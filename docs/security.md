# Security

- Never store passwords, private keys, passphrases, or API tokens in plaintext.
- Host persistence stores metadata only (`name`, `hostname`, `port`, `username`, `authType`).
- `authType` is a planned method, not a secret.
- Passwords are passed to native code at connect time and are never written to AsyncStorage, logs, or source.
- Do not log secrets or objects that may contain them. Use `redactSecrets` if an object might contain credentials.
- Never silently trust SSH host keys. Phase 2 requires an explicit session trust; known-host persistence belongs in Phase 3.
- AI must propose actions; the app decides whether they run. Destructive commands require confirmation.
