import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { TextField } from '@/components/ui/text-field';
import { SheetModal, SheetPanel } from '@/components/ui/sheet';
import { ThemedText } from '@/components/themed-text';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
import {
  launchableAgentProviderSchema,
  providerLabel,
  type AgentManifest,
  type AgentWorkspace,
  type CreateAgentInput,
  type LaunchableAgentProvider,
} from '@/domain/herdr';
import { supportsTuning, type Tuning } from '@/domain/agent-catalogue';
import { AgentProviderIcon } from '@/features/agents/agent-provider-icon';
import { AgentTuningPicker } from '@/features/agents/agent-tuning-picker';
import { useDockContentInset } from '@/features/navigation/floating-dock';
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
  const dockContentInset = useDockContentInset();
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
  const [name, setName] = useState('');
  const [tuning, setTuning] = useState<Tuning>({
    model: null,
    effort: null,
    context: null,
  });
  const tunable = supportsTuning(provider);
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
      await onCreate({
        provider,
        workspaceId: spaceId,
        bypassPermissions,
        name: name.trim() || undefined,
        // Nothing chosen means send no flag and let the CLI decide, which is
        // the only choice guaranteed to work on every account.
        model: (tunable && tuning.model) || undefined,
        effort: (tunable && tuning.effort) || undefined,
        context: (tunable && tuning.context) || undefined,
      });
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <SheetModal closeLabel="Close new agent" onClose={onClose} busy={creating}>
      {(close) => (
      <SheetPanel onClose={close} busy={creating}>
        <ScrollView
          contentContainerStyle={[styles.sheetContent, { paddingBottom: dockContentInset }]}
          showsVerticalScrollIndicator={false}>

          <TextField
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="What is this agent for?"
            autoCapitalize="sentences"
          />

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

          {tunable ? (
            <AgentTuningPicker
              provider={provider}
              value={tuning}
              onChange={setTuning}
            />
          ) : null}

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
      </SheetPanel>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    gap: Spacing.three,
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
    minHeight: ControlHeight.regular,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.half,
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
    minHeight: ControlHeight.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  spaceCopy: {
    flex: 1,
    gap: 2,
  },
  permissions: {
    minHeight: ControlHeight.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  permissionCopy: {
    flex: 1,
    gap: 2,
  },
});
