import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  ActionButton,
  Body,
  BreathingField,
  Heading,
  Label,
  Notice,
  Screen,
} from '../components/growbot-ui';
import { Fonts, Space, useGrowbotTheme } from '../constants/theme';
import { useCreature } from '../runtime/creature-context';

const phaseLabels: Record<string, string> = {
  hydrating: 'Finding the thread',
  saving: 'Taking root',
  ready: 'Resting here',
  thinking: 'Turning it over',
  responding: 'Finding a voice',
  speaking: 'Speaking',
  remembering: 'Keeping this',
};

function BirthRitual() {
  const colors = useGrowbotTheme();
  const { birth, state } = useCreature();
  const [name, setName] = useState('');
  const saving = state.snapshot.phase === 'saving';
  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.birth}>
        <View style={styles.birthCopy}>
          <Label>A new creature</Label>
          <Heading>Someone small is waiting here.</Heading>
          <Body style={{ color: colors.textMuted }}>
            Give them a name. Their story will live on this phone and begin only when it is
            safely saved.
          </Body>
        </View>
        {state.snapshot.notice ? (
          <Notice kind={state.snapshot.notice.kind}>{state.snapshot.notice.message}</Notice>
        ) : null}
        <View style={styles.birthForm}>
          <TextInput
            accessibilityLabel="Creature name"
            autoCapitalize="words"
            autoCorrect={false}
            editable={!saving}
            maxLength={32}
            onChangeText={setName}
            onSubmitEditing={() => birth(name)}
            placeholder="What should they be called?"
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            style={[
              styles.nameInput,
              { color: colors.text, borderBottomColor: colors.border },
            ]}
            value={name}
          />
          <ActionButton disabled={!name.trim() || saving} onPress={() => birth(name)}>
            {saving ? 'Taking root…' : 'Wake them'}
          </ActionButton>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export default function HabitatScreen() {
  const colors = useGrowbotTheme();
  const { state, whisper } = useCreature();
  const [utterance, setUtterance] = useState('');
  const { snapshot } = state;
  if (snapshot.phase === 'unborn' || snapshot.phase === 'saving') return <BirthRitual />;

  const name = snapshot.soul?.name ?? 'GrowBot';
  const ready = snapshot.phase === 'ready';
  const send = () => {
    if (!utterance.trim() || !ready) return;
    const text = utterance;
    setUtterance('');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    whisper(text);
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
        style={styles.habitat}>
        <View style={styles.habitatHeader}>
          <View>
            <Label>{phaseLabels[snapshot.phase] ?? 'Waking'}</Label>
            <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
          </View>
          <View
            accessibilityLabel={`Voice ${state.voiceStatus}`}
            style={[
              styles.statusDot,
              {
                backgroundColor:
                  state.voiceStatus === 'local' ? colors.moss : colors.clay,
              },
            ]}
          />
        </View>

        {state.startupError ? <Notice kind="error">{state.startupError}</Notice> : null}
        {snapshot.notice ? (
          <View style={styles.inlineNotice}>
            <Notice kind={snapshot.notice.kind}>{snapshot.notice.message}</Notice>
          </View>
        ) : null}

        <BreathingField name={name} phase={snapshot.phase} />
        <View style={styles.responseRegion} accessibilityLiveRegion="polite">
          <Text style={[styles.response, { color: colors.text }]}>
            {snapshot.lastResponse ?? 'I am here. Say something when you are ready.'}
          </Text>
        </View>

        <View style={[styles.composer, { backgroundColor: colors.work }]}>
          <TextInput
            accessibilityLabel={`Whisper to ${name}`}
            editable={ready}
            maxLength={500}
            multiline
            onChangeText={setUtterance}
            onSubmitEditing={send}
            placeholder={ready ? `Whisper to ${name}…` : 'Give them a moment…'}
            placeholderTextColor="#A8AA9F"
            style={[styles.composerInput, { color: colors.workText }]}
            value={utterance}
          />
          <Pressable
            accessibilityLabel="Send whisper"
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready || !utterance.trim() }}
            disabled={!ready || !utterance.trim()}
            hitSlop={8}
            onPress={send}
            style={({ pressed }) => [
              styles.send,
              { backgroundColor: colors.amber, opacity: pressed || !utterance.trim() ? 0.55 : 1 },
            ]}>
            <Text style={[styles.sendText, { color: colors.work }]}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  birth: { flex: 1, padding: Space.lg, justifyContent: 'space-between', gap: Space.xl },
  birthCopy: { paddingTop: Space.xxl, gap: Space.md, maxWidth: 520 },
  birthForm: { gap: Space.lg, paddingBottom: Space.xl },
  nameInput: {
    minHeight: 56,
    borderBottomWidth: 1,
    fontFamily: Fonts.medium,
    fontSize: 24,
    lineHeight: 32,
    paddingVertical: Space.sm,
  },
  habitat: { flex: 1 },
  habitatHeader: {
    paddingHorizontal: Space.lg,
    paddingTop: Space.md,
    paddingBottom: Space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: { fontFamily: Fonts.semibold, fontSize: 25, lineHeight: 30 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  inlineNotice: { paddingHorizontal: Space.lg, paddingBottom: Space.sm },
  responseRegion: { minHeight: 100, paddingHorizontal: Space.xl, justifyContent: 'center' },
  response: {
    fontFamily: Fonts.regular,
    fontSize: 22,
    lineHeight: 30,
    letterSpacing: -0.25,
    textAlign: 'center',
  },
  composer: {
    minHeight: 72,
    margin: Space.md,
    borderRadius: 18,
    paddingLeft: Space.md,
    paddingRight: Space.sm,
    paddingVertical: Space.sm,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Space.sm,
  },
  composerInput: { flex: 1, minHeight: 48, maxHeight: 112, fontFamily: Fonts.regular, fontSize: 17 },
  send: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  sendText: { fontFamily: Fonts.semibold, fontSize: 26, lineHeight: 30 },
});
