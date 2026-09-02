# Remote Workspace

Android frontend for coding agents managed by Herdr on a remote development
server.

```text
Android UI → existing SSH → Herdr mobile bridge → Herdr / provider sessions
```

The default workflow is a native Agents list and shared conversation UI. Herdr
provides runtime identity and status; provider adapters provide semantic
messages, tool activity, questions, and TODOs where reliable. Terminal output
is a conservative fallback, not the primary interface.

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

## Checks

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
PYTHONPATH=modules/remote-core/bridge \
  python3 -m unittest discover -s modules/remote-core/bridge -p 'test_*.py'
```
