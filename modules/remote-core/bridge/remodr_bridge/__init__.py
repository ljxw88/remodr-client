"""Remodr's dependency-free Herdr bridge runtime package."""
from .constants import BRIDGE_VERSION, PROTOCOL
from .errors import BridgeError

__all__ = ["BRIDGE_VERSION", "PROTOCOL", "BridgeError"]
