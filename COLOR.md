# Colour

Where every colour in the app is defined, and which knob to turn.

Almost everything lives in **`src/constants/theme.ts`**. Start there.

## Tuning recipes

### The canvas gradient

`BackgroundGradient` in `src/constants/theme.ts`.

```ts
export const BackgroundGradient = {
  colors: ['#2E3BE0', '#232C9E', '#0E1130', Colors.background],
  locations: [0, 0.28, 0.58, 1],
};
```

`locations` are fractions of screen height. Lower the third stop to reach
near-black sooner, which keeps more of a screen neutral; raise it to carry the
indigo further down. Keep the last colour equal to `Colors.background` so the
foot of the gradient matches anything painted with the flat canvas colour.

Rendered once behind the navigator by `src/components/ui/app-background.tsx`.
Screens and stacks are transparent on purpose — see `DESIGN.md`.

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

`color` should track the foot of the canvas gradient. A scrim tuned against a
different colour reads as a grey band, which is what happened when the canvas
became a gradient while these values still assumed flat near-black.

Consumed by `src/components/ui/scroll-edge-frame.tsx`, which builds the CSS
gradient strings from these values. Applied on the Agents list and the agent
conversation screen.

### The accent, text, and surfaces

`Colors` in `src/constants/theme.ts`. Semantic roles rather than raw names, so
changing `accent` restyles every primary action, selection, and focus ring at
once.

Use `withAlpha('#6C7CFF', 0.4)` rather than writing a second `rgba()` literal
for a translucent variant of an existing token.

## Everywhere else

These hold colour outside the main palette. Most are deliberate; the last two
columns say whether you normally touch them.

| Location | Holds | Edit? |
|---|---|---|
| `src/constants/theme.ts` | `Colors`, `BackgroundGradient`, `ScrollEdgeFade` | **Yes — start here** |
| `src/global.css` | CSS variables mirroring `Colors` | Only to keep in sync |
| `src/app/_layout.tsx` | `AbyssTheme` navigation colours | Keep in sync with `Colors` |
| `app.json` | Root, splash, and adaptive-icon background | Native chrome, not JS |
| `src/components/markdown/markdown-theme.ts` | `SyntaxColors`, `DiffColors`, markdown block styles | For code and diff rendering |
| `src/components/ui/chromatic-metal.tsx` | `CHROME.gradient` ramp | For the shader orb |
| `src/features/agents/liquid-glass-button.tsx` | Glow, rim, and bezel gradients | For the glass button |
| `src/features/agents/agent-provider-icon.tsx` | Per-provider brand colours | Rarely — these are vendor brands |

Two duplications are worth knowing about. `src/global.css` and the `AbyssTheme`
block in `src/app/_layout.tsx` both restate values from `Colors` as literals,
because a CSS custom property and a React Navigation theme cannot import from
it in the form each needs. Changing a core colour means editing all three.

`app.json` is separate again: it colours the native window and splash before
any JavaScript runs, so it cannot read `Colors`. Keep it equal to
`Colors.background`, which is also the foot of the canvas gradient.

## Rules

- Add a colour to `Colors` before using it. Do not introduce a hex literal in a
  component.
- Name by role, not by hue. `danger`, not `red`.
- Derive translucent variants with `withAlpha`, so the base colour stays the
  single source.
- Scrims and fades must reference the canvas colour, never a hardcoded
  near-black.
- Brand colours for third-party providers are the one accepted exception, and
  belong beside the icon that uses them.
