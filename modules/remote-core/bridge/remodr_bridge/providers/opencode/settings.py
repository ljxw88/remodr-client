"""OpenCode 1.18.29 launch flags; --auto still respects explicitly denied permissions."""
from ..base import ProviderSpec

SPEC = ProviderSpec(
    name="opencode",
    label="OpenCode",
    aliases=("herdr:opencode",),
    bypass_arguments=("--auto",),
    # Default session_interrupt; ctrl-c is app_exit. Herdr accepts "escape"/"esc".
    interrupt_keys=("escape",),
    tuning_flags={"model": "--model"},
    retunable=True,
    structured_conversation=True,
    tool_activity=True,
    todos=True,
)
