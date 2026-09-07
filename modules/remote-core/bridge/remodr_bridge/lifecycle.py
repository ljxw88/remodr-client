"""Workspace/pane lifecycle and provider-neutral launch orchestration."""
from __future__ import annotations

import hashlib
import os
import time
import uuid
from pathlib import Path
from typing import Any, TYPE_CHECKING
from .constants import MAX_AGENT_NAME, SHELL_READY_TIMEOUT
from .providers import SUPPORTED_PROVIDERS
from .errors import BridgeError

if TYPE_CHECKING:
    from .bridge import Bridge

def create_workspace(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    cwd = payload.get("cwd")
    label = payload.get("label")
    if not isinstance(cwd, str) or not cwd.strip():
        raise BridgeError("INVALID_WORKSPACE", "A root folder is required.")
    if label is not None and not isinstance(label, str):
        raise BridgeError("INVALID_WORKSPACE", "Invalid space name.")

    expanded = os.path.expanduser(cwd.strip())
    if not os.path.isabs(expanded):
        expanded = os.path.join(str(Path.home()), expanded)
    normalized_cwd = os.path.normpath(expanded)
    if not os.path.isdir(normalized_cwd):
        raise BridgeError(
            "WORKSPACE_DIRECTORY_NOT_FOUND",
            "The root folder does not exist on this device.",
        )

    params: dict[str, Any] = {
        "focus": False,
        "cwd": normalized_cwd,
    }
    if isinstance(label, str) and label.strip():
        params["label"] = label.strip()
    result = host._herdr_request("workspace.create", params)
    workspace = result.get("workspace")
    workspace_id = (
        workspace.get("workspace_id")
        if isinstance(workspace, dict)
        else result.get("workspace_id")
    )
    if not isinstance(workspace_id, str) or not workspace_id:
        raise BridgeError(
            "INVALID_HERDR_RESPONSE",
            "Created space ID is missing.",
        )
    try:
        host._refresh_runtime()
    except Exception as error:
        host._diagnostic("WORKSPACE_REFRESH", repr(error))
        host._install_created_workspace(
            workspace_id,
            label.strip() if isinstance(label, str) and label.strip() else None,
            normalized_cwd,
        )
    return {
        "workspaceId": workspace_id,
        "runtime": host.runtime,
    }


def install_created_workspace(
    host: Bridge,
    workspace_id: str,
    label: str | None,
    cwd: str,
) -> None:
    with host.refresh_lock:
        with host.state_lock:
            workspaces = host.runtime.get("workspaces", [])
            if any(
                workspace.get("id") == workspace_id
                for workspace in workspaces
                if isinstance(workspace, dict)
            ):
                return
            workspace = {
                "id": workspace_id,
                "deviceId": host.device_id,
                "name": label or Path(cwd).name or "Workspace",
                "cwd": cwd,
                "paneCount": 1,
                "status": "idle",
            }
            host.runtime = {
                **host.runtime,
                "workspaces": [*workspaces, workspace],
                "lastRuntimeEvent": time.time(),
            }


def close_workspace(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    workspace_id = payload.get("workspaceId")
    close_group = payload.get("closeGroup", False)
    if not isinstance(workspace_id, str) or not workspace_id:
        raise BridgeError("INVALID_WORKSPACE", "A space is required.")
    if not isinstance(close_group, bool):
        raise BridgeError("INVALID_WORKSPACE", "Invalid group close setting.")
    host._herdr_request(
        "workspace.close",
        {
            "workspace_id": workspace_id,
            "close_group": close_group,
        },
    )
    try:
        host._refresh_runtime()
    except Exception as error:
        host._diagnostic("WORKSPACE_REFRESH", repr(error))
        host._remove_workspace_from_runtime(workspace_id)
    return {
        "workspaceId": workspace_id,
        "runtime": host.runtime,
    }


def remove_workspace_from_runtime(host: Bridge, workspace_id: str) -> None:
    with host.refresh_lock:
        with host.state_lock:
            removed_agents = [
                agent
                for agent in host.runtime.get("agents", [])
                if isinstance(agent, dict)
                and agent.get("workspaceId") == workspace_id
            ]
            removed_agent_ids = {agent.get("id") for agent in removed_agents}
            host.runtime = {
                **host.runtime,
                "workspaces": [
                    workspace
                    for workspace in host.runtime.get("workspaces", [])
                    if not isinstance(workspace, dict)
                    or workspace.get("id") != workspace_id
                ],
                "agents": [
                    agent
                    for agent in host.runtime.get("agents", [])
                    if not isinstance(agent, dict)
                    or agent.get("workspaceId") != workspace_id
                ],
                "lastRuntimeEvent": time.time(),
            }
            host.raw_agents = {
                agent_id: agent
                for agent_id, agent in host.raw_agents.items()
                if agent_id not in removed_agent_ids
            }
            host.pending_agents = {
                pane_id: agent
                for pane_id, agent in host.pending_agents.items()
                if agent.get("workspaceId") != workspace_id
            }
        for agent in removed_agents:
            agent_id = agent.get("id")
            if isinstance(agent_id, str):
                host.sessions.remove_agent(agent_id)
                host.output_activity.invalidate(agent_id)
            pane_id = agent.get("paneId")
            if isinstance(pane_id, str):
                host.sessions.forget_pane(pane_id)


def create_agent(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    provider = host._provider(payload.get("provider"))
    workspace_id = payload.get("workspaceId")
    bypass_permissions = payload.get("bypassPermissions", True)
    name_input = payload.get("name")
    label = (
        name_input.strip()[:MAX_AGENT_NAME]
        if isinstance(name_input, str) and name_input.strip()
        else ""
    )
    if provider not in SUPPORTED_PROVIDERS:
        raise BridgeError("INVALID_PROVIDER", "Unsupported agent provider.")
    adapter = host.provider_adapter(provider)
    tuning = host._tuning_arguments(provider, payload)
    if not isinstance(workspace_id, str) or not workspace_id:
        raise BridgeError("INVALID_WORKSPACE", "A space is required.")
    if not isinstance(bypass_permissions, bool):
        raise BridgeError("INVALID_REQUEST", "Invalid permission setting.")

    host._refresh_runtime()
    workspace_ids = {
        workspace.get("id")
        for workspace in host.runtime.get("workspaces", [])
        if isinstance(workspace, dict)
    }
    if workspace_id not in workspace_ids:
        raise BridgeError("WORKSPACE_NOT_FOUND", "The selected space no longer exists.")
    catalog = host._agent_catalog_snapshot(force=True)
    available = next(
        (
            item.get("available")
            for item in catalog
            if item.get("provider") == provider
        ),
        False,
    )
    if not available:
        raise BridgeError(
            "PROVIDER_UNAVAILABLE",
            f"{host._provider_label(provider)} is not available on this device.",
        )

    tab_result = host._herdr_request(
        "tab.create",
        {
            "focus": False,
            "workspace_id": workspace_id,
            # The label is what the agent is called in the list. Without
            # one every new agent arrives as "GitHub Copilot", which is
            # unfindable once there is more than one.
            "label": label or provider,
        },
    )
    root_pane = tab_result.get("root_pane")
    pane_id = (
        root_pane.get("pane_id") if isinstance(root_pane, dict) else None
    )
    if not isinstance(pane_id, str) or not pane_id:
        raise BridgeError("INVALID_HERDR_RESPONSE", "New agent pane is missing.")

    name = provider
    args = list(adapter.spec.bypass_arguments) if bypass_permissions else []
    args.extend(tuning)
    try:
        workspace = next(
            (entry for entry in host.runtime.get("workspaces", []) if entry.get("id") == workspace_id),
            {},
        )
        cwd = workspace.get("cwd")
        session_id = adapter.prepare_launch(label, args, cwd if isinstance(cwd, str) else None)
        try:
            host._start_agent(name, provider, pane_id, args)
        except BridgeError as error:
            if error.code.lower() != "agent_name_taken":
                raise
            name = f"{provider}-{uuid.uuid4().hex[:4]}"
            host._start_agent(name, provider, pane_id, args)
        agent_id = host._stable_agent_id(pane_id)
        with host.refresh_lock:
            host.sessions.record_launch(
                pane_id, session_id, host._tuning_of(payload), bypass_permissions,
            )
        for _ in range(20):
            if adapter.spec.wait_for_session:
                host._refresh_runtime(inspect_copilot=False)
            else:
                host._refresh_runtime()
            agent = next(
                (
                    item
                    for item in host.runtime.get("agents", [])
                    if isinstance(item, dict) and item.get("paneId") == pane_id
                ),
                None,
            )
            if agent and (not adapter.spec.wait_for_session or agent.get("providerSessionId")):
                break
            time.sleep(0.1)
        if not agent:
            host._install_pending_agent(
                agent_id,
                name,
                provider,
                workspace_id,
                pane_id,
            )
        return {
            "paneId": pane_id,
            "agentId": agent_id,
            "name": name,
            "runtime": host.runtime,
        }
    except Exception:
        try:
            host._herdr_request("pane.close", {"pane_id": pane_id})
        except Exception as cleanup_error:
            host._diagnostic("AGENT_CLEANUP", repr(cleanup_error))
        raise


def rename_agent(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    """Rename by relabelling the tab the agent sits in.

    Herdr's own agent name is an identifier — lowercase, no spaces, unique
    among live agents — so it cannot hold what someone would actually call
    a piece of work. The tab label has no such rules, and the title shown
    for an agent already prefers it.
    """
    agent = host._require_agent(payload)
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        raise BridgeError("INVALID_NAME", "A name is required.")
    tab_id = agent.get("tabId") or agent.get("tab_id")
    if not isinstance(tab_id, str) or not tab_id:
        raise BridgeError("AGENT_NOT_FOUND", "This agent has no tab to rename.")
    host._herdr_request(
        "tab.rename", {"tab_id": tab_id, "label": name.strip()[:MAX_AGENT_NAME]}
    )
    host._refresh_runtime()
    return {"agentId": agent["id"], "runtime": host.runtime}


def close_agent(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    """Close the agent's pane, which stops the agent with it.

    The pane rather than the tab: an agent started outside this app can be
    sharing a tab with panes nobody asked us to touch.
    """
    agent = host._require_agent(payload)
    agent_id = agent["id"]
    pane_id = agent.get("paneId")
    if not isinstance(pane_id, str) or not pane_id:
        raise BridgeError("AGENT_NOT_FOUND", "This agent has no pane to close.")
    host._herdr_request("pane.close", {"pane_id": pane_id})
    with host.refresh_lock:
        with host.state_lock:
            host.pending_agents.pop(pane_id, None)
        host.sessions.forget_pane(pane_id)
        host.output_activity.invalidate(agent_id)
    try:
        host._refresh_runtime()
    except Exception as error:
        host._diagnostic("AGENT_CLOSE_REFRESH", repr(error))
        host._remove_agent_from_runtime(agent_id)
    return {"agentId": agent_id, "runtime": host.runtime}


def remove_agent_from_runtime(host: Bridge, agent_id: str) -> None:
    with host.refresh_lock:
        with host.state_lock:
            removed = host.raw_agents.get(agent_id)
            host.runtime = {
                **host.runtime,
                "agents": [
                    agent
                    for agent in host.runtime.get("agents", [])
                    if not isinstance(agent, dict) or agent.get("id") != agent_id
                ],
                "lastRuntimeEvent": time.time(),
            }
            host.raw_agents.pop(agent_id, None)
        binding = host.sessions.binding(agent_id)
        pane_id = str(removed.get("paneId") or "") if removed else None
        if pane_id is None and binding is not None:
            pane_id = binding.pane_id
        host.sessions.remove_agent(agent_id)
        if pane_id is not None:
            host.sessions.forget_pane(pane_id)
        host.output_activity.invalidate(agent_id)


def install_pending_agent(
    host: Bridge,
    agent_id: str,
    name: str,
    provider: str,
    workspace_id: str,
    pane_id: str,
) -> None:
    with host.refresh_lock:
        with host.state_lock:
            if any(
                item.get("id") == agent_id
                for item in host.runtime.get("agents", [])
                if isinstance(item, dict)
            ):
                return
            workspace = next(
                (
                    item
                    for item in host.runtime.get("workspaces", [])
                    if isinstance(item, dict) and item.get("id") == workspace_id
                ),
                {},
            )
            pending = {
                "id": agent_id,
                "deviceId": host.device_id,
                "provider": provider,
                "providerSessionId": None,
                "tuning": host._reported_tuning(pane_id, None, provider),
                "herdrSessionId": host.session_name,
                "workspaceId": workspace_id,
                "workspaceName": workspace.get("name", "Workspace"),
                "tabId": None,
                "paneId": pane_id,
                "cwd": workspace.get("cwd"),
                "status": "working",
                "title": name,
                "focused": False,
                "capabilities": host._agent_capabilities(provider, None),
            }
            host.runtime = {
                **host.runtime,
                "agents": [*host.runtime.get("agents", []), pending],
                "lastRuntimeEvent": time.time(),
            }
            host.raw_agents[agent_id] = {
                "pane_id": pane_id,
                "workspace_id": workspace_id,
                **pending,
            }
            host.pending_agents[pane_id] = pending


def stable_agent_id(host: Bridge, pane_id: str) -> str:
    identity = "|".join((host.session_name, host.device_id, pane_id))
    return "agent_" + hashlib.sha256(identity.encode()).hexdigest()[:20]


def start_agent(
    host: Bridge,
    name: str,
    provider: str,
    pane_id: str,
    args: list[str],
) -> None:
    try:
        pinned_terminal_id = host._pane_terminal_id(pane_id)
    except Exception:
        pinned_terminal_id = None
    # A pane this app just made has nothing in it but a shell starting up,
    # so "busy" only ever means "not at its prompt yet" and waiting is
    # always the right answer. Two seconds was not enough for a shell with
    # a real profile behind it — version managers, hooks — and the failure
    # surfaced as a raw herdr message where an agent should have been.
    deadline = time.monotonic() + SHELL_READY_TIMEOUT
    while True:
        try:
            host._herdr_request(
                "agent.start",
                {
                    "name": name,
                    "kind": provider,
                    "pane_id": pane_id,
                    "args": args,
                },
            )
            return
        except BridgeError as error:
            if error.code != "agent_pane_busy":
                raise
            # A replaced terminal means something other than a slow
            # profile is going on, and no amount of waiting fixes it.
            if pinned_terminal_id is None or not host._pane_terminal_unchanged(
                pane_id, pinned_terminal_id
            ):
                raise
            if time.monotonic() >= deadline:
                raise BridgeError(
                    "SHELL_NOT_READY",
                    "The shell for this agent did not finish starting up.",
                ) from error
            time.sleep(0.2)


def pane_terminal_id(host: Bridge, pane_id: str) -> str | None:
    result = host._herdr_request("pane.get", {"pane_id": pane_id})
    pane = result.get("pane")
    terminal_id = pane.get("terminal_id") if isinstance(pane, dict) else None
    return terminal_id if isinstance(terminal_id, str) else None


def pane_terminal_unchanged(host: Bridge, pane_id: str, pinned_terminal_id: str) -> bool:
    """Whether the pane still holds the terminal we started waiting on.

    This is the whole test for whether waiting is worthwhile. Asking the
    process list whether a shell looks like it is still starting up is a
    guess, and it guessed wrong for shells with a real profile behind them
    — version managers, hooks — which then failed instead of waiting.
    """
    try:
        return host._pane_terminal_id(pane_id) == pinned_terminal_id
    except Exception:
        return False
