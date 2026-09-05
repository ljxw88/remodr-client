import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { glassRim } from '@/components/ui/glass-surface';
import { Colors, ControlHeight, Radius, Spacing } from '@/constants/theme';
import { retryDeviceConnection } from '@/features/agents/connect-runtime';
import type { ConnectionSnapshot } from '@/features/connection/connection-supervisor';
import { useConnectionSnapshot, useForeground, usePendingCommands } from '@/features/connection/use-connection';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export const UNCERTAIN_DELIVERY_COPY =
  'Delivery could not be confirmed. Check the conversation before sending again.';

export type DeliveryState = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';

export function getDeliveryStatus(state?: DeliveryState) {
  switch (state) {
    case 'queued': return { label: '◷ Queued', detail: null };
    case 'sending': return { label: 'Sending…', detail: null };
    case 'sent': return { label: 'Sent', detail: null };
    case 'failed': return { label: 'Not sent', detail: null };
    case 'uncertain': return { label: 'Delivery uncertain', detail: UNCERTAIN_DELIVERY_COPY };
    default: return null;
  }
}

export function getConnectionStatus(
  snapshot: ConnectionSnapshot | undefined,
  now: number,
  queuedCount = 0,
): { kind: 'hidden' | 'small' | 'banner' | 'fatal'; text: string; reconnect: boolean } {
  if (snapshot?.phase === 'fatal') {
    const text = snapshot.errorCode === 'ERR_HOST_KEY_MISMATCH'
      ? 'Server identity changed. Review the host key in server settings.'
      : snapshot.errorCode === 'ERR_HOST_KEY_UNKNOWN'
        ? 'Verify this server’s host key before connecting.'
        : snapshot.errorCode === 'ERR_AUTHENTICATION'
          ? 'Sign in to this server to reconnect.'
          : snapshot.lastError ?? 'Connection needs attention. Review server settings.';
    return { kind: 'fatal', text, reconnect: false };
  }
  const queued = queuedCount > 0 ? `◷ ${queuedCount} queued` : '';
  if (!snapshot || snapshot.phase === 'connected') {
    return { kind: queued ? 'small' : 'hidden', text: queued, reconnect: false };
  }
  const elapsed = snapshot.disconnectedAt == null ? 0 : Math.max(0, now - snapshot.disconnectedAt);
  if (elapsed < 10_000) {
    return { kind: queued ? 'small' : 'hidden', text: queued, reconnect: false };
  }
  if (elapsed < 40_000) {
    const text = snapshot.phase === 'waiting_network' ? 'Waiting for a network…'
      : snapshot.phase === 'suspended' ? 'Connection paused'
        : 'Reconnecting…';
    return { kind: 'small', text: queued ? `${text} · ${queued}` : text, reconnect: false };
  }
  return {
    kind: 'banner',
    text: `Reconnecting… remote work may still be running${queued ? ` · ${queued}` : ''}`,
    reconnect: elapsed >= 120_000,
  };
}

type ConnectionStatusProps = {
  deviceId?: string | null;
  agentId?: string;
  /** Clearance for the existing dock/composer; this indicator never adds layout space. */
  bottomInset: number;
};

export function ConnectionStatus({ deviceId, ...props }: ConnectionStatusProps) {
  return deviceId ? <DeviceConnectionStatus key={deviceId} deviceId={deviceId} {...props} /> : null;
}

