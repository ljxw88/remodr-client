import {
  childRemoteFolderPath,
  isValidRemoteFolderName,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';

describe('remote folder paths', () => {
  it.each([
    ['~/', '~'],
    ['~/Projects/../Code', '~/Code'],
    ['Projects/app', '~/Projects/app'],
    ['/srv//apps/./api', '/srv/apps/api'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRemoteFolderPath(input)).toBe(expected);
  });

  it('maps home-relative paths to SFTP paths', () => {
    expect(remoteFolderSftpPath('~/')).toBe('.');
    expect(remoteFolderSftpPath('~/Projects/app')).toBe('./Projects/app');
    expect(remoteFolderSftpPath('/srv/app')).toBe('/srv/app');
  });

  it('navigates between parent and child folders', () => {
    expect(childRemoteFolderPath('~/Projects', 'app')).toBe('~/Projects/app');
    expect(parentRemoteFolderPath('~/Projects/app')).toBe('~/Projects');
    expect(parentRemoteFolderPath('~/Projects')).toBe('~');
    expect(parentRemoteFolderPath('~')).toBeNull();
    expect(parentRemoteFolderPath('/')).toBeNull();
  });

  it('accepts only a single new folder name', () => {
    expect(isValidRemoteFolderName('new-folder')).toBe(true);
    expect(isValidRemoteFolderName('../../tmp')).toBe(false);
    expect(isValidRemoteFolderName('nested/folder')).toBe(false);
    expect(isValidRemoteFolderName('..')).toBe(false);
  });
});
