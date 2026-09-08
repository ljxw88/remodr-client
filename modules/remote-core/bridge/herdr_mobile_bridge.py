#!/usr/bin/env python3
"""Source-tree compatibility entry point; deploy the self-contained zipapp."""
import sys

if "--version" in sys.argv[1:]:
    sys.dont_write_bytecode = True

from remodr_bridge.bridge import Bridge
from remodr_bridge.constants import (
    BRIDGE_VERSION, PROTOCOL, SHELL_READY_TIMEOUT, MAX_AGENT_NAME, CONTEXT_TIERS,
    ORDERED_TUNING, REASONING_EFFORTS, SUBSCRIPTION_RETRY_INITIAL,
    SUBSCRIPTION_RETRY_MAX, DURABLE_ACTIONS, COMMAND_RESERVATION_SECONDS,
    COMMAND_MAX_ENTRIES, COMMAND_MAX_RESPONSE_BYTES, SUBSCRIPTIONS,
)
from remodr_bridge.errors import BridgeError
from remodr_bridge.ledger import CommandLedger
from remodr_bridge.providers import (
    SUPPORTED_PROVIDERS, BYPASS_ARGUMENTS, TUNING_ARGUMENTS, RETUNABLE_PROVIDERS,
    PROVIDER_EFFORTS,
)
from remodr_bridge.providers.copilot.processes import (
    PROCESS_INSPECTION_TIMEOUT, PROCESS_INSPECTION_MAX_BYTES, PROCESS_INSPECTION_MAX_FDS,
)
from remodr_bridge.providers.copilot.settings import (
    SESSION_STATE_EVENTS, SESSION_CHANGE_EVENTS, NO_MODEL,
)

if __name__ == "__main__":
    from remodr_bridge.__main__ import main

    main()
