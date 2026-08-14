import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { Fonts, useGrowbotTheme } from '../constants/theme';

export default function AppTabs() {
  const colors = useGrowbotTheme();
  return (
    <NativeTabs
      backgroundColor={colors.background}
      tintColor={colors.amber}
      iconColor={{ default: colors.textMuted, selected: colors.amber }}
      labelStyle={{
        default: { color: colors.textMuted, fontFamily: Fonts.medium },
        selected: { color: colors.text, fontFamily: Fonts.medium },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Habitat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'circle.dotted', selected: 'circle.dotted.circle.fill' }}
          md={{ default: 'pets', selected: 'pets' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="story">
        <NativeTabs.Trigger.Label>Story</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'book.closed', selected: 'book.closed.fill' }}
          md={{ default: 'menu_book', selected: 'menu_book' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="workshop">
        <NativeTabs.Trigger.Label>Workshop</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'wrench.and.screwdriver', selected: 'wrench.and.screwdriver.fill' }}
          md={{ default: 'build', selected: 'build' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
