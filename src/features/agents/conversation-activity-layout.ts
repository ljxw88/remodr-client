import { StyleSheet } from 'react-native';

import { ChipGeometry } from '@/constants/theme';

const iconSize = 14;
const borderWidth = StyleSheet.hairlineWidth * 2;

export const ActivityLayout = {
  iconSize,
  borderWidth,
  headingMinHeight: ChipGeometry.minHeight - borderWidth * 2,
  // State icons sit under the category icon, beyond the disclosure chevron.
  disclosureInset: iconSize + ChipGeometry.gap,
  lineHeight: 18,
} as const;
