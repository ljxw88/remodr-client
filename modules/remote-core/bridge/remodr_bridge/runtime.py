"""Normalize Herdr snapshots and reconcile session-scoped runtime state."""
from __future__ import annotations

import time
from typing import Any, TYPE_CHECKING
from .providers import SUPPORTED_PROVIDERS, provider_label
from .session_registry import SessionBinding, SessionKey

if TYPE_CHECKING:
    from .bridge import Bridge

def normalize_snapshot(
    host: Bridge, snapshot: dict[str, Any], *, inspect_copilot: bool = True, include_activity: bool = False
) -> dict[str, Any]:
    catalog = host.agent_catalog or host._fallback_agent_catalog()
    workspace_labels = {
        item.get("workspace_id"): item.get("label") or "Workspace"
        for item in snapshot.get("workspaces", [])
        if isinstance(item, dict)
    }
    tab_labels = {
        item.get("tab_id"): item.get("label")
        for item in snapshot.get("tabs", [])
        if isinstance(item, dict) and isinstance(item.get("label"), str)
    }
    workspace_cwds: dict[Any, str] = {}
    panes = snapshot.get("panes")
    agents = snapshot.get("agents")
    for raw in [
        *(panes if isinstance(panes, list) else []),
        *(agents if isinstance(agents, list) else []),
    ]:
        if not isinstance(raw, dict):
            continue
        workspace_id = raw.get("workspace_id")
        cwd = raw.get("foreground_cwd") or raw.get("cwd")
        if workspace_id is not None and isinstance(cwd, str) and cwd:
            workspace_cwds.setdefault(workspace_id, cwd)
    normalized_agents: list[dict[str, Any]] = []
    raw_agents: dict[str, dict[str, Any]] = {}
    for raw in snapshot.get("agents", []):
        if not isinstance(raw, dict):
            continue
        provider = host._provider(raw.get("agent"))
        session = raw.get("agent_session")
        pane_id = str(raw.get("pane_id") or "")
        provider_session_id = (
            session.get("value") if isinstance(session, dict) else None
        )
        if not isinstance(provider_session_id, str) or not provider_session_id:
            provider_session_id = None
        adapter = host.provider_adapter(provider)
        reported_session_id = adapter.resolve_session(
            raw, provider_session_id, inspect=inspect_copilot
        )
        provider_session_id = adapter.session_hint(pane_id, reported_session_id)
        agent_id = host._stable_agent_id(pane_id)
        binding = SessionBinding(SessionKey(agent_id, provider, provider_session_id), pane_id)
        if host.sessions.bind(binding, reported=bool(reported_session_id)):
            host.output_activity.invalidate(agent_id)
        adapter.remember_session(pane_id, reported_session_id)
        workspace_id = str(raw.get("workspace_id") or "")
        capabilities = host._agent_capabilities(provider, provider_session_id, pane_id)
        agent = {
            "id": agent_id,
            "deviceId": host.device_id,
            "provider": provider,
            "providerSessionId": provider_session_id,
            "tuning": host._reported_tuning(pane_id, provider_session_id, provider),
            "herdrSessionId": host.session_name,
            "workspaceId": workspace_id,
            "workspaceName": workspace_labels.get(workspace_id, "Workspace"),
            "tabId": raw.get("tab_id"),
            "paneId": raw.get("pane_id"),
            "cwd": raw.get("foreground_cwd") or raw.get("cwd"),
            "status": host._status(raw.get("agent_status")),
            "title": host._agent_display_title(
                raw,
                provider,
                tab_labels.get(raw.get("tab_id")),
            ),
            "focused": bool(raw.get("focused")),
            "capabilities": capabilities,
        }
        status_revision = raw.get("state_change_seq")
        if type(status_revision) is int and 0 <= status_revision <= 9_007_199_254_740_991:
            agent["statusRevision"] = status_revision
        last_output = (
            host.output_activity.observe(agent, raw.get("terminal_id"), adapter)
            if include_activity
            else host.output_activity.cached(agent, raw.get("terminal_id"))
        )
        if last_output is not None:
            agent["lastOutputAt"] = last_output
        normalized_agents.append(agent)
        raw_agents[agent_id] = {**raw, **agent}

    detected_pane_ids = {
        str(agent.get("paneId"))
        for agent in normalized_agents
        if agent.get("paneId")
    }
    live_pane_ids = {
        str(pane.get("pane_id"))
        for pane in (panes if isinstance(panes, list) else [])
        if isinstance(pane, dict) and pane.get("pane_id")
    }
    # Sessions are keyed by id rather than pane, so they need pruning
    # against the panes still holding them or the cache grows for as long
    # as the bridge runs.
    live_sessions = {
        str(agent.get("providerSessionId"))
        for agent in normalized_agents
        if agent.get("providerSessionId")
    }
    for pane_id, pending in list(host.pending_agents.items()):
        if pane_id in detected_pane_ids or pane_id not in live_pane_ids:
            host.pending_agents.pop(pane_id, None)
            continue
        normalized_agents.append(pending)
        raw_agents[pending["id"]] = {
            "pane_id": pane_id,
            "workspace_id": pending["workspaceId"],
            **pending,
        }

    host.sessions.prune(live_pane_ids, live_sessions, set(raw_agents))
    # A snapshot that reported no pane list at all says nothing about which
    # panes exist, so it is never treated as proof that an agent has gone.
    panes_reported = isinstance(panes, list) and bool(live_pane_ids)
    for adapter in host.providers.values():
        # A pruned or replaced pane must not keep a cached verification alive;
        # the stored record stays, and stays unusable without re-verification.
        adapter.prune_bindings(live_pane_ids)
        if panes_reported:
            adapter.prune_launches(live_pane_ids)
    host.output_activity.prune(set(raw_agents))
    with host.state_lock:
        host.raw_agents = raw_agents
    return {
        "connectionState": "connected",
        "deviceId": host.device_id,
        "herdrVersion": snapshot.get("version", "unknown"),
        "herdrProtocol": snapshot.get("protocol"),
        "herdrSession": host.session_name,
        "socketPath": host.herdr_socket,
        "workspaces": [
            {
                "id": str(item.get("workspace_id") or ""),
                "deviceId": host.device_id,
                "name": item.get("label") or "Workspace",
                "cwd": workspace_cwds.get(item.get("workspace_id")),
                "paneCount": item.get("pane_count")
                if isinstance(item.get("pane_count"), int)
                else 0,
                "status": host._status(item.get("agent_status")),
            }
            for item in snapshot.get("workspaces", [])
            if isinstance(item, dict)
        ],
        "agents": normalized_agents,
        "providers": catalog,
        "lastRuntimeEvent": time.time(),
    }


