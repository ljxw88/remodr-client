"""Incremental Copilot session settings and same-session retuning."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any
from ..base import ProviderHost
from .settings import SPEC, SESSION_STATE_EVENTS, SESSION_CHANGE_EVENTS, NO_MODEL
from ...constants import SHELL_READY_TIMEOUT
from ...errors import BridgeError

class CopilotTuning:
    def __init__(self, host: ProviderHost) -> None:
        self.host = host

    def retune_current_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Change the model, reasoning effort or context window of a live agent.

        A model can be swapped in place — Copilot takes `/model` mid-session —
        but effort and context are only read at startup. Those are changed by
        quitting the CLI and starting it again on the same session id, which
        resumes the conversation rather than beginning a new one.
        """
        host = self.host
        agent = host._require_agent(payload)
        if agent.get("paneId") in host.session_identity_errors:
            raise BridgeError("SESSION_IDENTITY_UNRESOLVED", "The active provider session cannot be verified.")
        provider = agent.get("provider")
        pane_id = agent.get("paneId")
        if not isinstance(pane_id, str) or not pane_id:
            raise BridgeError("AGENT_NOT_FOUND", "This agent has no pane.")

        # Validate before touching anything, so a bad value cannot leave the
        # agent stopped.
        host._tuning_arguments(provider, payload)
        wanted = host._tuning_of(payload)
        session_id = agent.get("providerSessionId")
        # Against everything known about the agent, not only what was set from
        # here. Comparing against the latter alone made a plain model swap look
        # like a reasoning change on any agent this bridge did not start, and
        # restarting one to change nothing interrupts whatever it is doing.
        current = host._reported_tuning(pane_id, session_id, provider)

        restart_needed = any(
            wanted.get(key) != current.get(key) for key in ("effort", "context")
        )
        if restart_needed:
            if not isinstance(session_id, str) or not session_id:
                raise BridgeError(
                    "SESSION_UNKNOWN",
                    "This agent's session cannot be reopened, so its reasoning "
                    "and context cannot be changed.",
                )
            self.restart_agent(agent, pane_id, session_id, wanted)
        elif wanted.get("model") != current.get("model"):
            # `auto` is what Copilot itself calls letting it choose.
            host._herdr_request(
                "agent.prompt",
                {
                    "target": pane_id,
                    "text": f"/model {wanted.get('model') or 'auto'}",
                },
            )

        with host.state_lock:
            host.agent_tuning[pane_id] = wanted
        host._refresh_runtime()
        return {"agentId": agent["id"], "runtime": host.runtime}

    def restart_agent(
        self,
        agent: dict[str, Any],
        pane_id: str,
        session_id: str,
        tuning: dict[str, Any],
    ) -> None:
        host = self.host
        provider = str(agent.get("provider"))
        with host.state_lock:
            # Whatever it was started with. Handing back all its tools because
            # it was restarted is not a change anyone asked for, and the
            # opposite would leave it stopping for permission it used to have.
            bypass = host.agent_bypass.get(pane_id, True)
            previous = dict(host.agent_tuning.get(pane_id) or {})

        host._herdr_request("agent.prompt", {"target": pane_id, "text": "/exit"})
        deadline = time.monotonic() + SHELL_READY_TIMEOUT
        while time.monotonic() < deadline:
            time.sleep(0.3)
            try:
                host._herdr_request("agent.get", {"target": pane_id})
            except BridgeError:
                break  # No agent in the pane any more, so the shell is back.

        name = str(agent.get("name") or provider)
        try:
            self.launch_tuned(name, provider, pane_id, session_id, bypass, tuning)
        except BridgeError:
            # The agent has already been stopped, so failing here would leave
            # the pane at a shell with the conversation stranded. Putting it
            # back as it was is the only thing left that helps.
            host._diagnostic("AGENT_RETUNE", f"pane {pane_id} rejected new settings")
            self.launch_tuned(
                name, provider, pane_id, session_id, bypass, previous
            )
            raise BridgeError(
                "RETUNE_REFUSED",
                "The agent would not start with those settings, so it has been "
                "put back as it was.",
            )
        with host.state_lock:
            host.started_sessions[pane_id] = session_id

    def launch_tuned(
        self,
        name: str,
        provider: str,
        pane_id: str,
        session_id: str,
        bypass: bool,
        tuning: dict[str, Any],
    ) -> None:
        host = self.host
        args = list(SPEC.bypass_arguments) if bypass else []
        args.extend(host._tuning_arguments(provider, tuning))
        args.extend(["--session-id", session_id])
        try:
            host._start_agent(name, provider, pane_id, args)
        except BridgeError as error:
            if error.code.lower() != "agent_name_taken":
                raise
            # Herdr releases a name when the CLI exits, but not always before
            # the next one asks for it.
            host._start_agent(
                f"{provider}-{uuid.uuid4().hex[:4]}", provider, pane_id, args
            )

    def session_tuning(self, provider_session_id: Any) -> dict[str, Any]:
        """The model, reasoning effort and context window a session is running.

        Only the session-level events carry all three, and they are the CLI's
        own record: it writes one when a session starts, when it resumes, and
        whenever any of the three is changed — including from the terminal
        rather than from here. Per-turn events name a model but never a
        context window, so the tail alone is not enough.

        A log is append-only, so each call reads only what has arrived since
        the last one. Scanning the whole file every time would mean re-reading
        megabytes a second while an agent is working.
        """
        host = self.host
        empty: dict[str, Any] = {"model": None, "effort": None, "context": None}
        if not isinstance(provider_session_id, str) or not provider_session_id:
            return dict(empty)
        path = (
            Path.home()
            / ".copilot"
            / "session-state"
            / provider_session_id
            / "events.jsonl"
        )
        try:
            size = path.stat().st_size
        except OSError:
            return dict(empty)

        offset, tuning = host.session_tuning_cache.get(
            provider_session_id, (0, dict(empty))
        )
        if size < offset:
            # Truncated or replaced, so nothing read before can be trusted.
            offset, tuning = 0, dict(empty)
        if size == offset:
            return dict(tuning)

        tuning = dict(tuning)
        try:
            with path.open("rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
        except OSError:
            return dict(tuning)

        # A read can land mid-line, so the last fragment is left for next time.
        consumed = chunk.rfind(b"\n") + 1
        for raw in chunk[:consumed].splitlines():
            if b'"session.' not in raw:
                continue
            try:
                event = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(event, dict) or event.get("agentId"):
                continue
            kind = event.get("type")
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            if kind in SESSION_STATE_EVENTS:
                model = data.get(SESSION_STATE_EVENTS[kind])
                tuning = {
                    "model": None if model == NO_MODEL else (model or None),
                    "effort": data.get("reasoningEffort") or None,
                    "context": data.get("contextTier") or None,
                }
            elif kind in SESSION_CHANGE_EVENTS:
                model = data.get(SESSION_CHANGE_EVENTS[kind])
                if model:
                    tuning["model"] = None if model == NO_MODEL else model
                if data.get("reasoningEffort"):
                    tuning["effort"] = data["reasoningEffort"]
                if data.get("contextTier"):
                    tuning["context"] = data["contextTier"]

        host.session_tuning_cache[provider_session_id] = (
            offset + consumed,
            dict(tuning),
        )
        return dict(tuning)
