"""Herdr's installed OpenCode TUI integration is the only session authority."""
from __future__ import annotations

from dataclasses import replace
import threading
import time
from typing import Any

from ...errors import BridgeError
from ...session_registry import SessionKey
from ...storage import host_scope
from ..base import AgentLaunch, ProviderAdapter, ProviderHost
from . import api, native, questions, transcript
from .bootstrap import create_session, delete_session
from .events import EventManager
from .registry import ServerRegistry, generate_credentials
from .settings import SPEC
from .variants import OpenCodeVariants, retune

# How long a verified binding is trusted before the process and server are
# checked again. Capability answers are read far more often than they change,
# and every miss costs a Herdr round trip plus two loopback requests.
BINDING_TTL = 5.0
# How often the durable store is reconciled against live panes. Reconciling on
# every snapshot would open the store for every Herdr event; the pane set
# changing is the interesting moment, and that is never delayed.
RETAIN_INTERVAL = 30.0


class OpenCodeAdapter(ProviderAdapter):
    spec = SPEC

    def __init__(self, host: ProviderHost) -> None:
        super().__init__(host)
        self._binding_lock = threading.Lock()
        self._bindings: dict[str, tuple[float, Any, api.ServerBinding | None]] = {}
        self._binding_workers: set[tuple[str, str]] = set()
        self._retained: tuple[float, frozenset] | None = None
        self.events = EventManager(host)

    def servers(self) -> ServerRegistry:
        return ServerRegistry(host_scope(self.host))

    def variant_options(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenCodeVariants(self.host, payload).options()

    def retune(self, payload: dict[str, Any]) -> dict[str, Any]:
        if "model" not in payload and "variant" not in payload:
            raise BridgeError(
                "INVALID_VARIANT", "Choose an OpenCode variant, or a model for native API mode."
            )
        agent = self.host._require_agent(payload)
        binding = self.require_binding(agent, allow_compatibility=True)
        if binding is not None:
            if payload.get("effort") is not None or payload.get("context") is not None:
                raise BridgeError(
                    "UNSUPPORTED_TUNING",
                    "OpenCode accepts model and variant settings for the next prompt.",
                )
            if "model" not in payload and "variant" not in payload:
                raise BridgeError(
                    "INVALID_MODEL", "Choose an OpenCode model or variant."
                )
            model = payload.get("model")
            if model is not None and not transcript.model_id(model):
                raise BridgeError(
                    "INVALID_MODEL", "OpenCode models must use provider/model format."
                )
            variant = payload.get("variant")
            if variant is not None and (
                not isinstance(variant, str)
                or not variant.strip()
                or len(variant) > 128
            ):
                raise BridgeError("INVALID_VARIANT", "Invalid OpenCode variant.")
            tuning = self.host.sessions.tuning(agent["paneId"])
            if "model" in payload:
                tuning["model"] = model
                tuning["_apiModelSelected"] = True
                if "variant" not in payload:
                    tuning["variant"] = None
            if "variant" in payload:
                tuning["variant"] = variant
            self.host.sessions.set_tuning(agent["paneId"], tuning)
            self.host._refresh_runtime()
            return {"agentId": agent["id"], "runtime": self.host.runtime}
        return retune(self.host, payload)

    def prepare_launch(self, label: str, args: list[str], cwd: str | None) -> AgentLaunch:
        """Generate the managed server's credentials, and nothing durable yet.

        The TUI is given a username and password made for this agent alone, and
        Herdr's ``agent.start`` carries no environment, so they can only reach
        the process through the pane's own environment -- which means they have
        to exist before the pane does. Generating a secret leaves nothing behind
        if the pane is never created; the native session does, so it waits.
        """
        if not cwd:
            raise BridgeError("INVALID_WORKSPACE", "OpenCode needs a known workspace directory before launch.")
        credential = generate_credentials("", cwd, "")
        return AgentLaunch(env=credential.environment(), binding=credential)

    def open_session(
        self, pane_id: str, label: str, args: list[str], launch: AgentLaunch
    ) -> AgentLaunch:
        """Create the empty native session the TUI will resume into."""
        credential = launch.binding
        identifier = create_session(credential.cwd, label)
        args.extend(["--hostname", api.LOOPBACK, "--port", "0", "--session", identifier])
        return replace(
            launch,
            session_id=identifier,
            binding=replace(credential, pane_id=pane_id, session_id=identifier),
        )

    def commit_launch(self, pane_id: str, launch: AgentLaunch) -> None:
        credential = launch.binding
        if credential is None or not launch.session_id:
            return
        self.servers().record(replace(credential, pane_id=pane_id))

    def discard_launch(
        self, pane_id: str | None, launch: AgentLaunch, *, started: bool = False
    ) -> None:
        """Take back everything a failed creation left behind.

        The credential record goes first, because an agent that never started
        must not keep a claim on a pane. The native session is deleted only
        when it is certainly unused: before the TUI ran nothing can have
        written to it, and after the TUI ran the pane has already been closed
        and the session is deleted only if it still holds no messages. A
        conversation is never destroyed to tidy up.
        """
        credential = launch.binding
        if credential is None:
            return
        if pane_id:
            self.forget_pane(pane_id)
        identifier = launch.session_id
        if not identifier:
            return
        if started and transcript.message_count(identifier) != 0:
            self.host._diagnostic(
                "OPENCODE_SESSION_CLEANUP", "kept a session that may hold a conversation"
            )
            return
        try:
            delete_session(credential.cwd, identifier)
        except BridgeError as error:
            self.host._diagnostic("OPENCODE_SESSION_CLEANUP", error.code)

    def forget_pane(self, pane_id: str) -> None:
        self.events.stop_pane(pane_id)
        with self._binding_lock:
            self._bindings.pop(pane_id, None)
        try:
            self.servers().forget(pane_id)
        except BridgeError as error:
            self.host._diagnostic("OPENCODE_SERVER_STORE", error.code)

    def binding(
        self, pane_id: Any, session_id: Any, *, force: bool = False,
    ) -> api.ServerBinding | None:
        """The verified server binding for this pane and session, if there is one.

        A record on its own grants nothing: the process is re-checked, the
        listener is re-discovered from that PID, and the server is asked who it
        is. A failure is cached as "no binding" for a moment so that an agent
        which has gone away cannot turn every snapshot into a round trip, but a
        failure never removes the record, because one refused probe is not
        proof that the agent is gone.
        """
        if not isinstance(pane_id, str) or not pane_id or not transcript.session_id(session_id):
            return None
        now = time.monotonic()
        with self._binding_lock:
            cached = self._bindings.get(pane_id)
            if (
                cached is not None
                and cached[0] > now
                and cached[1] == session_id
            ):
                return cached[2]
        if not force:
            return None
        try:
            credential = self.servers().load(pane_id)
        except BridgeError as error:
            self.host._diagnostic("OPENCODE_SERVER_STORE", error.code)
            credential = None
        binding = api.resolve(self.host, pane_id, session_id, credential)
        with self._binding_lock:
            self._bindings[pane_id] = (now + BINDING_TTL, session_id, binding)
        return binding

    def request_binding(self, pane_id: Any, session_id: Any) -> None:
        if (
            not isinstance(pane_id, str)
            or not pane_id
            or not transcript.session_id(session_id)
        ):
            return
        key = (pane_id, session_id)
        now = time.monotonic()
        with self._binding_lock:
            cached = self._bindings.get(pane_id)
            if (
                cached is not None
                and cached[0] > now
                and cached[1] == session_id
            ):
                return
            if key in self._binding_workers:
                return
            self._binding_workers.add(key)

        def verify() -> None:
            try:
                binding = self.binding(pane_id, session_id, force=True)
                if binding is not None and getattr(self.host, "running", False):
                    self.host._refresh_runtime_and_publish()
            except Exception as error:
                self.host._diagnostic(
                    "OPENCODE_SERVER_VERIFY",
                    getattr(error, "code", type(error).__name__),
                )
            finally:
                with self._binding_lock:
                    self._binding_workers.discard(key)

        threading.Thread(
            target=verify,
            name=f"opencode-binding-{pane_id}",
            daemon=True,
        ).start()

    def invalidate_binding(self, pane_id: str, session_id: Any) -> None:
        with self._binding_lock:
            self._bindings[pane_id] = (
                time.monotonic() + 1.0, session_id, None,
            )

    def require_binding(
        self, agent: dict[str, Any], *, allow_compatibility: bool = False,
    ) -> api.ServerBinding | None:
        binding = self.binding(
            agent.get("paneId"), agent.get("providerSessionId"), force=True,
        )
        if binding is not None:
            return binding
        if allow_compatibility:
            try:
                credential = self.servers().load(str(agent.get("paneId") or ""))
            except BridgeError as error:
                raise BridgeError(
                    "OPENCODE_API_UNAVAILABLE",
                    "The OpenCode server binding could not be checked safely.",
                ) from error
            if credential is None:
                return None
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE",
            "This OpenCode session does not have a verified native connection.",
        )

    def send_message(self, agent: dict[str, Any], text: str) -> None:
        binding = self.require_binding(agent, allow_compatibility=True)
        if binding is None:
            super().send_message(agent, text)
            return
        tuning = self.host.sessions.tuning(agent["paneId"])
        payload = native.prompt_payload(
            text,
            self.host._active_command_id(),
            model=tuning.get("model") if tuning.get("_apiModelSelected") is True else None,
            variant=tuning.get("variant"),
        )
        self.host._provider_mutation(agent)
        status, _ = api.post(
            binding,
            f"/session/{binding.session_id}/prompt_async",
            payload,
            parse=False,
        )
        if status in (400, 401, 404):
            self.host._provider_rejected()
            raise BridgeError(
                "OPENCODE_API_REJECTED", "OpenCode rejected the message."
            )
        if status != 204:
            raise BridgeError(
                "OPENCODE_API_UNAVAILABLE",
                "OpenCode could not confirm the message.",
            )

    def answer_request(
        self, agent: dict[str, Any], request: dict[str, Any], answer: dict[str, Any],
    ) -> bool:
        binding = self.require_binding(agent)
        if binding is None:
            raise BridgeError(
                "OPENCODE_API_UNAVAILABLE",
                "This OpenCode request no longer has a native connection.",
            )
        if request.get("kind") == "permission":
            identifier, payload = native.permission_reply(request, answer)
            path = f"/permission/{identifier}/reply"
            action = "permission"
        else:
            identifier, payload = native.question_reply(request, answer)
            path = f"/question/{identifier}/reply"
            action = "question"
        self.host._provider_mutation(agent)
        status, value = api.post(binding, path, payload)
        if status in (400, 401, 404):
            self.host._provider_rejected()
        native.require_success(status, value, action)
        return True

    def prepare_request(self, agent: dict[str, Any], origin: Any) -> None:
        if origin != "api":
            return
        if self.require_binding(agent) is None:
            raise BridgeError(
                "COMMAND_PRECONDITION_FAILED",
                "The native OpenCode request can no longer be verified.",
            )

    def prepare_conversation(self, agent: dict[str, Any]) -> None:
        self.require_binding(agent, allow_compatibility=True)

    def interrupt(self, agent: dict[str, Any]) -> None:
        binding = self.require_binding(agent, allow_compatibility=True)
        if binding is None:
            super().interrupt(agent)
            return
        status, value = api.post(
            binding, f"/session/{binding.session_id}/abort",
        )
        native.require_success(status, value, "abort")

    def prune_bindings(self, live_panes: set[str]) -> None:
        """Forget cached verifications for panes that are not in this snapshot.

        Deliberately does not touch stored records. One snapshot without a pane
        is not proof that its agent is gone -- that judgement belongs to
        ``prune_launches`` -- and a record that outlives its pane still cannot
        grant anything without passing verification.
        """
        with self._binding_lock:
            self._bindings = {
                pane: value for pane, value in self._bindings.items() if pane in live_panes
            }
        self.events.prune(live_panes)

    def prune_launches(self, live_panes: set[str]) -> None:
        """Reclaim credentials for panes an authoritative snapshot proves gone.

        Panes closed outside this app never reach the close path, so without
        this their credentials would sit in the store until they aged out. A
        store that is busy or unavailable simply keeps them for next time:
        nothing here is worth failing a snapshot over.
        """
        panes = frozenset(live_panes)
        now = time.monotonic()
        with self._binding_lock:
            retained = self._retained
            if retained is not None and retained[0] > now and retained[1] == panes:
                return
            self._retained = (now + RETAIN_INTERVAL, panes)
        try:
            self.servers().retain(set(panes))
        except BridgeError as error:
            self.host._diagnostic("OPENCODE_SERVER_STORE", error.code)

    @staticmethod
    def format_tuning_value(key: str, value: str) -> str:
        if key == "model" and not transcript.model_id(value):
            raise BridgeError("INVALID_MODEL", "OpenCode models must use provider/model format.")
        return value

    def resolve_session(
        self, raw: dict[str, Any], native_session_id: str | None, *, inspect: bool
    ) -> str | None:
        pane_id = str(raw.get("pane_id") or "")
        self.host.sessions.clear_identity(pane_id)
        self.host.sessions.forget_launch_session(pane_id)
        if native_session_id is None:
            return None
        if not transcript.session_id(native_session_id):
            self.host.sessions.record_identity(
                pane_id, error="Herdr reported an invalid OpenCode session identifier.",
                diagnostic=None, process_bound=False,
            )
            return None
        return native_session_id

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        pane_id = agent.get("paneId")
        if session_id is None:
            return None
        binding = self.binding(pane_id, session_id)
        if binding is not None:
            try:
                conversation = native.load_conversation(binding, agent["id"])
            except Exception:
                self.events.stop_pane(str(pane_id or ""))
                self.invalidate_binding(str(pane_id or ""), session_id)
                raise
            self.events.ensure(agent, binding)
            requests = [
                item["request"]
                for item in conversation["items"]
                if item.get("kind") == "human_request"
                and isinstance(item.get("request"), dict)
            ]
            session = self.host.sessions.binding(agent["id"])
            self.host.sessions.replace_questions(
                session.key if session is not None else SessionKey.from_agent(agent),
                requests,
            )
            return conversation
        snapshot = transcript.read_session(session_id)
        if snapshot is None:
            return None
        items = snapshot["items"]
        request = None
        for item in items:
            if item.get("kind") != "human_request":
                continue
            current = item.get("request")
            if not isinstance(current, dict) or not isinstance(current.get("id"), str):
                continue
            current = {
                **current,
                "origin": "sqlite",
                "providerSessionId": session_id,
            }
            item["request"] = current
            if item.get("resolved"):
                self.host.sessions.forget_question(current["id"])
                continue
            request = current
        if request is None:
            request = questions.live_question(self.host, agent)
            if request is not None:
                request = {
                    **request,
                    "origin": "tui",
                    "providerSessionId": session_id,
                }
        if request:
            self.host._remember_human_request(request, agent)
            if not any(item.get("kind") == "human_request" and item.get("request", {}).get("id") == request["id"] for item in items):
                items = [*items, {"id": "human:" + request["id"], "kind": "human_request", "request": request}]
        return {
            "agentId": agent["id"],
            "provider": self.spec.name,
            "providerSessionId": agent["providerSessionId"],
            "semantic": True,
            "items": items,
            "activeHumanRequest": request,
        }

    def has_semantic_session(self, session_id: Any) -> bool:
        if not transcript.session_id(session_id):
            return False
        try:
            return transcript.read_session(session_id) is not None
        except (transcript.TranscriptError, OSError):
            return False

    def provider_capabilities(self, installed: bool) -> dict[str, bool]:
        result = super().provider_capabilities(installed)
        result["structuredConversation"] = transcript.database_supported()
        result["todos"] = transcript.todos_supported()
        return result

    def api_capabilities(self, session_id: Any, pane_id: str | None) -> dict[str, bool]:
        """True only for an agent whose managed server was just verified.

        There is no useful provider-level answer: an installed OpenCode says
        nothing about whether a particular agent was started by this bridge
        with a managed server, and the pane is what decides that. Provider
        capabilities therefore stay false and mean "installed potential"; only
        a verified pane and session turn these on.
        """
        binding = self.binding(pane_id, session_id)
        verified = binding is not None
        if pane_id is not None and not verified:
            self.request_binding(pane_id, session_id)
        return {name: verified for name in super().api_capabilities(session_id, pane_id)}

    def agent_capabilities(
        self, session_id: Any, pane_id: str | None = None
    ) -> dict[str, bool]:
        result = super().agent_capabilities(session_id, pane_id)
        if result.get("apiConversation"):
            result.update({
                "structuredConversation": True,
                "streamingConversation": True,
                "structuredQuestions": True,
                "toolActivity": True,
                "todos": True,
            })
        else:
            result["todos"] = (
                result["structuredConversation"] and transcript.todos_supported()
            )
        return result

    def session_tuning(self, session_id: Any) -> dict[str, Any]:
        model = transcript.session_model(session_id)
        return {"model": model, "effort": None, "context": None} if model else {}
