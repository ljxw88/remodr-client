import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from herdr_mobile_bridge import Bridge, BridgeError


class ProcessSessionTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name).resolve()
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        self.bridge = Bridge()
        self.bridge.agent_catalog = [{"provider": "copilot", "available": True}]
        self.bridge._ensure_pane_subscriptions = Mock()
        self.bridge._diagnostic = Mock()
        self.bridge.write_event = Mock()
        self.bridge.write = Mock()
        self.info = {
            "pane_id": "p1",
            "foreground_process_group_id": 100,
            "shell_pid": 50,
            "foreground_processes": [{"pid": 100, "name": "copilot", "argv0": "copilot"}],
        }
        self.snapshot = {
            "panes": [{"pane_id": "p1"}],
            "agents": [{
                "pane_id": "p1", "agent": "copilot",
                "agent_session": {"value": "native-stale"}, "workspace_id": "w1",
            }],
        }
        self.bridge._herdr_request = Mock(side_effect=self.request)
        self.inspection = patch.object(
            self.bridge, "_copilot_open_session_ids", return_value={"active-session"}
        )
        self.open_sessions = self.inspection.start()
        self.addCleanup(self.inspection.stop)
        self.agent_id = self.bridge._stable_agent_id("p1")
        self.write_session("native-stale", "old history")
        self.write_session("active-session", "current history")

    def request(self, method, params):
        if method == "pane.process_info":
            return {"process_info": self.info}
        if method == "session.snapshot":
            return {"snapshot": self.snapshot}
        if method == "agent.read":
            return {"read": {"text": "old terminal text"}}
        if method == "agent.get":
            raise BridgeError("agent_not_found", "Agent exited.")
        return {}

    def write_session(self, session_id, content):
        directory = self.home / ".copilot" / "session-state" / session_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "events.jsonl").write_text(json.dumps({
            "id": session_id, "type": "user.message", "data": {"content": content},
        }) + "\n")

    def poll(self):
        return self.bridge._dispatch("agent.conversation", {"agentId": self.agent_id})

    def test_active_database_overrides_stale_native_identity_everywhere(self):
        self.bridge.started_sessions["p1"] = "native-stale"
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "active-session")
        self.assertEqual(conversation["items"][0]["text"], "current history")
        self.assertEqual(self.bridge.started_sessions["p1"], "active-session")
        self.assertEqual(
            self.bridge.runtime["agents"][0]["providerSessionId"], "active-session"
        )
        self.assertEqual(
            self.bridge.write_event.call_args.args[1]["agents"][0]["providerSessionId"],
            "active-session",
        )
        self.bridge._refresh_runtime()
        self.assertEqual(
            self.bridge.raw_agents[self.agent_id]["providerSessionId"], "active-session"
        )
        self.assertTrue(self.bridge._diagnostic.called)

    def test_clear_switching_descriptors_in_same_pid_is_not_hidden_by_a_cache(self):
        self.assertEqual(self.poll()["providerSessionId"], "active-session")
        self.write_session("after-clear", "new conversation")
        self.open_sessions.return_value = {"after-clear"}
        second = self.poll()
        self.assertEqual(second["providerSessionId"], "after-clear")
        self.assertEqual(second["items"][0]["text"], "new conversation")
        self.assertEqual(self.open_sessions.call_args_list[0].args, (100,))
        self.assertEqual(self.open_sessions.call_args_list[1].args, (100,))
        self.assertFalse(any(
            key[2] == "active-session" for key in self.bridge.conversation_cache
        ))

    def test_event_bursts_do_not_rescan_processes_or_restore_stale_native_ids(self):
        self.poll()
        self.open_sessions.reset_mock()
        self.write_session("after-clear", "new conversation")
        self.open_sessions.return_value = {"after-clear"}
        for _ in range(20):
            self.bridge._handle_herdr_event({
                "data": {"type": "pane_agent_status_changed", "pane_id": "p1"}
            })
        self.open_sessions.assert_not_called()
        self.assertEqual(
            self.bridge.raw_agents[self.agent_id]["providerSessionId"], "active-session"
        )
        self.assertEqual(self.poll()["providerSessionId"], "after-clear")
        self.open_sessions.assert_called_once_with(100)

    def test_event_hints_cannot_carry_session_identity_into_a_replaced_terminal(self):
        self.snapshot["agents"][0]["terminal_id"] = "original-terminal"
        self.poll()
        self.snapshot["agents"][0]["terminal_id"] = "replacement-terminal"
        self.bridge._refresh_runtime(inspect_copilot=False)
        self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])
        self.assertEqual(self.poll()["providerSessionId"], "active-session")

    def test_missing_optional_database_retains_native_identity_before_process_binding(self):
        self.open_sessions.return_value = set()
        self.assertEqual(self.poll()["providerSessionId"], "native-stale")
        self.assertNotIn("p1", self.bridge.process_bound_panes)
        self.assertIn("unverified native identity", self.bridge._diagnostic.call_args.args[1])

    def test_missing_database_cannot_restore_native_identity_after_process_binding(self):
        self.poll()
        self.open_sessions.return_value = set()
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])

    def test_multiple_candidates_fail_closed_even_with_native_id(self):
        for candidates in ({"first", "second"}, {"first", "second", "third"}):
            with self.subTest(candidates=candidates):
                self.open_sessions.return_value = candidates
                with self.assertRaises(BridgeError) as caught:
                    self.poll()
                self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
                self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])
                self.assertNotIn("p1", self.bridge.started_sessions)
                with self.assertRaises(BridgeError) as retune:
                    self.bridge._retune_agent({"agentId": self.agent_id, "model": "gpt-5.4"})
                self.assertEqual(retune.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.assertFalse(any(
            call.args[0] in ("agent.read", "agent.prompt")
            for call in self.bridge._herdr_request.call_args_list
        ))

    def test_unavailable_metadata_retains_native_behavior_with_diagnostic(self):
        self.info = None
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "native-stale")
        self.assertEqual(conversation["items"][0]["text"], "old history")
        self.open_sessions.assert_not_called()
        self.assertIn("unverified native identity", self.bridge._diagnostic.call_args.args[1])

    def test_unavailable_inspection_retains_native_behavior_before_first_binding(self):
        self.open_sessions.side_effect = OSError("lsof unavailable")
        self.assertEqual(self.poll()["providerSessionId"], "native-stale")
        self.assertIn("lsof unavailable", self.bridge._diagnostic.call_args.args[1])

    def test_temporary_inspection_failure_cannot_overwrite_process_bound_identity(self):
        self.poll()
        self.open_sessions.side_effect = OSError("inspection temporarily unavailable")
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])
        self.open_sessions.side_effect = None
        self.assertEqual(self.poll()["providerSessionId"], "active-session")

    def test_child_copilot_is_not_treated_as_foreground_group_leader(self):
        self.info["foreground_processes"] = [
            {"pid": 100, "name": "node", "argv0": "node"},
            {"pid": 101, "name": "copilot", "argv0": "copilot"},
        ]
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.open_sessions.assert_not_called()

    def test_mismatched_pane_process_metadata_is_not_inspected(self):
        self.info["pane_id"] = "another-pane"
        self.assertEqual(self.poll()["providerSessionId"], "native-stale")
        self.open_sessions.assert_not_called()

    def test_process_restart_or_pid_reuse_triggers_fresh_inspection(self):
        self.poll()
        self.write_session("restarted", "replacement process")
        self.info["foreground_process_group_id"] = 200
        self.info["foreground_processes"][0]["pid"] = 200
        self.open_sessions.return_value = {"restarted"}
        self.assertEqual(self.poll()["providerSessionId"], "restarted")
        self.info["shell_pid"] = 70
        self.info["foreground_process_group_id"] = 100
        self.info["foreground_processes"][0]["pid"] = 100
        self.open_sessions.return_value = {"active-session"}
        self.assertEqual(self.poll()["providerSessionId"], "active-session")
        self.assertEqual(
            [call.args[0] for call in self.open_sessions.call_args_list], [100, 200, 100]
        )

    def test_process_binding_change_during_inspection_is_refused(self):
        with patch.object(
            self.bridge, "_copilot_foreground_process",
            side_effect=[(100, 50), (200, 50)],
        ):
            with self.assertRaises(BridgeError) as caught:
                self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_metadata_disappearing_after_inspection_is_not_native_fallback(self):
        with patch.object(
            self.bridge, "_copilot_foreground_process",
            side_effect=[(100, 50), OSError("pane disappeared")],
        ):
            with self.assertRaises(BridgeError) as caught:
                self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_retune_independently_resolves_the_process_session(self):
        self.bridge.started_sessions["p1"] = "native-stale"
        with patch.object(self.bridge, "_restart_agent") as restart:
            self.bridge._retune_agent({
                "agentId": self.agent_id, "model": "gpt-5.4", "effort": "high"
            })
        self.assertEqual(restart.call_args.args[2], "active-session")

    def test_durable_preconditions_use_effective_identity_not_native_stale_ref(self):
        self.bridge._handle_request_line(json.dumps({
            "protocol": 1, "type": "request", "id": "attempt",
            "commandId": str(uuid.uuid4()), "action": "agent.send_message",
            "payload": {
                "agentId": self.agent_id, "text": "queued for old session",
                "expectedPaneId": "p1", "expectedProviderSessionId": "native-stale",
            },
        }))
        self.assertEqual(
            self.bridge.write.call_args.args[0]["error"]["code"],
            "COMMAND_PRECONDITION_FAILED",
        )
        self.assertFalse(any(
            call.args[0] == "agent.prompt" for call in self.bridge._herdr_request.call_args_list
        ))

    def test_exact_database_paths_only_not_other_homes_sidecars_or_children(self):
        self.inspection.stop()
        root = self.home / ".copilot" / "session-state"
        paths = [
            str(root / "valid" / "session.db"),
            str(root / "valid" / "session.db"),
            str(root / "wrong" / "events.jsonl"),
            str(root / "wrong" / "session.db-wal"),
            str(root / "wrong" / "nested" / "session.db"),
            str(self.home / "elsewhere" / "wrong" / "session.db"),
            str(root / ".." / "escape" / "session.db"),
            str(root / "deleted" / "session.db") + " (deleted)",
        ]
        with (
            patch("herdr_mobile_bridge.sys.platform", "linux"),
            patch.object(self.bridge, "_linux_process_paths", return_value=paths) as read,
        ):
            self.assertEqual(self.bridge._copilot_open_session_ids(100), {"valid"})
        read.assert_called_once_with(100)

    def test_macos_lsof_parser_requires_matching_pid_and_owner(self):
        self.inspection.stop()
        database = self.home / ".copilot" / "session-state" / "active-session" / "session.db"
        output = (
            f"p100\0u{os.getuid()}\0\nfcwd\0n{self.home}\0\nf7\0n{database}\0\n"
        ).encode()
        with (
            patch("herdr_mobile_bridge.sys.platform", "darwin"),
            patch("herdr_mobile_bridge.shutil.which", return_value="/usr/sbin/lsof"),
            patch.object(self.bridge, "_bounded_process_output", return_value=output) as run,
        ):
            self.assertEqual(self.bridge._copilot_open_session_ids(100), {"active-session"})
        self.assertEqual(run.call_args.args[0][-5:], ["-nP", "-a", "-p", "100", "-F0pun"])
        for invalid in (
            output.replace(b"p100\0", b"p101\0"),
            output.replace(f"u{os.getuid()}\0".encode(), f"u{os.getuid() + 1}\0".encode()),
            b"n/a/session.db\0",
        ):
            with self.subTest(output=invalid):
                with self.assertRaises(OSError):
                    Bridge._lsof_paths(invalid, 100)

    def test_linux_proc_inspects_only_numeric_fds_of_the_selected_owned_pid(self):
        entries = [
            SimpleNamespace(name="7", path="/proc/100/fd/7"),
            SimpleNamespace(name="8", path="/proc/100/fd/8"),
            SimpleNamespace(name="not-a-fd", path="/proc/100/fd/not-a-fd"),
        ]
        scan = MagicMock()
        scan.__enter__.return_value = iter(entries)
        with (
            patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=os.getuid())),
            patch("herdr_mobile_bridge.os.scandir", return_value=scan) as scandir,
            patch(
                "herdr_mobile_bridge.os.readlink",
                side_effect=["/home/user/.copilot/session-state/active/session.db", FileNotFoundError()],
            ) as readlink,
        ):
            self.assertEqual(
                Bridge._linux_process_paths(100),
                ["/home/user/.copilot/session-state/active/session.db"],
            )
        scandir.assert_called_once_with(Path("/proc/100/fd"))
        self.assertEqual(readlink.call_count, 2)

    def test_descriptor_subprocess_has_time_and_output_limits(self):
        with patch("herdr_mobile_bridge.PROCESS_INSPECTION_TIMEOUT", 0.05):
            with self.assertRaisesRegex(OSError, "timed out"):
                Bridge._bounded_process_output([
                    sys.executable, "-c", "import time; time.sleep(3)"
                ])
        with patch("herdr_mobile_bridge.PROCESS_INSPECTION_MAX_BYTES", 32):
            with self.assertRaisesRegex(OSError, "size limit"):
                Bridge._bounded_process_output([
                    sys.executable, "-c", "print('x' * 1000)"
                ])

    def test_linux_inspection_rejects_foreign_owners_and_excess_descriptors(self):
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=os.getuid() + 1)):
            with self.assertRaisesRegex(OSError, "another user"):
                Bridge._linux_process_paths(100)
        scan = MagicMock()
        scan.__enter__.return_value = iter([
            SimpleNamespace(name="7", path="/proc/100/fd/7"),
            SimpleNamespace(name="8", path="/proc/100/fd/8"),
        ])
        with (
            patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=os.getuid())),
            patch("herdr_mobile_bridge.os.scandir", return_value=scan),
            patch("herdr_mobile_bridge.os.readlink", return_value="/some/path"),
            patch("herdr_mobile_bridge.PROCESS_INSPECTION_MAX_FDS", 1),
        ):
            with self.assertRaisesRegex(OSError, "exceeds its limit"):
                Bridge._linux_process_paths(100)


if __name__ == "__main__":
    unittest.main()
