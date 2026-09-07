# Architecture

[Documentation index](README.md)

Remodr is an Android conversation client for coding agents managed by Herdr.
React Native owns the interface, Kotlin owns SSH resources, and a deployed
Python bridge translates Herdr/provider data into the app's models. The product
has no interactive terminal.

```text
Expo Router screens
    |
    +-- connection supervisor and lifecycle signals
    |
    +-- HerdrRepository
            |
            +-- CommandDispatcher -> durable CommandOutbox
            +-- ConversationStore (transcripts, session fences, disk cache)
            +-- DraftStore (ordered draft persistence)
            |
            +-- HerdrBridgeTransport (NDJSON)
                    |
                    +-- RemoteCore / SessionManager / SSHJ
                            |
                            +-- Python bridge over non-PTY SSH exec
                                    |
                                    +-- Herdr Unix socket
                                    +-- provider transcript files
```

## Ownership

| Layer | Source | Responsibility |
| --- | --- | --- |
| Screens | [`src/app/`](../src/app/) | Agents, conversations, server setup, files, monitoring, Docker, tunnels |
| Domain | [`src/domain/`](../src/domain/) | Validated host, agent, conversation, error, and model-choice data |
| Retuning availability | [`agent-capabilities.ts`](../src/domain/agent-capabilities.ts) | Client implementation and reported agent capability intersection, including legacy compatibility |
| Recovery | [`connection-supervisor.ts`](../src/features/connection/connection-supervisor.ts) | Per-device attempts, health checks, backoff, and cancellation |
| Lifecycle | [`use-connection-lifecycle.ts`](../src/features/connection/use-connection-lifecycle.ts) | Network, foreground, and confirmed service state |
| Runtime adapter | [`connect-runtime.ts`](../src/features/agents/connect-runtime.ts) | Saved hosts, explicit device selection, supervisor/native wiring |
| Application state | [`herdr-repository.ts`](../src/services/herdr-repository.ts) | Per-device snapshots, transport routing, command intent validation, pending-message overlays |
| Conversations | [`conversation-store.ts`](../src/services/conversation-store.ts) | Authoritative transcripts, coalesced reads/restores, session epochs, ordered cache writes and invalidation |
| Durable sends | [`command-outbox.ts`](../src/services/command-outbox.ts) | Serialized local command persistence |
| Command delivery | [`command-dispatcher.ts`](../src/services/command-dispatcher.ts) | Per-device scheduling, dispatch, retry/uncertainty, receipt reconciliation and endpoint invalidation |
| Draft storage | [`draft-store.ts`](../src/services/draft-store.ts) | Per-agent ordered draft writes/removals and read-after-write failures |
| Composer drafts | [`use-persisted-draft.ts`](../src/features/agents/use-persisted-draft.ts) | Restore, input debounce, lifecycle flush, and revision-fenced send clearing |
| Conversation lifecycle | [`use-conversation-controller.ts`](../src/features/agents/use-conversation-controller.ts) | Offline restore, visible-chat refresh, retry, scoped errors and completion-read acknowledgement |
| Remote directories | [`use-remote-directory.ts`](../src/features/files/use-remote-directory.ts) | Normalized paths, focus/session-fenced SFTP reads, scoped loading/errors and mutation refresh tokens |
| Native client API | [`native-remote-client.ts`](../src/services/native-remote-client.ts) | Typed access to the local Expo module |
| Native resources | [`modules/remote-core/android/`](../modules/remote-core/android/) | SSH sessions, channels, SFTP, forwards, secrets, background service |
| Bridge runtime | [`remodr_bridge/`](../modules/remote-core/bridge/remodr_bridge/) | Herdr orchestration, protocol, durable commands, and shared session handling |
| Bridge sessions | [`session_registry.py`](../modules/remote-core/bridge/remodr_bridge/session_registry.py) | Typed session bindings, identity/launch metadata, scoped caches and question ownership |
| Provider adapters | [`providers/`](../modules/remote-core/bridge/remodr_bridge/providers/) | Provider-specific launch settings, session identity, and transcript readers |

External stores expose snapshots through `useSyncExternalStore`. There is one
runtime/transport per connected device. The selected-device fields are derived
views; agent requests use their owning device, not whichever device is selected.

The supervisor controls recovery policy. Screens do not create independent
retry loops. Native attempt generations prevent obsolete work from replacing a
newer session. Remote agent lifetime remains independent of mobile attachment.

`ConversationStore` receives a narrow source interface: current agent lookup and
a request handle with read, attachment assertion, and identity-refresh operations.
It does not receive the repository, device maps, transport lifecycle controls,
or outbox. The repository installs runtime changes before notifying the store;
detaching an attachment releases pending-read coalescing without deleting history.

The store publishes authoritative snapshots independently of cache writes.
Its asynchronous `onRead` consumer lets `CommandDispatcher` durably reconcile commands
once per coalesced read before that read resolves, with attachment/session fences
checked again afterward. Consumer failures propagate; only rebuildable cache I/O
degrades to diagnostics. Pending-message overlays remain repository-owned and
never enter the conversation cache.

`CommandDispatcher` receives the durable outbox and a narrow source/effects
interface, not the repository or device maps. Attachment handles fence the
captured transport generation, while the repository retains connection lifecycle
and message/question validation. The dispatcher owns all queue timers and flush
coalescing, reads authoritative baselines, and publishes optimistic working
status only after the local ACK write succeeds. Detach cancels scheduling without
discarding durable sends; live interrupts remain outside the enqueue API.

