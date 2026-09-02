import { useState } from 'react';
import { StyleSheet, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoComplete?: TextInputProps['autoComplete'];
  secureTextEntry?: boolean;
};

export function TextField({
  label,
  value,
  onChangeText,
  error,
  placeholder,
  keyboardType,
  autoCapitalize = 'none',
  autoCorrect = false,
  autoComplete = 'off',
  secureTextEntry = false,
}: Props) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      <ThemedText type="label" themeColor="textMuted">
        {label}
      </ThemedText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholder}
        selectionColor={theme.accent}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoComplete={autoComplete}
        secureTextEntry={secureTextEntry}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.glassStrong,
            borderColor: error ? theme.danger : focused ? theme.accent : theme.glassBorder,
            fontFamily: Fonts.regular,
            shadowColor: focused ? theme.accent : theme.glassShadow,
            elevation: focused ? 3 : 1,
          },
        ]}
      />
      {error ? (
        <ThemedText
          accessibilityLiveRegion="polite"
          type="caption"
          style={{ color: theme.danger }}>
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.one,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.two,
    fontSize: 16,
    letterSpacing: -0.16,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 10,
  },
});
