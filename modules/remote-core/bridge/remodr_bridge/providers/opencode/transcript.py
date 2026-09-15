"""Read-only, exact-session SQLite projection; never discovers sessions by cwd/mtime.

Pinned upstream schema and path contract (OpenCode v1.18.29):
https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/session/sql.ts
https://github.com/anomalyco/opencode/blob/v1.18.29/packages/schema/src/session-message.ts
https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/database/database.ts
https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/global.ts
Global uses xdg-basedir on every platform, not macOS Application Support.
Channel-specific databases require an explicit override; no directory scanning.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Any, Iterator

from ...formatting import tool_detail, tool_title

MAX_MESSAGES = 200
MAX_TODOS = 1_000
MAX_TODO_CONTENT = 10_000
TODO_STATUSES = {
    "pending": "pending",
    "in_progress": "in_progress",
    "completed": "done",
    "cancelled": "cancelled",
}


class TranscriptError(ValueError):
    """Unsupported or invalid persisted data (messages never include raw payloads)."""


def session_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"ses_[A-Za-z0-9]+", value) is not None


def model_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"[A-Za-z0-9._-]+/[^\s\x00-\x1f\x7f]+", value) is not None
    )


def database_path() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME", "")
    data = (Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / ".local/share") / "opencode"
    override = os.environ.get("REMODR_OPENCODE_DB") or os.environ.get("OPENCODE_DB")
    if override == ":memory:":
        raise TranscriptError("In-memory OpenCode databases cannot be read by the bridge.")
    path = Path(override) if override else Path("opencode.db")
    return path if path.is_absolute() else data / path


@contextmanager
def database() -> Iterator[sqlite3.Connection | None]:
    path = database_path()
    if not path.is_file():
        yield None
        return
    connection = None
    try:
        # Do not use immutable=1: live OpenCode commits normally reside in WAL.
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        yield connection
    except sqlite3.Error as error:
        raise TranscriptError("The OpenCode database could not be read with the supported schema.") from error
    finally:
        if connection is not None:
            connection.close()


def schema(connection: sqlite3.Connection) -> set[str]:
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    required = {
        "session": {"id", "revert", "model"},
        "session_message": {"id", "session_id", "type", "seq", "data"},
        "message": {"id", "session_id", "time_created", "data"},
        "part": {"id", "session_id", "message_id", "data"},
        "todo": {
            "session_id", "content", "status", "priority", "position",
            "time_created", "time_updated",
        },
    }
    if "session" not in tables or not (
        "session_message" in tables or {"message", "part"} <= tables
    ) or (("message" in tables) != ("part" in tables)):
        raise TranscriptError("Unsupported OpenCode database schema.")
    for table, columns in required.items():
        if table in tables:
            actual = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
            if not columns <= actual:
                raise TranscriptError("Unsupported OpenCode database columns.")
    return tables


def database_supported() -> bool:
    try:
        with database() as connection:
            if connection is None:
                return False
            schema(connection)
            return True
    except (TranscriptError, OSError):
        return False


def todos_supported() -> bool:
    try:
        with database() as connection:
            if connection is None:
                return False
            return "todo" in schema(connection)
    except (TranscriptError, OSError):
        return False


def object_data(value: Any) -> dict[str, Any]:
    try:
        result = json.loads(value)
    except (ValueError, TypeError) as error:
        raise TranscriptError("Invalid OpenCode JSON data.") from error
    if not isinstance(result, dict):
        raise TranscriptError("Invalid OpenCode JSON object.")
    return result


def text(value: Any) -> str:
    if not isinstance(value, str):
        raise TranscriptError("Invalid OpenCode text field.")
    return value


def todo_field(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 128
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def visible(part: dict[str, Any]) -> bool:
    return not any(part.get(flag) for flag in ("synthetic", "ignored", "private"))


def project_part(key: str, role: str, part: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(part, dict):
        raise TranscriptError("Invalid OpenCode content part.")
    if not visible(part):
        return None
    kind = part.get("type")
    if kind == "text":
        value = text(part.get("text"))
        if not value:
            return None
        return {
            "id": key,
            "kind": "user_message" if role == "user" else "assistant_message",
            "text" if role == "user" else "markdown": value,
        }
    if kind != "tool" or role != "assistant":
        return None
    state = part.get("state")
    if not isinstance(state, dict):
        raise TranscriptError("Invalid OpenCode tool state.")
    native_status = state.get("status")
    if not isinstance(native_status, str):
        raise TranscriptError("Invalid OpenCode tool status.")
    status = {
        "pending": "running", "running": "running", "completed": "completed", "error": "failed",
    }.get(native_status)
    if status is None:
        raise TranscriptError("Unsupported OpenCode tool state.")
    name = text(part.get("name", part.get("tool")))
    if name == "question":
        request = normalize_question(key, state.get("input")) or normalize_question(
            key, state.get("structured"),
        )
        if request:
            item = {"id": key, "kind": "human_request", "request": request}
            if status in ("completed", "failed"):
                item["resolved"] = True
            return item
    return {
        "id": key,
        "kind": "tool_activity",
        "tool": name,
        "title": tool_title(name),
        "detail": tool_detail(state.get("input")),
        "state": status,
    }


def question_payload(value: Any) -> Any:
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return None
    return value


def question_options(value: Any) -> list[dict[str, str]]:
    options: list[dict[str, str]] = []
    if not isinstance(value, list):
        return options
    for option in value:
        if isinstance(option, dict):
            label = option.get("label") or option.get("id") or option.get("const")
            if not isinstance(label, str) or not label.strip():
                continue
            item = {"id": str(option.get("id") or label), "label": label}
            description = option.get("description") or option.get("title")
            if isinstance(description, str) and description.strip() and description != label:
                item["description"] = description
            options.append(item)
        elif isinstance(option, (str, int, float)):
            options.append({"id": str(option), "label": str(option)})
    return options


def normalize_question(request_id: str, arguments: Any) -> dict[str, Any] | None:
    """Map OpenCode's question tool to Copilot's activeHumanRequest shape.

    Pending tools persist `input` as JSON text; running tools use an object.
    """
    payload = question_payload(arguments)
    first: dict[str, Any] | None = None
    if isinstance(payload, dict):
        questions = payload.get("questions")
        if isinstance(questions, list) and questions and isinstance(questions[0], dict):
            first = questions[0]
        elif isinstance(payload.get("question"), str):
            first = payload
    elif isinstance(payload, list) and payload and isinstance(payload[0], dict):
        first = payload[0]
    if first is None:
        return None
    question = first.get("question") or first.get("header") or first.get("message")
    if not isinstance(question, str) or not question.strip():
        return None
    options = question_options(first.get("options") or first.get("choices"))
    custom = first.get("custom")
    return {
        "id": request_id,
        "kind": "choice" if options else "text",
        "question": question,
        "options": options,
        "allowCustomAnswer": True if custom is None else custom is True,
        "multiSelect": first.get("multiple") is True,
    }


def project_todos(
    connection: sqlite3.Connection, identifier: str,
) -> dict[str, Any] | None:
    rows = connection.execute(
        """
        SELECT content, status, priority, position, time_updated
        FROM todo
        WHERE session_id = ?
        ORDER BY position
        LIMIT ?
        """,
        (identifier, MAX_TODOS + 1),
    ).fetchall()
    if not rows:
        return None
    if len(rows) > MAX_TODOS:
        raise TranscriptError("OpenCode returned too many todo items.")
    todos = []
    updated = 0
    for position, row in enumerate(rows):
        content = row["content"]
        status = row["status"]
        priority = row["priority"]
        if (
            row["position"] != position
            or not isinstance(content, str)
            or len(content) > MAX_TODO_CONTENT
            or not todo_field(status)
            or not todo_field(priority)
            or not isinstance(row["time_updated"], int)
            or row["time_updated"] < 0
        ):
            raise TranscriptError("Invalid OpenCode todo data.")
        todos.append({
            "id": f"opencode:{identifier}:todo:{position}",
            "text": content,
            "state": TODO_STATUSES.get(status, "unknown"),
        })
        updated = max(updated, row["time_updated"])
    return {
        "id": f"opencode:{identifier}:todos",
        "kind": "todo_update",
        "timestamp": updated,
        "todos": todos,
    }


def message_count(identifier: Any) -> int | None:
    """How many messages the exact session holds, or None if that is unknown.

    Used only to decide whether an abandoned session is safe to delete, so an
    unreadable database, an unsupported schema or a missing session all answer
    "unknown" rather than "empty". Nothing is ever deleted on a guess.
    """
    if not session_id(identifier):
        return None
    try:
        with database() as connection:
            if connection is None:
                return None
            tables = schema(connection)
            if connection.execute(
                "SELECT 1 FROM session WHERE id = ?", (identifier,)
            ).fetchone() is None:
                return None
            total = 0
            for table in ("session_message", "message"):
                if table in tables:
                    total += connection.execute(
                        f'SELECT count(*) FROM "{table}" WHERE session_id = ?', (identifier,)
                    ).fetchone()[0]
            return total
    except (TranscriptError, sqlite3.Error, OSError):
        return None


def read_session(identifier: Any) -> dict[str, Any] | None:
    if not session_id(identifier):
        raise TranscriptError("Invalid OpenCode session identifier.")
    with database() as connection:
        if connection is None:
            return None
        tables = schema(connection)
        session = connection.execute("SELECT revert FROM session WHERE id = ?", (identifier,)).fetchone()
        if session is None:
            raise TranscriptError("The exact OpenCode session is not present in the database.")
        if session["revert"] is not None and object_data(session["revert"]):
            # Both message- and part-level revert need native projection semantics.
            # Until implemented, fail explicitly rather than show reverted history.
            raise TranscriptError("OpenCode sessions with an active revert are not supported.")
        rows = []
        if "session_message" in tables:
            rows = connection.execute(
                "SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
                (identifier, MAX_MESSAGES),
            ).fetchall()
        items = []
        if rows:
            for row in reversed(rows):
                data = object_data(row["data"])
                role = row["type"]
                if role not in (
                    "user", "assistant", "synthetic", "system", "shell",
                    "compaction", "agent-switched", "model-switched",
                ):
                    raise TranscriptError("Unsupported OpenCode message type.")
                if role not in ("user", "assistant") or not visible(data):
                    continue
                prefix = f"opencode:{identifier}:{row['id']}"
                if role == "user":
                    value = text(data.get("text"))
                    if value:
                        items.append({"id": prefix, "kind": "user_message", "text": value})
                    continue
                content = data.get("content")
                if not isinstance(content, list):
                    raise TranscriptError("Invalid OpenCode assistant content.")
                for part in content:
                    if not isinstance(part, dict) or not isinstance(part.get("id"), str):
                        raise TranscriptError("Invalid OpenCode assistant part identity.")
                    item = project_part(f"{prefix}:{part['id']}", role, part)
                    if item:
                        items.append(item)
        elif {"message", "part"} <= tables:
            rows = connection.execute(
                "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?",
                (identifier, MAX_MESSAGES),
            ).fetchall()
            for row in reversed(rows):
                data = object_data(row["data"])
                role = data.get("role")
                if role not in ("user", "assistant") or not visible(data):
                    continue
                parts = connection.execute(
                    "SELECT id, data FROM part WHERE session_id = ? AND message_id = ? ORDER BY id",
                    (identifier, row["id"]),
                )
                for part in parts:
                    item = project_part(
                        f"opencode:{identifier}:{row['id']}:{part['id']}", role, object_data(part["data"]),
                    )
                    if item:
                        items.append(item)
        if "todo" in tables:
            todo_item = project_todos(connection, identifier)
            if todo_item:
                items.append(todo_item)
        return {"items": items}


def session_model(identifier: Any) -> str | None:
    if not session_id(identifier):
        return None
    try:
        with database() as connection:
            if connection is None:
                return None
            schema(connection)
            row = connection.execute("SELECT model FROM session WHERE id = ?", (identifier,)).fetchone()
            if row is None or row["model"] is None:
                return None
            model = object_data(row["model"])
            provider, name = model.get("providerID"), model.get("id")
            value = f"{provider}/{name}" if isinstance(provider, str) and isinstance(name, str) else None
            return value if model_id(value) else None
    except (TranscriptError, OSError):
        return None
