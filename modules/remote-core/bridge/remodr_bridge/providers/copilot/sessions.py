"""Resolve authoritative Copilot identity without caching process bindings."""
from __future__ import annotations

import subprocess
from ..base import ProviderHost
from ...errors import BridgeError
from .processes import CopilotProcesses


def _bound_session(host: ProviderHost, pane_id: str) -> str | None:
    previous = host.raw_agents.get(host._stable_agent_id(pane_id))
    session_id = previous.get("providerSessionId") if previous else None
    return session_id if isinstance(session_id, str) and session_id else None


def _unique_live_session(
    host: ProviderHost, pane_id: str, sessions: set[str], source: str,
) -> set[str]:
    """Drop a leftover post-clear marker; never pick newest folder or a stale native ID."""
    if source != "marker":
        raise ValueError(f"foreground Copilot has multiple active session {source}s")
    bound = _bound_session(host, pane_id)
    remainder = sessions - {bound} if bound in sessions else sessions
    if len(remainder) == 1:
        return remainder
    raise ValueError(f"foreground Copilot has multiple active session {source}s")


def effective_session(
    host: ProviderHost, processes: CopilotProcesses, pane_id: str, native_session_id: str | None
) -> str | None:
    status = "unavailable"
    reason = ""
    session_id = None
    source = "database"
    inspected = False
    try:
        binding = processes.foreground_process(pane_id)
        sessions = processes.open_session_ids(binding[0])
        if not sessions:
            sessions = processes.locked_session_ids(binding[0])
            source = "marker"
        inspected = True
        # Recheck the live pane binding after inspection. Session results are
        # never cached by PID, so clears and process/PID reuse are re-inspected.
        if processes.foreground_process(pane_id) != binding:
            raise ValueError("foreground process changed during descriptor inspection")
        if len(sessions) > 1:
            sessions = _unique_live_session(host, pane_id, sessions, source)
        if sessions:
            session_id = next(iter(sessions))
            status = "verified"
        else:
            # Idle/new CLIs need not have opened the optional session database.
            reason = "foreground Copilot does not expose an active session database or marker"
    except ValueError as error:
        status, reason = "unresolved", str(error)
    except (OSError, BridgeError, subprocess.SubprocessError) as error:
        if inspected:
            status = "unresolved"
        reason = str(error)

    process_bound = False
    observed = False
    identity_error = None
    if status == "verified":
        process_bound = True
        diagnostic = (
            f"Using the foreground Copilot session {source}; native session reference differs."
            if session_id != native_session_id else ""
        )
    elif status == "unresolved" or host.sessions.is_process_bound(pane_id):
        process_bound = True
        observed = True
        identity_error = reason
        diagnostic = f"Session identity unresolved: {reason}; not using a possibly stale native ID."
    else:
        session_id = native_session_id
        diagnostic = f"Process-bound session inspection unavailable: {reason}; using unverified native identity."
    changed = host.sessions.record_identity(
        pane_id, error=identity_error, diagnostic=diagnostic,
        process_bound=process_bound, observed=observed,
    )
    if changed and diagnostic:
        host._diagnostic("COPILOT_SESSION_IDENTITY", f"{pane_id}: {diagnostic}")
    return session_id
