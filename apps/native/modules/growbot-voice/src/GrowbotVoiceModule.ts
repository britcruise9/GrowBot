import { NativeModule, requireNativeModule } from 'expo';

import type { GrowbotVoiceInfo } from './GrowbotVoice.types';

declare class GrowbotVoiceModule extends NativeModule<{}> {
  initialize(): Promise<void>;
  listVoices(): Promise<GrowbotVoiceInfo[]>;
  speak(text: string, voiceId: string | null, rate: number): Promise<void>;
  stop(): Promise<void>;
}

export default requireNativeModule<GrowbotVoiceModule>('GrowbotVoice');
