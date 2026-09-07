/* global afterEach, beforeEach, describe, expect, jest, test */
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('./sync-version.cjs');

describe('version synchronization', () => {
  let packageJson;
  let appJson;
  let write;

  beforeEach(() => {
    execFileSync.mockReset();
    packageJson = { version: '1.2.3' };
    appJson = {
      expo: {
        version: '1.2.3',
        android: { versionCode: 7, package: 'com.example.app' },
        ios: { buildNumber: '7' },
        extra: { keep: true },
      },
    };
    jest.spyOn(fs, 'readFileSync').mockImplementation((file) => {
      if (path.basename(file) === 'package.json') return JSON.stringify(packageJson);
      if (path.basename(file) === 'app.json') return JSON.stringify(appJson);
      throw new Error(`Unexpected read: ${file}`);
    });
    write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('checking matching versions never writes, even with --no-increment', () => {
    expect(run(['--check', '--no-increment'])).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  test('checking a mismatch fails without repairing app.json', () => {
    appJson.expo.version = '1.2.2';
    expect(run(['--check'])).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([undefined, null, 0, -1, 1.5, '7', 'invalid', 2100000001])(
    'checking rejects invalid Android versionCode %p without writing',
    (versionCode) => {
      appJson.expo.android.versionCode = versionCode;
      expect(run(['--check'])).toBe(1);
      expect(write).not.toHaveBeenCalled();
    },
  );

  test('checking accepts the maximum Android versionCode', () => {
    appJson.expo.android.versionCode = 2100000000;
    expect(run(['--check'])).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([{}, { expo: {} }, { expo: { version: '1.2.3' } }])(
    'checking missing configuration fails without creating it: %p',
    (config) => {
      appJson = config;
      expect(run(['--check'])).toBe(1);
      expect(write).not.toHaveBeenCalled();
    },
  );

  test('checking rejects missing package and app versions', () => {
    delete packageJson.version;
    delete appJson.expo.version;
    expect(run(['--check'])).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test.each(['1.2.3', '1.2.3-beta.1', '1.2.3+build.4'])(
    'an exact v-prefixed release tag matches version %s',
    (version) => {
      packageJson.version = version;
      appJson.expo.version = version;
      expect(run(['--check', '--tag', `v${version}`])).toBe(0);
      expect(write).not.toHaveBeenCalled();
    },
  );

  test.each(['v1.2.2', '1.2.3', 'v1.2.3-beta.1', 'preview'])(
    'a mismatched release tag %s fails without mutation',
    (tag) => {
      expect(run(['--check', '--tag', tag])).toBe(1);
      expect(write).not.toHaveBeenCalled();
    },
  );

  test('a matching tag cannot conceal an app version mismatch', () => {
    appJson.expo.version = '1.2.2';
    expect(run(['--check', '--tag', 'v1.2.3'])).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test('checks the actual APK manifest without mutating version files', () => {
    execFileSync.mockReturnValue('1.2.3\n');
    expect(run(['--check', '--tag', 'v1.2.3', '--apk', 'build/my app.apk'])).toBe(0);
    expect(execFileSync).toHaveBeenCalledWith(
      'apkanalyzer', ['manifest', 'version-name', 'build/my app.apk'], { encoding: 'utf8' },
    );
    expect(write).not.toHaveBeenCalled();
  });

  test.each(['1.2.2\n', ''])('rejects an APK version %p that differs from its release label', (version) => {
    execFileSync.mockReturnValue(version);
    expect(run(['--check', '--apk', 'build/app.apk'])).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test('fails closed when the APK manifest cannot be inspected', () => {
    execFileSync.mockImplementation(() => { throw new Error('APK analyzer failed'); });
    expect(run(['--check', '--apk', 'build/app.apk'])).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([
    ['--tag', 'v1.2.3'],
    ['--check', '--tag'],
    ['--check', '--tag', ''],
    ['--check', '--tag', '--no-increment'],
    ['--check', '--tag', 'v1.2.3', '--tag', 'v1.2.3'],
    ['--chek'],
    ['--apk', 'build/app.apk'],
    ['--check', '--apk'],
    ['--check', '--apk', '--tag', 'v1.2.3'],
    ['--check', '--apk', 'first.apk', '--apk', 'second.apk'],
  ])('invalid arguments %p cannot accidentally bump versions', (...args) => {
    expect(run(args)).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([
    [[], 8],
    [['--no-increment'], 7],
  ])('sync %p preserves increment semantics and unrelated configuration', (args, code) => {
    appJson.expo.version = '1.2.2';
    expect(run(args)).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    const [file, contents, encoding] = write.mock.calls[0];
    expect(path.basename(file)).toBe('app.json');
    expect(encoding).toBe('utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(JSON.parse(contents)).toEqual({
      expo: {
        ...appJson.expo,
        version: '1.2.3',
        android: { ...appJson.expo.android, versionCode: code },
        ios: { buildNumber: String(code) },
      },
    });
  });

  test.each([
    [[], 2],
    [['--no-increment'], 1],
  ])('sync %p initializes missing configuration using existing defaults', (args, code) => {
    appJson = {};
    expect(run(args)).toBe(0);
    expect(JSON.parse(write.mock.calls[0][1])).toEqual({
      expo: {
        version: '1.2.3',
        android: { versionCode: code },
        ios: { buildNumber: String(code) },
      },
    });
  });
});
