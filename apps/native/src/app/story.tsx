import { StyleSheet, Text, View } from 'react-native';

import { Body, Heading, Label, Screen } from '../components/growbot-ui';
import { Fonts, Space, useGrowbotTheme } from '../constants/theme';
import { useCreature } from '../runtime/creature-context';

export default function StoryScreen() {
  const colors = useGrowbotTheme();
  const { state } = useCreature();
  const memories = state.snapshot.soul?.memories ?? [];
  return (
    <Screen scroll>
      <View style={styles.header}>
        <Label>Durable memory only</Label>
        <Heading>Story</Heading>
        <Body style={{ color: colors.textMuted }}>
          Moments appear here only after this phone confirms they were safely remembered.
        </Body>
      </View>
      {memories.length === 0 ? (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <Text style={[styles.emptyMark, { color: colors.amber }]}>—</Text>
          <Body>No diary-worthy moment yet. Routine exchanges can simply pass through.</Body>
        </View>
      ) : (
        [...memories].reverse().map((memory) => (
          <View key={memory.id} style={[styles.memory, { borderColor: colors.border }]}>
            <Label>
              {new Intl.DateTimeFormat(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }).format(new Date(memory.at))}
            </Label>
            <Text style={[styles.memoryText, { color: colors.text }]}>{memory.text}</Text>
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: Space.sm, marginBottom: Space.md },
  empty: { borderTopWidth: 1, paddingVertical: Space.xl, gap: Space.md },
  emptyMark: { fontFamily: Fonts.mono, fontSize: 32 },
  memory: { borderTopWidth: 1, paddingTop: Space.md, gap: Space.sm },
  memoryText: { fontFamily: Fonts.regular, fontSize: 20, lineHeight: 29 },
});
