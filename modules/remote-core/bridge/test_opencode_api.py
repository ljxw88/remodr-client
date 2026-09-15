"""Ownership discovery and the strict loopback client for a managed OpenCode server.

No real process is inspected and no real socket is opened. Process listings,
``/proc`` trees, ``lsof`` output and HTTP responses are all synthetic, so the
rules can be tested without depending on -- or touching -- whatever happens to
be running on the machine.
"""
import json
import os
import unittest
from pathlib import Path
import tempfile
from unittest.mock import MagicMock, Mock, patch
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import api
from remodr_bridge.providers.opencode.registry import ServerCredential, ServerRegistry


SESSION = "ses_synthetic"
ARGV = [
    "opencode", "--auto", "--hostname", "127.0.0.1", "--port", "0", "--session", SESSION,
]


def process_info(pane_id="p1", argv=ARGV, pid=4321, shell_pid=4000, **changes):
    return {
        "process_info": {
            "pane_id": pane_id,
            "shell_pid": shell_pid,
            "foreground_process_group_id": pid,
            "foreground_processes": [{"pid": pid, "argv": list(argv), "name": argv[0]}],
            **changes,
        }
    }


class ManagedArgumentsTest(unittest.TestCase):
    def test_a_managed_launch_is_recognised_in_either_argument_style(self):
        self.assertEqual(api.managed_port(ARGV), 0)
        self.assertEqual(
            api.managed_port(["opencode", "--hostname=127.0.0.1", "--port=4096"]), 4096
        )
        self.assertTrue(api.managed_arguments(ARGV))

    def test_anything_not_bound_to_loopback_is_not_a_managed_launch(self):
        for argv in (
            ["opencode"],
            ["opencode", "--port", "0"],
            ["opencode", "--hostname", "127.0.0.1"],
            ["opencode", "--hostname", "0.0.0.0", "--port", "0"],
            ["opencode", "--hostname", "localhost", "--port", "0"],
            ["opencode", "--hostname", "::1", "--port", "0"],
            ["opencode", "--hostname", "127.0.0.1", "--port", "-1"],
            ["opencode", "--hostname", "127.0.0.1", "--port", "65536"],
            ["opencode", "--hostname", "127.0.0.1", "--port", "http"],
            ["opencode", "--hostname", "127.0.0.1", "--port", None],
            ["opencode"] * (api.MAX_ARGUMENTS + 1),
            [],
        ):
            with self.subTest(argv=argv):
                self.assertFalse(api.managed_arguments(argv))

    def test_only_a_supported_version_string_counts(self):
        self.assertTrue(api.supported_version("1.18.30"))
        self.assertTrue(api.supported_version("2.0.0-beta.1"))
        for value in ("1.18.29", "1.17.99", "0.1.0", "", "latest", "1.18", None, 11830, "x" * 65):
            with self.subTest(value=value):
                self.assertFalse(api.supported_version(value))


class ForegroundProcessTest(unittest.TestCase):
    def setUp(self):
        self.host = Mock()
        self.host._herdr_request = Mock(return_value=process_info())

    def test_the_panes_own_managed_opencode_is_accepted(self):
        self.assertEqual(api.foreground_process(self.host, "p1"), (4321, 0))
        self.host._herdr_request.assert_called_once_with(
            "pane.process_info", {"pane_id": "p1"}
        )

    def test_an_explicit_port_is_carried_out_of_the_argument_list(self):
        argv = ["opencode", "--hostname", "127.0.0.1", "--port", "4096"]
        self.host._herdr_request.return_value = process_info(argv=argv)
        self.assertEqual(api.foreground_process(self.host, "p1"), (4321, 4096))

    def test_a_pane_that_cannot_prove_it_owns_opencode_is_refused(self):
        cases = {
            "another pane": process_info(pane_id="p2"),
            "no metadata": {},
            "no group": process_info(pid=0),
            "shell only": process_info(pid=4000, shell_pid=4000),
            "unmanaged": process_info(argv=["opencode", "--session", SESSION]),
            "another program": process_info(argv=[
                "curl", "--hostname", "127.0.0.1", "--port", "0",
            ]),
            "too many": {"process_info": {
                **process_info()["process_info"],
                "foreground_processes": [{"pid": 4321, "argv": ARGV}] * 300,
            }},
            "ambiguous": {"process_info": {
                **process_info()["process_info"],
                "foreground_processes": [{"pid": 4321, "argv": ARGV}] * 2,
            }},
        }
        for name, response in cases.items():
            with self.subTest(case=name):
                self.host._herdr_request.return_value = response
                with self.assertRaises(api.OwnershipError):
                    api.foreground_process(self.host, "p1")


class ListenerDiscoveryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.proc = Path(directory.name)
        proc = patch.object(api, "PROC", self.proc)
        proc.start()
        self.addCleanup(proc.stop)

    def write_process(self, pid, inodes):
        descriptors = self.proc / str(pid) / "fd"
        descriptors.mkdir(parents=True)
        for index, inode in enumerate(inodes):
            os.symlink(f"socket:[{inode}]", descriptors / str(index + 3))
        os.symlink("/dev/null", descriptors / "99")

    def write_table(self, rows, name="tcp"):
        (self.proc / "net").mkdir(exist_ok=True)
        header = "  sl  local_address rem_address   st ... inode\n"
        lines = "".join(
            "  {index}: {local} 00000000:0000 {state} 00000000:00000000 "
            "00:00000000 00000000 {uid} 0 {inode} 1 0000 10\n".format(
                index=index, local=local, state=state,
                uid=row.get("uid", os.getuid()), inode=inode,
            )
            for index, (local, state, inode, row) in enumerate(rows)
        )
        (self.proc / "net" / name).write_text(header + lines)

    def test_only_the_pids_own_loopback_listener_is_discovered(self):
        self.write_process(4321, [111])
        self.write_table([
            ("0100007F:1000", "0A", 111, {}),
            ("0100007F:2000", "0A", 222, {}),
            ("0100007F:3000", "01", 111, {}),
        ])
        self.assertEqual(api.linux_listening_ports(4321), {0x1000})

    def test_a_listener_on_any_other_address_is_ignored(self):
        self.write_process(4321, [111, 112, 113])
        self.write_table([
            ("00000000:1000", "0A", 111, {}),
            ("0202000A:2000", "0A", 112, {}),
        ])
        self.write_table(
            [("00000000000000000000000001000000:3000", "0A", 113, {})], name="tcp6"
        )
        self.assertEqual(api.linux_listening_ports(4321), set())

    def test_an_ipv4_mapped_loopback_listener_still_counts(self):
        self.write_process(4321, [113])
        self.write_table(
            [("0000000000000000FFFF00000100007F:1000", "0A", 113, {})], name="tcp6"
        )
        self.assertEqual(api.linux_listening_ports(4321), {0x1000})

    def test_a_listener_owned_by_another_user_is_refused_outright(self):
        self.write_process(4321, [111])
        self.write_table([("0100007F:1000", "0A", 111, {"uid": os.getuid() + 1})])
        with self.assertRaises(api.OwnershipError):
            api.linux_listening_ports(4321)

    def test_a_process_holding_no_socket_listens_nowhere(self):
        self.write_process(4321, [])
        self.write_table([("0100007F:1000", "0A", 111, {})])
        self.assertEqual(api.linux_listening_ports(4321), set())

    def test_lsof_output_must_belong_to_the_inspected_process_and_user(self):
        output = "p4321\0u{uid}\0\nf5\0n127.0.0.1:4096\0\nf6\0n*:9000\0\n".format(
            uid=os.getuid()
        ).encode()
        with patch.object(api, "bounded_output", return_value=output) as command:
            self.assertEqual(api.lsof_listening_ports(4321), {4096})
        arguments = command.call_args.args[0]
        self.assertEqual(arguments[1:], [
            "-nP", "-a", "-p", "4321", "-iTCP", "-sTCP:LISTEN", "-F0pun",
        ])
        for output in (
            b"p9999\0u%d\0\nf5\0n127.0.0.1:4096\0\n" % os.getuid(),
            b"p4321\0u%d\0\nf5\0n127.0.0.1:4096\0\n" % (os.getuid() + 1),
            b"f5\0n127.0.0.1:4096\0\n",
        ):
            with self.subTest(output=output):
                with patch.object(api, "bounded_output", return_value=output):
                    with self.assertRaises(api.OwnershipError):
                        api.lsof_listening_ports(4321)


