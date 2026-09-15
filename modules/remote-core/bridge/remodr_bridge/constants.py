"""Provider-independent wire protocol, command storage and lifecycle limits."""

BRIDGE_VERSION = "0.2.0"
PROTOCOL = 1
SHELL_READY_TIMEOUT = 20
MAX_AGENT_NAME = 60
CONTEXT_TIERS = ("default", "long_context")
ORDERED_TUNING = ("model", "effort", "context")
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
SUBSCRIPTION_RETRY_INITIAL = 0.25
SUBSCRIPTION_RETRY_MAX = 2.0
DURABLE_ACTIONS = frozenset(("agent.send_message", "human_request.answer", "agent.interrupt"))
COMMAND_RESERVATION_SECONDS = 120
COMMAND_MAX_ENTRIES = 10000
COMMAND_MAX_RESPONSE_BYTES = 65536
SUBSCRIPTIONS = (
    "workspace.created", "workspace.updated", "workspace.metadata_updated",
    "workspace.renamed", "workspace.moved", "workspace.reordered", "workspace.closed",
    "workspace.focused", "worktree.created", "worktree.opened", "worktree.removed",
    "tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
    "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved",
    "pane.exited", "pane.agent_detected", "layout.updated",
)
