"""Synthetic tests for OpenCode's authenticated API snapshot projection."""
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import native
from remodr_bridge.providers.opencode.api import ServerBinding
from remodr_bridge.providers.opencode.registry import ServerCredential


SESSION = "ses_native"


def binding():
    credential = ServerCredential(
        pane_id="p1", cwd="/work/native", username="user",
        password="secret", session_id=SESSION,
    )
    return ServerBinding(
        pane_id="p1", pid=42, port=4096, cwd="/work/native",
        session_id=SESSION, version="1.18.30", credential=credential,
    )


class OpenCodeNativeProjectionTest(unittest.TestCase):
    def test_projects_exact_session_messages_tools_and_todos(self):
        messages = [
            {
                "info": {
                    "id": "msg_user", "sessionID": SESSION, "role": "user",
                    "time": {"created": 10},
                },
                "parts": [
                    {
                        "id": "prt_user", "sessionID": SESSION,
                        "messageID": "msg_user", "type": "text", "text": "Hello",
                    },
                    {
                        "id": "prt_hidden", "sessionID": SESSION,
                        "messageID": "msg_user", "type": "text",
                        "text": "hidden", "synthetic": True,
                    },
                ],
            },
            {
                "info": {
                    "id": "msg_assistant", "sessionID": SESSION,
                    "role": "assistant", "time": {"created": 11},
                },
                "parts": [
                    {
                        "id": "prt_text", "sessionID": SESSION,
                        "messageID": "msg_assistant", "type": "text",
                        "text": "Working on it.",
                    },
                    {
                        "id": "prt_tool", "sessionID": SESSION,
                        "messageID": "msg_assistant", "type": "tool",
                        "tool": "read",
                        "state": {
                            "status": "completed",
                            "title": "Read file",
                            "input": {"path": "README.md"},
                        },
                    },
                ],
            },
        ]
        self.assertEqual(native.project_messages(SESSION, messages), [
            {
                "id": f"opencode:{SESSION}:msg_user:prt_user",
                "kind": "user_message", "text": "Hello", "timestamp": 10,
            },
            {
                "id": f"opencode:{SESSION}:msg_assistant:prt_text",
                "kind": "assistant_message", "markdown": "Working on it.",
                "timestamp": 11,
            },
            {
                "id": f"opencode:{SESSION}:msg_assistant:prt_tool",
                "kind": "tool_activity", "tool": "read", "title": "Read file",
                "detail": "README.md", "state": "completed", "timestamp": 11,
            },
        ])
        self.assertEqual(native.project_todos(SESSION, [
            {"content": "Inspect", "status": "completed", "priority": "high"},
            {"content": "Implement", "status": "in_progress", "priority": "medium"},
        ]), {
            "id": f"opencode:{SESSION}:todos",
            "kind": "todo_update",
            "todos": [
                {"id": f"opencode:{SESSION}:todo:0", "text": "Inspect", "state": "done"},
                {"id": f"opencode:{SESSION}:todo:1", "text": "Implement", "state": "in_progress"},
            ],
        })

    def test_projects_ordered_multi_question_details(self):
        request = native.project_question(SESSION, {
            "id": "que_native",
            "sessionID": SESSION,
            "questions": [
                {
                    "header": "Database",
                    "question": "Which database?",
                    "options": [
                        {"label": "PostgreSQL", "description": "Hosted database"},
                    ],
                    "multiple": False,
                    "custom": False,
                },
                {
                    "header": "Regions",
                    "question": "Which regions?",
                    "options": [
                        {"label": "Europe", "description": "EU deployment"},
                        {"label": "US", "description": "US deployment"},
                    ],
                    "multiple": True,
                    "custom": True,
                },
            ],
        })
        self.assertEqual(request["origin"], "api")
        self.assertEqual(request["providerSessionId"], SESSION)
        self.assertEqual(request["question"], "Which database?")
        self.assertFalse(request["allowCustomAnswer"])
        self.assertEqual(
            [question["question"] for question in request["questions"]],
            ["Which database?", "Which regions?"],
        )
        self.assertTrue(request["questions"][1]["multiSelect"])

    def test_projects_permission_without_forwarding_metadata(self):
        request = native.project_permission(SESSION, {
            "id": "per_native",
            "sessionID": SESSION,
            "permission": "bash",
            "patterns": ["git status"],
            "always": ["git *"],
            "metadata": {"secret": "must not cross"},
        })
        self.assertEqual(request, {
            "id": "per_native",
            "kind": "permission",
            "question": "Allow OpenCode to use bash?",
            "options": [],
            "allowCustomAnswer": False,
            "multiSelect": False,
            "origin": "api",
            "providerSessionId": SESSION,
            "permission": {
                "permission": "bash",
                "patterns": ["git status"],
                "always": ["git *"],
            },
        })

    def test_filters_requests_to_the_exact_session_and_prioritizes_permission(self):
        requests = native.project_requests(
            SESSION,
            [
                {
                    "id": "que_native", "sessionID": SESSION,
                    "questions": [{
                        "header": "Choice", "question": "Continue?",
                        "options": [], "custom": True,
                    }],
                },
                {
                    "id": "que_other", "sessionID": "ses_other",
                    "questions": [{
                        "header": "Other", "question": "Wrong session?",
                        "options": [],
                    }],
                },
            ],
            [
                {
                    "id": "per_native", "sessionID": SESSION,
                    "permission": "bash", "patterns": ["pwd"], "always": [],
                },
            ],
        )
        self.assertEqual([request["id"] for request in requests], [
            "per_native", "que_native",
        ])

    def test_rejects_cross_session_messages_and_parts(self):
        base = {
            "info": {
                "id": "msg_user", "sessionID": SESSION,
                "role": "user", "time": {"created": 1},
            },
            "parts": [{
                "id": "prt_user", "sessionID": SESSION,
                "messageID": "msg_user", "type": "text", "text": "Hello",
            }],
        }
        for changed in (
            {**base, "info": {**base["info"], "sessionID": "ses_other"}},
            {**base, "parts": [{**base["parts"][0], "sessionID": "ses_other"}]},
            {**base, "parts": [{**base["parts"][0], "messageID": "msg_other"}]},
        ):
            with self.subTest(changed=changed), self.assertRaises(native.NativeSnapshotError):
                native.project_messages(SESSION, [changed])

    def test_loads_all_native_snapshots_without_tui_calls(self):
        responses = {
            f"/session/{SESSION}/message?limit=200": [],
            f"/session/{SESSION}/todo": [],
            "/question": [{
                "id": "que_native", "sessionID": SESSION,
                "questions": [{
                    "header": "Choice", "question": "Continue?",
                    "options": [{"label": "Yes", "description": "Proceed"}],
                }],
            }],
            "/permission": [],
        }

        def get(_port, path, _credential, _cwd, **_options):
            return 200, responses[path]

        with patch.object(native.api, "get", side_effect=get) as request:
            conversation = native.load_conversation(binding(), "agent-1")
        self.assertEqual(request.call_count, 4)
        self.assertEqual(conversation["providerSessionId"], SESSION)
        self.assertEqual(conversation["activeHumanRequest"]["id"], "que_native")
        self.assertEqual(conversation["items"][-1]["kind"], "human_request")

    def test_auth_and_session_failures_are_typed(self):
        for status, code in (
            (401, "OPENCODE_API_AUTH_FAILED"),
            (404, "OPENCODE_API_SESSION_CHANGED"),
            (500, "OPENCODE_API_UNAVAILABLE"),
        ):
            with (
                self.subTest(status=status),
                patch.object(native.api, "get", return_value=(status, None)),
                self.assertRaises(BridgeError) as caught,
            ):
                native.load_conversation(binding(), "agent-1")
            self.assertEqual(caught.exception.code, code)


class OpenCodeNativeCommandTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge()
        self.agent = {
            "id": "agent-1",
            "provider": "opencode",
            "providerSessionId": SESSION,
            "paneId": "p1",
        }
        self.bridge.raw_agents = {"agent-1": self.agent}
        self.bridge._herdr_request = Mock()
        self.adapter = self.bridge.providers["opencode"]
        self.adapter.binding = Mock(return_value=binding())
        self.adapter.require_binding = Mock(return_value=binding())

    def test_message_and_abort_use_the_exact_native_session(self):
        with patch.object(native.api, "post", side_effect=[
            (204, None), (200, True),
        ]) as post:
            self.assertEqual(
                self.bridge._dispatch(
                    "agent.send_message", {"agentId": "agent-1", "text": "Hello"},
                ),
                {"accepted": True},
            )
            self.assertEqual(
                self.bridge._dispatch("agent.interrupt", {"agentId": "agent-1"}),
                {"accepted": True},
            )
        self.assertEqual(
            [item.args[1] for item in post.call_args_list],
            [
                f"/session/{SESSION}/prompt_async",
                f"/session/{SESSION}/abort",
            ],
        )
        self.assertEqual(
            post.call_args_list[0].args[2],
            {"parts": [{"type": "text", "text": "Hello"}]},
        )
        self.bridge._herdr_request.assert_not_called()

    def test_model_selection_is_applied_to_future_mobile_prompts(self):
        self.bridge.runtime = {"agents": [], "workspaces": []}
        self.bridge._refresh_runtime = Mock()
        result = self.adapter.retune({
            "agentId": "agent-1",
            "providerSessionId": SESSION,
            "model": "openai/gpt-5.4",
        })
        self.assertEqual(result["agentId"], "agent-1")
        self.assertEqual(
            self.bridge.sessions.tuning("p1"),
            {
                "model": "openai/gpt-5.4",
                "variant": None,
                "_apiModelSelected": True,
            },
        )
        with patch.object(native.api, "post", return_value=(204, None)) as post:
            self.adapter.send_message(self.agent, "Use the selected model")
        self.assertEqual(post.call_args.args[2], {
            "parts": [{"type": "text", "text": "Use the selected model"}],
            "model": {"providerID": "openai", "modelID": "gpt-5.4"},
        })

    def test_native_question_and_permission_answers_keep_native_ids(self):
        question = {
            "id": "que_native",
            "kind": "choice",
            "origin": "api",
            "questions": [{
                "question": "Which database?",
                "options": [
                    {"id": "pg", "label": "PostgreSQL"},
                    {"id": "sqlite", "label": "SQLite"},
                ],
                "allowCustomAnswer": False,
                "multiSelect": False,
            }],
        }
        permission = {
            "id": "per_native",
            "kind": "permission",
            "origin": "api",
            "permission": {
                "permission": "bash", "patterns": ["git status"], "always": [],
            },
        }
        with patch.object(native.api, "post", return_value=(200, True)) as post:
            for request, answer, expected_path, expected_payload in (
                (
                    question,
                    {"requestOrigin": "api", "selectedOptionIds": ["pg"]},
                    "/question/que_native/reply",
                    {"answers": [["PostgreSQL"]]},
                ),
                (
                    permission,
                    {"requestOrigin": "api", "permissionReply": "once"},
                    "/permission/per_native/reply",
                    {"reply": "once"},
                ),
            ):
                with self.subTest(request=request["id"]):
                    self.bridge._remember_human_request(request, self.agent)
                    self.assertEqual(
                        self.bridge._answer_human_request({
                            "agentId": "agent-1",
                            "requestId": request["id"],
                            "answer": answer,
                        }),
                        {"accepted": True},
                    )
                    self.assertEqual(post.call_args.args[1:], (
                        expected_path, expected_payload,
                    ))
        self.bridge._herdr_request.assert_not_called()

    def test_mutation_timeout_is_marked_uncertain_before_the_http_write(self):
        self.bridge.command_context.active = True
        self.bridge.command_context.agent = self.agent
        self.bridge.command_context.side_effect = False
        self.bridge.command_context.command_id = (
            "11111111-1111-4111-8111-111111111111"
        )
        with (
            patch.object(
                native.api, "post",
                side_effect=BridgeError(
                    "OPENCODE_API_UNAVAILABLE", "synthetic timeout",
                ),
            ),
            self.assertRaises(BridgeError),
        ):
            self.adapter.send_message(self.agent, "Hello")
        self.assertTrue(self.bridge.command_context.side_effect)

    def test_definite_native_rejection_clears_the_uncertain_marker(self):
        self.bridge.command_context.active = True
        self.bridge.command_context.agent = self.agent
        self.bridge.command_context.side_effect = False
        with (
            patch.object(native.api, "post", return_value=(401, None)),
            self.assertRaises(BridgeError) as caught,
        ):
            self.adapter.send_message(self.agent, "Hello")
        self.assertEqual(caught.exception.code, "OPENCODE_API_REJECTED")
        self.assertFalse(self.bridge.command_context.side_effect)

    def test_multi_question_answers_preserve_question_and_selection_order(self):
        identifier, payload = native.question_reply({
            "id": "que_native",
            "questions": [
                {
                    "question": "Database?",
                    "options": [{"id": "pg", "label": "PostgreSQL"}],
                    "allowCustomAnswer": False,
                    "multiSelect": False,
                },
                {
                    "question": "Regions?",
                    "options": [
                        {"id": "eu", "label": "Europe"},
                        {"id": "us", "label": "United States"},
                    ],
                    "allowCustomAnswer": True,
                    "multiSelect": True,
                },
            ],
        }, {
            "answers": [
                {"selectedOptionIds": ["pg"]},
                {
                    "selectedOptionIds": ["us", "eu"],
                    "customText": "Asia Pacific",
                },
            ],
        })
        self.assertEqual(identifier, "que_native")
        self.assertEqual(payload, {
            "answers": [
                ["PostgreSQL"],
                ["United States", "Europe", "Asia Pacific"],
            ],
        })


if __name__ == "__main__":
    unittest.main()
