import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { glassRim } from '@/components/ui/glass-surface';
import { SheetModal, SheetPanel } from '@/components/ui/sheet';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
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
  const [sheet, setSheet] = useState<{ closeOnConnected: boolean } | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const mounted = useRef(true);
  const openSettingsAfterClose = useRef(false);
  const visible = focused && foreground;
  const needsClock = snapshot != null && snapshot.phase !== 'connected' && snapshot.phase !== 'fatal';
  const queuedCount = commands.filter((command) =>
    command.deviceId === deviceId && (!agentId || command.agentId === agentId) &&
    (command.state === 'queued' || command.state === 'sending'),
  ).length;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!visible || !needsClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible, needsClock]);
  const status = getConnectionStatus(snapshot, now, queuedCount);
  if (!visible || (status.kind === 'hidden' && !sheet)) return null;

  async function retry(close: () => void) {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      const connected = await retryDeviceConnection(deviceId);
      if (mounted.current && connected) close();
    } catch (cause) {
      if (mounted.current) setRetryError(toUserMessage(cause));
    } finally {
      retryingRef.current = false;
      if (mounted.current) setRetrying(false);
    }
  }

  function dismiss() {
    if (!mounted.current) return;
    setSheet(null);
    setRetryError(null);
    if (openSettingsAfterClose.current) {
      openSettingsAfterClose.current = false;
      router.push({ pathname: '/hosts/[id]', params: { id: deviceId } });
    }
  }

  const label = status.kind === 'fatal' ? 'Connection needs attention'
    : status.reconnect ? 'Reconnect'
      : status.kind === 'banner' ? 'Reconnecting…' : status.text;
  const recovered = sheet?.closeOnConnected === true && snapshot?.phase === 'connected';

  return (
    <>
      {status.kind !== 'hidden' ? (
        <View
          testID="connection-status-overlay"
          pointerEvents="box-none"
          style={[styles.position, { bottom: bottomInset + Spacing.one }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open connection details"
            accessibilityHint={status.text}
            onPress={() => {
              openSettingsAfterClose.current = false;
              setRetryError(null);
              setSheet({ closeOnConnected: snapshot?.phase !== 'connected' });
            }}
            style={({ pressed }) => [
              styles.indicator,
              glassRim(),
              { backgroundColor: theme.background, opacity: pressed ? 0.8 : 1 },
            ]}>
            <ThemedText
              type="caption"
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              themeColor={status.kind === 'fatal' ? 'warning' : 'textSecondary'}>
              {label}
            </ThemedText>
          </Pressable>
        </View>
      ) : null}
      {sheet ? (
        <SheetModal closeLabel="Close connection details" onClose={dismiss}>
          {(close) => (
            <ConnectionSheetContent
              close={close}
              resolved={recovered || status.kind === 'hidden'}
              text={recovered ? 'Connected.' : status.text}
              fatal={status.kind === 'fatal'}
              connected={snapshot?.phase === 'connected'}
              retrying={retrying}
              error={retryError}
              onRetry={() => void retry(close)}
              onSettings={() => {
                openSettingsAfterClose.current = true;
                close();
              }}
            />
          )}
        </SheetModal>
      ) : null}
    </>
  );
}

function ConnectionSheetContent({
  close, resolved, text, fatal, connected, retrying, error, onRetry, onSettings,
}: {
  close: () => void;
  resolved: boolean;
  text: string;
  fatal: boolean;
  connected: boolean;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
  onSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (resolved) close();
  }, [resolved, close]);

  return (
    <SheetPanel onClose={close}>
      <ScrollView
        contentContainerStyle={[styles.sheetContent, { paddingBottom: Math.max(insets.bottom, Spacing.two) }]}
        showsVerticalScrollIndicator={false}>
        <ThemedText type="heading" style={styles.sheetTitle}>Connection</ThemedText>
        <ThemedText type="small" accessibilityLiveRegion="polite" themeColor={fatal ? 'warning' : 'textSecondary'}>
          {text}
        </ThemedText>
        {!fatal && !connected ? (
          <ThemedText type="caption" themeColor="textMuted">
            Automatic reconnection continues. You can close this panel and keep reading or writing.
          </ThemedText>
        ) : null}
        {fatal ? (
          <AppButton label="Server settings" onPress={onSettings} />
        ) : !connected ? (
          <AppButton label={retrying ? 'Reconnecting…' : 'Reconnect now'} onPress={onRetry} disabled={retrying} />
        ) : null}
        {error ? <ThemedText type="caption" themeColor="danger">{error}</ThemedText> : null}
      </ScrollView>
    </SheetPanel>
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
    minHeight: ControlHeight.regular,
    justifyContent: 'center',
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  sheetContent: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  sheetTitle: {
    paddingRight: ControlHeight.regular,
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
