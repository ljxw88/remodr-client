import { BlurTargetView } from 'expo-blur';
import { TabList, TabSlot, Tabs, TabTrigger } from 'expo-router/ui';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AnimatedTabContent,
  DockMotionProvider,
  FloatingDock,
} from '@/features/navigation/floating-dock';
import { useTheme } from '@/hooks/use-theme';

export default function TabsLayout() {
  const theme = useTheme();
  const blurTarget = useRef<View | null>(null);

  return (
    <DockMotionProvider>
      <Tabs style={[styles.tabs, { backgroundColor: theme.background }]}>
        <BlurTargetView ref={blurTarget} style={styles.content}>
          <AnimatedTabContent>
            <TabSlot style={styles.content} />
          </AnimatedTabContent>
        </BlurTargetView>

        <FloatingDock blurTarget={blurTarget} />

        <TabList style={styles.hiddenTabs}>
          <TabTrigger name="agents" href="/" />
          <TabTrigger name="servers" href="/servers" />
          <TabTrigger name="settings" href="/settings" />
        </TabList>
      </Tabs>
    </DockMotionProvider>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  hiddenTabs: {
    display: 'none',
  },
});
