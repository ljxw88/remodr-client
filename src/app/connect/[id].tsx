import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Switch } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { RemoteOperationError } from '@/domain/errors';
import type { HostProfile } from '@/domain/hosts';
import { connectHost } from '@/features/connection/connect-host';
import { refreshSessions } from '@/features/connection/use-host-session';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';
import { retryDeviceConnection } from '@/features/agents/connect-runtime';

export default function ConnectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return typeof id === 'string'
    ? <ConnectServerForm key={id} id={id} />
    : <FormPage title="Connect"><FormError message="No server was selected." /></FormPage>;
}

function ConnectServerForm({ id }: { id: string }) {
  const [host, setHost] = useState<HostProfile | null | undefined>();
  const [secret, setSecret] = useState('');
  const [saveSecret, setSaveSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (typeof id !== 'string') return;
    void hostRepository.get(id).then((value) => {
      if (active) setHost(value);
    }).catch((cause) => {
      if (active) setError(toUserMessage(cause));
    });
    return () => { active = false; };
  }, [id]);

  async function run(acceptedFingerprint?: string) {
    if (!host || inFlight.current || !mounted.current) return;
    if (!secret && !(host.credentialId && remoteClient.hasSecret(host.credentialId))) {
      setError(host.authType === 'privateKey' ? 'Enter a private key.' : 'Enter a password.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await connectHost(host, secret, { saveSecret, acceptedFingerprint });
      await retryDeviceConnection(host.id);
      refreshSessions();
      if (mounted.current) router.dismissTo({ pathname: '/hosts/[id]', params: { id: host.id } });
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof RemoteOperationError && cause.remoteError.type === 'hostKeyUnknown') {
        const fingerprint = cause.remoteError.fingerprint;
        Alert.alert('Trust this host?', `${host.hostname}\n${fingerprint}`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Trust and Save', onPress: () => { void run(fingerprint); } },
        ]);
      } else if (cause instanceof RemoteOperationError && cause.remoteError.type === 'hostKeyMismatch') {
        Alert.alert('Host key changed',
          `The fingerprint does not match the stored key.\n${cause.remoteError.fingerprint ?? ''}\nDo not ignore this unless you rotated keys on purpose.`);
      } else {
        setError(toUserMessage(cause));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (!host) {
    return (
      <FormPage title="Connect">
        <FormError message={error} />
        {!error ? <ThemedText type="small" themeColor="textSecondary">{host === null ? 'Server not found.' : 'Loading server…'}</ThemedText> : null}
      </FormPage>
    );
  }
  const saved = host.credentialId ? remoteClient.hasSecret(host.credentialId) : false;
  const privateKey = host.authType === 'privateKey';

  return (
    <FormPage
      title="Connect"
      busy={busy}
      footer={<AppButton label={busy ? 'Connecting…' : 'Connect'} onPress={() => void run()} disabled={busy || (!saved && !secret)} />}>
      <ThemedText type="heading">{host.name}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">{host.username}@{host.hostname}:{host.port}</ThemedText>
      <TextField
        label={privateKey ? 'Private key' : 'Password'}
        value={secret}
        onChangeText={(text) => { setSecret(text); setError(null); }}
        placeholder={saved ? 'Use saved credential' : undefined}
        autoComplete={privateKey ? 'off' : 'password'}
        secureTextEntry={!privateKey}
        multiline={privateKey}
        editable={!busy}
        returnKeyType={privateKey ? 'default' : 'go'}
        onSubmitEditing={privateKey ? undefined : () => void run()}
      />
      <FormSection title="Credential storage">
        <SelectionRow
          label="Remember credential"
          description="Encrypted with Android Keystore"
          accessory={<Switch value={saveSecret} onValueChange={setSaveSecret} disabled={busy} trackColor={{ true: Colors.accent }} accessibilityLabel="Remember credential" />}
        />
      </FormSection>
      <FormError message={error} />
    </FormPage>
  );
}
