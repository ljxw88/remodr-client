import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, ControlHeight, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useFormFieldFocus } from '@/components/ui/form-keyboard-context';

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
  editable?: boolean;
  autoFocus?: boolean;
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  maxLength?: number;
  selectTextOnFocus?: boolean;
  multiline?: boolean;
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
  editable = true,
  autoFocus = false,
  returnKeyType,
  onSubmitEditing,
  maxLength,
  selectTextOnFocus,
  multiline = false,
}: Props) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput | null>(null);
  const reveal = useFormFieldFocus();

  return (
    <View style={styles.wrap}>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <View
        style={[
          styles.inputFrame,
          {
            backgroundColor: theme.glassStrong,
            borderColor: error ? theme.danger : focused ? theme.accent : theme.glassBorder,
            borderTopColor: error
              ? theme.danger
              : focused
                ? theme.accent
                : theme.glassHighlight,
          },
        ]}>
        <TextInput
          ref={input}
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
          editable={editable}
          autoFocus={autoFocus}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          maxLength={maxLength}
          selectTextOnFocus={selectTextOnFocus}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          onFocus={() => { setFocused(true); reveal?.(input.current); }}
          onBlur={() => { setFocused(false); reveal?.(null); }}
          style={[
            styles.input,
            multiline && styles.multiline,
            {
              color: theme.text,
              fontFamily: multiline ? Fonts.mono : Fonts.regular,
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
    minHeight: ControlHeight.regular,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  input: {
    flex: 1,
    // The frame's own minimum, less its border, so the field is one height
    // rather than two that disagree by a couple of points.
    minHeight: ControlHeight.regular - 2,
    paddingHorizontal: Spacing.two,
    fontSize: 16,
    letterSpacing: -0.16,
  },
  rightAccessory: {
    marginRight: Spacing.half,
  },
  multiline: {
    minHeight: ControlHeight.row * 2,
    maxHeight: 220,
    paddingVertical: Spacing.one,
  },
});
