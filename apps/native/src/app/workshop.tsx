import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ActionButton, Body, Heading, Label, Notice, Screen } from '../components/growbot-ui';
import { Fonts, Space, useGrowbotTheme } from '../constants/theme';
import { useCreature } from '../runtime/creature-context';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useGrowbotTheme();
  return (
    <View style={[styles.section, { borderColor: colors.border }]}>
      <Label>{title}</Label>
      {children}
    </View>
  );
}

export default function WorkshopScreen() {
  const colors = useGrowbotTheme();
  const {
    apiKeyPresent,
    model,
    saveApiKey,
    saveModel,
    state,
    voiceNotice,
  } = useCreature();
  const [apiKey, setApiKey] = useState('');
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const displayedModel = modelDraft ?? model;

  const inputStyle = [
    styles.input,
    { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border },
  ];
  return (
    <Screen scroll>
      <View style={styles.header}>
        <Label>Capability, not theater</Label>
        <Heading>Workshop</Heading>
        <Body style={{ color: colors.textMuted }}>
          The honest machine face: what this creature can do now, and what is still only a
          possibility.
        </Body>
      </View>

      {saved ? <Notice kind="info">{saved}</Notice> : null}
      {voiceNotice ? <Notice kind="info">{voiceNotice}</Notice> : null}

      <Section title="Mind · OpenRouter">
        <Text style={[styles.value, { color: colors.text }]}>
          {apiKeyPresent ? 'Owner key stored' : 'Owner key needed'}
        </Text>
        <Body style={{ color: colors.textMuted }}>
          The key is kept in OS-protected storage, never in cookies or the creature database.
          Requests send only the current whisper plus bounded recent context, with data
          collection denied and Zero Data Retention required.
        </Body>
        <TextInput
          accessibilityLabel="OpenRouter API key"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setApiKey}
          placeholder={apiKeyPresent ? 'Replace stored key' : 'sk-or-v1-…'}
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          style={inputStyle}
          value={apiKey}
        />
        <ActionButton
          disabled={!apiKey.trim()}
          onPress={() => {
            void saveApiKey(apiKey).then(() => {
              setApiKey('');
              setSaved('OpenRouter key saved in protected storage.');
            });
          }}>
          {apiKeyPresent ? 'Replace key' : 'Save key'}
        </ActionButton>
      </Section>

      <Section title="Model">
        <TextInput
          accessibilityLabel="OpenRouter model identifier"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setModelDraft}
          placeholder="anthropic/claude-haiku-4.5"
          placeholderTextColor={colors.textMuted}
          style={inputStyle}
          value={displayedModel}
        />
        <ActionButton
          disabled={!displayedModel.trim() || displayedModel.trim() === model}
          onPress={() => {
            void saveModel(displayedModel).then(() => {
              setModelDraft(null);
              setSaved('Model choice saved.');
            });
          }}>
          Save model
        </ActionButton>
      </Section>

      <Section title="Voice · This phone">
        <Text style={[styles.value, { color: colors.text }]}>
          {state.voiceStatus === 'local'
            ? 'Installed system voice · local'
            : state.voiceStatus === 'checking'
              ? 'Checking installed voices…'
              : 'No offline voice available'}
        </Text>
        <Body style={{ color: colors.textMuted }}>
          Speech uses the best matching voice already installed on this device. It has no model
          bill and sends no audio to GrowBot.
        </Body>
      </Section>

      <Section title="Body truth · MVP 1">
        <View style={styles.capabilityRow}>
          <Text style={[styles.value, { color: colors.text }]}>Speak</Text>
          <Text style={[styles.enabled, { color: colors.moss }]}>ENABLED</Text>
        </View>
        <View style={styles.capabilityRow}>
          <Text style={[styles.value, { color: colors.textMuted }]}>See · Hear · Move</Text>
          <Text style={[styles.enabled, { color: colors.textMuted }]}>NOT YET</Text>
        </View>
        <Body style={{ color: colors.textMuted }}>
          Model prose cannot become an action. Code accepts one bounded say command; every other
          verb is rejected.
        </Body>
      </Section>

      <Section title="Local memory">
        <Body style={{ color: colors.textMuted }}>
          Soul and Story live in this app’s SQLite database. They may be included in an
          OS-managed device backup according to platform and device settings. There is no
          GrowBot account or cloud sync in this MVP.
        </Body>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: Space.sm, marginBottom: Space.md },
  section: { borderTopWidth: 1, paddingTop: Space.md, gap: Space.md },
  value: { fontFamily: Fonts.medium, fontSize: 18, lineHeight: 24 },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: Space.md,
    fontFamily: Fonts.mono,
    fontSize: 14,
  },
  capabilityRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Space.md },
  enabled: { fontFamily: Fonts.monoMedium, fontSize: 12, letterSpacing: 0.8 },
});
