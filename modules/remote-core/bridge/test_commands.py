import json
import io
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from herdr_mobile_bridge import Bridge, BridgeError, CommandLedger


AGENT = {
    "id": "agent-1",
    "provider": "copilot",
    "providerSessionId": "session-1",
    "paneId": "pane-1",
    "agent_status": "working",
}
PRECONDITION = {key: AGENT[key] for key in ("provider", "providerSessionId", "paneId")}
WORKER = """
import json, os, time
from pathlib import Path
from herdr_mobile_bridge import Bridge
bridge = Bridge()
bridge.raw_agents = {"agent-1": {
    "id":"agent-1", "provider":"copilot", "providerSessionId":"session-1",
    "paneId":"pane-1", "agent_status":"working"
}}
bridge._refresh_runtime = lambda: None
def mutate(method, params):
    with (Path.home() / "effects").open("a") as output:
        output.write("effect\\n")
        output.flush()
        os.fsync(output.fileno())
    time.sleep(float(os.environ.get("EFFECT_DELAY", "0")))
    return {}
bridge._herdr_request = mutate
if os.environ.get("LOSE_ACK"):
    bridge.write = lambda response: os._exit(0)
bridge._handle_request_line(input())
"""


class DurableCommandsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.home_patch = patch.object(Path, "home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.bridge = self.make_bridge()
        self.command_id = str(uuid.uuid4())
        self.payload = {
            "agentId": "agent-1",
            "text": "private message",
            "precondition": dict(PRECONDITION),
        }

    def make_bridge(self):
        bridge = Bridge()
        bridge.raw_agents = {"agent-1": dict(AGENT)}
        bridge._refresh_runtime = Mock()
        bridge._herdr_request = Mock(return_value={})
        bridge.write = Mock()
        return bridge

    def envelope(self, command_id=None, action="agent.send_message", payload=None, attempt="attempt-1"):
        return {
            "protocol": 1, "type": "request", "id": attempt,
            "commandId": self.command_id if command_id is None else command_id,
            "action": action, "payload": self.payload if payload is None else payload,
        }

    def send(self, bridge=None, **kwargs):
        bridge = bridge or self.bridge
        bridge._handle_request_line(json.dumps(self.envelope(**kwargs)))
        return bridge.write.call_args.args[0]

    def status(self, bridge=None):
        return (bridge or self.bridge)._dispatch("command.status", {"commandId": self.command_id})

    def assert_error(self, response, code):
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], code, response)

    def test_protocol_and_fast_ping_preserve_legacy_behavior(self):
        self.assertEqual(self.bridge._dispatch("bridge.ping", {}), {"alive": True})
        self.bridge._herdr_request.assert_not_called()
        envelope = self.envelope()
        del envelope["commandId"]
        del envelope["payload"]["precondition"]
        self.bridge._handle_request_line(json.dumps(envelope))
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertEqual(self.bridge._herdr_request.call_count, 2)
        self.assertFalse((self.home / ".local").exists())
        self.assertTrue(self.bridge._capabilities()["durableCommands"])

    def test_restart_replays_exact_result_with_new_transport_id(self):
        first = self.send()
        bridge = self.make_bridge()
        second = self.send(bridge, attempt="attempt-2")
        self.assertEqual(second, {**first, "id": "attempt-2"})
        self.assertEqual(second["payload"], {"accepted": True})
        bridge._herdr_request.assert_not_called()
        self.assertEqual(self.status()["state"], "succeeded")

    def test_real_process_lost_ack_does_not_repeat_effect(self):
        envelope = self.envelope()
        first = self.worker(envelope, LOSE_ACK="1")
        self.assertEqual(first.stdout, "")
        envelope["id"] = "after-restart"
        second = self.worker(envelope)
        self.assertTrue(json.loads(second.stdout)["ok"])
        self.assertEqual(json.loads(second.stdout)["id"], "after-restart")
        self.assertEqual((self.home / "effects").read_text(), "effect\n")

    def worker(self, envelope, **environment):
        return subprocess.run(
            [sys.executable, "-c", WORKER],
            input=json.dumps(envelope) + "\n", text=True, capture_output=True,
            cwd=Path(__file__).parent,
            env={
                **os.environ, "HOME": str(self.home),
                "HERDR_SOCKET": self.bridge.herdr_socket, **environment,
            },
            timeout=15, check=True,
        )

    def test_fingerprint_covers_action_payload_and_binding(self):
        self.assertTrue(self.send()["ok"])
        for kwargs in (
            {"payload": {**self.payload, "text": "different"}},
            {"action": "agent.interrupt"},
            {"payload": {**self.payload, "precondition": {**PRECONDITION, "paneId": "new"}}},
        ):
            self.assert_error(self.send(**kwargs), "COMMAND_ID_CONFLICT")
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_fingerprint_is_canonical_not_dictionary_order(self):
        self.send()
        payload = dict(reversed(list(self.payload.items())))
        self.assertTrue(self.send(payload=payload)["ok"])
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_stable_device_user_herdr_session_scope(self):
        self.send()
        other = self.make_bridge()
        other.device_id = "other-device"
        self.assertEqual(self.status(other)["state"], "unknown")
        self.assertTrue(self.send(other)["ok"])
        other = self.make_bridge()
        other.session_name = "other-session"
        self.assertEqual(self.status(other)["state"], "unknown")
        other.herdr_socket = "/different/herdr.sock"
        self.assertTrue(self.send(other)["ok"])

    def test_validation_error_is_persisted_before_response(self):
        self.payload["text"] = ""
        first = self.send()
        self.assert_error(first, "INVALID_MESSAGE")
        other = self.make_bridge()
        self.assertEqual(self.send(other, attempt="retry"), {**first, "id": "retry"})
        other._refresh_runtime.assert_not_called()
        self.assertEqual(self.status()["state"], "failed")

    def test_status_unknown_does_not_reserve_or_dispatch(self):
        self.assertEqual(self.status(), {"commandId": self.command_id, "state": "unknown"})
        self.bridge._herdr_request.assert_not_called()
        self.assertTrue(self.send()["ok"])
        status = self.status()
        self.assertTrue(status["response"]["ok"])
        self.assertNotIn("id", status["response"])

    def test_reservation_committed_before_mutation_and_ack_after_finish(self):
        observed = []
        def mutate(*_):
            observed.append(self.status()["state"])
            return {}
        def write(response):
            observed.append(self.status()["state"])
        self.bridge._herdr_request = mutate
        self.bridge.write = write
        self.bridge._handle_request_line(json.dumps(self.envelope()))
        self.assertEqual(observed, ["in_progress", "succeeded"])

    def test_concurrent_processes_dispatch_only_once(self):
        self.status()
        processes = [
            subprocess.Popen(
                [sys.executable, "-c", WORKER],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, cwd=Path(__file__).parent,
                env={
                    **os.environ, "HOME": str(self.home),
                    "HERDR_SOCKET": self.bridge.herdr_socket, "EFFECT_DELAY": "0.3",
                },
            )
            for _ in range(5)
        ]
        try:
            for process in processes:
                process.stdin.write(json.dumps(self.envelope()) + "\n")
                process.stdin.flush()
            results = []
            for process in processes:
                output, errors = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, errors)
                results.append(json.loads(output))
            self.assertEqual(sum(result["ok"] for result in results), 1)
            for result in results:
                if not result["ok"]:
                    self.assert_error(result, "COMMAND_IN_PROGRESS")
            self.assertEqual((self.home / "effects").read_text(), "effect\n")
            self.assertTrue(self.send()["ok"])
            self.bridge._herdr_request.assert_not_called()
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)

    def test_inflight_is_not_reexecuted(self):
        ledger = self.bridge._command_ledger()
        encoded = json.dumps(
            ["agent.send_message", self.payload], sort_keys=True,
            separators=(",", ":"), ensure_ascii=True,
        )
        import hashlib
        ledger.reserve(self.command_id, hashlib.sha256(encoded.encode()).hexdigest())
        self.assert_error(self.send(), "COMMAND_IN_PROGRESS")
        self.bridge._herdr_request.assert_not_called()

    def test_dead_owner_is_uncertain_even_before_dispatch(self):
        self.reserve_matching()
        with patch.object(CommandLedger, "_owner_alive", return_value=False):
            self.assert_error(self.send(), "COMMAND_UNCERTAIN")
        self.assertEqual(self.status()["state"], "uncertain")
        self.bridge._herdr_request.assert_not_called()

    def reserve_matching(self):
        import hashlib
        encoded = json.dumps(
            ["agent.send_message", self.payload], sort_keys=True, separators=(",", ":"),
        )
        ledger = self.bridge._command_ledger()
        ledger.reserve(self.command_id, hashlib.sha256(encoded.encode()).hexdigest())
        return ledger

    def test_expired_reservation_never_becomes_replayable(self):
        ledger = self.reserve_matching()
        with sqlite3.connect(ledger.path) as connection:
            connection.execute("UPDATE commands SET created=?", (time.time() - 121,))
        for bridge in (self.bridge, self.make_bridge()):
            self.assert_error(self.send(bridge), "COMMAND_UNCERTAIN")
            bridge._herdr_request.assert_not_called()

    def test_process_crash_reservation_becomes_uncertain(self):
        process = subprocess.run(
            [sys.executable, "-c",
             "from herdr_mobile_bridge import Bridge; "
             f"Bridge()._command_ledger().reserve({self.command_id!r}, 'reserved'); "
             "import os; os._exit(0)"],
            cwd=Path(__file__).parent, env={
                **os.environ, "HOME": str(self.home), "HERDR_SOCKET": self.bridge.herdr_socket,
            },
            capture_output=True, text=True, check=True, timeout=10,
        )
        self.assertEqual(process.stdout, "")
        self.assertEqual(self.status()["state"], "uncertain")
        self.bridge._herdr_request.assert_not_called()

    def test_partial_effect_exception_is_durably_uncertain(self):
        self.bridge._herdr_request.side_effect = OSError("reply lost after send")
        self.assert_error(self.send(), "COMMAND_UNCERTAIN")
        self.assertEqual(self.status()["state"], "uncertain")
        other = self.make_bridge()
        self.assert_error(self.send(other), "COMMAND_UNCERTAIN")
        other._herdr_request.assert_not_called()

    def test_herdr_error_after_dispatch_is_conservatively_uncertain(self):
        self.bridge._herdr_request.side_effect = BridgeError("HERDR_ERROR", "rejected")
        self.assert_error(self.send(), "COMMAND_UNCERTAIN")

    def test_finish_failure_cannot_emit_success_or_replay(self):
        with patch.object(CommandLedger, "finish", side_effect=sqlite3.OperationalError("disk full")):
            self.assert_error(self.send(), "COMMAND_UNCERTAIN")
        self.assert_error(self.send(), "COMMAND_IN_PROGRESS")
        self.assertEqual(self.bridge._herdr_request.call_count, 1)
        with patch.object(CommandLedger, "_owner_alive", return_value=False):
            self.assert_error(self.send(), "COMMAND_UNCERTAIN")

    def test_store_unavailable_fails_before_dispatch(self):
        with patch.object(sqlite3, "connect", side_effect=sqlite3.OperationalError("unavailable")):
            self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.bridge._herdr_request.assert_not_called()

    def test_sqlite_lock_is_in_progress_without_dispatch(self):
        self.status()
        connection = sqlite3.connect(self.bridge._command_ledger().path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.assert_error(self.send(), "COMMAND_IN_PROGRESS")
        finally:
            connection.close()
        self.bridge._herdr_request.assert_not_called()

    def test_corrupt_store_is_not_reset(self):
        self.status()
        path = self.bridge._command_ledger().path
        path.write_bytes(b"not a SQLite database")
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.assertEqual(path.read_bytes(), b"not a SQLite database")
        self.bridge._herdr_request.assert_not_called()

    def test_missing_database_after_initialization_is_not_recreated(self):
        self.send()
        path = self.bridge._command_ledger().path
        path.unlink()
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.assertFalse(path.exists())
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_capacity_refuses_new_ids_without_evicting_old_results(self):
        self.assertTrue(self.send()["ok"])
        with patch("herdr_mobile_bridge.COMMAND_MAX_ENTRIES", 1):
            self.assert_error(self.send(command_id=str(uuid.uuid4())), "COMMAND_STORE_FULL")
            self.assertTrue(self.send()["ok"])
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_private_directory_database_marker_and_no_plaintext_payload(self):
        self.send()
        path = self.bridge._command_ledger().path
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((path.parent / "commands.initialized").stat().st_mode & 0o777, 0o600)
        self.assertNotIn(b"private message", path.read_bytes())

    def test_nonprivate_store_is_refused_not_silently_chmodded(self):
        self.status()
        path = self.bridge._command_ledger().path
        path.chmod(0o644)
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        self.bridge._herdr_request.assert_not_called()

    def test_symlink_database_is_refused(self):
        self.status()
        path = self.bridge._command_ledger().path
        backup = path.with_name("backup")
        path.rename(backup)
        path.symlink_to(backup)
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.bridge._herdr_request.assert_not_called()

    def test_symlink_storage_ancestor_is_refused(self):
        real = self.home / "real-local"
        real.mkdir()
        (self.home / ".local").symlink_to(real)
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.assertFalse((real / "share").exists())
        self.bridge._herdr_request.assert_not_called()

    def test_missing_or_changed_binding_fails_closed(self):
        payloads = [
            {key: value for key, value in self.payload.items() if key != "precondition"},
            {**self.payload, "precondition": {**PRECONDITION, "providerSessionId": "old"}},
            {**self.payload, "precondition": {**PRECONDITION, "paneId": "old"}},
            {**self.payload, "precondition": {**PRECONDITION, "provider": "claude"}},
        ]
        for payload in payloads:
            self.assert_error(
                self.send(command_id=str(uuid.uuid4()), payload=payload),
                "COMMAND_PRECONDITION_FAILED",
            )
        self.bridge._herdr_request.assert_not_called()

    def test_refresh_detects_new_provider_session(self):
        self.bridge._refresh_runtime.side_effect = lambda: self.bridge.raw_agents.update(
            {"agent-1": {**AGENT, "providerSessionId": "replacement"}}
        )
        self.assert_error(self.send(), "COMMAND_PRECONDITION_FAILED")
        self.bridge._herdr_request.assert_not_called()

    def test_target_change_after_preflight_still_prevents_dispatch(self):
        original = self.bridge._dispatch
        def dispatch(action, payload):
            self.bridge.raw_agents["agent-1"] = {**AGENT, "providerSessionId": "new"}
            return original(action, payload)
        self.bridge._dispatch = dispatch
        self.assert_error(self.send(), "COMMAND_PRECONDITION_FAILED")
        self.bridge._herdr_request.assert_not_called()

    def test_target_change_between_key_batches_stops_with_uncertainty(self):
        self.bridge.raw_agents["agent-1"]["agent_status"] = "blocked"
        self.bridge.dialog_settle_seconds = 0
        self.bridge._load_conversation = Mock(
            return_value={"activeHumanRequest": {"id": "question-1", "options": []}}
        )
        def change_target(*_):
            self.bridge.raw_agents["agent-1"] = {**AGENT, "providerSessionId": "new"}
            return {}
        self.bridge._herdr_request.side_effect = change_target
        payload = {
            "agentId": "agent-1", "requestId": "question-1", "precondition": PRECONDITION,
            "answer": {"customText": "yes"},
        }
        self.assert_error(
            self.send(action="human_request.answer", payload=payload), "COMMAND_UNCERTAIN"
        )
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_corrupt_saved_result_cannot_cause_reexecution(self):
        self.send()
        with sqlite3.connect(self.bridge._command_ledger().path) as connection:
            connection.execute("UPDATE commands SET response='not json'")
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_unsafe_directory_and_journal_are_rejected(self):
        self.status()
        path = self.bridge._command_ledger().path
        path.parent.chmod(0o755)
        self.assertTrue(self.bridge._capabilities()["durableCommands"])
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        journal = Path(str(path) + "-journal")
        journal.symlink_to(path)
        self.assert_error(self.send(), "COMMAND_STORE_UNAVAILABLE")
        self.bridge._herdr_request.assert_not_called()

    def test_session_manager_sftp_deployment_layout_migrates_safely(self):
        import hashlib
        source = Path(__file__).with_name("herdr_mobile_bridge.py").read_bytes()
        deployment = self.home / ".local/share/remote-workspace"
        deployment.mkdir(parents=True)
        script = deployment / "herdr_mobile_bridge.py"
        script.write_bytes(source)
        script.chmod(0o700)
        digest = hashlib.sha256(source).hexdigest()
        (deployment / "herdr_mobile_bridge.sha256").write_text(digest)
        for mode in (0o755, 0o775, 0o777):
            with self.subTest(sftp_directory_mode=oct(mode)):
                for directory in (deployment.parent.parent, deployment.parent, deployment):
                    directory.chmod(mode)
                result = subprocess.run(
                    [
                        sys.executable, "-c",
                        "import json; from herdr_mobile_bridge import Bridge; "
                        "print(json.dumps(Bridge()._capabilities()))",
                    ],
                    cwd=deployment, env={**os.environ, "HOME": str(self.home)},
                    capture_output=True, text=True, timeout=10, check=True,
                )
                self.assertTrue(json.loads(result.stdout)["durableCommands"], result.stderr)
                self.assertEqual(deployment.stat().st_mode & 0o777, 0o700)
                for ancestor in (deployment.parent.parent, deployment.parent):
                    self.assertEqual(ancestor.stat().st_mode & 0o022, 0)
                self.assertEqual(script.read_bytes(), source)
                self.assertEqual((deployment / "herdr_mobile_bridge.sha256").read_text(), digest)

    def test_permission_migration_preserves_existing_command_history(self):
        self.assertTrue(self.send()["ok"])
        ledger = self.bridge._command_ledger()
        inode = ledger.path.stat().st_ino
        ledger.path.parent.chmod(0o775)
        other = self.make_bridge()
        self.assertTrue(self.send(other)["ok"])
        other._herdr_request.assert_not_called()
        self.assertEqual(ledger.path.stat().st_ino, inode)
        self.assertEqual(ledger.path.parent.stat().st_mode & 0o777, 0o700)

    def test_foreign_owned_directory_is_not_hardened_or_traversed(self):
        directory = self.home / ".local"
        directory.mkdir(mode=0o755)
        with patch("herdr_mobile_bridge.os.getuid", return_value=directory.stat().st_uid + 1):
            response = self.send()
        self.assert_error(response, "COMMAND_STORE_UNAVAILABLE")
        self.assertIn(str(directory), response["error"]["message"])
        self.assertIn("owned by uid", response["error"]["message"])
        self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        self.assertFalse((directory / "share").exists())
        self.bridge._herdr_request.assert_not_called()

    def test_symlink_diagnostic_names_unsafe_path_without_chmod_target(self):
        real = self.home / "shared"
        real.mkdir(mode=0o755)
        link = self.home / ".local"
        link.symlink_to(real)
        response = self.send()
        self.assert_error(response, "COMMAND_STORE_UNAVAILABLE")
        self.assertIn(str(link), response["error"]["message"])
        self.assertIn("symbolic link", response["error"]["message"])
        self.assertEqual(real.stat().st_mode & 0o777, 0o755)
        self.assertFalse((real / "share").exists())

    def test_file_permission_diagnostic_names_mode_and_remediation(self):
        self.status()
        path = self.bridge._command_ledger().path
        path.chmod(0o644)
        response = self.send()
        self.assert_error(response, "COMMAND_STORE_UNAVAILABLE")
        self.assertIn(str(path), response["error"]["message"])
        self.assertIn("0644", response["error"]["message"])
        self.assertIn("0600", response["error"]["message"])
        self.assertIn("without deleting", response["error"]["message"])

    def test_failed_directory_hardening_remains_fatal_with_exact_path(self):
        directory = self.home / ".local"
        directory.mkdir()
        directory.chmod(0o775)
        with patch("herdr_mobile_bridge.os.fchmod", side_effect=PermissionError("denied")):
            self.bridge.run()
        hello = self.bridge.write.call_args.args[0]
        self.assertTrue(hello["fatal"])
        self.assertFalse(hello["capabilities"]["durableCommands"])
        self.assertIn(str(directory), hello["error"]["message"])
        self.assertIn("0755", hello["error"]["message"])
        self.assertIn("denied", hello["error"]["message"])
        self.assertEqual(directory.stat().st_mode & 0o777, 0o775)
        self.bridge._refresh_runtime.assert_not_called()

    def test_saved_uncertain_error_replays_exactly(self):
        self.bridge._herdr_request.side_effect = OSError("lost reply")
        first = self.send()
        second = self.send(attempt="new-attempt")
        self.assertEqual(second, {**first, "id": "new-attempt"})
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_initial_interrupt_is_journaled_without_advertising_safe_run_replay(self):
        first = self.send(action="agent.interrupt")
        self.assertTrue(first["ok"])
        self.bridge._herdr_request.assert_called_once_with(
            "agent.send_keys", {"target": "pane-1", "keys": ["ctrl-c"]}
        )
        self.assertEqual(self.status()["state"], "succeeded")
        other = self.make_bridge()
        self.assertEqual(self.send(other, action="agent.interrupt"), first)
        other._herdr_request.assert_not_called()
        self.assertFalse(self.bridge._capabilities()["durableInterruptReplay"])

    def test_parent_expected_identity_fields_are_supported(self):
        payload = {
            "agentId": "agent-1", "text": "hello",
            "expectedProviderSessionId": "session-1", "expectedPaneId": "pane-1",
        }
        self.assertTrue(self.send(payload=payload)["ok"])
        self.assertEqual(self.bridge._herdr_request.call_count, 1)

    def test_nullable_or_changed_expected_identity_is_not_replay_safe(self):
        for session_id, pane_id in ((None, "pane-1"), ("", "pane-1"), ("old", "pane-1"),
                                    ("session-1", "old"), ("session-1", None)):
            payload = {
                "agentId": "agent-1", "text": "hello",
                "expectedProviderSessionId": session_id, "expectedPaneId": pane_id,
            }
            self.assert_error(
                self.send(payload=payload, command_id=str(uuid.uuid4())),
                "COMMAND_PRECONDITION_FAILED",
            )
        self.bridge._herdr_request.assert_not_called()

    def test_capability_is_false_when_journal_is_unavailable(self):
        with patch.object(sqlite3, "connect", side_effect=sqlite3.OperationalError("unavailable")):
            capabilities = self.bridge._capabilities()
        self.assertFalse(capabilities["durableCommands"])
        self.assertTrue(capabilities["durableCommandsRequireSessionIdentity"])
        self.assertEqual(self.bridge.command_store_error.code, "COMMAND_STORE_UNAVAILABLE")

    def test_unavailable_journal_is_a_fatal_typed_handshake(self):
        with patch.object(sqlite3, "connect", side_effect=sqlite3.OperationalError("unavailable")):
            self.bridge.run()
        self.bridge.write.assert_called_once()
        hello = self.bridge.write.call_args.args[0]
        self.assertEqual(hello["type"], "hello")
        self.assertTrue(hello["fatal"])
        self.assertFalse(hello["runtimeReady"])
        self.assertFalse(hello["capabilities"]["durableCommands"])
        self.assertEqual(hello["error"]["code"], "COMMAND_STORE_UNAVAILABLE")
        self.bridge._refresh_runtime.assert_not_called()
        self.assertFalse(self.bridge.running)

    def test_alive_ping_does_not_claim_unavailable_runtime_is_healthy(self):
        self.bridge._refresh_runtime.side_effect = OSError("Herdr is down")
        self.bridge.subscribed.set()
        ping = {
            "protocol": 1, "type": "request", "id": "ping",
            "action": "bridge.ping", "payload": {},
        }
        with (
            patch("herdr_mobile_bridge.threading.Thread"),
            patch("herdr_mobile_bridge.sys.stdin", io.StringIO(json.dumps(ping) + "\n")),
        ):
            self.bridge.run()
        messages = [call.args[0] for call in self.bridge.write.call_args_list]
        self.assertFalse(messages[0]["runtimeReady"])
        self.assertEqual(messages[0]["error"]["code"], "HERDR_UNAVAILABLE")
        self.assertTrue(messages[0]["capabilities"]["durableCommands"])
        self.assertEqual(messages[-1]["payload"], {"alive": True})
        self.assertNotEqual(self.bridge.runtime["connectionState"], "connected")

    def test_hello_reports_provider_catalog_loaded_during_initialization(self):
        def initialize():
            self.bridge.agent_catalog = [{"provider": "copilot", "available": True}]
        self.bridge._refresh_runtime.side_effect = initialize
        self.bridge.subscribed.set()
        with (
            patch("herdr_mobile_bridge.threading.Thread"),
            patch("herdr_mobile_bridge.sys.stdin", io.StringIO("")),
        ):
            self.bridge.run()
        hello = self.bridge.write.call_args_list[0].args[0]
        self.assertTrue(hello["runtimeReady"])
        self.assertTrue(hello["capabilities"]["providerCapabilities"]["copilot"]["installed"])
        self.assertTrue(hello["capabilities"]["durableCommands"])

    def test_stale_human_request_cannot_answer_new_question(self):
        self.bridge._load_conversation = Mock(return_value={"activeHumanRequest": {"id": "new"}})
        payload = {
            "agentId": "agent-1", "requestId": "old", "precondition": PRECONDITION,
            "answer": {"customText": "yes"},
        }
        self.assert_error(
            self.send(action="human_request.answer", payload=payload),
            "COMMAND_PRECONDITION_FAILED",
        )
        self.bridge._herdr_request.assert_not_called()

    def test_current_answer_is_cached_across_restart_without_revalidating_question(self):
        self.bridge._load_conversation = Mock(
            return_value={"activeHumanRequest": {"id": "question-1", "options": []}}
        )
        payload = {
            "agentId": "agent-1", "requestId": "question-1", "precondition": PRECONDITION,
            "answer": {"customText": "yes"},
        }
        self.assertTrue(self.send(action="human_request.answer", payload=payload)["ok"])
        other = self.make_bridge()
        self.assertTrue(self.send(other, action="human_request.answer", payload=payload)["ok"])
        other._refresh_runtime.assert_not_called()
        other._herdr_request.assert_not_called()

    def test_partial_multikey_answer_is_uncertain(self):
        self.bridge.raw_agents["agent-1"]["agent_status"] = "blocked"
        self.bridge.dialog_settle_seconds = 0
        self.bridge._load_conversation = Mock(
            return_value={"activeHumanRequest": {"id": "question-1", "options": []}}
        )
        self.bridge._herdr_request.side_effect = [{}, OSError("lost after first batch")]
        payload = {
            "agentId": "agent-1", "requestId": "question-1", "precondition": PRECONDITION,
            "answer": {"customText": "yes"},
        }
        self.assert_error(
            self.send(action="human_request.answer", payload=payload), "COMMAND_UNCERTAIN"
        )
        self.assertEqual(self.bridge._herdr_request.call_count, 2)

    def test_invalid_ids_and_unsupported_actions_never_dispatch(self):
        for value in ("", "attempt-1", 7, False):
            self.assert_error(self.send(command_id=value), "INVALID_COMMAND_ID")
        self.assert_error(self.send(action="agent.create"), "COMMAND_ACTION_UNSUPPORTED")
        self.bridge._herdr_request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
