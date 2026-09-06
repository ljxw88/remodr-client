# Remodr — Dark Mobile Design

Remodr is an always-dark, conversation-first Android client for
remote coding agents. It uses a calm near-black canvas, restrained blue
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
- The active destination uses one restrained blue-soft capsule; inactive
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

- The canvas is one indigo-to-near-black vertical gradient. Every screen paints
  its own copy, aligned to the window rather than to the screen, so it still
  reads as one surface the routes move across. Headers stay transparent so the
  canvas shows through them.
- A screen must be opaque. Left transparent, it shows whatever it is covering
  in the navigator, which during a transition is the screen it is replacing —
  the two read as a double exposure until the animation ends.
- Keep the canvas otherwise clean. No glow blobs, decorative wallpaper, or
  noisy texture, and no second gradient competing with the canvas.
- Scrims and edge fades must stay low in alpha. A scrim tuned against the old
  solid near-black reads as a grey band over the saturated top of the
  gradient.
- Use one blue accent for primary actions, selection, focus, and active
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
| Canvas gradient | `#2241C0` → `#1D3182` → `#0D1226` → `#08090B` |
| Surface | `#141519` |
| Selected surface | `#202229` |
| Border | `#252830` |
| Primary text | `#F5F6F8` |
| Secondary text | `#B2B6C0` |
| Muted text | `#A2A8B6` |
| Placeholder | `#8E95A5` |
| Primary accent | `#6682F0` |
| Success | `#5BE49B` |
| Warning | `#FFC65C` |
| Danger | `#FF716B` |

Blue is reserved for action and active emphasis. Green, amber, and red are
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

- Primary buttons use blue with white semibold text and a pill shape.
- Secondary buttons use an elevated dark surface with a restrained border.
- Destructive actions remain visually separate from the primary workflow.
- Inputs use the shared minimum control height with an 18dp radius. Focus uses a blue border and
  subtle depth, not a glow.

### Workflow pages and contextual menus

- Creation, folder browsing, model settings and rename use full pages through
  `FormPage`, with quiet content surfaces and one primary footer action.
- Long choices use searchable lists. Keep optional settings collapsed until
  needed instead of showing every model and option at once.
- Selectors share a draft with their parent through a flow ID. Back preserves
  editing values; Cancel does not apply them to the server.
- Forms account for actual keyboard overlap, including native `adjustResize`.
  Keep focused fields and the footer visible without applying keyboard height
  twice. Do not use dock clearance on pages where there is no dock.
- Small agent actions use `ActionMenu` anchored to the ellipsis, without a
  screen-wide dimming layer. Destructive actions still ask for confirmation.
- Connection status stays in a floating control. Retry is a small direct
  action; detailed status belongs on the server page, not another modal.
- Retain glass on functional floating controls. Do not add animated borders
  or separately measured decorative rims to resizing forms or the composer.

### Elevated surfaces

All of them go through `GlassSurface`, or `glassRim` when a `Pressable` needs
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
- Chrome with no blur target in scope backs itself with an opaque, window-
  aligned copy of the canvas, under the ordinary fill and rim, instead of
  falling through to the panel material alone. The blur is not decoration: it
  is the only thing hiding what scrolls beneath, and the panel fill is 7%
  white, so the fallback on its own left the transcript perfectly readable
  through the composer.
- That fallback is opaque, and the transparency has to come from a real blur or
  not at all. Measured on device: the pass-through needed before a surface
  looks like glass leaves sharp text behind it at ~11 levels of contrast, which
  is readable. Smearing it is precisely what the blur does, and `expo-blur`
  degrades to a plain translucent view without a `BlurTargetView` — so a
  surface either gets a target or gets an opaque one. There is nothing in
  between that both reads as glass and hides anything.
- A scrollable offers itself as that target, never the screen. `ScrollEdgeFrame`
  mounts one when its stack asks for it (`RouteStack blurBackdrop`), because it
  is the one component that can hold the line the target has to hold: it
  contains what gets blurred and excludes what does the blurring. It declines
  when a target is already overhead — the tab screens have one for the dock,
  and nesting targets is the same SIGSEGV as nesting a `BlurView` in its own.
- A surface that resizes gets a flat fill and a real border, nothing that has
  to measure itself. The composer grows with the draft, and a rim traced by a
  canvas or a gradient sized to the box lands a frame behind the resize and
  shears against the edge while you type. Drawn materials — refraction, sweep
  rims, `LiquidGlassButton` — belong on controls with a fixed size.
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

Any copy is shifted up by however far it sits below the window top, so it
*continues* the canvas rather than restarting it. A copy mounted under a
navigation header would otherwise jump back to the gradient's brightest colour
at the header's lower edge, leaving a band across the top of the screen.
`CanvasFill` does this measuring itself, and is what both `Screen` and
`BlurBackdropTarget` use.

