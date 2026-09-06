#!/usr/bin/env python3
"""Herdr mobile bridge.

stdin/stdout use remodr protocol 1 as NDJSON.
stderr is reserved for diagnostics. The Herdr socket never leaves the server.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import queue
import re
import select
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "0.1.0"
PROTOCOL = 1
SUPPORTED_PROVIDERS = ("copilot", "claude", "codex", "cursor")
BYPASS_ARGUMENTS = {
    "claude": ["--dangerously-skip-permissions"],
    "codex": ["--dangerously-bypass-approvals-and-sandbox"],
    "copilot": ["--allow-all-tools"],
    "cursor": ["--force"],
}
SHELL_READY_TIMEOUT = 20
"""How long a freshly made pane is given to reach its shell prompt."""

PROCESS_INSPECTION_TIMEOUT = 2.0
PROCESS_INSPECTION_MAX_BYTES = 512 * 1024
PROCESS_INSPECTION_MAX_FDS = 4096

MAX_AGENT_NAME = 60
"""Longest name a tab label will carry, so one cannot fill the list row."""

# The bridge's half of the model catalogue: which flags each CLI takes. The
# app holds the other half — which models and settings to offer — in
# `src/domain/model-catalogues/`. A CLI must appear in both or neither: models
# offered with no flags here cannot be sent, and flags here with no models
# there are never asked for.
TUNING_ARGUMENTS = {
    "copilot": {
        "model": "--model",
        "effort": "--effort",
        "context": "--context",
    },
    "claude": {"model": "--model", "effort": "--effort"},
    "codex": {"model": "--model", "effort": "-c"},
    "cursor": {"model": "--model"},
}
RETUNABLE_PROVIDERS = ("copilot",)
CODEX_STATUS_CONFIG = 'tui.status_line=["session-id","model-with-reasoning","current-dir"]'

CONTEXT_TIERS = ("default", "long_context")

# The events that state a session's model, reasoning effort and context window,
# and the key each one names the model under.
#
# Start and resume report the whole state. A model change reports only what it
# changed, leaving the rest null — a change with no effort in it keeps the
# effort the session already had, as the next resume goes on to confirm.
SESSION_STATE_EVENTS = {"session.start": "selectedModel", "session.resume": "selectedModel"}
SESSION_CHANGE_EVENTS = {"session.model_change": "newModel"}

# How the CLI writes "no model pinned" in a log.
NO_MODEL = "auto"

ORDERED_TUNING = ("model", "effort", "context")

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
PROVIDER_EFFORTS = {
    "copilot": tuple(effort for effort in REASONING_EFFORTS if effort != "ultra"),
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": REASONING_EFFORTS,
}

SUBSCRIPTION_RETRY_INITIAL = 0.25
SUBSCRIPTION_RETRY_MAX = 2.0
DURABLE_ACTIONS = frozenset(
    ("agent.send_message", "human_request.answer", "agent.interrupt")
)
COMMAND_RESERVATION_SECONDS = 120
COMMAND_MAX_ENTRIES = 10000
COMMAND_MAX_RESPONSE_BYTES = 65536
SUBSCRIPTIONS = (
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "workspace.focused",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
)


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class CommandLedger:
    """Never reclaim command IDs: an abandoned reservation is not permission to retry."""

    def __init__(self, scope: str) -> None:
        self.scope = scope
        self.owner = uuid.uuid4().hex
        self.path = Path.home() / ".local/share/remote-workspace/commands.sqlite3"

    @staticmethod
    def _private(path: Path, directory: bool = False) -> None:
        info = path.lstat()
        expected = stat.S_ISDIR if directory else stat.S_ISREG
        required_mode = 0o700 if directory else 0o600
        reason = None
        if stat.S_ISLNK(info.st_mode):
            reason = "is a symbolic link; use a real, user-owned path"
        elif not expected(info.st_mode):
            reason = f"is not a {'directory' if directory else 'regular file'}"
        elif info.st_uid != os.getuid():
            reason = f"is owned by uid {info.st_uid}, expected uid {os.getuid()}"
        elif stat.S_IMODE(info.st_mode) != required_mode:
            reason = (
                f"has mode {stat.S_IMODE(info.st_mode):04o}; "
                f"requires {required_mode:04o}"
            )
        elif not directory and info.st_nlink != 1:
            reason = f"has {info.st_nlink} hard links; requires a single private file"
        if reason is not None:
            raise BridgeError(
                "COMMAND_STORE_UNAVAILABLE",
                f"Command storage path '{path}' {reason}. "
                "Repair this path without deleting existing command history.",
            )

    @staticmethod
    def _prepare_directory(path: Path, private: bool) -> None:
        path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise BridgeError(
                "COMMAND_STORE_UNAVAILABLE",
                f"Command storage path '{path}' is not a real directory "
                "(symbolic links are refused). Repair the path before reconnecting.",
            )
        if info.st_uid != os.getuid():
            raise BridgeError(
                "COMMAND_STORE_UNAVAILABLE",
                f"Command storage path '{path}' is owned by uid {info.st_uid}, "
                f"expected uid {os.getuid()}. Repair ownership before reconnecting.",
            )
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_uid) != (
                info.st_dev, info.st_ino, os.getuid()
            ):
                raise BridgeError(
                    "COMMAND_STORE_UNAVAILABLE",
                    f"Command storage path '{path}' changed during validation; reconnect safely.",
                )
            # SFTP mkdirs inherits the server's umask (often 0002). Tighten only
            # verified user-owned directories, never follow a link with chmod.
            mode = stat.S_IMODE(opened.st_mode)
            desired = 0o700 if private else mode & ~0o022
            if mode != desired:
                try:
                    os.fchmod(fd, desired)
                except OSError as error:
                    raise BridgeError(
                        "COMMAND_STORE_UNAVAILABLE",
                        f"Cannot secure command storage directory '{path}' to "
                        f"mode {desired:04o}: {error}. Repair permissions before reconnecting.",
                    ) from error
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise BridgeError(
                    "COMMAND_STORE_UNAVAILABLE",
                    f"Command storage path '{path}' changed while securing permissions.",
                )
            if current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) != desired:
                raise BridgeError(
                    "COMMAND_STORE_UNAVAILABLE",
                    f"Command storage directory '{path}' could not be secured to "
                    f"mode {desired:04o} for uid {os.getuid()}; repair it before reconnecting.",
                )
        finally:
            os.close(fd)

    def _connect(self) -> sqlite3.Connection:
        connection = None
        lock_fd = None
        try:
            directory = self.path.parent
            for parent in (directory.parent.parent, directory.parent, directory):
                self._prepare_directory(parent, private=parent == directory)
            self._private(directory, directory=True)
            marker = directory / "commands.initialized"
            initialize = False
            try:
                lock_fd = os.open(
                    marker, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600
                )
                initialize = True
                os.fsync(lock_fd)
                directory_fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except FileExistsError:
                self._private(marker)
                lock_fd = os.open(marker, os.O_RDWR | os.O_NOFOLLOW)
            self._private(marker)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BridgeError("COMMAND_IN_PROGRESS", "Command storage is busy.")
            # An existing empty or damaged database must not be silently initialized.
            created = False
            if initialize:
                fd = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                    0o600,
                )
                os.close(fd)
                created = True
            self._private(self.path)
            for suffix in ("-journal", "-wal", "-shm"):
                sidecar = Path(str(self.path) + suffix)
                if sidecar.exists() or sidecar.is_symlink():
                    self._private(sidecar)
            connection = sqlite3.connect(
                self.path.as_uri() + "?mode=rw", uri=True, timeout=0.2,
                isolation_level=None,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA fullfsync=ON")
            connection.execute("PRAGMA max_page_count=16384")
            connection.execute("BEGIN IMMEDIATE")
            if created:
                connection.execute(
                    """CREATE TABLE commands (
                    scope TEXT NOT NULL, command_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, state TEXT NOT NULL
                    CHECK(state IN ('reserved','succeeded','failed','uncertain')),
                    owner TEXT NOT NULL, pid INTEGER NOT NULL,
                    created REAL NOT NULL, response TEXT,
                    PRIMARY KEY(scope, command_id))"""
                )
                connection.execute("PRAGMA user_version=1")
            elif connection.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise BridgeError(
                    "COMMAND_STORE_UNAVAILABLE", "Command storage is not initialized."
                )
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise BridgeError(
                    "COMMAND_STORE_UNAVAILABLE", "Command storage is damaged."
                )
            connection.execute("COMMIT")
            return connection
        except (OSError, sqlite3.Error) as error:
            if connection is not None:
                connection.close()
            raise self._store_error(error, self.path) from error
        except BaseException:
            if connection is not None:
                connection.close()
            raise
        finally:
            if lock_fd is not None:
                os.close(lock_fd)

    @staticmethod
    def _store_error(error: Exception, path: Path | None = None) -> BridgeError:
        if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL:
            return BridgeError("COMMAND_STORE_FULL", "Command storage has reached capacity.")
        if isinstance(error, sqlite3.OperationalError) and (
            "locked" in str(error).lower() or "busy" in str(error).lower()
        ):
            return BridgeError("COMMAND_IN_PROGRESS", "Command storage is busy.")
        location = getattr(error, "filename", None) or path
        detail = f" at '{location}'" if location is not None else ""
        return BridgeError(
            "COMMAND_STORE_UNAVAILABLE",
            f"Command storage{detail} is unavailable: {error}. "
            "Check ownership, permissions, and free space; preserve existing command history.",
        )

    @staticmethod
    def _owner_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _read(self, connection: sqlite3.Connection, command_id: str) -> dict[str, Any] | None:
        row = connection.execute(
            "SELECT * FROM commands WHERE scope=? AND command_id=?",
            (self.scope, command_id),
        ).fetchone()
        if row is None:
            return None
        record = dict(row)
        if record["state"] == "reserved" and (
            not 0 <= time.time() - record["created"] < COMMAND_RESERVATION_SECONDS
            or not self._owner_alive(record["pid"])
        ):
            connection.execute(
                "UPDATE commands SET state='uncertain' WHERE scope=? AND command_id=?",
                (self.scope, command_id),
            )
            record["state"] = "uncertain"
        return record

    def reserve(self, command_id: str, fingerprint: str) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            record = self._read(connection, command_id)
            if record is not None:
                if record["fingerprint"] != fingerprint:
                    raise BridgeError(
                        "COMMAND_ID_CONFLICT", "Command ID was used for different content."
                    )
            else:
                count = connection.execute("SELECT count(*) FROM commands").fetchone()[0]
                if count >= COMMAND_MAX_ENTRIES:
                    raise BridgeError(
                        "COMMAND_STORE_FULL", "Command storage is full; no IDs were evicted."
                    )
                connection.execute(
                    "INSERT INTO commands VALUES (?, ?, ?, 'reserved', ?, ?, ?, NULL)",
                    (self.scope, command_id, fingerprint, self.owner, os.getpid(), time.time()),
                )
            connection.execute("COMMIT")
            return record
        except (OSError, sqlite3.Error) as error:
            raise self._store_error(error) from error
        finally:
            connection.close()

    def status(self, command_id: str) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            record = self._read(connection, command_id)
            connection.execute("COMMIT")
            return record
        except (OSError, sqlite3.Error) as error:
            raise self._store_error(error) from error
        finally:
            connection.close()

    def check_available(self) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            # A read-only probe cannot establish that journal creation/commit works.
            connection.execute("PRAGMA user_version=1")
            connection.execute("COMMIT")
        except (OSError, sqlite3.Error) as error:
            raise self._store_error(error) from error
        finally:
            connection.close()

    def finish(self, command_id: str, state: str, response: dict[str, Any]) -> None:
        connection = self._connect()
        try:
            encoded = json.dumps(response, ensure_ascii=True, allow_nan=False)
            if len(encoded.encode("utf-8")) > COMMAND_MAX_RESPONSE_BYTES:
                raise BridgeError("COMMAND_UNCERTAIN", "Command result is too large to store.")
            connection.execute("BEGIN IMMEDIATE")
            result = connection.execute(
                """UPDATE commands SET state=?, response=?
                WHERE scope=? AND command_id=? AND owner=? AND state='reserved'""",
                (state, encoded, self.scope, command_id, self.owner),
            )
            if result.rowcount != 1:
                raise BridgeError("COMMAND_UNCERTAIN", "Command reservation is no longer owned.")
            connection.execute("COMMIT")
        except (OSError, sqlite3.Error) as error:
            raise self._store_error(error) from error
        finally:
            connection.close()


class Bridge:
    def __init__(self) -> None:
        self.herdr_socket = os.path.expanduser(
            os.environ.get("HERDR_SOCKET", "~/.config/herdr/herdr.sock")
        )
        self.session_name = os.environ.get("HERDR_SESSION", "default")
        self.device_id = os.environ.get("REMOTE_WORKSPACE_DEVICE_ID", "device")
        # How long the agent's question dialog is given to redraw between
        # keystroke batches. An attribute so tests can drive it at zero.
        self.dialog_settle_seconds = 0.25
        # Pane id -> the Copilot session id this app asked that pane to open.
        self.started_sessions: dict[str, str] = {}
        self.observed_session_panes: set[str] = set()
        self.process_bound_panes: set[str] = set()
        self.session_identity_errors: dict[str, str] = {}
        self.session_identity_diagnostics: dict[str, str] = {}
        # Pane id -> the model, effort and context it was last started with.
        self.agent_tuning: dict[str, dict[str, Any]] = {}
        # Pane id -> whether it was started with its permissions bypassed.
        self.agent_bypass: dict[str, bool] = {}
        # Session id -> (bytes of the log already read, settings found in them).
        self.session_tuning_cache: dict[str, tuple[int, dict[str, Any]]] = {}
        self.output_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.refresh_lock = threading.RLock()
        self.buffered_events: queue.Queue[dict[str, Any]] = queue.Queue()
        self.pane_subscriptions: set[str] = set()
        self.pane_subscription_lock = threading.Lock()
        self.subscribed = threading.Event()
        self.live = threading.Event()
        self.running = True
        self.runtime: dict[str, Any] = {
            "connectionState": "starting_bridge",
            "workspaces": [],
            "agents": [],
            "providers": [],
        }
        self.agent_catalog: list[dict[str, Any]] | None = None
        self.raw_agents: dict[str, dict[str, Any]] = {}
        self.pending_human_requests: dict[str, dict[str, Any]] = {}
        self.human_request_scopes: dict[str, tuple[str, Any, Any]] = {}
        self.pending_agents: dict[str, dict[str, Any]] = {}
        self.conversation_cache: dict[
            tuple[str, str, str], tuple[tuple[int, int, int, int], dict[str, Any]]
        ] = {}
        self.command_context = threading.local()
        self.command_store_error: BridgeError | None = None

    def run(self) -> None:
        capabilities = self._capabilities()
        if self.command_store_error is not None:
            error = self.command_store_error
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": "unknown",
                    "herdrProtocol": None,
                    "runtimeReady": False,
                    "capabilities": capabilities,
                    "fatal": True,
                    "error": {"code": error.code, "message": str(error)},
                }
            )
            self.running = False
            return
        subscription = threading.Thread(
            target=self._subscription_loop,
            name="herdr-events",
            daemon=True,
        )
        subscription.start()

        if not self.subscribed.wait(timeout=8):
            self._diagnostic("HERDR_EVENT", "subscription did not acknowledge")

        try:
            self._refresh_runtime()
            capabilities = self._capabilities(check_store=False)
            herdr_version = self.runtime.get("herdrVersion", "unknown")
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": herdr_version,
                    "herdrProtocol": self.runtime.get("herdrProtocol"),
                    "runtimeReady": True,
                    "capabilities": capabilities,
                }
            )
            self.write_event("runtime.snapshot", self.runtime)
        except Exception as error:
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": "unknown",
                    "herdrProtocol": None,
                    "runtimeReady": False,
                    "capabilities": capabilities,
                    "warning": str(error),
                    "error": {"code": "HERDR_UNAVAILABLE", "message": "Herdr is unavailable."},
                }
            )
            self.write_event(
                "connection.warning",
                {"code": "HERDR_UNAVAILABLE", "message": "Herdr is unavailable."},
            )

        self.live.set()
        while not self.buffered_events.empty():
            self._handle_herdr_event(self.buffered_events.get_nowait())

        for line in sys.stdin:
            if not self.running:
                break
            self._handle_request_line(line)

        self.running = False

    def _handle_request_line(self, line: str) -> None:
        request_id: str | None = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise BridgeError("INVALID_REQUEST", "Request must be an object.")
            request_id = message.get("id")
            if message.get("protocol") != PROTOCOL:
                raise BridgeError("UNSUPPORTED_PROTOCOL", "Unsupported bridge protocol.")
            if message.get("type") != "request" or not isinstance(request_id, str):
                raise BridgeError("INVALID_REQUEST", "Invalid request envelope.")
            action = message.get("action")
            payload = message.get("payload") or {}
            if not isinstance(action, str) or not isinstance(payload, dict):
                raise BridgeError("INVALID_REQUEST", "Invalid action or payload.")
            if "commandId" in message:
                response = self._durable_command(message["commandId"], action, payload)
                self.write({**response, "id": request_id})
                return
            result = self._dispatch(action, payload)
            self.write(
                {
                    "protocol": PROTOCOL,
                    "id": request_id,
                    "type": "response",
                    "ok": True,
                    "payload": result,
                }
            )
        except BridgeError as error:
            self._write_error(request_id, error.code, str(error))
        except json.JSONDecodeError:
            self._write_error(request_id, "INVALID_JSON", "Request is not valid JSON.")
        except Exception as error:
            self._diagnostic("HERDR_BRIDGE", repr(error))
            self._write_error(request_id, "BRIDGE_ERROR", "The bridge request failed.")

    def _dispatch(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action == "bridge.ping":
            return {"alive": True}
        if action == "command.status":
            command_id = self._command_id(payload.get("commandId"))
            record = self._command_ledger().status(command_id)
            result: dict[str, Any] = {
                "commandId": command_id,
                "state": "unknown" if record is None else (
                    "in_progress" if record["state"] == "reserved" else record["state"]
                ),
            }
            if record and record["response"]:
                result["response"] = self._stored_response(record)
            return result
        if action == "runtime.snapshot":
            self._refresh_runtime()
            return self.runtime
        if action == "agent.conversation":
            with self.refresh_lock:
                self._refresh_runtime_and_publish()
                agent = self._require_agent(payload)
                return self._load_conversation(agent)
        if action == "agent.send_message":
            agent = self._require_agent(payload)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BridgeError("INVALID_MESSAGE", "Message cannot be empty.")
            self._herdr_mutation(
                "agent.prompt",
                {"target": agent["paneId"], "text": text},
            )
            return {"accepted": True}
        if action == "agent.create":
            return self._create_agent(payload)
        if action == "agent.rename":
            return self._rename_agent(payload)
        if action == "agent.close":
            return self._close_agent(payload)
        if action == "agent.retune":
            return self._retune_agent(payload)
        if action == "workspace.create":
            return self._create_workspace(payload)
        if action == "workspace.close":
            return self._close_workspace(payload)
        if action == "human_request.answer":
            return self._answer_human_request(payload)
        if action == "agent.interrupt":
            agent = self._require_agent(payload)
            self._herdr_mutation(
                "agent.send_keys",
                {"target": agent["paneId"], "keys": ["ctrl-c"]},
            )
            return {"accepted": True}
        raise BridgeError("UNKNOWN_ACTION", f"Unsupported action: {action}")

    @staticmethod
    def _command_id(value: Any) -> str:
        try:
            if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
                raise ValueError
            return value.lower()
        except (ValueError, AttributeError):
            raise BridgeError("INVALID_COMMAND_ID", "Command ID must be a canonical UUID.")

    def _command_ledger(self) -> CommandLedger:
        scope = json.dumps(
            [os.getuid(), self.device_id, self.session_name, os.path.abspath(self.herdr_socket)],
            separators=(",", ":"),
        )
        return CommandLedger(hashlib.sha256(scope.encode()).hexdigest())

    @staticmethod
    def _command_error(code: str, message: str) -> dict[str, Any]:
        return {
            "protocol": PROTOCOL, "type": "response", "ok": False,
            "error": {"code": code, "message": message},
        }

    @staticmethod
    def _stored_response(record: dict[str, Any]) -> dict[str, Any]:
        try:
            response = json.loads(record["response"])
            if (
                not isinstance(response, dict)
                or response.get("protocol") != PROTOCOL
                or response.get("type") != "response"
                or not isinstance(response.get("ok"), bool)
                or (response["ok"] and not isinstance(response.get("payload"), dict))
                or (not response["ok"] and not isinstance(response.get("error"), dict))
            ):
                raise ValueError
            return response
        except (ValueError, TypeError):
            raise BridgeError("COMMAND_STORE_UNAVAILABLE", "Stored command result is invalid.")

    def _durable_command(
        self, value: Any, action: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        command_id = self._command_id(value)
        if action not in DURABLE_ACTIONS:
            raise BridgeError(
                "COMMAND_ACTION_UNSUPPORTED", "This action does not support durable commands."
            )
        try:
            encoded = json.dumps(
                [action, payload], sort_keys=True, separators=(",", ":"),
                ensure_ascii=True, allow_nan=False,
            )
        except (ValueError, TypeError):
            raise BridgeError("INVALID_REQUEST", "Command must contain valid JSON values.")
        ledger = self._command_ledger()
        record = ledger.reserve(command_id, hashlib.sha256(encoded.encode()).hexdigest())
        if record is not None:
            if record["state"] == "reserved":
                raise BridgeError("COMMAND_IN_PROGRESS", "Command is still in progress.")
            if record["state"] == "uncertain":
                if record["response"]:
                    return self._stored_response(record)
                raise BridgeError(
                    "COMMAND_UNCERTAIN", "Command may have been delivered; do not resend."
                )
            return self._stored_response(record)
        self.command_context.active = True
        self.command_context.side_effect = False
        self.command_context.agent = None
        try:
            self._prepare_command(action, payload)
            result = self._dispatch(action, payload)
            response = {
                "protocol": PROTOCOL, "type": "response", "ok": True, "payload": result,
            }
            state = "succeeded"
        except Exception as error:
            if self.command_context.side_effect:
                state = "uncertain"
                response = self._command_error(
                    "COMMAND_UNCERTAIN", "Command may have been delivered; do not resend."
                )
            else:
                state = "failed"
                response = self._command_error(
                    error.code if isinstance(error, BridgeError) else "BRIDGE_ERROR",
                    str(error) if isinstance(error, BridgeError) else "Command validation failed.",
                )
        finally:
            self.command_context.active = False
            self.command_context.agent = None
        try:
            ledger.finish(command_id, state, response)
        except Exception:
            # Even a successful Herdr reply is not an ACK until it has been committed.
            raise BridgeError(
                "COMMAND_UNCERTAIN", "Command result could not be persisted; do not resend."
            )
        return response

    def _prepare_command(self, action: str, payload: dict[str, Any]) -> None:
        if "expectedProviderSessionId" in payload or "expectedPaneId" in payload:
            expected = {
                "providerSessionId": payload.get("expectedProviderSessionId"),
                "paneId": payload.get("expectedPaneId"),
            }
            if "expectedProvider" in payload:
                expected["provider"] = payload["expectedProvider"]
        else:
            expected = payload.get("precondition")
        fields = ("providerSessionId", "paneId")
        if not isinstance(expected, dict) or any(
            not isinstance(expected.get(field), str) or not expected[field] for field in fields
        ):
            raise BridgeError(
                "COMMAND_PRECONDITION_FAILED", "Provider session and pane identity are required."
            )
        self._refresh_runtime()
        agent = self._require_agent(payload)
        identity_error = self.session_identity_errors.get(agent.get("paneId"))
        if identity_error:
            raise BridgeError("COMMAND_PRECONDITION_FAILED", identity_error)
        checked_fields = (*fields, "provider") if "provider" in expected else fields
        if any(expected[field] != agent.get(field) for field in checked_fields):
            raise BridgeError(
                "COMMAND_PRECONDITION_FAILED", "The target provider session or pane has changed."
            )
        self.command_context.agent = agent
        if action == "human_request.answer":
            conversation = self._load_conversation(agent)
            request = conversation.get("activeHumanRequest")
            if not isinstance(request, dict) or request.get("id") != payload.get("requestId"):
                raise BridgeError(
                    "COMMAND_PRECONDITION_FAILED", "The question is no longer active."
                )
            self._remember_human_request(request, agent)

    def _remember_human_request(
        self, request: dict[str, Any], agent: dict[str, Any]
    ) -> None:
        self.pending_human_requests[request["id"]] = request
        self.human_request_scopes[request["id"]] = (
            agent["id"], agent.get("provider"), agent.get("providerSessionId")
        )

    def _answer_human_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = payload.get("requestId")
        agent = self._require_agent(payload)
        if not isinstance(request_id, str):
            raise BridgeError("INVALID_REQUEST", "Human request ID is required.")
        request = self.pending_human_requests.get(request_id)
        scope = self.human_request_scopes.get(request_id)
        if scope is not None and scope[1:] != (
            agent.get("provider"), agent.get("providerSessionId")
        ):
            raise BridgeError("INVALID_REQUEST", "The question belongs to another session.")
        answer = payload.get("answer") or {}
        if not isinstance(answer, dict):
            raise BridgeError("INVALID_ANSWER", "Answer must be an object.")
        custom_text = answer.get("customText")
        selected_ids = answer.get("selectedOptionIds") or []
        text = custom_text.strip() if isinstance(custom_text, str) else ""
        if not text and request:
            labels = {
                option["id"]: option["label"]
                for option in request.get("options", [])
                if isinstance(option, dict)
            }
            text = ", ".join(
                labels[option_id]
                for option_id in selected_ids
                if option_id in labels
            )
        if not text:
            raise BridgeError("INVALID_ANSWER", "An answer is required.")
        # A question puts the agent's own selection UI on screen, and Herdr
        # refuses `agent.prompt` while that is up — it answers with
        # `agent_blocked` before sending anything. The dialog has to be driven
        # the way a person would drive it. The status can be a moment stale, so
        # a refusal is also taken as proof the dialog is up.
        if self._agent_is_blocked(agent):
            self._answer_blocked_dialog(agent, request, selected_ids, text)
        else:
            try:
                self._herdr_mutation(
                    "agent.prompt",
                    {"target": agent["paneId"], "text": text},
                )
            except BridgeError as error:
                if error.code != "agent_blocked":
                    raise
                self._answer_blocked_dialog(agent, request, selected_ids, text)
        self.pending_human_requests.pop(request_id, None)
        self.human_request_scopes.pop(request_id, None)
        return {"accepted": True}

    @staticmethod
    def _agent_is_blocked(agent: dict[str, Any]) -> bool:
        return Bridge._status(agent.get("agent_status")) == "blocked"

    def _send_keys(self, agent: dict[str, Any], keys: list[str]) -> None:
        if keys:
            self._herdr_mutation(
                "agent.send_keys", {"target": agent["paneId"], "keys": keys}
            )

    def _herdr_mutation(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if getattr(self.command_context, "active", False):
            agent = self.command_context.agent
            if agent is None or params.get("target") != agent.get("paneId"):
                raise BridgeError("COMMAND_PRECONDITION_FAILED", "Command target is not bound.")
            self._require_agent({"agentId": agent["id"]})
            identity_error = self.session_identity_errors.get(agent.get("paneId"))
            if identity_error:
                raise BridgeError("COMMAND_PRECONDITION_FAILED", identity_error)
            self.command_context.side_effect = True
        return self._herdr_request(method, params)

    def _answer_blocked_dialog(
        self,
        agent: dict[str, Any],
        request: dict[str, Any] | None,
        selected_ids: list[Any],
        text: str,
    ) -> None:
        """Drive the agent's own question dialog.

        The dialog is a list of the offered answers followed by a synthesised
        "Other (type your answer)" row, and the cursor opens on the schema's
        default rather than the top. Both ends of the list clamp, so moving
        further than the list is long is what makes a position certain without
        having to read the screen back.
        """
        options = list(request.get("options", [])) if request else []
        span = len(options) + 2

        index = None
        if len(selected_ids) == 1:
            index = next(
                (
                    position
                    for position, option in enumerate(options)
                    if isinstance(option, dict) and option.get("id") == selected_ids[0]
                ),
                None,
            )

        if index is not None:
            # Anchor on the first row, then step down to the wanted one.
            self._send_keys(agent, ["up"] * span + ["down"] * index + ["enter"])
            return

        # Anything the offered answers do not cover — a typed reply, a
        # synthesised yes/no, or several answers at once — goes through the
        # freeform row at the bottom. Reaching that row swaps the list for a
        # text field, and characters sent before it has drawn are dropped, so
        # each stage is given a moment to settle. Herdr's own prompt does the
        # same thing, sending Enter after a short delay.
        self._send_keys(agent, ["down"] * span)
        time.sleep(self.dialog_settle_seconds)
        self._send_keys(agent, self._text_keys(text))
        time.sleep(self.dialog_settle_seconds)
        self._send_keys(agent, ["enter"])

    @staticmethod
    def _text_keys(text: str) -> list[str]:
        # Herdr takes one key per character and rejects a literal space.
        return ["space" if character == " " else character for character in text]

    def _require_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = payload.get("agentId")
        if not isinstance(agent_id, str):
            raise BridgeError("INVALID_AGENT", "Agent ID is required.")
        with self.state_lock:
            agent = self.raw_agents.get(agent_id)
        if agent is None:
            raise BridgeError("AGENT_NOT_FOUND", "Agent is no longer available.")
        bound = getattr(self.command_context, "agent", None)
        if bound is not None:
            fields = ("id", "provider", "providerSessionId", "paneId")
            if any(bound.get(field) != agent.get(field) for field in fields):
                raise BridgeError(
                    "COMMAND_PRECONDITION_FAILED", "The command target has changed."
                )
            return bound
        return agent

    def _refresh_runtime(self, *, inspect_copilot: bool = True) -> None:
        with self.refresh_lock:
            result = self._herdr_request("session.snapshot", {})
            snapshot = result.get("snapshot")
            if not isinstance(snapshot, dict):
                raise BridgeError(
                    "INVALID_HERDR_RESPONSE", "Herdr snapshot is missing."
                )
            self._agent_catalog_snapshot()
            normalized = self._normalize_snapshot(snapshot, inspect_copilot=inspect_copilot)
            with self.state_lock:
                self.runtime = normalized
            self._ensure_pane_subscriptions()

    def _refresh_runtime_and_publish(self) -> None:
        with self.refresh_lock:
            before = {
                key: value for key, value in self.runtime.items()
                if key != "lastRuntimeEvent"
            }
            self._refresh_runtime()
            after = {
                key: value for key, value in self.runtime.items()
                if key != "lastRuntimeEvent"
            }
            if before != after:
                self.write_event("runtime.snapshot", self.runtime)

    def _invalidate_agent_session(
        self, agent_id: str, pane_id: str, session_id: Any
    ) -> None:
        self.agent_tuning.pop(pane_id, None)
        self.session_tuning_cache.pop(session_id, None)
        self.conversation_cache = {
            key: value for key, value in self.conversation_cache.items()
            if key[0] != agent_id
        }
        for request_id, scope in list(self.human_request_scopes.items()):
            if scope[0] == agent_id:
                self.pending_human_requests.pop(request_id, None)
                self.human_request_scopes.pop(request_id, None)

    def _copilot_foreground_process(self, pane_id: str) -> tuple[int, int]:
        result = self._herdr_request("pane.process_info", {"pane_id": pane_id})
        info = result.get("process_info")
        if not isinstance(info, dict) or info.get("pane_id") != pane_id:
            raise OSError("pane process metadata is unavailable or mismatched")
        group = info.get("foreground_process_group_id")
        shell_pid = info.get("shell_pid")
        processes = info.get("foreground_processes")
        if (
            type(group) is not int or group <= 0
            or type(shell_pid) is not int or shell_pid <= 0
            or not isinstance(processes, list)
        ):
            raise OSError("pane process metadata is incomplete")
        roots = [
            item for item in processes
            if isinstance(item, dict) and type(item.get("pid")) is int
            and item["pid"] == group
        ]
        if len(roots) != 1 or group == shell_pid:
            raise ValueError("no unique foreground Copilot group leader")
        root = roots[0]
        if not sys.platform.startswith("linux"):
            if not all(
                isinstance(root.get(key), str) and Path(root[key]).name == "copilot"
                for key in ("name", "argv0")
            ):
                raise ValueError("foreground group leader is not the Copilot executable")
            return group, shell_pid

        # Linux may omit argv0 and launch through VS Code's shell/Node shims.
        # Follow only the verified foreground launch chain, not arbitrary children.
        if len(processes) > 256:
            raise OSError("foreground process list exceeds the inspection limit")
        leader = self._linux_process_metadata(group)
        if leader["group"] != group:
            raise ValueError("foreground process group changed")
        ancestor = leader["parent"]
        visited = {group}
        for _ in range(32):
            if ancestor == shell_pid:
                break
            if ancestor <= 1 or ancestor in visited:
                raise ValueError("foreground process no longer belongs to the pane shell")
            visited.add(ancestor)
            ancestor = self._linux_process_metadata(ancestor)["parent"]
        else:
            raise ValueError("foreground process ancestry could not be verified")
        # Package updates can unlink a still-running executable on Linux.
        executable = self._linux_executable_name(leader["executable"])
        if executable == "copilot":
            return group, shell_pid
        argv = leader["argv"]
        script = argv[1] if len(argv) > 1 else ""
        if (
            executable not in ("sh", "dash", "bash", "zsh", "node", "bun")
            or Path(script).name not in ("copilot", "copilotCLIShim.js")
        ):
            raise ValueError("foreground group leader is not a verified Copilot launcher")
        metadata = {group: leader}
        for process in processes:
            pid = process.get("pid") if isinstance(process, dict) else None
            if type(pid) is not int or pid <= 0 or pid == group:
                continue
            try:
                item = self._linux_process_metadata(pid)
            except FileNotFoundError:
                continue
            if item["group"] == group:
                metadata[pid] = item
        candidates = {
            pid for pid, item in metadata.items()
            if self._linux_executable_name(item["executable"]) == "copilot"
        }
        primary = []
        for pid in candidates:
            parent = metadata[pid]["parent"]
            visited = {pid}
            while parent in metadata and parent not in visited and parent not in candidates:
                if parent == group:
                    primary.append(pid)
                    break
                visited.add(parent)
                parent = metadata[parent]["parent"]
        if len(primary) != 1:
            raise ValueError("Copilot launcher has no unique foreground runtime")
        return primary[0], shell_pid

    @staticmethod
    def _linux_executable_name(executable: str) -> str:
        suffix = " (deleted)"
        return Path(executable[:-len(suffix)] if executable.endswith(suffix) else executable).name

    @staticmethod
    def _linux_process_metadata(pid: int) -> dict[str, Any]:
        directory = Path("/proc") / str(pid)
        if directory.stat().st_uid != os.getuid():
            raise OSError("foreground process belongs to another user")
        fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
        executable = os.readlink(directory / "exe")
        with (directory / "cmdline").open("rb") as command:
            argv = command.read(65537)
        if len(argv) > 65536:
            raise OSError("foreground command metadata exceeds the inspection limit")
        return {
            "parent": int(fields[1]),
            "group": int(fields[2]),
            "executable": executable,
            "argv": [os.fsdecode(part) for part in argv.split(b"\0") if part],
        }

    @staticmethod
    def _bounded_process_output(arguments: list[str]) -> bytes:
        deadline = time.monotonic() + PROCESS_INSPECTION_TIMEOUT
        with subprocess.Popen(
            arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ) as process:
            try:
                output = bytearray()
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise OSError("process descriptor inspection timed out")
                    readable, _, _ = select.select([process.stdout], [], [], remaining)
                    if not readable:
                        raise OSError("process descriptor inspection timed out")
                    chunk = os.read(process.stdout.fileno(), 16384)
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > PROCESS_INSPECTION_MAX_BYTES:
                        raise OSError("process descriptor output exceeds the size limit")
                code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                if code != 0:
                    raise OSError("process descriptor inspection was refused")
                return bytes(output)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    @staticmethod
    def _lsof_paths(output: bytes, pid: int) -> list[str]:
        paths = []
        current_pid = None
        owner = None
        for field in output.split(b"\0"):
            field = field.lstrip(b"\n")
            if not field:
                continue
            if field[:1] == b"p":
                current_pid = int(field[1:])
                if current_pid != pid:
                    raise OSError("descriptor output belongs to another process")
            elif field[:1] == b"u":
                owner = int(field[1:])
                if owner != os.getuid():
                    raise OSError("descriptor output belongs to another user")
            elif field[:1] == b"n":
                if current_pid != pid or owner != os.getuid():
                    raise OSError("descriptor output has no verified process owner")
                paths.append(os.fsdecode(field[1:]))
        if current_pid != pid or owner != os.getuid():
            raise OSError("descriptor output has no verified process owner")
        return paths

    @staticmethod
    def _linux_process_paths(pid: int) -> list[str]:
        process_dir = Path("/proc") / str(pid)
        if process_dir.stat().st_uid != os.getuid():
            raise OSError("foreground process belongs to another user")
        deadline = time.monotonic() + PROCESS_INSPECTION_TIMEOUT
        paths = []
        size = 0
        with os.scandir(process_dir / "fd") as entries:
            for index, entry in enumerate(entries):
                if index >= PROCESS_INSPECTION_MAX_FDS or time.monotonic() >= deadline:
                    raise OSError("process descriptor inspection exceeds its limit")
                if not entry.name.isdigit():
                    continue
                try:
                    path = os.readlink(entry.path)
                except FileNotFoundError:
                    continue
                size += len(os.fsencode(path))
                if size > PROCESS_INSPECTION_MAX_BYTES:
                    raise OSError("process descriptor output exceeds the size limit")
                paths.append(path)
        return paths

    def _copilot_open_session_ids(self, pid: int) -> set[str]:
        if sys.platform.startswith("linux"):
            paths = self._linux_process_paths(pid)
        elif sys.platform == "darwin":
            lsof = "/usr/sbin/lsof"
            if not Path(lsof).is_file():
                lsof = shutil.which("lsof")
            if not lsof:
                raise OSError("lsof is unavailable")
            paths = self._lsof_paths(
                self._bounded_process_output([lsof, "-nP", "-a", "-p", str(pid), "-F0pun"]),
                pid,
            )
        else:
            raise OSError("process descriptor inspection is unsupported on this platform")
        root = (Path.home() / ".copilot" / "session-state").resolve()
        sessions = set()
        for value in paths:
            path = Path(value)
            if (
                path.is_absolute() and path.name == "session.db"
                and path.parent.parent == root
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", path.parent.name)
            ):
                sessions.add(path.parent.name)
        return sessions

    def _effective_copilot_session(
        self, pane_id: str, native_session_id: str | None
    ) -> str | None:
        status = "unavailable"
        reason = ""
        session_id = None
        inspected = False
        try:
            binding = self._copilot_foreground_process(pane_id)
            sessions = self._copilot_open_session_ids(binding[0])
            inspected = True
            # Recheck the live pane binding after inspection. Session results are
            # never cached by PID, so clears and process/PID reuse are re-inspected.
            if self._copilot_foreground_process(pane_id) != binding:
                raise ValueError("foreground process changed during descriptor inspection")
            if len(sessions) > 1:
                raise ValueError("foreground Copilot has multiple open session databases")
            if sessions:
                session_id = next(iter(sessions))
                status = "verified"
            else:
                # Idle/new CLIs need not have opened the optional session database.
                reason = "foreground Copilot does not expose an open session database"
        except ValueError as error:
            status, reason = "unresolved", str(error)
        except (OSError, BridgeError, subprocess.SubprocessError) as error:
            if inspected:
                status = "unresolved"
            reason = str(error)

        if status == "verified":
            self.process_bound_panes.add(pane_id)
            self.session_identity_errors.pop(pane_id, None)
            diagnostic = (
                "Using the foreground Copilot session database; native session reference differs."
                if session_id != native_session_id else ""
            )
        elif status == "unresolved" or pane_id in self.process_bound_panes:
            self.process_bound_panes.add(pane_id)
            self.observed_session_panes.add(pane_id)
            self.session_identity_errors[pane_id] = reason
            diagnostic = f"Session identity unresolved: {reason}; not using a possibly stale native ID."
        else:
            self.session_identity_errors.pop(pane_id, None)
            session_id = native_session_id
            diagnostic = f"Process-bound session inspection unavailable: {reason}; using unverified native identity."
        if self.session_identity_diagnostics.get(pane_id) != diagnostic:
            if diagnostic:
                self._diagnostic("COPILOT_SESSION_IDENTITY", f"{pane_id}: {diagnostic}")
            self.session_identity_diagnostics[pane_id] = diagnostic
        return session_id

    @staticmethod
    def _codex_uuid(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        try:
            parsed = uuid.UUID(value)
        except ValueError:
            return None
        return str(parsed) if parsed.int and str(parsed) == value.lower() else None

    @classmethod
    def _codex_status_session(cls, text: Any) -> str | None:
        if not isinstance(text, str):
            return None
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            return None
        # Only the live footer is evidence. UUIDs in messages or /status history
        # must never select the target of a queued command.
        sessions = {
            session
            for part in lines[-1].split("\u00b7")
            if (session := cls._codex_uuid(part.strip())) is not None
        }
        return next(iter(sessions)) if len(sessions) == 1 else None

    def _effective_codex_session(
        self, raw: dict[str, Any], native_session_id: str | None
    ) -> str | None:
        pane_id = str(raw.get("pane_id") or "")
        reason = (
            "Codex has not exposed its active thread. Finish any startup dialogs "
            "and enable Thread ID in Codex /statusline. New Remodr Codex agents "
            "enable this automatically."
        )
        try:
            result = self._herdr_request(
                "agent.read",
                {"target": pane_id, "source": "visible", "format": "text",
                 "strip_ansi": True, "lines": 6},
            )
            read = result.get("read")
            session_id = self._codex_status_session(
                read.get("text") if isinstance(read, dict) else None
            )
        except (OSError, BridgeError) as error:
            session_id = None
            reason = f"Codex thread identity could not be read: {error}"
        if session_id:
            self.session_identity_errors.pop(pane_id, None)
            self.session_identity_diagnostics.pop(pane_id, None)
            return session_id

        self.session_identity_errors[pane_id] = reason
        if self.session_identity_diagnostics.get(pane_id) != reason:
            self._diagnostic("CODEX_SESSION_IDENTITY", f"{pane_id}: {reason}")
            self.session_identity_diagnostics[pane_id] = reason
        previous = self.raw_agents.get(self._stable_agent_id(pane_id))
        # Preserve the last displayed transcript while a dialog hides the footer.
        # This hint is not dispatch authority: command preparation refuses it.
        if (
            previous and previous.get("provider") == "codex"
            and previous.get("terminal_id") == raw.get("terminal_id")
        ):
            return previous.get("providerSessionId")
        return native_session_id

    def _normalize_snapshot(
        self, snapshot: dict[str, Any], *, inspect_copilot: bool = True
    ) -> dict[str, Any]:
        catalog = self.agent_catalog or self._fallback_agent_catalog()
        workspace_labels = {
            item.get("workspace_id"): item.get("label") or "Workspace"
            for item in snapshot.get("workspaces", [])
            if isinstance(item, dict)
        }
        tab_labels = {
            item.get("tab_id"): item.get("label")
            for item in snapshot.get("tabs", [])
            if isinstance(item, dict) and isinstance(item.get("label"), str)
        }
        workspace_cwds: dict[Any, str] = {}
        panes = snapshot.get("panes")
        agents = snapshot.get("agents")
        for raw in [
            *(panes if isinstance(panes, list) else []),
            *(agents if isinstance(agents, list) else []),
        ]:
            if not isinstance(raw, dict):
                continue
            workspace_id = raw.get("workspace_id")
            cwd = raw.get("foreground_cwd") or raw.get("cwd")
            if workspace_id is not None and isinstance(cwd, str) and cwd:
                workspace_cwds.setdefault(workspace_id, cwd)
        normalized_agents: list[dict[str, Any]] = []
        raw_agents: dict[str, dict[str, Any]] = {}
        for raw in snapshot.get("agents", []):
            if not isinstance(raw, dict):
                continue
            provider = self._provider(raw.get("agent"))
            session = raw.get("agent_session")
            pane_id = str(raw.get("pane_id") or "")
            provider_session_id = (
                session.get("value") if isinstance(session, dict) else None
            )
            if not isinstance(provider_session_id, str) or not provider_session_id:
                provider_session_id = None
            if provider == "copilot":
                if inspect_copilot:
                    provider_session_id = self._effective_copilot_session(
                        pane_id, provider_session_id
                    )
                elif pane_id in self.process_bound_panes:
                    # Event hints must not rescan every process or restore a stale
                    # native ID. Reads and mutations always inspect afresh.
                    previous = self.raw_agents.get(self._stable_agent_id(pane_id))
                    provider_session_id = (
                        previous.get("providerSessionId")
                        if previous and previous.get("provider") == provider
                        and previous.get("terminal_id") == raw.get("terminal_id")
                        else None
                    )
            elif provider == "codex":
                self.process_bound_panes.discard(pane_id)
                provider_session_id = self._effective_codex_session(
                    raw, provider_session_id
                )
            else:
                self.process_bound_panes.discard(pane_id)
                self.session_identity_errors.pop(pane_id, None)
                self.session_identity_diagnostics.pop(pane_id, None)
            reported_session_id = provider_session_id
            if (
                not provider_session_id and provider == "copilot"
                and pane_id not in self.observed_session_panes
            ):
                # Herdr only learns a session id once the agent writes its
                # state out, which is after it has done something. For an agent
                # this app started we already know it, so the conversation can
                # be read from the first moment rather than falling back to
                # scraping the terminal.
                provider_session_id = self.started_sessions.get(pane_id)
            agent_id = self._stable_agent_id(pane_id)
            previous = self.raw_agents.get(agent_id)
            remembered = self.started_sessions.get(pane_id)
            previous_session_id = previous.get("providerSessionId") if previous else None
            observed = pane_id in self.observed_session_panes
            if previous_session_id is None and not observed:
                previous_session_id = remembered
            # First identification is not a rotation away from launch settings.
            had_session_identity = observed or previous_session_id is not None
            if (
                (previous is not None or remembered is not None)
                and (
                    (had_session_identity and previous_session_id != provider_session_id)
                    or (previous and previous.get("provider") != provider)
                )
            ):
                self._invalidate_agent_session(agent_id, pane_id, previous_session_id)
            if reported_session_id:
                self.observed_session_panes.add(pane_id)
                if provider == "copilot" and remembered is not None:
                    self.started_sessions[pane_id] = reported_session_id
            if provider != "copilot" or (
                not reported_session_id and pane_id in self.observed_session_panes
            ):
                self.started_sessions.pop(pane_id, None)
            workspace_id = str(raw.get("workspace_id") or "")
            capabilities = self._agent_capabilities(provider, provider_session_id)
            agent = {
                "id": agent_id,
                "deviceId": self.device_id,
                "provider": provider,
                "providerSessionId": provider_session_id,
                "tuning": self._reported_tuning(pane_id, provider_session_id, provider),
                "herdrSessionId": self.session_name,
                "workspaceId": workspace_id,
                "workspaceName": workspace_labels.get(workspace_id, "Workspace"),
                "tabId": raw.get("tab_id"),
                "paneId": raw.get("pane_id"),
                "cwd": raw.get("foreground_cwd") or raw.get("cwd"),
                "status": self._status(raw.get("agent_status")),
                "title": self._agent_display_title(
                    raw,
                    provider,
                    tab_labels.get(raw.get("tab_id")),
                ),
                "focused": bool(raw.get("focused")),
                "capabilities": capabilities,
            }
            normalized_agents.append(agent)
            raw_agents[agent_id] = {**raw, **agent}

        detected_pane_ids = {
            str(agent.get("paneId"))
            for agent in normalized_agents
            if agent.get("paneId")
        }
        live_pane_ids = {
            str(pane.get("pane_id"))
            for pane in (panes if isinstance(panes, list) else [])
            if isinstance(pane, dict) and pane.get("pane_id")
        }
        self.started_sessions = {
            pane: session
            for pane, session in self.started_sessions.items()
            if pane in live_pane_ids
        }
        self.observed_session_panes.intersection_update(live_pane_ids)
        self.process_bound_panes.intersection_update(live_pane_ids)
        self.session_identity_errors = {
            pane: error for pane, error in self.session_identity_errors.items()
            if pane in live_pane_ids
        }
        self.session_identity_diagnostics = {
            pane: message for pane, message in self.session_identity_diagnostics.items()
            if pane in live_pane_ids
        }
        self.agent_tuning = {
            pane: tuning
            for pane, tuning in self.agent_tuning.items()
            if pane in live_pane_ids
        }
        self.agent_bypass = {
            pane: bypass
            for pane, bypass in self.agent_bypass.items()
            if pane in live_pane_ids
        }
        # Sessions are keyed by id rather than pane, so they need pruning
        # against the panes still holding them or the cache grows for as long
        # as the bridge runs.
        live_sessions = {
            str(agent.get("providerSessionId"))
            for agent in normalized_agents
            if agent.get("providerSessionId")
        }
        self.session_tuning_cache = {
            session: entry
            for session, entry in self.session_tuning_cache.items()
            if session in live_sessions
        }
        for pane_id, pending in list(self.pending_agents.items()):
            if pane_id in detected_pane_ids or pane_id not in live_pane_ids:
                self.pending_agents.pop(pane_id, None)
                continue
            normalized_agents.append(pending)
            raw_agents[pending["id"]] = {
                "pane_id": pane_id,
                "workspace_id": pending["workspaceId"],
                **pending,
            }

        for agent_id, previous in self.raw_agents.items():
            if agent_id not in raw_agents:
                self._invalidate_agent_session(
                    agent_id, str(previous.get("paneId") or ""),
                    previous.get("providerSessionId"),
                )
        with self.state_lock:
            self.raw_agents = raw_agents
        return {
            "connectionState": "connected",
            "deviceId": self.device_id,
            "herdrVersion": snapshot.get("version", "unknown"),
            "herdrProtocol": snapshot.get("protocol"),
            "herdrSession": self.session_name,
            "socketPath": self.herdr_socket,
            "workspaces": [
                {
                    "id": str(item.get("workspace_id") or ""),
                    "deviceId": self.device_id,
                    "name": item.get("label") or "Workspace",
                    "cwd": workspace_cwds.get(item.get("workspace_id")),
                    "paneCount": item.get("pane_count")
                    if isinstance(item.get("pane_count"), int)
                    else 0,
                    "status": self._status(item.get("agent_status")),
                }
                for item in snapshot.get("workspaces", [])
                if isinstance(item, dict)
            ],
            "agents": normalized_agents,
            "providers": catalog,
            "lastRuntimeEvent": time.time(),
        }

    def _agent_catalog_snapshot(self, force: bool = False) -> list[dict[str, Any]]:
        if self.agent_catalog is not None and not force:
            return self.agent_catalog
        aliases_by_provider: dict[str, list[str]] = {}
        advertised: set[str] = set()
        manifests_loaded = False
        catalog_error: str | None = None
        try:
            result = self._herdr_request("server.agent_manifests", {})
            manifests = result.get("manifests")
            if isinstance(manifests, list):
                manifests_loaded = True
                for manifest in manifests:
                    if not isinstance(manifest, dict):
                        continue
                    provider = self._provider(manifest.get("agent"))
                    if provider not in SUPPORTED_PROVIDERS:
                        continue
                    advertised.add(provider)
                    aliases = manifest.get("aliases")
                    aliases_by_provider[provider] = (
                        [str(alias) for alias in aliases]
                        if isinstance(aliases, list)
                        else []
                    )
        except Exception as error:
            catalog_error = "Provider catalog unavailable."
            self._diagnostic("HERDR_MANIFESTS", repr(error))

        self.agent_catalog = [
            {
                "provider": provider,
                "available": manifests_loaded and provider in advertised,
                "aliases": aliases_by_provider.get(provider, []),
                "unavailableReason": (
                    None
                    if manifests_loaded and provider in advertised
                    else catalog_error or "Not advertised by Herdr."
                ),
            }
            for provider in SUPPORTED_PROVIDERS
        ]
        return self.agent_catalog

    @staticmethod
    def _fallback_agent_catalog() -> list[dict[str, Any]]:
        return [
            {
                "provider": provider,
                "available": False,
                "aliases": [],
                "unavailableReason": "Provider catalog unavailable.",
            }
            for provider in SUPPORTED_PROVIDERS
        ]

    def _create_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        cwd = payload.get("cwd")
        label = payload.get("label")
        if not isinstance(cwd, str) or not cwd.strip():
            raise BridgeError("INVALID_WORKSPACE", "A root folder is required.")
        if label is not None and not isinstance(label, str):
            raise BridgeError("INVALID_WORKSPACE", "Invalid space name.")

        expanded = os.path.expanduser(cwd.strip())
        if not os.path.isabs(expanded):
            expanded = os.path.join(str(Path.home()), expanded)
        normalized_cwd = os.path.normpath(expanded)
        if not os.path.isdir(normalized_cwd):
            raise BridgeError(
                "WORKSPACE_DIRECTORY_NOT_FOUND",
                "The root folder does not exist on this device.",
            )

        params: dict[str, Any] = {
            "focus": False,
            "cwd": normalized_cwd,
        }
        if isinstance(label, str) and label.strip():
            params["label"] = label.strip()
        result = self._herdr_request("workspace.create", params)
        workspace = result.get("workspace")
        workspace_id = (
            workspace.get("workspace_id")
            if isinstance(workspace, dict)
            else result.get("workspace_id")
        )
        if not isinstance(workspace_id, str) or not workspace_id:
            raise BridgeError(
                "INVALID_HERDR_RESPONSE",
                "Created space ID is missing.",
            )
        try:
            self._refresh_runtime()
        except Exception as error:
            self._diagnostic("WORKSPACE_REFRESH", repr(error))
            self._install_created_workspace(
                workspace_id,
                label.strip() if isinstance(label, str) and label.strip() else None,
                normalized_cwd,
            )
        return {
            "workspaceId": workspace_id,
            "runtime": self.runtime,
        }

    def _install_created_workspace(
        self,
        workspace_id: str,
        label: str | None,
        cwd: str,
    ) -> None:
        with self.refresh_lock:
            with self.state_lock:
                workspaces = self.runtime.get("workspaces", [])
                if any(
                    workspace.get("id") == workspace_id
                    for workspace in workspaces
                    if isinstance(workspace, dict)
                ):
                    return
                workspace = {
                    "id": workspace_id,
                    "deviceId": self.device_id,
                    "name": label or Path(cwd).name or "Workspace",
                    "cwd": cwd,
                    "paneCount": 1,
                    "status": "idle",
                }
                self.runtime = {
                    **self.runtime,
                    "workspaces": [*workspaces, workspace],
                    "lastRuntimeEvent": time.time(),
                }

    def _close_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_id = payload.get("workspaceId")
        close_group = payload.get("closeGroup", False)
        if not isinstance(workspace_id, str) or not workspace_id:
            raise BridgeError("INVALID_WORKSPACE", "A space is required.")
        if not isinstance(close_group, bool):
            raise BridgeError("INVALID_WORKSPACE", "Invalid group close setting.")
        self._herdr_request(
            "workspace.close",
            {
                "workspace_id": workspace_id,
                "close_group": close_group,
            },
        )
        try:
            self._refresh_runtime()
        except Exception as error:
            self._diagnostic("WORKSPACE_REFRESH", repr(error))
            self._remove_workspace_from_runtime(workspace_id)
        return {
            "workspaceId": workspace_id,
            "runtime": self.runtime,
        }

    def _remove_workspace_from_runtime(self, workspace_id: str) -> None:
        with self.refresh_lock:
            with self.state_lock:
                removed_agent_ids = {
                    agent.get("id")
                    for agent in self.runtime.get("agents", [])
                    if isinstance(agent, dict)
                    and agent.get("workspaceId") == workspace_id
                }
                self.runtime = {
                    **self.runtime,
                    "workspaces": [
                        workspace
                        for workspace in self.runtime.get("workspaces", [])
                        if not isinstance(workspace, dict)
                        or workspace.get("id") != workspace_id
                    ],
                    "agents": [
                        agent
                        for agent in self.runtime.get("agents", [])
                        if not isinstance(agent, dict)
                        or agent.get("workspaceId") != workspace_id
                    ],
                    "lastRuntimeEvent": time.time(),
                }
                self.raw_agents = {
                    agent_id: agent
                    for agent_id, agent in self.raw_agents.items()
                    if agent_id not in removed_agent_ids
                }
                self.pending_agents = {
                    pane_id: agent
                    for pane_id, agent in self.pending_agents.items()
                    if agent.get("workspaceId") != workspace_id
                }

    def _create_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        provider = self._provider(payload.get("provider"))
        workspace_id = payload.get("workspaceId")
        bypass_permissions = payload.get("bypassPermissions", True)
        name_input = payload.get("name")
        label = (
            name_input.strip()[:MAX_AGENT_NAME]
            if isinstance(name_input, str) and name_input.strip()
            else ""
        )
        if provider not in SUPPORTED_PROVIDERS:
            raise BridgeError("INVALID_PROVIDER", "Unsupported agent provider.")
        tuning = self._tuning_arguments(provider, payload)
        if not isinstance(workspace_id, str) or not workspace_id:
            raise BridgeError("INVALID_WORKSPACE", "A space is required.")
        if not isinstance(bypass_permissions, bool):
            raise BridgeError("INVALID_REQUEST", "Invalid permission setting.")

        self._refresh_runtime()
        workspace_ids = {
            workspace.get("id")
            for workspace in self.runtime.get("workspaces", [])
            if isinstance(workspace, dict)
        }
        if workspace_id not in workspace_ids:
            raise BridgeError("WORKSPACE_NOT_FOUND", "The selected space no longer exists.")
        catalog = self._agent_catalog_snapshot(force=True)
        available = next(
            (
                item.get("available")
                for item in catalog
                if item.get("provider") == provider
            ),
            False,
        )
        if not available:
            raise BridgeError(
                "PROVIDER_UNAVAILABLE",
                f"{self._provider_label(provider)} is not available on this device.",
            )

        tab_result = self._herdr_request(
            "tab.create",
            {
                "focus": False,
                "workspace_id": workspace_id,
                # The label is what the agent is called in the list. Without
                # one every new agent arrives as "GitHub Copilot", which is
                # unfindable once there is more than one.
                "label": label or provider,
            },
        )
        root_pane = tab_result.get("root_pane")
        pane_id = (
            root_pane.get("pane_id") if isinstance(root_pane, dict) else None
        )
        if not isinstance(pane_id, str) or not pane_id:
            raise BridgeError("INVALID_HERDR_RESPONSE", "New agent pane is missing.")

        name = provider
        args = list(BYPASS_ARGUMENTS[provider]) if bypass_permissions else []
        args.extend(tuning)
        session_id = self._new_session_arguments(provider, label, args)
        try:
            try:
                self._start_agent(name, provider, pane_id, args)
            except BridgeError as error:
                if error.code.lower() != "agent_name_taken":
                    raise
                name = f"{provider}-{uuid.uuid4().hex[:4]}"
                self._start_agent(name, provider, pane_id, args)
            agent_id = self._stable_agent_id(pane_id)
            if session_id:
                with self.state_lock:
                    self.started_sessions[pane_id] = session_id
            with self.state_lock:
                self.agent_tuning[pane_id] = self._tuning_of(payload)
                self.agent_bypass[pane_id] = bypass_permissions
            for _ in range(20):
                if provider == "codex":
                    self._refresh_runtime(inspect_copilot=False)
                else:
                    self._refresh_runtime()
                agent = next(
                    (
                        item
                        for item in self.runtime.get("agents", [])
                        if isinstance(item, dict) and item.get("paneId") == pane_id
                    ),
                    None,
                )
                if agent and (provider != "codex" or agent.get("providerSessionId")):
                    break
                time.sleep(0.1)
            if not agent:
                self._install_pending_agent(
                    agent_id,
                    name,
                    provider,
                    workspace_id,
                    pane_id,
                )
            return {
                "paneId": pane_id,
                "agentId": agent_id,
                "name": name,
                "runtime": self.runtime,
            }
        except Exception:
            try:
                self._herdr_request("pane.close", {"pane_id": pane_id})
            except Exception as cleanup_error:
                self._diagnostic("AGENT_CLEANUP", repr(cleanup_error))
            raise

    @staticmethod
    def _new_session_arguments(
        provider: Any, label: str, args: list[str]
    ) -> str | None:
        """Make the agent open a brand new session, and say which one.

        Left to itself Copilot offers to resume, and an unfinished session in
        the same folder puts a restore picker up instead of a prompt. A new
        agent then looks empty, and the first message typed at it is swallowed
        by the picker's search box rather than reaching the agent.

        Naming the session as well when the user named the agent keeps the two
        the same thing rather than two names for one piece of work.
        """
        if str(provider) == "codex":
            # Codex queues SessionStart hooks until the first turn. Its live
            # status line exposes the real thread UUID before any input.
            # "session-id" is the backwards-compatible alias of "thread-id".
            args.extend(["-c", CODEX_STATUS_CONFIG])
            return None
        if str(provider) != "copilot":
            return None
        session_id = str(uuid.uuid4())
        args.extend(["--session-id", session_id])
        if label:
            args.extend(["--name", label])
        return session_id

    @staticmethod
    def _tuning_arguments(provider: Any, payload: dict[str, Any]) -> list[str]:
        """Model and reasoning effort, as command-line arguments.

        Both are left off entirely unless asked for, so the agent keeps its own
        default — which for a model is the CLI picking one, and is the only
        choice guaranteed to be available on every account.
        """
        flags = TUNING_ARGUMENTS.get(str(provider))
        if flags is None:
            raise BridgeError("INVALID_PROVIDER", "Unsupported agent provider.")
        arguments: list[str] = []
        for key in ORDERED_TUNING:
            value = payload.get(key)
            if value is None:
                continue
            if not isinstance(value, str):
                raise BridgeError(f"INVALID_{key.upper()}", f"Invalid {key} setting.")
            value = value.strip()
            if not value:
                continue
            if key not in flags:
                raise BridgeError(
                    "UNSUPPORTED_TUNING",
                    f"{Bridge._provider_label(str(provider))} does not support "
                    f"the {key} setting from here.",
                )
            if key == "effort" and value not in PROVIDER_EFFORTS.get(str(provider), ()):
                raise BridgeError("INVALID_EFFORT", "Unsupported reasoning effort.")
            if key == "context" and value not in CONTEXT_TIERS:
                raise BridgeError("INVALID_CONTEXT", "Unsupported context window.")
            if key == "model" and any(ord(char) < 32 or ord(char) == 127 for char in value):
                raise BridgeError("INVALID_MODEL", "Invalid model setting.")
            if provider == "codex" and key == "effort":
                value = f"model_reasoning_effort={json.dumps(value)}"
            arguments.extend([flags[key], value])
        return arguments

    @staticmethod
    def _tuning_of(payload: dict[str, Any]) -> dict[str, Any]:
        """The three settings, normalised, with absent meaning "let the CLI pick"."""
        return {
            key: (
                payload.get(key).strip()
                if isinstance(payload.get(key), str) and payload.get(key).strip()
                else None
            )
            for key in ORDERED_TUNING
        }

    def _retune_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.refresh_lock:
            self._refresh_runtime_and_publish()
            return self._retune_current_agent(payload)

    def _retune_current_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Change the model, reasoning effort or context window of a live agent.

        A model can be swapped in place — Copilot takes `/model` mid-session —
        but effort and context are only read at startup. Those are changed by
        quitting the CLI and starting it again on the same session id, which
        resumes the conversation rather than beginning a new one.
        """
        agent = self._require_agent(payload)
        if agent.get("paneId") in self.session_identity_errors:
            raise BridgeError("SESSION_IDENTITY_UNRESOLVED", "The active provider session cannot be verified.")
        provider = agent.get("provider")
        if provider not in RETUNABLE_PROVIDERS:
            raise BridgeError(
                "PROVIDER_NOT_TUNABLE",
                f"{self._provider_label(str(provider))} cannot be tuned from here.",
            )
        pane_id = agent.get("paneId")
        if not isinstance(pane_id, str) or not pane_id:
            raise BridgeError("AGENT_NOT_FOUND", "This agent has no pane.")

        # Validate before touching anything, so a bad value cannot leave the
        # agent stopped.
        self._tuning_arguments(provider, payload)
        wanted = self._tuning_of(payload)
        session_id = agent.get("providerSessionId")
        # Against everything known about the agent, not only what was set from
        # here. Comparing against the latter alone made a plain model swap look
        # like a reasoning change on any agent this bridge did not start, and
        # restarting one to change nothing interrupts whatever it is doing.
        current = self._reported_tuning(pane_id, session_id, provider)

        restart_needed = any(
            wanted.get(key) != current.get(key) for key in ("effort", "context")
        )
        if restart_needed:
            if not isinstance(session_id, str) or not session_id:
                raise BridgeError(
                    "SESSION_UNKNOWN",
                    "This agent's session cannot be reopened, so its reasoning "
                    "and context cannot be changed.",
                )
            self._restart_agent(agent, pane_id, session_id, wanted)
        elif wanted.get("model") != current.get("model"):
            # `auto` is what Copilot itself calls letting it choose.
            self._herdr_request(
                "agent.prompt",
                {
                    "target": pane_id,
                    "text": f"/model {wanted.get('model') or 'auto'}",
                },
            )

        with self.state_lock:
            self.agent_tuning[pane_id] = wanted
        self._refresh_runtime()
        return {"agentId": agent["id"], "runtime": self.runtime}

    def _restart_agent(
        self,
        agent: dict[str, Any],
        pane_id: str,
        session_id: str,
        tuning: dict[str, Any],
    ) -> None:
        provider = str(agent.get("provider"))
        with self.state_lock:
            # Whatever it was started with. Handing back all its tools because
            # it was restarted is not a change anyone asked for, and the
            # opposite would leave it stopping for permission it used to have.
            bypass = self.agent_bypass.get(pane_id, True)
            previous = dict(self.agent_tuning.get(pane_id) or {})

        self._herdr_request("agent.prompt", {"target": pane_id, "text": "/exit"})
        deadline = time.monotonic() + SHELL_READY_TIMEOUT
        while time.monotonic() < deadline:
            time.sleep(0.3)
            try:
                self._herdr_request("agent.get", {"target": pane_id})
            except BridgeError:
                break  # No agent in the pane any more, so the shell is back.

        name = str(agent.get("name") or provider)
        try:
            self._launch_tuned(name, provider, pane_id, session_id, bypass, tuning)
        except BridgeError:
            # The agent has already been stopped, so failing here would leave
            # the pane at a shell with the conversation stranded. Putting it
            # back as it was is the only thing left that helps.
            self._diagnostic("AGENT_RETUNE", f"pane {pane_id} rejected new settings")
            self._launch_tuned(
                name, provider, pane_id, session_id, bypass, previous
            )
            raise BridgeError(
                "RETUNE_REFUSED",
                "The agent would not start with those settings, so it has been "
                "put back as it was.",
            )
        with self.state_lock:
            self.started_sessions[pane_id] = session_id

    def _launch_tuned(
        self,
        name: str,
        provider: str,
        pane_id: str,
        session_id: str,
        bypass: bool,
        tuning: dict[str, Any],
    ) -> None:
        args = list(BYPASS_ARGUMENTS[provider]) if bypass else []
        args.extend(self._tuning_arguments(provider, tuning))
        args.extend(["--session-id", session_id])
        try:
            self._start_agent(name, provider, pane_id, args)
        except BridgeError as error:
            if error.code.lower() != "agent_name_taken":
                raise
            # Herdr releases a name when the CLI exits, but not always before
            # the next one asks for it.
            self._start_agent(
                f"{provider}-{uuid.uuid4().hex[:4]}", provider, pane_id, args
            )

    def _reported_tuning(
        self, pane_id: str, provider_session_id: Any, provider: str
    ) -> dict[str, Any]:
        """What the agent is actually running, as far as we can tell.

        What this app last set wins field by field, because that is what the
        agent will use next: the log can be a moment behind a change made from
        here.

        For Copilot, everything not set from here comes from its session log.
        Other providers' session formats are not read for tuning, so settings
        not remembered from creation remain unknown.
        """
        ours = self.agent_tuning.get(pane_id) or {}
        logged = self._session_tuning(provider_session_id) if provider == "copilot" else {}
        return {key: ours.get(key) or logged.get(key) for key in ORDERED_TUNING}

    def _session_tuning(self, provider_session_id: Any) -> dict[str, Any]:
        """The model, reasoning effort and context window a session is running.

        Only the session-level events carry all three, and they are the CLI's
        own record: it writes one when a session starts, when it resumes, and
        whenever any of the three is changed — including from the terminal
        rather than from here. Per-turn events name a model but never a
        context window, so the tail alone is not enough.

        A log is append-only, so each call reads only what has arrived since
        the last one. Scanning the whole file every time would mean re-reading
        megabytes a second while an agent is working.
        """
        empty: dict[str, Any] = {"model": None, "effort": None, "context": None}
        if not isinstance(provider_session_id, str) or not provider_session_id:
            return dict(empty)
        path = (
            Path.home()
            / ".copilot"
            / "session-state"
            / provider_session_id
            / "events.jsonl"
        )
        try:
            size = path.stat().st_size
        except OSError:
            return dict(empty)

        offset, tuning = self.session_tuning_cache.get(
            provider_session_id, (0, dict(empty))
        )
        if size < offset:
            # Truncated or replaced, so nothing read before can be trusted.
            offset, tuning = 0, dict(empty)
        if size == offset:
            return dict(tuning)

        tuning = dict(tuning)
        try:
            with path.open("rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
        except OSError:
            return dict(tuning)

        # A read can land mid-line, so the last fragment is left for next time.
        consumed = chunk.rfind(b"\n") + 1
        for raw in chunk[:consumed].splitlines():
            if b'"session.' not in raw:
                continue
            try:
                event = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(event, dict) or event.get("agentId"):
                continue
            kind = event.get("type")
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            if kind in SESSION_STATE_EVENTS:
                model = data.get(SESSION_STATE_EVENTS[kind])
                tuning = {
                    "model": None if model == NO_MODEL else (model or None),
                    "effort": data.get("reasoningEffort") or None,
                    "context": data.get("contextTier") or None,
                }
            elif kind in SESSION_CHANGE_EVENTS:
                model = data.get(SESSION_CHANGE_EVENTS[kind])
                if model:
                    tuning["model"] = None if model == NO_MODEL else model
                if data.get("reasoningEffort"):
                    tuning["effort"] = data["reasoningEffort"]
                if data.get("contextTier"):
                    tuning["context"] = data["contextTier"]

        self.session_tuning_cache[provider_session_id] = (
            offset + consumed,
            dict(tuning),
        )
        return dict(tuning)

    def _rename_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Rename by relabelling the tab the agent sits in.

        Herdr's own agent name is an identifier — lowercase, no spaces, unique
        among live agents — so it cannot hold what someone would actually call
        a piece of work. The tab label has no such rules, and the title shown
        for an agent already prefers it.
        """
        agent = self._require_agent(payload)
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise BridgeError("INVALID_NAME", "A name is required.")
        tab_id = agent.get("tabId") or agent.get("tab_id")
        if not isinstance(tab_id, str) or not tab_id:
            raise BridgeError("AGENT_NOT_FOUND", "This agent has no tab to rename.")
        self._herdr_request(
            "tab.rename", {"tab_id": tab_id, "label": name.strip()[:MAX_AGENT_NAME]}
        )
        self._refresh_runtime()
        return {"agentId": agent["id"], "runtime": self.runtime}

    def _close_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Close the agent's pane, which stops the agent with it.

        The pane rather than the tab: an agent started outside this app can be
        sharing a tab with panes nobody asked us to touch.
        """
        agent = self._require_agent(payload)
        agent_id = agent["id"]
        pane_id = agent.get("paneId")
        if not isinstance(pane_id, str) or not pane_id:
            raise BridgeError("AGENT_NOT_FOUND", "This agent has no pane to close.")
        self._herdr_request("pane.close", {"pane_id": pane_id})
        with self.state_lock:
            self.pending_agents.pop(pane_id, None)
            self.started_sessions.pop(pane_id, None)
            self.agent_tuning.pop(pane_id, None)
            self.agent_bypass.pop(pane_id, None)
        try:
            self._refresh_runtime()
        except Exception as error:
            self._diagnostic("AGENT_CLOSE_REFRESH", repr(error))
            self._remove_agent_from_runtime(agent_id)
        return {"agentId": agent_id, "runtime": self.runtime}

    def _remove_agent_from_runtime(self, agent_id: str) -> None:
        with self.refresh_lock:
            with self.state_lock:
                self.runtime = {
                    **self.runtime,
                    "agents": [
                        agent
                        for agent in self.runtime.get("agents", [])
                        if not isinstance(agent, dict) or agent.get("id") != agent_id
                    ],
                    "lastRuntimeEvent": time.time(),
                }
                self.raw_agents.pop(agent_id, None)

    def _install_pending_agent(
        self,
        agent_id: str,
        name: str,
        provider: str,
        workspace_id: str,
        pane_id: str,
    ) -> None:
        with self.refresh_lock:
            with self.state_lock:
                if any(
                    item.get("id") == agent_id
                    for item in self.runtime.get("agents", [])
                    if isinstance(item, dict)
                ):
                    return
                workspace = next(
                    (
                        item
                        for item in self.runtime.get("workspaces", [])
                        if isinstance(item, dict) and item.get("id") == workspace_id
                    ),
                    {},
                )
                pending = {
                    "id": agent_id,
                    "deviceId": self.device_id,
                    "provider": provider,
                    "providerSessionId": None,
                    "tuning": self._reported_tuning(pane_id, None, provider),
                    "herdrSessionId": self.session_name,
                    "workspaceId": workspace_id,
                    "workspaceName": workspace.get("name", "Workspace"),
                    "tabId": None,
                    "paneId": pane_id,
                    "cwd": workspace.get("cwd"),
                    "status": "working",
                    "title": name,
                    "focused": False,
                    "capabilities": self._agent_capabilities(provider, None),
                }
                self.runtime = {
                    **self.runtime,
                    "agents": [*self.runtime.get("agents", []), pending],
                    "lastRuntimeEvent": time.time(),
                }
                self.raw_agents[agent_id] = {
                    "pane_id": pane_id,
                    "workspace_id": workspace_id,
                    **pending,
                }
                self.pending_agents[pane_id] = pending

    def _stable_agent_id(self, pane_id: str) -> str:
        identity = "|".join((self.session_name, self.device_id, pane_id))
        return "agent_" + hashlib.sha256(identity.encode()).hexdigest()[:20]

    def _start_agent(
        self,
        name: str,
        provider: str,
        pane_id: str,
        args: list[str],
    ) -> None:
        try:
            pinned_terminal_id = self._pane_terminal_id(pane_id)
        except Exception:
            pinned_terminal_id = None
        # A pane this app just made has nothing in it but a shell starting up,
        # so "busy" only ever means "not at its prompt yet" and waiting is
        # always the right answer. Two seconds was not enough for a shell with
        # a real profile behind it — version managers, hooks — and the failure
        # surfaced as a raw herdr message where an agent should have been.
        deadline = time.monotonic() + SHELL_READY_TIMEOUT
        while True:
            try:
                self._herdr_request(
                    "agent.start",
                    {
                        "name": name,
                        "kind": provider,
                        "pane_id": pane_id,
                        "args": args,
                    },
                )
                return
            except BridgeError as error:
                if error.code != "agent_pane_busy":
                    raise
                # A replaced terminal means something other than a slow
                # profile is going on, and no amount of waiting fixes it.
                if pinned_terminal_id is None or not self._pane_terminal_unchanged(
                    pane_id, pinned_terminal_id
                ):
                    raise
                if time.monotonic() >= deadline:
                    raise BridgeError(
                        "SHELL_NOT_READY",
                        "The shell for this agent did not finish starting up.",
                    ) from error
                time.sleep(0.2)

    def _pane_terminal_id(self, pane_id: str) -> str | None:
        result = self._herdr_request("pane.get", {"pane_id": pane_id})
        pane = result.get("pane")
        terminal_id = pane.get("terminal_id") if isinstance(pane, dict) else None
        return terminal_id if isinstance(terminal_id, str) else None

    def _pane_terminal_unchanged(self, pane_id: str, pinned_terminal_id: str) -> bool:
        """Whether the pane still holds the terminal we started waiting on.

        This is the whole test for whether waiting is worthwhile. Asking the
        process list whether a shell looks like it is still starting up is a
        guess, and it guessed wrong for shells with a real profile behind them
        — version managers, hooks — which then failed instead of waiting.
        """
        try:
            return self._pane_terminal_id(pane_id) == pinned_terminal_id
        except Exception:
            return False

    def _agent_display_title(
        self,
        raw: dict[str, Any],
        provider: str,
        tab_label: Any,
    ) -> str:
        custom_title = raw.get("title")
        if (
            isinstance(custom_title, str)
            and custom_title.strip()
            and not self._is_generic_agent_title(custom_title, provider)
        ):
            return custom_title.strip()
        if (
            isinstance(tab_label, str)
            and tab_label.strip()
            and not self._is_generic_agent_name(tab_label, provider)
        ):
            return tab_label.strip()
        name = raw.get("name")
        if (
            isinstance(name, str)
            and name.strip()
            and not self._is_generic_agent_name(name, provider)
        ):
            return name.strip()
        terminal_title = raw.get("terminal_title_stripped")
        generic_titles = {
            provider,
            self._provider_label(provider).lower(),
            str(name or "").strip().lower(),
        }
        if (
            isinstance(terminal_title, str)
            and terminal_title.strip()
            and terminal_title.strip().lower() not in generic_titles
        ):
            return self._without_provider_suffix(terminal_title.strip(), provider)
        for fallback in (name, tab_label):
            if isinstance(fallback, str) and fallback.strip():
                return fallback.strip()
        return self._provider_label(provider)

    @classmethod
    def _without_provider_suffix(cls, title: str, provider: str) -> str:
        """Drop the CLI's name from the end of a title it wrote.

        Every Copilot terminal title ends "- GitHub Copilot", which is
        seventeen characters of a narrow header spent saying what the icon
        beside it already says, and enough to push the real title into an
        ellipsis. Only stripped when something is left over: a title that is
        nothing but the CLI's name still has to say something.
        """
        label = cls._provider_label(provider)
        for separator in (" - ", " \u2013 ", " \u2014 ", " | "):
            suffix = separator + label
            if title.lower().endswith(suffix.lower()):
                trimmed = title[: -len(suffix)].strip()
                if trimmed:
                    return trimmed
        return title

    @staticmethod
    def _is_generic_agent_name(value: str, provider: str) -> bool:
        normalized = value.strip().lower()
        if normalized == provider:
            return True
        prefix = provider + "-"
        suffix = normalized[len(prefix) :] if normalized.startswith(prefix) else ""
        return len(suffix) == 4 and all(character in "0123456789abcdef" for character in suffix)

    def _is_generic_agent_title(self, value: str, provider: str) -> bool:
        normalized = value.strip().lower()
        return (
            self._is_generic_agent_name(value, provider)
            or normalized == self._provider_label(provider).lower()
            or normalized.startswith("session initialization -")
        )

    def _load_conversation(self, agent: dict[str, Any]) -> dict[str, Any]:
        with self.refresh_lock:
            current = self.raw_agents.get(agent["id"])
            if current is not None and any(
                current.get(field) != agent.get(field)
                for field in ("provider", "providerSessionId", "paneId")
            ):
                raise BridgeError(
                    "COMMAND_PRECONDITION_FAILED", "The target session has changed."
                )
            return self._load_bound_conversation(agent)

    def _load_bound_conversation(self, agent: dict[str, Any]) -> dict[str, Any]:
        if agent.get("paneId") in self.session_identity_errors:
            reason = (
                self.session_identity_errors[agent["paneId"]]
                if agent.get("provider") == "codex"
                else "The active provider session cannot be verified: "
                + self.session_identity_errors[agent["paneId"]]
            )
            raise BridgeError("SESSION_IDENTITY_UNRESOLVED", reason)
        provider = agent["provider"]
        try:
            if provider == "copilot":
                conversation = self._load_copilot(agent)
            elif provider == "claude":
                conversation = self._load_claude(agent)
            elif provider == "codex":
                conversation = self._load_codex(agent)
            else:
                conversation = None
            if conversation is not None:
                return conversation
        except Exception as error:
            self._diagnostic(f"PROVIDER_{provider.upper()}", repr(error))
            raise BridgeError(
                "CONVERSATION_UNAVAILABLE", "The current session transcript could not be read."
            ) from error
        return self._load_fallback(agent)

    def _load_copilot(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        session_dir = Path.home() / ".copilot" / "session-state" / session_id
        events_path = session_dir / "events.jsonl"
        if not events_path.is_file():
            return None
        database = session_dir / "session.db"
        event_stat = events_path.stat()
        database_stat = database.stat() if database.is_file() else None
        cache_version = (
            event_stat.st_size,
            event_stat.st_mtime_ns,
            database_stat.st_size if database_stat else 0,
            database_stat.st_mtime_ns if database_stat else 0,
        )
        cache_key = (agent["id"], "copilot", session_id)
        cached = self.conversation_cache.get(cache_key)
        if cached and cached[0] == cache_version:
            request = cached[1].get("activeHumanRequest")
            if request:
                self._remember_human_request(request, agent)
            return cached[1]

        records: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        chunks: dict[str, dict[int, str]] = {}
        human_tool_ids: dict[str, str] = {}

        def upsert(item_id: str, item: dict[str, Any]) -> None:
            if item_id not in records:
                order.append(item_id)
                records[item_id] = item
            else:
                records[item_id].update(item)

        with events_path.open("r", encoding="utf-8", errors="replace") as events:
            for line in events:
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                # Child-agent events share this file but are not the pane's conversation.
                if not isinstance(event, dict) or event.get("agentId"):
                    continue
                event_type = event.get("type")
                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                event_id = str(event.get("id") or uuid.uuid4())
                timestamp = event.get("timestamp")

                if event_type == "user.message":
                    content = data.get("content")
                    if (
                        isinstance(content, str)
                        and content.strip()
                        and not content.lstrip().startswith("<system_notification>")
                    ):
                        upsert(
                            event_id,
                            {
                                "id": event_id,
                                "kind": "user_message",
                                "text": content,
                                "timestamp": timestamp,
                            },
                        )
                elif event_type == "assistant.message":
                    content = data.get("content")
                    if not isinstance(content, str) or not content:
                        continue
                    message_id = str(data.get("messageId") or event_id)
                    chunk_index = data.get("chunkIndex")
                    if isinstance(chunk_index, int):
                        chunks.setdefault(message_id, {})[chunk_index] = content
                        content = "".join(
                            chunks[message_id][index]
                            for index in sorted(chunks[message_id])
                        )
                    upsert(
                        message_id,
                        {
                            "id": message_id,
                            "kind": "assistant_message",
                            "markdown": content,
                            "timestamp": timestamp,
                        },
                    )
                elif event_type == "session.task_complete":
                    summary = data.get("summary")
                    previous = records.get(order[-1]) if order else None
                    if (
                        isinstance(summary, str)
                        and summary.strip()
                        and not (
                            previous
                            and previous.get("kind") == "assistant_message"
                            and previous.get("markdown") == summary
                        )
                    ):
                        upsert(
                            "completion:" + event_id,
                            {
                                "id": "completion:" + event_id,
                                "kind": "assistant_message",
                                "markdown": summary,
                                "timestamp": timestamp,
                            },
                        )
                elif event_type == "tool.execution_start":
                    tool_name = str(data.get("toolName") or "Tool")
                    tool_call_id = str(data.get("toolCallId") or event_id)
                    arguments = data.get("arguments")
                    if tool_name == "task_complete":
                        continue
                    if tool_name in ("ask_user", "AskUserQuestion"):
                        request = self._normalize_copilot_question(
                            tool_call_id,
                            arguments if isinstance(arguments, dict) else {},
                        )
                        if request:
                            self._remember_human_request(request, agent)
                            human_tool_ids[tool_call_id] = request["id"]
                            upsert(
                                "human:" + request["id"],
                                {
                                    "id": "human:" + request["id"],
                                    "kind": "human_request",
                                    "request": request,
                                    "timestamp": timestamp,
                                },
                            )
                        continue
                    upsert(
                        "tool:" + tool_call_id,
                        {
                            "id": "tool:" + tool_call_id,
                            "kind": "tool_activity",
                            "tool": tool_name,
                            "title": self._tool_title(tool_name),
                            "detail": self._tool_detail(arguments),
                            "state": "running",
                            "timestamp": timestamp,
                        },
                    )
                elif event_type == "tool.execution_complete":
                    tool_call_id = str(data.get("toolCallId") or event_id)
                    if tool_call_id in human_tool_ids:
                        request_id = human_tool_ids[tool_call_id]
                        self.pending_human_requests.pop(request_id, None)
                        self.human_request_scopes.pop(request_id, None)
                        current = records.get("human:" + request_id)
                        if current:
                            current["resolved"] = True
                        continue
                    existing = records.get("tool:" + tool_call_id)
                    if existing:
                        existing["state"] = (
                            "completed" if data.get("success") is True else "failed"
                        )

        items = [records[item_id] for item_id in order][-200:]
        todo_item = self._copilot_todos(session_dir)
        if todo_item:
            items.append(todo_item)
        conversation = {
            "agentId": agent["id"],
            "provider": "copilot",
            "providerSessionId": session_id,
            "semantic": True,
            "items": items,
            "activeHumanRequest": next(
                (
                    item["request"]
                    for item in reversed(items)
                    if item.get("kind") == "human_request"
                    and not item.get("resolved")
                ),
                None,
            ),
        }
        self.conversation_cache[cache_key] = (cache_version, conversation)
        return conversation

    def _normalize_copilot_question(
        self, request_id: str, arguments: dict[str, Any]
    ) -> dict[str, Any] | None:
        message = arguments.get("message")
        # Copilot writes ask_user two ways depending on the model behind it:
        # a plain {question, choices} pair, or a JSON-Schema {message,
        # requestedSchema}. Both appear in real session logs and the plain one
        # is by far the more common, so reading only the schema left most
        # questions invisible to the app.
        plain_question = arguments.get("question")
        plain_choices = arguments.get("choices")
        if isinstance(plain_question, str) and plain_question.strip():
            options = [
                {"id": str(choice), "label": str(choice)}
                for choice in plain_choices
                if isinstance(choice, (str, int, float))
            ] if isinstance(plain_choices, list) else []
            return {
                "id": request_id,
                "kind": "choice" if options else "text",
                "question": plain_question,
                "options": options,
                "allowCustomAnswer": True,
                "multiSelect": False,
            }
        schema = arguments.get("requestedSchema")
        properties = (
            schema.get("properties")
            if isinstance(schema, dict) and isinstance(schema.get("properties"), dict)
            else {}
        )
        if not properties:
            if isinstance(message, str):
                return {
                    "id": request_id,
                    "kind": "text",
                    "question": message,
                    "allowCustomAnswer": True,
                    "multiSelect": False,
                    "options": [],
                }
            return None
        field_name, field = next(iter(properties.items()))
        if not isinstance(field, dict):
            return None
        question = (
            field.get("title")
            or field.get("description")
            or message
            or str(field_name)
        )
        options: list[dict[str, str]] = []
        values = field.get("enum")
        if isinstance(values, list):
            names = field.get("enumNames")
            for index, value in enumerate(values):
                label = (
                    names[index]
                    if isinstance(names, list) and index < len(names)
                    else str(value)
                )
                options.append({"id": str(value), "label": str(label)})
        choices = field.get("oneOf")
        if isinstance(choices, list):
            for choice in choices:
                if isinstance(choice, dict) and "const" in choice:
                    options.append(
                        {
                            "id": str(choice["const"]),
                            "label": str(choice.get("title") or choice["const"]),
                        }
                    )
        field_type = field.get("type")
        kind = "choice" if options else "confirmation" if field_type == "boolean" else "text"
        return {
            "id": request_id,
            "kind": kind,
            "question": str(question),
            "options": options,
            "allowCustomAnswer": True,
            "multiSelect": field_type == "array",
        }

    def _copilot_todos(self, session_dir: Path) -> dict[str, Any] | None:
        database = session_dir / "session.db"
        if not database.is_file():
            return None
        try:
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
            rows = connection.execute(
                "select id, title, status from todos order by created_at"
            ).fetchall()
            connection.close()
            if not rows:
                return None
            if all(row[2] == "done" for row in rows):
                return None
            return {
                "id": "todos",
                "kind": "todo_update",
                "todos": [
                    {"id": row[0], "text": row[1], "state": row[2]}
                    for row in rows
                ],
            }
        except (sqlite3.Error, OSError):
            return None

    def _load_claude(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        candidates = list((Path.home() / ".claude" / "projects").glob("**/*.jsonl"))
        path = next((item for item in candidates if session_id in item.name), None)
        return self._load_role_jsonl(agent, path, "claude") if path else None

    def _load_codex(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = self._codex_uuid(agent.get("providerSessionId"))
        if not session_id:
            return None
        path = self._codex_transcript_path(session_id)
        if path is None:
            return None
        info = path.stat()
        version = (info.st_size, info.st_mtime_ns, info.st_ino, info.st_ctime_ns)
        key = (agent["id"], "codex", session_id)
        cached = self.conversation_cache.get(key)
        if cached and cached[0] == version:
            return cached[1]

        completed: list[dict[str, Any]] = []
        legacy: list[dict[str, Any]] = []
        positions: dict[str, int] = {}
        verified = False
        paginated = False
        with path.open(encoding="utf-8", errors="replace") as transcript:
            for line_number, line in enumerate(transcript):
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    continue
                if event.get("type") == "session_meta":
                    if self._codex_uuid(payload.get("id")) != session_id:
                        raise BridgeError(
                            "CONVERSATION_SESSION_MISMATCH",
                            "The Codex transcript belongs to a different thread.",
                        )
                    verified = True
                    paginated = payload.get("history_mode") == "paginated"
                    continue
                if event.get("type") != "event_msg":
                    continue
                event_type = payload.get("type")
                if event_type == "item_completed":
                    if payload.get("thread_id") not in (None, session_id):
                        continue
                    item = payload.get("item")
                    if not isinstance(item, dict):
                        continue
                    kind = item.get("type")
                    if kind not in ("UserMessage", "AgentMessage"):
                        continue
                    if kind == "AgentMessage" and item.get("phase") not in (
                        None, "commentary", "final_answer",
                    ):
                        continue
                    text = self._content_text(item.get("content"))
                    if not text:
                        continue
                    item_id = item.get("id") or f"line:{line_number}"
                    message = {
                        "id": f"codex:{kind}:{item_id}",
                        "kind": "user_message" if kind == "UserMessage" else "assistant_message",
                        "text" if kind == "UserMessage" else "markdown": text,
                    }
                    if message["id"] in positions:
                        completed[positions[message["id"]]] = message
                    else:
                        positions[message["id"]] = len(completed)
                        completed.append(message)
                elif event_type in ("user_message", "agent_message"):
                    text = payload.get("message")
                    if isinstance(text, str) and text:
                        legacy.append({
                            "id": f"codex:{session_id}:line:{line_number}",
                            "kind": "user_message" if event_type == "user_message" else "assistant_message",
                            "text" if event_type == "user_message" else "markdown": text,
                        })
        if not verified:
            return None
        conversation = {
            "agentId": agent["id"],
            "provider": "codex",
            "providerSessionId": session_id,
            "semantic": True,
            "items": completed if paginated or completed else legacy,
            "activeHumanRequest": None,
        }
        self.conversation_cache[key] = (version, conversation)
        return conversation

    def _codex_transcript_path(self, session_id: str) -> Path | None:
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
        indexes = []
        for path in home.glob("state_*.sqlite"):
            match = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
            if match:
                indexes.append((int(match.group(1)), path))
        for _, database in sorted(indexes, reverse=True):
            try:
                connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
                try:
                    row = connection.execute(
                        "SELECT rollout_path FROM threads WHERE id = ?", (session_id,)
                    ).fetchone()
                finally:
                    connection.close()
            except sqlite3.Error as error:
                self._diagnostic("CODEX_TRANSCRIPT_INDEX", str(error))
                continue
            if row:
                if not isinstance(row[0], str) or not row[0]:
                    raise BridgeError("CONVERSATION_UNAVAILABLE", "Codex has an invalid transcript index entry.")
                path = Path(row[0])
                return path if path.suffix == ".jsonl" and path.is_file() else None
        candidates = list((home / "sessions").glob(f"**/*{session_id}*.jsonl"))
        if len(candidates) > 1:
            raise BridgeError("CONVERSATION_UNAVAILABLE", "Multiple Codex transcripts match this thread without an authoritative index.")
        return candidates[0] if candidates else None

    def _load_role_jsonl(
        self, agent: dict[str, Any], path: Path, provider: str
    ) -> dict[str, Any] | None:
        items: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8", errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                role = event.get("role") or event.get("type")
                message = event.get("message") or event.get("content")
                if isinstance(message, dict):
                    role = message.get("role") or role
                    message = message.get("content")
                text = self._content_text(message)
                if not text:
                    continue
                event_id = str(event.get("id") or uuid.uuid4())
                if role in ("user", "user_message"):
                    items.append(
                        {"id": event_id, "kind": "user_message", "text": text}
                    )
                elif role in ("assistant", "assistant_message"):
                    items.append(
                        {
                            "id": event_id,
                            "kind": "assistant_message",
                            "markdown": text,
                        }
                    )
        return {
            "agentId": agent["id"],
            "provider": provider,
            "providerSessionId": agent.get("providerSessionId"),
            "semantic": True,
            "items": items,
            "activeHumanRequest": None,
        }

    def _load_fallback(self, agent: dict[str, Any]) -> dict[str, Any]:
        source = "visible" if agent.get("status") == "working" else "recent_unwrapped"
        result = self._herdr_request(
            "agent.read",
            {
                "target": agent["paneId"],
                "source": source,
                "format": "text",
                "strip_ansi": True,
                "lines": 240,
            },
        )
        read = result.get("read") if isinstance(result, dict) else None
        text = read.get("text") if isinstance(read, dict) else ""
        return {
            "agentId": agent["id"],
            "provider": agent["provider"],
            "providerSessionId": agent.get("providerSessionId"),
            "semantic": False,
            "items": [
                {
                    "id": f"raw:{agent['paneId']}:{read.get('revision', 0) if isinstance(read, dict) else 0}",
                    "kind": "raw_output",
                    "text": text or "No agent output is available.",
                }
            ],
            "activeHumanRequest": None,
        }

    def _subscription_loop(self) -> None:
        retry_delay = SUBSCRIPTION_RETRY_INITIAL
        while self.running:
            resynchronize = self.subscribed.is_set()
            try:
                self._read_global_subscription(resynchronize)
            except Exception as error:
                self._diagnostic("HERDR_EVENT", repr(error))
            finally:
                self.subscribed.set()
            if not self.running:
                return
            if self.live.is_set():
                self.write_event(
                    "connection.warning",
                    {
                        "code": "EVENT_STREAM_CLOSED",
                        "message": "Herdr events are reconnecting.",
                    },
                )
            self._wait_for_subscription_retry(retry_delay)
            retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)

    def _read_global_subscription(self, resynchronize: bool = False) -> None:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(self.herdr_socket)
            request = {
                "id": "mobile-subscription",
                "method": "events.subscribe",
                "params": {
                    "subscriptions": [{"type": item} for item in SUBSCRIPTIONS]
                },
            }
            connection.sendall((json.dumps(request) + "\n").encode())
            stream = connection.makefile("r", encoding="utf-8")
            acknowledgement = json.loads(stream.readline())
            if acknowledgement.get("error"):
                raise BridgeError(
                    "SUBSCRIPTION_FAILED",
                    str(acknowledgement["error"].get("message", "Unknown error")),
                )
            self.subscribed.set()
            if resynchronize:
                with self.refresh_lock:
                    self._refresh_runtime()
                    self.write_event("runtime.snapshot", self.runtime)
            while self.running:
                line = stream.readline()
                if not line:
                    return
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not self.live.is_set():
                    self.buffered_events.put(event)
                else:
                    self._handle_herdr_event(event)

    def _ensure_pane_subscriptions(self) -> None:
        with self.state_lock:
            pane_ids = {
                str(agent.get("paneId"))
                for agent in self.raw_agents.values()
                if agent.get("paneId")
            }
        for pane_id in pane_ids:
            with self.pane_subscription_lock:
                if pane_id in self.pane_subscriptions:
                    continue
                self.pane_subscriptions.add(pane_id)
            threading.Thread(
                target=self._pane_subscription_loop,
                args=(pane_id,),
                name=f"herdr-status-{pane_id}",
                daemon=True,
            ).start()

    def _pane_subscription_loop(self, pane_id: str) -> None:
        retry_delay = SUBSCRIPTION_RETRY_INITIAL
        try:
            while self.running and self._pane_is_active(pane_id):
                try:
                    self._read_pane_subscription(pane_id)
                except Exception as error:
                    self._diagnostic("HERDR_EVENT", f"{pane_id}: {error!r}")
                if not self.running or not self._pane_is_active(pane_id):
                    return
                self._wait_for_subscription_retry(retry_delay)
                retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)
        finally:
            with self.pane_subscription_lock:
                self.pane_subscriptions.discard(pane_id)

    def _read_pane_subscription(self, pane_id: str) -> None:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(self.herdr_socket)
            request = {
                "id": "mobile-status-" + uuid.uuid4().hex,
                "method": "events.subscribe",
                "params": {
                    "subscriptions": [
                        {
                            "type": "pane.agent_status_changed",
                            "pane_id": pane_id,
                        }
                    ]
                },
            }
            connection.sendall((json.dumps(request) + "\n").encode())
            stream = connection.makefile("r", encoding="utf-8")
            acknowledgement = json.loads(stream.readline())
            if acknowledgement.get("error"):
                raise BridgeError(
                    "SUBSCRIPTION_FAILED",
                    str(acknowledgement["error"].get("message", "Unknown error")),
                )
            while self.running and self._pane_is_active(pane_id):
                line = stream.readline()
                if not line:
                    return
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not self.live.is_set():
                    self.buffered_events.put(event)
                else:
                    self._handle_herdr_event(event)

    def _pane_is_active(self, pane_id: str) -> bool:
        with self.state_lock:
            return any(
                agent.get("paneId") == pane_id for agent in self.raw_agents.values()
            )

    def _wait_for_subscription_retry(self, delay: float) -> None:
        deadline = time.monotonic() + delay
        while self.running:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.1, remaining))

    def _handle_herdr_event(self, event: dict[str, Any]) -> None:
        with self.refresh_lock:
            self._handle_locked_herdr_event(event)

    def _handle_locked_herdr_event(self, event: dict[str, Any]) -> None:
        try:
            self._refresh_runtime(inspect_copilot=False)
            self.write_event("runtime.snapshot", self.runtime)
            data = event.get("data")
            if isinstance(data, dict) and data.get("type") in (
                "pane_output_changed",
                "pane_agent_status_changed",
                "pane_agent_detected",
            ):
                pane_id = data.get("pane_id")
                agent = next(
                    (
                        item
                        for item in self.raw_agents.values()
                        if item.get("paneId") == pane_id
                    ),
                    None,
                )
                if agent:
                    self.write_event(
                        "conversation.changed", {"agentId": agent["id"]}
                    )
        except Exception as error:
            self._diagnostic("HERDR_EVENT", repr(error))

    def _herdr_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = "mobile-" + uuid.uuid4().hex
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(12)
            connection.connect(self.herdr_socket)
            connection.sendall(
                (
                    json.dumps(
                        {"id": request_id, "method": method, "params": params},
                        separators=(",", ":"),
                    )
                    + "\n"
                ).encode()
            )
            stream = connection.makefile("r", encoding="utf-8")
            line = stream.readline()
        if not line:
            raise BridgeError("HERDR_DISCONNECTED", "Herdr closed the connection.")
        response = json.loads(line)
        if "error" in response:
            error = response["error"]
            raise BridgeError(
                str(error.get("code") or "HERDR_ERROR"),
                str(error.get("message") or "Herdr request failed."),
            )
        result = response.get("result")
        if not isinstance(result, dict):
            raise BridgeError("INVALID_HERDR_RESPONSE", "Herdr result is invalid.")
        return result

    def _capabilities(self, *, check_store: bool = True) -> dict[str, Any]:
        if check_store:
            try:
                self._command_ledger().check_available()
                self.command_store_error = None
            except BridgeError as error:
                self.command_store_error = error
        availability = {
            item.get("provider"): item.get("available") is True
            for item in self.agent_catalog or []
        }
        provider_capabilities = {}
        for provider in SUPPORTED_PROVIDERS:
            provider_capabilities[provider] = {
                "installed": availability.get(provider, False),
                "supportsRetuning": provider in RETUNABLE_PROVIDERS,
                "structuredConversation": provider in ("copilot", "claude", "codex"),
                "streamingConversation": provider == "copilot",
                "structuredQuestions": provider == "copilot",
                "permissions": False,
                "todos": provider == "copilot",
                "fallback": True,
            }
        return {
            "durableCommands": self.command_store_error is None,
            "durableCommandsRequireSessionIdentity": True,
            "durableInterruptReplay": False,
            "providers": list(SUPPORTED_PROVIDERS),
            "providerCapabilities": provider_capabilities,
            "humanRequests": True,
            "toolActivity": True,
            "todos": True,
            "editAndResend": True,
        }

    def _agent_capabilities(
        self, provider: str, provider_session_id: Any
    ) -> dict[str, bool]:
        semantic = False
        if provider == "copilot" and isinstance(provider_session_id, str):
            semantic = (
                Path.home()
                / ".copilot"
                / "session-state"
                / provider_session_id
                / "events.jsonl"
            ).is_file()
        return {
            "supportsRetuning": provider in RETUNABLE_PROVIDERS,
            "structuredConversation": semantic,
            "streamingConversation": semantic and provider == "copilot",
            "structuredQuestions": semantic and provider == "copilot",
            "toolActivity": semantic and provider == "copilot",
            "todos": semantic and provider == "copilot",
            "fallback": True,
        }

    @staticmethod
    def _provider(value: Any) -> str:
        normalized = str(value or "").lower().replace("-", "").replace("_", "")
        if "copilot" in normalized:
            return "copilot"
        if "claude" in normalized:
            return "claude"
        if "codex" in normalized:
            return "codex"
        if normalized in ("cursor", "cursoragent"):
            return "cursor"
        return "unknown"

    @staticmethod
    def _provider_label(provider: str) -> str:
        return {
            "copilot": "GitHub Copilot",
            "claude": "Claude Code",
            "codex": "Codex",
            "cursor": "Cursor Agent",
        }.get(provider, "Agent")

    @staticmethod
    def _status(value: Any) -> str:
        status = str(value or "unknown").lower()
        return status if status in ("idle", "working", "blocked", "done") else "unknown"

    @staticmethod
    def _content_text(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts = []
            for item in value:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "\n".join(parts)
        return ""

    @staticmethod
    def _tool_title(tool: str) -> str:
        return {
            "view": "Reading",
            "read": "Reading",
            "apply_patch": "Editing",
            "edit": "Editing",
            "create": "Creating",
            "bash": "Running",
            "rg": "Searching",
            "grep": "Searching",
            "glob": "Finding files",
            "task": "Delegating",
            "sql": "SQL",
            "task_complete": "Task complete",
        }.get(tool, tool.replace("_", " ").title())

    @staticmethod
    def _tool_detail(arguments: Any) -> str | None:
        if not isinstance(arguments, dict):
            return None
        for key in ("path", "file_path", "query", "pattern", "description", "command"):
            value = arguments.get(key)
            if isinstance(value, str) and value:
                return value[:240]
        return None

    def write_event(self, event: str, data: dict[str, Any]) -> None:
        self.write(
            {
                "protocol": PROTOCOL,
                "type": "event",
                "event": event,
                "data": data,
            }
        )

    def _write_error(self, request_id: str | None, code: str, message: str) -> None:
        self.write(
            {
                "protocol": PROTOCOL,
                "id": request_id,
                "type": "response",
                "ok": False,
                "error": {"code": code, "message": message},
            }
        )

    def write(self, message: dict[str, Any]) -> None:
        encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        with self.output_lock:
            sys.stdout.write(encoded + "\n")
            sys.stdout.flush()

    @staticmethod
    def _diagnostic(tag: str, message: str) -> None:
        print(f"[{tag}] {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    Bridge().run()
