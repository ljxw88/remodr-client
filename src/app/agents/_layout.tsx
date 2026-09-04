import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/features/navigation/stack-screen-options';

export default function AgentsLayout() {
  return <Stack screenOptions={useStackScreenOptions()} />;
}
