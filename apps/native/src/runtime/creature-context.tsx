import GrowbotVoiceModule from '../../modules/growbot-voice';
import { openDatabaseAsync } from 'expo-sqlite';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { createOpenRouterModel } from '../model/openrouter-model';
import { createSettingsStore } from '../storage/settings-store';
import { createSoulStore } from '../storage/soul-store';
import { createDeviceVoice } from '../voice/device-voice';
import {
  createCreatureController,
  type CreatureControllerState,
} from './creature-controller';

type CreatureContextValue = Readonly<{
  state: CreatureControllerState;
  birth(name: string): void;
  whisper(text: string): void;
  apiKeyPresent: boolean;
  model: string;
  saveApiKey(apiKey: string): Promise<void>;
  saveModel(model: string): Promise<void>;
  voiceNotice: string | null;
}>;

const CreatureContext = createContext<CreatureContextValue | null>(null);

export function CreatureProvider({ children }: { children: React.ReactNode }) {
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const services = useMemo(() => {
    const settings = createSettingsStore();
    const voice = createDeviceVoice({
      module: GrowbotVoiceModule,
      preference: settings,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      onVoiceChanged: (message) => {
        setVoiceNotice(message);
      },
    });
    const storePromise = openDatabaseAsync('growbot.db').then(createSoulStore);
    const store = {
      async initialize() {
        await (await storePromise).initialize();
      },
      async load() {
        return (await storePromise).load();
      },
      async save(soul: Parameters<Awaited<typeof storePromise>['save']>[0]) {
        await (await storePromise).save(soul);
      },
    };
    const controller = createCreatureController({
      store,
      model: createOpenRouterModel({ getConfiguration: settings.getModelConfiguration }),
      voice,
    });
    return { controller, settings, voice };
  }, []);
  const [state, setState] = useState(services.controller.getState());
  const [configuration, setConfiguration] = useState({
    apiKeyPresent: false,
    model: '',
  });

  useEffect(() => {
    const unsubscribe = services.controller.subscribe(setState);
    void services.settings.getModelConfiguration().then((value) =>
      setConfiguration({ apiKeyPresent: Boolean(value.apiKey), model: value.model }),
    );
    void services.controller.initialize();
    return () => {
      unsubscribe();
    };
  }, [services]);

  const value: CreatureContextValue = {
    state,
    birth: services.controller.birth,
    whisper: services.controller.whisper,
    apiKeyPresent: configuration.apiKeyPresent,
    model: configuration.model,
    async saveApiKey(apiKey) {
      await services.settings.setApiKey(apiKey);
      setConfiguration((current) => ({ ...current, apiKeyPresent: Boolean(apiKey.trim()) }));
    },
    async saveModel(model) {
      await services.settings.setModel(model);
      const next = await services.settings.getModelConfiguration();
      setConfiguration((current) => ({ ...current, model: next.model }));
    },
    voiceNotice,
  };

  return <CreatureContext.Provider value={value}>{children}</CreatureContext.Provider>;
}

export function useCreature(): CreatureContextValue {
  const value = useContext(CreatureContext);
  if (value === null) throw new Error('useCreature must be inside CreatureProvider.');
  return value;
}
