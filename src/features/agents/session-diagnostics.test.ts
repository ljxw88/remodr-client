import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import DiagnosticsScreen from '@/app/diagnostics';
import { remoteClient } from '@/services/native-remote-client';
import { sessionDiagnosticsCommand } from './session-diagnostics';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ agentId: 'agent-1' }),
}));
jest.mock('@/components/ui/screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ backgroundElement: '#000', border: '#333' }),
}));
jest.mock('@/features/agents/use-herdr', () => ({
  useHerdr: () => ({
    selectedDeviceId: 'device-1',
    devices: {
      'device-1': {
        connection: 'connected', hello: null, lastError: null,
        runtime: {
          agents: [{ id: 'agent-1', paneId: 'w2:p7' }],
          socketPath: '/tmp/herdr.sock',
        },
      },
    },
  }),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: { deviceIdForAgent: () => 'device-1' },
}));
jest.mock('@/services/native-remote-client', () => ({
  remoteClient: {
    getSession: () => ({ sessionId: 'ssh-1', status: 'connected' }),
    listSessions: () => [{ sessionId: 'ssh-1', status: 'connected' }],
    exec: jest.fn(async () => ({ stdout: '{"platform":"linux"}', stderr: '', exitCode: 0 })),
  },
}));

describe('read-only session diagnostics', () => {
  it('runs one remote query for the page, not one per summary row', async () => {
    jest.mocked(remoteClient.exec).mockClear();
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await TestRenderer.act(async () => {
        renderer = TestRenderer.create(createElement(DiagnosticsScreen));
      });
      expect(remoteClient.exec).toHaveBeenCalledTimes(1);
      expect(remoteClient.exec).toHaveBeenCalledWith(
        'ssh-1', sessionDiagnosticsCommand('w2:p7', '/tmp/herdr.sock'),
      );
    } finally {
      TestRenderer.act(() => renderer?.unmount());
    }
  });

  it('keeps remote identifiers as data, including quotes and heredoc-like text', () => {
    const pane = 'w2:p7';
    const socket = '/tmp/"socket"\nREMODR_SESSION_DIAGNOSTICS\n$(do-not-run)';
    const command = sessionDiagnosticsCommand(pane, socket);
    const script = command.split('\n').slice(1, -1).join('\n');
    const parsed = execFileSync('python3', ['-c', [
      'import ast,json,sys',
      'tree=ast.parse(sys.stdin.read())',
      'values={node.targets[0].id:node.value for node in tree.body if isinstance(node,ast.Assign)}',
      'print(json.dumps({"pane":ast.literal_eval(values["pane"]),"socket":ast.literal_eval(values["socket_path"].args[0])}))',
    ].join('\n')], { input: script, encoding: 'utf8' });
    expect(JSON.parse(parsed)).toEqual({ pane, socket });
    expect(command).not.toContain('agent.prompt');
    expect(command).not.toContain('send_keys');
  });
});
