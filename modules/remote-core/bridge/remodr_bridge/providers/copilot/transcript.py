"""Copilot events, question schemas and read-only todo snapshots."""
from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from ..base import ProviderHost
from ...formatting import tool_title, tool_detail

def load_conversation(host: ProviderHost, agent: dict[str, Any]) -> dict[str, Any] | None:
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
    cached = host.conversation_cache.get(cache_key)
    if cached and cached[0] == cache_version:
        request = cached[1].get("activeHumanRequest")
        if request:
            host._remember_human_request(request, agent)
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
                    request = normalize_question(
                        tool_call_id,
                        arguments if isinstance(arguments, dict) else {},
                    )
                    if request:
                        host._remember_human_request(request, agent)
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
                        "title": tool_title(tool_name),
                        "detail": tool_detail(arguments),
                        "state": "running",
                        "timestamp": timestamp,
                    },
                )
            elif event_type == "tool.execution_complete":
                tool_call_id = str(data.get("toolCallId") or event_id)
                if tool_call_id in human_tool_ids:
                    request_id = human_tool_ids[tool_call_id]
                    host.pending_human_requests.pop(request_id, None)
                    host.human_request_scopes.pop(request_id, None)
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
    todo_item = load_todos(session_dir)
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
    host.conversation_cache[cache_key] = (cache_version, conversation)
    return conversation


def normalize_question(
    request_id: str, arguments: dict[str, Any]
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


def load_todos(session_dir: Path) -> dict[str, Any] | None:
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
