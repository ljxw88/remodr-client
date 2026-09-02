# Herdr mobile architecture

## Existing application

- Product UI: React Native 0.86 / TypeScript / Expo SDK 57, not Jetpack Compose.
- Navigation: Expo Router with native tabs and stack routes.
- SSH: Kotlin local Expo module using SSHJ 0.39.
- Connection ownership: `SessionManager` owns authenticated `SSHClient` instances and can open multiple exec, SFTP, PTY, tunnel, and bridge channels.
- State: small external stores through `useSyncExternalStore`; no MVVM/MVI framework.
- Terminal: SSHJ PTY rendered by xterm inside a native Android view. It remains a separate diagnostics/server tool, not the agent experience.
- Persistence: AsyncStorage for non-secret metadata and Android Keystore-backed encrypted preferences for credentials.
- Dependency injection: explicit singleton services; no DI container.

## Installed remote runtime

- Herdr: 0.8.2, protocol 20.
- Session: `default`; socket `~/.config/herdr/herdr.sock`.
- Live agents: two GitHub Copilot agents with Herdr-reported Copilot session IDs.
- GitHub Copilot CLI: 1.0.80 with structured `events.jsonl` and ACP support.
- Codex CLI: 0.146.0.
- Claude Code and OpenCode executables: not currently installed.
- Herdr integrations: Copilot v3, Claude v8, Codex v8, OpenCode v10.

## Integration

```text
React Native screens
    ↓ normalized models only
HerdrRepository
    ↓ protocol 1 requests/events
HerdrBridgeTransport
    ↓ local Expo module
SSHJ non-PTY exec channel
    ↓ encrypted SSH
herdr_mobile_bridge.py
    ├ Herdr protocol 20 Unix socket
    ├ Copilot structured event/session adapter
    ├ Claude/Codex defensive transcript adapters
    └ conservative agent.read fallback
```

The bridge is bundled as an Android asset, hashed, and deployed with SFTP to
`~/.local/share/remote-workspace/`. It does not expose a TCP service and stdout
contains protocol NDJSON only.

Copilot `assistant.message` chunk events are reconciled by message ID for
streaming updates. Only the visible working conversation refreshes every
second; unchanged transcript snapshots are cached by remote file version.

## Process ownership

Closing the Android bridge or SSH connection closes only the client channel.
It never stops Herdr, closes panes, or terminates agents. Runtime and Copilot
conversation state are reconstructed after reconnect.
