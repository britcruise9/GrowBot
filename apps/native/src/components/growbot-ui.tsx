import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Fonts, Space, useGrowbotTheme } from '../constants/theme';

export function Screen({ children, scroll = false }: ViewProps & { scroll?: boolean }) {
  const colors = useGrowbotTheme();
  const content = scroll ? (
    <ScrollView contentContainerStyle={styles.scrollContent}>{children}</ScrollView>
  ) : (
    children
  );
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      {content}
    </SafeAreaView>
  );
}

export function Label({ style, ...props }: TextProps) {
  const colors = useGrowbotTheme();
  return <Text {...props} style={[styles.label, { color: colors.textMuted }, style]} />;
}

export function Heading({ style, ...props }: TextProps) {
  const colors = useGrowbotTheme();
  return <Text {...props} style={[styles.heading, { color: colors.text }, style]} />;
}

export function Body({ style, ...props }: TextProps) {
  const colors = useGrowbotTheme();
  return <Text {...props} style={[styles.body, { color: colors.text }, style]} />;
}

export function Notice({ kind, children }: { kind: 'error' | 'info'; children: string }) {
  const colors = useGrowbotTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        {
          borderColor: kind === 'error' ? colors.clay : colors.moss,
          backgroundColor: colors.surface,
        },
      ]}>
      <Body style={{ color: kind === 'error' ? colors.clay : colors.text }}>{children}</Body>
    </View>
  );
}

export function ActionButton({
  children,
  disabled = false,
  onPress,
  accessibilityLabel,
}: {
  children: string;
  disabled?: boolean;
  onPress(): void;
  accessibilityLabel?: string;
}) {
  const colors = useGrowbotTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: disabled ? colors.border : colors.amber,
          opacity: pressed ? 0.72 : 1,
        },
      ]}>
      <Text style={[styles.actionText, { color: colors.background }]}>{children}</Text>
    </Pressable>
  );
}

export function BreathingField({
  phase,
  name,
}: {
  phase: string;
  name: string;
}) {
  const colors = useGrowbotTheme();
  const [breath] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(false);
  const active = ['thinking', 'responding', 'speaking', 'remembering', 'saving'].includes(phase);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    breath.stopAnimation();
    if (reduceMotion) {
      breath.setValue(active ? 1 : 0.35);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: active ? 850 : 2400,
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: active ? 850 : 2400,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [active, breath, reduceMotion]);

  const scale = breath.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.04] });
  const opacity = breath.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.72] });
  return (
    <View
      accessible
      accessibilityLabel={`${name} is ${phase}`}
      style={[styles.field, { backgroundColor: colors.field }]}>
      <Animated.View
        style={[
          styles.orbit,
          { borderColor: colors.moss, opacity, transform: [{ scale }] },
        ]}
      />
      <Animated.View
        style={[
          styles.core,
          {
            backgroundColor: active ? colors.amber : colors.moss,
            transform: [{ scale }],
          },
        ]}>
        <Text style={[styles.creatureMark, { color: colors.background }]}>
          {name.slice(0, 1).toUpperCase()}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { padding: Space.lg, paddingBottom: 120, gap: Space.lg },
  label: {
    fontFamily: Fonts.monoMedium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  heading: { fontFamily: Fonts.semibold, fontSize: 32, lineHeight: 38, letterSpacing: -0.8 },
  body: { fontFamily: Fonts.regular, fontSize: 17, lineHeight: 24 },
  notice: { borderLeftWidth: 3, padding: Space.md, gap: Space.sm },
  action: {
    minHeight: 48,
    paddingHorizontal: Space.lg,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontFamily: Fonts.semibold, fontSize: 16, lineHeight: 20 },
  field: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  orbit: { position: 'absolute', width: 236, height: 236, borderRadius: 118, borderWidth: 1 },
  core: { width: 136, height: 136, borderRadius: 68, alignItems: 'center', justifyContent: 'center' },
  creatureMark: { fontFamily: Fonts.medium, fontSize: 54, lineHeight: 64 },
});
