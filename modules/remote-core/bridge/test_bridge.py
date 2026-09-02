import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from herdr_mobile_bridge import Bridge, SUBSCRIPTIONS


class BridgeProtocolTest(unittest.TestCase):
    def test_global_subscriptions_do_not_require_pane_parameters(self):
        self.assertNotIn("pane.agent_status_changed", SUBSCRIPTIONS)
        self.assertNotIn("pane.output_matched", SUBSCRIPTIONS)

    def test_pane_subscription_reconnects_after_stream_failure(self):
        bridge = Bridge()
        bridge.raw_agents = {"agent-1": {"paneId": "p1"}}
        bridge.pane_subscriptions.add("p1")
        attempts = 0

        def fail_then_stop(_pane_id):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                bridge.running = False
            raise OSError("stream closed")

        with (
            patch.object(bridge, "_read_pane_subscription", side_effect=fail_then_stop),
            patch.object(bridge, "_wait_for_subscription_retry"),
            patch.object(bridge, "_diagnostic"),
        ):
            bridge._pane_subscription_loop("p1")

        self.assertEqual(attempts, 2)
        self.assertNotIn("p1", bridge.pane_subscriptions)

    def test_global_subscription_resynchronizes_after_reconnect(self):
        bridge = Bridge()
        attempts = []

        def fail_then_stop(resynchronize):
            attempts.append(resynchronize)
            if len(attempts) == 2:
                bridge.running = False
                return
            raise OSError("stream closed")

        with (
            patch.object(bridge, "_read_global_subscription", side_effect=fail_then_stop),
            patch.object(bridge, "_wait_for_subscription_retry"),
            patch.object(bridge, "_diagnostic"),
        ):
            bridge._subscription_loop()

        self.assertEqual(attempts, [False, True])

    def test_internal_system_notifications_are_not_user_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            (session / "events.jsonl").write_text(
                json.dumps(
                    {
                        "id": "system-1",
                        "type": "user.message",
                        "data": {
                            "content": "<system_notification>IDE reconnected</system_notification>"
                        },
                    }
                ),
                encoding="utf-8",
            )
            bridge = Bridge()
            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(
                    {
                        "id": "agent-1",
                        "providerSessionId": "session-1",
                        "paneId": "p1",
                    }
                )
            self.assertEqual(conversation["items"], [])

    def test_invalid_json_returns_protocol_error(self):
        bridge = Bridge()
        messages = []
        bridge.write = messages.append

        bridge._handle_request_line("{not-json")

        self.assertEqual(messages[0]["type"], "response")
        self.assertFalse(messages[0]["ok"])
        self.assertEqual(messages[0]["error"]["code"], "INVALID_JSON")

    def test_snapshot_normalizes_stable_agent_identity(self):
        bridge = Bridge()
        snapshot = {
            "version": "0.8.2",
            "protocol": 20,
            "workspaces": [
                {
                    "workspace_id": "w1",
                    "label": "mobile",
                    "agent_status": "working",
                }
            ],
            "agents": [
                {
                    "agent": "copilot",
                    "agent_session": {"value": "session-1"},
                    "terminal_id": "terminal-1",
                    "workspace_id": "w1",
                    "tab_id": "t1",
                    "pane_id": "p1",
                    "agent_status": "working",
                    "focused": True,
                }
            ],
        }

        first = bridge._normalize_snapshot(snapshot)
        second = bridge._normalize_snapshot(snapshot)

        self.assertEqual(first["agents"][0]["id"], second["agents"][0]["id"])
        self.assertEqual(first["agents"][0]["provider"], "copilot")
        self.assertEqual(first["agents"][0]["status"], "working")

    def test_copilot_adapter_builds_semantic_items_and_question(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            events = [
                {
                    "id": "u1",
                    "type": "user.message",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "data": {"content": "Fix reconnect."},
                },
                {
                    "id": "a1",
                    "type": "assistant.message",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "data": {"messageId": "m1", "content": "I will inspect it."},
                },
                {
                    "id": "t1",
                    "type": "tool.execution_start",
                    "data": {
                        "toolCallId": "tool-1",
                        "toolName": "view",
                        "arguments": {"path": "Connection.kt"},
                    },
                },
                {
                    "id": "q1",
                    "type": "tool.execution_start",
                    "data": {
                        "toolCallId": "question-1",
                        "toolName": "ask_user",
                        "arguments": {
                            "message": "Choose an approach",
                            "requestedSchema": {
                                "properties": {
                                    "approach": {
                                        "type": "string",
                                        "enum": ["flow", "callbacks"],
                                        "enumNames": ["StateFlow", "Callbacks"],
                                    }
                                }
                            },
                        },
                    },
                },
            ]
            (session / "events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events),
                encoding="utf-8",
            )
            bridge = Bridge()
            agent = {
                "id": "agent-1",
                "providerSessionId": "session-1",
                "paneId": "p1",
            }

            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(agent)
                cached_conversation = bridge._load_copilot(agent)

            self.assertIsNotNone(conversation)
            self.assertIs(cached_conversation, conversation)
            kinds = [item["kind"] for item in conversation["items"]]
            self.assertEqual(
                kinds,
                ["user_message", "assistant_message", "tool_activity", "human_request"],
            )
            request = conversation["activeHumanRequest"]
            self.assertEqual(request["options"][0]["label"], "StateFlow")

    def test_copilot_streaming_chunks_are_reconciled_into_one_message(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            events = [
                {
                    "id": "chunk-1",
                    "type": "assistant.message",
                    "data": {
                        "messageId": "message-1",
                        "chunkIndex": 0,
                        "chunkCount": 2,
                        "content": "Stream",
                    },
                },
                {
                    "id": "chunk-2",
                    "type": "assistant.message",
                    "data": {
                        "messageId": "message-1",
                        "chunkIndex": 1,
                        "chunkCount": 2,
                        "content": "ing",
                    },
                },
            ]
            (session / "events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events),
                encoding="utf-8",
            )
            bridge = Bridge()
            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(
                    {
                        "id": "agent-1",
                        "providerSessionId": "session-1",
                        "paneId": "p1",
                    }
                )
            assistant_items = [
                item
                for item in conversation["items"]
                if item["kind"] == "assistant_message"
            ]
            self.assertEqual(len(assistant_items), 1)
            self.assertEqual(assistant_items[0]["markdown"], "Streaming")

    def test_task_complete_summary_is_visible_and_not_counted_as_tool_activity(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            events = [
                {
                    "id": "tool-1",
                    "type": "tool.execution_start",
                    "data": {
                        "toolCallId": "complete-1",
                        "toolName": "task_complete",
                        "arguments": {"summary": "Hello!"},
                    },
                },
                {
                    "id": "complete-event",
                    "type": "session.task_complete",
                    "data": {"success": True, "summary": "Hello!"},
                },
                {
                    "id": "tool-complete",
                    "type": "tool.execution_complete",
                    "data": {"toolCallId": "complete-1", "success": True},
                },
            ]
            (session / "events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events),
                encoding="utf-8",
            )
            bridge = Bridge()
            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(
                    {
                        "id": "agent-1",
                        "providerSessionId": "session-1",
                        "paneId": "p1",
                    }
                )
            self.assertEqual(
                conversation["items"],
                [
                    {
                        "id": "completion:complete-event",
                        "kind": "assistant_message",
                        "markdown": "Hello!",
                        "timestamp": None,
                    }
                ],
            )

    def test_identical_completion_summaries_in_separate_turns_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            events = [
                {
                    "id": "u1",
                    "type": "user.message",
                    "data": {"content": "hi"},
                },
                {
                    "id": "c1",
                    "type": "session.task_complete",
                    "data": {"success": True, "summary": "Hi!"},
                },
                {
                    "id": "u2",
                    "type": "user.message",
                    "data": {"content": "hi"},
                },
                {
                    "id": "c2",
                    "type": "session.task_complete",
                    "data": {"success": True, "summary": "Hi!"},
                },
            ]
            (session / "events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events),
                encoding="utf-8",
            )
            bridge = Bridge()
            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(
                    {
                        "id": "agent-1",
                        "providerSessionId": "session-1",
                        "paneId": "p1",
                    }
                )
            self.assertEqual(
                [
                    item["markdown"]
                    for item in conversation["items"]
                    if item["kind"] == "assistant_message"
                ],
                ["Hi!", "Hi!"],
            )

    def test_completion_summary_duplicates_only_adjacent_assistant_message(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            session = home / ".copilot" / "session-state" / "session-1"
            session.mkdir(parents=True)
            events = [
                {
                    "id": "a1",
                    "type": "assistant.message",
                    "data": {"messageId": "m1", "content": "Done."},
                },
                {
                    "id": "c1",
                    "type": "session.task_complete",
                    "data": {"success": True, "summary": "Done."},
                },
            ]
            (session / "events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events),
                encoding="utf-8",
            )
            bridge = Bridge()
            with patch.object(Path, "home", return_value=home):
                conversation = bridge._load_copilot(
                    {
                        "id": "agent-1",
                        "providerSessionId": "session-1",
                        "paneId": "p1",
                    }
                )
            self.assertEqual(
                [
                    item
                    for item in conversation["items"]
                    if item["kind"] == "assistant_message"
                ],
                [
                    {
                        "id": "m1",
                        "kind": "assistant_message",
                        "markdown": "Done.",
                        "timestamp": None,
                    }
                ],
            )


if __name__ == "__main__":
    unittest.main()
