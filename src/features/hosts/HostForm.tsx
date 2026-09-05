import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  DEFAULT_HOST_FORM, parseHostForm,
  type CreateHostInput, type HostFieldErrors, type HostFormFields,
} from '@/domain/hosts';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  title?: string;
  initialValues?: Partial<HostFormFields>;
  submitLabel: string;
  onSubmit: (input: CreateHostInput) => Promise<void>;
  onSaved?: () => void;
  footer?: ReactNode;
};

export function HostForm({ title = 'New server', initialValues, submitLabel, onSubmit, onSaved, footer }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 360 || fontScale > 1.3;
  const [fields, setFields] = useState<HostFormFields>({ ...DEFAULT_HOST_FORM, ...initialValues });
  const [fieldErrors, setFieldErrors] = useState<HostFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function update<K extends keyof HostFormFields>(key: K, value: HostFormFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    const parsed = parseHostForm(fields);
    if (!parsed.ok) {
      setFieldErrors(parsed.fieldErrors);
      return;
    }
    inFlight.current = true;
    setFieldErrors({});
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
      if (mounted.current) onSaved?.();
    } catch (cause) {
      if (mounted.current) setError(toUserMessage(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <FormPage
      title={title}
      busy={submitting}
      footer={<AppButton label={submitting ? 'Saving…' : submitLabel} onPress={() => void handleSubmit()} disabled={submitting} />}>
      <View style={styles.section}>
        <ThemedText type="section">Server</ThemedText>
        <TextField label="Name" value={fields.name} onChangeText={(value) => update('name', value)}
          error={fieldErrors.name} placeholder="GPU server" autoCapitalize="sentences" editable={!submitting} />
        <TextField label="Hostname or IP address" value={fields.hostname} onChangeText={(value) => update('hostname', value)}
          error={fieldErrors.hostname} placeholder="gpu01.example.com" autoComplete="off" editable={!submitting} />
      </View>
      <View style={styles.section}>
        <ThemedText type="section">Connection</ThemedText>
        <View style={[styles.connectionRow, stacked && styles.stacked]}>
          <View style={stacked ? styles.fullWidth : styles.usernameField}>
            <TextField label="Username" value={fields.username} onChangeText={(value) => update('username', value)}
              error={fieldErrors.username} placeholder="ubuntu" autoComplete="username" editable={!submitting}
              returnKeyType="done" onSubmitEditing={() => void handleSubmit()} />
          </View>
          <View style={stacked ? styles.fullWidth : styles.portField}>
            <TextField label="Port" value={fields.port} onChangeText={(value) => update('port', value)}
              error={fieldErrors.port} placeholder="22" keyboardType="number-pad" editable={!submitting} />
          </View>
        </View>
      </View>
      <FormSection title="Authentication">
        <SelectionRow label="Password" selected={fields.authType === 'password'} disabled={submitting}
          onPress={() => update('authType', 'password')} />
        <SelectionRow label="Private key" selected={fields.authType === 'privateKey'} disabled={submitting}
          onPress={() => update('authType', 'privateKey')} />
      </FormSection>
      <FormError message={error} />
      {footer}
    </FormPage>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.two },
  connectionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  stacked: { flexDirection: 'column' },
  usernameField: { flex: 1 },
  portField: { width: 96 },
  fullWidth: { width: '100%' },
});
