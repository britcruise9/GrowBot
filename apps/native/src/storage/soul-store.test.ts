import { describe, expect, it } from 'vitest';

import { createSoulStore, type SoulDatabase } from './soul-store';

function createMemoryDatabase(): SoulDatabase & { value: string | null } {
  return {
    value: null,
    async execAsync() {},
    async getFirstAsync() {
      return this.value === null ? null : { payload: this.value };
    },
    async runAsync(_query, payload) {
      this.value = String(payload);
    },
    async withTransactionAsync(task) {
      await task();
    },
  };
}

describe('native soul store', () => {
  it('atomically round-trips the one owner creature', async () => {
    const database = createMemoryDatabase();
    const store = createSoulStore(database);
    const soul = {
      creatureId: 'creature-1',
      name: 'Olie',
      identity: 'I am small and alert.',
      traces: [{ interactionId: 'i-1', person: 'Hello', creature: 'Hi.' }],
      memories: [
        {
          id: 'i-1:memory',
          interactionId: 'i-1',
          at: '2026-08-14T15:00:00.000Z',
          text: 'A warm voice found me.',
        },
      ],
    } as const;

    await store.initialize();
    await store.save(soul);

    expect(await store.load()).toEqual(soul);
  });

  it('refuses malformed persisted state instead of inventing a new creature', async () => {
    const database = createMemoryDatabase();
    database.value = '{"name":"orphaned"}';
    const store = createSoulStore(database);

    await expect(store.load()).rejects.toMatchObject({ name: 'SoulStoreError' });
  });
});
