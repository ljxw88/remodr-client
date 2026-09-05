# Architecture decisions

[Documentation index](../README.md)

ADRs record decisions and their context. An accepted decision can have later
implementation changes; the linked current guides describe those changes.
Numbering gaps are retained so existing references do not change.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-react-native-product-layer.md) | React Native product layer | Accepted; implemented |
| [002](002-native-remote-core.md) | Kotlin remote core | Accepted; implemented |
| [004](004-secure-credential-storage.md) | Initial credential-storage boundary | Superseded by 007 |
| [006](006-host-metadata-persistence.md) | Versioned host metadata repository | Accepted |
| [007](007-known-hosts-and-secrets.md) | Persistent host trust and encrypted secrets | Accepted; implemented |
| [008](008-herdr-mobile-bridge.md) | SSH-exec Python bridge | Accepted; extended by 010 and 015 |
| [009](009-assistant-markdown-rendering.md) | Custom native Markdown rendering | Accepted; snapshot display has no typewriter effect |
| [010](010-multi-device-herdr-runtime.md) | Per-device runtimes | Accepted; recovery policy defined by 015 |
| [011](011-skia-visual-effects.md) | Skia for scoped visual effects | Accepted |
| [012](012-frosted-glass-material.md) | Shared frosted material | Accepted; rims use native borders |
| [013](013-hand-rolled-bottom-sheets.md) | Project-owned modal sheets | Superseded by 016 |
| [014](014-answering-agent-questions.md) | Questions above the composer | Accepted; delivery follows 015 |
| [015](015-connection-recovery.md) | Supervised recovery and durable commands | Accepted; implemented |
| [016](016-page-first-navigation.md) | Page workflows and contextual menus | Accepted |

When a decision changes, record the new decision and link it from the old one.
Do not turn an old planning statement into a claim that a shipped feature is
still unimplemented.
