import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import { BottomTabInset, Radius, Spacing } from '@/constants/theme';
import {
  launchableAgentProviderSchema,
  providerLabel,
  type AgentManifest,
  type AgentWorkspace,
  type CreateAgentInput,
  type LaunchableAgentProvider,
} from '@/domain/herdr';
import { AgentProviderIcon } from '@/features/agents/agent-provider-icon';
import { useTheme } from '@/hooks/use-theme';
import { toUserMessage } from '@/utils/user-error';

const PROVIDERS = launchableAgentProviderSchema.options;

type Props = {
  manifests: AgentManifest[];
  spaces: AgentWorkspace[];
  initialSpaceId: string | null;
  onClose: () => void;
  onCreate: (input: CreateAgentInput) => Promise<void>;
};

export function NewAgentSheet({
  manifests,
  spaces,
  initialSpaceId,
  onClose,
  onCreate,
}: Props) {
  const theme = useTheme();
  const availability = useMemo(
    () => new Map(manifests.map((manifest) => [manifest.provider, manifest.available])),
    [manifests],
  );
  const [provider, setProvider] = useState<LaunchableAgentProvider>(
    () => PROVIDERS.find((candidate) => availability.get(candidate)) ?? 'copilot',
  );
  const [spaceId, setSpaceId] = useState(
    () =>
      (spaces.some((space) => space.id === initialSpaceId)
        ? initialSpaceId
        : spaces[0]?.id) ?? '',
  );
  const [bypassPermissions, setBypassPermissions] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spaceAvailable = spaces.some((space) => space.id === spaceId);

  async function create() {
    if (!spaceAvailable || creating || !availability.get(provider)) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate({ provider, workspaceId: spaceId, bypassPermissions });
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      animationType="slide"
      transparent
      statusBarTranslucent
      visible
      onRequestClose={creating ? undefined : onClose}>
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close new agent"
          disabled={creating}
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.chrome,
              borderColor: theme.glassBorder,
              shadowColor: theme.glassShadow,
            },
          ]}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.titleCopy}>
              <ThemedText type="heading">New agent</ThemedText>
              <ThemedText type="caption" themeColor="textSecondary">
                Choose an agent and the space it should work in.
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              disabled={creating}
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <AppIcon
                name={{ ios: 'xmark', android: 'close', web: 'close' }}
                size={20}
                tintColor={theme.textSecondary}
                fallback="×"
              />
            </Pressable>
          </View>

          <View style={styles.section}>
            <ThemedText type="label" themeColor="textMuted">
              AGENT
            </ThemedText>
            <View style={styles.providerGrid}>
              {PROVIDERS.map((candidate) => {
                const available = availability.get(candidate) === true;
                const selected = provider === candidate;
                return (
                  <Pressable
                    key={candidate}
                    accessibilityRole="button"
                    accessibilityLabel={providerLabel(candidate)}
                    accessibilityState={{ disabled: !available, selected }}
                    disabled={!available}
                    onPress={() => setProvider(candidate)}
                    style={({ pressed }) => [
                      styles.provider,
                      {
                        backgroundColor: selected
                          ? theme.accentSoft
                          : theme.backgroundElement,
                        borderColor: selected ? theme.accent : theme.border,
                        opacity: available ? (pressed ? 0.72 : 1) : 0.38,
                      },
                    ]}>
                    <AgentProviderIcon
                      provider={candidate}
                      size={20}
                      tintColor={selected ? theme.accent : theme.textSecondary}
                    />
                    <View style={styles.providerCopy}>
                      <ThemedText
                        type="smallBold"
                        style={{ color: selected ? theme.accent : theme.text }}>
                        {providerLabel(candidate)}
                      </ThemedText>
                      {!available ? (
                        <ThemedText type="caption" themeColor="textMuted">
                          {manifests.find(
                            (manifest) => manifest.provider === candidate,
                          )?.unavailableReason ?? 'Unavailable'}
                        </ThemedText>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <ThemedText type="label" themeColor="textMuted">
              SPACE
            </ThemedText>
            <ScrollView
              style={styles.spaceList}
              contentContainerStyle={styles.spaceListContent}
              showsVerticalScrollIndicator={false}>
              {spaces.map((space) => {
                const selected = space.id === spaceId;
                return (
                  <Pressable
                    key={space.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setSpaceId(space.id)}
                    style={({ pressed }) => [
                      styles.space,
                      {
                        backgroundColor: selected
                          ? theme.accentSoft
                          : theme.backgroundElement,
                        borderColor: selected ? theme.accent : theme.border,
                        opacity: pressed ? 0.72 : 1,
                      },
                    ]}>
                    <View style={styles.spaceCopy}>
                      <ThemedText type="smallBold" numberOfLines={1}>
                        {space.name}
                      </ThemedText>
                      {space.cwd ? (
                        <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
                          {space.cwd}
                        </ThemedText>
                      ) : null}
                    </View>
                    {selected ? (
                      <AppIcon
                        name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                        size={18}
                        tintColor={theme.accent}
                        fallback="✓"
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          <View
            style={[
              styles.permissions,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <View style={styles.permissionCopy}>
              <ThemedText type="smallBold">Allow tools automatically</ThemedText>
              <ThemedText type="caption" themeColor="textMuted">
                Apply bypass flag
              </ThemedText>
            </View>
            <Switch
              value={bypassPermissions}
              disabled={creating}
              onValueChange={setBypassPermissions}
              trackColor={{ false: theme.border, true: theme.accent }}
            />
          </View>

          {error ? (
            <ThemedText accessibilityLiveRegion="polite" type="caption" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}

          <AppButton
            label={creating ? 'Starting agent…' : 'Start agent'}
            disabled={creating || !spaceAvailable || !availability.get(provider)}
            onPress={() => void create()}
          />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    maxHeight: '92%',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingTop: Spacing.one,
    paddingBottom: 0,
    borderWidth: 1,
    borderTopLeftRadius: Radius.glass,
    borderTopRightRadius: Radius.glass,
    elevation: 20,
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 1,
    shadowRadius: 28,
  },
  sheetContent: {
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.one,
  },
  handle: {
    width: 38,
    height: 4,
    alignSelf: 'center',
    borderRadius: Radius.pill,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  titleCopy: {
    flex: 1,
    gap: Spacing.half,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  section: {
    gap: Spacing.one,
  },
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  provider: {
    width: '48.5%',
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  providerCopy: {
    flex: 1,
    gap: 2,
  },
  spaceList: {
    maxHeight: 190,
  },
  spaceListContent: {
    gap: Spacing.one,
  },
  space: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  spaceCopy: {
    flex: 1,
    gap: 2,
  },
  permissions: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  permissionCopy: {
    flex: 1,
    gap: 2,
  },
  pressed: {
    opacity: 0.6,
  },
});
