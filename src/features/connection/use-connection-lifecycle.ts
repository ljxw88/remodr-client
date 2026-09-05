import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import {
  connectionSupervisor,
  startConnectionRuntime,
  stopConnectionRuntime,
} from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';
import { getRemoteCoreNativeModule } from '@/services/native-remote-client';

let notificationPermissionRequested = false;
let serviceOperations: Promise<void> = Promise.resolve();

export function useConnectionLifecycle() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    let disposed = false;
    let foreground = AppState.currentState === 'active';
    let online = true;
    let serviceAlive = false;
    let serviceAttempted = false;
    let servicePending = false;
    let networkKey: string | null = null;
    let networkTimer: ReturnType<typeof setTimeout> | undefined;
    let checkingHealth = false;
    let native: ReturnType<typeof getRemoteCoreNativeModule> | null = null;
    try {
      native = getRemoteCoreNativeModule();
    } catch (error) {
      console.warn('[CONNECTION] Background connection service unavailable', error);
    }

    function publishEnvironment() {
      if (!disposed) {
        connectionSupervisor.setEnvironment({
          online,
          foreground,
          backgroundAllowed: serviceAlive,
        });
      }
    }

    function needsService() {
      const desired = connectionSupervisor.getSnapshot();
      const enabled = (deviceId: string) => desired[deviceId] && desired[deviceId].phase !== 'fatal';
      return Object.values(herdrRepository.getSnapshot().devices).some((device) =>
        enabled(device.deviceId) && device.runtime.agents.some((agent) => agent.status === 'working'),
      ) || herdrRepository.getPendingCommands().some((command) =>
        enabled(command.deviceId) && (command.state === 'queued' || command.state === 'sending'),
      );
    }

    function reconcileService() {
      if (disposed || !native || servicePending) return;
      const needed = needsService();
      if (!needed) serviceAttempted = false;
      if (needed ? serviceAlive || !foreground || serviceAttempted : !serviceAlive) return;
      servicePending = true;
      if (needed) serviceAttempted = true;
      serviceOperations = serviceOperations.then(async () => {
        if (disposed || !native) return;
        if (needed && foreground && !notificationPermissionRequested && Number(Platform.Version) >= 33) {
          notificationPermissionRequested = true;
          try {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
          } catch (error) {
            console.warn('[CONNECTION] Notification permission unavailable', error);
          }
        }
        // Permission UI can outlive this mount or send the app to the background.
        if (disposed || (needed && (!foreground || !needsService()))) return;
        const active = await native.setConnectionService(
          needed,
          'Keeping active agents and queued messages connected',
        );
        if (disposed) {
          if (active) await native.setConnectionService(false, '');
          return;
        }
        serviceAlive = active;
        publishEnvironment();
      }).catch((error) => {
        if (!disposed) {
          serviceAlive = false;
          publishEnvironment();
          console.warn('[CONNECTION] Could not update connection service', error);
        }
      }).finally(() => {
        servicePending = false;
        if (!disposed) reconcileService();
      });
    }

    async function checkHealth() {
      if (disposed || checkingHealth || !online || (!foreground && !serviceAlive)) return;
      checkingHealth = true;
      try {
        await connectionSupervisor.checkHealth();
      } catch (error) {
        console.warn('[CONNECTION] Health check failed', error);
      } finally {
        checkingHealth = false;
      }
    }

    function onNetwork(state: NetInfoState) {
      if (disposed) return;
      if (networkTimer) clearTimeout(networkTimer);
      networkTimer = setTimeout(() => {
        if (disposed) return;
        // Public internet reachability is only a hint: LAN/VPN SSH can still work.
        online = state.isConnected !== false;
        const details = state.details as Record<string, unknown> | null;
        const nextKey = JSON.stringify([
          state.type, state.isConnected, state.isInternetReachable,
          details?.ipAddress, details?.subnet, details?.interface,
          details?.cellularGeneration,
        ]);
        const changed = networkKey !== null && networkKey !== nextKey;
        networkKey = nextKey;
        publishEnvironment();
        if (changed) connectionSupervisor.networkChanged();
      }, 300);
    }

    const networkSubscription = NetInfo.addEventListener(onNetwork);
    const stateSubscription = AppState.addEventListener('change', (state) => {
      const wasForeground = foreground;
      foreground = state === 'active';
      if (foreground && !wasForeground) serviceAttempted = false;
      publishEnvironment();
      reconcileService();
      if (foreground && !wasForeground) {
        void checkHealth();
        void NetInfo.fetch().then(onNetwork).catch((error) => {
          console.warn('[CONNECTION] Could not refresh network state', error);
        });
      }
    });
    const serviceSubscription = native?.addListener('onConnectionServiceChange', (event) => {
      if (disposed) return;
      serviceAlive = event.active;
      if (!event.active && event.reason) serviceAttempted = true;
      publishEnvironment();
    });
    const runtimeSubscription = herdrRepository.subscribe(reconcileService);
    const commandSubscription = herdrRepository.subscribeCommands(reconcileService);
    const supervisorSubscription = connectionSupervisor.subscribe(reconcileService);
    publishEnvironment();
    void startConnectionRuntime().catch((error) => {
      if (!disposed) console.warn('[CONNECTION] Could not start connection runtime', error);
    });
    reconcileService();

    return () => {
      disposed = true;
      networkSubscription();
      stateSubscription.remove();
      serviceSubscription?.remove();
      runtimeSubscription();
      commandSubscription();
      supervisorSubscription();
      clearTimeout(networkTimer);
      stopConnectionRuntime();
      // Serialize teardown before a StrictMode remount can start a new service.
      serviceOperations = serviceOperations.then(async () => {
        await native?.setConnectionService(false, '');
      }).catch((error) => {
        console.warn('[CONNECTION] Could not stop connection service', error);
      });
    };
  }, []);
}
