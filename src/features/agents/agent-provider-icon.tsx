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
    case 'claude':
      return '#D97757';
    case 'codex':
      return '#10A37F';
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
    case 'claude':
      return <ClaudeIcon size={size} color={tintColor} />;
    case 'codex':
      return <CodexIcon size={size} color={tintColor} />;
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

function ClaudeIcon({ size, color }: IconProps) {
  // The glyph extends beyond 24 units and is centered near (16, 13.25).
  return (
    <Svg width={size} height={size} viewBox="2 -0.75 28 28" fill="none">
      <Path
        d="M4.773 14.022c-.527 0-.987-.35-.987-.878 0-.496.425-.877.947-.877h3.364c.28 0 .52-.163.63-.404l1.173-2.673a.873.873 0 0 0-.156-.99l-2.39-2.39a.885.885 0 0 1 0-1.248.885.885 0 0 1 1.248 0l2.39 2.39c.264.264.675.318.99.156l2.673-1.173a.68.68 0 0 0 .404-.63V1.94c0-.522.38-.947.877-.947.528 0 .878.46.878.987v3.364c0 .28.163.52.404.63l2.673 1.173c.315.162.726.108.99-.156l2.39-2.39a.885.885 0 0 1 1.248 0 .885.885 0 0 1 0 1.248l-2.39 2.39a.873.873 0 0 0-.156.99l1.173 2.673c.11.241.35.404.63.404h3.364c.522 0 .987.38.987.877 0 .528-.46.878-.987.878h-3.364a.68.68 0 0 0-.404.63l-1.173 2.673a.873.873 0 0 0 .156.99l2.39 2.39a.885.885 0 0 1 0 1.248.885.885 0 0 1-1.248 0l-2.39-2.39a.873.873 0 0 0-.99-.156l-2.673 1.173a.68.68 0 0 0-.404.63v3.364c0 .522-.35.987-.878.987-.496 0-.877-.425-.877-.947v-3.364a.68.68 0 0 0-.404-.63l-2.673-1.173a.873.873 0 0 0-.99.156l-2.39 2.39a.885.885 0 0 1-1.248 0 .885.885 0 0 1 0-1.248l2.39-2.39a.873.873 0 0 0 .156-.99l-1.173-2.673a.68.68 0 0 0-.63-.404H4.773Z"
        fill={color}
      />
    </Svg>
  );
}

function CodexIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.2 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.08zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14.08 4.78 2.76a.77.77 0 0 0 .78 0l5.85-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.69a.77.77 0 0 0 .38.67l5.82 3.36-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.85L13.1 8.36l2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.67a.79.79 0 0 0-.4-.67zm2.01-3.02l-.14-.08-4.78-2.79a.78.78 0 0 0-.78 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08L8.7 5.46a.79.79 0 0 0-.39.68zm1.1-2.37l2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5Z"
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
