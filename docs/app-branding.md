# App branding

[Documentation index](README.md) | [App identity](development.md#app-identity)

The display name is **Remodr**. The icon is an original geometric R with a
window-shaped counter, rendered as Tahoe liquid glass on a flat `#171717`
field. Its silhouette, rather than small decorative details, carries the
identity at launcher size.

## Source and exports

Edit the vectors in [`assets/brand/`](../assets/brand/), not the generated PNGs:

- `mark.svg`: the R geometry and liquid-glass shading; no fonts or external artwork.
- `background.svg`: the opaque `#171717` field.

Generate the platform assets with the pinned development dependency:

```bash
npm ci
npm run assets:icons
npm run assets:icons -- --check
```

[`generate-app-icons.mjs`](../scripts/generate-app-icons.mjs) exports:
Unless another directory is shown, the files below live in `assets/images/`.

| Asset | Use |
| --- | --- |
| `assets/images/icon.png` | Opaque 1024px general/legacy icon |
| `android-icon-foreground.png` | Transparent 1024px adaptive foreground |
| `android-icon-background.png` | Opaque, full-bleed 1024px adaptive background |
| `android-icon-monochrome.png` | Clean white alpha mask for Android themed icons |
| `splash-icon.png` | Transparent 1024px launch mark |
| `favicon.png` | 64px web favicon |
| `assets/expo.icon/Assets/remodr-mark.png` | Mark layer for the retained iOS Icon Composer configuration |

The Android foreground uses a 108dp canvas. The essential monochrome silhouette
must stay inside its centered 66dp safe circle; shadows are not part of that
silhouette. Do not bake a rounded-square or circular mask into launcher assets:
the operating system supplies it. The small web favicon is the sole pre-rounded
export.

The monochrome layer must contain the mark only, with no background, gradients,
or shadow. Keep the splash image transparent. The iOS `.icon` configuration
references the same generated mark; Android remains the supported app platform.

## Shipping changes

Asset paths and display name live in [`app.json`](../app.json). These are native
resources, so changing them requires regeneration and a rebuilt installation:

```bash
npx expo prebuild --platform android --no-install --no-clean
npx expo run:android --device
```

Fast Refresh alone cannot update a launcher icon or label. Use a preview or
production build to assess the final splash screen; development clients have
their own launch UI.
SDK 57 cleans native folders by default; `--no-clean` retains a valid existing
project and its incremental build output when applying these resource changes.

Keep the npm name `remodr`, Android application ID, deep-link scheme, storage
keys, remote bridge protocol name, and linked Expo project identifiers unchanged.
They are compatibility identifiers, not display branding.
