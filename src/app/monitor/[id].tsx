import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import {
  parseDiskUsage,
  parseFreeMemory,
  parseNvidiaSmi,
  parseProcesses,
  parseUptime,
} from '@/services/parsers';
import { remoteClient } from '@/services/native-remote-client';

export default function MonitorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [uptime, setUptime] = useState('');
  const [memory, setMemory] = useState('');
  const [disks, setDisks] = useState('');
  const [gpus, setGpus] = useState('');
  const [processes, setProcesses] = useState('');

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    void fetchMetrics(session.sessionId).then((metrics) => {
      if (!active) {
        return;
      }
      setUptime(metrics.uptime);
      setMemory(metrics.memory);
      setDisks(metrics.disks);
      setGpus(metrics.gpus);
      setProcesses(metrics.processes);
    });
    return () => {
      active = false;
    };
  }, [session]);

  if (!session) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Monitor' }} />
        <ThemedText>Connect to this host first.</ThemedText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Monitor' }} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}>
        <View style={styles.grid}>
          <MetricCard label="Uptime" value={uptime} />
          <MetricCard label="Memory" value={memory} />
        </View>
        <MetricCard label="Disk" value={disks} />
        <MetricCard label="GPU" value={gpus} />
        <View
          style={[
            styles.card,
            { backgroundColor: theme.backgroundElement, borderColor: theme.border },
          ]}>
          <ThemedText type="label" themeColor="textMuted">
            PROCESSES
          </ThemedText>
          <ThemedText type="caption" style={styles.mono}>
            {processes}
          </ThemedText>
        </View>
      </ScrollView>
    </Screen>
  );
}

async function fetchMetrics(sessionId: string) {
  const exec = (command: string) => remoteClient.exec(sessionId, command);
  const [up, mem, df, gpu, ps] = await Promise.all([
    exec('uptime'),
    exec('free -b'),
    exec('df -P'),
    exec(
      'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits',
    ),
    exec('ps aux --sort=-pcpu | head -n 12'),
  ]);
  const parsedMem = parseFreeMemory(mem.stdout);

  return {
    uptime: parseUptime(up.stdout),
    memory: parsedMem
      ? `${parsedMem.usedBytes} / ${parsedMem.totalBytes} bytes used`
      : mem.stderr || 'Unavailable',
    disks: parseDiskUsage(df.stdout)
      .map((disk) => `${disk.mount} ${disk.capacity}`)
      .join('\n'),
    gpus:
      gpu.exitCode === 0
        ? parseNvidiaSmi(gpu.stdout)
            .map(
              (item) =>
                `${item.name} ${item.utilization}% ${item.memoryUsed}/${item.memoryTotal} MiB`,
            )
            .join('\n')
        : 'No NVIDIA GPU reported',
    processes: parseProcesses(ps.stdout)
      .map((row) => `${row.pid} ${row.cpu}% ${row.command}`)
      .join('\n'),
  };
}

function MetricCard({ label, value }: { label: string; value: string }) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <ThemedText type="label" themeColor="textMuted">
        {label.toUpperCase()}
      </ThemedText>
      <ThemedText type="small">{value || '—'}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: Spacing.two,
    paddingBottom: Spacing.five,
  },
  grid: {
    gap: Spacing.two,
  },
  card: {
    gap: Spacing.one,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  mono: {
    fontFamily: Fonts.mono,
    lineHeight: 20,
  },
});
