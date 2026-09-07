"""Ordered provider registry; the single selection point for runtime adapters."""
from typing import Any

from .base import ProviderAdapter, ProviderHost
from .claude import ClaudeAdapter
from .codex import CodexAdapter
from .copilot import CopilotAdapter
from .opencode import OpenCodeAdapter

ADAPTER_TYPES = {
    adapter.spec.name: adapter
    for adapter in (OpenCodeAdapter, CopilotAdapter, ClaudeAdapter, CodexAdapter)
}
SUPPORTED_PROVIDERS = tuple(ADAPTER_TYPES)
BYPASS_ARGUMENTS = {
    name: list(adapter.spec.bypass_arguments) for name, adapter in ADAPTER_TYPES.items()
}
TUNING_ARGUMENTS = {
    name: dict(adapter.spec.tuning_flags) for name, adapter in ADAPTER_TYPES.items()
}
PROVIDER_EFFORTS = {
    name: adapter.spec.efforts for name, adapter in ADAPTER_TYPES.items() if adapter.spec.efforts
}
RETUNABLE_PROVIDERS = tuple(
    name for name, adapter in ADAPTER_TYPES.items() if adapter.spec.retunable
)


def provider_type(provider: str) -> type[ProviderAdapter]:
    return ADAPTER_TYPES.get(provider, ProviderAdapter)


def normalize_provider(value: Any) -> str:
    normalized = str(value or "").lower().replace("-", "").replace("_", "")
    return next(
        (name for name, adapter in ADAPTER_TYPES.items() if adapter.spec.matches(normalized)),
        "unknown",
    )


def provider_label(provider: str) -> str:
    return provider_type(provider).spec.label


def create_registry(host: ProviderHost) -> dict[str, ProviderAdapter]:
    return {
        **{name: adapter(host) for name, adapter in ADAPTER_TYPES.items()},
        "unknown": ProviderAdapter(host),
    }
