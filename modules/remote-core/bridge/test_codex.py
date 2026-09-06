import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from remodr_bridge.providers.codex.sessions import status_session

from herdr_mobile_bridge import Bridge, BridgeError, CODEX_STATUS_CONFIG


SESSION = "019a0000-1111-7111-8111-111111111111"
NEXT_SESSION = "019a0000-2222-7222-8222-222222222222"


class CodexTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict("os.environ", {"CODEX_HOME": str(self.home / ".codex")})
        environment.start()
        self.addCleanup(environment.stop)
        self.bridge = Bridge()
        self.footer = SESSION
        self.prompts = []
        self.bridge._herdr_request = self.request
        self.bridge._diagnostic = Mock()
        self.snapshot = {
            "agents": [{
                "agent": "codex", "pane_id": "p1", "terminal_id": "t1",
                "agent_status": "idle", "workspace_id": "w1",
            }],
            "panes": [{"pane_id": "p1"}],
        }
        self.bridge._refresh_runtime = self.refresh
        self.refresh()
        self.agent_id = self.bridge.runtime["agents"][0]["id"]

    def request(self, method, params):
        if method == "agent.read":
            self.assertEqual(params["source"], "visible")
            self.assertEqual(params["target"], "p1")
            return {"read": {"text": f"Earlier output\n\n> Ask Codex\n\n  {self.footer}\n"}}
        if method == "agent.prompt":
            self.prompts.append(params["text"])
        return {}

    def refresh(self):
        self.bridge.runtime = self.bridge._normalize_snapshot(self.snapshot)

    def agent(self):
        return self.bridge.raw_agents[self.agent_id]

    def command(self, session=SESSION):
        return {
            "agentId": self.agent_id, "text": "hello",
            "precondition": {"provider": "codex", "paneId": "p1", "providerSessionId": session},
        }

    def rollout(self, events, session=SESSION, mode="paginated", suffix=""):
        path = self.home / ".codex" / "sessions" / f"rollout-{session}{suffix}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {"type": "session_meta", "payload": {"id": session, "history_mode": mode}}
        path.write_text("\n".join(json.dumps(event) for event in [meta, *events]) + "\n")
        return path

    @staticmethod
    def item(kind, item_id, text, session=SESSION):
        return {
            "type": "event_msg",
            "payload": {
                "type": "item_completed", "thread_id": session,
                "item": {
                    "type": kind, "id": item_id,
                    "content": [{"type": "Text" if kind == "AgentMessage" else "text", "text": text}],
                },
            },
        }

    def test_new_launch_exposes_the_actual_id_without_inventing_a_session(self):
        arguments = ["--model", "gpt-6-astra"]
        self.assertIsNone(Bridge._new_session_arguments("codex", "Example", arguments))
        self.assertEqual(arguments, ["--model", "gpt-6-astra", "-c", CODEX_STATUS_CONFIG])

    def test_creation_waits_for_the_asynchronous_thread_identity(self):
        bridge = Bridge()
        bridge.runtime = {"workspaces": [{"id": "w1"}], "agents": []}
        polls = []
        def start(*_args):
            bridge.runtime["agents"] = [{"paneId": "p1", "providerSessionId": None}]
        def refresh(**_kwargs):
            if bridge.runtime["agents"]:
                polls.append(True)
                if len(polls) == 2:
                    bridge.runtime["agents"][0]["providerSessionId"] = SESSION
        with (
            patch.object(bridge, "_refresh_runtime", side_effect=refresh),
            patch.object(bridge, "_agent_catalog_snapshot", return_value=[{"provider": "codex", "available": True}]),
            patch.object(bridge, "_herdr_request", return_value={"root_pane": {"pane_id": "p1"}}),
            patch.object(bridge, "_start_agent", side_effect=start),
            patch("remodr_bridge.lifecycle.time.sleep"),
        ):
            result = bridge._create_agent({"provider": "codex", "workspaceId": "w1", "bypassPermissions": False})
        self.assertEqual(len(polls), 2)
        self.assertEqual(result["runtime"]["agents"][0]["providerSessionId"], SESSION)

    def test_first_message_is_durable_before_native_hooks_or_a_rollout_exist(self):
        self.assertNotIn("agent_session", self.snapshot["agents"][0])
        self.assertEqual(self.agent()["providerSessionId"], SESSION)
        self.assertFalse((self.home / ".codex" / "sessions").exists())
        command_id = str(uuid.uuid4())
        for _ in range(2):
            response = self.bridge._durable_command(command_id, "agent.send_message", self.command())
            self.assertTrue(response["ok"])
        self.assertEqual(self.prompts, ["hello"])

    def test_only_the_live_footer_can_identify_the_thread(self):
        for footer in ("gpt-6-astra", "Press enter to confirm", f"Session: {SESSION}",
                       "00000000-0000-0000-0000-000000000000", f"{SESSION} \u00b7 {NEXT_SESSION}"):
            with self.subTest(footer=footer):
                self.assertIsNone(status_session(f"{SESSION}\n> Ask Codex\n{footer}"))
        for footer in (SESSION, f"{SESSION} \u00b7 gpt-6-astra low", f"gpt-6-astra \u00b7 {SESSION}"):
            self.assertEqual(status_session(footer), SESSION)

    def test_new_overrides_stale_hook_identity_and_blocks_the_old_outbox_target(self):
        self.snapshot["agents"][0]["agent_session"] = {"kind": "id", "value": SESSION}
        self.footer = NEXT_SESSION
        response = self.bridge._durable_command(str(uuid.uuid4()), "agent.send_message", self.command())
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "COMMAND_PRECONDITION_FAILED")
        self.assertEqual(self.agent()["providerSessionId"], NEXT_SESSION)
        self.assertEqual(self.prompts, [])
        response = self.bridge._durable_command(
            str(uuid.uuid4()), "agent.send_message", self.command(NEXT_SESSION)
        )
        self.assertTrue(response["ok"])
        self.assertEqual(self.prompts, ["hello"])

    def test_hidden_footer_preserves_display_identity_but_cannot_authorize_a_send(self):
        self.footer = "Press enter to review hooks"
        self.refresh()
        self.assertEqual(self.agent()["providerSessionId"], SESSION)
        response = self.bridge._durable_command(str(uuid.uuid4()), "agent.send_message", self.command())
        self.assertEqual(response["error"]["code"], "COMMAND_PRECONDITION_FAILED")
        self.assertEqual(self.prompts, [])
        self.footer = SESSION
        self.refresh()
        self.assertNotIn("p1", self.bridge.session_identity_errors)

    def test_unknown_initial_identity_does_not_fall_back_to_an_arbitrary_log(self):
        self.bridge = Bridge()
        self.bridge._herdr_request = self.request
        self.bridge._diagnostic = Mock()
        self.footer = "gpt-6-astra low"
        self.rollout([])
        self.refresh()
        self.assertIsNone(self.agent()["providerSessionId"])

    def test_paginated_messages_ignore_prompt_context_reasoning_and_duplicate_raw_events(self):
        self.rollout([
            {"type": "response_item", "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "Internal project instructions"}],
            }},
            self.item("UserMessage", "user-1", "hello"),
            self.item("Reasoning", "reasoning-1", "Not a user-facing message"),
            self.item("AgentMessage", "assistant-1", "Hello"),
            self.item("AgentMessage", "assistant-1", "Hello!"),
            self.item("AgentMessage", "other-thread", "Other session", NEXT_SESSION),
            {"type": "response_item", "payload": {
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "Hello!"}],
            }},
        ])
        result = self.bridge.providers["codex"].load_conversation(self.agent())
        self.assertEqual(result["providerSessionId"], SESSION)
        self.assertEqual(result["items"], [
            {"id": "codex:UserMessage:user-1", "kind": "user_message", "text": "hello"},
            {"id": "codex:AgentMessage:assistant-1", "kind": "assistant_message", "markdown": "Hello!"},
        ])
        self.assertIs(self.bridge.providers["codex"].load_conversation(self.agent()), result)

    def test_legacy_messages_have_stable_ids_and_append_without_retyping_history(self):
        path = self.rollout([
            {"type": "event_msg", "payload": {"type": "user_message", "message": "hello"}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "Hi"}},
        ], mode="legacy")
        first = self.bridge.providers["codex"].load_conversation(self.agent())
        with path.open("a") as output:
            output.write(json.dumps({"type": "event_msg", "payload": {
                "type": "agent_message", "message": "More",
            }}) + "\n")
        second = self.bridge.providers["codex"].load_conversation(self.agent())
        self.assertEqual(first["items"], second["items"][:2])
        self.assertEqual(second["items"][2]["markdown"], "More")

    def test_a_filename_match_cannot_override_the_transcripts_actual_identity(self):
        path = self.rollout([])
        path.write_text(json.dumps({"type": "session_meta", "payload": {"id": NEXT_SESSION}}) + "\n")
        with self.assertRaises(BridgeError) as error:
            self.bridge.providers["codex"].load_conversation(self.agent())
        self.assertEqual(error.exception.code, "CONVERSATION_SESSION_MISMATCH")

    def test_sqlite_selects_the_authoritative_rollout_among_multiple_physical_files(self):
        self.rollout([self.item("AgentMessage", "old", "Old")])
        current = self.rollout([self.item("AgentMessage", "current", "Current")], suffix="_physical")
        database = self.home / ".codex" / "state_5.sqlite"
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
            connection.execute("INSERT INTO threads VALUES (?, ?)", (SESSION, str(current)))
        result = self.bridge.providers["codex"].load_conversation(self.agent())
        self.assertEqual(result["items"][0]["markdown"], "Current")

    def test_multiple_unindexed_rollouts_are_not_guessed_by_time_or_filename(self):
        self.rollout([])
        self.rollout([], suffix="_physical")
        with self.assertRaises(BridgeError):
            self.bridge.providers["codex"].load_conversation(self.agent())

    def test_missing_unmaterialized_transcript_is_not_an_error(self):
        self.assertIsNone(self.bridge.providers["codex"].load_conversation(self.agent()))


if __name__ == "__main__":
    unittest.main()
