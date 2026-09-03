import { TabList, TabSlot, Tabs, TabTrigger } from 'expo-router/ui';
import { StyleSheet } from 'react-native';

import {
  BlurBackdropProvider,
  BlurBackdropTarget,
} from '@/components/ui/blur-backdrop';
import {
  AnimatedTabContent,
  DockMotionProvider,
  FloatingDock,
} from '@/features/navigation/floating-dock';

export default function TabsLayout() {
  return (
    <DockMotionProvider>
      <BlurBackdropProvider>
        <Tabs style={styles.tabs}>
          {/* The dock is a sibling of the target, never a child: a BlurView
              nested inside the target it samples crashes the render thread. */}
          <BlurBackdropTarget>
            <AnimatedTabContent>
              <TabSlot style={styles.content} />
            </AnimatedTabContent>
          </BlurBackdropTarget>

          <FloatingDock />

          <TabList style={styles.hiddenTabs}>
            <TabTrigger name="agents" href="/" />
            <TabTrigger name="servers" href="/servers" />
            <TabTrigger name="settings" href="/settings" />
          </TabList>
        </Tabs>
      </BlurBackdropProvider>
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
