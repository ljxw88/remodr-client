# Remote Workspace — Dark Mobile Design

Remote Workspace is an always-dark, conversation-first Android client for
remote coding agents. It uses a calm near-black canvas, restrained violet
accents, and soft depth to make complex remote workflows feel native on a
phone. The interface borrows proven hierarchy from modern finance and chat
apps without copying another product's branding or screen layouts.

## Product hierarchy

```text
Agents      primary daily destination
Servers     connection and server-tool management
Settings    security and diagnostics
```

Top-level tabs do not repeat their names as page titles. Pushed detail screens
retain a concise title and Back action.

Successful manual connection returns to Server status. It never opens
Terminal. Connected servers lead with **Open agents**; Terminal is not part of
the normal user flow.

## Floating dock

- Top-level navigation floats above the canvas as one rounded glass dock. It
  never spans edge to edge or paints a full-width navigation background.
- The active destination uses one restrained violet-soft capsule; inactive
  destinations remain transparent.
- At the top of a page, show icons and labels in a 72dp dock. After a deliberate
  downward scroll, animate to a narrower 54dp icon-only dock.
- Restore the expanded dock when the user scrolls upward, returns to the top, or
  changes tabs.
- Blur only content beneath the dock. Android uses the SDK 31+ RenderNode blur
  path and a translucent fallback on older devices.
- Scrollable regions use short, non-interactive top and bottom edge fades so
  rows transition smoothly into fixed controls and the dock rather than ending
  at a hard clipping line. iOS/web may add cropped blur; Android keeps the
  gradient-only path to avoid re-blurring a full scrolling viewport.
- Keep navigation reachable and labeled for assistive technology in both
  states, and disable motion when the system requests reduced motion.

## Visual principles

- Keep the canvas a pure, solid near-black. Do not add gradients, glow blobs,
  decorative wallpaper, or noisy texture.
- Use one violet accent for primary actions, selection, focus, and active
  states.
- Use glass sparingly for floating or elevated modules. On Android, pair the
  translucent surface with a subtle dark shadow so it remains legible.
- Prefer grouped modules and clear spacing over a collection of small cards.
- Keep information compact, but preserve comfortable mobile touch targets.
- Light mode and theme switching are intentionally out of scope.

## Core tokens

| Role | Value |
|---|---|
| Canvas | `#08090B` |
| Surface | `#141519` |
| Selected surface | `#202229` |
| Border | `#252830` |
| Primary text | `#F5F6F8` |
| Secondary text | `#B2B6C0` |
| Muted text | `#7F8591` |
| Placeholder | `#6C727D` |
| Primary accent | `#6C7CFF` |
| Success | `#5BE49B` |
| Warning | `#FFC65C` |
| Danger | `#FF716B` |

Violet is reserved for action and active emphasis. Green, amber, and red are
semantic and must always be paired with a label or icon.

## Geometry and spacing

Use the shared token scale rather than local one-off values.

| Token | Value | Typical use |
|---|---:|---|
| `half` | 4dp | Inline micro-gap |
| `one` | 8dp | Tight internal spacing |
| `two` | 16dp | Standard padding and gap |
| `three` | 24dp | Section separation |
| `four` | 32dp | Large section separation |
| `five` | 48dp | Control height / major space |
| `six` | 80dp | Bottom navigation clearance |

Use 10dp radii for tags, 18dp for controls, 24dp for elevated glass modules,
and full pills for buttons, status chips, and circular controls. Interactive
targets must be at least 44×44dp; primary controls should be 48dp tall.

## Typography

Use Inter 400, 500, and 600. Semibold establishes hierarchy without heavy,
oversized display treatment.

| Role | Size / line | Weight |
|---|---|---|
| Body | 16 / 24 | Regular |
| Small body | 14 / 20 | Medium |
| Section | 16 / 22 | Semibold |
| Detail heading | 24 / 32 | Semibold |
| Caption | 12 / 18 | Regular |
| Label | 12 / 18 | Medium |

Use monospace only for paths, commands, identifiers, diffs, endpoints, and
logs. Do not add marketing subtitles to mobile headers.

## Components

### Buttons and fields

- Primary buttons use violet with white semibold text and a pill shape.
- Secondary buttons use an elevated dark surface with a restrained border.
- Destructive actions remain visually separate from the primary workflow.
- Inputs are 48dp high with an 18dp radius. Focus uses a violet border and
  subtle depth, not a glow.

### Elevated surfaces

- Use a 24dp radius and one-pixel translucent border.
- iOS may use native Liquid Glass where supported.
- Android uses the shared dark glass fallback with soft elevation.
- Avoid nesting multiple elevated surfaces unless hierarchy requires it.

### Status

- Working: violet
- Needs input: amber
- Done or connected: green
- Failed: red
- Idle or unknown: muted gray

Status must remain understandable without color alone.

## Agents

- Select one saved device at a time; changing devices replaces the active Herdr
  runtime rather than mixing identities from different servers.
- Show every Herdr workspace as a horizontally scrollable space filter,
  including spaces that do not currently contain an agent.
- Group agents by Herdr workspace in one surface rather than separate floating
  cards for every row.
- Show provider, working directory, and explicit status.
- Preserve last-known content during reconnect and show a compact reconnect
  banner.
- A violet-soft icon tile gives each row a stable visual anchor.
- Tapping a row opens its conversation at the newest content.
- Keep **New agent** as the only primary action. Its bottom sheet chooses one
  of the server-advertised providers, a required space, and an explicit
  auto-approval setting without exposing terminal controls.

## Conversation

- Assistant content sits directly on the canvas for maximum reading space.
- User messages use compact right-aligned dark bubbles.
- Open at the newest item and follow sent messages, streaming chunks, tool
  updates, and assistant responses automatically.
- Group every tool call within a user turn into one thin, expandable line:
  `Worked for 20m (6 tool calls)`.
- Show a persistent named activity indicator above the composer while the
  agent is sending, working, or running a tool.
- Keep the rounded composer fixed above navigation with functional blur and
  soft depth.
- Render questions and permissions as inline native cards.
- Never expose terminal keys or Ctrl+C as the primary agent interaction.

## Server status

- Start with one elevated server summary, explicit connection status, and an
  **Open agents** primary action.
- Present Files, Monitor, Docker, and Tunnels as four large circular quick
  actions sized for touch.
- Keep connection metadata in a simple grouped module.
- Keep Disconnect, Edit, and Delete below the primary workflow.

## Settings

- Use compact grouped rows with violet-soft icon tiles.
- Keep security claims specific: stored credentials, host-key verification,
  diagnostics, and app version.
- Do not include Appearance controls because the product is intentionally
  dark-only.

## Motion, feedback, and accessibility

- Use subtle press-scale and opacity feedback; avoid decorative animation.
- Use named phases rather than fake progress percentages.
- Keep approval, failure, working, and reconnect states visible until they are
  resolved.
- Support font scaling, screen readers, and at least 4.5:1 text contrast.
- Label every icon-only action.
- Respect reduced-motion preferences.
