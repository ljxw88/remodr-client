"""Resolve authoritative Copilot identity without caching process bindings."""
from __future__ import annotations

import subprocess
from ..base import ProviderHost
from ...errors import BridgeError
from .processes import CopilotProcesses

def effective_session(
    host: ProviderHost, processes: CopilotProcesses, pane_id: str, native_session_id: str | None
) -> str | None:
    status = "unavailable"
    reason = ""
    session_id = None
    inspected = False
    try:
        binding = processes.foreground_process(pane_id)
        sessions = processes.open_session_ids(binding[0])
        inspected = True
        # Recheck the live pane binding after inspection. Session results are
        # never cached by PID, so clears and process/PID reuse are re-inspected.
        if processes.foreground_process(pane_id) != binding:
            raise ValueError("foreground process changed during descriptor inspection")
        if len(sessions) > 1:
            raise ValueError("foreground Copilot has multiple open session databases")
        if sessions:
            session_id = next(iter(sessions))
            status = "verified"
        else:
            # Idle/new CLIs need not have opened the optional session database.
            reason = "foreground Copilot does not expose an open session database"
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
            "Using the foreground Copilot session database; native session reference differs."
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
