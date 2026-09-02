# ADR 005: AI command safety

## Context

AI will help generate and explain commands. Unrestricted shell access is unsafe.

## Decision

AI proposes structured actions. A policy layer classifies risk. Destructive commands require explicit confirmation.

## Reasons

The model must not bypass application policy.

## Consequences

No AI execution in Phase 1. Settings only records the future constraint.

## Rules

Do not scatter safety checks across UI components. Keep policy in one layer.
