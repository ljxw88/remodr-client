"""Claude session JSONL conversations selected by Herdr's native session ID."""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any
from ...formatting import content_text

def transcript_path(session_id: Any) -> Path | None:
    if not isinstance(session_id, str) or not session_id:
        return None
    candidates = list((Path.home() / ".claude" / "projects").glob("**/*.jsonl"))
    return next((item for item in candidates if session_id in item.name), None)


def load_conversation(agent: dict[str, Any]) -> dict[str, Any] | None:
    path = transcript_path(agent.get("providerSessionId"))
    return load_role_jsonl(agent, path, "claude") if path else None


def load_role_jsonl(
    agent: dict[str, Any], path: Path, provider: str
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
            text = content_text(message)
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
