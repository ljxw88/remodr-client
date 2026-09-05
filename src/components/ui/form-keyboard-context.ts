import { createContext, useContext } from 'react';
import type { TextInput } from 'react-native';

export const FormKeyboardContext = createContext<((input: TextInput | null) => void) | null>(null);

export function useFormFieldFocus() {
  return useContext(FormKeyboardContext);
}
