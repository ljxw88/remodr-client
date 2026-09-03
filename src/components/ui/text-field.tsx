import { useState, type ReactNode } from 'react';
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
  rightAccessory?: ReactNode;
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
  rightAccessory,
}: Props) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      <ThemedText type="label" themeColor="textMuted">
        {label}
      </ThemedText>
      <View
        style={[
          styles.inputFrame,
          {
            backgroundColor: theme.glassStrong,
            borderColor: error ? theme.danger : focused ? theme.accent : theme.glassBorder,
            shadowColor: focused ? theme.accent : theme.glassShadow,
            elevation: focused ? 3 : 1,
          },
        ]}>
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
              fontFamily: Fonts.regular,
            },
          ]}
        />
        {rightAccessory ? (
          <View style={styles.rightAccessory}>{rightAccessory}</View>
        ) : null}
      </View>
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
  inputFrame: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.control,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 10,
  },
  input: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: Spacing.two,
    fontSize: 16,
    letterSpacing: -0.16,
  },
  rightAccessory: {
    marginRight: Spacing.half,
  },
});
