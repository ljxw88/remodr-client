"""Claude session JSONL conversations selected by Herdr's native session ID."""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any
from ...formatting import content_text

def load_conversation(agent: dict[str, Any]) -> dict[str, Any] | None:
    session_id = agent.get("providerSessionId")
    if not isinstance(session_id, str):
        return None
    candidates = list((Path.home() / ".claude" / "projects").glob("**/*.jsonl"))
    path = next((item for item in candidates if session_id in item.name), None)
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