def agent_catalog_snapshot(host: Bridge, force: bool = False) -> list[dict[str, Any]]:
    if host.agent_catalog is not None and not force:
        return host.agent_catalog
    aliases_by_provider: dict[str, list[str]] = {}
    advertised: set[str] = set()
    manifests_loaded = False
    catalog_error: str | None = None
    try:
        result = host._herdr_request("server.agent_manifests", {})
        manifests = result.get("manifests")
        if isinstance(manifests, list):
            manifests_loaded = True
            for manifest in manifests:
                if not isinstance(manifest, dict):
                    continue
                provider = host._provider(manifest.get("agent"))
                if provider not in SUPPORTED_PROVIDERS:
                    continue
                advertised.add(provider)
                aliases = manifest.get("aliases")
                aliases_by_provider[provider] = (
                    [str(alias) for alias in aliases]
                    if isinstance(aliases, list)
                    else []
                )
    except Exception as error:
        catalog_error = "Provider catalog unavailable."
        host._diagnostic("HERDR_MANIFESTS", repr(error))

    host.agent_catalog = [
        {
            "provider": provider,
            "available": manifests_loaded and provider in advertised,
            "aliases": aliases_by_provider.get(provider, []),
            "unavailableReason": (
                None
                if manifests_loaded and provider in advertised
                else catalog_error or "Not advertised by Herdr."
            ),
        }
        for provider in SUPPORTED_PROVIDERS
    ]
    return host.agent_catalog


def fallback_agent_catalog() -> list[dict[str, Any]]:
    return [
        {
            "provider": provider,
            "available": False,
            "aliases": [],
            "unavailableReason": "Provider catalog unavailable.",
        }
        for provider in SUPPORTED_PROVIDERS
    ]


def agent_display_title(
    host: Bridge,
    raw: dict[str, Any],
    provider: str,
    tab_label: Any,
) -> str:
    custom_title = raw.get("title")
    if (
        isinstance(custom_title, str)
        and custom_title.strip()
        and not host._is_generic_agent_title(custom_title, provider)
    ):
        return custom_title.strip()
    if (
        isinstance(tab_label, str)
        and tab_label.strip()
        and not host._is_generic_agent_name(tab_label, provider)
    ):
        return tab_label.strip()
    name = raw.get("name")
    if (
        isinstance(name, str)
        and name.strip()
        and not host._is_generic_agent_name(name, provider)
    ):
        return name.strip()
    terminal_title = raw.get("terminal_title_stripped")
    generic_titles = {
        provider,
        host._provider_label(provider).lower(),
        str(name or "").strip().lower(),
    }
    if (
        isinstance(terminal_title, str)
        and terminal_title.strip()
        and terminal_title.strip().lower() not in generic_titles
    ):
        return host._without_provider_suffix(terminal_title.strip(), provider)
    for fallback in (name, tab_label):
        if isinstance(fallback, str) and fallback.strip():
            return fallback.strip()
    return host._provider_label(provider)


def without_provider_suffix(title: str, provider: str) -> str:
    """Drop the CLI's name from the end of a title it wrote.

    Every Copilot terminal title ends "- GitHub Copilot", which is
    seventeen characters of a narrow header spent saying what the icon
    beside it already says, and enough to push the real title into an
    ellipsis. Only stripped when something is left over: a title that is
    nothing but the CLI's name still has to say something.
    """
    label = provider_label(provider)
    for separator in (" - ", " \u2013 ", " \u2014 ", " | "):
        suffix = separator + label
        if title.lower().endswith(suffix.lower()):
            trimmed = title[: -len(suffix)].strip()
            if trimmed:
                return trimmed
    return title


def is_generic_agent_name(value: str, provider: str) -> bool:
    normalized = value.strip().lower()
    if normalized == provider:
        return True
    prefix = provider + "-"
    suffix = normalized[len(prefix) :] if normalized.startswith(prefix) else ""
    return len(suffix) == 4 and all(character in "0123456789abcdef" for character in suffix)


def is_generic_agent_title(host: Bridge, value: str, provider: str) -> bool:
    normalized = value.strip().lower()
    return (
        host._is_generic_agent_name(value, provider)
        or normalized == host._provider_label(provider).lower()
        or normalized.startswith("session initialization -")
    )
