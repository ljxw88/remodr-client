import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { Screen } from '@/components/ui/screen';
import type { HostProfile } from '@/domain/hosts';
import { hostFormFromProfile } from '@/domain/hosts';
import { HostForm } from '@/features/hosts/HostForm';
import { updateHost } from '@/features/hosts/host-lifecycle';
import { hostRepository } from '@/services/host-repository';
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
      <HostForm
        key={host.id}
        title="Edit server"
        initialValues={hostFormFromProfile(host)}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          await updateHost(host, { ...host, ...input });
        }}
        onSaved={() => router.dismissTo({ pathname: '/hosts/[id]', params: { id: host.id } })}
      />
  );
}
