"""Synthetic tests for coalesced OpenCode SSE invalidations."""
import io
import time
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.providers.opencode import events
from remodr_bridge.providers.opencode.api import ServerBinding
from remodr_bridge.providers.opencode.registry import ServerCredential


def binding():
    credential = ServerCredential(
        pane_id="p1", cwd="/work/project", username="user",
        password="secret", session_id="ses_events",
    )
    return ServerBinding(
        pane_id="p1", pid=42, port=4096, cwd="/work/project",
        session_id="ses_events", version="1.18.30", credential=credential,
    )


class EventStreamTest(unittest.TestCase):
    def test_parses_data_events_and_ignores_sse_metadata(self):
        stop = events.threading.Event()
        stream = io.BytesIO(
            b": keepalive\n"
            b"id: 1\n"
            b"data: {\"type\":\"server.connected\"}\n\n"
            b"event: message\n"
            b"data: {\"type\":\"message.part.updated\",\"properties\":{}}\n\n"
        )
        self.assertEqual(
            [event["type"] for event in events.iter_events(stream, stop)],
            ["server.connected", "message.part.updated"],
        )

    def test_rejects_oversized_or_invalid_events(self):
        stop = events.threading.Event()
        for raw in (
            b"data: " + b"x" * (events.MAX_EVENT_LINE + 1) + b"\n\n",
            b"data: not-json\n\n",
        ):
            with self.subTest(raw=raw[:20]), self.assertRaises(Exception):
                list(events.iter_events(io.BytesIO(raw), stop))

    def test_stream_uses_basic_header_without_proxy_or_query_credentials(self):
        response = Mock()
        response.status = 200
        opener = Mock()
        opener.open.return_value = response
        with patch.object(events, "build_opener", return_value=opener) as build:
            self.assertIs(events.open_stream(binding()), response)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:4096/event")
        self.assertNotIn("secret", request.full_url)
        self.assertEqual(
            request.get_header("Authorization"), "Basic dXNlcjpzZWNyZXQ=",
        )
        self.assertEqual(request.get_header("X-opencode-directory"), "/work/project")
        proxy = next(
            handler for handler in build.call_args.args
            if isinstance(handler, events.ProxyHandler)
        )
        self.assertEqual(proxy.proxies, {})


class EventManagerTest(unittest.TestCase):
    def setUp(self):
        self.host = Mock()
        self.host.running = True
        self.manager = events.EventManager(self.host)
        self.subscription = events._Subscription(
            agent_id="agent-1",
            session_id="ses_events",
            binding=binding(),
            stop=events.threading.Event(),
            thread=Mock(),
        )
        self.manager.subscriptions["p1"] = self.subscription

    def tearDown(self):
        self.manager.stop_pane("p1")

    def test_streaming_updates_are_coalesced_but_questions_are_immediate(self):
        with patch.object(events, "COALESCE_SECONDS", 0.02):
            self.manager._notify("p1", self.subscription, immediate=False)
            self.manager._notify("p1", self.subscription, immediate=False)
            time.sleep(0.05)
        self.host.write_event.assert_called_once_with(
            "conversation.changed",
            {"agentId": "agent-1", "conversationRevision": 1},
        )
        self.manager._notify("p1", self.subscription, immediate=True)
        self.assertEqual(self.host.write_event.call_count, 2)
        self.assertEqual(
            self.host.write_event.call_args.args[1]["conversationRevision"], 2,
        )

    def test_stopping_a_pane_cancels_a_pending_notification(self):
        with patch.object(events, "COALESCE_SECONDS", 0.05):
            self.manager._notify("p1", self.subscription, immediate=False)
            self.manager.stop_pane("p1")
            time.sleep(0.08)
        self.host.write_event.assert_not_called()


if __name__ == "__main__":
    unittest.main()
