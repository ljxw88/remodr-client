# Physical Android development with Tailscale

remodr uses two independent connections during development:

```text
App SSH traffic  -> Tailscale -> remote server
JavaScript bundle -> USB ADB  -> Metro on the development Mac
```

Keep Tailscale enabled on the Android phone. Routing Metro through USB avoids
VPN routing, Wi-Fi isolation, and firewall issues while preserving access to
servers on the tailnet.

## Prerequisites

- Install the Android development build, not Expo Go.
- Enable Developer options and USB debugging on the phone.
- Connect the phone by USB and approve its debugging prompt.
- Install the project dependencies with `npm install`.

Confirm that ADB can see the phone:

```bash
adb devices -l
```

The current test phone appears as:

```text
R3GL70CQ5KA  device  model:SM_F971B
```

## Recommended workflow: Tailscale plus USB Metro

1. Keep Tailscale enabled on the phone.
2. Forward the phone's local port `8081` to Metro through USB:

   ```bash
   adb -s R3GL70CQ5KA reverse tcp:8081 tcp:8081
   ```

3. Start Metro in development-client mode:

   ```bash
   npx expo start --dev-client --localhost
   ```

4. Open the installed **remodr** development app.

The app can now connect to a server by its Tailscale address while loading its
JavaScript bundle from `http://127.0.0.1:8081`.

Check the active forwarding rule with:

```bash
adb -s R3GL70CQ5KA reverse --list
```

Expected output:

```text
UsbFfs tcp:8081 tcp:8081
```

ADB reverse rules are temporary. Run the `adb reverse` command again after
reconnecting USB, restarting ADB, or rebooting the phone.

## Rebuild after native changes

Metro can update TypeScript and JavaScript, but it cannot add Kotlin modules to
an installed binary. Rebuild and reinstall after changing `app.json`, upgrading
Expo, adding a native dependency, or changing `modules/remote-core`:

```bash
npx expo run:android --device
```

Select `SM_F971B` when prompted. If the APK has already been built, it can also
be installed directly:

```bash
adb -s R3GL70CQ5KA install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
```

Then restart Metro:

```bash
npx expo start --dev-client --localhost -c
```

## Wireless fallback over Tailscale

When USB is unavailable, Metro can be reached through the Mac's Tailscale
address. Start Metro so it listens beyond localhost:

```bash
npx expo start --dev-client --lan
```

In the development launcher, connect to:

```text
http://<mac-tailscale-ip>:8081
```

Find the Mac address with:

```bash
tailscale ip -4
```

For the current development Mac, that address is `100.90.20.12`. The wireless
path requires both devices to be on the same tailnet and the Mac firewall to
allow Metro on port `8081`.

## Troubleshooting

### No development build is installed

```text
CommandError: No development build (...) for this project is installed.
```

`npx expo start` starts Metro but does not install the native app. Run:

```bash
npx expo run:android --device
```

Do not open this project in Expo Go because `RemoteCore` is a local native
Android module.

### Cannot find native module `RemoteCore`

The installed development app is stale or the project was opened in Expo Go.
Rebuild and reinstall the development app, then clear Metro's cache:

```bash
npx expo run:android --device
npx expo start --dev-client --localhost -c
```

### Blank or white screen

If the foreground activity is
`expo.modules.devlauncher.launcher.DevLauncherActivity`, the launcher has not
initialized the React Native bundle. Recreate the USB tunnel and restart the
app:

```bash
adb -s R3GL70CQ5KA reverse tcp:8081 tcp:8081
adb -s R3GL70CQ5KA shell am force-stop com.anonymous.remoteworkspace
npx expo start --dev-client --localhost
```

Verify Metro locally:

```bash
curl http://127.0.0.1:8081/status
```

The expected response is:

```text
packager-status:running
```

### More than one Android target is connected

When an emulator and phone are both connected, qualify every ADB command with
the phone serial:

```bash
adb -s R3GL70CQ5KA <command>
```
