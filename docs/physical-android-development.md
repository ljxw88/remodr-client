# Physical Android development

[Documentation index](README.md) | [Build instructions](development.md)

A development installation uses two independent connections:

```text
App SSH traffic   -> LAN, public SSH, or VPN -> remote server
JavaScript bundle -> USB ADB                -> Metro on the development machine
```

USB routing for Metro avoids relying on the phone's Wi-Fi/VPN path for the
JavaScript bundle. If your SSH host is on a tailnet, keep Tailscale connected
on the phone. Tailscale is a deployment choice, not an app requirement.

## USB setup

Install the development build using the [build guide](development.md), enable
USB debugging, and approve the computer's debugging prompt.

From the repository root, list available devices and select the phone:

```bash
adb devices -l
export ANDROID_SERIAL=YOUR_DEVICE_SERIAL
adb -s "$ANDROID_SERIAL" reverse tcp:8081 tcp:8081
npx expo start --dev-client --localhost
```

Replace `YOUR_DEVICE_SERIAL` with the identifier reported by `adb devices`.
Open **Remodr** and select the development server at
`http://127.0.0.1:8081` in its launcher.

Check the forwarding rule with:

```bash
adb -s "$ANDROID_SERIAL" reverse --list
```

The result should include `tcp:8081 tcp:8081`. Recreate the rule after unplugging
USB, restarting ADB, or rebooting the device. Qualify ADB commands when more than
one emulator/phone is attached.

## Updating the installed app

Metro applies JavaScript changes but cannot add native modules or replace the
bundled Python bridge. Rebuild/reinstall after native dependencies, Kotlin,
bridge assets, or native app configuration change:

```bash
npx expo run:android --device
```

If the APK has already been built, install it without clearing app data:

```bash
adb -s "$ANDROID_SERIAL" install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
```

The application ID remains `com.anonymous.remoteworkspace` after the Remodr
rename. Display branding, deep-link scheme, and installation identity are
different settings; see [app identity](development.md#app-identity).

## Wireless Metro

When USB is unavailable, run Metro on a reachable interface:

```bash
npx expo start --dev-client --lan
```

Open `http://YOUR_DEVELOPMENT_MACHINE_ADDRESS:8081` in the app's development
launcher. The phone must be able to reach that address and the host firewall
must allow the connection.

For Tailscale, obtain the development machine's tailnet address with:

```bash
tailscale ip -4
```

Use the reported address, not an address copied from another developer's setup.
An emulator's host alias, `10.0.2.2`, is not the development machine's address
on a physical phone.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No development build is installed | Run `npx expo run:android --device`; starting Metro alone does not install an app |
| `RemoteCore` or another native module is missing | Rebuild and reinstall; Expo Go cannot load the local module |
| Development launcher is open instead of the product UI | Select a reachable Metro URL; this is not proof of an SSH failure |
| Metro loads but servers do not connect | Inspect the SSH endpoint, host trust, saved credentials, VPN, and inline connection status |
| SSH works but the bundle does not load | Inspect ADB reverse, the Metro process, and port 8081 routing |
| More than one target is attached | Use `adb -s "$ANDROID_SERIAL"` for each operation |

Useful local checks:

```bash
curl http://127.0.0.1:8081/status
adb -s "$ANDROID_SERIAL" reverse --list
adb -s "$ANDROID_SERIAL" shell am force-stop com.anonymous.remoteworkspace
```

Metro's status response is `packager-status:running`. A cache clear
(`npx expo start --dev-client --localhost -c`) can help stale bundle state,
but it cannot update native code. Avoid multiple Metro processes competing for
the same port.

## Mobile recovery checks

Use a disposable agent when exercising airplane mode, Wi-Fi/cellular changes,
screen-off behavior, or process restarts. Follow the
[connection checklist](connection-resilience.md#failure-injection-checklist).
Emulator success does not establish physical radio roaming or OEM battery
behavior. A foreground-service notification does not guarantee uninterrupted
network or JavaScript execution under Doze.
