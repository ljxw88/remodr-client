"""Exact-session projection of OpenCode's authenticated HTTP snapshots."""
from __future__ import annotations

import re
from typing import Any

from ...errors import BridgeError
from ...formatting import tool_detail, tool_title
from . import api
from .api import ServerBinding
from .transcript import session_id as valid_session_id

MAX_MESSAGES = 200
MAX_PARTS = 2_000
MAX_REQUESTS = 1_000
MAX_TODOS = 1_000
MAX_TEXT = 1_000_000
MAX_CONVERSATION_RESPONSE = 8 * 1024 * 1024
MAX_AUXILIARY_RESPONSE = 2 * 1024 * 1024
MAX_ANSWER_TEXT = 20_000
REQUEST_ID = re.compile(r"^(?:que|per)_[A-Za-z0-9_-]+$")


class NativeSnapshotError(ValueError):
    """The owned server returned data outside the supported wire contract."""


def _string(value: Any, field: str, *, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise NativeSnapshotError(f"Invalid OpenCode {field}.")
    return value


def _optional_time(value: Any) -> int | float | None:
    if type(value) not in (int, float) or value < 0:
        return None
    return value


def _read(
    binding: ServerBinding, path: str, *, max_response: int = MAX_AUXILIARY_RESPONSE,
) -> Any:
    status, value = api.get(
        binding.port, path, binding.credential, binding.cwd,
        max_response=max_response,
    )
    if status == 401:
        raise BridgeError(
            "OPENCODE_API_AUTH_FAILED",
            "The OpenCode server no longer accepts this agent's credentials.",
        )
    if status == 404:
        raise BridgeError(
            "OPENCODE_API_SESSION_CHANGED",
            "The OpenCode session changed before its conversation could be read.",
        )
    if status != 200:
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE",
            "The OpenCode server could not provide this conversation.",
        )
    return value


def _part_id(session_id: str, message_id: str, part: dict[str, Any]) -> str:
    identifier = _string(part.get("id"), "part ID", maximum=512)
    if part.get("sessionID") != session_id or part.get("messageID") != message_id:
        raise NativeSnapshotError("OpenCode returned a part from another session or message.")
    return f"opencode:{session_id}:{message_id}:{identifier}"


def _text_item(
    session_id: str,
    message_id: str,
    role: str,
    part: dict[str, Any],
    timestamp: int | float | None,
) -> dict[str, Any] | None:
    if part.get("synthetic") is True or part.get("ignored") is True:
        return None
    text = part.get("text")
    if not isinstance(text, str) or not text:
        return None
    if len(text) > MAX_TEXT:
        raise NativeSnapshotError("OpenCode returned an oversized message.")
    item = {
        "id": _part_id(session_id, message_id, part),
        "kind": "user_message" if role == "user" else "assistant_message",
        "text" if role == "user" else "markdown": text,
    }
    if timestamp is not None:
        item["timestamp"] = timestamp
    return item


def _tool_item(
    session_id: str,
    message_id: str,
    part: dict[str, Any],
    timestamp: int | float | None,
) -> dict[str, Any]:
    name = _string(part.get("tool"), "tool name", maximum=512)
    state = part.get("state")
    if not isinstance(state, dict):
        raise NativeSnapshotError("OpenCode returned an invalid tool state.")
    native_status = state.get("status")
    status = {
        "pending": "pending",
        "running": "running",
        "completed": "completed",
        "error": "failed",
    }.get(native_status)
    if status is None:
        raise NativeSnapshotError("OpenCode returned an unsupported tool state.")
    item = {
        "id": _part_id(session_id, message_id, part),
        "kind": "tool_activity",
        "tool": name,
        "title": (
            state.get("title")
            if isinstance(state.get("title"), str) and state["title"]
            else tool_title(name)
        ),
        "detail": tool_detail(state.get("input")),
        "state": status,
    }
    if timestamp is not None:
        item["timestamp"] = timestamp
    return item


