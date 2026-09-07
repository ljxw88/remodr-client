import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { FinishDot } from '@/components/ui/finish-dot';
import type { HostProfile } from '@/domain/hosts';
import { useHostSession } from '@/features/connection/use-host-session';
import { HostRow } from './HostRow';

jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: jest.fn() }));

const host: HostProfile = {
  id: 'server-a', name: 'Development', hostname: 'dev.example.com', username: 'user', port: 22,
  authType: 'password', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('HostRow connection status', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  function render() {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(HostRow, { host, onPress: jest.fn() }));
    });
  }

  it.each([
    ['connected', 'Connected'],
    ['connecting', 'Connecting\u2026'],
    ['disconnected', 'Offline'],
  ] as const)('shows only connection status when %s', (status, label) => {
    jest.mocked(useHostSession).mockReturnValue(
      status === 'disconnected' ? null : { sessionId: 'ssh-1', hostId: host.id, status },
    );
    render();
    expect(renderer.root.findAllByType(FinishDot)).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: label })).toBeDefined();
    const button = renderer.root.findByProps({ accessibilityRole: 'button' });
    expect(button.props.accessibilityLabel).toContain(label);
    expect(button.props.accessibilityLabel).not.toContain('unread');
  });
});
