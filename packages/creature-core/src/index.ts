export type Soul = Readonly<{
  creatureId: string;
  name: string;
  identity: string;
  traces: readonly Trace[];
  memories: readonly EpisodicMemory[];
}>;

export type Trace = Readonly<{
  interactionId: string;
  person: string;
  creature: string;
}>;

export type EpisodicMemory = Readonly<{
  id: string;
  interactionId: string;
  at: string;
  text: string;
}>;

export type RuntimeSnapshot = Readonly<{
  phase:
    | "hydrating"
    | "unborn"
    | "saving"
    | "ready"
    | "thinking"
    | "responding"
    | "speaking"
    | "remembering";
  soul: Soul | null;
  lastResponse?: string;
  notice?: Readonly<{ kind: "error" | "info"; message: string }> | undefined;
}>;

export type RuntimeEvent =
  | Readonly<{
      type: "hydrated";
      soul: Soul | null;
    }>
  | Readonly<{
      type: "birthRequested";
      birthId: string;
      creatureId: string;
      name: string;
      at: string;
    }>
  | Readonly<{
      type: "persistSucceeded";
      effectId: string;
    }>
  | Readonly<{
      type: "utteranceRequested";
      interactionId: string;
      text: string;
      at: string;
    }>
  | Readonly<{
      type: "modelSucceeded";
      effectId: string;
      output: unknown;
    }>
  | Readonly<{
      type: "modelFailed";
      effectId: string;
      failure:
        | "missing-key"
        | "network"
        | "rate-limited"
        | "provider"
        | "invalid-response";
    }>
  | Readonly<{
      type: "persistFailed";
      effectId: string;
    }>
  | Readonly<{
      type: "speechSucceeded";
      effectId: string;
    }>
  | Readonly<{
      type: "speechFailed";
      effectId: string;
    }>;

export type ModelRequest = Readonly<{
  creatureName: string;
  identity: string;
  utterance: string;
  recentTraces: readonly Trace[];
  recentMemories: readonly EpisodicMemory[];
}>;

export type RuntimeEffect =
  | Readonly<{
      type: "persistSoul";
      effectId: string;
      interactionId: string;
      soul: Soul;
    }>
  | Readonly<{
      type: "infer";
      effectId: string;
      interactionId: string;
      request: ModelRequest;
    }>
  | Readonly<{
      type: "speak";
      effectId: string;
      interactionId: string;
      text: string;
    }>;

export type RuntimeTransition = Readonly<{
  snapshot: RuntimeSnapshot;
  effects: readonly RuntimeEffect[];
}>;

export type CreatureRuntime = Readonly<{
  dispatch(event: RuntimeEvent): RuntimeTransition;
  getSnapshot(): RuntimeSnapshot;
}>;

type PendingInteraction = Readonly<{
  interactionId: string;
  utterance: string;
  at: string;
  inferEffectId: string;
}>;

function parseModelOutput(output: unknown):
  | Readonly<{ speech: string; diaryEntry?: string }>
  | null {
  if (typeof output !== "object" || output === null) return null;
  const candidate = output as {
    commands?: unknown;
    memory?: { diaryEntry?: unknown };
  };
  if (!Array.isArray(candidate.commands) || candidate.commands.length !== 1) {
    return null;
  }

  const command = candidate.commands[0] as {
    name?: unknown;
    args?: { text?: unknown };
  };
  if (
    command?.name !== "say" ||
    typeof command.args?.text !== "string" ||
    !command.args.text.trim()
  ) {
    return null;
  }

  const speech = command.args.text.trim().split(/\s+/u).slice(0, 18).join(" ");
  const rawDiary = candidate.memory?.diaryEntry;
  const diaryEntry =
    typeof rawDiary === "string" && rawDiary.trim()
      ? rawDiary.trim().slice(0, 280)
      : undefined;
  return diaryEntry === undefined ? { speech } : { speech, diaryEntry };
}

function modelFailureMessage(failure: Extract<RuntimeEvent, { type: "modelFailed" }>['failure']): string {
  switch (failure) {
    case "missing-key":
      return "Add an OpenRouter key in Workshop so I can answer.";
    case "network":
      return "I could not reach the network. Check your connection and try again.";
    case "rate-limited":
      return "OpenRouter asked me to slow down. Try again in a moment.";
    case "invalid-response":
      return "The model returned a thought this body could not understand.";
    case "provider":
      return "The model provider could not answer. Try again or choose another model.";
  }
}

