import { router, useIsFocused } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { GlassSurface } from '@/components/ui/glass-surface';
import { SkeletonGroup, SkeletonLine } from '@/components/ui/skeleton';
import { AppIcon } from '@/components/ui/app-icon';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { HostRow, HostRowSkeleton } from '@/features/hosts/HostRow';
import { useHosts } from '@/features/hosts/use-hosts';
import { useTheme } from '@/hooks/use-theme';
import { useContentReveal } from '@/hooks/use-content-reveal';

const SKELETON_ROWS = ['0', '1', '2', '3', '4'];

export default function HostsScreen() {
  const focused = useIsFocused();
  const theme = useTheme();
  const { hosts, loading, error, reload } = useHosts();
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const [query, setQuery] = useState('');
  const initialLoading = loading && hosts.length === 0 && !error;
  const revealStyle = useContentReveal(initialLoading);
  const visibleHosts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return hosts;
    }
    return hosts.filter((host) =>
      [host.name, host.hostname, host.username, host.group]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [hosts, query]);

  return (
    <Screen includeTopSafeArea>
      <View style={styles.hero}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add server"
            onPress={() => router.push('/hosts/new')}
            style={({ pressed }) => [
              styles.addButton,
              {
                backgroundColor: theme.accent,
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}>
            <AppIcon
              name={{ ios: 'plus', android: 'add', web: 'add' }}
              size={18}
              tintColor={theme.onAccent}
              fallback="+"
            />
            <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
              Add server
            </ThemedText>
          </Pressable>
        </View>
      </View>

      {loading || hosts.length > 0 ? (
        <View style={styles.controls}>
          <GlassSurface strength="strong" style={styles.search}>
            <AppIcon
              name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
              size={19}
              tintColor={theme.textMuted}
              fallback="⌕"
            />
            <TextInput
              accessibilityLabel="Search servers"
              placeholder="Search servers"
              placeholderTextColor={theme.placeholder}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.searchInput, { color: theme.text }]}
            />
          </GlassSurface>
          {!loading || hosts.length > 0 ? (
            <ThemedText type="caption" themeColor="textMuted">
              {hosts.length} {hosts.length === 1 ? 'server' : 'servers'}
            </ThemedText>
          ) : <SkeletonGroup label="Loading server count"><SkeletonLine width={64} /></SkeletonGroup>}
        </View>
      ) : null}

      {error ? (
        <GlassSurface style={styles.errorState}>
          <ThemedText type="section">Couldn’t load your servers</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {error}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={() => void reload()}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Try again
            </ThemedText>
          </Pressable>
        </GlassSurface>
      ) : null}
      {error && hosts.length === 0 ? null : initialLoading ? (
        <ScrollEdgeFrame onScroll={onDockScroll}>
          {(edge) => (
            <Animated.FlatList
              {...edge}
              style={revealStyle}
              data={SKELETON_ROWS}
              keyExtractor={(item) => item}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.list, { paddingBottom: dockContentInset }]}
              renderItem={() => <HostRowSkeleton />}
            />
          )}
        </ScrollEdgeFrame>
      ) : hosts.length === 0 ? (
        <EmptyState message="No servers" />
      ) : visibleHosts.length === 0 ? (
        <EmptyState message="No matching servers" />
      ) : (
        <ScrollEdgeFrame onScroll={onDockScroll}>
          {(edge) => (
            <Animated.FlatList
              {...edge}
              style={revealStyle}
              data={visibleHosts}
              keyExtractor={(host) => host.id}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.list, { paddingBottom: dockContentInset }]}
              renderItem={({ item }) => (
                <HostRow
                  active={focused}
                  host={item}
                  onPress={() =>
                    router.push({
                      pathname: '/hosts/[id]',
                      params: { id: item.id },
                    })
                  }
                />
              )}
            />
          )}
        </ScrollEdgeFrame>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginBottom: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  addButton: {
    minHeight: 44,
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: {
    gap: Spacing.one,
    marginBottom: Spacing.two,
  },
  search: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
  },
  searchInput: {
    flex: 1,
    height: 46,
    fontFamily: Fonts.regular,
    fontSize: 15,
    letterSpacing: -0.15,
  },
  list: {
    gap: Spacing.one + Spacing.half,
    paddingTop: Spacing.one,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
  errorState: {
    gap: Spacing.one,
    padding: Spacing.three,
  },
});
