"""Codex live status-line thread authority and display-only identity hints."""
from __future__ import annotations

import uuid
from typing import Any
from ..base import ProviderHost
from ...errors import BridgeError

def session_uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return str(parsed) if parsed.int and str(parsed) == value.lower() else None


def status_session(text: Any) -> str | None:
    if not isinstance(text, str):
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    # Only the live footer is evidence. UUIDs in messages or /status history
    # must never select the target of a queued command.
    sessions = {
        session
        for part in lines[-1].split("\u00b7")
        if (session := session_uuid(part.strip())) is not None
    }
    return next(iter(sessions)) if len(sessions) == 1 else None


def effective_session(
    host: ProviderHost, raw: dict[str, Any], native_session_id: str | None
) -> str | None:
    pane_id = str(raw.get("pane_id") or "")
    reason = (
        "Codex has not exposed its active thread. Finish any startup dialogs "
        "and enable Thread ID in Codex /statusline. New Remodr Codex agents "
        "enable this automatically."
    )
    try:
        result = host._herdr_request(
            "agent.read",
            {"target": pane_id, "source": "visible", "format": "text",
             "strip_ansi": True, "lines": 6},
        )
        read = result.get("read")
        session_id = status_session(
            read.get("text") if isinstance(read, dict) else None
        )
    except (OSError, BridgeError) as error:
        session_id = None
        reason = f"Codex thread identity could not be read: {error}"
    if session_id:
        host.session_identity_errors.pop(pane_id, None)
        host.session_identity_diagnostics.pop(pane_id, None)
        return session_id

    host.session_identity_errors[pane_id] = reason
    if host.session_identity_diagnostics.get(pane_id) != reason:
        host._diagnostic("CODEX_SESSION_IDENTITY", f"{pane_id}: {reason}")
        host.session_identity_diagnostics[pane_id] = reason
    previous = host.raw_agents.get(host._stable_agent_id(pane_id))
    # Preserve the last displayed transcript while a dialog hides the footer.
    # This hint is not dispatch authority: command preparation refuses it.
    if (
        previous and previous.get("provider") == "codex"
        and previous.get("terminal_id") == raw.get("terminal_id")
    ):
        return previous.get("providerSessionId")
    return native_session_id
