import { describe, expect, it, vi } from 'vitest';
import type { Soul } from '@growbot/creature-core';

import { createCreatureController } from './creature-controller';

describe('native creature journey', () => {
  it('wakes, answers, speaks, remembers, and restores through the controller boundary', async () => {
    let persisted: Soul | null = null;
    const store = {
      initialize: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      save: vi.fn(async (soul) => {
        persisted = soul;
      }),
    };
    const model = {
      infer: vi.fn(async () => ({
        commands: [{ name: 'say', args: { text: 'I am awake with you.' } }],
        memory: { diaryEntry: 'I woke when my person whispered.' },
      })),
    };
    const voice = {
      initialize: vi.fn(async () => undefined),
      speak: vi.fn(async () => undefined),
    };
    const controller = createCreatureController({
      store,
      model,
      voice,
      createId: vi.fn().mockReturnValueOnce('creature-1').mockReturnValueOnce('interaction-1'),
      now: () => '2026-08-14T15:00:00.000Z',
    });

    await controller.initialize();
    expect(controller.getState().snapshot.phase).toBe('unborn');

    controller.birth('Olie');
    await vi.waitFor(() => expect(controller.getState().snapshot.phase).toBe('ready'));
    controller.whisper('Are you awake?');
    await vi.waitFor(() =>
      expect(controller.getState().snapshot).toMatchObject({
        phase: 'ready',
        lastResponse: 'I am awake with you.',
        soul: { memories: [{ text: 'I woke when my person whispered.' }] },
      }),
    );

    expect(voice.speak).toHaveBeenCalledWith('I am awake with you.');
    expect(persisted).toMatchObject({ name: 'Olie', memories: [{ interactionId: 'interaction-1' }] });

    const restoredController = createCreatureController({
      store: {
        initialize: vi.fn(async () => undefined),
        load: vi.fn(async () => persisted),
        save: vi.fn(async () => undefined),
      },
      model,
      voice,
    });
    await restoredController.initialize();
    expect(restoredController.getState().snapshot).toMatchObject({
      phase: 'ready',
      soul: { name: 'Olie', memories: [{ interactionId: 'interaction-1' }] },
    });
  });
});
