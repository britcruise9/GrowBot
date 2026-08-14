import { describe, expect, it, vi } from 'vitest';

import { createDeviceVoice } from './device-voice';

describe('device voice adapter', () => {
  it('deterministically chooses the best installed local voice and remembers it', async () => {
    const setVoiceId = vi.fn(async () => undefined);
    const module = {
      initialize: vi.fn(async () => undefined),
      listVoices: vi.fn(async () => [
        { id: 'network', name: 'Cloud', language: 'en-US', quality: 99, requiresNetwork: true },
        { id: 'local-b', name: 'B', language: 'en-GB', quality: 2, requiresNetwork: false },
        { id: 'local-a', name: 'A', language: 'en-US', quality: 2, requiresNetwork: false },
      ]),
      speak: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const voice = createDeviceVoice({
      module,
      preference: {
        getVoiceId: async () => null,
        setVoiceId,
      },
      locale: 'en-US',
    });

    await voice.speak('I am awake.');

    expect(module.speak).toHaveBeenCalledWith('I am awake.', 'local-a', 0.92);
    expect(setVoiceId).toHaveBeenCalledWith('local-a');
  });

  it('reports when an installed voice disappeared and falls back', async () => {
    const changed = vi.fn();
    const module = {
      initialize: vi.fn(async () => undefined),
      listVoices: vi.fn(async () => [
        { id: 'fallback', name: 'Fallback', language: 'en-US', quality: 1, requiresNetwork: false },
      ]),
      speak: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const voice = createDeviceVoice({
      module,
      preference: {
        getVoiceId: async () => 'removed-voice',
        setVoiceId: async () => undefined,
      },
      locale: 'en-US',
      onVoiceChanged: changed,
    });

    await voice.initialize();

    expect(changed).toHaveBeenCalledWith('GrowBot’s previous system voice is no longer installed.');
  });
});
