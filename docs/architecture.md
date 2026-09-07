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
    +-- HerdrRepository + durable CommandOutbox
            |
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
| Application state | [`herdr-repository.ts`](../src/services/herdr-repository.ts) | Per-device snapshots, transport routing, command dispatch/reconciliation, pending-message overlays |
| Conversations | [`conversation-store.ts`](../src/services/conversation-store.ts) | Authoritative transcripts, coalesced reads/restores, session epochs, ordered cache writes and invalidation |
| Durable sends | [`command-outbox.ts`](../src/services/command-outbox.ts) | Serialized local command persistence |
| Draft storage | [`draft-store.ts`](../src/services/draft-store.ts) | Per-agent ordered draft writes/removals and read-after-write failures |
| Composer drafts | [`use-persisted-draft.ts`](../src/features/agents/use-persisted-draft.ts) | Restore, input debounce, lifecycle flush, and revision-fenced send clearing |
| Conversation lifecycle | [`use-conversation-controller.ts`](../src/features/agents/use-conversation-controller.ts) | Offline restore, visible-chat refresh, retry, scoped errors and completion-read acknowledgement |
| Remote directories | [`use-remote-directory.ts`](../src/features/files/use-remote-directory.ts) | Normalized paths, focus/session-fenced SFTP reads, scoped loading/errors and mutation refresh tokens |
| Native client API | [`native-remote-client.ts`](../src/services/native-remote-client.ts) | Typed access to the local Expo module |
| Native resources | [`modules/remote-core/android/`](../modules/remote-core/android/) | SSH sessions, channels, SFTP, forwards, secrets, background service |
| Bridge runtime | [`remodr_bridge/`](../modules/remote-core/bridge/remodr_bridge/) | Herdr orchestration, protocol, durable commands, and shared session handling |
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
Its asynchronous `onRead` consumer lets the repository durably reconcile commands
once per coalesced read before that read resolves, with attachment/session fences
checked again afterward. Consumer failures propagate; only rebuildable cache I/O
degrades to diagnostics. Pending-message overlays remain repository-owned and
never enter the conversation cache.

Shared [protocol fixtures](../modules/remote-core/bridge/README.md#cross-language-protocol-fixtures)
tie synthetic production bridge output to the TypeScript schemas and session
helpers. The store also consumes the same session-replacement fixture, so its
invalidation behavior is constrained by the wire contract rather than only
store-specific mocks.

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

The conversation route assembles `ConversationMessageList` and
`ConversationComposer`, each with its own presentation styles. The list owns
rows, tool/plan display, empty states and the inverted native list; it forwards
measurements and gestures to the existing `useConversationScroll` controller.
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
