# Development and builds

[Documentation index](README.md)

remodr is an Android app built with Expo SDK 57 and a local Kotlin module.
Use a development build, not Expo Go: Expo Go cannot load
[`RemoteCore`](../modules/remote-core/).

Dependency versions and commands live in [`package.json`](../package.json) and
[`package-lock.json`](../package-lock.json). Consult the
[SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) before changing
Expo APIs; do not assume examples for another SDK apply.

## Prerequisites

- Node.js/npm compatible with the installed Expo SDK.
- Android SDK/platform tools, an emulator or USB-debuggable Android phone, and
  a compatible JDK. The local Android build has been exercised with JDK 17.
- A remote SSH host running Herdr and the provider CLI you want to use. See
  [Herdr integration](herdr-mobile-architecture.md).

From the repository root:

```bash
npm ci
npx expo run:android --device
```

`expo run:android` builds and installs the app and can generate the native
project when it is absent. JavaScript-only changes normally arrive through
Metro; native module, native dependency, and app configuration changes require
a rebuilt installation.

## Metro and a development APK

```bash
npx expo start --dev-client --localhost
```

For a phone, route port 8081 over USB using the
[physical-device guide](physical-android-development.md). Metro and SSH are
separate connections. A working JavaScript bundle does not imply the remote
server is reachable.

If `android/` already exists, an incremental local build does not require
prebuild:

```bash
cd android
./gradlew :app:assembleDebug
```

The output is `android/app/build/outputs/apk/debug/app-debug.apk`, relative to
the repository root. Install it with:

```bash
adb -s YOUR_DEVICE_SERIAL install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
```

This debug development APK uses Metro. It is not a self-contained distribution
build merely because Gradle produced an APK.

## Native generation

The generated `android/` and `ios/` directories are gitignored. Persistent
Android module declarations belong in
[`modules/remote-core/android/src/main/AndroidManifest.xml`](../modules/remote-core/android/src/main/AndroidManifest.xml);
app configuration belongs in [`app.json`](../app.json).

When the generated project is absent or native configuration needs refreshing:

```bash
npx expo prebuild --platform android --no-install
```

Prebuild can recreate native files. Preserve any intentional local native edits
before running it; do not use `--clean` as a routine troubleshooting step.
Reusing an existing generated project also preserves incremental Gradle output.

## Self-contained preview builds

[`eas.json`](../eas.json) defines three profiles:

| Profile | Configuration |
| --- | --- |
| `development` | Development client, internal distribution |
| `preview` | Internal distribution, Android APK |
| `production` | Production build with automatic version increment |

The preview profile bundles JavaScript and does not require Metro:

```bash
npx eas-cli build --platform android --profile preview --local
```

For a cloud build, omit `--local`. EAS needs an authenticated Expo account with
access to the linked project. Local builds also need the Android toolchain.
There is no requirement that only EAS can build this app.

`./gradlew :app:assembleRelease` is another local build path after native
generation. Review its signing and bundling configuration before distributing
the output; an existing debug keystore is not a production signing setup.

## App identity

The display name and package metadata use `remodr`. Compatibility identifiers
remain unchanged:

- Android application ID: `com.anonymous.remoteworkspace`
- Deep-link scheme: `remoteworkspace`
- Existing storage keys and remote deployment directory
- Expo owner, slug, and EAS project ID in `app.json`

GitHub authentication and Expo project ownership are independent. Changing the
GitHub remote does not transfer the EAS project. Coordinate an Expo project
rename/transfer separately instead of deleting its project ID or changing its
slug without updating the linked project.

## Checks

Run the smallest existing command covering the change:

```bash
npm run typecheck
npm run lint
npm test -- --runInBand
python3 -m unittest discover -s modules/remote-core/bridge -p 'test_*.py'
```

Examples of targeted checks:

```bash
npm test -- --runInBand src/features/agents/conversation-refresh.test.ts
cd android
./gradlew :remote-core:testDebugUnitTest
./gradlew :remote-core:connectedDebugAndroidTest
```

The last command requires a connected Android target. Native tests cover
resource ownership, host trust, bridge delivery, deployment, and service
lifecycle; they do not establish real-phone roaming or OEM Doze behavior.
Use the [failure-injection checklist](connection-resilience.md#failure-injection-checklist)
for connection work.
