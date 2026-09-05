# Architecture

[Documentation index](README.md)

remodr is an Android conversation client for coding agents managed by Herdr.
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
| Recovery | [`connection-supervisor.ts`](../src/features/connection/connection-supervisor.ts) | Per-device attempts, health checks, backoff, and cancellation |
| Lifecycle | [`use-connection-lifecycle.ts`](../src/features/connection/use-connection-lifecycle.ts) | Network, foreground, and confirmed service state |
| Runtime adapter | [`connect-runtime.ts`](../src/features/agents/connect-runtime.ts) | Saved hosts, explicit device selection, supervisor/native wiring |
| Application state | [`herdr-repository.ts`](../src/services/herdr-repository.ts) | Per-device snapshots, conversation cache, pending-message overlays |
| Durable sends | [`command-outbox.ts`](../src/services/command-outbox.ts) | Serialized local command persistence |
| Native client API | [`native-remote-client.ts`](../src/services/native-remote-client.ts) | Typed access to the local Expo module |
| Native resources | [`modules/remote-core/android/`](../modules/remote-core/android/) | SSH sessions, channels, SFTP, forwards, secrets, background service |
| Bridge | [`herdr_mobile_bridge.py`](../modules/remote-core/bridge/herdr_mobile_bridge.py) | Herdr calls, provider adapters, durable command journal |

External stores expose snapshots through `useSyncExternalStore`. There is one
runtime/transport per connected device. The selected-device fields are derived
views; agent requests use their owning device, not whichever device is selected.

The supervisor controls recovery policy. Screens do not create independent
retry loops. Native attempt generations prevent obsolete work from replacing a
newer session. Remote agent lifetime remains independent of mobile attachment.

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

## Detailed guides

- [Herdr integration and provider support](herdr-mobile-architecture.md)
- [Recovery, durable delivery, and background limits](connection-resilience.md)
- [Storage and host trust](security.md)
- [Markdown rendering](markdown-rendering.md)
- [Skia effects](skia-effects.md)
- [Design decisions](adr/README.md)
