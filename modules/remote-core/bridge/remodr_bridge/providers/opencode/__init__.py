"""Herdr's installed OpenCode TUI integration is the only session authority."""
from __future__ import annotations

from typing import Any

from ...errors import BridgeError
from ..base import ProviderAdapter
from . import transcript
from .bootstrap import create_session
from .settings import SPEC
from .variants import OpenCodeVariants, retune


class OpenCodeAdapter(ProviderAdapter):
    spec = SPEC

    def variant_options(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenCodeVariants(self.host, payload).options()

    def retune(self, payload: dict[str, Any]) -> dict[str, Any]:
        return retune(self.host, payload)

    def prepare_launch(self, label: str, args: list[str], cwd: str | None) -> str:
        if not cwd:
            raise BridgeError("INVALID_WORKSPACE", "OpenCode needs a known workspace directory before launch.")
        identifier = create_session(cwd, label)
        args.extend(["--session", identifier])
        return identifier

    @staticmethod
    def format_tuning_value(key: str, value: str) -> str:
        if key == "model" and not transcript.model_id(value):
            raise BridgeError("INVALID_MODEL", "OpenCode models must use provider/model format.")
        return value

    def resolve_session(
        self, raw: dict[str, Any], native_session_id: str | None, *, inspect: bool
    ) -> str | None:
        pane_id = str(raw.get("pane_id") or "")
        self.host.sessions.clear_identity(pane_id)
        self.host.sessions.forget_launch_session(pane_id)
        if native_session_id is None:
            return None
        if not transcript.session_id(native_session_id):
            self.host.sessions.record_identity(
                pane_id, error="Herdr reported an invalid OpenCode session identifier.",
                diagnostic=None, process_bound=False,
            )
            return None
        return native_session_id

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        if agent.get("providerSessionId") is None:
            return None
        snapshot = transcript.read_session(agent.get("providerSessionId"))
        if snapshot is None:
            return None
        return {
            "agentId": agent["id"],
            "provider": self.spec.name,
            "providerSessionId": agent["providerSessionId"],
            "semantic": True,
            "items": snapshot["items"],
            "activeHumanRequest": None,
        }

    def has_semantic_session(self, session_id: Any) -> bool:
        if not transcript.session_id(session_id):
            return False
        try:
            return transcript.read_session(session_id) is not None
        except (transcript.TranscriptError, OSError):
            return False

    def provider_capabilities(self, installed: bool) -> dict[str, bool]:
        result = super().provider_capabilities(installed)
        result["structuredConversation"] = transcript.database_supported()
        result["todos"] = transcript.todos_supported()
        return result

    def agent_capabilities(self, session_id: Any) -> dict[str, bool]:
        result = super().agent_capabilities(session_id)
        result["todos"] = result["structuredConversation"] and transcript.todos_supported()
        return result

    def session_tuning(self, session_id: Any) -> dict[str, Any]:
        model = transcript.session_model(session_id)
        return {"model": model, "effort": None, "context": None} if model else {}