Never give a `BlurTargetView` an `onLayout` prop. Its descendants then stop
receiving layout events entirely, which silently starves anything that sizes
itself that way — the Skia button simply renders nothing. Measure from a child
instead; the target's ref is a native instance without `measureInWindow`
anyway.

### Status

- Working: blue
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
- Preserve last-known content during reconnect and show a compact floating
  connection indicator.
- A blue-soft icon tile gives each row a stable visual anchor.
- Tapping a row opens its conversation at the newest content.
- Keep **New agent** as the only primary action. Its page chooses one
  of the server-advertised providers, a required space, and an explicit
  auto-approval setting without exposing terminal controls.
- Place **+ New Space** in the Spaces filter list, including when a connected
  device has no spaces yet. Space creation asks for an
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
- Open at the newest item and follow sent messages, received reply updates, tool
  updates, and assistant responses while the reader is at the bottom.
- Sending a message or an answer resumes following immediately. Re-pin after
  transcript, composer and keyboard layout changes so long messages and
  streaming markdown cannot push the newest content out of view.
- Scrolling into history pauses following and leaves position preservation to
  native anchoring. A small **Latest** action in the composer's existing top row
  returns to the bottom; scrolling back near the bottom also resumes following.
  Opening the keyboard alone must not interrupt history reading.
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
- Colour `diff` fences per line: green additions, red removals, blue hunk
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

- Use compact grouped rows with blue-soft icon tiles.
- Keep security claims specific: stored credentials, host-key verification,
  diagnostics, and app version.
- Do not include Appearance controls because the product is intentionally
  dark-only.

## Motion, feedback, and accessibility

- Use subtle press-scale and opacity feedback; avoid decorative animation.
- A push replaces what it covers outright, with no transition — the same thing
  the dock does when it swaps tabs. A cross-fade draws both screens at once,
  and ours share a canvas at the same brightness, so it reads as the screen
  being left refusing to go. A slide avoids that but costs 200-400ms that
  cannot be shortened from JavaScript.
- The change of place is a cut; the arrival is not. Once the new screen is up it
  settles into place over its own canvas — a 16dp step, gone in 200ms. Because
  it plays *after* the swap there is only ever one screen on show, so it costs
  nothing in legibility and the change still reads as movement rather than a
  jump cut. One definition, shared by dock changes, nested page changes, and Back:
  `features/navigation/screen-entrance.ts`.
- Forward navigation and replacements arrive from the right; Back arrives from
  the left, including a stack uncovered by closing another workflow. The stack's
  stable layout observes its active route key and focus, not form values or
  keyboard events. It does not remount pages or discard their drafts.
- Start stack arrivals, including returning to the dock, on the native opening
  `transitionEnd` event, not JS focus. Ordinary dock tab switches animate their
  committed content directly.
  Even `animation: 'none'` swaps Android fragments asynchronously; starting sooner
  moves the outgoing page and leaves the destination with almost no motion.
- Interrupted arrivals stop before a new one starts. Hidden stacks reset their
  offset, reduced motion skips the effect, and animations do not delay list rendering.
- Never animate a whole screen's opacity on Android. Alpha on a view group is
  applied to each child in turn rather than to the finished picture, so a screen
  at less than full opacity is one whose own layers show through each other —
  fading the chat in put the transcript *inside* the composer. Animate geometry
  instead, or pay for a hardware texture.
- Any route that can be pushed over another paints the canvas behind its own
  header. Headers are transparent, and a route's content starts below its
  header, so that band is one the route never covers — during a transition
  what shows through it is the screen being left, not the canvas. See
  `features/navigation/route-stack.tsx`.
- Frosted chrome may only sample a blur target on a screen whose arrival and
  departure are cuts. A `BlurTargetView` draws nothing from the moment its
  screen starts animating away, so its contents blink out while the screen is
  still visible; chrome outside the target keeps drawing, and the screen reads
  as having thrown its content away. A pushed route was disqualified outright
  until pushes became cuts — with `animation: 'none'` the blank lasts one
  frame, which is why the chat can carry a target again. Reintroducing a stack
  animation brings the bug back with it.
- Do not add `zIndex` where declaration order already gives the required
  ordering. The scroll edge fade belongs above the rows and below floating
  controls. React Native's Android `setZIndex` updates view-group drawing order;
  it is not a window-global `translationZ`. Inspect the complete composition
  when changing layering so a fade cannot dim the composer or dock.
- Press-scale belongs to controls that stand alone on the canvas. A row that
  fills its card edge to edge must not scale: shrinking it pulls the pressed
  highlight inwards and leaves the card showing down both sides.
- Use named phases rather than fake progress percentages.
- Keep approval, failure, working, and reconnect states visible until they are
  resolved.
- Support font scaling, screen readers, and at least 4.5:1 text contrast.
- Label every icon-only action.
- Respect reduced-motion preferences.
