# ADR 001: React Native product layer

## Context

The product is Android-first remote server management with a rich UI and future native SSH.

## Decision

Use React Native, TypeScript, Expo SDK 57, Expo Router, and a development build. Do not target Expo Go.

## Reasons

The UI can move quickly while native code owns SSH, PTY, and credentials.

## Consequences

The app requires a custom native build. Product screens stay in TypeScript.

## Rules

Do not replace Expo or React Native. Do not put SSH protocol details in UI code.
