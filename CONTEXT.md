# GrowBot domain context

GrowBot is an embodied-AI creature whose phone supplies the mind and senses while an
optional body supplies physical action. The product should feel like a creature first
and reveal its open robot platform progressively.

## Ubiquitous language

- **Creature** — one persistent GrowBot with a particular identity and history.
- **Soul** — the creature's portable durable state: identity, goals, working memory,
  traces, and episodic memories. It is relationship data, not disposable cache.
- **Habitat** — the default living surface where the person encounters the creature.
- **Story** — the legible record of memories and, later, dreams and growth.
- **Workshop** — the advanced surface for capabilities, bodies, models, calibration,
  telemetry, and extensions.
- **Birth** — the first-run ritual that creates a creature and its initial soul.
- **Utterance** — words intentionally addressed by a person to the creature.
- **Response** — the creature's model-produced reply and requested actions.
- **Memory** — a bounded, meaningful record earned by a real exchange; idle time never
  earns a memory slot.
- **Effect** — a requested external action such as model inference, speech, persistence,
  or later movement. The runtime requests effects; adapters execute them.
- **Body truth** — the declared, validated verb and physical-capability contract exposed
  to the creature. Narration is never action.
- **CreatureRuntime** — the deep, pure TypeScript module whose interface accepts domain
  events and returns observable state transitions plus requested effects.

## Product invariants

1. The first experience is aliveness, not provider or robot configuration.
2. Only a real exchange earns a memory.
3. Model narration cannot directly cause physical action.
4. Identity ownership and physical safety are enforced in code, not prompt convention.
5. Habitat shows real state; Story shows real memories; Workshop exposes only real
   capabilities.
6. Local system speech is the zero-marginal-cost default. Premium speech remains
   optional.
7. Brit Cruise retains final project and deployment authority.
