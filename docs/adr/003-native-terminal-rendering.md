# ADR 003: Native terminal rendering

## Context

Interactive shells need a real terminal emulator. React state cannot carry a byte stream.

## Decision

PTY bytes go native emulator → native view → React Native screen. React owns session chrome only.

## Reasons

`setTerminalText(prev => prev + chunk)` cannot support vim, tmux, or htop.

## Consequences

Terminal work waits until Phase 4. Do not build an emulator from scratch.

## Rules

Do not route live terminal output through React state.
