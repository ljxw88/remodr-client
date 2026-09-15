"""Private, durable record of the servers this bridge started OpenCode TUIs with.

A managed OpenCode TUI is launched with a generated username and password so
the HTTP server it exposes answers only to this bridge. Those credentials have
to survive a bridge restart or the running agent becomes unreachable, and they
must never travel inside a command payload, a runtime snapshot or a diagnostic,
so they live in their own private database beside the command ledger rather
than inside it. The command ledger's schema is pinned and must not be migrated;
a separate file with its own marker keeps both stores independent.

A record is only ever a *claim* about a pane. Nothing here proves the pane
still holds the process the credentials were generated for, so every reader
must verify process ownership before the credentials are used. Stale records
therefore fail closed rather than granting anything.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import os
import secrets
import sqlite3
import time
from typing import Any

from ...errors import BridgeError
from ...storage import PrivateStore

MAX_ENTRIES = 512
MAX_AGE_SECONDS = 90 * 24 * 60 * 60
# A snapshot taken before an agent existed can still be processed after its
# record is written, so a young record is never treated as proof of absence.
PRUNE_GRACE_SECONDS = 60
MAX_FIELD = 4096
BUSY_ATTEMPTS = 5
BUSY_DELAY = 0.05


@dataclass(frozen=True)
class ServerCredential:
    """Launch-time secret for one pane's OpenCode server. Never rendered."""

    pane_id: str
    cwd: str
    username: str
    password: str
    session_id: str
    created: float = 0.0

    def __repr__(self) -> str:
        # Tracebacks, diagnostics and test failures all reach for repr().
        return f"ServerCredential(pane_id={self.pane_id!r}, cwd={self.cwd!r})"

    __str__ = __repr__

    def authorization(self) -> str:
        return "Basic " + base64.b64encode(
            f"{self.username}:{self.password}".encode()
        ).decode("ascii")

    def environment(self) -> dict[str, str]:
        return {
            "OPENCODE_SERVER_USERNAME": self.username,
            "OPENCODE_SERVER_PASSWORD": self.password,
        }


