// Re-export the native module. On web, it will be resolved to GrowbotVoiceModule.web.ts
// and on native platforms to GrowbotVoiceModule.ts
export { default } from './src/GrowbotVoiceModule';
export * from './src/GrowbotVoice.types';
