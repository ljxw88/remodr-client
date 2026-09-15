"""Private SQLite command reservations and durable results."""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any
from .constants import COMMAND_RESERVATION_SECONDS, COMMAND_MAX_ENTRIES, COMMAND_MAX_RESPONSE_BYTES
from .errors import BridgeError
from .storage import PrivateStore, store_error

class CommandLedger(PrivateStore):
    """Never reclaim command IDs: an abandoned reservation is not permission to retry."""

    noun = "Command storage"
    lower_noun = "command storage"
    repair_hint = "Repair this path without deleting existing command history."
    store_hint = "Check ownership, permissions, and free space; preserve existing command history."
    unavailable_code = "COMMAND_STORE_UNAVAILABLE"
    busy_code = "COMMAND_IN_PROGRESS"
    full_code = "COMMAND_STORE_FULL"
    file_name = "commands.sqlite3"
    marker_name = "commands.initialized"
    lock_name = "commands.lock"
    user_version = 1
    schema = (
        """CREATE TABLE commands (
        scope TEXT NOT NULL, command_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL
        CHECK(state IN ('reserved','succeeded','failed','uncertain')),
        owner TEXT NOT NULL, pid INTEGER NOT NULL,
        created REAL NOT NULL, response TEXT,
        PRIMARY KEY(scope, command_id))""",
    )

    def __init__(self, scope: str) -> None:
        super().__init__()
        self.scope = scope
        self.owner = uuid.uuid4().hex

    @classmethod
    def _store_error(cls, error: Exception, path: Path | None = None) -> BridgeError:
        return store_error(
            error, path, noun=cls.noun, hint=cls.store_hint,
            full_code=cls.full_code, busy_code=cls.busy_code,
            unavailable_code=cls.unavailable_code, sqlite_module=sqlite3,
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
