import type { ModelRequest } from '@growbot/creature-core';

export type ModelFailureKind =
  | 'missing-key'
  | 'network'
  | 'rate-limited'
  | 'provider'
  | 'invalid-response';

export class ModelAdapterError extends Error {
  constructor(readonly kind: ModelFailureKind, message: string) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

type Configuration = Readonly<{ apiKey: string | null; model: string }>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commands', 'memory'],
  properties: {
    commands: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'args'],
        properties: {
          name: { type: 'string', enum: ['say'] },
          args: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string', minLength: 1 } },
          },
        },
      },
    },
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: { diaryEntry: { type: 'string', maxLength: 280 } },
    },
  },
} as const;

function buildMessages(request: ModelRequest) {
  const memoryLines = request.recentMemories.map((memory) => `- ${memory.text}`);
  const system = [
    `You are ${request.creatureName}, a small creature living in this phone.`,
    `Identity: ${request.identity}`,
    'Be vivid, first-person, honest, and worth returning to.',
    'Your current body can only speak. To act, emit exactly one say command in this reply.',
    'Never claim to see, hear, move, touch, or remember anything outside the supplied context.',
    'Keep spoken text at 18 words or fewer.',
    'Write a short diaryEntry only when this exchange is genuinely worth remembering; otherwise omit it.',
    `Recent diary:\n${memoryLines.join('\n') || '(nothing yet)'}`,
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    ...request.recentTraces.flatMap((trace) => [
      { role: 'user', content: trace.person },
      { role: 'assistant', content: trace.creature },
    ]),
    { role: 'user', content: request.utterance },
  ];
}

export function createOpenRouterModel({
  fetcher = fetch,
  getConfiguration,
}: Readonly<{
  fetcher?: Fetcher;
  getConfiguration(): Promise<Configuration>;
}>) {
  return {
    async infer(request: ModelRequest): Promise<unknown> {
      const configuration = await getConfiguration();
      if (!configuration.apiKey?.trim()) {
        throw new ModelAdapterError('missing-key', 'No OpenRouter key is configured.');
      }

      let response: Response;
      try {
        response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/britcruise9/GrowBot',
            'X-Title': 'GrowBot',
          },
          body: JSON.stringify({
            model: configuration.model,
            max_tokens: 220,
            messages: buildMessages(request),
            provider: { data_collection: 'deny', zdr: true },
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'growbot_phone_body_response',
                strict: true,
                schema: responseSchema,
              },
            },
          }),
        });
      } catch (error) {
        if (error instanceof ModelAdapterError) throw error;
        throw new ModelAdapterError('network', 'The OpenRouter request could not connect.');
      }

      if (!response.ok) {
        const kind = response.status === 429 ? 'rate-limited' : 'provider';
        throw new ModelAdapterError(kind, `OpenRouter returned ${response.status}.`);
      }

      try {
        const payload = (await response.json()) as {
          choices?: readonly [{ message?: { content?: string } }];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error('Missing model content.');
        return JSON.parse(content) as unknown;
      } catch {
        throw new ModelAdapterError(
          'invalid-response',
          'OpenRouter returned an unreadable response.',
        );
      }
    },
  };
}
