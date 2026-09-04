import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from herdr_mobile_bridge import BYPASS_ARGUMENTS, Bridge, BridgeError, SUBSCRIPTIONS


class BridgeProtocolTest(unittest.TestCase):
    def test_supported_providers_have_herdrm_compatible_bypass_arguments(self):
        self.assertEqual(
            BYPASS_ARGUMENTS,
            {
                "claude": ["--dangerously-skip-permissions"],
                "codex": ["--dangerously-bypass-approvals-and-sandbox"],
                "copilot": ["--allow-all-tools"],
                "opencode": ["--auto"],
            },
        )

    def test_global_subscriptions_do_not_require_pane_parameters(self):
        self.assertNotIn("pane.agent_status_changed", SUBSCRIPTIONS)
        self.assertNotIn("pane.output_matched", SUBSCRIPTIONS)
        self.assertIn("workspace.created", SUBSCRIPTIONS)
        self.assertIn("pane.closed", SUBSCRIPTIONS)
        self.assertIn("worktree.opened", SUBSCRIPTIONS)

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
        bridge.device_id = "device-1"
        bridge.agent_catalog = [
            {"provider": "copilot", "available": True, "aliases": []}
        ]
        snapshot = {
            "version": "0.8.2",
            "protocol": 20,
            "workspaces": [
                {
                    "workspace_id": "w1",
                    "label": "mobile",
                    "agent_status": "working",
                },
                {
                    "workspace_id": "w2",
                    "label": "empty-space",
                    "agent_status": "idle",
                    "pane_count": 1,
                },
            ],
            "panes": [
                {
                    "pane_id": "p2",
                    "workspace_id": "w2",
                    "foreground_cwd": "/work/empty",
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
        snapshot["agents"][0]["agent_session"] = {"value": "session-2"}
        after_session_detection = bridge._normalize_snapshot(snapshot)

        self.assertEqual(first["agents"][0]["id"], second["agents"][0]["id"])
        self.assertEqual(
            first["agents"][0]["id"],
            after_session_detection["agents"][0]["id"],
        )
        self.assertEqual(first["agents"][0]["provider"], "copilot")
        self.assertEqual(first["agents"][0]["status"], "working")
        self.assertEqual(first["agents"][0]["deviceId"], "device-1")
        self.assertEqual(first["workspaces"][1]["cwd"], "/work/empty")
        self.assertEqual(first["providers"][0]["provider"], "copilot")

    def test_creates_agent_in_selected_space_with_provider_bypass_arguments(self):
        bridge = Bridge()
        agent_id = bridge._stable_agent_id("p2")
        bridge.runtime = {
            "connectionState": "connected",
            "deviceId": "device-1",
            "workspaces": [{"id": "w1", "name": "project", "status": "idle"}],
            "agents": [
                {
                    "id": agent_id,
                    "paneId": "p2",
                }
            ],
            "providers": [
                {"provider": "codex", "available": True, "aliases": []}
            ],
        }
        catalog = [{"provider": "codex", "available": True, "aliases": []}]

        with (
            patch.object(bridge, "_refresh_runtime"),
            patch.object(bridge, "_agent_catalog_snapshot", return_value=catalog),
            patch.object(
                bridge,
                "_herdr_request",
                return_value={"root_pane": {"pane_id": "p2"}},
            ) as request,
            patch.object(bridge, "_start_agent") as start_agent,
        ):
            result = bridge._create_agent(
                {
                    "provider": "codex",
                    "workspaceId": "w1",
                    "bypassPermissions": True,
                }
            )

        request.assert_called_once_with(
            "tab.create",
            {
                "focus": False,
                "workspace_id": "w1",
                "label": "codex",
            },
        )
        start_agent.assert_called_once_with(
            "codex",
            "codex",
            "p2",
            ["--dangerously-bypass-approvals-and-sandbox"],
        )
        self.assertEqual(result["agentId"], agent_id)

    def test_creates_workspace_from_remote_root_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge()
            bridge.runtime = {
                "connectionState": "connected",
                "workspaces": [
                    {"id": "w2", "name": "project", "status": "idle"}
                ],
                "agents": [],
                "providers": [],
            }
            with (
                patch.object(
                    bridge,
                    "_herdr_request",
                    return_value={"workspace": {"workspace_id": "w2"}},
                ) as request,
                patch.object(bridge, "_refresh_runtime"),
            ):
                result = bridge._create_workspace(
                    {"cwd": directory, "label": "Project"}
                )

        request.assert_called_once_with(
            "workspace.create",
            {
                "focus": False,
                "cwd": directory,
                "label": "Project",
            },
        )
        self.assertEqual(result["workspaceId"], "w2")

    def test_rejects_missing_workspace_root_folder(self):
        bridge = Bridge()
        with self.assertRaisesRegex(BridgeError, "does not exist"):
            bridge._create_workspace(
                {"cwd": "/definitely/missing/remote-workspace", "label": ""}
            )

    def test_workspace_creation_survives_post_create_refresh_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge()
            bridge.runtime = {
                "connectionState": "connected",
                "deviceId": "device-1",
                "workspaces": [],
                "agents": [],
                "providers": [],
            }
            with (
                patch.object(
                    bridge,
                    "_herdr_request",
                    return_value={"workspace_id": "w2"},
                ),
                patch.object(
                    bridge,
                    "_refresh_runtime",
                    side_effect=OSError("snapshot unavailable"),
                ),
                patch.object(bridge, "_diagnostic"),
            ):
                result = bridge._create_workspace(
                    {"cwd": directory, "label": "Project"}
                )

        self.assertEqual(result["workspaceId"], "w2")
        self.assertEqual(result["runtime"]["workspaces"][0]["name"], "Project")

    def test_closes_workspace_and_reconciles_runtime(self):
        bridge = Bridge()
        bridge.runtime = {
            "connectionState": "connected",
            "workspaces": [],
            "agents": [],
            "providers": [],
        }
        with (
            patch.object(bridge, "_herdr_request", return_value={}) as request,
            patch.object(bridge, "_refresh_runtime"),
        ):
            result = bridge._close_workspace({"workspaceId": "w2"})

        request.assert_called_once_with(
            "workspace.close",
            {"workspace_id": "w2", "close_group": False},
        )
        self.assertEqual(result["workspaceId"], "w2")

    def test_closes_linked_workspace_group_after_confirmation(self):
        bridge = Bridge()
        bridge.runtime = {
            "connectionState": "connected",
            "workspaces": [],
            "agents": [],
            "providers": [],
        }
        with (
            patch.object(bridge, "_herdr_request", return_value={}) as request,
            patch.object(bridge, "_refresh_runtime"),
        ):
            bridge._close_workspace({"workspaceId": "w2", "closeGroup": True})

        request.assert_called_once_with(
            "workspace.close",
            {"workspace_id": "w2", "close_group": True},
        )

    def test_create_agent_cleans_up_pane_when_post_start_refresh_fails(self):
        bridge = Bridge()
        bridge.runtime = {
            "connectionState": "connected",
            "workspaces": [{"id": "w1", "name": "project", "status": "idle"}],
            "agents": [],
            "providers": [
                {"provider": "copilot", "available": True, "aliases": []}
            ],
        }
        requests = []

        def request(method, params):
            requests.append((method, params))
            if method == "tab.create":
                return {"root_pane": {"pane_id": "p2"}}
            if method == "pane.close":
                return {}
            self.fail(f"Unexpected request: {method}")

        with (
            patch.object(
                bridge,
                "_refresh_runtime",
                side_effect=[None, OSError("snapshot failed")],
            ),
            patch.object(
                bridge,
                "_agent_catalog_snapshot",
                return_value=[
                    {"provider": "copilot", "available": True, "aliases": []}
                ],
            ),
            patch.object(bridge, "_herdr_request", side_effect=request),
            patch.object(bridge, "_start_agent"),
        ):
            with self.assertRaises(OSError):
                bridge._create_agent(
                    {
                        "provider": "copilot",
                        "workspaceId": "w1",
                        "bypassPermissions": True,
                    }
                )

        self.assertIn(("pane.close", {"pane_id": "p2"}), requests)

    def test_manifest_failure_does_not_infer_remote_availability_from_path(self):
        bridge = Bridge()
        with (
            patch.object(
                bridge,
                "_herdr_request",
                side_effect=OSError("catalog unavailable"),
            ),
            patch.object(bridge, "_diagnostic"),
        ):
            catalog = bridge._agent_catalog_snapshot()

        self.assertTrue(all(not item["available"] for item in catalog))
        self.assertTrue(
            all(
                item["unavailableReason"] == "Provider catalog unavailable."
                for item in catalog
            )
        )

    def test_agent_start_retries_only_while_the_same_shell_is_initializing(self):
        bridge = Bridge()
        starts = 0

        def request(method, _params):
            nonlocal starts
            if method == "pane.get":
                return {"pane": {"terminal_id": "terminal-1"}}
            if method == "pane.process_info":
                return {
                    "process_info": {
                        "shell_pid": 42,
                        "foreground_process_group_id": 42,
                        "foreground_processes": [
                            {"pid": 42, "name": "/bin/bash", "argv": ["-bash"]}
                        ],
                    }
                }
            if method == "agent.start":
                starts += 1
                if starts == 1:
                    raise BridgeError("agent_pane_busy", "Pane is busy")
                return {}
            self.fail(f"Unexpected request: {method}")

        with (
            patch.object(bridge, "_herdr_request", side_effect=request),
            patch("herdr_mobile_bridge.time.sleep"),
        ):
            bridge._start_agent("copilot", "copilot", "p2", [])

        self.assertEqual(starts, 2)

    def test_agent_start_preserves_busy_error_if_terminal_identity_changes(self):
        bridge = Bridge()
        terminal_ids = iter(("terminal-1", "terminal-2"))

        def request(method, _params):
            if method == "pane.get":
                return {"pane": {"terminal_id": next(terminal_ids)}}
            if method == "agent.start":
                raise BridgeError("agent_pane_busy", "Pane is busy")
            self.fail(f"Unexpected request: {method}")

        with patch.object(bridge, "_herdr_request", side_effect=request):
            with self.assertRaisesRegex(BridgeError, "Pane is busy"):
                bridge._start_agent("copilot", "copilot", "p2", [])

    def test_shell_initialization_accepts_exact_float_ids_and_argv_shell(self):
        self.assertTrue(
            Bridge._process_info_shows_shell_initialization(
                {
                    "shell_pid": 42.0,
                    "foreground_process_group_id": 42,
                    "foreground_processes": [
                        {"pid": 42.0, "name": "wrapper", "argv": ["-zsh"]}
                    ],
                }
            )
        )

    def test_pending_agent_survives_snapshots_until_its_pane_closes(self):
        bridge = Bridge()
        bridge.agent_catalog = []
        bridge.runtime = {
            "connectionState": "connected",
            "workspaces": [
                {
                    "id": "w1",
                    "name": "project",
                    "cwd": "/work/project",
                    "status": "idle",
                }
            ],
            "agents": [],
            "providers": [],
        }
        agent_id = bridge._stable_agent_id("p2")
        bridge._install_pending_agent(
            agent_id,
            "copilot",
            "copilot",
            "w1",
            "p2",
        )
        snapshot = {
            "workspaces": [{"workspace_id": "w1", "label": "project"}],
            "panes": [{"pane_id": "p2", "workspace_id": "w1"}],
            "agents": [],
        }

        while_pending = bridge._normalize_snapshot(snapshot)
        after_close = bridge._normalize_snapshot(
            {**snapshot, "panes": []}
        )

        self.assertEqual(while_pending["agents"][0]["id"], agent_id)
        self.assertEqual(after_close["agents"], [])

    def test_custom_title_precedes_generated_name_and_tab_label(self):
        bridge = Bridge()
        self.assertEqual(
            bridge._agent_display_title(
                {
                    "name": "codex-a13f",
                    "title": "API migration",
                    "terminal_title_stripped": "Codex",
                },
                "codex",
                "codex",
            ),
            "API migration",
        )
        self.assertEqual(
            bridge._agent_display_title(
                {
                    "name": "copilot-9a7f",
                    "title": "Session Initialization - GitHub Copilot",
                    "terminal_title_stripped": "GitHub Copilot",
                },
                "copilot",
                "copilot",
            ),
            "copilot-9a7f",
        )

    def test_runtime_events_refresh_snapshot_for_external_agent_changes(self):
        bridge = Bridge()
        bridge.runtime = {
            "connectionState": "connected",
            "workspaces": [],
            "agents": [],
            "providers": [],
        }

        with (
            patch.object(bridge, "_refresh_runtime") as refresh,
            patch.object(bridge, "write_event") as write_event,
        ):
            bridge._handle_herdr_event(
                {"event": {"type": "pane.closed"}, "data": {}}
            )

        refresh.assert_called_once_with()
        write_event.assert_called_once_with("runtime.snapshot", bridge.runtime)

    def test_working_agent_fallback_reads_visible_output_without_scrollback(self):
        bridge = Bridge()
        with patch.object(
            bridge,
            "_herdr_request",
            return_value={"read": {"text": "Working", "revision": 2}},
        ) as request:
            bridge._load_fallback(
                {
                    "id": "agent-1",
                    "provider": "copilot",
                    "paneId": "p1",
                    "status": "working",
                }
            )

        request.assert_called_once_with(
            "agent.read",
            {
                "target": "p1",
                "source": "visible",
                "format": "text",
                "strip_ansi": True,
                "lines": 240,
            },
        )

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


class HumanQuestionTest(unittest.TestCase):
    """The two shapes Copilot writes ask_user in, and how a question is answered."""

    def test_reads_the_plain_question_and_choices_shape(self):
        # By far the more common shape in real session logs. Reading only the
        # JSON-Schema shape left most questions invisible to the app.
        bridge = Bridge()
        request = bridge._normalize_copilot_question(
            "call-1",
            {
                "question": "Which decomposition should I create?",
                "choices": ["Three branches (Recommended)", "Four branches"],
            },
        )
        self.assertEqual(request["kind"], "choice")
        self.assertEqual(request["question"], "Which decomposition should I create?")
        self.assertEqual(
            request["options"],
            [
                {
                    "id": "Three branches (Recommended)",
                    "label": "Three branches (Recommended)",
                },
                {"id": "Four branches", "label": "Four branches"},
            ],
        )

    def test_a_plain_question_without_choices_is_a_text_question(self):
        bridge = Bridge()
        request = bridge._normalize_copilot_question("call-1", {"question": "Which host?"})
        self.assertEqual(request["kind"], "text")
        self.assertEqual(request["options"], [])

    def test_reads_the_json_schema_shape(self):
        bridge = Bridge()
        request = bridge._normalize_copilot_question(
            "call-1",
            {
                "message": "Pick a transport.",
                "requestedSchema": {
                    "properties": {
                        "protocol": {
                            "type": "string",
                            "title": "Transport protocol",
                            "oneOf": [
                                {"const": "TCP", "title": "TCP"},
                                {"const": "UDP", "title": "UDP"},
                            ],
                        }
                    }
                },
            },
        )
        self.assertEqual(request["question"], "Transport protocol")
        self.assertEqual(
            [option["label"] for option in request["options"]], ["TCP", "UDP"]
        )

    def test_selecting_an_offered_answer_anchors_before_stepping_to_it(self):
        # The dialog opens on the schema default rather than the top, and both
        # ends clamp, so over-travelling to the first row is what makes the
        # position certain without reading the screen back.
        bridge = Bridge()
        sent = []
        bridge._herdr_request = lambda method, params: sent.append((method, params))
        request = {
            "options": [
                {"id": "debug", "label": "debug"},
                {"id": "info", "label": "info"},
                {"id": "warn", "label": "warn"},
            ]
        }
        bridge._answer_blocked_dialog({"paneId": "p1"}, request, ["warn"], "warn")
        self.assertEqual(
            sent,
            [("agent.send_keys", {"target": "p1", "keys": ["up"] * 5 + ["down"] * 2 + ["enter"]})],
        )

    def test_the_first_answer_needs_no_steps_after_anchoring(self):
        bridge = Bridge()
        sent = []
        bridge._herdr_request = lambda method, params: sent.append((method, params))
        request = {"options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]}
        bridge._answer_blocked_dialog({"paneId": "p1"}, request, ["a"], "A")
        self.assertEqual(sent[0][1]["keys"], ["up"] * 4 + ["enter"])

    def test_a_typed_answer_goes_through_the_freeform_row(self):
        # A synthesised yes/no has no row of its own, and neither does anything
        # the offered answers do not cover.
        bridge = Bridge()
        bridge.dialog_settle_seconds = 0
        sent = []
        bridge._herdr_request = lambda method, params: sent.append((method, params))
        bridge._answer_blocked_dialog({"paneId": "p1"}, {"options": []}, [], "Yes")
        self.assertEqual([method for method, _ in sent], ["agent.send_keys"] * 3)
        self.assertEqual(sent[0][1]["keys"], ["down"] * 2)
        self.assertEqual(sent[1][1]["keys"], ["Y", "e", "s"])
        self.assertEqual(sent[2][1]["keys"], ["enter"])

    def test_a_space_is_sent_by_name_because_herdr_rejects_a_literal_one(self):
        self.assertEqual(
            Bridge._text_keys("a b"),
            ["a", "space", "b"],
        )

    def test_answering_drives_the_dialog_rather_than_prompting_when_blocked(self):
        # Herdr refuses agent.prompt while a question dialog is up, so an
        # answer sent that way never reached the agent at all.
        bridge = Bridge()
        sent = []
        bridge._herdr_request = lambda method, params: sent.append((method, params))
        bridge.raw_agents = {
            "agent-1": {"id": "agent-1", "paneId": "p1", "agent_status": "blocked"}
        }
        bridge.pending_human_requests = {
            "req-1": {"options": [{"id": "TCP", "label": "TCP"}]}
        }
        bridge._answer_human_request(
            {"agentId": "agent-1", "requestId": "req-1", "answer": {"selectedOptionIds": ["TCP"]}}
        )
        self.assertEqual([method for method, _ in sent], ["agent.send_keys"])

    def test_a_late_refusal_still_reaches_the_dialog(self):
        # The cached status can lag the agent by a moment.
        bridge = Bridge()
        sent = []

        def request(method, params):
            sent.append((method, params))
            if method == "agent.prompt":
                raise BridgeError("agent_blocked", "agent is blocked")

        bridge._herdr_request = request
        bridge.dialog_settle_seconds = 0
        bridge.raw_agents = {
            "agent-1": {"id": "agent-1", "paneId": "p1", "agent_status": "idle"}
        }
        bridge.pending_human_requests = {"req-1": {"options": []}}
        bridge._answer_human_request(
            {"agentId": "agent-1", "requestId": "req-1", "answer": {"customText": "hi"}}
        )
        self.assertEqual(
            [method for method, _ in sent],
            ["agent.prompt", "agent.send_keys", "agent.send_keys", "agent.send_keys"],
        )


if __name__ == "__main__":
    unittest.main()
