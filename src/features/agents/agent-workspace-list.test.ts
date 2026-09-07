import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { FinishDot } from '@/components/ui/finish-dot';
import { remoteAgentSchema, type AgentWorkspace } from '@/domain/herdr';
import { AgentWorkspaceList, type AgentWorkspaceSection } from './agent-workspace-list';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));

function agent(id: string, unread: boolean) {
  return remoteAgentSchema.parse({
    id, paneId: id, provider: 'copilot', workspaceId: 'space-1', workspaceName: 'Space',
    herdrSessionId: 'default', title: id, focused: false, status: 'done',
    capabilities: {},
    completion: unread ? { id: `finish-${id}`, unread: true, statusRevision: 1 } : undefined,
  });
}

function section(agents: ReturnType<typeof agent>[]): AgentWorkspaceSection {
  const space: AgentWorkspace = { id: 'space-1', name: 'Space', status: 'idle' };
  return { space, agents };
}

describe('AgentWorkspaceList unread finish dots', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => TestRenderer.act(() => renderer?.unmount()));

  function render(sections: AgentWorkspaceSection[]) {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(AgentWorkspaceList, { sections }));
    });
  }

  it('draws a row dot only for agents with an unread completion receipt', () => {
    render([section([agent('a', true), agent('b', false)])]);
    const rowDots = renderer.root.findAllByType(FinishDot).filter((node) => node.props.count == null);
    expect(rowDots).toHaveLength(1);
    expect(rowDots[0].props.label).toBe('Unread finished work');
  });

  it('aggregates the workspace header dot from unread rows, not from row count', () => {
    render([section([agent('a', true), agent('b', true), agent('c', false)])]);
    const groupDot = renderer.root.findAllByType(FinishDot).find((node) => node.props.count != null);
    expect(groupDot?.props.count).toBe(2);
    expect(groupDot?.props.label).toContain('2 unread finished agents in Space');
  });

  it('omits both row and group dots once every agent in the section is read', () => {
    render([section([agent('a', false), agent('b', false)])]);
    expect(renderer.root.findAllByType(FinishDot)).toHaveLength(0);
  });

  it('reading one agent lowers the group aggregate without clearing the other row dot', () => {
    render([section([agent('a', true), agent('b', true)])]);
    expect(renderer.root.findAllByType(FinishDot).find((node) => node.props.count != null)?.props.count).toBe(2);

    // Acknowledge only "a": its receipt flips to unread: false, as the parent
    // would persist after a focused conversation read.
    TestRenderer.act(() => {
      renderer.update(createElement(AgentWorkspaceList, { sections: [section([agent('a', false), agent('b', true)])] }));
    });
    const dots = renderer.root.findAllByType(FinishDot);
    const rowDots = dots.filter((node) => node.props.count == null);
    const groupDot = dots.find((node) => node.props.count != null);
    expect(rowDots).toHaveLength(1);
    expect(groupDot?.props.count).toBe(1);
  });
});