class OwnedListenerTest(unittest.TestCase):
    def setUp(self):
        self.host = Mock()
        self.host._herdr_request = Mock(return_value=process_info())

    def owned(self, ports, argv=ARGV):
        self.host._herdr_request.return_value = process_info(argv=argv)
        with patch.object(api, "listening_ports", return_value=set(ports)):
            return api.owned_listener(self.host, "p1")

    def test_exactly_one_loopback_listener_is_a_binding(self):
        self.assertEqual(self.owned({4096}), (4321, 4096))

    def test_no_listener_or_several_is_never_resolved_by_choosing_one(self):
        for ports in (set(), {4096, 4097}):
            with self.subTest(ports=ports):
                with self.assertRaises(api.OwnershipError):
                    self.owned(ports)

    def test_an_explicit_port_must_be_the_one_the_process_holds(self):
        argv = ["opencode", "--hostname", "127.0.0.1", "--port", "4096"]
        self.assertEqual(self.owned({4096, 22}, argv=argv), (4321, 4096))
        with self.assertRaises(api.OwnershipError):
            self.owned({5000}, argv=argv)


class LoopbackClientTest(unittest.TestCase):
    def setUp(self):
        self.credential = ServerCredential(
            pane_id="p1", cwd="/work/project", username="user",
            password="secret-password", session_id=SESSION,
        )
        self.response = MagicMock()
        self.response.__enter__.return_value = self.response
        self.response.status = 200
        self.response.read.return_value = b'{"healthy": true, "version": "1.18.30"}'
        self.opener = Mock()
        self.opener.open.return_value = self.response
        opener = patch.object(api, "build_opener", return_value=self.opener)
        self.build_opener = opener.start()
        self.addCleanup(opener.stop)

    def test_requests_are_authenticated_loopback_only_and_carry_the_directory(self):
        status, body = api.get(4096, "/global/health", self.credential, "/work/project")
        self.assertEqual((status, body), (200, {"healthy": True, "version": "1.18.30"}))
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:4096/global/health")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.host, "127.0.0.1:4096")
        self.assertEqual(
            request.get_header("Authorization"), "Basic dXNlcjpzZWNyZXQtcGFzc3dvcmQ=",
        )
        self.assertEqual(request.get_header("X-opencode-directory"), "/work/project")
        self.assertEqual(self.opener.open.call_args.kwargs["timeout"], api.REQUEST_TIMEOUT)
        # A credential must never be reachable from the URL itself.
        self.assertNotIn("secret-password", request.full_url)

    def test_post_serializes_a_bounded_authenticated_json_request(self):
        self.response.status = 204
        self.response.read.return_value = b""
        binding = api.ServerBinding(
            pane_id="p1", pid=42, port=4096, cwd="/work/project",
            session_id=SESSION, version="1.18.30", credential=self.credential,
        )
        status, body = api.post(
            binding,
            "/question/que_native/reply",
            {"answers": [["PostgreSQL"]]},
        )
        self.assertEqual((status, body), (204, None))
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(
            json.loads(request.data), {"answers": [["PostgreSQL"]]},
        )
        self.assertEqual(
            request.get_header("Authorization"),
            "Basic dXNlcjpzZWNyZXQtcGFzc3dvcmQ=",
        )

    def test_an_unauthenticated_probe_carries_no_credential_and_no_body(self):
        self.response.read.return_value = b'{"healthy": true}'
        status, body = api.get(4096, "/global/health", None, "/work/project", parse=False)
        self.assertEqual((status, body), (200, None))
        request = self.opener.open.call_args.args[0]
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(request.get_header("X-opencode-directory"), "/work/project")

    def test_no_proxy_and_no_redirect_can_carry_the_credential_away(self):
        api.get(4096, "/global/health", self.credential, "/work/project")
        handlers = self.build_opener.call_args.args
        proxy = next(handler for handler in handlers if isinstance(handler, ProxyHandler))
        self.assertEqual(proxy.proxies, {})
        redirect = next(handler for handler in handlers if isinstance(handler, api.NoRedirect))
        self.assertIsNone(
            redirect.redirect_request(None, None, 302, "Found", {}, "http://elsewhere.invalid")
        )

    def test_an_oversized_or_unreadable_body_is_refused(self):
        for body in (b"x" * (api.MAX_RESPONSE + 1), b"not json"):
            with self.subTest(body=body[:16]):
                self.response.read.return_value = body
                with self.assertRaises(BridgeError) as caught:
                    api.get(4096, "/global/health", self.credential, "/work/project")
                self.assertEqual(caught.exception.code, "OPENCODE_API_UNAVAILABLE")
        self.response.read.assert_called_with(api.MAX_RESPONSE + 1)

    def test_a_refusal_is_reported_as_its_status_without_reading_a_body(self):
        self.opener.open.side_effect = HTTPError(
            "http://127.0.0.1:4096/global/health", 401, "Unauthorized", {}, None
        )
        self.assertEqual(
            api.get(4096, "/global/health", self.credential, "/work/project"), (401, None)
        )

    def test_an_unreachable_server_is_a_typed_error_not_another_port(self):
        self.opener.open.side_effect = URLError("connection refused")
        with self.assertRaises(BridgeError) as caught:
            api.get(4096, "/global/health", self.credential, "/work/project")
        self.assertEqual(caught.exception.code, "OPENCODE_API_UNAVAILABLE")

    def test_a_path_can_never_smuggle_a_header_or_a_host(self):
        for path in ("global/health", "/session/ses x", "/session/a\r\nHost: evil"):
            with self.subTest(path=path):
                with self.assertRaises(BridgeError):
                    api.get(4096, path, self.credential, "/work/project")


class VerificationTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.cwd = Path(directory.name).resolve()
        self.credential = ServerCredential(
            pane_id="p1", cwd=str(self.cwd), username="user",
            password="secret-password", session_id=SESSION,
        )
        self.health = {"healthy": True, "version": "1.18.30"}
        self.session = {"id": SESSION, "directory": str(self.cwd)}
        self.responses = []
        self.unauthenticated_status = 401
        self.health_status = 200
        self.session_status = 200

    def get(self, port, path, credential, directory, *, parse=True):
        self.responses.append((port, path, credential, directory, parse))
        if credential is None:
            # The probe never asks for a body and is never given one.
            return self.unauthenticated_status, None
        if path == "/global/health":
            return self.health_status, self.health
        return self.session_status, self.session

    @property
    def offered(self):
        return [path for _, path, credential, _, _ in self.responses if credential is not None]

    def verify(self, session=SESSION):
        with patch.object(api, "get", side_effect=self.get):
            return api.verify(4096, self.credential, session)

    def test_a_healthy_server_holding_the_exact_session_verifies(self):
        self.assertEqual(self.verify(), ("1.18.30", str(self.cwd)))
        self.assertEqual(
            [(path, credential is None) for _, path, credential, _, _ in self.responses],
            [
                ("/global/health", True),
                ("/global/health", False),
                ("/session/" + SESSION, False),
            ],
        )
        self.assertTrue(
            all(directory == str(self.cwd) for _, _, _, directory, _ in self.responses)
        )
        # The probe asks for a status, never for a body to parse.
        self.assertFalse(self.responses[0][4])

    def test_a_listener_that_does_not_demand_a_credential_is_never_given_one(self):
        for status in (200, 204, 301, 302, 400, 403, 404, 500):
            with self.subTest(status=status):
                self.responses = []
                self.unauthenticated_status = status
                self.assertIsNone(self.verify())
                self.assertEqual(self.offered, [])

    def test_an_unreachable_probe_is_not_proof_of_a_protected_server(self):
        with patch.object(
            api, "get",
            side_effect=BridgeError("OPENCODE_API_UNAVAILABLE", "synthetic failure"),
        ):
            self.assertFalse(api.demands_credential(4096, str(self.cwd)))

    def test_only_a_refusal_lets_the_credential_be_offered(self):
        with patch.object(api, "get", return_value=(401, None)) as probe:
            self.assertTrue(api.demands_credential(4096, str(self.cwd)))
        self.assertIsNone(probe.call_args.args[2])
        self.assertFalse(probe.call_args.kwargs["parse"])

    def test_an_unhealthy_or_unsupported_server_is_not_a_binding(self):
        for health in (
            {"healthy": False, "version": "1.18.30"},
            {"healthy": "yes", "version": "1.18.30"},
            {"healthy": True, "version": "1.0.0"},
            {"healthy": True},
            {},
        ):
            with self.subTest(health=health):
                self.health = health
                self.assertIsNone(self.verify())
        self.assertEqual(set(self.offered), {"/global/health"})

    def test_a_refused_credential_never_becomes_a_binding(self):
        self.health_status = 401
        self.assertIsNone(self.verify())

    def test_another_session_or_another_directory_is_not_this_agent(self):
        for session in (
            {"id": "ses_other", "directory": str(self.cwd)},
            {"id": SESSION, "directory": str(self.cwd / "elsewhere")},
            {"id": SESSION},
            {"id": SESSION, "directory": ""},
        ):
            with self.subTest(session=session):
                self.session = session
                self.assertIsNone(self.verify())

    def test_a_missing_session_is_not_a_binding(self):
        self.session_status = 404
        self.assertIsNone(self.verify())

    def test_a_directory_reported_by_another_name_still_has_to_be_the_same_place(self):
        link = self.cwd.parent / (self.cwd.name + "-link")
        link.symlink_to(self.cwd)
        self.addCleanup(link.unlink)
        self.session = {"id": SESSION, "directory": str(link)}
        self.assertEqual(self.verify(), ("1.18.30", str(link)))


