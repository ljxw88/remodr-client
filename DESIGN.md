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
- Tab changes use a short directional fade/slide while the selected dock
  capsule scales and fades between destinations. Keep the motion under 220ms
  and disable it when reduced motion is enabled.
- Blur only content beneath the dock. Android uses the SDK 31+ RenderNode blur
  path and a translucent fallback on older devices.
- Scrollable regions use short, non-interactive top and bottom edge fades so
  rows transition smoothly into fixed controls and the dock rather than ending
  at a hard clipping line. iOS/web may add cropped blur; Android keeps the
  gradient-only path to avoid re-blurring a full scrolling viewport.
- Keep navigation reachable and labeled for assistive technology in both
  states, and disable motion when the system requests reduced motion.

## Visual principles

- The canvas is one indigo-to-near-black vertical gradient, rendered once
  behind the whole navigator. Screens, stacks and headers stay transparent so
  it never restarts per route or seams between them.
- Keep the canvas otherwise clean. No glow blobs, decorative wallpaper, or
  noisy texture, and no second gradient competing with the canvas.
- Scrims and edge fades must stay low in alpha. A scrim tuned against the old
  solid near-black reads as a grey band over the saturated top of the
  gradient.
- Use one violet accent for primary actions, selection, focus, and active
  states.
- Frosted glass is the app's one surface material. Chips, buttons, cards, the
  dock, and the composer are all the same glass at different strengths, so the
  interface reads as a single sheet rather than a set of unrelated widgets.
- Glass surfaces are white at low alpha, never opaque grey. A white alpha fill
  works at both ends of the canvas — a bright panel over the indigo, a dark
  panel where the gradient bottoms out — so one token covers every screen.
- Prefer grouped modules and clear spacing over a collection of small cards.
- Keep information compact, but preserve comfortable mobile touch targets.
- Light mode and theme switching are intentionally out of scope.

## Core tokens

Defined in `src/constants/theme.ts`. See [`COLOR.md`](COLOR.md) for every place
a colour lives and which value to tune.

| Role | Value |
|---|---|
| Canvas | `#08090B` |
| Canvas gradient | `#2E3BE0` → `#232C9E` → `#0E1130` → `#08090B` |
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

### Sheets

All of them go through `SheetModal` and `SheetPanel`.

- The scrim fades, it never travels. `animationType="slide"` moves the whole
  modal window, dragging the scrim up from the bottom edge as a grey rectangle;
  a scrim is meant to darken in place, and when it moves the effect reads as a
  sheet of paper sliding over the screen rather than the app dimming behind a
  panel.
- The panel does the moving, and only a little. A short rise gives it direction
  without restating the full height of the screen.
- Sheets render in their own window and cannot blur the app behind them, so
  they use the opaque `chrome` surface rather than glass.

### Elevated surfaces

All of them go through `GlassSurface`, or `GlassRim` when a `Pressable` needs
the material without an extra layout node. Do not hand-roll a translucent fill
plus a border; see [`COLOR.md`](COLOR.md) for the tokens.

- Use a 24dp radius, a hairline translucent rim, and a brighter `borderTopColor`
  standing in for light catching the upper curve.
- **Glass casts no shadow.** Android draws a view's shadow behind the view; an
  opaque fill hid it, a translucent one does not, so the shadow shows straight
  through the glass as a dark band inside its own edges. Separation comes from
  the rim and the fill. This applies to `elevation` too, which draws a shadow
  of its own.
- Draw the rim as a real border, not an absolutely positioned overlay. Yoga
  lays absolute children out against the parent's *padding* box rather than its
  border box, so an overlay inside a padded surface traces the content instead
  of the edge — a visible box floating inside the glass.
- The same rule applies to any absolute child, including a Skia canvas: keep
  padding off the positioned parent and put it on an inner content view, the
  way `LiquidGlassButton` does.
- Two families, chosen by what is behind the surface:
  - **Panel** — sits on the canvas. Fill and rim only, no blur, because there
    is nothing behind it but the gradient.
  - **Chrome** — floats over scrolling content. Real backdrop blur.
- iOS may use native Liquid Glass where supported.
- Avoid nesting multiple elevated surfaces unless hierarchy requires it.

**A `BlurView` must never be a descendant of the blur target it samples.** It
draws that target's RenderNode, so nesting makes the RenderNode contain itself
and Android recurses through `RenderNode::prepareTreeImpl` until the native
stack overflows. The app dies with SIGSEGV — no JS error, no red box. Chrome is
always a *sibling* of `BlurBackdropTarget`; see
`src/components/ui/blur-backdrop.tsx`.

