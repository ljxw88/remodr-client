"""Source-tree and zipapp entry point."""
import json
import sys

from .constants import BRIDGE_VERSION, PROTOCOL
from .providers import SUPPORTED_PROVIDERS


def main() -> None:
    if "--version" in sys.argv[1:]:
        print(json.dumps({
            "bridgeVersion": BRIDGE_VERSION,
            "protocol": PROTOCOL,
            "providers": list(SUPPORTED_PROVIDERS),
        }, separators=(",", ":")))
        return

    from .bridge import Bridge

    Bridge().run()


if __name__ == "__main__":
    main()