class BindingResolutionTest(unittest.TestCase):
    def setUp(self):
        self.host = Mock()
        self.host._herdr_request = Mock(return_value=process_info())
        self.credential = ServerCredential(
            pane_id="p1", cwd="/work/project", username="user",
            password="secret-password", session_id=SESSION,
        )

    def resolve(self, credential=None, **patches):
        defaults = {"owned_listener": (4321, 4096), "verify": ("1.18.30", "/work/project")}
        defaults.update(patches)
        with (
            patch.object(api, "owned_listener", **self.behaviour(defaults["owned_listener"])),
            patch.object(api, "verify", **self.behaviour(defaults["verify"])) as verify,
        ):
            self.verify = verify
            return api.resolve(
                self.host, "p1", SESSION,
                self.credential if credential is None else credential,
            )

    @staticmethod
    def behaviour(value):
        return {"side_effect": value} if isinstance(value, Exception) else {"return_value": value}

    def test_a_verified_pane_produces_a_binding_that_hides_its_secret(self):
        binding = self.resolve()
        self.assertEqual(
            (binding.pane_id, binding.pid, binding.port, binding.session_id, binding.version),
            ("p1", 4321, 4096, SESSION, "1.18.30"),
        )
        self.assertEqual(binding.base_url, "http://127.0.0.1:4096")
        self.assertEqual(binding.credential, self.credential)
        self.assertNotIn("secret-password", repr(binding))
        self.assertNotIn("secret-password", str(binding))

    def test_without_a_stored_record_nothing_is_asked_of_the_pane(self):
        with patch.object(api, "owned_listener") as owned, patch.object(api, "verify") as verify:
            self.assertIsNone(api.resolve(self.host, "p1", SESSION, None))
        owned.assert_not_called()
        verify.assert_not_called()
        self.host._herdr_request.assert_not_called()

    def test_a_record_for_another_pane_or_an_invalid_session_is_refused(self):
        self.assertIsNone(api.resolve(self.host, "p2", SESSION, self.credential))
        for session in (None, "", "not-a-session", 7):
            with self.subTest(session=session):
                self.assertIsNone(api.resolve(self.host, "p1", session, self.credential))
        self.host._herdr_request.assert_not_called()

    def test_the_credential_is_never_offered_before_ownership_is_proven(self):
        binding = self.resolve(owned_listener=api.OwnershipError("no listener"))
        self.assertIsNone(binding)
        self.verify.assert_not_called()

    def test_an_unreachable_or_refused_server_yields_no_binding_at_all(self):
        for outcome in (
            None,
            BridgeError("OPENCODE_API_UNAVAILABLE", "synthetic failure"),
        ):
            with self.subTest(outcome=outcome):
                self.assertIsNone(self.resolve(verify=outcome))

    def test_an_unsupported_platform_is_a_missing_binding_not_a_crash(self):
        with patch.object(api, "listening_ports", side_effect=api.OwnershipError("unsupported")):
            self.assertIsNone(api.resolve(self.host, "p1", SESSION, self.credential))


class ApiCapabilityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        home = patch.object(Path, "home", return_value=Path(directory.name))
        home.start()
        self.addCleanup(home.stop)
        self.bridge = Bridge()
        self.adapter = self.bridge.providers["opencode"]
        self.binding = api.ServerBinding(
            pane_id="p1", pid=4321, port=4096, cwd="/work/project",
            session_id=SESSION, version="1.18.30",
            credential=ServerCredential(
                pane_id="p1", cwd="/work/project", username="user",
                password="secret-password", session_id=SESSION,
            ),
        )

    def capabilities(self, binding):
        with patch.object(api, "resolve", return_value=binding) as resolve:
            self.adapter.prune_bindings(set())
            self.adapter.binding("p1", SESSION, force=True)
            result = self.adapter.agent_capabilities(SESSION, "p1")
        return result, resolve

    def test_api_capabilities_are_absent_until_a_binding_is_verified(self):
        capabilities, _ = self.capabilities(None)
        for name in (
            "apiConversation", "apiPrompt", "apiAbort",
            "nativeQuestions", "nativePermissions", "apiModelSelection", "apiVariantSelection",
        ):
            self.assertNotIn(name, capabilities)
        self.assertEqual(
            set(capabilities),
            {
                "supportsRetuning", "structuredConversation", "streamingConversation",
                "structuredQuestions", "toolActivity", "todos", "fallback",
            },
        )

    def test_a_verified_binding_turns_every_api_capability_on(self):
        capabilities, _ = self.capabilities(self.binding)
        self.assertEqual(
            {
                name: capabilities[name]
                for name in (
                    "apiConversation", "apiPrompt", "apiAbort",
                    "nativeQuestions", "nativePermissions", "apiModelSelection", "apiVariantSelection",
                )
            },
            {
                "apiConversation": True, "apiPrompt": True, "apiAbort": True,
                "nativeQuestions": True, "nativePermissions": True,
                "apiModelSelection": True,
                "apiVariantSelection": True,
            },
        )

    def test_an_agent_without_a_pane_is_never_verified(self):
        with patch.object(api, "resolve") as resolve:
            capabilities = self.adapter.agent_capabilities(SESSION, None)
        resolve.assert_not_called()
        self.assertNotIn("apiConversation", capabilities)

    def test_provider_capabilities_describe_potential_and_promise_nothing(self):
        capabilities = self.bridge._capabilities(check_store=False)["providerCapabilities"]
        for provider, values in capabilities.items():
            with self.subTest(provider=provider):
                self.assertEqual(
                    [values[name] for name in (
                        "apiConversation", "apiPrompt", "apiAbort",
                        "nativeQuestions", "nativePermissions", "apiModelSelection", "apiVariantSelection",
                    )],
                    [False] * 7,
                )

    def test_verification_is_cached_briefly_then_repeated(self):
        _, resolve = self.capabilities(self.binding)
        with patch.object(api, "resolve", return_value=self.binding) as again:
            self.adapter.agent_capabilities(SESSION, "p1")
        again.assert_not_called()
        with patch.object(api, "resolve", return_value=self.binding) as rotated:
            with patch.object(self.adapter, "request_binding") as request:
                capabilities = self.adapter.agent_capabilities("ses_rotated", "p1")
            request.assert_called_once_with("p1", "ses_rotated")
        rotated.assert_not_called()
        self.assertNotIn("apiConversation", capabilities)
        self.assertEqual(resolve.call_count, 1)

    def test_a_failed_probe_never_removes_the_stored_record(self):
        self.adapter.servers().record(self.binding.credential)
        self.capabilities(None)
        self.assertIsNotNone(self.adapter.servers().load("p1"))

    def test_a_pruned_pane_loses_its_cached_verification_but_not_its_record(self):
        self.adapter.servers().record(self.binding.credential)
        self.capabilities(self.binding)
        self.adapter.prune_bindings(set())
        with patch.object(api, "resolve", return_value=None) as resolve:
            with patch.object(self.adapter, "request_binding") as request:
                capabilities = self.adapter.agent_capabilities(SESSION, "p1")
        resolve.assert_not_called()
        request.assert_called_once_with("p1", SESSION)
        self.assertNotIn("apiConversation", capabilities)
        self.assertIsNotNone(self.adapter.servers().load("p1"))

    def test_a_closed_pane_loses_both(self):
        self.adapter.servers().record(self.binding.credential)
        self.capabilities(self.binding)
        self.adapter.forget_pane("p1")
        self.assertIsNone(self.adapter.servers().load("p1"))
        with (
            patch.object(api, "resolve", return_value=None),
            patch.object(self.adapter, "request_binding"),
        ):
            self.assertNotIn(
                "apiConversation", self.adapter.agent_capabilities(SESSION, "p1")
            )

    def test_an_unreadable_store_is_reported_without_naming_a_secret(self):
        diagnostics = []
        with (
            patch.object(
                type(self.adapter.servers()), "load",
                side_effect=BridgeError("OPENCODE_SERVER_STORE_UNAVAILABLE", "synthetic"),
            ),
            patch.object(self.bridge, "_diagnostic", side_effect=lambda *item: diagnostics.append(item)),
            patch.object(api, "resolve", return_value=None) as resolve,
        ):
            self.assertIsNone(self.adapter.binding("p1", SESSION, force=True))
            with patch.object(self.adapter, "request_binding"):
                capabilities = self.adapter.agent_capabilities(SESSION, "p1")
        self.assertNotIn("apiConversation", capabilities)
        self.assertEqual(diagnostics, [("OPENCODE_SERVER_STORE", "OPENCODE_SERVER_STORE_UNAVAILABLE")])
        resolve.assert_called_once()
        self.assertIsNone(resolve.call_args.args[3])

    def test_a_published_agent_snapshot_never_contains_a_credential(self):
        self.adapter.servers().record(self.binding.credential)
        with patch.object(api, "resolve", return_value=self.binding):
            self.adapter.binding("p1", SESSION, force=True)
            snapshot = self.bridge._normalize_snapshot({
                "panes": [{"pane_id": "p1"}],
                "agents": [{
                    "pane_id": "p1", "agent": "opencode", "workspace_id": "w1",
                    "agent_session": {"value": SESSION},
                }],
            })
        self.assertNotIn("secret-password", json.dumps(snapshot, default=str))
        agent = snapshot["agents"][0]
        self.assertTrue(agent["capabilities"]["apiConversation"])

    def test_explicit_reads_reverify_an_expired_managed_binding(self):
        self.adapter.servers().record(self.binding.credential)
        self.adapter._bindings["p1"] = (0, SESSION, self.binding)
        agent = {
            "id": "a1", "provider": "opencode",
            "providerSessionId": SESSION, "paneId": "p1",
        }
        with patch.object(api, "resolve", return_value=self.binding) as resolve:
            self.adapter.prepare_conversation(agent)
        resolve.assert_called_once()
        self.assertIs(self.adapter.binding("p1", SESSION), self.binding)

    def test_model_apply_reverifies_an_expired_managed_binding(self):
        self.adapter.servers().record(self.binding.credential)
        self.adapter._bindings["p1"] = (0, SESSION, self.binding)
        agent = {
            "id": "a1", "provider": "opencode",
            "providerSessionId": SESSION, "paneId": "p1",
        }
        self.bridge.raw_agents = {"a1": agent}
        self.bridge.runtime = {"agents": [], "workspaces": []}
        self.bridge._refresh_runtime = Mock()
        with patch.object(api, "resolve", return_value=self.binding) as resolve:
            result = self.adapter.retune({
                "agentId": "a1", "providerSessionId": SESSION,
                "model": "openai/gpt-5.4",
            })
        self.assertEqual(result["agentId"], "a1")
        resolve.assert_called_once()


