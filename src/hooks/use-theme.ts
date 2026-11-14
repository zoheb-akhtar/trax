import { Colors } from '@/constants/theme';

/** Velo is dark-only: it is read at a glance on handlebars, often in low light. */
export function useTheme() {
  return Colors.dark;
}
