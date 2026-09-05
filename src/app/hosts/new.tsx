import { router } from 'expo-router';
import { HostForm } from '@/features/hosts/HostForm';
import { hostRepository } from '@/services/host-repository';

export default function NewHostScreen() {
  return (
      <HostForm
        submitLabel="Save server"
        onSubmit={async (input) => {
          await hostRepository.create(input);
          if (router.canGoBack()) router.back();
          else router.replace('/servers');
        }}
      />
  );
}
