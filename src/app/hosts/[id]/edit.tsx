import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { Screen } from '@/components/ui/screen';
import type { HostProfile } from '@/domain/hosts';
import { hostFormFromProfile } from '@/domain/hosts';
import { HostForm } from '@/features/hosts/HostForm';
import { hostRepository } from '@/services/host-repository';
import { toUserMessage } from '@/utils/user-error';
import { ThemedText } from '@/components/themed-text';

export default function EditServerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [host, setHost] = useState<HostProfile | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    if (!id) {
      return;
    }
    void hostRepository.get(id).then((nextHost) => {
      if (active) {
        setHost(nextHost);
      }
    });
    return () => {
      active = false;
    };
  }, [id]);

  if (host === undefined) {
    return (
      <Screen>
        <ThemedText themeColor="textSecondary">Loading server…</ThemedText>
      </Screen>
    );
  }

  if (host === null) {
    return (
      <Screen>
        <ThemedText>Server not found.</ThemedText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Edit server' }} />
      <HostForm
        initialValues={hostFormFromProfile(host)}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          try {
            await hostRepository.update(host.id, input);
            router.back();
          } catch (error) {
            Alert.alert('Could not save server', toUserMessage(error));
          }
        }}
      />
    </Screen>
  );
}
