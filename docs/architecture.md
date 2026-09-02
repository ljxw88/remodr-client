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

PTY bytes are written to a native terminal view. They do not flow through React state.

AI proposes commands. A policy layer classifies risk. Destructive commands require confirmation.
