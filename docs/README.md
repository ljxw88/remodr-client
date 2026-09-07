# Remodr documentation

These guides describe the checked-in implementation. Architecture decision
records (ADRs) explain why it has that shape; their context is historical, not
a list of unfinished milestones.

## Start here

| Task | Guide |
| --- | --- |
| Install dependencies, build an APK, or run checks | [Development and builds](development.md) |
| Connect a physical phone to Metro while using SSH over a VPN | [Physical Android development](physical-android-development.md) |
| Understand component ownership and the data flow | [Architecture](architecture.md) |
| Understand bridge deployment, provider support, and protocol boundaries | [Herdr integration](herdr-mobile-architecture.md) |
| Configure OpenCode and understand the native API integration direction | [OpenCode integration](opencode-integration.md) |
| Refresh provider model lists, context limits, and reasoning settings | [Model catalogues](model-catalogues.md) |
| Change reconnect, outbox, or background behavior | [Connection resilience](connection-resilience.md) |
| Handle credentials, host trust, or persisted conversation data | [Security](security.md) |
| Change message formatting or snapshot rendering | [Markdown rendering](markdown-rendering.md) |
| Work on shader effects | [Skia effects](skia-effects.md) |
| Change creation, selection, settings, or keyboard behavior | [Page workflows](form-workflows.md) |
| Change the app icon or display branding | [App branding](app-branding.md) |
| Make a code change with an agent | [Contributor rules](agent-rules.md) |
| Find the rationale for an architectural choice | [ADR index](adr/README.md) |

The root [design guide](../DESIGN.md) and [color reference](../COLOR.md) describe
visual conventions. The [bridge contract](../modules/remote-core/bridge/README.md)
owns the wire envelope, journal limits, and command error definitions.

## Keeping these docs current

- Treat source and configuration as authoritative. Guides link to the files
  that own important behavior instead of reproducing entire implementations.
- Keep build commands in `development.md` and device routing in
  `physical-android-development.md`.
- Update current guides when behavior changes. For an ADR, retain useful
  decision context and mark any superseded assumption explicitly.
- Do not describe a developer's phone, server installation, or local address
  as a project requirement. Version observations are compatibility examples,
  not a guarantee about every provider release.
- A documentation-only change needs link/path and factual review, not an
  unrelated app rebuild.
