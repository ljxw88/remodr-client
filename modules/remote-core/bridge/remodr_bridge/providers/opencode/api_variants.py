"""Project only model labels and variant IDs from the owned provider API."""
from __future__ import annotations

from typing import Any

from ...errors import BridgeError
from . import native, transcript
from .api import ServerBinding


def valid_name(value: Any, maximum: int = 128) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def options(binding: ServerBinding, model: Any, tuning: dict[str, Any]) -> dict[str, Any]:
    if not transcript.model_id(model):
        raise BridgeError("INVALID_MODEL", "Choose a specific OpenCode model to load its variants.")
    value = native._read(binding, "/provider", max_response=16 * 1024 * 1024)
    providers = value.get("all") if isinstance(value, dict) else None
    connected = value.get("connected") if isinstance(value, dict) else None
    if (not isinstance(providers, list) or len(providers) > 1000
            or not isinstance(connected, list) or len(connected) > 1000):
        raise BridgeError("INVALID_VARIANTS", "OpenCode returned invalid provider metadata.")
    provider_id, model_id = model.split("/", 1)
    matches = [item for item in providers if isinstance(item, dict) and item.get("id") == provider_id]
    if len(matches) != 1 or provider_id not in connected:
        raise BridgeError("INVALID_MODEL", "This OpenCode provider is no longer connected. Refresh models.")
    models = matches[0].get("models")
    selected = models.get(model_id) if isinstance(models, dict) else None
    if (not isinstance(selected, dict) or selected.get("id") != model_id
            or selected.get("providerID") != provider_id):
        raise BridgeError("INVALID_MODEL", "This OpenCode model is no longer available. Refresh models.")
    variants = selected.get("variants", {})
    if (not isinstance(variants, dict) or len(variants) > 128
            or any(not valid_name(name) or not isinstance(settings, dict)
                   for name, settings in variants.items())):
        raise BridgeError("INVALID_VARIANTS", "OpenCode returned invalid variant choices.")
    names = [name for name, settings in variants.items() if settings.get("disabled") is not True]
    current = tuning.get("variant") if tuning.get("model") == model else None
    # Removed overrides are presented as Default so they can be replaced.
    current = current if current in names else None
    label = selected.get("name")
    return {
        "modelLabel": label if valid_name(label, 512) else model,
        "modelToken": model,
        "currentVariant": current,
        "variants": names,
    }
