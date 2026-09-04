import { router } from 'expo-router';
import { Alert } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { HostForm } from '@/features/hosts/HostForm';
import { hostRepository } from '@/services/host-repository';
import { toUserMessage } from '@/utils/user-error';

export default function NewHostScreen() {
  return (
    <Screen>
      <HostForm
        submitLabel="Save server"
        onSubmit={async (input) => {
          try {
            await hostRepository.create(input);
            router.back();
          } catch (error) {
            Alert.alert('Could not save server', toUserMessage(error));
          }
        }}
      />
    </Screen>
  );
}
