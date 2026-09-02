import { AppIcon } from '@/components/ui/app-icon';
import type { AgentProvider } from '@/domain/herdr';

type Props = {
  provider: AgentProvider;
  size?: number;
  tintColor: string;
};

export function AgentProviderIcon({ provider, size = 22, tintColor }: Props) {
  return (
    <AppIcon
      name={providerIcon(provider)}
      size={size}
      tintColor={tintColor}
      fallback="A"
    />
  );
}

function providerIcon(provider: AgentProvider) {
  switch (provider) {
    case 'copilot':
      return {
        ios: 'chevron.left.forwardslash.chevron.right' as const,
        android: 'code' as const,
        web: 'code' as const,
      };
    case 'claude':
      return {
        ios: 'text.bubble' as const,
        android: 'chat' as const,
        web: 'chat' as const,
      };
    case 'codex':
      return {
        ios: 'terminal' as const,
        android: 'terminal' as const,
        web: 'terminal' as const,
      };
    default:
      return {
        ios: 'curlybraces' as const,
        android: 'data_object' as const,
        web: 'data_object' as const,
      };
  }
}
