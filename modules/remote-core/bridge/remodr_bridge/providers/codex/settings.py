"""Codex CLI tuning and live thread-ID status-line configuration."""
from ...constants import REASONING_EFFORTS
from ..base import ProviderSpec

CODEX_STATUS_CONFIG = 'tui.status_line=["session-id","model-with-reasoning","current-dir"]'
SPEC = ProviderSpec(
    name="codex",
    label="Codex",
    substring_match=True,
    bypass_arguments=("--dangerously-bypass-approvals-and-sandbox",),
    tuning_flags={"model": "--model", "effort": "-c"},
    efforts=REASONING_EFFORTS,
    structured_conversation=True,
    wait_for_session=True,
)