class ServerRegistry(PrivateStore):
    noun = "OpenCode server storage"
    lower_noun = "OpenCode server storage"
    repair_hint = "Repair this path without deleting existing agent bindings."
    store_hint = "Check ownership, permissions, and free space; preserve existing agent bindings."
    unavailable_code = "OPENCODE_SERVER_STORE_UNAVAILABLE"
    busy_code = "OPENCODE_SERVER_STORE_BUSY"
    full_code = "OPENCODE_SERVER_STORE_FULL"
    file_name = "opencode-servers.sqlite3"
    marker_name = "opencode-servers.initialized"
    lock_name = "opencode-servers.lock"
    user_version = 1
    max_page_count = 2048
    schema = (
        """CREATE TABLE servers (
        scope TEXT NOT NULL, pane_id TEXT NOT NULL, cwd TEXT NOT NULL,
        username TEXT NOT NULL, password TEXT NOT NULL,
        session_id TEXT NOT NULL, created REAL NOT NULL,
        PRIMARY KEY(scope, pane_id))""",
    )

    def __init__(self, scope: str) -> None:
        super().__init__()
        self.scope = scope

    def _run(self, operation: Any, *, create: bool) -> Any:
        """Run one short transaction, retrying only a contended store.

        Contention can surface either while opening the store or on the
        transaction's own ``BEGIN IMMEDIATE``, and SQLite reports the second as
        a plain operational error. Both are translated first and retried on the
        same footing, so a busy moment is never reported as a broken store.
        """
        if not create and not self.path.exists():
            return None
        error: BridgeError | None = None
        for attempt in range(BUSY_ATTEMPTS):
            connection = None
            try:
                connection = self._connect()
                connection.execute("BEGIN IMMEDIATE")
                result = operation(connection)
                connection.execute("COMMIT")
                return result
            except BridgeError as failure:
                error = failure
            except (OSError, sqlite3.Error) as failure:
                error = self._store_error(failure, self.path)
            finally:
                if connection is not None:
                    connection.close()
            if error.code != self.busy_code:
                raise error
            if attempt + 1 < BUSY_ATTEMPTS:
                time.sleep(BUSY_DELAY)
        raise error

    @staticmethod
    def _field(value: Any, name: str) -> str:
        if not isinstance(value, str) or not value or len(value) > MAX_FIELD:
            raise BridgeError(
                "OPENCODE_SERVER_BINDING_INVALID",
                f"An OpenCode server binding needs a valid {name}.",
            )
        return value

    def record(self, credential: ServerCredential) -> None:
        """Persist one pane's credentials, replacing any previous claim on it."""
        pane_id = self._field(credential.pane_id, "pane")
        values = (
            self._field(credential.cwd, "directory"),
            self._field(credential.username, "username"),
            self._field(credential.password, "password"),
            self._field(credential.session_id, "session"),
        )
        created = time.time()

        def operation(connection: sqlite3.Connection) -> None:
            # Expiry is by age alone, so it is safe to apply to every scope:
            # it reclaims rows no scope could still be using and keeps one
            # abandoned device from filling the file for the others.
            connection.execute(
                "DELETE FROM servers WHERE created < ? OR created > ?",
                (created - MAX_AGE_SECONDS, created + MAX_AGE_SECONDS),
            )
            # The cap is this scope's alone. Another device, user or Herdr
            # session must not be able to refuse this one a binding, and a
            # full scope refuses the new record rather than evicting a live
            # agent's credentials to make room.
            count = connection.execute(
                "SELECT count(*) FROM servers WHERE scope=? AND pane_id<>?",
                (self.scope, pane_id),
            ).fetchone()[0]
            if count >= MAX_ENTRIES:
                raise BridgeError(
                    self.full_code,
                    "OpenCode server storage is full for this session; "
                    "no agent binding was replaced.",
                )
            connection.execute(
                "INSERT OR REPLACE INTO servers VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.scope, pane_id, *values, created),
            )

        self._run(operation, create=True)

    def retain(self, live_panes: set[str]) -> int:
        """Delete this scope's records for panes that are provably gone.

        ``live_panes`` must come from an authoritative snapshot of the Herdr
        session this scope names -- a partial or failed snapshot is not proof
        of absence, and the caller is responsible for that distinction. Records
        belonging to other scopes are never considered: this bridge knows
        nothing about another device's or another session's panes.

        Records younger than the grace period are kept regardless, because a
        snapshot taken before an agent was created can still arrive after it.
        """
        cutoff = time.time() - PRUNE_GRACE_SECONDS

        def operation(connection: sqlite3.Connection) -> int:
            rows = connection.execute(
                "SELECT pane_id FROM servers WHERE scope=? AND created<?",
                (self.scope, cutoff),
            ).fetchall()
            gone = [row["pane_id"] for row in rows if row["pane_id"] not in live_panes]
            for pane_id in gone:
                connection.execute(
                    "DELETE FROM servers WHERE scope=? AND pane_id=?", (self.scope, pane_id)
                )
            return len(gone)

        return self._run(operation, create=False) or 0

    def load(self, pane_id: str) -> ServerCredential | None:
        """Read a pane's claim. Never creates the store, never proves ownership."""
        if not isinstance(pane_id, str) or not pane_id:
            return None

        def operation(connection: sqlite3.Connection) -> Any:
            return connection.execute(
                "SELECT * FROM servers WHERE scope=? AND pane_id=?",
                (self.scope, pane_id),
            ).fetchone()

        row = self._run(operation, create=False)
        if row is None:
            return None
        record = dict(row)
        try:
            return ServerCredential(
                pane_id=self._field(record["pane_id"], "pane"),
                cwd=self._field(record["cwd"], "directory"),
                username=self._field(record["username"], "username"),
                password=self._field(record["password"], "password"),
                session_id=self._field(record["session_id"], "session"),
                created=float(record["created"]),
            )
        except (BridgeError, KeyError, TypeError, ValueError):
            return None

    def forget(self, pane_id: str) -> None:
        if not isinstance(pane_id, str) or not pane_id:
            return

        def operation(connection: sqlite3.Connection) -> None:
            connection.execute(
                "DELETE FROM servers WHERE scope=? AND pane_id=?", (self.scope, pane_id)
            )

        self._run(operation, create=False)

    def panes(self) -> frozenset[str]:
        def operation(connection: sqlite3.Connection) -> Any:
            return connection.execute(
                "SELECT pane_id FROM servers WHERE scope=?", (self.scope,)
            ).fetchall()

        rows = self._run(operation, create=False)
        return frozenset(row["pane_id"] for row in rows or ())


def generate_credentials(pane_id: str, cwd: str, session_id: str) -> ServerCredential:
    """Fresh per-agent credentials; never derived from anything guessable."""
    return ServerCredential(
        pane_id=pane_id,
        cwd=os.path.abspath(cwd),
        username="remodr-" + secrets.token_urlsafe(12),
        password=secrets.token_urlsafe(32),
        session_id=session_id,
    )