class LaunchPruningTest(unittest.TestCase):
    """Records for panes closed outside this app, and only those."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        home = patch.object(Path, "home", return_value=Path(directory.name))
        home.start()
        self.addCleanup(home.stop)
        grace = patch(
            "remodr_bridge.providers.opencode.registry.PRUNE_GRACE_SECONDS", 0
        )
        grace.start()
        self.addCleanup(grace.stop)
        self.bridge = Bridge()
        self.bridge.agent_catalog = []
        self.adapter = self.bridge.providers["opencode"]
        for pane in ("p1", "p2"):
            self.adapter.servers().record(ServerCredential(
                pane_id=pane, cwd="/work/project", username="user",
                password="secret-password", session_id=SESSION,
            ))

    def snapshot(self, panes):
        self.adapter._retained = None
        return self.bridge._normalize_snapshot({
            "panes": panes,
            "agents": [],
        })

    def panes(self):
        return self.adapter.servers().panes()

    def test_an_authoritative_snapshot_reclaims_panes_it_does_not_list(self):
        self.snapshot([{"pane_id": "p2"}, {"pane_id": "p9"}])
        self.assertEqual(self.panes(), frozenset({"p2"}))

    def test_a_snapshot_without_a_pane_list_proves_nothing(self):
        for panes in ([], None, "panes", [{"label": "no id"}]):
            with self.subTest(panes=panes):
                self.snapshot(panes)
                self.assertEqual(self.panes(), frozenset({"p1", "p2"}))

    def test_an_unusable_store_never_breaks_a_snapshot(self):
        diagnostics = []
        with (
            patch.object(
                ServerRegistry, "retain",
                side_effect=BridgeError("OPENCODE_SERVER_STORE_BUSY", "synthetic /private/path"),
            ),
            patch.object(self.bridge, "_diagnostic", side_effect=lambda *item: diagnostics.append(item)),
        ):
            self.assertEqual(self.snapshot([{"pane_id": "p2"}])["agents"], [])
        self.assertEqual(diagnostics, [("OPENCODE_SERVER_STORE", "OPENCODE_SERVER_STORE_BUSY")])
        self.assertEqual(self.panes(), frozenset({"p1", "p2"}))

    def test_an_unchanged_pane_set_does_not_reopen_the_store(self):
        panes = [{"pane_id": "p1"}, {"pane_id": "p2"}]
        self.snapshot(panes)
        with patch.object(ServerRegistry, "retain") as retain:
            self.bridge._normalize_snapshot({"panes": panes, "agents": []})
            self.bridge._normalize_snapshot({"panes": panes, "agents": []})
            retain.assert_not_called()
            # A pane appearing or disappearing is never delayed.
            self.bridge._normalize_snapshot({"panes": [{"pane_id": "p1"}], "agents": []})
            retain.assert_called_once_with({"p1"})


if __name__ == "__main__":
    unittest.main()
