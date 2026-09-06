"""Indexed Codex rollouts, including paginated item-completed transcripts."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any
from .sessions import session_uuid
from ..base import ProviderHost
from ...errors import BridgeError
from ...formatting import content_text

def load_conversation(host: ProviderHost, agent: dict[str, Any]) -> dict[str, Any] | None:
    session_id = session_uuid(agent.get("providerSessionId"))
    if not session_id:
        return None
    path = transcript_path(host, session_id)
    if path is None:
        return None
    info = path.stat()
    version = (info.st_size, info.st_mtime_ns, info.st_ino, info.st_ctime_ns)
    key = (agent["id"], "codex", session_id)
    cached = host.conversation_cache.get(key)
    if cached and cached[0] == version:
        return cached[1]

    completed: list[dict[str, Any]] = []
    legacy: list[dict[str, Any]] = []
    positions: dict[str, int] = {}
    verified = False
    paginated = False
    with path.open(encoding="utf-8", errors="replace") as transcript:
        for line_number, line in enumerate(transcript):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            if event.get("type") == "session_meta":
                if session_uuid(payload.get("id")) != session_id:
                    raise BridgeError(
                        "CONVERSATION_SESSION_MISMATCH",
                        "The Codex transcript belongs to a different thread.",
                    )
                verified = True
                paginated = payload.get("history_mode") == "paginated"
                continue
            if event.get("type") != "event_msg":
                continue
            event_type = payload.get("type")
            if event_type == "item_completed":
                if payload.get("thread_id") not in (None, session_id):
                    continue
                item = payload.get("item")
                if not isinstance(item, dict):
                    continue
                kind = item.get("type")
                if kind not in ("UserMessage", "AgentMessage"):
                    continue
                if kind == "AgentMessage" and item.get("phase") not in (
                    None, "commentary", "final_answer",
                ):
                    continue
                text = content_text(item.get("content"))
                if not text:
                    continue
                item_id = item.get("id") or f"line:{line_number}"
                message = {
                    "id": f"codex:{kind}:{item_id}",
                    "kind": "user_message" if kind == "UserMessage" else "assistant_message",
                    "text" if kind == "UserMessage" else "markdown": text,
                }
                if message["id"] in positions:
                    completed[positions[message["id"]]] = message
                else:
                    positions[message["id"]] = len(completed)
                    completed.append(message)
            elif event_type in ("user_message", "agent_message"):
                text = payload.get("message")
                if isinstance(text, str) and text:
                    legacy.append({
                        "id": f"codex:{session_id}:line:{line_number}",
                        "kind": "user_message" if event_type == "user_message" else "assistant_message",
                        "text" if event_type == "user_message" else "markdown": text,
                    })
    if not verified:
        return None
    conversation = {
        "agentId": agent["id"],
        "provider": "codex",
        "providerSessionId": session_id,
        "semantic": True,
        "items": completed if paginated or completed else legacy,
        "activeHumanRequest": None,
    }
    host.conversation_cache[key] = (version, conversation)
    return conversation


def transcript_path(host: ProviderHost, session_id: str) -> Path | None:
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    indexes = []
    for path in home.glob("state_*.sqlite"):
        match = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
        if match:
            indexes.append((int(match.group(1)), path))
    for _, database in sorted(indexes, reverse=True):
        try:
            connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
            try:
                row = connection.execute(
                    "SELECT rollout_path FROM threads WHERE id = ?", (session_id,)
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error as error:
            host._diagnostic("CODEX_TRANSCRIPT_INDEX", str(error))
            continue
        if row:
            if not isinstance(row[0], str) or not row[0]:
                raise BridgeError("CONVERSATION_UNAVAILABLE", "Codex has an invalid transcript index entry.")
            path = Path(row[0])
            return path if path.suffix == ".jsonl" and path.is_file() else None
    candidates = list((home / "sessions").glob(f"**/*{session_id}*.jsonl"))
    if len(candidates) > 1:
        raise BridgeError("CONVERSATION_UNAVAILABLE", "Multiple Codex transcripts match this thread without an authoritative index.")
    return candidates[0] if candidates else None
