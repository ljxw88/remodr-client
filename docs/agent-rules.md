# Contributor rules

[Documentation index](README.md)

These rules apply to agent-assisted changes as well as manual changes.

1. Read the relevant code and [SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/)
   before changing an Expo API. Installed package versions are in `package.json`.
2. Make a coherent change within the requested scope. Preserve existing user
   work and do not replace Expo, React Native, or TypeScript.
3. Keep SSH, host verification, and secret handling behind the native boundary.
   Do not add an interactive terminal or a generic bridge shell action.
4. Keep recovery in the per-device supervisor. Respect explicit disconnect,
   fatal authentication/trust errors, and the owning device of each request.
5. Preserve drafts, cached transcripts, and durable command IDs across retries.
   Never automatically replay a command whose side effect is uncertain.
6. Use React Native primitives and shared controls. Add dependencies only when
   the requested behavior needs them.
7. Use `GlassSurface`/`glassRim` for ordinary surfaces. Keep blur consumers
   outside their sampled target; follow the [glass decision](adr/012-frosted-glass-material.md).
8. Use [Skia guidance](skia-effects.md) for shader controls. Do not apply
   canvas-measured decorative rims to the resizing composer.
9. Render received message text immediately. Do not animate cached history or
   describe transcript polling as a live token event stream.
10. Surface errors according to their meaning. Transient connection loss belongs
    in automatic recovery and inline status, not repeated modal dialogs.
11. Do not log credentials, raw prompts, or full bridge request objects.
    Consult [security](security.md) before changing storage or diagnostic output.
12. Use targeted existing [checks](development.md#checks). Inspect visual changes
    on a device; distinguish emulator results from physical-device evidence.
13. Update the current guide when behavior changes and annotate affected ADRs.
    Documentation-only changes need factual and link/path review, not unrelated
    tests or builds.
