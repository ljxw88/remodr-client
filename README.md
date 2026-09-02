# Remote Workspace

Android frontend for coding agents managed by Herdr on a remote development
server.

```text
Android UI → existing SSH → Herdr mobile bridge → Herdr / provider sessions
```

The default workflow is a native Agents list and shared conversation UI. Herdr
provides runtime identity and status; provider adapters provide semantic
messages, tool activity, questions, and TODOs where reliable. Raw agent output
is a conservative fallback, not the primary interface.

The Agents screen selects one saved device at a time, exposes every Herdr
workspace as a filterable space, and can start Copilot, Claude, Codex, or
OpenCode in a new tab inside the selected space. Herdr events refresh additions,
removals, moves, and status changes from authoritative snapshots.

Top-level navigation uses a custom floating glass dock that collapses to compact
icons during downward scrolling and expands on upward scrolling or tab changes.

## Current remote compatibility

- Herdr 0.8.2 / protocol 20
- GitHub Copilot CLI 1.0.80: structured conversation, tools, TODOs, questions
- Codex CLI 0.146.0: defensive transcript adapter with Herdr fallback
- Claude Code: adapter and fallback; executable required on the server
- OpenCode: Herdr fallback; executable required on the server

Herdr remains accessible only through the remote user's Unix socket. The app
does not expose a new TCP service.

## Run

```bash
npm install
npx expo run:android
```

This project contains the local `RemoteCore` Android module and cannot run in
Expo Go. Rebuild and reinstall the development app after native module changes.
For physical-device testing with Tailscale, see
[`docs/physical-android-development.md`](docs/physical-android-development.md).

## Checks

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
PYTHONPATH=modules/remote-core/bridge \
  python3 -m unittest discover -s modules/remote-core/bridge -p 'test_*.py'
```
