import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import herdr_mobile_bridge
from remodr_bridge.__main__ import main
from remodr_bridge.bridge import Bridge
from remodr_bridge.constants import BRIDGE_VERSION, PROTOCOL
from remodr_bridge.errors import BridgeError
from remodr_bridge.ledger import CommandLedger
from remodr_bridge.providers import SUPPORTED_PROVIDERS


class EntryPointTest(unittest.TestCase):
    def test_compatibility_imports_are_the_runtime_types(self):
        self.assertIs(herdr_mobile_bridge.Bridge, Bridge)
        self.assertIs(herdr_mobile_bridge.BridgeError, BridgeError)
        self.assertIs(herdr_mobile_bridge.CommandLedger, CommandLedger)

    def test_version_does_not_construct_bridge_or_touch_runtime_resources(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["bridge", "--version"]),
            patch("remodr_bridge.bridge.Bridge") as bridge,
            patch("socket.socket") as socket,
            patch.object(Path, "home") as home,
            patch("threading.Thread") as thread,
            contextlib.redirect_stdout(output),
        ):
            main()
        self.assertEqual(json.loads(output.getvalue()), {
            "bridgeVersion": BRIDGE_VERSION,
            "protocol": PROTOCOL,
            "providers": list(SUPPORTED_PROVIDERS),
        })
        bridge.assert_not_called()
        socket.assert_not_called()
        home.assert_not_called()
        thread.assert_not_called()

    def test_normal_entrypoint_runs_protocol_bridge(self):
        with (
            patch.object(sys, "argv", ["bridge"]),
            patch("remodr_bridge.bridge.Bridge") as bridge,
        ):
            main()
        bridge.assert_called_once_with()
        bridge.return_value.run.assert_called_once_with()

    def test_source_cli_version_does_not_create_home_state(self):
        source = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(dir=source) as directory:
            home = Path(directory)
            for invocation in (
                [str(source / "herdr_mobile_bridge.py"), "--version"],
                ["-m", "remodr_bridge", "--version"],
            ):
                with self.subTest(invocation=invocation):
                    result = subprocess.run(
                        [sys.executable, "-B", *invocation],
                        cwd=source,
                        env={**os.environ, "HOME": str(home), "HERDR_SOCKET": str(home / "absent")},
                        capture_output=True, text=True, check=True, timeout=5,
                    )
                    self.assertEqual(json.loads(result.stdout)["providers"], list(SUPPORTED_PROVIDERS))
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(list(home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
