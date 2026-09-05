# ADR 001: React Native product layer

Status: accepted; implemented.

[Decision index](README.md) | [Current architecture](../architecture.md)

## Context

The product needed an Android interface for remote server and agent workflows,
with a native boundary for SSH and credentials.

## Decision

Use React Native, TypeScript, Expo SDK 57, Expo Router, and a development build.
Keep product screens in TypeScript and native transport details out of them.

## Consequences

The shipped product is an Android conversation client with supporting server
tools, not an interactive terminal. `RemoteCore` requires a custom native build;
Expo Go cannot run the complete app.

The tab shell uses headless Expo Router components and a custom dock. It is
not a native tab-bar implementation. Exact versions and build commands belong
in [`package.json`](../../package.json) and the
[development guide](../development.md).
