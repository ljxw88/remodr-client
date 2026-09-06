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

    if status == "verified":
        host.process_bound_panes.add(pane_id)
        host.session_identity_errors.pop(pane_id, None)
        diagnostic = (
            "Using the foreground Copilot session database; native session reference differs."
            if session_id != native_session_id else ""
        )
    elif status == "unresolved" or pane_id in host.process_bound_panes:
        host.process_bound_panes.add(pane_id)
        host.observed_session_panes.add(pane_id)
        host.session_identity_errors[pane_id] = reason
        diagnostic = f"Session identity unresolved: {reason}; not using a possibly stale native ID."
    else:
        host.session_identity_errors.pop(pane_id, None)
        session_id = native_session_id
        diagnostic = f"Process-bound session inspection unavailable: {reason}; using unverified native identity."
    if host.session_identity_diagnostics.get(pane_id) != diagnostic:
        if diagnostic:
            host._diagnostic("COPILOT_SESSION_IDENTITY", f"{pane_id}: {diagnostic}")
        host.session_identity_diagnostics[pane_id] = diagnostic
    return session_id
