"""Synthetic CLI discovery only: no OpenCode, refresh, credentials, or agents."""
from copy import deepcopy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import models


class ModelParserTest(unittest.TestCase):
    def test_exact_nested_selectors_and_empty_list(self):
        self.assertEqual(models.parse_models(b""), [])
        self.assertEqual(
            models.parse_models(b"opencode/free-model\r\ncustom/org/nested/model:v2\n"),
            ["opencode/free-model", "custom/org/nested/model:v2"],
        )
        self.assertEqual(models.parse_models("custom/模型\n".encode()), ["custom/模型"])

    def test_unexpected_logs_duplicates_controls_and_truncation_fail_whole_list(self):
        for output in (
            b"p/m\np/m\n", b"p/m\nunexpected log\n", b"Models cache refreshed\np/m\n",
            b"p/m", b"p/m\np/truncated", b"\n", b"p/m\n\n", b" p/m\n", b"p/m \n",
            b"p/\n", b"/m\n", b"p/m\rname\n", b"p/m\tname\n", b"p/m\x00\n",
            b"p/m\x7f\n", b"\x1b[31mp/m\x1b[0m\n", b"p/\xff\n",
            "p/m\u202ename\n".encode(), "p/m\u0085name\n".encode(),
            b"p/m\n{\"options\":{\"headers\":\"secret\"}}\n",
        ):
            with self.subTest(output=output), self.assertRaises(BridgeError) as caught:
                models.parse_models(output)
            self.assertEqual(caught.exception.code, "INVALID_OPENCODE_MODELS")
            self.assertNotIn("secret", str(caught.exception))

    def test_selector_count_length_and_byte_limits(self):
        selector = "p/" + "m" * (models.MAX_SELECTOR - 2)
        self.assertEqual(models.parse_models((selector + "\n").encode()), [selector])
        with self.assertRaises(BridgeError):
            models.parse_models((selector + "x\n").encode())
        output = "".join("p/model-{}\n".format(index) for index in range(models.MAX_MODELS))
        self.assertEqual(len(models.parse_models(output.encode())), models.MAX_MODELS)
        with self.assertRaises(BridgeError):
            models.parse_models((output + "p/extra\n").encode())
        with patch.object(models, "MAX_OUTPUT", 3), self.assertRaises(BridgeError):
            models.parse_models(b"p/m\n")


class ModelDispatchTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge()
        self.directory = Path(__file__).parent.resolve()
        self.snapshot = {
            "workspaces": [{"workspace_id": "chosen"}, {"workspace_id": "focused"}],
            "panes": [
                {"workspace_id": "focused", "cwd": str(self.directory.parent), "focused": True},
                {"workspace_id": "chosen", "cwd": str(self.directory), "pane_id": "p1"},
            ],
            "agents": [],
        }
        self.bridge.runtime["workspaces"] = [{"id": "stale", "cwd": "/not/a/workspace"}]
        self.bridge._herdr_request = Mock(side_effect=lambda *_: {"snapshot": deepcopy(self.snapshot)})
        self.discover = patch.object(models, "_discover", return_value=["custom/org/model"]).start()
        self.addCleanup(patch.stopall)

    def request(self, **changes):
        return self.bridge._dispatch("opencode.models", {"workspaceId": "chosen", "refresh": False, **changes})

    def test_dispatch_uses_actual_selected_workspace_without_inputs_or_runtime_mutation(self):
        runtime = deepcopy(self.bridge.runtime)
        self.assertEqual(self.request(), {
            "workspaceId": "chosen", "cwd": str(self.directory), "models": ["custom/org/model"],
        })
        self.assertEqual(self.discover.call_args.args[:2], (self.directory, False))
        self.assertEqual(self.bridge._herdr_request.call_count, 2)
        for call in self.bridge._herdr_request.call_args_list:
            self.assertEqual(call.args, ("session.snapshot", {}))
        self.assertEqual(self.bridge.runtime, runtime)
        self.assertEqual(self.bridge.raw_agents, {})
        self.assertEqual(self.bridge.pending_agents, {})

    def test_refresh_and_empty_results(self):
        self.discover.return_value = []
        self.assertEqual(self.request(refresh=True)["models"], [])
        self.assertIs(self.discover.call_args.args[1], True)

    def test_unknown_workspace_and_invalid_payload_never_execute_cli(self):
        for payload in (
            {"workspaceId": "unknown"}, {"workspaceId": ""}, {"workspaceId": None},
            {"workspaceId": 7}, {"refresh": "false"}, {"refresh": 1},
            {"cwd": str(self.directory)}, {"agentId": "focused-agent"},
        ):
            with self.subTest(payload=payload), self.assertRaises(BridgeError):
                self.request(**payload)
        self.discover.assert_not_called()

    def test_missing_invalid_or_relative_directory_fails_closed(self):
        for cwd in (None, "", "relative/path", str(self.directory / "not-a-real-directory")):
            self.snapshot["panes"][1]["cwd"] = cwd
            with self.subTest(cwd=cwd), self.assertRaises(BridgeError):
                self.request()
        self.discover.assert_not_called()

    def test_foreground_directory_matches_runtime_and_agents_can_supply_cwd(self):
        self.snapshot["panes"][1]["foreground_cwd"] = str(self.directory.parent)
        self.assertEqual(self.request()["cwd"], str(self.directory.parent))
        self.snapshot["panes"].pop()
        self.snapshot["agents"] = [{"workspace_id": "chosen", "cwd": str(self.directory)}]
        self.assertEqual(self.request()["cwd"], str(self.directory))

    def test_changed_removed_or_replaced_directory_is_rejected_after_command(self):
        for change in ("cwd", "removed", "missing-cwd"):
            original = deepcopy(self.snapshot)
            def discover(*_):
                if change == "cwd":
                    self.snapshot["panes"][1]["cwd"] = str(self.directory.parent)
                elif change == "removed":
                    self.snapshot["workspaces"].pop(0)
                else:
                    self.snapshot["panes"].pop(1)
                return ["p/m"]
            self.discover.side_effect = discover
            with self.subTest(change=change), self.assertRaises(BridgeError):
                self.request()
            self.snapshot = original

    def test_directory_identity_is_rechecked_before_return(self):
        scope = ("cwd", self.directory, 1, 10)
        with patch.object(models, "_workspace", side_effect=[scope, (*scope[:3], 11)]):
            with self.assertRaises(BridgeError) as caught:
                self.request()
        self.assertEqual(caught.exception.code, "WORKSPACE_CHANGED")

    def test_shared_budget_reserves_final_runtime_check(self):
        with patch.object(models.time, "monotonic", return_value=100):
            self.request()
        self.assertEqual(self.discover.call_args.args[2], 100 + models.DISCOVERY_TIMEOUT - models.SCOPE_TIMEOUT)

    def test_overall_deadline_rejects_result_after_slow_scope_check(self):
        values = iter([100])
        with patch.object(models.time, "monotonic", side_effect=lambda: next(values, 200)):
            with self.assertRaises(BridgeError) as caught:
                self.request()
        self.assertEqual(caught.exception.code, "OPENCODE_MODELS_TIMEOUT")

    def test_invalid_snapshot_and_duplicate_workspace_fail_before_cli(self):
        for snapshot in (
            None, {}, {"workspaces": [], "panes": None}, {"workspaces": {}},
            {**self.snapshot, "workspaces": [{"workspace_id": "chosen"}] * 2},
        ):
            self.bridge._herdr_request.side_effect = None
            self.bridge._herdr_request.return_value = {"snapshot": snapshot}
            with self.subTest(snapshot=snapshot), self.assertRaises(BridgeError):
                self.request()
        self.discover.assert_not_called()

    def test_unexpected_cleanup_error_is_sanitized_at_endpoint_boundary(self):
        self.discover.side_effect = OSError("secret pipe path")
        with self.assertRaises(BridgeError) as caught:
            self.request()
        self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(caught.exception.code, "OPENCODE_MODELS_FAILED")

    def test_remote_errors_never_reach_protocol_or_diagnostic_output(self):
        for error in (RuntimeError("secret-token"), BridgeError("HERDR_SECRET", "secret-token")):
            for fail_after_command in (False, True):
                self.bridge._herdr_request.side_effect = (
                    [{"snapshot": deepcopy(self.snapshot)}, error] if fail_after_command else error
                )
                self.bridge.write = Mock()
                self.bridge._diagnostic = Mock()
                self.bridge._handle_request_line(json.dumps({
                    "protocol": 1, "id": "request", "type": "request",
                    "action": "opencode.models", "payload": {"workspaceId": "chosen", "refresh": False},
                }))
                response = self.bridge.write.call_args.args[0]
                self.assertFalse(response["ok"])
                self.assertNotIn("secret", json.dumps(response))
                self.bridge._diagnostic.assert_not_called()


class SyntheticModelProcessTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(__file__).parent.resolve()
        self.processes = []
        self.real_popen = subprocess.Popen
        self.script = "print('custom/org/model')"
        self.arguments = []
        self.options = []
        patcher = patch.object(models.subprocess, "Popen", side_effect=self.spawn)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup)
        patcher = patch.object(models.bootstrap, "executable", return_value="/synthetic/opencode")
        self.executable = patcher.start()
        self.addCleanup(patcher.stop)

    def spawn(self, arguments, **options):
        self.arguments.append(arguments)
        self.options.append(options)
        process = self.real_popen([sys.executable, "-c", self.script, *arguments[1:]], **options)
        self.processes.append(process)
        return process

    def cleanup(self):
        for process in self.processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)
            if process.stdout:
                process.stdout.close()

    def discover(self, refresh=False, timeout=5):
        return models._discover(self.directory, refresh, time.monotonic() + timeout)

    def assert_reaped(self):
        for process in self.processes:
            self.assertIsNotNone(process.returncode)
            self.assertTrue(process.stdout.closed)
            with self.assertRaises(ChildProcessError):
                os.waitpid(process.pid, os.WNOHANG)

    def test_native_flags_cwd_db_binding_environment_and_separate_stderr(self):
        environment = {
            "HERDR_ENV": "1", "HERDR_PANE_ID": "unrelated", "HERDR_SOCKET_PATH": "unrelated",
            "REMODR_OPENCODE_DB": str(self.directory / "synthetic.db"),
            "OPENCODE_CONFIG": "/private/custom.json", "OPENCODE_CONFIG_CONTENT": '{"private":"secret"}',
            "XDG_CONFIG_HOME": "/private/config", "PROVIDER_API_KEY": "secret",
        }
        self.script = (
            "import os,sys; "
            "assert os.getcwd() == " + repr(str(self.directory)) + "; "
            "assert 'HERDR_PANE_ID' not in os.environ; "
            "sys.stderr.write('Models cache refreshed\\nsecret credential metadata\\n'); "
            "print('custom/org/model')"
        )
        with patch.dict(os.environ, environment):
            for refresh in (False, True):
                self.assertEqual(self.discover(refresh), ["custom/org/model"])
            self.assertEqual(os.environ["HERDR_PANE_ID"], "unrelated")
        self.assertEqual(self.arguments, [
            ["/synthetic/opencode", "models"], ["/synthetic/opencode", "models", "--refresh"],
        ])
        for options in self.options:
            self.assertEqual(options["cwd"], self.directory)
            self.assertEqual(options["stdin"], subprocess.DEVNULL)
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            self.assertEqual(options["stdout"], subprocess.PIPE)
            self.assertTrue(options["start_new_session"])
            self.assertNotIn("shell", options)
            self.assertEqual(options["env"]["OPENCODE_DB"], environment["REMODR_OPENCODE_DB"])
            for name in ("OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "XDG_CONFIG_HOME", "PROVIDER_API_KEY"):
                self.assertEqual(options["env"][name], environment[name])
            for name in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"):
                self.assertNotIn(name, options["env"])
        self.assert_reaped()

    def test_empty_nonzero_and_malformed_stdout(self):
        self.script = "pass"
        self.assertEqual(self.discover(), [])
        for script, code in (
            ("import sys; print('p/m'); sys.stderr.write('secret'); sys.exit(7)", "OPENCODE_MODELS_FAILED"),
            ("print('p/m'); print('secret metadata')", "INVALID_OPENCODE_MODELS"),
            ("import sys; sys.stdout.write('p/truncated')", "INVALID_OPENCODE_MODELS"),
        ):
            self.script = script
            with self.subTest(script=script), self.assertRaises(BridgeError) as caught:
                self.discover()
            self.assertEqual(caught.exception.code, code)
            self.assertNotIn("secret", str(caught.exception))
        self.assert_reaped()

    def test_timeout_with_open_pipe_or_stdout_closed_reaps_owned_process(self):
        for script in ("import time; time.sleep(10)", "import os,time; os.close(1); time.sleep(10)"):
            self.script = script
            started = time.monotonic()
            with self.subTest(script=script), self.assertRaises(BridgeError) as caught:
                self.discover(timeout=0.15)
            self.assertEqual(caught.exception.code, "OPENCODE_MODELS_TIMEOUT")
            self.assertLess(time.monotonic() - started, 2)
        self.assert_reaped()

    def test_continuous_oversized_stdout_is_bounded_and_killed(self):
        self.script = "import os\nwhile True: os.write(1, b'p/model\\n' * 10000)"
        with patch.object(models, "MAX_OUTPUT", 1024), self.assertRaises(BridgeError) as caught:
            self.discover()
        self.assertEqual(caught.exception.code, "INVALID_OPENCODE_MODELS")
        self.assert_reaped()

    def test_stderr_is_discarded_without_deadlock_or_memory_capture(self):
        self.script = "import os; os.write(2, b'secret' * 1000000); print('p/m')"
        self.assertEqual(self.discover(), ["p/m"])
        self.assert_reaped()

    def test_plugin_descendant_is_killed_even_when_cli_exits_successfully(self):
        self.script = (
            "import subprocess,sys; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
            "print('p/' + str(p.pid))"
        )
        sentinel = self.real_popen(
            [sys.executable, "-c", "import time; time.sleep(20)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            child_pid = int(self.discover()[0].split("/")[1])
            for _ in range(20):
                state_process = self.real_popen(
                    ["ps", "-o", "stat=", "-p", str(child_pid)],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                )
                state, _ = state_process.communicate(timeout=2)
                if not state.strip() or state.strip().startswith(b"Z"):
                    break
                time.sleep(0.05)
            else:
                self.fail("Owned plugin descendant survived discovery cleanup")
            self.assertIsNone(sentinel.poll(), "Unrelated process must remain untouched")
        finally:
            sentinel.kill()
            sentinel.wait(timeout=2)
        self.assert_reaped()

    def test_missing_executable_and_unexpected_exception_are_sanitized(self):
        for error in (FileNotFoundError("secret-path"), ValueError("secret-config")):
            with patch.object(models.subprocess, "Popen", side_effect=error):
                with self.assertRaises(BridgeError) as caught:
                    self.discover()
            self.assertEqual(caught.exception.code, "OPENCODE_MODELS_FAILED")
            self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(self.processes, [])

    def test_reader_exception_is_sanitized_and_always_cleans_up(self):
        self.script = "import time; time.sleep(10)"
        with patch.object(models, "_read_models", side_effect=RuntimeError("secret-key")):
            with self.assertRaises(BridgeError) as caught:
                self.discover()
        self.assertNotIn("secret", str(caught.exception))
        self.assert_reaped()

    def test_expired_budget_never_spawns(self):
        with self.assertRaises(BridgeError) as caught:
            self.discover(timeout=-1)
        self.assertEqual(caught.exception.code, "OPENCODE_MODELS_TIMEOUT")
        self.assertEqual(self.processes, [])


if __name__ == "__main__":
    unittest.main()
