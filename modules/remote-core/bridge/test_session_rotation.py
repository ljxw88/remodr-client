import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from herdr_mobile_bridge import Bridge, BridgeError


class SessionRotationTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict("os.environ", {"CODEX_HOME": str(self.home / ".codex")})
        environment.start()
        self.addCleanup(environment.stop)
        self.bridge = Bridge()
        self.bridge.agent_catalog = [{"provider": "copilot", "available": True}]
        self.bridge._ensure_pane_subscriptions = Mock()
        self.bridge.write_event = Mock()
        self.bridge.write = Mock()
        self.snapshot = self.make_snapshot("before-clear")
        self.bridge._herdr_request = Mock(side_effect=self.request)
        self.agent_id = self.bridge._stable_agent_id("p1")

    @staticmethod
    def make_snapshot(session_id, provider="copilot", panes=("p1",)):
        return {
            "workspaces": [{"workspace_id": "w1", "label": "Project"}],
            "panes": [{"pane_id": pane} for pane in panes],
            "agents": [
                {
                    "agent": provider,
                    "pane_id": pane,
                    "workspace_id": "w1",
                    "agent_status": "idle",
                    "agent_session": {"value": session_id},
                }
                for pane in panes
            ],
        }

    def request(self, method, params):
        if method == "session.snapshot":
            return {"snapshot": self.snapshot}
        if method == "agent.read":
            return {"read": {"text": "BEFORE CLEAR terminal scrollback", "revision": 1}}
        if method == "agent.get":
            raise BridgeError("agent_not_found", "Agent exited.")
        return {}

    def write_session(self, session_id, text=None, extra=()):
        directory = self.home / ".copilot" / "session-state" / session_id
        directory.mkdir(parents=True, exist_ok=True)
        events = [{
            "type": "session.start",
            "data": {"selectedModel": "gpt-5.4", "reasoningEffort": "low"},
        }]
        if text is not None:
            events.append({
                "id": session_id + ":message",
                "type": "user.message",
                "data": {"content": text},
            })
        events.extend(extra)
        path = directory / "events.jsonl"
        path.write_text("".join(json.dumps(event) + "\n" for event in events))
        return path

    def poll(self, agent_id=None):
        return self.bridge._dispatch(
            "agent.conversation", {"agentId": agent_id or self.agent_id}
        )

    def seed_old_session(self):
        self.write_session("before-clear", "old conversation", [{
            "type": "tool.execution_start",
            "data": {
                "toolName": "ask_user",
                "toolCallId": "old-question",
                "arguments": {"question": "Old question?", "choices": ["Yes", "No"]},
            },
        }])
        self.bridge.sessions.remember_launch_session("p1", "before-clear")
        self.bridge.sessions.set_tuning("p1", {
            "model": "old-model", "effort": "max", "context": "long_context"
        })
        return self.poll()

    def test_poll_follows_rotation_without_a_status_event_and_publishes_once(self):
        old = self.seed_old_session()
        self.assertEqual(old["providerSessionId"], "before-clear")
        self.assertIn("old-question", self.bridge.sessions.question_ids())
        self.write_session("after-clear", "new conversation")
        self.snapshot = self.make_snapshot("after-clear")

        new = self.poll()
        unchanged = self.poll()

        self.assertEqual(new["providerSessionId"], "after-clear")
        self.assertEqual(new["items"][0]["text"], "new conversation")
        self.assertEqual(new, unchanged)
        self.assertEqual(self.bridge.sessions.launched_session("p1"), "after-clear")
        self.assertEqual(self.bridge.sessions.tuning("p1"), {})
        self.assertIsNone(self.bridge.sessions.cached_tuning("before-clear"))
        self.assertFalse(any(
            key.session_id == "before-clear"
            for key in self.bridge.sessions.conversation_keys()
        ))
        self.assertNotIn("old-question", self.bridge.sessions.question_ids())
        self.assertIsNone(self.bridge.sessions.question("old-question"))
        self.assertEqual(
            self.bridge.runtime["agents"][0]["tuning"],
            {"model": "gpt-5.4", "effort": "low", "context": None},
        )
        snapshots = [
            call for call in self.bridge._herdr_request.call_args_list
            if call.args[0] == "session.snapshot"
        ]
        self.assertEqual(len(snapshots), 3)
        self.assertEqual(self.bridge.write_event.call_count, 2)
        self.assertEqual(
            self.bridge.write_event.call_args.args[1]["agents"][0]["providerSessionId"],
            "after-clear",
        )
        self.assertEqual(old["providerSessionId"], "before-clear")

    def test_further_messages_are_read_from_the_new_session(self):
        self.seed_old_session()
        path = self.write_session("after-clear", "new conversation")
        self.snapshot = self.make_snapshot("after-clear")
        first = self.poll()
        with path.open("a") as output:
            output.write(json.dumps({
                "id": "new-reply", "type": "assistant.message",
                "data": {"content": "new session reply"},
            }) + "\n")
        second = self.poll()
        self.assertEqual(second["providerSessionId"], "after-clear")
        self.assertEqual(second["items"][-1]["markdown"], "new session reply")
        self.assertEqual(len(second["items"]), len(first["items"]) + 1)

    def test_child_agent_events_do_not_replace_the_main_conversation_or_tuning(self):
        self.write_session("before-clear", "main request", [
            {"id": "child-user", "agentId": "child", "type": "user.message",
             "data": {"content": "internal delegation prompt"}},
            {"id": "child-reply", "agentId": "child", "type": "assistant.message",
             "data": {"content": "internal agent reply"}},
            {"id": "child-model", "agentId": "child", "type": "session.model_change",
             "data": {"newModel": "child-model", "reasoningEffort": "max"}},
            {"id": "child-question", "agentId": "child", "type": "tool.execution_start",
             "data": {"toolName": "ask_user", "toolCallId": "child-question",
                      "arguments": {"question": "Child question?", "choices": ["Yes"]}}},
            {"id": "main-reply", "type": "assistant.message",
             "data": {"content": "main reply"}},
        ])
        conversation = self.poll()
        self.assertEqual(
            [item["kind"] for item in conversation["items"]],
            ["user_message", "assistant_message"],
        )
        self.assertEqual(conversation["items"][0]["text"], "main request")
        self.assertEqual(conversation["items"][1]["markdown"], "main reply")
        self.assertIsNone(conversation["activeHumanRequest"])
        self.assertNotIn("child-question", self.bridge.sessions.question_ids())
        self.assertEqual(self.bridge.runtime["agents"][0]["tuning"]["model"], "gpt-5.4")

    def test_empty_rotated_semantic_session_does_not_show_old_terminal_text(self):
        self.seed_old_session()
        self.write_session("after-clear")
        self.snapshot = self.make_snapshot("after-clear")
        conversation = self.poll()
        self.assertTrue(conversation["semantic"])
        self.assertEqual(conversation["providerSessionId"], "after-clear")
        self.assertEqual(conversation["items"], [])
        self.assertIsNone(conversation["activeHumanRequest"])
        self.assertFalse(any(
            call.args[0] == "agent.read"
            for call in self.bridge._herdr_request.call_args_list
        ))

    def test_other_empty_semantic_transcripts_keep_their_session_identity(self):
        for provider, directory in (
            ("claude", ".claude/projects/project"),
            ("codex", ".codex/sessions"),
        ):
            with self.subTest(provider=provider):
                folder = self.home / directory
                folder.mkdir(parents=True)
                session_id = str(uuid.uuid4()) if provider == "codex" else "empty-session"
                path = folder / f"{session_id}.jsonl"
                path.write_text(
                    json.dumps({"type": "session_meta", "payload": {"id": session_id}}) + "\n"
                    if provider == "codex" else ""
                )
                self.snapshot = self.make_snapshot(session_id, provider)
                with patch.object(
                    self.bridge.providers["codex"], "resolve_session", return_value=session_id
                ):
                    conversation = self.poll()
                self.assertEqual(conversation["provider"], provider)
                self.assertEqual(conversation["providerSessionId"], session_id)
                self.assertTrue(conversation["semantic"])
                self.assertEqual(conversation["items"], [])

    def test_terminal_fallback_always_carries_explicit_session_identity(self):
        for session in (None, "ses_rotation"):
            with self.subTest(session=session):
                self.snapshot = self.make_snapshot(session, "opencode")
                conversation = self.poll()
                self.assertEqual(conversation["agentId"], self.agent_id)
                self.assertEqual(conversation["provider"], "opencode")
                self.assertIn("providerSessionId", conversation)
                self.assertEqual(conversation["providerSessionId"], session)
                self.assertFalse(conversation["semantic"])

    def test_retune_refreshes_without_polling_and_never_resumes_original_id(self):
        self.write_session("before-clear")
        self.bridge.sessions.remember_launch_session("p1", "before-clear")
        self.bridge._refresh_runtime()
        self.write_session("after-clear")
        self.snapshot = self.make_snapshot("after-clear")
        with patch("remodr_bridge.providers.copilot.tuning.time.sleep"):
            self.bridge._retune_agent({
                "agentId": self.agent_id, "model": "gpt-5.4", "effort": "high"
            })
        start = next(
            call.args[1] for call in self.bridge._herdr_request.call_args_list
            if call.args[0] == "agent.start"
        )
        index = start["args"].index("--session-id")
        self.assertEqual(start["args"][index + 1], "after-clear")
        self.assertNotIn("before-clear", start["args"])
        self.assertEqual(self.bridge.sessions.launched_session("p1"), "after-clear")

    def test_authoritative_id_overrides_launch_id_on_first_detection(self):
        self.bridge.sessions.remember_launch_session("p1", "original-launch")
        self.bridge.sessions.set_tuning("p1", {"model": "original-model"})
        self.write_session("before-clear")
        conversation = self.poll()
        self.assertEqual(conversation["providerSessionId"], "before-clear")
        self.assertEqual(self.bridge.sessions.launched_session("p1"), "before-clear")
        self.assertEqual(self.bridge.sessions.tuning("p1"), {})

    def test_missing_identity_after_detection_does_not_restore_remembered_id(self):
        self.seed_old_session()
        self.snapshot = self.make_snapshot(None)
        self.poll()
        self.assertIsNone(self.bridge.sessions.launched_session("p1"))
        self.assertIsNone(self.poll()["providerSessionId"])
        self.assertNotIn("old-question", self.bridge.sessions.question_ids())

    def test_first_native_identity_does_not_erase_creation_settings(self):
        self.snapshot = self.make_snapshot(None, "claude")
        self.poll()
        tuning = {"model": "sonnet", "effort": "high", "context": None}
        self.bridge.sessions.set_tuning("p1", tuning)
        self.snapshot = self.make_snapshot("first-claude-session", "claude")
        self.poll()
        self.assertEqual(self.bridge.sessions.tuning("p1"), tuning)
        self.assertEqual(self.bridge.runtime["agents"][0]["tuning"], tuning)

    def test_pending_launch_keeps_settings_when_the_reported_id_matches_bootstrap(self):
        self.bridge.raw_agents[self.agent_id] = {
            "id": self.agent_id, "paneId": "p1", "provider": "copilot",
            "providerSessionId": None,
        }
        self.bridge.sessions.remember_launch_session("p1", "before-clear")
        tuning = {"model": "gpt-5.4", "effort": "high", "context": None}
        self.bridge.sessions.set_tuning("p1", tuning)
        self.write_session("before-clear")
        self.poll()
        self.assertEqual(self.bridge.sessions.tuning("p1"), tuning)
        self.assertEqual(self.bridge.runtime["agents"][0]["tuning"], tuning)

    def test_shared_session_cache_cannot_return_another_agent_id(self):
        self.write_session("shared", "shared text")
        self.snapshot = self.make_snapshot("shared", panes=("p1", "p2"))
        other_id = self.bridge._stable_agent_id("p2")
        first = self.poll()
        second = self.poll(other_id)
        cached_first = self.poll()
        self.assertEqual(first["agentId"], self.agent_id)
        self.assertEqual(cached_first["agentId"], self.agent_id)
        self.assertEqual(second["agentId"], other_id)
        self.assertEqual(second["providerSessionId"], "shared")
        self.write_session("after-clear", "only first pane changed")
        self.snapshot["agents"][0]["agent_session"]["value"] = "after-clear"
        self.assertEqual(self.poll()["providerSessionId"], "after-clear")
        self.assertEqual(self.poll(other_id)["providerSessionId"], "shared")
        self.assertEqual(self.poll(other_id)["items"][0]["text"], "shared text")

    def test_snapshot_failure_returns_an_error_instead_of_stale_success(self):
        self.seed_old_session()
        self.bridge._herdr_request.side_effect = BridgeError(
            "HERDR_UNAVAILABLE", "Snapshot unavailable."
        )
        self.bridge._handle_request_line(json.dumps({
            "protocol": 1, "type": "request", "id": "poll",
            "action": "agent.conversation", "payload": {"agentId": self.agent_id},
        }))
        response = self.bridge.write.call_args.args[0]
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "HERDR_UNAVAILABLE")

    def test_transcript_failure_is_not_silently_replaced_with_terminal_output(self):
        self.write_session("before-clear")
        with (
            patch.object(self.bridge.providers["copilot"], "load_conversation", side_effect=OSError("unreadable")),
            patch.object(self.bridge, "_load_fallback") as fallback,
            patch.object(self.bridge, "_diagnostic"),
        ):
            with self.assertRaises(BridgeError) as caught:
                self.poll()
        self.assertEqual(caught.exception.code, "CONVERSATION_UNAVAILABLE")
        fallback.assert_not_called()

    def test_failed_retune_refresh_does_not_mutate_the_old_session(self):
        self.seed_old_session()
        self.bridge._herdr_request.reset_mock()
        self.bridge._herdr_request.side_effect = BridgeError(
            "HERDR_UNAVAILABLE", "Snapshot unavailable."
        )
        with self.assertRaises(BridgeError):
            self.bridge._retune_agent({"agentId": self.agent_id, "effort": "high"})
        self.bridge._herdr_request.assert_called_once_with("session.snapshot", {})

    def test_durable_old_session_command_is_rejected_not_rebound_after_clear(self):
        self.seed_old_session()
        self.write_session("after-clear")
        self.snapshot = self.make_snapshot("after-clear")
        self.bridge._herdr_request.reset_mock()
        payload = {
            "agentId": self.agent_id, "text": "queued before clear",
            "expectedPaneId": "p1", "expectedProviderSessionId": "before-clear",
        }
        command_id = str(uuid.uuid4())
        envelope = {
            "protocol": 1, "type": "request", "id": "attempt",
            "commandId": command_id, "action": "agent.send_message", "payload": payload,
        }
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertEqual(
            self.bridge.write.call_args.args[0]["error"]["code"],
            "COMMAND_PRECONDITION_FAILED",
        )
        self.assertFalse(any(
            call.args[0] == "agent.prompt"
            for call in self.bridge._herdr_request.call_args_list
        ))
        envelope["payload"] = {**payload, "expectedProviderSessionId": "after-clear"}
        self.bridge._handle_request_line(json.dumps(envelope))
        self.assertEqual(
            self.bridge.write.call_args.args[0]["error"]["code"], "COMMAND_ID_CONFLICT"
        )

    def test_subscription_refresh_waits_for_the_bound_transcript_read(self):
        self.write_session("before-clear", "old conversation")
        self.write_session("after-clear", "new conversation")
        entered = threading.Event()
        release = threading.Event()
        refreshing = threading.Event()
        errors = []
        results = []
        load = self.bridge.providers["copilot"].load_conversation

        def paused_load(agent):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test read was not released")
            return load(agent)

        def poll():
            try:
                results.append(self.poll())
            except Exception as error:
                errors.append(error)

        def subscription():
            refreshing.set()
            self.bridge._handle_herdr_event({"data": {"type": "pane_output_changed"}})

        with patch.object(self.bridge.providers["copilot"], "load_conversation", side_effect=paused_load):
            reader = threading.Thread(target=poll)
            updater = threading.Thread(target=subscription)
            reader.start()
            try:
                self.assertTrue(entered.wait(5))
                self.snapshot = self.make_snapshot("after-clear")
                updater.start()
                self.assertTrue(refreshing.wait(5))
                self.assertEqual(
                    self.bridge.raw_agents[self.agent_id]["providerSessionId"],
                    "before-clear",
                )
            finally:
                release.set()
                reader.join(5)
                if updater.ident is not None:
                    updater.join(5)
            self.assertFalse(reader.is_alive())
            self.assertFalse(updater.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results[0]["providerSessionId"], "before-clear")
        self.assertEqual(results[0]["items"][0]["text"], "old conversation")
        self.assertEqual(
            self.bridge.raw_agents[self.agent_id]["providerSessionId"], "after-clear"
        )
        self.assertEqual(self.poll()["providerSessionId"], "after-clear")


if __name__ == "__main__":
    unittest.main()
