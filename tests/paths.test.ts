import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  daemonLogFile,
  daemonVersionFile,
  defaultProfileName,
  lockFile,
  pidFile,
  profilePath,
  rootHash,
  stateFile,
  socketPathForPlatform,
} from '../src/session/paths.js';

describe('platform paths', () => {
  it('rejects profile names that can escape or alias the runtime directory', () => {
    for (const name of ['../outside', 'nested/profile', '..', '.', '/tmp/profile', 'nested\\profile']) {
      expect(() => defaultProfileName(name)).toThrow(/safe local identifier/u);
    }
  });

  it('uses Unix socket files outside Windows', () => {
    expect(socketPathForPlatform('darwin', '/Users/me/.1688')).toBe(
      path.join('/Users/me/.1688', 'daemon.sock'),
    );
    expect(socketPathForPlatform('linux', '/home/me/.1688')).toBe(
      path.join('/home/me/.1688', 'daemon.sock'),
    );
  });

  it('scopes Unix socket files by non-default profile', () => {
    expect(socketPathForPlatform('darwin', '/Users/me/.1688', 'work')).toBe(
      path.join('/Users/me/.1688', 'profiles', 'work', 'daemon.sock'),
    );
  });

  it('uses root-scoped named pipes on Windows', () => {
    const first = socketPathForPlatform('win32', 'C:\\Users\\alice\\.1688');
    const second = socketPathForPlatform('win32', 'C:\\Users\\bob\\.1688');

    expect(first).toMatch(/^\\\\\.\\pipe\\1688-cli-daemon-[a-f0-9]{12}$/);
    expect(second).toMatch(/^\\\\\.\\pipe\\1688-cli-daemon-[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it('scopes Windows named pipes by profile', () => {
    const def = socketPathForPlatform('win32', 'C:\\Users\\alice\\.1688');
    const work = socketPathForPlatform('win32', 'C:\\Users\\alice\\.1688', 'work');

    expect(def).toMatch(/^\\\\\.\\pipe\\1688-cli-daemon-[a-f0-9]{12}$/);
    expect(work).toMatch(/^\\\\\.\\pipe\\1688-cli-daemon-[a-f0-9]{12}-[a-f0-9]{12}$/);
    expect(work).not.toBe(def);
  });

  it('normalizes root hash casing', () => {
    expect(rootHash('C:\\Users\\Alice\\.1688')).toBe(
      rootHash('c:\\users\\alice\\.1688'),
    );
  });

  it('keeps default artifacts compatible and scopes non-default artifacts', () => {
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = '/tmp/bb1688-paths';
    try {
      expect(stateFile()).toBe(path.join('/tmp/bb1688-paths', 'state.json'));
      expect(lockFile()).toBe(path.join('/tmp/bb1688-paths', '.lock'));
      expect(pidFile()).toBe(path.join('/tmp/bb1688-paths', 'daemon.pid'));
      expect(daemonVersionFile()).toBe(path.join('/tmp/bb1688-paths', 'daemon.version'));
      expect(daemonLogFile()).toBe(path.join('/tmp/bb1688-paths', 'daemon.log'));

      const work = profilePath('work');
      expect(stateFile('work')).toBe(path.join(work, 'state.json'));
      expect(lockFile('work')).toBe(path.join(work, '.lock'));
      expect(pidFile('work')).toBe(path.join(work, 'daemon.pid'));
      expect(daemonVersionFile('work')).toBe(path.join(work, 'daemon.version'));
      expect(daemonLogFile('work')).toBe(path.join(work, 'daemon.log'));
    } finally {
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
    }
  });
});
