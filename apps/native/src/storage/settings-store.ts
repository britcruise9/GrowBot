import * as SecureStore from 'expo-secure-store';

export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

const API_KEY = 'growbot.owner.openrouter-key';
const MODEL = 'growbot.owner.model';
const VOICE = 'growbot.owner.voice';

export function createSettingsStore(storage = SecureStore) {
  return {
    async getModelConfiguration() {
      const [apiKey, model] = await Promise.all([
        storage.getItemAsync(API_KEY),
        storage.getItemAsync(MODEL),
      ]);
      return { apiKey, model: model?.trim() || DEFAULT_MODEL };
    },
    async setApiKey(apiKey: string): Promise<void> {
      const value = apiKey.trim();
      if (value) await storage.setItemAsync(API_KEY, value);
      else await storage.deleteItemAsync(API_KEY);
    },
    async setModel(model: string): Promise<void> {
      const value = model.trim() || DEFAULT_MODEL;
      await storage.setItemAsync(MODEL, value);
    },
    getVoiceId: () => storage.getItemAsync(VOICE),
    setVoiceId: (voiceId: string) => storage.setItemAsync(VOICE, voiceId),
  };
}
