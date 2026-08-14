export type DeviceVoiceInfo = Readonly<{
  id: string;
  name: string;
  language: string;
  quality: number;
  requiresNetwork: boolean;
}>;

export type DeviceVoiceModule = Readonly<{
  initialize(): Promise<void>;
  listVoices(): Promise<DeviceVoiceInfo[]>;
  speak(text: string, voiceId: string | null, rate: number): Promise<void>;
  stop(): Promise<void>;
}>;

type VoicePreference = Readonly<{
  getVoiceId(): Promise<string | null>;
  setVoiceId(id: string): Promise<void>;
}>;

function rankVoice(voice: DeviceVoiceInfo, locale: string): readonly [number, number, string] {
  const exactLocale = voice.language.toLowerCase() === locale.toLowerCase();
  const sameLanguage =
    voice.language.split('-')[0]?.toLowerCase() === locale.split('-')[0]?.toLowerCase();
  return [exactLocale ? 2 : sameLanguage ? 1 : 0, voice.quality, voice.id];
}

function compareVoices(left: DeviceVoiceInfo, right: DeviceVoiceInfo, locale: string): number {
  const a = rankVoice(left, locale);
  const b = rankVoice(right, locale);
  return b[0] - a[0] || b[1] - a[1] || a[2].localeCompare(b[2]);
}

export function createDeviceVoice({
  module,
  preference,
  locale,
  onVoiceChanged = () => undefined,
}: Readonly<{
  module: DeviceVoiceModule;
  preference: VoicePreference;
  locale: string;
  onVoiceChanged?(message: string): void;
}>) {
  let selected: DeviceVoiceInfo | null = null;

  async function initialize(): Promise<DeviceVoiceInfo> {
    await module.initialize();
    const installed = (await module.listVoices())
      .filter((voice) => !voice.requiresNetwork)
      .sort((left, right) => compareVoices(left, right, locale));
    if (installed.length === 0) {
      throw new Error('No offline system voice is installed on this phone.');
    }

    const savedId = await preference.getVoiceId();
    selected = installed.find((voice) => voice.id === savedId) ?? installed[0]!;
    if (savedId !== selected.id) {
      if (savedId !== null) {
        onVoiceChanged('GrowBot’s previous system voice is no longer installed.');
      }
      await preference.setVoiceId(selected.id);
    }
    return selected;
  }

  return {
    initialize,
    async speak(text: string): Promise<void> {
      const voice = selected ?? (await initialize());
      await module.speak(text, voice.id, 0.92);
    },
    stop: () => module.stop(),
    getSelected: () => selected,
  };
}
