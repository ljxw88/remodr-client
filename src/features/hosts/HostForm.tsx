import { ReactNode, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  DEFAULT_HOST_FORM,
  parseHostForm,
  type CreateHostInput,
  type HostFieldErrors,
  type HostFormFields,
} from '@/domain/hosts';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  initialValues?: Partial<HostFormFields>;
  submitLabel: string;
  onSubmit: (input: CreateHostInput) => Promise<void>;
  footer?: ReactNode;
};

export function HostForm({ initialValues, submitLabel, onSubmit, footer }: Props) {
  const [fields, setFields] = useState<HostFormFields>({
    ...DEFAULT_HOST_FORM,
    ...initialValues,
  });
  const [fieldErrors, setFieldErrors] = useState<HostFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof HostFormFields>(key: K, value: HostFormFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit() {
    const parsed = parseHostForm(fields);
    if (!parsed.ok) {
      setFieldErrors(parsed.fieldErrors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        style={styles.flex}>
        <View style={styles.section}>
          <ThemedText type="section">Server</ThemedText>
          <TextField
            label="Name"
            value={fields.name}
            onChangeText={(value) => update('name', value)}
            error={fieldErrors.name}
            placeholder="GPU server"
            autoCapitalize="sentences"
          />
          <TextField
            label="Hostname or IP address"
            value={fields.hostname}
            onChangeText={(value) => update('hostname', value)}
            error={fieldErrors.hostname}
            placeholder="gpu01.example.com"
            autoComplete="off"
          />
        </View>

        <View style={styles.section}>
          <ThemedText type="section">Connection</ThemedText>
          <View style={styles.connectionRow}>
            <View style={styles.usernameField}>
              <TextField
                label="Username"
                value={fields.username}
                onChangeText={(value) => update('username', value)}
                error={fieldErrors.username}
                placeholder="ubuntu"
                autoComplete="username"
              />
            </View>
            <View style={styles.portField}>
              <TextField
                label="Port"
                value={fields.port}
                onChangeText={(value) => update('port', value)}
                error={fieldErrors.port}
                placeholder="22"
                keyboardType="number-pad"
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <ThemedText type="section">Authentication</ThemedText>
          <View style={styles.authRow}>
            <AuthChoice
              label="Password"
              selected={fields.authType === 'password'}
              onPress={() => update('authType', 'password')}
            />
            <AuthChoice
              label="Private Key"
              selected={fields.authType === 'privateKey'}
              onPress={() => update('authType', 'privateKey')}
            />
          </View>
        </View>

        <AppButton label={submitLabel} onPress={() => void handleSubmit()} disabled={submitting} />
        {footer}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function AuthChoice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          backgroundColor: selected ? theme.fog : theme.backgroundElement,
          borderColor: selected ? theme.text : theme.border,
        },
      ]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    gap: Spacing.four,
    paddingBottom: Spacing.five,
  },
  section: {
    gap: Spacing.two,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  usernameField: {
    flex: 1,
  },
  portField: {
    width: 96,
  },
  authRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  choice: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
});