function DeviceConnectionStatus({
  deviceId, agentId, bottomInset,
}: Omit<ConnectionStatusProps, 'deviceId'> & { deviceId: string }) {
  const theme = useTheme();
  const focused = useIsFocused();
  const foreground = useForeground();
  const snapshot = useConnectionSnapshot(deviceId);
  const commands = usePendingCommands();
  const [now, setNow] = useState(Date.now);
  const { retrying, error, retry } = useConnectionRetry(deviceId);
  const visible = focused && foreground;
  const needsClock = snapshot != null && snapshot.phase !== 'connected' && snapshot.phase !== 'fatal';
  const queuedCount = commands.filter((command) =>
    command.deviceId === deviceId && (!agentId || command.agentId === agentId) &&
    (command.state === 'queued' || command.state === 'sending'),
  ).length;

  useEffect(() => {
    if (!visible || !needsClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible, needsClock]);
  const status = getConnectionStatus(snapshot, now, queuedCount);
  if (!visible || status.kind === 'hidden') return null;

  const label = status.kind === 'fatal' ? 'Connection needs attention'
    : status.reconnect ? 'Reconnect'
      : status.kind === 'banner' ? 'Reconnecting…' : status.text;
  return (
    <View
      testID="connection-status-overlay"
      pointerEvents="box-none"
      style={[styles.position, { bottom: bottomInset + Spacing.one }]}>
      <View style={[styles.indicator, glassRim(), { backgroundColor: theme.background }]}>
        <View style={styles.indicatorRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open connection details"
            accessibilityHint={status.text}
            onPress={() => router.push({ pathname: '/hosts/[id]', params: { id: deviceId } })}
            style={({ pressed }) => [styles.detailsButton, { opacity: pressed ? 0.7 : 1 }]}>
            <ThemedText
              type="caption"
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              themeColor={status.kind === 'fatal' ? 'warning' : 'textSecondary'}>
              {label}
            </ThemedText>
          </Pressable>
          {status.kind !== 'fatal' && snapshot?.phase !== 'connected' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reconnect now"
              accessibilityState={{ disabled: retrying }}
              disabled={retrying}
              onPress={() => void retry()}
              style={[styles.retryButton, { backgroundColor: theme.accentSoft, opacity: retrying ? 0.5 : 1 }]}>
              <ThemedText type="smallBold" themeColor="accent">{retrying ? 'Retrying…' : 'Retry'}</ThemedText>
            </Pressable>
          ) : null}
        </View>
        {error ? <ThemedText type="caption" themeColor="danger" style={styles.indicatorError}>{error}</ThemedText> : null}
      </View>
    </View>
  );
}

function useConnectionRetry(deviceId: string) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    setError(null);
    try {
      await retryDeviceConnection(deviceId);
    } catch (cause) {
      if (mounted.current) setError(toUserMessage(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setRetrying(false);
    }
  }
  return { retrying, error, retry };
}

export function ConnectionDetails({ deviceId }: { deviceId: string }) {
  return <DeviceConnectionDetails key={deviceId} deviceId={deviceId} />;
}

function DeviceConnectionDetails({ deviceId }: { deviceId: string }) {
  const snapshot = useConnectionSnapshot(deviceId);
  const commands = usePendingCommands().filter((command) => command.deviceId === deviceId);
  const queued = commands.filter((command) => command.state === 'queued' || command.state === 'sending').length;
  const attention = commands.filter((command) => command.state === 'failed' || command.state === 'uncertain').length;
  const { retrying, error, retry } = useConnectionRetry(deviceId);
  const connected = snapshot?.phase === 'connected';
  const status = snapshot?.phase === 'fatal' ? 'Needs attention'
    : connected ? 'Connected'
      : snapshot?.phase === 'waiting_network' ? 'Waiting for a network'
        : snapshot?.phase === 'suspended' ? 'Paused in background'
          : snapshot ? 'Reconnecting' : 'Not connected';
  return (
    <View style={styles.connectionDetails}>
      <ThemedText type="section">Agent connection</ThemedText>
      <ThemedText type="small" themeColor={connected ? 'success' : 'textSecondary'} accessibilityLiveRegion="polite">{status}</ThemedText>
      {snapshot?.lastError ? <ThemedText type="caption" themeColor="warning">{snapshot.lastError}</ThemedText> : null}
      {queued + attention > 0 ? <ThemedText type="caption" themeColor="textMuted">{queued} queued · {attention} need attention</ThemedText> : null}
      {!connected && snapshot?.phase !== 'fatal' ? <AppButton label={retrying ? 'Reconnecting…' : 'Reconnect now'} onPress={() => void retry()} disabled={retrying} /> : null}
      {snapshot?.phase === 'fatal' ? <ThemedText type="caption" themeColor="textMuted">Review the server settings or use Connect above to verify the connection.</ThemedText> : null}
      {error ? <ThemedText type="caption" themeColor="danger">{error}</ThemedText> : null}
    </View>
  );
}

export function CommandDelivery({
  commandId,
  delivery,
  deliveryError,
  discardLabel = 'Discard',
  onDiscard,
}: {
  commandId?: string;
  delivery?: DeliveryState;
  deliveryError?: string | null;
  discardLabel?: string;
  onDiscard?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const status = getDeliveryStatus(delivery);
  if (!status) return null;

  async function act(discard: boolean) {
    if (!commandId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (discard) {
        await herdrRepository.discardCommand(commandId);
        onDiscard?.();
      } else {
        await herdrRepository.retryCommand(commandId);
      }
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.delivery}>
      <ThemedText type="caption" themeColor="textMuted" accessibilityLiveRegion="polite">
        {status.label}
      </ThemedText>
      {status.detail ? (
        <ThemedText type="caption" themeColor="warning">{status.detail}</ThemedText>
      ) : null}
      {deliveryError ? (
        <ThemedText type="caption" themeColor="danger">{deliveryError}</ThemedText>
      ) : null}
      {commandId && (delivery === 'queued' || delivery === 'failed' || delivery === 'uncertain') ? (
        <View style={styles.actions}>
          {delivery === 'failed' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry the same message"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void act(false)}>
              <ThemedText type="caption" themeColor="accent">Retry same message</ThemedText>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void act(true)}>
            <ThemedText type="caption" themeColor="textSecondary">{discardLabel}</ThemedText>
          </Pressable>
        </View>
      ) : null}
      {error ? <ThemedText type="caption" themeColor="danger">{error}</ThemedText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  position: {
    position: 'absolute',
    left: Spacing.two,
    right: Spacing.two,
    alignItems: 'center',
  },
  indicator: {
    maxWidth: '100%',
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  indicatorRow: { flexDirection: 'row', alignItems: 'center' },
  detailsButton: { flexShrink: 1, minHeight: ControlHeight.regular + Spacing.half, justifyContent: 'center', paddingHorizontal: Spacing.two },
  retryButton: { minHeight: ControlHeight.regular + Spacing.half, justifyContent: 'center', paddingHorizontal: Spacing.two },
  indicatorError: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.one },
  connectionDetails: {
    gap: Spacing.one,
    padding: Spacing.two,
    borderRadius: Radius.control,
    backgroundColor: Colors.glass,
  },
  delivery: {
    gap: Spacing.half,
    paddingTop: Spacing.half,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    paddingVertical: Spacing.half,
  },
});
