import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Text } from 'react-native';

type Props = Pick<SymbolViewProps, 'name' | 'size' | 'tintColor'> & {
  fallback?: string;
};

export function AppIcon({ name, size = 20, tintColor, fallback = '•' }: Props) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={tintColor}
      fallback={<Text style={{ color: tintColor, fontSize: size }}>{fallback}</Text>}
    />
  );
}
