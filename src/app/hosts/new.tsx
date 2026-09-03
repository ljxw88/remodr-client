import { router } from 'expo-router';
import { Alert } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { canAddDevice } from '@/domain/subscription';
import { HostForm } from '@/features/hosts/HostForm';
import { useHosts } from '@/features/hosts/use-hosts';
import { useSubscription } from '@/features/subscription/use-subscription';
import { hostRepository } from '@/services/host-repository';
import { toUserMessage } from '@/utils/user-error';

export default function NewHostScreen() {
  const { hosts } = useHosts();
  const { isPro } = useSubscription();

  return (
    <Screen>
      <HostForm
        submitLabel="Save server"
        onSubmit={async (input) => {
          if (!canAddDevice(hosts.length, isPro)) {
            Alert.alert(
              'Device Limit Reached',
              __DEV__
                ? 'Free trial allows 1 remote device. Use the plan preview to test unlimited devices.'
                : 'This build supports 1 saved remote device.',
              __DEV__
                ? [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'View plan preview', onPress: () => router.push('/(tabs)/settings') },
                  ]
                : [{ text: 'OK' }],
            );
            return;
          }

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
