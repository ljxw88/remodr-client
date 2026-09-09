import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from remodr_bridge.providers.copilot.processes import CopilotProcesses
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
            self.bridge.providers["copilot"].processes, "open_session_ids", return_value={"active-session"}
        )
        self.open_sessions = self.inspection.start()
        self.addCleanup(self.inspection.stop)
        locks = patch.object(self.bridge.providers["copilot"].processes, "locked_session_ids", return_value=set())
        self.locked_sessions = locks.start()
        self.addCleanup(locks.stop)
        self.lock_patch = locks
        metadata = patch.object(self.bridge.providers["copilot"].processes, "linux_process_metadata", side_effect=self.process_metadata)
        metadata.start()
        self.addCleanup(metadata.stop)
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

    def process_metadata(self, pid):
        process = next(item for item in self.info["foreground_processes"] if item["pid"] == pid)
        executable = process.get("argv0") or process["name"]
        return {
            "parent": self.info["shell_pid"], "group": self.info["foreground_process_group_id"],
            "executable": executable, "argv": [executable],
        }

    def test_linux_vscode_launcher_resolves_native_runtime_without_argv0(self):
        self.info["foreground_processes"] = [
            {"pid": 100, "name": "copilot", "argv0": None},
            {"pid": 101, "name": "MainThread", "argv0": None},
            {"pid": 102, "name": "MainThread", "argv0": None},
            {"pid": 103, "name": "MainThread", "argv0": None},
        ]
        metadata = {
            100: {"parent": 50, "group": 100, "executable": "/usr/bin/dash",
                  "argv": ["/bin/sh", "/vscode/copilotCli/copilot"]},
            101: {"parent": 100, "group": 100, "executable": "/vscode/node",
                  "argv": ["/vscode/node", "/vscode/copilotCLIShim.js"]},
            102: {"parent": 101, "group": 100, "executable": "/usr/local/bin/node",
                  "argv": ["node", "/usr/local/bin/copilot"]},
            103: {"parent": 102, "group": 100, "executable": "/npm/@github/copilot-linux-x64/copilot (deleted)",
                  "argv": ["/npm/@github/copilot-linux-x64/copilot"]},
        }
        with (
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "linux"),
            patch.object(self.bridge.providers["copilot"].processes, "linux_process_metadata", side_effect=metadata.__getitem__),
        ):
            self.assertEqual(self.poll()["providerSessionId"], "active-session")
        self.open_sessions.assert_called_once_with(103)

    def test_linux_native_runtime_is_recognized_by_executable_not_thread_name(self):
        self.info["foreground_processes"] = [{"pid": 100, "name": "MainThread", "argv0": None}]
        with (
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "linux"),
            patch.object(self.bridge.providers["copilot"].processes, "linux_process_metadata", return_value={
                "parent": 50, "group": 100, "executable": "/opt/copilot/copilot", "argv": ["copilot"],
            }),
        ):
            self.assertEqual(self.poll()["providerSessionId"], "active-session")
        self.open_sessions.assert_called_once_with(100)

    def test_linux_reused_pid_from_another_shell_is_not_inspected(self):
        self.info["foreground_processes"] = [{"pid": 100, "name": "MainThread", "argv0": None}]
        with (
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "linux"),
            patch.object(self.bridge.providers["copilot"].processes, "linux_process_metadata", side_effect={
                100: {"parent": 70, "group": 100, "executable": "/bin/copilot", "argv": ["copilot"]},
                70: {"parent": 1, "group": 70, "executable": "/bin/bash", "argv": ["bash"]},
            }.__getitem__),
        ):
            with self.assertRaises(BridgeError) as error:
                self.poll()
            self.assertEqual(error.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.open_sessions.assert_not_called()

    def test_linux_launcher_rejects_unrelated_or_ambiguous_runtimes(self):
        self.info["foreground_processes"] = [
            {"pid": 100, "name": "copilot"}, {"pid": 101, "name": "MainThread"},
            {"pid": 102, "name": "MainThread"},
        ]
        root = {"parent": 50, "group": 100, "executable": "/bin/sh", "argv": ["sh", "/bin/copilot"]}
        native = {"parent": 100, "group": 100, "executable": "/bin/copilot", "argv": ["copilot"]}
        for children in (
            {101: {**native, "parent": 999}, 102: {**native, "group": 200}},
            {101: native, 102: native},
        ):
            with (
                self.subTest(children=children),
                patch("remodr_bridge.providers.copilot.processes.sys.platform", "linux"),
                patch.object(self.bridge.providers["copilot"].processes, "linux_process_metadata", side_effect={100: root, **children}.__getitem__),
            ):
                with self.assertRaises(BridgeError) as error:
                    self.poll()
                self.assertEqual(error.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.open_sessions.assert_not_called()

    def write_session(self, session_id, content):
        directory = self.home / ".copilot" / "session-state" / session_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "events.jsonl").write_text(json.dumps({
            "id": session_id, "type": "user.message", "data": {"content": content},
        }) + "\n")

    def poll(self):
        return self.bridge._dispatch("agent.conversation", {"agentId": self.agent_id})

    def test_first_process_verified_identity_retains_matching_launch_settings(self):
        tuning = {"model": "launch-model", "effort": "high", "context": "long_context"}
        self.bridge.sessions.record_launch("p1", "active-session", tuning, False)
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "active-session")
        self.assertEqual(self.bridge.sessions.tuning("p1"), tuning)
        self.assertEqual(self.bridge.runtime["agents"][0]["tuning"], tuning)
        self.assertFalse(self.bridge.sessions.bypass("p1"))
        self.assertTrue(self.bridge.sessions.is_process_bound("p1"))
        self.assertTrue(self.bridge.sessions.was_observed("p1"))

    def test_active_database_overrides_stale_native_identity_everywhere(self):
        self.bridge.sessions.record_launch("p1", "native-stale", {"model": "stale-model"}, False)
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "active-session")
        self.assertEqual(conversation["items"][0]["text"], "current history")
        self.assertEqual(self.bridge.sessions.launched_session("p1"), "active-session")
        self.assertEqual(self.bridge.sessions.tuning("p1"), {})
        self.assertIsNone(self.bridge.runtime["agents"][0]["tuning"]["model"])
        self.assertFalse(self.bridge.sessions.bypass("p1"))
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
            key.session_id == "active-session"
            for key in self.bridge.sessions.conversation_keys()
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
        self.assertFalse(self.bridge.sessions.is_process_bound("p1"))
        self.assertIn("unverified native identity", self.bridge._diagnostic.call_args.args[1])

    def test_first_message_binds_to_live_marker_without_native_id_or_database(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"new-before-first-turn"}
        self.snapshot["agents"][0].pop("agent_session")
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "new-before-first-turn")
        self.assertEqual(self.bridge.runtime["agents"][0]["providerSessionId"], "new-before-first-turn")
        self.assertTrue(self.bridge.sessions.is_process_bound("p1"))
        self.assertIsNone(self.bridge.sessions.identity_error("p1"))

    def test_marker_recovers_identity_after_bridge_reconnect_without_launch_hints(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"active-session"}
        self.assertIsNone(self.bridge.sessions.launched_session("p1"))
        self.assertEqual(self.poll()["items"][0]["text"], "current history")
        self.assertEqual(self.poll()["providerSessionId"], "active-session")

    def test_first_message_with_marker_identity_keeps_durable_preconditions(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"new-before-first-turn"}
        self.snapshot["agents"][0].pop("agent_session")
        envelope = {
            "protocol": 1, "type": "request", "id": "first-send",
            "commandId": str(uuid.uuid4()), "action": "agent.send_message",
            "payload": {
                "agentId": self.agent_id, "text": "hello",
                "precondition": {
                    "provider": "copilot", "paneId": "p1",
                    "providerSessionId": "new-before-first-turn",
                },
            },
        }
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertTrue(self.bridge.write.call_args.args[0]["ok"])
        prompts = [call for call in self.bridge._herdr_request.call_args_list if call.args[0] == "agent.prompt"]
        self.assertEqual(len(prompts), 1)
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertEqual(len([call for call in self.bridge._herdr_request.call_args_list if call.args[0] == "agent.prompt"]), 1)
        self.locked_sessions.return_value = {"rotated-session"}
        envelope["commandId"] = str(uuid.uuid4())
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertEqual(self.bridge.write.call_args.args[0]["error"]["code"], "COMMAND_PRECONDITION_FAILED")
        self.assertEqual(len([call for call in self.bridge._herdr_request.call_args_list if call.args[0] == "agent.prompt"]), 1)

    def test_new_marker_overrides_stale_launch_and_native_id_after_clear(self):
        self.poll()
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"after-clear"}
        self.assertEqual(self.poll()["providerSessionId"], "after-clear")
        self.locked_sessions.return_value = set()
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_multiple_active_markers_fail_closed(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"first", "second"}
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_clear_drops_bound_marker_when_one_live_marker_remains(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"native-stale"}
        self.assertEqual(self.poll()["providerSessionId"], "native-stale")
        self.write_session("after-clear", "new conversation")
        self.locked_sessions.return_value = {"native-stale", "after-clear"}
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "after-clear")
        self.assertEqual(conversation["items"][0]["text"], "new conversation")

    def test_clear_follows_live_marker_when_herdr_native_id_catches_up(self):
        self.open_sessions.return_value = set()
        self.locked_sessions.return_value = {"native-stale"}
        self.poll()
        self.write_session("after-clear", "new conversation")
        self.snapshot["agents"][0]["agent_session"] = {"value": "after-clear"}
        self.locked_sessions.return_value = {"native-stale", "after-clear"}
        self.assertEqual(self.poll()["providerSessionId"], "after-clear")

    def test_multiple_unrelated_markers_still_fail_closed(self):
        self.open_sessions.return_value = set()
        for markers in ({"first", "second"}, {"native-stale", "after-clear"}):
            with self.subTest(markers=markers):
                self.locked_sessions.return_value = markers
                with self.assertRaises(BridgeError) as caught:
                    self.poll()
                self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_database_remains_authoritative_when_available(self):
        self.locked_sessions.return_value = {"stale-marker"}
        self.assertEqual(self.poll()["providerSessionId"], "active-session")
        self.locked_sessions.assert_not_called()

    def test_marker_inspection_rejects_stale_pid_mismatched_content_and_symlinked_directories(self):
        self.lock_patch.stop()
        root = self.home / ".copilot" / "session-state"
        for name, content, modified in [
            ("live", "100\n", 200), ("reused-pid", "100\n", 90),
            ("wrong-pid", "101\n", 200), ("oversized", "100" * 20, 200),
        ]:
            folder = root / name
            folder.mkdir()
            marker = folder / "inuse.100.lock"
            marker.write_text(content)
            os.utime(marker, (modified, modified))
        (root / "linked").symlink_to(root / "live", target_is_directory=True)
        with patch.object(self.bridge.providers["copilot"].processes, "process_start_time", return_value=100):
            self.assertEqual(self.bridge.providers["copilot"].processes.locked_session_ids(100), {"live"})

    def test_marker_inspection_is_bounded_and_checks_owner(self):
        self.lock_patch.stop()
        root = self.home / ".copilot" / "session-state" / "marker-session"
        root.mkdir()
        (root / "inuse.100.lock").write_text("100\n")
        processes = self.bridge.providers["copilot"].processes
        with (
            patch.object(processes, "process_start_time", return_value=0),
            patch("remodr_bridge.providers.copilot.processes.PROCESS_INSPECTION_MAX_FDS", 0),
        ):
            with self.assertRaisesRegex(OSError, "exceeds its limit"):
                processes.locked_session_ids(100)
        with (
            patch.object(processes, "process_start_time", return_value=0),
            patch("remodr_bridge.providers.copilot.processes.os.getuid", return_value=os.getuid() + 1),
        ):
            self.assertEqual(processes.locked_session_ids(100), set())

    def test_macos_marker_start_time_uses_locale_independent_process_metadata(self):
        processes = self.bridge.providers["copilot"].processes
        value = "Tue Sep  8 12:30:07 2026"
        with (
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "darwin"),
            patch.object(processes, "bounded_process_output", return_value=(value + "\n").encode()) as read,
        ):
            self.assertEqual(processes.process_start_time(100), time.mktime(time.strptime(value, "%a %b %d %H:%M:%S %Y")))
        self.assertEqual(read.call_args.args[0], ["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-p", "100", "-o", "lstart="])

    def test_missing_database_cannot_restore_native_identity_after_process_binding(self):
        self.poll()
        self.open_sessions.return_value = set()
        with self.assertRaises(BridgeError) as caught:
            self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
        self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])

    def test_multiple_candidates_fail_closed_even_with_native_id(self):
        for candidates in ({"first", "second"}, {"first", "second", "third"}, {"native-stale", "second"}):
            with self.subTest(candidates=candidates):
                self.open_sessions.return_value = candidates
                with self.assertRaises(BridgeError) as caught:
                    self.poll()
                self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")
                self.assertIsNone(self.bridge.raw_agents[self.agent_id]["providerSessionId"])
                self.assertIsNone(self.bridge.sessions.launched_session("p1"))
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
            self.bridge.providers["copilot"].processes, "foreground_process",
            side_effect=[(100, 50), (200, 50)],
        ):
            with self.assertRaises(BridgeError) as caught:
                self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_metadata_disappearing_after_inspection_is_not_native_fallback(self):
        with patch.object(
            self.bridge.providers["copilot"].processes, "foreground_process",
            side_effect=[(100, 50), OSError("pane disappeared")],
        ):
            with self.assertRaises(BridgeError) as caught:
                self.poll()
        self.assertEqual(caught.exception.code, "SESSION_IDENTITY_UNRESOLVED")

    def test_retune_independently_resolves_the_process_session(self):
        self.bridge.sessions.remember_launch_session("p1", "native-stale")
        with patch.object(self.bridge.providers["copilot"].tuning, "restart_agent") as restart:
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
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "linux"),
            patch.object(self.bridge.providers["copilot"].processes, "linux_process_paths", return_value=paths) as read,
        ):
            self.assertEqual(self.bridge.providers["copilot"].processes.open_session_ids(100), {"valid"})
        read.assert_called_once_with(100)

    def test_macos_lsof_parser_requires_matching_pid_and_owner(self):
        self.inspection.stop()
        database = self.home / ".copilot" / "session-state" / "active-session" / "session.db"
        output = (
            f"p100\0u{os.getuid()}\0\nfcwd\0n{self.home}\0\nf7\0n{database}\0\n"
        ).encode()
        with (
            patch("remodr_bridge.providers.copilot.processes.sys.platform", "darwin"),
            patch("remodr_bridge.providers.copilot.processes.shutil.which", return_value="/usr/sbin/lsof"),
            patch.object(self.bridge.providers["copilot"].processes, "bounded_process_output", return_value=output) as run,
        ):
            self.assertEqual(self.bridge.providers["copilot"].processes.open_session_ids(100), {"active-session"})
        self.assertEqual(run.call_args.args[0][-5:], ["-nP", "-a", "-p", "100", "-F0pun"])
        for invalid in (
            output.replace(b"p100\0", b"p101\0"),
            output.replace(f"u{os.getuid()}\0".encode(), f"u{os.getuid() + 1}\0".encode()),
            b"n/a/session.db\0",
        ):
            with self.subTest(output=invalid):
                with self.assertRaises(OSError):
                    CopilotProcesses.lsof_paths(invalid, 100)

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
            patch("remodr_bridge.providers.copilot.processes.os.scandir", return_value=scan) as scandir,
            patch(
                "remodr_bridge.providers.copilot.processes.os.readlink",
                side_effect=["/home/user/.copilot/session-state/active/session.db", FileNotFoundError()],
            ) as readlink,
        ):
            self.assertEqual(
                CopilotProcesses.linux_process_paths(100),
                ["/home/user/.copilot/session-state/active/session.db"],
            )
        scandir.assert_called_once_with(Path("/proc/100/fd"))
        self.assertEqual(readlink.call_count, 2)

    def test_descriptor_subprocess_has_time_and_output_limits(self):
        with patch("remodr_bridge.providers.copilot.processes.PROCESS_INSPECTION_TIMEOUT", 0.05):
            with self.assertRaisesRegex(OSError, "timed out"):
                CopilotProcesses.bounded_process_output([
                    sys.executable, "-c", "import time; time.sleep(3)"
                ])
        with patch("remodr_bridge.providers.copilot.processes.PROCESS_INSPECTION_MAX_BYTES", 32):
            with self.assertRaisesRegex(OSError, "size limit"):
                CopilotProcesses.bounded_process_output([
                    sys.executable, "-c", "print('x' * 1000)"
                ])

    def test_linux_inspection_rejects_foreign_owners_and_excess_descriptors(self):
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=os.getuid() + 1)):
            with self.assertRaisesRegex(OSError, "another user"):
                CopilotProcesses.linux_process_paths(100)
        scan = MagicMock()
        scan.__enter__.return_value = iter([
            SimpleNamespace(name="7", path="/proc/100/fd/7"),
            SimpleNamespace(name="8", path="/proc/100/fd/8"),
        ])
        with (
            patch.object(Path, "stat", return_value=SimpleNamespace(st_uid=os.getuid())),
            patch("remodr_bridge.providers.copilot.processes.os.scandir", return_value=scan),
            patch("remodr_bridge.providers.copilot.processes.os.readlink", return_value="/some/path"),
            patch("remodr_bridge.providers.copilot.processes.PROCESS_INSPECTION_MAX_FDS", 1),
        ):
            with self.assertRaisesRegex(OSError, "exceeds its limit"):
                CopilotProcesses.linux_process_paths(100)


if __name__ == "__main__":
    unittest.main()
