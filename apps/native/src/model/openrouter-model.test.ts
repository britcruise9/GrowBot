import { describe, expect, it, vi } from 'vitest';

import { createOpenRouterModel } from './openrouter-model';

describe('OpenRouter model adapter', () => {
  it('sends only bounded creature context through privacy-restricted routing', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commands: [{ name: 'say', args: { text: 'I am awake.' } }],
                  memory: { diaryEntry: 'I woke when my person called.' },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const model = createOpenRouterModel({
      fetcher,
      getConfiguration: async () => ({
        apiKey: 'test-owner-key',
        model: 'anthropic/claude-haiku-4.5',
      }),
    });

    const output = await model.infer({
      creatureName: 'Olie',
      identity: 'I am small and alert.',
      utterance: 'Are you awake?',
      recentTraces: [
        { interactionId: 'old-1', person: 'Hello', creature: 'A tiny hello.' },
      ],
      recentMemories: [
        {
          id: 'memory-1',
          interactionId: 'old-1',
          at: '2026-08-14T15:00:00.000Z',
          text: 'A warm voice found me.',
        },
      ],
    });

    expect(output).toEqual({
      commands: [{ name: 'say', args: { text: 'I am awake.' } }],
      memory: { diaryEntry: 'I woke when my person called.' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-owner-key' });
    const body = JSON.parse(String(init.body));
    expect(body.provider).toEqual({ data_collection: 'deny', zdr: true });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(body)).not.toContain('test-owner-key');
    expect(JSON.stringify(body)).not.toContain('creature-1');
  });

  it('reports a missing owner key without making a request', async () => {
    const fetcher = vi.fn();
    const model = createOpenRouterModel({
      fetcher,
      getConfiguration: async () => ({ apiKey: null, model: 'openrouter/free' }),
    });

    await expect(
      model.infer({
        creatureName: 'Olie',
        identity: 'Small and alert.',
        utterance: 'Hello',
        recentTraces: [],
        recentMemories: [],
      }),
    ).rejects.toMatchObject({ kind: 'missing-key' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
