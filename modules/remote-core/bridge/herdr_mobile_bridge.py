#!/usr/bin/env python3
"""Herdr mobile bridge.

stdin/stdout use Remote Workspace protocol 1 as NDJSON.
stderr is reserved for diagnostics. The Herdr socket never leaves the server.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "0.1.0"
PROTOCOL = 1
SUPPORTED_PROVIDERS = ("copilot", "claude", "codex", "opencode")
BYPASS_ARGUMENTS = {
    "claude": ["--dangerously-skip-permissions"],
    "codex": ["--dangerously-bypass-approvals-and-sandbox"],
    "copilot": ["--allow-all-tools"],
    "opencode": ["--auto"],
}
SHELL_READY_TIMEOUT = 20
"""How long a freshly made pane is given to reach its shell prompt."""

MAX_AGENT_NAME = 60
"""Longest name a tab label will carry, so one cannot fill the list row."""

# The bridge's half of the model catalogue: which flags each CLI takes. The
# app holds the other half — which models and settings to offer — in
# `src/domain/agent-catalogue.ts`. A CLI must appear in both or neither: models
# offered with no flags here cannot be sent, and flags here with no models
# there are never asked for.
TUNING_ARGUMENTS = {
    # Only Copilot for now. The others take a model differently, or not at all
    # from the command line, and guessing a flag would fail at startup with
    # nothing useful to show for it.
    "copilot": {
        "model": "--model",
        "effort": "--effort",
        "context": "--context",
    },
}

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

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

SUBSCRIPTION_RETRY_INITIAL = 0.25
SUBSCRIPTION_RETRY_MAX = 2.0
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
        # Pane id -> the model, effort and context it was last started with.
        self.agent_tuning: dict[str, dict[str, Any]] = {}
        # Pane id -> whether it was started with its permissions bypassed.
        self.agent_bypass: dict[str, bool] = {}
        # Session id -> (bytes of the log already read, settings found in them).
        self.session_tuning_cache: dict[str, tuple[int, dict[str, Any]]] = {}
        self.output_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.refresh_lock = threading.Lock()
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
        self.pending_agents: dict[str, dict[str, Any]] = {}
        self.conversation_cache: dict[
            str, tuple[tuple[int, int, int, int], dict[str, Any]]
        ] = {}

    def run(self) -> None:
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
            herdr_version = self.runtime.get("herdrVersion", "unknown")
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": herdr_version,
                    "herdrProtocol": self.runtime.get("herdrProtocol"),
                    "capabilities": self._capabilities(),
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
                    "capabilities": self._capabilities(),
                    "warning": str(error),
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
        if action == "runtime.snapshot":
            self._refresh_runtime()
            return self.runtime
        if action == "agent.conversation":
            agent = self._require_agent(payload)
            return self._load_conversation(agent)
        if action == "agent.send_message":
            agent = self._require_agent(payload)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BridgeError("INVALID_MESSAGE", "Message cannot be empty.")
            self._herdr_request(
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
            self._herdr_request(
                "agent.send_keys",
                {"target": agent["paneId"], "keys": ["ctrl-c"]},
            )
            return {"accepted": True}
        raise BridgeError("UNKNOWN_ACTION", f"Unsupported action: {action}")

    def _answer_human_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = payload.get("requestId")
        agent = self._require_agent(payload)
        if not isinstance(request_id, str):
            raise BridgeError("INVALID_REQUEST", "Human request ID is required.")
        request = self.pending_human_requests.get(request_id)
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
                self._herdr_request(
                    "agent.prompt",
                    {"target": agent["paneId"], "text": text},
                )
            except BridgeError as error:
                if error.code != "agent_blocked":
                    raise
                self._answer_blocked_dialog(agent, request, selected_ids, text)
        self.pending_human_requests.pop(request_id, None)
        return {"accepted": True}

    @staticmethod
    def _agent_is_blocked(agent: dict[str, Any]) -> bool:
        return Bridge._status(agent.get("agent_status")) == "blocked"

    def _send_keys(self, agent: dict[str, Any], keys: list[str]) -> None:
        if keys:
            self._herdr_request(
                "agent.send_keys", {"target": agent["paneId"], "keys": keys}
            )

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
        return agent

    def _refresh_runtime(self) -> None:
        with self.refresh_lock:
            result = self._herdr_request("session.snapshot", {})
            snapshot = result.get("snapshot")
            if not isinstance(snapshot, dict):
                raise BridgeError(
                    "INVALID_HERDR_RESPONSE", "Herdr snapshot is missing."
                )
            self._agent_catalog_snapshot()
            normalized = self._normalize_snapshot(snapshot)
            with self.state_lock:
                self.runtime = normalized
            self._ensure_pane_subscriptions()

    def _normalize_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
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
            if not provider_session_id:
                # Herdr only learns a session id once the agent writes its
                # state out, which is after it has done something. For an agent
                # this app started we already know it, so the conversation can
                # be read from the first moment rather than falling back to
                # scraping the terminal.
                provider_session_id = self.started_sessions.get(pane_id)
            agent_id = self._stable_agent_id(pane_id)
            workspace_id = str(raw.get("workspace_id") or "")
            capabilities = self._agent_capabilities(provider, provider_session_id)
            agent = {
                "id": agent_id,
                "deviceId": self.device_id,
                "provider": provider,
                "providerSessionId": provider_session_id,
                "tuning": self._reported_tuning(pane_id, provider_session_id),
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
        provider = payload.get("provider")
        workspace_id = payload.get("workspaceId")
        bypass_permissions = payload.get("bypassPermissions", True)
        name_input = payload.get("name")
        label = (
            name_input.strip()[:MAX_AGENT_NAME]
            if isinstance(name_input, str) and name_input.strip()
            else ""
        )
        tuning = self._tuning_arguments(provider, payload)
        if provider not in SUPPORTED_PROVIDERS:
            raise BridgeError("INVALID_PROVIDER", "Unsupported agent provider.")
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
                self._refresh_runtime()
                agent = next(
                    (
                        item
                        for item in self.runtime.get("agents", [])
                        if isinstance(item, dict) and item.get("paneId") == pane_id
                    ),
                    None,
                )
                if agent:
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
        flags = TUNING_ARGUMENTS.get(str(provider), {})
        arguments: list[str] = []
        model = payload.get("model")
        if "model" in flags and isinstance(model, str) and model.strip():
            arguments.extend([flags["model"], model.strip()])
        effort = payload.get("effort")
        if "effort" in flags and isinstance(effort, str) and effort.strip():
            if effort not in REASONING_EFFORTS:
                raise BridgeError("INVALID_EFFORT", "Unsupported reasoning effort.")
            arguments.extend([flags["effort"], effort])
        context = payload.get("context")
        if "context" in flags and isinstance(context, str) and context.strip():
            if context not in CONTEXT_TIERS:
                raise BridgeError("INVALID_CONTEXT", "Unsupported context window.")
            arguments.extend([flags["context"], context])
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
        """Change the model, reasoning effort or context window of a live agent.

        A model can be swapped in place — Copilot takes `/model` mid-session —
        but effort and context are only read at startup. Those are changed by
        quitting the CLI and starting it again on the same session id, which
        resumes the conversation rather than beginning a new one.
        """
        agent = self._require_agent(payload)
        provider = agent.get("provider")
        if provider not in TUNING_ARGUMENTS:
            raise BridgeError(
                "PROVIDER_NOT_TUNABLE",
                f"{self._provider_label(str(provider))} cannot be tuned from here.",
            )
        pane_id = agent.get("paneId")
        if not isinstance(pane_id, str) or not pane_id:
            raise BridgeError("AGENT_NOT_FOUND", "This agent has no pane.")

        wanted = self._tuning_of(payload)
        # Validate before touching anything, so a bad value cannot leave the
        # agent stopped.
        self._tuning_arguments(provider, wanted)
        with self.state_lock:
            session_id = self.started_sessions.get(pane_id)
        if not session_id:
            session_id = agent.get("providerSessionId")
        # Against everything known about the agent, not only what was set from
        # here. Comparing against the latter alone made a plain model swap look
        # like a reasoning change on any agent this bridge did not start, and
        # restarting one to change nothing interrupts whatever it is doing.
        current = self._reported_tuning(pane_id, session_id)

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
        self, pane_id: str, provider_session_id: Any
    ) -> dict[str, Any]:
        """What the agent is actually running, as far as we can tell.

        What this app last set wins field by field, because that is what the
        agent will use next: the log can be a moment behind a change made from
        here.

        Everything not set from here comes from the log, which is how a
        conversation started before this bridge ran — or before it last
        restarted — still shows what it is actually running instead of
        claiming a default it never had.
        """
        ours = self.agent_tuning.get(pane_id) or {}
        logged = self._session_tuning(provider_session_id)
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
            return terminal_title.strip()
        for fallback in (name, tab_label):
            if isinstance(fallback, str) and fallback.strip():
                return fallback.strip()
        return self._provider_label(provider)

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
        provider = agent["provider"]
        try:
            if provider == "copilot":
                conversation = self._load_copilot(agent)
            elif provider == "claude":
                conversation = self._load_claude(agent)
            elif provider == "codex":
                conversation = self._load_codex(agent)
            elif provider == "opencode":
                conversation = self._load_opencode(agent)
            else:
                conversation = None
            if conversation and conversation.get("items"):
                return conversation
        except Exception as error:
            self._diagnostic(f"PROVIDER_{provider.upper()}", repr(error))
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
        cached = self.conversation_cache.get(session_id)
        if cached and cached[0] == cache_version:
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
                if not isinstance(event, dict):
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
                            self.pending_human_requests[request["id"]] = request
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
        self.conversation_cache[session_id] = (cache_version, conversation)
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
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        candidates = list((Path.home() / ".codex" / "sessions").glob("**/*.jsonl"))
        path = next((item for item in candidates if session_id in item.name), None)
        return self._load_role_jsonl(agent, path, "codex") if path else None

    def _load_opencode(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return None

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
        if not items:
            return None
        return {
            "agentId": agent["id"],
            "provider": provider,
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
        try:
            self._refresh_runtime()
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

    def _capabilities(self) -> dict[str, Any]:
        availability = {
            item.get("provider"): item.get("available") is True
            for item in self.agent_catalog or []
        }
        provider_capabilities = {}
        for provider in SUPPORTED_PROVIDERS:
            provider_capabilities[provider] = {
                "installed": availability.get(provider, False),
                "structuredConversation": provider in ("copilot", "claude", "codex"),
                "streamingConversation": provider == "copilot",
                "structuredQuestions": provider == "copilot",
                "permissions": False,
                "todos": provider == "copilot",
                "fallback": True,
            }
        return {
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
        if "opencode" in normalized:
            return "opencode"
        return "unknown"

    @staticmethod
    def _provider_label(provider: str) -> str:
        return {
            "copilot": "GitHub Copilot",
            "claude": "Claude Code",
            "codex": "Codex",
            "opencode": "OpenCode",
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
