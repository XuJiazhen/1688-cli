import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import {
  getSharedContext,
  getSharedContextStatus,
  installSharedContextForTesting,
  releaseSharedContext,
} from '../src/session/shared.js';

afterEach(() => installSharedContextForTesting(null));

describe('releaseSharedContext containment', () => {
  it('retains lock/owner and denies replacement after close rejection with a live process', async () => {
    let releases = 0;
    installSharedContextForTesting({
      context: fakeContext(() => Promise.reject(new Error('close rejected'))),
      profile: 'profile-1',
      headful: true,
      release: async () => { releases += 1; },
    });

    await expect(releaseSharedContext({
      closeTimeoutMs: 5,
      processAlive: () => true,
    })).rejects.toMatchObject({ code: 'CONTEXT_RELEASE_UNPROVEN' });
    expect(releases).toBe(0);
    await expect(getSharedContextStatus()).resolves.toMatchObject({
      profile: 'profile-1',
      fatalRecoveryState: 'close rejected',
    });
    await expect(getSharedContext('profile-1', { headful: true }))
      .rejects.toMatchObject({ code: 'CONTEXT_QUARANTINED' });
  });

  it('retains lock/owner and denies replacement when close hangs past its deadline', async () => {
    let releases = 0;
    installSharedContextForTesting({
      context: fakeContext(() => new Promise<void>(() => {})),
      profile: 'profile-1',
      headful: true,
      release: async () => { releases += 1; },
    });

    await expect(releaseSharedContext({
      closeTimeoutMs: 1,
      processAlive: () => true,
    })).rejects.toMatchObject({ code: 'CONTEXT_RELEASE_UNPROVEN' });
    expect(releases).toBe(0);
    await expect(getSharedContext('profile-1', { headful: true }))
      .rejects.toMatchObject({ code: 'CONTEXT_QUARANTINED' });
  });

  it('retains the in-memory owner and denies restart when lock release fails', async () => {
    let releases = 0;
    installSharedContextForTesting({
      context: fakeContext(() => Promise.resolve()),
      profile: 'profile-1',
      headful: true,
      release: async () => {
        releases += 1;
        throw new Error('lock ownership uncertain');
      },
    });

    await expect(releaseSharedContext())
      .rejects.toMatchObject({ code: 'CONTEXT_LOCK_RELEASE_UNPROVEN' });
    expect(releases).toBe(1);
    await expect(getSharedContextStatus()).resolves.toMatchObject({
      profile: 'profile-1',
      fatalRecoveryState: expect.stringContaining('lock ownership uncertain'),
    });
    await expect(getSharedContext('profile-1', { headful: true }))
      .rejects.toMatchObject({ code: 'CONTEXT_QUARANTINED' });
    expect(releases).toBe(1);
  });
});

function fakeContext(close: () => Promise<void>): BrowserContext {
  return {
    close,
    browser: () => ({
      isConnected: () => true,
      process: () => ({ pid: 4242 }),
    }),
    pages: () => [],
  } as unknown as BrowserContext;
}