Shared [protocol fixtures](../modules/remote-core/bridge/README.md#cross-language-protocol-fixtures)
tie synthetic production bridge output to the TypeScript schemas and session
helpers. The store also consumes the same session-replacement fixture, so its
invalidation behavior is constrained by the wire contract rather than only
store-specific mocks.

The Python bridge similarly keeps session-owned memory in `SessionRegistry`.
Providers use explicit registry operations and read-only runtime views instead
of mutating host dictionaries or taking its state lock. The registry has no
bridge reference or I/O; bridge refresh locks still serialize multi-step
identity/read operations. See the [session ownership and lock contract](../modules/remote-core/bridge/README.md#session-ownership-and-locks).

## Navigation and presentation

The tab shell uses Expo Router's headless `Tabs`/`TabSlot` with a custom
floating dock, not native tab-bar controls. Feature routes use `RouteStack`.
Native stack animation is `none`; shared entrance motion runs inside each
screen over its own background. `AppBackground` and `CanvasFill` paint
window-aligned copies where a surface needs to cover a previous route.

Shared UI lives in [`src/components/ui/`](../src/components/ui/).
`GlassSurface` and `glassRim` own ordinary frosted surfaces; selected fixed-size
controls use Skia effects. `FormPage` owns keyboard-safe workflow pages and
`ActionMenu` owns small anchored action menus. See [page workflows](form-workflows.md).

Conversation items remain semantic models until they reach the UI. Markdown
renders as native views, and the latest received text appears immediately.
Structured questions use `HumanRequestBar` above the composer; resolved
questions remain in the transcript.

The conversation route assembles `ConversationMessageList`,
`ConversationActivityPanel`, and `ConversationComposer`, each with its own
presentation styles. The list owns message rows, empty states and the inverted
native list; tools and plan snapshots are filtered out before virtualization, not
rendered as empty rows. It forwards
measurements and gestures to the existing `useConversationScroll` controller.
Below the context row, a thin horizontal section contains separate Plan and Tools
glass chips. The section floats over the transcript as a sibling of its blur
target: the conversation continues behind and between the controls rather than
starting beneath a full-width header strip. The section and horizontal scroller
have transparent backgrounds, with no added navigation divider or outer fill.
Soft shadows belong only to the individual chip/panel silhouettes; shared chrome
glass blurs the content beneath those surfaces. Expanded panels use
The home Device/Space filters and activity controls share `ChipGeometry`: 38dp
outer height, 12dp side padding and 4dp inline gaps. The activity heading subtracts
its rim from that height so expanded and collapsed label baselines match.
The panel retains 8dp bottom viewport spacing and compact corners. Both collapsed chips and expanded
panels share the same top surface inset, and retain an inset
collapse control. Selecting one replaces the chips with its bounded floating
glass panel; it is not a navigation control or modal. A measured transcript
footer inset (the top in an inverted list) keeps the oldest messages reachable
below the overlay. Resets publish collapsed clearance before native layout, and
removed activity clears it; old expanded measurements cannot survive a session
or visibility change. The collapsed scroller shrink-wraps its chips, capped at
the available width, so its transparent remainder does not intercept transcript
touches. The panels use the shared `GlassSurface` material, with no
nested plan card or opaque full-width bar.
Each list is inverted with newest/bottom data first, so it opens at the bottom
without a delayed scroll. Native anchoring follows new content near the bottom
and preserves a reader inspecting older rows. Only the latest actual
`todo_update` is shown; an empty update clears the plan. Tool failures have a
quiet chip indicator and explicit row labels. Disclosure chevrons lead the label
at the left in both states. Shared row geometry keeps the label vertically aligned
across expansion; the expanded heading centers its title between equal-width
leading/trailing groups that flex equally as counts or font sizes change.
List rows align their status markers beneath the category icon; the right row
padding includes the same disclosure-column inset to balance the visible edges.
Running spinners and static markers share a 14dp footprint. Tool status belongs
to the title row, leaving the description free to use the full text column.
No additional gap below the heading enlarges its band. Caption
typography remains 12sp/18sp line height, including plan steps and tool text.
The heading/collapse control
and native Back restore the chips; route/session changes, blur/background, and
viewport changes reset the section. The composer remains independently anchored.
The heading is a normal-flow Pressable, not an absolute touch/tint layer.
The inverted list sits in its own clipped viewport directly below the heading,
so scrolling rows cannot draw or receive touches through the heading. Opening
at the bottom can leave an older row partially visible at the viewport's top;
that row remains fully reachable by scrolling.
The semantic conversation store is unchanged.
The composer receives input/send/model callbacks and a question-bar slot, rather
than importing repository operations. The route retains agent actions, durable
send handling, and the shared enqueue guard used by typed and structured answers.

`useConversationController` depends only on conversation restore/read and
completion-receipt methods. It preserves the shared in-flight refresh gate and
cadence while stopping callbacks on blur, background, disconnection or identity
change. Errors belong to a route/session, and a late receipt failure cannot
replace the outcome of a newer refresh.

File management and folder selection share `useRemoteDirectory`, not a common
page. It depends only on native session lookup and directory listing, filters
navigation entries, and preserves folder-first/non-hidden-first sorting. The
picker requests directories only; the file manager also shows files and retains
its own create/delete controls. Each page still determines whether its owning
connection is eligible for browsing.

## Detailed guides

- [Herdr integration and provider support](herdr-mobile-architecture.md)
- [Recovery, durable delivery, and background limits](connection-resilience.md)
- [Storage and host trust](security.md)
- [Markdown rendering](markdown-rendering.md)
- [Skia effects](skia-effects.md)
- [Design decisions](adr/README.md)
