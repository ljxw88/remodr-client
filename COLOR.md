# Colour

Where every colour in the app is defined, and which knob to turn.

Almost everything lives in **`src/constants/theme.ts`**. Start there.

## Tuning recipes

### The graphite canvas

`Colors.background` in `src/constants/theme.ts`.

```ts
background: '#171717'
```

`AppBackground` paints this exact flat field on every route and blur target.
It needs no measured window alignment or gradient pass. `Colors.accent` is
`#F5F5F5`, so action and selection emphasis remain neutral rather than
reintroducing a hue.

`Colors.accentSecondary` is `#FF8000`. It is supplemental, not a replacement
for the off-white primary accent: use it for unread indicators and
input-required prompts. Selected filters and agent icons remain white.

`src/components/ui/app-background.tsx` renders the canvas at the root and in
routes/blur targets that need their own opaque backdrop. Transparent headers
read through to the route's canvas, not to the preceding screen; see
`DESIGN.md`.

### The fade at the bottom of scrolling content

`ScrollEdgeFade` in `src/constants/theme.ts`. This is the dissolve that stops
rows ending at a hard line behind the floating dock or the chat composer.

```ts
export const ScrollEdgeFade = {
  color: Colors.background,   // what content dissolves into
  topHeight: 18,
  topOpacity: 0.16,
  bottomHeight: 112,          // how far up the dissolve reaches
  bottomOpacity: 0.92,        // how completely it hides content at the edge
};
```

- **Stronger dissolve**: raise `bottomOpacity` towards `1`.
- **Longer dissolve**: raise `bottomHeight`.
- **Disable an edge**: set its opacity to `0`.

`color` should track the canvas. A scrim tuned against a different neutral
reads as a visible band.

Consumed by `src/components/ui/scroll-edge-frame.tsx`, which builds the CSS
gradient strings from these values. Applied to tab scrollables and the agent
conversation screen.

### The frosted surfaces

`GlassMaterial` in `src/constants/theme.ts`, applied by
`src/components/ui/glass-surface.tsx`. Everything that should read as glass —
chips, header buttons, cards, the dock, the composer — goes through that one
component, so there is one place to tune the material.

There are two families, and picking the right one matters:

| Family | Used by | What it is |
|---|---|---|
| `panel` | Chips, header buttons, cards, search fields | Translucent white fill plus a rim. No blur. |
| `chrome` | The floating dock, the chat composer | A live backdrop blur plus a light fill. |

`panel` does not blur because there is nothing behind it but the flat canvas:
a blur pass would spend a frame producing the same picture. It gets
its glassiness from the fill, the hairline rim, and the specular top edge.

```ts
export const GlassMaterial = {
  panel: {
    fill: Colors.glass,             // rgba white, 0.065
    fillStrong: Colors.glassStrong, // rgba white, 0.10
    border: Colors.glassBorder,
    highlight: Colors.glassHighlight,
  },
  chrome: {
    intensity: 40,                  // tint alpha *and* blur radius
    blurReductionFactor: 1.7,       // radius = intensity / this
    tint: 'systemUltraThinMaterialDark',
    fill: 'rgba(255,255,255,0.05)',
    ...
  },
};
```

- **Lighter or heavier panels**: change `Colors.glass` / `Colors.glassStrong`.
  These are white at low alpha on purpose. A 6.5% white plate over `#171717`
  resolves near `#262626`; the stronger and selected plates step toward
  `#373737` without adding another hue.
- **Crisper edges**: raise `Colors.glassBorder`, then `Colors.glassHighlight`.
- **More blur without a darker bar**: on Android `intensity` drives the tint
  alpha *and* the blur radius, so raising it for more blur also smokes the
  surface over. Lower `blurReductionFactor` instead — radius is
  `intensity / blurReductionFactor`. Existing settings use a radius near 25;
  check the selected Android backend's limits before increasing it.
- **A darker or lighter chrome tint**: swap `tint` for another
  `systemNNNMaterialDark` value. Their alpha multipliers are listed in
  `expo-blur`'s `TintStyle.kt`; `ultraThin` is 0.55, `thin` 0.70, `dark` 0.69.

Glass surfaces deliberately carry no `elevation` and no shadow. Android draws
a shadow behind the view, and a translucent fill lets it through as a dark
band inside the surface's own edges — the effect looks like a second rectangle
floating in the glass. If a surface needs to feel lifted, raise its fill or its
rim rather than adding a shadow back.

`FormPage` uses a quiet content background. The small `ActionMenu` uses an
opaque base, shared glass tint and native rim in its modal window; it does not
sample the underlying app's blur target.

### The accent, text, and surfaces

`Colors` in `src/constants/theme.ts`. Semantic roles rather than raw names, so
changing `accent` restyles every primary action, selection, and focus ring at
once.

Use `withAlpha(Colors.accent, 0.4)` rather than writing a second `rgba()` literal
for a translucent variant of an existing token.

## Everywhere else

These hold colour outside the main palette. Most are deliberate; the last two
columns say whether you normally touch them.

| Location | Holds | Edit? |
|---|---|---|
| `src/constants/theme.ts` | `Colors`, `ScrollEdgeFade`, `GlassMaterial` | **Yes — start here** |
| `src/global.css` | CSS variables mirroring `Colors` | Only to keep in sync |
| `src/app/_layout.tsx` | `AbyssTheme` navigation colours | Reads `Colors` directly |
| `app.json` | Root and splash background | Keep equal to `#171717`; adaptive-icon branding is separate |
| `src/components/markdown/markdown-theme.ts` | `SyntaxColors`, `DiffColors`, markdown block styles | For code and diff rendering |
| `src/components/ui/chromatic-metal.tsx` | `CHROME.gradient` ramp | For the shader orb |
| `src/features/agents/liquid-glass-button.tsx` | Glow, rim, and bezel gradients | For the glass button |
| `src/features/agents/agent-provider-icon.tsx` | Per-provider brand colours | Rarely — these are vendor brands |

One duplication is worth knowing about. `src/global.css` restates values from
`Colors` as literals, because a CSS custom property cannot import from
TypeScript. Changing a core surface colour means editing both.

`app.json` is separate again: it colours the native window and splash before
any JavaScript runs, so it cannot read `Colors`. Keep both equal to
`Colors.background`.

## Rules

- Add a colour to `Colors` before using it. Do not introduce a hex literal in a
  component.
- Name by role, not by hue. `danger`, not `red`.
- Derive translucent variants with `withAlpha`, so the base colour stays the
  single source.
- Scrims and fades must reference the canvas colour, never a different
  hardcoded neutral.
- Brand colours for third-party providers are the one accepted exception, and
  belong beside the icon that uses them.
- Do not hand-roll a frosted surface. Use `GlassSurface`, or `glassRim` when a
  `Pressable` needs the material without an extra layout node.
