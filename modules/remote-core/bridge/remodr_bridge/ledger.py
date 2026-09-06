"""Private SQLite command reservations and durable results."""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import stat
import time
import uuid
from pathlib import Path
from typing import Any
from .constants import COMMAND_RESERVATION_SECONDS, COMMAND_MAX_ENTRIES, COMMAND_MAX_RESPONSE_BYTES
from .errors import BridgeError

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
        # Python 3.9 does not export SQLite's stable SQLITE_FULL result code.
        if getattr(error, "sqlite_errorcode", None) == getattr(sqlite3, "SQLITE_FULL", 13):
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
