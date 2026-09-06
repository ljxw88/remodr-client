"""Cursor Agent launch settings; generic 'agent' is deliberately not an alias."""
from ..base import ProviderSpec

SPEC = ProviderSpec(
    name="cursor",
    label="Cursor Agent",
    aliases=("cursor", "cursoragent"),
    bypass_arguments=("--force",),
    tuning_flags={"model": "--model"},
)
