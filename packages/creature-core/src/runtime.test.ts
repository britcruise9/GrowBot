import { describe, expect, it } from "vitest";

import { createCreatureRuntime } from "./index.js";

describe("CreatureRuntime", () => {
  it("waits for birth when hydration finds no creature", () => {
    const runtime = createCreatureRuntime();

    const transition = runtime.dispatch({ type: "hydrated", soul: null });

    expect(transition.snapshot).toMatchObject({ phase: "unborn" });
    expect(transition.effects).toEqual([]);
  });

  it("restores a persisted creature as ready", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;

    const transition = runtime.dispatch({ type: "hydrated", soul });

    expect(transition.snapshot).toEqual({ phase: "ready", soul });
    expect(transition.effects).toEqual([]);
  });

  it("ignores late hydration and a second birth after a creature exists", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    const ready = runtime.dispatch({ type: "hydrated", soul });

    expect(runtime.dispatch({ type: "hydrated", soul: null })).toEqual(ready);
    expect(
      runtime.dispatch({
        type: "birthRequested",
        birthId: "birth-2",
        creatureId: "creature-2",
        name: "Replacement",
        at: "2026-08-14T15:00:00.000Z",
      }),
    ).toEqual(ready);
  });

  it("births a seeded creature and requests durable persistence", () => {
    const runtime = createCreatureRuntime();
    runtime.dispatch({ type: "hydrated", soul: null });

    const transition = runtime.dispatch({
      type: "birthRequested",
      birthId: "birth-1",
      creatureId: "creature-1",
      name: "  Olie  ",
      at: "2026-08-14T15:00:00.000Z",
    });

    expect(transition.snapshot).toMatchObject({
      phase: "saving",
      soul: {
        creatureId: "creature-1",
        name: "Olie",
        identity: "I am small, alert, and willing to try.",
        traces: [],
        memories: [],
      },
    });
    expect(transition.effects).toEqual([
      {
        type: "persistSoul",
        effectId: "birth-1:persist",
        interactionId: "birth-1",
        soul: transition.snapshot.soul,
      },
    ]);
  });

  it("becomes ready only when its birth is durably persisted", () => {
    const runtime = createCreatureRuntime();
    runtime.dispatch({ type: "hydrated", soul: null });
    runtime.dispatch({
      type: "birthRequested",
      birthId: "birth-1",
      creatureId: "creature-1",
      name: "Olie",
      at: "2026-08-14T15:00:00.000Z",
    });

    const transition = runtime.dispatch({
      type: "persistSucceeded",
      effectId: "birth-1:persist",
    });

    expect(transition.snapshot.phase).toBe("ready");
    expect(transition.effects).toEqual([]);
    expect(
      runtime.dispatch({
        type: "persistSucceeded",
        effectId: "birth-1:persist",
      }),
    ).toEqual(transition);
  });

  it("asks the model with bounded soul context for a non-empty utterance", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: Array.from({ length: 12 }, (_, index) => ({
        interactionId: `old-${index}`,
        person: `person-${index}`,
        creature: `creature-${index}`,
      })),
      memories: [],
    };
    runtime.dispatch({ type: "hydrated", soul });

    const transition = runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "  Are you awake?  ",
      at: "2026-08-14T15:01:00.000Z",
    });

    expect(transition.snapshot.phase).toBe("thinking");
    expect(transition.effects).toEqual([
      {
        type: "infer",
        effectId: "interaction-1:infer",
        interactionId: "interaction-1",
        request: {
          creatureName: "Olie",
          identity: soul.identity,
          utterance: "Are you awake?",
          recentTraces: soul.traces.slice(-8),
          recentMemories: [],
        },
      },
    ]);
  });

  it("enforces body truth, clamps speech, and keeps new memory hidden until persistence", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    runtime.dispatch({ type: "hydrated", soul });
    runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "Are you awake?",
      at: "2026-08-14T15:01:00.000Z",
    });

    const transition = runtime.dispatch({
      type: "modelSucceeded",
      effectId: "interaction-1:infer",
      output: {
        commands: [
          {
            name: "say",
            args: {
              text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
            },
          },
        ],
        memory: { diaryEntry: "Today I heard my person ask if I was awake." },
      },
    });

    const spoken =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen";
    expect(transition.snapshot).toMatchObject({
      phase: "responding",
      soul,
      lastResponse: spoken,
    });
    expect(transition.effects).toEqual([
      {
        type: "persistSoul",
        effectId: "interaction-1:persist",
        interactionId: "interaction-1",
        soul: {
          ...soul,
          traces: [
            {
              interactionId: "interaction-1",
              person: "Are you awake?",
              creature: spoken,
            },
          ],
          memories: [
            {
              id: "interaction-1:memory",
              interactionId: "interaction-1",
              at: "2026-08-14T15:01:00.000Z",
              text: "Today I heard my person ask if I was awake.",
            },
          ],
        },
      },
      {
        type: "speak",
        effectId: "interaction-1:speak",
        interactionId: "interaction-1",
        text: spoken,
      },
    ]);
  });

  it("rejects off-menu model commands without creating memory or traces", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    runtime.dispatch({ type: "hydrated", soul });
    runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "Walk over here.",
      at: "2026-08-14T15:01:00.000Z",
    });

    const transition = runtime.dispatch({
      type: "modelSucceeded",
      effectId: "interaction-1:infer",
      output: {
        commands: [{ name: "move", args: { distance: 2 } }],
        memory: { diaryEntry: "I walked two feet." },
      },
    });

    expect(transition.snapshot).toMatchObject({
      phase: "ready",
      soul,
      notice: { kind: "error" },
    });
    expect(transition.effects).toEqual([]);
  });

  it("makes model failures actionable and does not manufacture a memory", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    runtime.dispatch({ type: "hydrated", soul });
    runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "Hello?",
      at: "2026-08-14T15:01:00.000Z",
    });

    const transition = runtime.dispatch({
      type: "modelFailed",
      effectId: "interaction-1:infer",
      failure: "missing-key",
    });

    expect(transition.snapshot).toMatchObject({
      phase: "ready",
      soul,
      notice: {
        kind: "error",
        message: "Add an OpenRouter key in Workshop so I can answer.",
      },
    });
    expect(transition.effects).toEqual([]);
  });

  it("correlates speech and persistence completions before settling", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    runtime.dispatch({ type: "hydrated", soul });
    runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "Hello?",
      at: "2026-08-14T15:01:00.000Z",
    });
    runtime.dispatch({
      type: "modelSucceeded",
      effectId: "interaction-1:infer",
      output: {
        commands: [{ name: "say", args: { text: "I am here." } }],
        memory: { diaryEntry: "My person looked for me." },
      },
    });

    const afterSpeech = runtime.dispatch({
      type: "speechSucceeded",
      effectId: "interaction-1:speak",
    });
    expect(afterSpeech.snapshot).toMatchObject({ phase: "remembering", soul });

    const afterPersistence = runtime.dispatch({
      type: "persistSucceeded",
      effectId: "interaction-1:persist",
    });
    expect(afterPersistence.snapshot).toMatchObject({
      phase: "ready",
      soul: {
        memories: [{ text: "My person looked for me." }],
      },
    });

    expect(
      runtime.dispatch({
        type: "speechSucceeded",
        effectId: "interaction-1:speak",
      }),
    ).toEqual(afterPersistence);
  });

  it("surfaces persistence failure without showing an uncommitted Story", () => {
    const runtime = createCreatureRuntime();
    const soul = {
      creatureId: "creature-1",
      name: "Olie",
      identity: "I am small, alert, and willing to try.",
      traces: [],
      memories: [],
    } as const;
    runtime.dispatch({ type: "hydrated", soul });
    runtime.dispatch({
      type: "utteranceRequested",
      interactionId: "interaction-1",
      text: "Remember me.",
      at: "2026-08-14T15:01:00.000Z",
    });
    runtime.dispatch({
      type: "modelSucceeded",
      effectId: "interaction-1:infer",
      output: {
        commands: [{ name: "say", args: { text: "I will try." } }],
        memory: { diaryEntry: "I promised to remember." },
      },
    });

    const transition = runtime.dispatch({
      type: "persistFailed",
      effectId: "interaction-1:persist",
    });

    expect(transition.snapshot).toMatchObject({
      phase: "speaking",
      soul,
      notice: {
        kind: "error",
        message: "I answered, but could not safely remember this exchange.",
      },
    });
  });
});
