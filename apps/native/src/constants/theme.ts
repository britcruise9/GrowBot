import { useColorScheme } from 'react-native';

export const Colors = {
  light: {
    background: '#F2E9D8',
    surface: '#E8DDC9',
    field: '#D9CDB7',
    text: '#171A16',
    textMuted: '#5D6258',
    border: '#C4B9A5',
    amber: '#B97813',
    amberSoft: '#E0A83E',
    moss: '#66735B',
    clay: '#B95035',
    work: '#20231E',
    workText: '#F2E9D8',
  },
  dark: {
    background: '#121411',
    surface: '#1B1E19',
    field: '#20231E',
    text: '#F2E9D8',
    textMuted: '#A8AA9F',
    border: '#373B33',
    amber: '#E0A83E',
    amberSoft: '#A97520',
    moss: '#89977A',
    clay: '#C9684A',
    work: '#090B09',
    workText: '#F2E9D8',
  },
} as const;

export const Fonts = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
} as const;

export const Space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export function useGrowbotTheme() {
  return Colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
