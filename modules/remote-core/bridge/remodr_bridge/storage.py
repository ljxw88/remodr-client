"""Shared private on-disk storage: strict ownership, locking and pinned schema.

The durable command ledger and the OpenCode server registry both keep a
user-private SQLite database under the same directory, and both need the same
rules: real user-owned paths, no symbolic links anywhere on the way in, 0600
files and 0700 directories, an exclusive lock over an initialization marker
that is fsynced before use, and a schema version that is never migrated in
place. Those rules live here once rather than being copied with small
differences, because a difference between two copies is exactly how one of
them ends up weaker than the other.

Each store keeps its own database file, marker and error vocabulary, so a
change to one cannot alter or reset the other.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sqlite3
import stat
from pathlib import Path
from typing import Any

from .errors import BridgeError

STORAGE_DIRECTORY = ".local/share/remote-workspace"


def bridge_scope(
    uid: int, device_id: str, session_name: str, socket_path: str
) -> str:
    """Stable identity for one user's bridge against one Herdr session."""
    return hashlib.sha256(
        json.dumps(
            [uid, device_id, session_name, socket_path], separators=(",", ":")
        ).encode()
    ).hexdigest()


def host_scope(host: Any) -> str:
    return bridge_scope(
        os.getuid(),
        host.device_id,
        host.session_name,
        os.path.abspath(host.herdr_socket),
    )


def store_error(
    error: Exception,
    path: Path | None,
    *,
    noun: str,
    hint: str,
    full_code: str,
    busy_code: str,
    unavailable_code: str,
    sqlite_module: Any = sqlite3,
) -> BridgeError:
    # Python 3.9 does not export SQLite's stable SQLITE_FULL result code.
    if getattr(error, "sqlite_errorcode", None) == getattr(sqlite_module, "SQLITE_FULL", 13):
        return BridgeError(full_code, f"{noun} has reached capacity.")
    if isinstance(error, sqlite_module.OperationalError) and (
        "locked" in str(error).lower() or "busy" in str(error).lower()
    ):
        return BridgeError(busy_code, f"{noun} is busy.")
    location = getattr(error, "filename", None) or path
    detail = f" at '{location}'" if location is not None else ""
    return BridgeError(
        unavailable_code,
        f"{noun}{detail} is unavailable: {error}. {hint}",
    )


class PrivateStore:
    """A single-file, user-private SQLite store with a pinned schema."""

    noun = "Storage"
    lower_noun = "storage"
    repair_hint = "Repair this path before reconnecting."
    store_hint = "Check ownership, permissions, and free space."
    unavailable_code = "STORE_UNAVAILABLE"
    busy_code = "STORE_BUSY"
    full_code = "STORE_FULL"
    file_name = "storage.sqlite3"
    marker_name = "storage.initialized"
    lock_name = "storage.lock"
    user_version = 1
    schema: tuple[str, ...] = ()
    max_page_count = 16384

    def __init__(self) -> None:
        self.path = Path.home() / STORAGE_DIRECTORY / self.file_name

    def _private(self, path: Path, directory: bool = False) -> None:
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
                self.unavailable_code,
                f"{self.noun} path '{path}' {reason}. {self.repair_hint}",
            )

    def _prepare_directory(self, path: Path, private: bool) -> None:
        path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise BridgeError(
                self.unavailable_code,
                f"{self.noun} path '{path}' is not a real directory "
                "(symbolic links are refused). Repair the path before reconnecting.",
            )
        if info.st_uid != os.getuid():
            raise BridgeError(
                self.unavailable_code,
                f"{self.noun} path '{path}' is owned by uid {info.st_uid}, "
                f"expected uid {os.getuid()}. Repair ownership before reconnecting.",
            )
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_uid) != (
                info.st_dev, info.st_ino, os.getuid()
            ):
                raise BridgeError(
                    self.unavailable_code,
                    f"{self.noun} path '{path}' changed during validation; reconnect safely.",
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
                        self.unavailable_code,
                        f"Cannot secure {self.lower_noun} directory '{path}' to "
                        f"mode {desired:04o}: {error}. Repair permissions before reconnecting.",
                    ) from error
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise BridgeError(
                    self.unavailable_code,
                    f"{self.noun} path '{path}' changed while securing permissions.",
                )
            if current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) != desired:
                raise BridgeError(
                    self.unavailable_code,
                    f"{self.noun} directory '{path}' could not be secured to "
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
            # The lock is taken on a file that is never created exclusively, so
            # every process converges on the same inode. Deciding whether to
            # initialize before holding it would publish a marker that another
            # process could act on while this one was still creating the
            # database, leaving a marker with nothing behind it.
            lock_path = directory / self.lock_name
            lock_fd = os.open(
                lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
            )
            self._private(lock_path)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BridgeError(self.busy_code, f"{self.noun} is busy.")
            marker = directory / self.marker_name
            initialize = False
            try:
                marker_fd = os.open(
                    marker, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600
                )
                try:
                    initialize = True
                    os.fsync(marker_fd)
                finally:
                    os.close(marker_fd)
                directory_fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except FileExistsError:
                pass
            self._private(marker)
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
            connection.execute(f"PRAGMA max_page_count={int(self.max_page_count)}")
            connection.execute("BEGIN IMMEDIATE")
            if created:
                for statement in self.schema:
                    connection.execute(statement)
                connection.execute(f"PRAGMA user_version={int(self.user_version)}")
            elif connection.execute("PRAGMA user_version").fetchone()[0] != self.user_version:
                raise BridgeError(
                    self.unavailable_code, f"{self.noun} is not initialized."
                )
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise BridgeError(self.unavailable_code, f"{self.noun} is damaged.")
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

    @classmethod
    def _store_error(cls, error: Exception, path: Path | None = None) -> BridgeError:
        return store_error(
            error, path, noun=cls.noun, hint=cls.store_hint,
            full_code=cls.full_code, busy_code=cls.busy_code,
            unavailable_code=cls.unavailable_code,
        )
