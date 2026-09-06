"""Claude CLI settings; identity remains Herdr's native session reference."""
from ..base import ProviderSpec

SPEC = ProviderSpec(
    name="claude",
    label="Claude Code",
    substring_match=True,
    bypass_arguments=("--dangerously-skip-permissions",),
    tuning_flags={"model": "--model", "effort": "--effort"},
    efforts=("low", "medium", "high", "xhigh", "max"),
    structured_conversation=True,
)
