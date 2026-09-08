# Remodr

Android client for conversations with coding agents managed by Herdr on remote
development servers.

```text
React Native UI -> SSH -> mobile Python bridge -> Herdr / provider sessions
```

The app provides a native agent list and conversation UI, with server tools for
files, monitoring, Docker, and tunnels. There is no interactive terminal.
Provider adapters return semantic messages where supported; raw output is an
explicit compatibility view.

Supported providers are **OpenCode** (preferred), **GitHub Copilot** (preferred),
**Claude Code** (limited support), and **Codex** (limited support). OpenCode manages its upstream model accounts on
the remote host; see [OpenCode integration](docs/opencode-integration.md) for
setup, supported behavior, and the native API integration direction.

Each enabled device has its own supervised connection and cached runtime.
Dropped connections retain transcripts and durable pending sends, with a floating
status indicator and server-page controls rather than repeated dialogs.
Ambiguous delivery requires review instead of a potentially duplicated command.

## Run

```bash
npm ci
npx expo run:android --device
```

The local Kotlin `RemoteCore` module requires a development build; the complete
app cannot run in Expo Go. A debug development APK uses Metro. Use the preview
build instructions for a self-contained APK.

## Documentation

Start at the [documentation index](docs/README.md).

| Topic | Guide |
| --- | --- |
| Setup, debug/preview builds, and checks | [Development](docs/development.md) |
| USB Metro, physical phones, and Tailscale | [Physical Android development](docs/physical-android-development.md) |
| Component ownership | [Architecture](docs/architecture.md) |
| Creation, selection, settings and mobile keyboards | [Page workflows](docs/form-workflows.md) |
| Icon artwork, platform exports and regeneration | [App branding](docs/app-branding.md) |
| Server requirements and provider support | [Herdr integration](docs/herdr-mobile-architecture.md) |
| Reconnect, durable messages, and background limits | [Connection resilience](docs/connection-resilience.md) |
| Credentials, host verification, and persisted data | [Security](docs/security.md) |
| Decision history | [Architecture decisions](docs/adr/README.md) |

## App identity

The display name is **Remodr**. Existing installation, storage, deep-link, and
Expo project identifiers are retained for upgrade compatibility. See
[app identity](docs/development.md#app-identity) before changing them.

Repository: [ljxw88/remodr-client](https://github.com/ljxw88/remodr-client).
