import type { Soul } from '@growbot/creature-core';

export type SoulDatabase = Readonly<{
  execAsync(query: string): Promise<unknown>;
  getFirstAsync(query: string): Promise<{ payload: string } | null>;
  runAsync(query: string, payload: string): Promise<unknown>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}>;

export class SoulStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoulStoreError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeSoul(payload: string): Soul {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new SoulStoreError('The saved creature is not valid JSON.');
  }

  if (
    !isRecord(value) ||
    typeof value.creatureId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.identity !== 'string' ||
    !Array.isArray(value.traces) ||
    !Array.isArray(value.memories) ||
    !value.traces.every(
      (trace) =>
        isRecord(trace) &&
        typeof trace.interactionId === 'string' &&
        typeof trace.person === 'string' &&
        typeof trace.creature === 'string',
    ) ||
    !value.memories.every(
      (memory) =>
        isRecord(memory) &&
        typeof memory.id === 'string' &&
        typeof memory.interactionId === 'string' &&
        typeof memory.at === 'string' &&
        typeof memory.text === 'string',
    )
  ) {
    throw new SoulStoreError('The saved creature does not match the current soul format.');
  }

  return value as Soul;
}

export function createSoulStore(database: SoulDatabase) {
  return {
    async initialize(): Promise<void> {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS owner_soul (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },

    async load(): Promise<Soul | null> {
      const row = await database.getFirstAsync(
        'SELECT payload FROM owner_soul WHERE slot = 1 LIMIT 1',
      );
      return row === null ? null : decodeSoul(row.payload);
    },

    async save(soul: Soul): Promise<void> {
      const payload = JSON.stringify(soul);
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          `INSERT INTO owner_soul (slot, payload, updated_at)
           VALUES (1, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(slot) DO UPDATE SET
             payload = excluded.payload,
             updated_at = CURRENT_TIMESTAMP`,
          payload,
        );
      });
    },
  };
}