def project_messages(session_id: str, value: Any) -> list[dict[str, Any]]:
    if not valid_session_id(session_id) or not isinstance(value, list):
        raise NativeSnapshotError("OpenCode returned an invalid message snapshot.")
    if len(value) > MAX_MESSAGES:
        raise NativeSnapshotError("OpenCode returned too many messages.")
    items: list[dict[str, Any]] = []
    parts_seen = 0
    for message in value:
        if not isinstance(message, dict):
            raise NativeSnapshotError("OpenCode returned an invalid message.")
        info = message.get("info")
        parts = message.get("parts")
        if not isinstance(info, dict) or not isinstance(parts, list):
            raise NativeSnapshotError("OpenCode returned an invalid message body.")
        if info.get("sessionID") != session_id:
            raise NativeSnapshotError("OpenCode returned a message from another session.")
        message_id = _string(info.get("id"), "message ID", maximum=512)
        role = info.get("role")
        if role not in ("user", "assistant"):
            raise NativeSnapshotError("OpenCode returned an unsupported message role.")
        time = info.get("time")
        timestamp = _optional_time(time.get("created")) if isinstance(time, dict) else None
        parts_seen += len(parts)
        if parts_seen > MAX_PARTS:
            raise NativeSnapshotError("OpenCode returned too many message parts.")
        for part in parts:
            if not isinstance(part, dict):
                raise NativeSnapshotError("OpenCode returned an invalid message part.")
            kind = part.get("type")
            projected = None
            if kind == "text":
                projected = _text_item(
                    session_id, message_id, role, part, timestamp,
                )
            elif kind == "tool" and role == "assistant":
                projected = _tool_item(
                    session_id, message_id, part, timestamp,
                )
            elif kind not in {
                "reasoning", "file", "agent", "subtask", "retry", "snapshot",
                "patch", "step-start", "step-finish", "compaction",
            }:
                raise NativeSnapshotError("OpenCode returned an unsupported message part.")
            if projected is not None:
                items.append(projected)
    return items


def project_todos(session_id: str, value: Any) -> dict[str, Any] | None:
    if not isinstance(value, list):
        raise NativeSnapshotError("OpenCode returned an invalid TODO snapshot.")
    if len(value) > MAX_TODOS:
        raise NativeSnapshotError("OpenCode returned too many TODOs.")
    todos = []
    for index, todo in enumerate(value):
        if not isinstance(todo, dict):
            raise NativeSnapshotError("OpenCode returned an invalid TODO.")
        text = _string(todo.get("content"), "TODO text", maximum=10_000)
        state = {
            "pending": "pending",
            "in_progress": "in_progress",
            "completed": "done",
            "cancelled": "cancelled",
        }.get(todo.get("status"), "unknown")
        todos.append({
            "id": f"opencode:{session_id}:todo:{index}",
            "text": text,
            "state": state,
        })
    if not todos:
        return None
    return {
        "id": f"opencode:{session_id}:todos",
        "kind": "todo_update",
        "todos": todos,
    }


