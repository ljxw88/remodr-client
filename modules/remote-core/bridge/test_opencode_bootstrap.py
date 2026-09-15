"""No-server tests of initial native session creation and lifecycle handoff."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, call, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import bootstrap
from remodr_bridge.providers.opencode.registry import ServerRegistry


class OpenCodeBootstrapTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name).resolve()
        environment = patch.dict(os.environ, {
            "REMODR_OPENCODE_DB": str(self.directory / "synthetic.db"),
            "OPENCODE_SERVER_USERNAME": "existing-username",
            "OPENCODE_SERVER_PASSWORD": "existing-password",
            "HERDR_ENV": "1", "HERDR_PANE_ID": "unrelated-pane", "HERDR_SOCKET_PATH": "unrelated-socket",
            "HTTP_PROXY": "http://proxy.invalid", "HTTPS_PROXY": "http://proxy.invalid",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.process = Mock()
        self.process.poll.return_value = None
        self.process.stdout.fileno.return_value = 123
        self.response = MagicMock()
        self.response.__enter__.return_value = self.response
        self.response.read.return_value = self.encoded()
        self.opener = Mock()
        self.opener.open.return_value = self.response
        for name, kwargs in (
            ("subprocess.Popen", {"return_value": self.process}),
            ("ready_url", {"return_value": "http://127.0.0.1:45678"}),
            ("build_opener", {"return_value": self.opener}),
            ("secrets.token_urlsafe", {"return_value": "synthetic-random-password"}),
        ):
            patcher = patch("remodr_bridge.providers.opencode.bootstrap." + name, **kwargs)
            setattr(self, name.replace(".", "_"), patcher.start())
            self.addCleanup(patcher.stop)

    def encoded(self, **changes):
        return json.dumps({"id": "ses_created", "directory": str(self.directory), **changes}).encode()

    def create(self, title="Synthetic title"):
        return bootstrap.create_session(str(self.directory), title)

    def assert_cleaned(self):
        self.process.terminate.assert_called_once_with()
        self.process.wait.assert_called_once_with(timeout=5)
        self.process.kill.assert_not_called()
        self.process.stdout.close.assert_called_once_with()

    def test_creates_only_empty_session_with_authenticated_owned_loopback_server(self):
        self.assertEqual(self.create(), "ses_created")
        argv = self.subprocess_Popen.call_args.args[0]
        self.assertEqual(argv[1:], ["serve", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"])
        options = self.subprocess_Popen.call_args.kwargs
        self.assertEqual(options["cwd"], self.directory)
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["stdout"], subprocess.PIPE)
        self.assertEqual(options["stderr"], subprocess.STDOUT)
        self.assertNotIn("shell", options)
        env = options["env"]
        self.assertEqual(env["OPENCODE_SERVER_USERNAME"], "opencode")
        self.assertEqual(env["OPENCODE_SERVER_PASSWORD"], "synthetic-random-password")
        self.assertEqual(env["OPENCODE_DB"], str(self.directory / "synthetic.db"))
        for variable in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"):
            self.assertNotIn(variable, env)
        self.assertEqual(os.environ["OPENCODE_SERVER_PASSWORD"], "existing-password")
        self.secrets_token_urlsafe.assert_called_once_with(32)
        self.ready_url.assert_called_once_with(self.process)
        self.opener.open.assert_called_once()
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:45678/session")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"title": "Synthetic title"})
        self.assertEqual(request.get_header("X-opencode-directory"), str(self.directory))
        auth = request.get_header("Authorization")
        self.assertEqual(base64.b64decode(auth.removeprefix("Basic ")), b"opencode:synthetic-random-password")
        self.assertEqual(self.opener.open.call_args.kwargs, {"timeout": bootstrap.REQUEST_TIMEOUT})
        self.response.read.assert_called_once_with(bootstrap.MAX_RESPONSE + 1)
        self.assert_cleaned()
        self.assertFalse((self.directory / "synthetic.db").exists())

    def test_proxy_configuration_is_disabled_and_redirects_are_refused(self):
        self.create()
        handlers = self.build_opener.call_args.args
        self.assertEqual(len(handlers), 2)
        proxy = next(handler for handler in handlers if isinstance(handler, bootstrap.ProxyHandler))
        redirect = next(handler for handler in handlers if isinstance(handler, bootstrap.NoRedirect))
        self.assertEqual(proxy.proxies, {})
        request = Request("http://127.0.0.1:45678/session")
        for destination in ("http://remote.invalid/session", "http://127.0.0.1:9999/session"):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(destination=destination, status=status):
                    self.assertIsNone(redirect.redirect_request(request, None, status, "", {}, destination))

    def test_empty_title_uses_remodr_without_sending_a_prompt(self):
        self.create("")
        self.assertEqual(json.loads(self.opener.open.call_args.args[0].data), {"title": "Remodr"})

    def test_invalid_native_session_ids_never_escape_validation(self):
        for identifier in (None, "", "ses_", "ses_bad-id", "ses_../bad", "native", 4, {"id": "ses_other"}):
            with self.subTest(identifier=identifier):
                self.response.read.return_value = self.encoded(id=identifier)
                with self.assertRaises(BridgeError) as caught:
                    self.create()
                self.assertEqual(caught.exception.code, "INVALID_OPENCODE_RESPONSE")
        self.assertEqual(self.process.terminate.call_count, 8)
        self.assertEqual(self.process.stdout.close.call_count, 8)

    def test_mismatched_or_missing_directory_is_rejected(self):
        for directory in (None, 4, [], "relative/other", str(self.directory / "different")):
            with self.subTest(directory=directory):
                self.response.read.return_value = self.encoded(directory=directory)
                with self.assertRaises(BridgeError) as caught:
                    self.create()
                self.assertEqual(caught.exception.code, "INVALID_OPENCODE_RESPONSE")
        self.assertEqual(self.process.terminate.call_count, 5)

    def test_oversized_reply_is_rejected_before_json_decoding(self):
        self.response.read.return_value = b"x" * (bootstrap.MAX_RESPONSE + 1)
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "INVALID_OPENCODE_RESPONSE")
        self.assert_cleaned()

    def test_malformed_json_and_nonobject_replies_are_typed_errors(self):
        for data in (b"{", b"\xff", b"null", b"[]", b'"ses_created"'):
            with self.subTest(data=data):
                self.response.read.return_value = data
                with self.assertRaises(BridgeError) as caught:
                    self.create()
                self.assertIn(caught.exception.code, ("INVALID_OPENCODE_RESPONSE", "OPENCODE_START_FAILED"))
        self.assertEqual(self.process.terminate.call_count, 5)
        self.assertEqual(self.process.stdout.close.call_count, 5)

    def test_request_failures_and_timeouts_always_stop_owned_process(self):
        for error in (URLError("synthetic failure"), TimeoutError("synthetic timeout"),
                      HTTPError("http://127.0.0.1:45678/session", 302, "redirect", {}, None)):
            with self.subTest(error=error):
                self.opener.open.side_effect = error
                with self.assertRaises(BridgeError) as caught:
                    self.create()
                self.assertEqual(caught.exception.code, "OPENCODE_START_FAILED")
        self.assertEqual(self.process.terminate.call_count, 3)
        self.assertEqual(self.process.wait.call_count, 3)
        self.assertEqual(self.process.stdout.close.call_count, 3)

    def test_readiness_timeout_stops_process_without_api_request(self):
        self.ready_url.side_effect = BridgeError("OPENCODE_START_FAILED", "synthetic startup timeout")
        with self.assertRaises(BridgeError):
            self.create()
        self.opener.open.assert_not_called()
        self.assert_cleaned()

    def test_process_kill_is_bounded_when_terminate_times_out(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired("opencode", 5), 0]
        self.assertEqual(self.create(), "ses_created")
        self.process.terminate.assert_called_once_with()
        self.process.kill.assert_called_once_with()
        self.assertEqual(self.process.wait.call_args_list, [call(timeout=5), call(timeout=5)])
        self.process.stdout.close.assert_called_once_with()

    def test_already_exited_process_is_not_signaled(self):
        self.process.poll.return_value = 1
        self.ready_url.side_effect = BridgeError("OPENCODE_START_FAILED", "synthetic process exit")
        with self.assertRaises(BridgeError):
            self.create()
        self.process.terminate.assert_not_called()
        self.process.kill.assert_not_called()
        self.process.stdout.close.assert_called_once_with()

    def test_missing_executable_has_typed_error_and_never_sends_request(self):
        self.subprocess_Popen.side_effect = FileNotFoundError("synthetic missing opencode")
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "OPENCODE_START_FAILED")
        self.ready_url.assert_not_called()
        self.opener.open.assert_not_called()
        self.process.terminate.assert_not_called()

    def test_invalid_workspace_is_rejected_before_starting_process(self):
        for cwd in ("relative", str(self.directory / "missing")):
            with self.subTest(cwd=cwd), self.assertRaises(BridgeError) as caught:
                bootstrap.create_session(cwd, "")
            self.assertEqual(caught.exception.code, "INVALID_WORKSPACE")
        self.subprocess_Popen.assert_not_called()
        self.opener.open.assert_not_called()

    def test_bridge_construction_never_launches_cli_or_creates_session(self):
        bridge = Bridge()
        self.assertIn("opencode", bridge.providers)
        self.subprocess_Popen.assert_not_called()
        self.ready_url.assert_not_called()
        self.opener.open.assert_not_called()

    def test_standard_install_is_found_without_interactive_shell_path(self):
        installed = self.directory / ".opencode" / "bin" / "opencode"
        installed.parent.mkdir(parents=True)
        installed.touch()
        installed.chmod(0o700)
        with (
            patch.dict(os.environ, {"OPENCODE_BIN": ""}),
            patch.object(bootstrap.shutil, "which", return_value=None),
            patch.object(Path, "home", return_value=self.directory),
        ):
            self.assertEqual(bootstrap.executable(), str(installed))

    def test_explicit_binary_and_path_take_precedence_over_installer_location(self):
        with patch.dict(os.environ, {"OPENCODE_BIN": "/explicit/opencode"}):
            self.assertEqual(bootstrap.executable(), "/explicit/opencode")
        with (
            patch.dict(os.environ, {"OPENCODE_BIN": ""}),
            patch.object(bootstrap.shutil, "which", return_value="/path/opencode"),
        ):
            self.assertEqual(bootstrap.executable(), "/path/opencode")


class OpenCodeReadinessTest(unittest.TestCase):
    def setUp(self):
        self.process = Mock()
        self.process.poll.return_value = None
        self.process.stdout.fileno.return_value = 123

    def read(self, chunks):
        with (
            patch.object(bootstrap.time, "monotonic", return_value=0),
            patch.object(bootstrap.select, "select", side_effect=[
                *[([self.process.stdout], [], []) for _ in chunks], ([], [], []),
            ]),
            patch.object(bootstrap.os, "read", side_effect=chunks),
        ):
            return bootstrap.ready_url(self.process)

    def test_accepts_only_exact_owned_loopback_readiness_line(self):
        self.assertEqual(
            self.read([b"startup info\nopencode server listening on http://127.", b"0.0.1:54321\n"]),
            "http://127.0.0.1:54321",
        )

    def test_rejects_nonloopback_malformed_or_out_of_range_endpoints(self):
        for endpoint in (
            "http://remote.invalid:54321", "http://0.0.0.0:54321", "http://localhost:54321",
            "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:54321/session",
            "http://127.0.0.1@remote.invalid", "https://127.0.0.1:54321",
            "http://[::1]:54321", "http://127.0.0.1:-1",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(BridgeError):
                self.read([f"opencode server listening on {endpoint}\n".encode()])

    def test_log_noise_cannot_supply_a_server_endpoint(self):
        with self.assertRaises(BridgeError):
            self.read([b"debug: opencode server listening on http://127.0.0.1:54321\n"])

    def test_startup_output_is_bounded(self):
        with self.assertRaises(BridgeError):
            self.read([b"x" * 4096] * 17)

    def test_closed_output_and_early_exit_are_explicit_errors(self):
        with self.assertRaises(BridgeError):
            self.read([b""])
        self.process.poll.return_value = 1
        with self.assertRaises(BridgeError):
            self.read([])

    def test_timeout_is_bounded_without_readable_output(self):
        with self.assertRaises(BridgeError):
            self.read([])


class OpenCodeBootstrapLifecycleTest(unittest.TestCase):
    def make_bridge(self):
        bridge = Bridge()
        bridge.runtime = {"workspaces": [{"id": "w1", "cwd": "/work/synthetic"}], "agents": []}
        bridge._refresh_runtime = Mock()
        bridge._agent_catalog_snapshot = Mock(
            return_value=[{"provider": "opencode", "available": True}]
        )
        bridge._herdr_request = Mock(return_value={"root_pane": {"pane_id": "p1"}})
        bridge._start_agent = Mock()
        return bridge

    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        self.bridge = self.make_bridge()
        patcher = patch("remodr_bridge.providers.opencode.create_session", return_value="ses_created")
        self.create_session = patcher.start()
        self.addCleanup(patcher.stop)
        deleter = patch("remodr_bridge.providers.opencode.delete_session")
        self.delete_session = deleter.start()
        self.addCleanup(deleter.stop)
        empty = patch(
            "remodr_bridge.providers.opencode.transcript.message_count", return_value=0
        )
        self.message_count = empty.start()
        self.addCleanup(empty.stop)
        sleep = patch("remodr_bridge.lifecycle.time.sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def create(self):
        return self.bridge._create_agent({
            "provider": "opencode", "workspaceId": "w1", "name": "Initial session",
            "model": "openai/test-model", "bypassPermissions": True,
        })

    def registry(self):
        return self.bridge.providers["opencode"].servers()

    def test_bootstrap_id_is_resumed_but_not_published_as_native_identity(self):
        result = self.create()
        self.create_session.assert_called_once_with("/work/synthetic", "Initial session")
        self.bridge._start_agent.assert_called_once_with(
            "opencode", "opencode", "p1",
            [
                "--auto", "--model", "openai/test-model",
                "--hostname", "127.0.0.1", "--port", "0", "--session", "ses_created",
            ],
        )
        pending = self.bridge.runtime["agents"][0]
        self.assertEqual(pending["id"], result["agentId"])
        self.assertIsNone(pending["providerSessionId"])
        adapter = self.bridge.providers["opencode"]
        self.assertIsNone(adapter.session_hint("p1", None))
        self.assertIsNone(adapter.resolve_session({"pane_id": "p1"}, None, inspect=False))
        self.assertIsNone(self.bridge.sessions.launched_session("p1"))
        self.assertEqual(adapter.resolve_session({"pane_id": "p1"}, "ses_reported", inspect=False), "ses_reported")
        credential = self.registry().load("p1")
        self.assertEqual(self.bridge._herdr_request.call_args_list, [
            call("tab.create", {
                "focus": False, "workspace_id": "w1", "label": "Initial session",
                "env": {
                    "OPENCODE_SERVER_USERNAME": credential.username,
                    "OPENCODE_SERVER_PASSWORD": credential.password,
                },
            }),
        ])
        self.assertEqual((credential.cwd, credential.session_id), ("/work/synthetic", "ses_created"))
        # A launch secret never reaches a payload, a snapshot or a repr.
        self.assertNotIn(credential.password, json.dumps(result, default=str))
        self.assertNotIn(credential.password, repr(credential))

    def test_generated_credentials_are_unique_per_agent(self):
        first = self.create()
        self.bridge._herdr_request.return_value = {"root_pane": {"pane_id": "p2"}}
        self.create()
        credentials = [self.registry().load(pane) for pane in ("p1", "p2")]
        self.assertEqual(len({item.username for item in credentials}), 2)
        self.assertEqual(len({item.password for item in credentials}), 2)
        self.assertTrue(all(len(item.password) >= 32 for item in credentials))
        self.assertIsNotNone(first["paneId"])

    def test_closing_the_agent_removes_its_stored_credentials(self):
        self.create()
        self.bridge.raw_agents = {
            "a1": {"id": "a1", "provider": "opencode", "paneId": "p1", "agent_status": "idle"},
        }
        self.bridge._close_agent({"agentId": "a1"})
        self.assertIsNone(self.registry().load("p1"))

    def test_closing_the_space_removes_the_credentials_of_its_agents(self):
        self.create()
        self.bridge.runtime["agents"] = [
            {"id": "a1", "provider": "opencode", "paneId": "p1", "workspaceId": "w1"},
            {"id": "a2", "provider": "opencode", "paneId": "p9", "workspaceId": "w2"},
        ]
        self.bridge.providers["opencode"].servers().record(
            self.registry().load("p1").__class__(
                pane_id="p9", cwd="/work/other", username="other",
                password="other-password", session_id="ses_other",
            )
        )
        self.bridge._close_workspace({"workspaceId": "w1"})
        self.assertIsNone(self.registry().load("p1"))
        self.assertIsNotNone(self.registry().load("p9"))

    def test_a_dropped_bridge_keeps_a_running_agent_reachable(self):
        self.create()
        self.assertIsNotNone(self.registry().load("p1"))
        restarted = Bridge()
        # Nothing about construction, shutdown or reconnection may forget a
        # server this bridge is still responsible for reaching.
        self.assertIsNotNone(restarted.providers["opencode"].servers().load("p1"))

    def test_bootstrap_failure_closes_new_pane_without_starting_tui(self):
        self.create_session.side_effect = BridgeError("OPENCODE_START_FAILED", "synthetic bootstrap failure")
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "OPENCODE_START_FAILED")
        self.bridge._start_agent.assert_not_called()
        self.assertIn(call("pane.close", {"pane_id": "p1"}), self.bridge._herdr_request.call_args_list)
        self.assertIsNone(self.bridge.sessions.launched_session("p1"))
        self.assertIsNone(self.registry().load("p1"))
        # Nothing durable was created, so there is nothing to delete.
        self.delete_session.assert_not_called()

    def test_unknown_workspace_cwd_never_creates_a_pane_or_launches_the_cli(self):
        self.bridge.runtime["workspaces"][0].pop("cwd")
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "INVALID_WORKSPACE")
        self.create_session.assert_not_called()
        self.bridge._start_agent.assert_not_called()
        # The launch is prepared first now, so a refused one costs no pane.
        self.bridge._herdr_request.assert_not_called()

    def test_tui_failure_after_bootstrap_closes_pane_and_stores_nothing(self):
        self.bridge._start_agent.side_effect = BridgeError("START_FAILED", "synthetic TUI failure")
        with self.assertRaises(BridgeError):
            self.create()
        self.create_session.assert_called_once()
        self.assertIn(call("pane.close", {"pane_id": "p1"}), self.bridge._herdr_request.call_args_list)
        self.assertIsNone(self.registry().load("p1"))

    def test_a_refused_tab_leaves_no_session_and_closes_nothing(self):
        self.bridge._herdr_request.side_effect = BridgeError("tab_failed", "synthetic tab failure")
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "tab_failed")
        # The native session is only created once a pane exists to own it.
        self.create_session.assert_not_called()
        self.delete_session.assert_not_called()
        self.bridge._start_agent.assert_not_called()
        self.assertEqual(
            [call.args[0] for call in self.bridge._herdr_request.call_args_list], ["tab.create"],
        )

    def test_a_tab_without_a_usable_pane_closes_the_tab_it_named(self):
        self.bridge._herdr_request.return_value = {
            "tab": {"tab_id": "t1"}, "root_pane": {"pane_id": ""},
        }
        with self.assertRaises(BridgeError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "INVALID_HERDR_RESPONSE")
        self.create_session.assert_not_called()
        self.assertEqual(
            self.bridge._herdr_request.call_args_list[-1], call("tab.close", {"tab_id": "t1"}),
        )

    def test_a_tab_that_names_nothing_is_never_closed_on_a_guess(self):
        for result in ({}, {"root_pane": {}}, {"root_pane": "p1", "tab": {}}, {"tab_id": 7}):
            with self.subTest(result=result):
                self.bridge._herdr_request.reset_mock()
                self.bridge._herdr_request.return_value = result
                with self.assertRaises(BridgeError) as caught:
                    self.create()
                self.assertEqual(caught.exception.code, "INVALID_HERDR_RESPONSE")
                self.assertEqual(
                    [call.args[0] for call in self.bridge._herdr_request.call_args_list],
                    ["tab.create"],
                )
        self.create_session.assert_not_called()

    def test_an_unstarted_session_is_deleted_after_a_failed_launch(self):
        self.bridge._start_agent.side_effect = BridgeError("START_FAILED", "synthetic TUI failure")
        with self.assertRaises(BridgeError):
            self.create()
        self.assertIn(call("pane.close", {"pane_id": "p1"}), self.bridge._herdr_request.call_args_list)
        self.delete_session.assert_called_once_with("/work/synthetic", "ses_created")
        # Nothing ran, so the transcript is not even consulted.
        self.message_count.assert_not_called()

    def test_a_session_the_agent_may_have_written_to_is_kept(self):
        self.message_count.return_value = 3
        self.bridge._refresh_runtime.side_effect = [None, None, OSError("snapshot failed")]
        with self.assertRaises(OSError):
            self.create()
        self.delete_session.assert_not_called()
        self.assertIsNone(self.registry().load("p1"))

    def test_an_unknown_transcript_is_never_treated_as_an_empty_session(self):
        self.message_count.return_value = None
        self.bridge._refresh_runtime.side_effect = [None, None, OSError("snapshot failed")]
        with self.assertRaises(OSError):
            self.create()
        self.delete_session.assert_not_called()

    def test_a_started_agents_pane_is_closed_before_its_session_is_judged(self):
        order = []
        self.bridge._herdr_request.side_effect = lambda method, params: (
            order.append(method) or {"root_pane": {"pane_id": "p1"}}
        )
        self.message_count.side_effect = lambda identifier: order.append("transcript") or 0
        self.delete_session.side_effect = lambda cwd, identifier: order.append("delete")
        self.bridge._refresh_runtime.side_effect = [None, None, OSError("snapshot failed")]
        with self.assertRaises(OSError):
            self.create()
        self.assertEqual(order, ["tab.create", "pane.close", "transcript", "delete"])

    def test_a_failed_session_cleanup_is_reported_without_masking_the_failure(self):
        self.delete_session.side_effect = BridgeError("OPENCODE_START_FAILED", "synthetic")
        self.bridge._start_agent.side_effect = BridgeError("START_FAILED", "synthetic TUI failure")
        diagnostics = []
        with patch.object(Bridge, "_diagnostic", staticmethod(lambda *item: diagnostics.append(item))):
            with self.assertRaises(BridgeError) as caught:
                self.create()
        self.assertEqual(caught.exception.code, "START_FAILED")
        self.assertIn(("OPENCODE_SESSION_CLEANUP", "OPENCODE_START_FAILED"), diagnostics)

    def test_a_store_failure_after_start_leaves_the_agent_running(self):
        failures = [
            BridgeError("OPENCODE_SERVER_STORE_BUSY", "synthetic contention"),
            BridgeError("OPENCODE_SERVER_STORE_FULL", "synthetic capacity"),
            BridgeError("OPENCODE_SERVER_STORE_UNAVAILABLE", "synthetic /private/path"),
            OSError("synthetic"),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.bridge = self.make_bridge()
                diagnostics = []
                with (
                    patch.object(ServerRegistry, "record", side_effect=failure),
                    patch.object(
                        Bridge, "_diagnostic", staticmethod(lambda *item: diagnostics.append(item))
                    ),
                ):
                    result = self.create()
                self.assertEqual(result["paneId"], "p1")
                self.bridge._start_agent.assert_called_once()
                self.assertNotIn(
                    "pane.close", [call.args[0] for call in self.bridge._herdr_request.call_args_list]
                )
                self.delete_session.assert_not_called()
                expected = getattr(failure, "code", type(failure).__name__)
                self.assertIn(("AGENT_LAUNCH_BINDING", expected), diagnostics)
                # A sanitized code only: never a path or a message.
                self.assertTrue(all("synthetic" not in item[1] for item in diagnostics))
                # Without a record every later check fails closed.
                self.assertIsNone(self.registry().load("p1"))

    def test_a_failed_post_start_creation_removes_the_stored_binding(self):
        self.bridge._refresh_runtime.side_effect = [None, None, OSError("snapshot failed")]
        with self.assertRaises(OSError):
            self.create()
        self.assertIsNone(self.registry().load("p1"))
        self.assertIn(call("pane.close", {"pane_id": "p1"}), self.bridge._herdr_request.call_args_list)

    def test_agent_name_retry_reuses_existing_native_session_without_bootstrapping_twice(self):
        self.bridge._start_agent.side_effect = [BridgeError("agent_name_taken", "synthetic collision"), None]
        self.create()
        self.create_session.assert_called_once()
        self.assertEqual(self.bridge._start_agent.call_count, 2)
        for start in self.bridge._start_agent.call_args_list:
            self.assertEqual(start.args[-1][-6:], [
                "--hostname", "127.0.0.1", "--port", "0", "--session", "ses_created",
            ])
        self.assertEqual(self.registry().load("p1").session_id, "ses_created")


if __name__ == "__main__":
    unittest.main()
