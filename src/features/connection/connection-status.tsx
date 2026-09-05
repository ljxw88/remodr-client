import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { retryDeviceConnection } from '@/features/agents/connect-runtime';
import type { ConnectionSnapshot } from '@/features/connection/connection-supervisor';
import { useConnectionSnapshot, usePendingCommands } from '@/features/connection/use-connection';
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

export function ConnectionStatus({ deviceId, agentId }: { deviceId?: string | null; agentId?: string }) {
  const theme = useTheme();
  const snapshot = useConnectionSnapshot(deviceId);
  const commands = usePendingCommands();
  const [now, setNow] = useState(Date.now);
  const [retryError, setRetryError] = useState<{ deviceId: string; message: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const queuedCount = commands.filter((command) =>
    command.deviceId === deviceId && (!agentId || command.agentId === agentId) &&
    (command.state === 'queued' || command.state === 'sending'),
  ).length;

  useEffect(() => {
    if (!snapshot || snapshot.phase === 'connected' || snapshot.phase === 'fatal') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [snapshot]);
  const error = retryError?.deviceId === deviceId && snapshot?.phase !== 'connected'
    ? retryError?.message : null;
  const status = getConnectionStatus(snapshot, now, queuedCount);
  if (status.kind === 'hidden' && !error) return null;

  async function retry() {
    if (!deviceId || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryDeviceConnection(deviceId);
    } catch (cause) {
      setRetryError({ deviceId, message: toUserMessage(cause) });
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }

  return (
    <View style={[
      styles.status,
      (status.kind === 'banner' || status.kind === 'fatal') && {
        backgroundColor: theme.backgroundElement,
        borderRadius: Radius.control,
      },
    ]}>
      <ThemedText
        type="caption"
        accessibilityLiveRegion="polite"
        themeColor={status.kind === 'fatal' ? 'warning' : 'textSecondary'}>
        {status.text}
      </ThemedText>
      {status.kind === 'fatal' && deviceId ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/hosts/[id]', params: { id: deviceId } })}>
          <ThemedText type="smallBold" themeColor="accent">Server settings</ThemedText>
        </Pressable>
      ) : status.reconnect ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          disabled={retrying}
          onPress={() => void retry()}>
          <ThemedText type="smallBold" themeColor="accent">
            {retrying ? 'Reconnecting…' : 'Reconnect now'}
          </ThemedText>
        </Pressable>
      ) : null}
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
  status: {
    gap: Spacing.half,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
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
