# ADR 011: Skia for visual effects

Status: accepted.

[Decision index](README.md) | [Current effects guide](../skia-effects.md)

## Context

The New Agent control called for refraction, edge dispersion, and animated
metal. A web SVG/WebGL design cannot directly sample React Native views.
Apple's native glass API does not implement this material on Android.

## Decision

Use `@shopify/react-native-skia` for scoped decorative controls. Draw the source
content, filter, and sharp foreground in one canvas. Use SkSL for per-pixel
edge behavior that cannot be expressed by one uniform displacement strength.

Keep the rest of the interface on shared native surfaces.

## Reasons

Skia provides runtime shaders and image filters without introducing a separate
WebGL render loop. Expo documents a compatible version of this Shopify library;
it is not an Expo-owned graphics implementation.

## Consequences

The filter only sees content in its own canvas, so the control must provide
the content it distorts. It cannot refract the native transcript behind it.

Animation needs explicit lifecycle management. The existing shader clock
pauses on blur/background and when disabled.

The resizing chat composer is not a shader surface. It uses ordinary backdrop
blur and native borders. Skia itself is available in Expo Go, but the full app
requires a custom build for `RemoteCore`.

## Rules

- Keep effects on individual controls, not across the entire app background.
- Clip filters and preserve premultiplied alpha.
- Mark a canvas opaque only when its actual contents justify it.
- Confirm shader/compiler and sizing behavior on the installed version.
- Inspect visuals and animation continuity on an Android target.
