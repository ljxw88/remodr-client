/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const { execFileSync } = require('child_process');
const { run } = require('./check-release-source.cjs');

describe('release source freshness', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(['push', 'workflow_dispatch'])('%s on current main is allowed', (event) => {
    execFileSync.mockReturnValue('current-sha\trefs/heads/main\n');
    expect(run({
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'current-sha',
    })).toBe(0);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
      { encoding: 'utf8' },
    );
  });

  test.each(['push', 'workflow_dispatch'])('%s cannot publish an older main commit', (event) => {
    execFileSync.mockReturnValue('new-sha\trefs/heads/main\n');
    expect(run({
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'old-sha',
    })).toBe(1);
  });

  test.each(['refs/heads/feature', 'refs/heads/v1.2.3', 'refs/tags/preview', undefined])(
    'manual runs from %p cannot overwrite the preview',
    (ref) => {
      expect(run({ GITHUB_REF: ref, GITHUB_SHA: 'some-sha' })).toBe(1);
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  test('version tags do not need to point to current main', () => {
    expect(run({ GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_SHA: 'old-sha' })).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('main advancing during the build is caught by the pre-publication recheck', () => {
    const env = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'build-sha' };
    execFileSync.mockReturnValueOnce('build-sha\trefs/heads/main\n');
    execFileSync.mockReturnValueOnce('new-sha\trefs/heads/main\n');
    expect(run(env)).toBe(0);
    expect(run(env)).toBe(1);
  });

  test('an empty remote response fails closed', () => {
    execFileSync.mockReturnValue('');
    expect(run({ GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'build-sha' })).toBe(1);
  });

  test('remote lookup failures are not treated as permission to publish', () => {
    execFileSync.mockImplementation(() => { throw new Error('network unavailable'); });
    expect(() => run({ GITHUB_REF: 'refs/heads/main' })).toThrow('network unavailable');
  });
});
