"""Typed protocol errors shared by the runtime and providers."""

class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
