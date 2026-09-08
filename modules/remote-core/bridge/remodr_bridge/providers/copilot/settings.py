"""Copilot CLI launch flags and session-level tuning events."""
from ...constants import REASONING_EFFORTS
from ..base import ProviderSpec

SPEC = ProviderSpec(
    name="copilot",
    label="GitHub Copilot",
    substring_match=True,
    bypass_arguments=("--allow-all-tools",),
    tuning_flags={"model": "--model", "effort": "--effort", "context": "--context"},
    efforts=REASONING_EFFORTS,
    retunable=True,
    structured_conversation=True,
    streaming=True,
    tool_activity=True,
    questions=True,
    todos=True,
)
SESSION_STATE_EVENTS = {"session.start": "selectedModel", "session.resume": "selectedModel"}
SESSION_CHANGE_EVENTS = {"session.model_change": "newModel"}
NO_MODEL = "auto"
