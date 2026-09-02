# Agent rules

1. Inspect existing code before changing it.
2. Implement the smallest coherent slice for the current phase.
3. Do not implement an interactive terminal or persist credentials until the current phase requires them.
4. Do not replace Expo, React Native, or TypeScript.
5. Do not add dependencies unless the current milestone needs them.
6. Keep UI on React Native primitives. No large design system.
7. Map native errors to typed application errors. Never show raw stack traces.
8. Run TypeScript, tests, and Android builds that cover the change.
9. Do not claim a feature works if it was not verified.
