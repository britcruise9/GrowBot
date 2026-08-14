import {
  createCreatureRuntime,
  type RuntimeEffect,
  type RuntimeSnapshot,
  type Soul,
} from '@growbot/creature-core';

import { ModelAdapterError, type ModelFailureKind } from '../model/openrouter-model';

type SoulStore = Readonly<{
  initialize(): Promise<void>;
  load(): Promise<Soul | null>;
  save(soul: Soul): Promise<void>;
}>;

type ModelAdapter = Readonly<{
  infer(request: Extract<RuntimeEffect, { type: 'infer' }>['request']): Promise<unknown>;
}>;

type VoiceAdapter = Readonly<{
  initialize(): Promise<unknown>;
  speak(text: string): Promise<void>;
}>;

export type CreatureControllerState = Readonly<{
  snapshot: RuntimeSnapshot;
  voiceStatus: 'checking' | 'local' | 'unavailable';
  startupError: string | null;
}>;

type Listener = (state: CreatureControllerState) => void;

function fallbackId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCreatureController({
  store,
  model,
  voice,
  createId = fallbackId,
  now = () => new Date().toISOString(),
}: Readonly<{
  store: SoulStore;
  model: ModelAdapter;
  voice: VoiceAdapter;
  createId?: () => string;
  now?: () => string;
}>) {
  const runtime = createCreatureRuntime();
  const listeners = new Set<Listener>();
  let state: CreatureControllerState = {
    snapshot: runtime.getSnapshot(),
    voiceStatus: 'checking',
    startupError: null,
  };

  function publish(snapshot = runtime.getSnapshot()): void {
    state = { ...state, snapshot };
    for (const listener of listeners) listener(state);
  }

  function dispatch(event: Parameters<typeof runtime.dispatch>[0]): void {
    const transition = runtime.dispatch(event);
    publish(transition.snapshot);
    for (const effect of transition.effects) void execute(effect);
  }

  async function execute(effect: RuntimeEffect): Promise<void> {
    switch (effect.type) {
      case 'persistSoul':
        try {
          await store.save(effect.soul);
          dispatch({ type: 'persistSucceeded', effectId: effect.effectId });
        } catch {
          dispatch({ type: 'persistFailed', effectId: effect.effectId });
        }
        return;
      case 'infer':
        try {
          const output = await model.infer(effect.request);
          dispatch({ type: 'modelSucceeded', effectId: effect.effectId, output });
        } catch (error) {
          const failure: ModelFailureKind =
            error instanceof ModelAdapterError ? error.kind : 'provider';
          dispatch({ type: 'modelFailed', effectId: effect.effectId, failure });
        }
        return;
      case 'speak':
        try {
          await voice.speak(effect.text);
          dispatch({ type: 'speechSucceeded', effectId: effect.effectId });
        } catch {
          dispatch({ type: 'speechFailed', effectId: effect.effectId });
        }
    }
  }

  return {
    getState: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize(): Promise<void> {
      const voiceInitialization = voice
        .initialize()
        .then(() => {
          state = { ...state, voiceStatus: 'local' };
          publish();
        })
        .catch(() => {
          state = { ...state, voiceStatus: 'unavailable' };
          publish();
        });

      try {
        await store.initialize();
        dispatch({ type: 'hydrated', soul: await store.load() });
      } catch {
        state = {
          ...state,
          startupError: 'GrowBot could not safely open its local memory.',
        };
        publish();
      }
      await voiceInitialization;
    },
    birth(name: string): void {
      if (!name.trim() || state.snapshot.phase !== 'unborn') return;
      const birthId = createId();
      dispatch({
        type: 'birthRequested',
        birthId,
        creatureId: birthId,
        name,
        at: now(),
      });
    },
    whisper(text: string): void {
      dispatch({
        type: 'utteranceRequested',
        interactionId: createId(),
        text,
        at: now(),
      });
    },
  };
}

export type CreatureController = ReturnType<typeof createCreatureController>;
