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
