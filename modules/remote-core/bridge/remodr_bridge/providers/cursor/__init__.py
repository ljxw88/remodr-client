"""Cursor preserves native session hints and the shared raw-terminal fallback."""
from ..base import ProviderAdapter
from .settings import SPEC


class CursorAdapter(ProviderAdapter):
    spec = SPEC
