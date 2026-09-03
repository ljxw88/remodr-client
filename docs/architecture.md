# Architecture

```text
React Native / TypeScript
        |
        | typed application APIs
        v
Domain / Service Layer
        |
        | typed native boundary
        v
Native Remote Core (`modules/remote-core`)
        |
        v
Android / Kotlin / SSHJ
```

React Native must not know how SSH works internally. UI talks to `RemoteClient`, `HostRepository`, and feature services.

Agent conversations are normalized by the Herdr bridge. Terminal rendering is
intentionally omitted from the mobile product surface.

Assistant replies are rendered as native markdown. See
[`markdown-rendering.md`](markdown-rendering.md) and
[ADR 009](adr/009-assistant-markdown-rendering.md).

Shader-backed visual effects use Skia. See
[`skia-effects.md`](skia-effects.md) and
[ADR 011](adr/011-skia-visual-effects.md).