export function createCreatureRuntime(): CreatureRuntime {
  let snapshot: RuntimeSnapshot = { phase: "hydrating", soul: null };
  let pendingPersistEffectId: string | null = null;
  let pendingPersistenceKind: "birth" | "interaction" | null = null;
  let pendingSpeechEffectId: string | null = null;
  let pendingCandidateSoul: Soul | null = null;
  let pendingInteraction: PendingInteraction | null = null;

  return {
    dispatch(event) {
      if (event.type === "hydrated") {
        if (snapshot.phase !== "hydrating") {
          return { snapshot, effects: [] };
        }
        snapshot = {
          phase: event.soul === null ? "unborn" : "ready",
          soul: event.soul,
        };

        return { snapshot, effects: [] };
      }

      if (event.type === "persistSucceeded") {
        if (event.effectId !== pendingPersistEffectId) {
          return { snapshot, effects: [] };
        }

        pendingPersistEffectId = null;
        pendingPersistenceKind = null;
        if (pendingCandidateSoul !== null) {
          snapshot = { ...snapshot, soul: pendingCandidateSoul };
          pendingCandidateSoul = null;
        }
        snapshot = {
          ...snapshot,
          phase: pendingSpeechEffectId === null ? "ready" : "speaking",
        };
        return { snapshot, effects: [] };
      }

      if (event.type === "persistFailed") {
        if (event.effectId !== pendingPersistEffectId) {
          return { snapshot, effects: [] };
        }

        const wasBirth = pendingPersistenceKind === "birth";
        pendingPersistEffectId = null;
        pendingPersistenceKind = null;
        pendingCandidateSoul = null;
        snapshot = wasBirth
          ? {
              phase: "unborn",
              soul: null,
              notice: {
                kind: "error",
                message: "I could not save this creature. Free some space and try again.",
              },
            }
          : {
              ...snapshot,
              phase: pendingSpeechEffectId === null ? "ready" : "speaking",
              notice: {
                kind: "error",
                message: "I answered, but could not safely remember this exchange.",
              },
            };
        return { snapshot, effects: [] };
      }

      if (event.type === "speechSucceeded" || event.type === "speechFailed") {
        if (event.effectId !== pendingSpeechEffectId) {
          return { snapshot, effects: [] };
        }

        pendingSpeechEffectId = null;
        snapshot = {
          ...snapshot,
          phase: pendingPersistEffectId === null ? "ready" : "remembering",
          ...(event.type === "speechFailed"
            ? {
                notice: {
                  kind: "error" as const,
                  message: "I found the words, but this phone could not speak them aloud.",
                },
              }
            : {}),
        };
        return { snapshot, effects: [] };
      }

      if (event.type === "utteranceRequested") {
        const utterance = event.text.trim();
        if (snapshot.phase !== "ready" || snapshot.soul === null || !utterance) {
          return { snapshot, effects: [] };
        }

        const soul = snapshot.soul;
        const inferEffectId = `${event.interactionId}:infer`;
        pendingInteraction = {
          interactionId: event.interactionId,
          utterance,
          at: event.at,
          inferEffectId,
        };
        snapshot = { ...snapshot, phase: "thinking", notice: undefined };
        return {
          snapshot,
          effects: [
            {
              type: "infer",
              effectId: inferEffectId,
              interactionId: event.interactionId,
              request: {
                creatureName: soul.name,
                identity: soul.identity,
                utterance,
                recentTraces: soul.traces.slice(-8),
                recentMemories: soul.memories.slice(-5),
              },
            },
          ],
        };
      }

      if (event.type === "modelSucceeded") {
        if (
          pendingInteraction === null ||
          event.effectId !== pendingInteraction.inferEffectId ||
          snapshot.soul === null
        ) {
          return { snapshot, effects: [] };
        }

        const parsed = parseModelOutput(event.output);
        if (parsed === null) {
          pendingInteraction = null;
          snapshot = {
            ...snapshot,
            phase: "ready",
            notice: {
              kind: "error",
              message: "I could not turn that thought into something this body can do.",
            },
          };
          return { snapshot, effects: [] };
        }

        const interaction = pendingInteraction;
        const memory = parsed.diaryEntry
          ? [
              ...snapshot.soul.memories,
              {
                id: `${interaction.interactionId}:memory`,
                interactionId: interaction.interactionId,
                at: interaction.at,
                text: parsed.diaryEntry,
              },
            ]
          : snapshot.soul.memories;
        pendingCandidateSoul = {
          ...snapshot.soul,
          traces: [
            ...snapshot.soul.traces,
            {
              interactionId: interaction.interactionId,
              person: interaction.utterance,
              creature: parsed.speech,
            },
          ],
          memories: memory,
        };
        pendingPersistEffectId = `${interaction.interactionId}:persist`;
        pendingPersistenceKind = "interaction";
        pendingSpeechEffectId = `${interaction.interactionId}:speak`;
        pendingInteraction = null;
        snapshot = {
          ...snapshot,
          phase: "responding",
          lastResponse: parsed.speech,
          notice: undefined,
        };
        return {
          snapshot,
          effects: [
            {
              type: "persistSoul",
              effectId: pendingPersistEffectId,
              interactionId: interaction.interactionId,
              soul: pendingCandidateSoul,
            },
            {
              type: "speak",
              effectId: pendingSpeechEffectId,
              interactionId: interaction.interactionId,
              text: parsed.speech,
            },
          ],
        };
      }

      if (event.type === "modelFailed") {
        if (
          pendingInteraction === null ||
          event.effectId !== pendingInteraction.inferEffectId
        ) {
          return { snapshot, effects: [] };
        }

        pendingInteraction = null;
        snapshot = {
          ...snapshot,
          phase: "ready",
          notice: { kind: "error", message: modelFailureMessage(event.failure) },
        };
        return { snapshot, effects: [] };
      }

      if (snapshot.phase !== "unborn" || !event.name.trim()) {
        return { snapshot, effects: [] };
      }

      const soul: Soul = {
        creatureId: event.creatureId,
        name: event.name.trim(),
        identity: "I am small, alert, and willing to try.",
        traces: [],
        memories: [],
      };
      snapshot = { phase: "saving", soul };
      pendingPersistEffectId = `${event.birthId}:persist`;
      pendingPersistenceKind = "birth";
      pendingCandidateSoul = soul;

      return {
        snapshot,
        effects: [
          {
            type: "persistSoul",
            effectId: pendingPersistEffectId,
            interactionId: event.birthId,
            soul,
          },
        ],
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