The blur can only see inside its target, so `BlurBackdropTarget` renders its
own copy of the canvas gradient. With the gradient outside, frosted chrome
blurs transparent pixels and reads as a dead grey slab.

That copy is shifted up by however far the target sits below the window top,
so it *continues* the canvas rather than restarting it. A target mounted under
a navigation header would otherwise jump back to the gradient's brightest
colour at the header's lower edge, leaving a band across the top of the screen.

Never give a `BlurTargetView` an `onLayout` prop. Its descendants then stop
receiving layout events entirely, which silently starves anything that sizes
itself that way — the Skia button simply renders nothing. Measure from a child
instead; the target's ref is a native instance without `measureInWindow`
anyway.

### Status

- Working: violet
- Needs input: amber
- Done or connected: green
- Failed: red
- Idle or unknown: muted gray

Status must remain understandable without color alone.

## Agents

- Keep a live runtime for every connected device. Selecting a device changes
  only what is displayed; it never reconnects or reloads.
- Show one device's spaces and agents at a time so identities from different
  servers never mix.
- Show every Herdr workspace as a horizontally scrollable space filter,
  including spaces that do not currently contain an agent.
- Keep the Spaces label row at a fixed height. Selecting a space may reveal its
  close action, but must not shift the filter chips or agent list.
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
- Place a secondary **New space** action beside it. Space creation asks for an
  optional label and required remote root folder, then selects the new space
  and continues directly into the agent picker.
- Keep the root-folder field editable, with a trailing folder action that opens
  a connected-device directory browser and writes the chosen path back into
  the field.

### Liquid glass primary action

**New agent** is the one sanctioned exception to the flat, restrained surface
rules above. It renders through Skia as refractive glass over an animated
chromatic orb.

- Treat it as scoped to this single hero control. Do not spread refraction,
  iridescence, or animated rim light to other buttons, rows, or the canvas.
- Draw the refracted content and the glass in one canvas. A backdrop filter
  reads only what that canvas already painted, so a glass pill over the bare
  near-black canvas has nothing to bend.
- Keep distortion strongest at the rim and near zero in the centre, so the
  label stays readable.
- Stop the animation when the control is disabled, the screen loses focus, or
  the app is backgrounded. A shader that animates forever keeps the GPU awake.

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

### Assistant markdown

- Render assistant replies as real markdown, not plain text: headings, bold and
  italic, nested lists, tables, blockquotes, links, and rules.
- Keep headings restrained. The largest is the 24/32 detail heading; markdown
  never introduces oversized display type.
- Give every fenced block a header with its language and a copy action, and
  scroll code horizontally rather than wrapping it, so indentation-sensitive
  output stays readable.
- Colour `diff` fences per line: green additions, red removals, violet hunk
  headers, muted file metadata.
- Size table columns to fit the screen and scroll wide tables horizontally.
  Never clip a column off the edge.
- Repair partial markdown while streaming so an unterminated emphasis or fence
  never leaks raw markers into the transcript.

## Server status

- Reconnect all devices with saved Keystore credentials in the background when
  the application shell starts; connection state must not depend on visiting
  the Agents tab.
- Start with one elevated server summary, explicit connection status, and an
  **Open agents** primary action.
- Present Files, Monitor, Docker, and Tunnels as four large circular quick
  actions sized for touch.
- Keep connection metadata in a simple grouped module.
- Keep Disconnect, Edit, and Delete below the primary workflow.
- When a saved credential exists, **Connect** uses it directly. Show the
  authentication form only when the device has no reusable credential.

## Settings

- Use compact grouped rows with violet-soft icon tiles.
- Keep security claims specific: stored credentials, host-key verification,
  diagnostics, and app version.
- Do not include Appearance controls because the product is intentionally
  dark-only.

## Motion, feedback, and accessibility

- Use subtle press-scale and opacity feedback; avoid decorative animation.
- Press-scale belongs to controls that stand alone on the canvas. A row that
  fills its card edge to edge must not scale: shrinking it pulls the pressed
  highlight inwards and leaves the card showing down both sides.
- Use named phases rather than fake progress percentages.
- Keep approval, failure, working, and reconnect states visible until they are
  resolved.
- Support font scaling, screen readers, and at least 4.5:1 text contrast.
- Label every icon-only action.
- Respect reduced-motion preferences.
