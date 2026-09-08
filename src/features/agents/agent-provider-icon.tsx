import Svg, { Path } from 'react-native-svg';

import type { AgentProvider } from '@/domain/herdr';

type Props = {
  provider: AgentProvider;
  size?: number;
  tintColor: string;
};

type IconProps = {
  size: number;
  color: string;
};

export function providerBrandColor(provider: AgentProvider): string {
  switch (provider) {
    case 'copilot':
      return '#8957E5';
    case 'opencode':
      return '#737373';
    default:
      return '#94A3B8';
  }
}

export function AgentProviderIcon({ provider, size = 22, tintColor }: Props) {
  switch (provider) {
    case 'copilot':
      return <CopilotIcon size={size} color={tintColor} />;
    case 'opencode':
      return <OpenCodeIcon size={size} color={tintColor} />;
    default:
      return <UnknownAgentIcon size={size} color={tintColor} />;
  }
}

function CopilotIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 1.821.487 3.53 1.338 5L2.1 20.3a1 1 0 0 0 1.258 1.258l3.3-1.238A9.957 9.957 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2Zm-5.5 8.75a3.25 3.25 0 0 1 6.308-.942A3.25 3.25 0 0 1 17.5 13a3.25 3.25 0 0 1-3.25 3.25h-4.5A3.25 3.25 0 0 1 6.5 13v-2.25Z"
        fill={color}
      />
      <Path
        d="M9.75 14a.75.75 0 0 1 .75.75v.005a.75.75 0 0 1-1.5 0v-.005a.75.75 0 0 1 .75-.75Zm4.5 0a.75.75 0 0 1 .75.75v.005a.75.75 0 0 1-1.5 0v-.005a.75.75 0 0 1 .75-.75Z"
        fill={color}
      />
    </Svg>
  );
}

function OpenCodeIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 4h18v16H3V4Zm2 2v12h14V6H5Zm2 3h2v6H7V9Zm4 4h6v2h-6v-2Z"
        fillRule="evenodd"
        fill={color}
      />
    </Svg>
  );
}

function UnknownAgentIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1v1a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-1H3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h1v-1a5 5 0 0 1 5-5h2V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2Zm-3 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
        fill={color}
      />
    </Svg>
  );
}
