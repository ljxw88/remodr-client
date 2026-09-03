import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';

export default function FeatureLayout() {
  return <Stack screenOptions={useStackScreenOptions()} />;
}
