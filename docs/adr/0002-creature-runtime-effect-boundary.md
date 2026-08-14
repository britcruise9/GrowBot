# ADR 0002: Pure creature runtime with correlated effects

- Status: accepted for MVP 1
- Date: 2026-08-14

## Decision

`@growbot/creature-core` is a pure state-transition module. It accepts a current soul
and a domain event, then returns the next state and requested effects. The app-level
controller executes persistence, model, and speech effects and sends correlated result
events back into the runtime.

## Why

The creature's truth cannot depend on React timing, network callbacks, SQLite details,
or speech-engine quirks. A memory is visible in Story only after its persistence effect
succeeds. Birth is complete only after the initial soul is durably saved. Effect IDs
prevent late or duplicate callbacks from corrupting the active interaction.

Model output is untrusted input. The core accepts exactly one `say` field, rejects
off-menu shapes, and clamps speech length in code. Recent traces and durable episodic
memories are different concepts with different bounds.

## Consequences

Tests target the public event/effect contract instead of reducers or database rows.
UI modules render runtime state and emit intent; they do not build prompts, invent
memories, or write storage directly. New effects require an explicit runtime contract
and one real executor before they become extension points.