def _options(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise NativeSnapshotError("OpenCode returned invalid question options.")
    options = []
    for option in value:
        if not isinstance(option, dict):
            raise NativeSnapshotError("OpenCode returned an invalid question option.")
        label = _string(option.get("label"), "question option", maximum=1_000)
        item = {"id": label, "label": label}
        description = option.get("description")
        if isinstance(description, str) and description:
            if len(description) > 10_000:
                raise NativeSnapshotError("OpenCode returned an oversized option description.")
            item["description"] = description
        options.append(item)
    return options


def project_question(session_id: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("sessionID") != session_id:
        raise NativeSnapshotError("OpenCode returned an invalid question request.")
    identifier = _string(value.get("id"), "question ID", maximum=512)
    if not REQUEST_ID.fullmatch(identifier) or not identifier.startswith("que_"):
        raise NativeSnapshotError("OpenCode returned an invalid question ID.")
    native_questions = value.get("questions")
    if not isinstance(native_questions, list) or not native_questions:
        raise NativeSnapshotError("OpenCode returned an empty question request.")
    questions = []
    for question in native_questions:
        if not isinstance(question, dict):
            raise NativeSnapshotError("OpenCode returned an invalid question.")
        prompt = _string(question.get("question"), "question", maximum=20_000)
        header = question.get("header")
        options = _options(question.get("options"))
        projected = {
            "question": prompt,
            "options": options,
            "allowCustomAnswer": question.get("custom") is not False,
            "multiSelect": question.get("multiple") is True,
        }
        if isinstance(header, str) and header:
            projected["header"] = header[:1_000]
        questions.append(projected)
    first = questions[0]
    return {
        "id": identifier,
        "kind": "choice" if first["options"] else "text",
        "question": first["question"],
        "options": first["options"],
        "allowCustomAnswer": first["allowCustomAnswer"],
        "multiSelect": first["multiSelect"],
        "origin": "api",
        "providerSessionId": session_id,
        "questions": questions,
    }


def project_permission(session_id: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("sessionID") != session_id:
        raise NativeSnapshotError("OpenCode returned an invalid permission request.")
    identifier = _string(value.get("id"), "permission ID", maximum=512)
    if not REQUEST_ID.fullmatch(identifier) or not identifier.startswith("per_"):
        raise NativeSnapshotError("OpenCode returned an invalid permission ID.")
    permission = _string(value.get("permission"), "permission", maximum=1_000)
    patterns = value.get("patterns")
    always = value.get("always")
    if not isinstance(patterns, list) or not isinstance(always, list):
        raise NativeSnapshotError("OpenCode returned invalid permission patterns.")
    if len(patterns) > 1_000 or len(always) > 1_000:
        raise NativeSnapshotError("OpenCode returned too many permission patterns.")
    safe_patterns = [_string(item, "permission pattern", maximum=10_000) for item in patterns]
    safe_always = [_string(item, "permission rule", maximum=10_000) for item in always]
    return {
        "id": identifier,
        "kind": "permission",
        "question": f"Allow OpenCode to use {permission}?",
        "options": [],
        "allowCustomAnswer": False,
        "multiSelect": False,
        "origin": "api",
        "providerSessionId": session_id,
        "permission": {
            "permission": permission,
            "patterns": safe_patterns,
            "always": safe_always,
        },
    }


def project_requests(
    session_id: str, questions: Any, permissions: Any,
) -> list[dict[str, Any]]:
    if not isinstance(questions, list) or not isinstance(permissions, list):
        raise NativeSnapshotError("OpenCode returned an invalid request snapshot.")
    if len(questions) + len(permissions) > MAX_REQUESTS:
        raise NativeSnapshotError("OpenCode returned too many pending requests.")
    requests = [
        project_permission(session_id, request)
        for request in permissions
        if isinstance(request, dict) and request.get("sessionID") == session_id
    ]
    requests.extend(
        project_question(session_id, request)
        for request in questions
        if isinstance(request, dict) and request.get("sessionID") == session_id
    )
    return requests


def load_conversation(binding: ServerBinding, agent_id: str) -> dict[str, Any]:
    session_id = binding.session_id
    messages = _read(
        binding,
        f"/session/{session_id}/message?limit={MAX_MESSAGES}",
        max_response=MAX_CONVERSATION_RESPONSE,
    )
    todos = _read(binding, f"/session/{session_id}/todo")
    questions = _read(binding, "/question")
    permissions = _read(binding, "/permission")
    items = project_messages(session_id, messages)
    todo = project_todos(session_id, todos)
    if todo is not None:
        items.append(todo)
    requests = project_requests(session_id, questions, permissions)
    for request in requests:
        items.append({
            "id": "human:" + request["id"],
            "kind": "human_request",
            "request": request,
        })
    active = requests[0] if requests else None
    return {
        "agentId": agent_id,
        "provider": "opencode",
        "providerSessionId": session_id,
        "semantic": True,
        "items": items,
        "activeHumanRequest": active,
    }


def prompt_payload(
    text: str,
    command_id: str | None,
    *,
    model: Any = None,
    variant: Any = None,
) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_ANSWER_TEXT:
        raise BridgeError("INVALID_MESSAGE", "Message cannot be empty or oversized.")
    payload: dict[str, Any] = {
        "parts": [{"type": "text", "text": text}],
    }
    if command_id:
        payload["messageID"] = "msg_remodr_" + command_id.replace("-", "")
    if model is not None:
        if not isinstance(model, str) or "/" not in model:
            raise BridgeError("INVALID_MODEL", "OpenCode needs a provider/model selection.")
        provider_id, model_id = model.split("/", 1)
        if not provider_id or not model_id:
            raise BridgeError("INVALID_MODEL", "OpenCode needs a provider/model selection.")
        payload["model"] = {"providerID": provider_id, "modelID": model_id}
    if variant is not None:
        if not isinstance(variant, str) or not variant.strip() or len(variant) > 128:
            raise BridgeError("INVALID_VARIANT", "The OpenCode variant is invalid.")
        payload["variant"] = variant
    return payload


def question_reply(
    request: dict[str, Any], answer: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    try:
        identifier = _string(request.get("id"), "question ID", maximum=512)
    except NativeSnapshotError as error:
        raise BridgeError("INVALID_ANSWER", "The native question ID is invalid.") from error
    if not REQUEST_ID.fullmatch(identifier) or not identifier.startswith("que_"):
        raise BridgeError("INVALID_ANSWER", "The native question ID is invalid.")
    questions = request.get("questions")
    if not isinstance(questions, list) or not questions:
        raise BridgeError("INVALID_ANSWER", "The native question is incomplete.")
    supplied = answer.get("answers")
    if supplied is None and len(questions) == 1:
        supplied = [{
            "selectedOptionIds": answer.get("selectedOptionIds") or [],
            "customText": answer.get("customText"),
        }]
    if not isinstance(supplied, list) or len(supplied) != len(questions):
        raise BridgeError("INVALID_ANSWER", "Every native question needs an answer.")
    result: list[list[str]] = []
    for question, selected in zip(questions, supplied):
        if not isinstance(question, dict) or not isinstance(selected, dict):
            raise BridgeError("INVALID_ANSWER", "A native question answer is invalid.")
        options = {
            option["id"]: option["label"]
            for option in question.get("options", [])
            if isinstance(option, dict)
            and isinstance(option.get("id"), str)
            and isinstance(option.get("label"), str)
        }
        selected_ids = selected.get("selectedOptionIds") or []
        if not isinstance(selected_ids, list) or not all(
            isinstance(option_id, str) for option_id in selected_ids
        ):
            raise BridgeError("INVALID_ANSWER", "Selected answer IDs are invalid.")
        values = [options[option_id] for option_id in selected_ids if option_id in options]
        custom = selected.get("customText")
        if isinstance(custom, str) and custom.strip():
            if question.get("allowCustomAnswer") is False:
                raise BridgeError(
                    "INVALID_ANSWER", "This question does not accept a custom answer."
                )
            if len(custom) > MAX_ANSWER_TEXT:
                raise BridgeError("INVALID_ANSWER", "The custom answer is too long.")
            values.append(custom.strip())
        if not values:
            raise BridgeError("INVALID_ANSWER", "Every native question needs an answer.")
        if question.get("multiSelect") is not True and len(values) != 1:
            raise BridgeError("INVALID_ANSWER", "This question accepts one answer.")
        result.append(values)
    return identifier, {"answers": result}


def permission_reply(
    request: dict[str, Any], answer: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    try:
        identifier = _string(request.get("id"), "permission ID", maximum=512)
    except NativeSnapshotError as error:
        raise BridgeError("INVALID_ANSWER", "The native permission ID is invalid.") from error
    if not REQUEST_ID.fullmatch(identifier) or not identifier.startswith("per_"):
        raise BridgeError("INVALID_ANSWER", "The native permission ID is invalid.")
    reply = answer.get("permissionReply")
    if reply not in ("once", "always", "reject"):
        raise BridgeError("INVALID_ANSWER", "Choose how to handle this permission.")
    return identifier, {"reply": reply}


def require_success(status: int, value: Any, action: str) -> None:
    if status in (400, 401, 404):
        raise BridgeError(
            "OPENCODE_API_REJECTED", f"OpenCode rejected the {action} request."
        )
    if status != 200 or value is not True:
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE",
            f"OpenCode could not confirm the {action} request.",
        )
