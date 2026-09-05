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

The Agents screen shows one saved device at a time, exposes every Herdr
workspace as a filterable space, and can start Copilot, Claude, Codex, or
OpenCode in a new tab inside the selected space. Herdr events refresh additions,
removals, moves, and status changes from authoritative snapshots.

Every enabled saved device with a Keystore credential is supervised from the
app root, and each one keeps its own Herdr bridge and runtime.
Switching devices is therefore instant and never reloads a session. Connecting
from Server status reuses the same deduplicated connection attempt and does not
ask for its password again.

Connection loss preserves the transcript and durable pending messages.
Recovery uses per-device backoff and network/lifecycle signals rather than
screen-specific retry buttons. See [connection recovery and delivery
guarantees](docs/connection-resilience.md), including ambiguous-delivery and
Android background-execution limits.

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

## Build & Packaging (Standalone APK)

Because this app includes the custom native `RemoteCore` Android module, it cannot run in the generic Expo Go app. Use one of the following methods to build a standalone APK or install directly to a device.

### 1. Direct USB Installation (Development)

Builds and installs directly to an ADB-connected Android device:

```bash
npx expo run:android --device
```

### 2. Local Gradle Build (Fastest, zero queue)

Generate native project files and compile a standalone APK locally using Gradle:

```bash
# 1. Generate the native android directory (if not already present)
npx expo prebuild --platform android

# 2. Build Debug APK (no keystore signing required)
cd android && ./gradlew assembleDebug
```

- **Output APK**: `android/app/build/outputs/apk/debug/app-debug.apk`
- **Install to device via ADB**:
  ```bash
  adb install -r android/app/build/outputs/apk/debug/app-debug.apk
  ```

To build a Release APK:

```bash
cd android && ./gradlew assembleRelease
```

- **Output APK**: `android/app/build/outputs/apk/release/app-release.apk` *(requires signing configuration)*

### 3. Local EAS Build (Zero queue via EAS CLI <- currently only this works)

Build an APK locally using EAS CLI and local Android SDK / JDK:

```bash
npx eas-cli build --platform android --profile preview --local
```

### 4. Cloud EAS Build

Build an APK via Expo Application Services in the cloud:

```bash
# Install EAS CLI and login
npm install -g eas-cli
eas login

# Trigger cloud preview build (configured for APK in eas.json)
eas build --platform android --profile preview
```

## Checks

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
PYTHONPATH=modules/remote-core/bridge \
  python3 -m unittest discover -s modules/remote-core/bridge -p 'test_*.py'
```
