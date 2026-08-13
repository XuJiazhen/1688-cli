import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

const shared = vi.hoisted(() => ({
  context: null as BrowserContext | null,
}));

vi.mock('../src/session/shared.js', () => ({
  getSharedContext: async () => shared.context,
  peekSharedContext: () => shared.context,
  releaseSharedContext: async () => undefined,
}));

import { SharedPersistentContextHost } from '../src/daemon/shared-context-host.js';

const DISCOVERY = '__vs1_profile_identity_discovery__';

describe('SharedPersistentContextHost identity discovery', () => {
  it('binds the current logged-in Context without navigating the human login Page', async () => {
    const goto = vi.fn();
    const page = {
      goto,
      url: () => 'https://www.1688.com/',
      title: async () => '1688',
      evaluate: async () => '',
    } as unknown as Page;
    shared.context = {
      cookies: async () => [{
        name: 'unb',
        value: 'observed-member',
        domain: '.1688.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      }],
    } as unknown as BrowserContext;
    const host = new SharedPersistentContextHost({
      profileId: 'profile-1',
      profileName: 'profile-1',
      daemonInstanceId: 'daemon-1',
      contextGeneration: 1,
      now: () => new Date('2026-08-13T12:30:00.000Z'),
      idFactory: () => 'receipt-1',
    });

    const receipt = await host.probeIdentity({
      expectedMemberId: DISCOVERY,
      probeRevision: 'discovery-v1',
      page,
    });

    expect(goto).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      observedMemberId: 'observed-member',
      pageState: 'normal',
      passed: true,
    });
  });

  it('reuses a recognized 1688 Page for an already-bound Profile', async () => {
    const goto = vi.fn(async () => ({ status: () => 200 }));
    const page = {
      goto,
      url: () => 'https://www.1688.com/',
      title: async () => '1688',
      evaluate: async () => '',
    } as unknown as Page;
    shared.context = {
      cookies: async () => [{
        name: 'unb',
        value: 'member-1',
        domain: '.1688.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      }],
    } as unknown as BrowserContext;
    const host = new SharedPersistentContextHost({
      profileId: 'profile-1',
      profileName: 'profile-1',
      daemonInstanceId: 'daemon-1',
      contextGeneration: 1,
      idFactory: () => 'receipt-2',
    });

    const receipt = await host.probeIdentity({
      expectedMemberId: 'member-1',
      probeRevision: 'health-v1',
      page,
    });

    expect(goto).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ pageState: 'normal', passed: true });
  });

  it('navigates an unrelated Page before checking an already-bound Profile', async () => {
    let currentUrl = 'about:blank';
    const goto = vi.fn(async (url: string) => {
      currentUrl = url;
      return { status: () => 200 };
    });
    const page = {
      goto,
      url: () => currentUrl,
      title: async () => currentUrl === 'about:blank' ? '' : '1688',
      evaluate: async () => '',
    } as unknown as Page;
    shared.context = {
      cookies: async () => [{
        name: 'unb', value: 'member-1', domain: '.1688.com', path: '/',
        expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
      }],
    } as unknown as BrowserContext;
    const host = new SharedPersistentContextHost({
      profileId: 'profile-1', profileName: 'profile-1', daemonInstanceId: 'daemon-1',
      contextGeneration: 1, idFactory: () => 'receipt-3',
    });

    const receipt = await host.probeIdentity({
      expectedMemberId: 'member-1', probeRevision: 'health-v1', page,
    });

    expect(goto).toHaveBeenCalledWith('https://www.1688.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    expect(receipt).toMatchObject({ pageState: 'normal', passed: true });
  });

  it('does not bind a stale identity cookie from an unrelated Page', async () => {
    const page = {
      goto: vi.fn(),
      url: () => 'about:blank',
      title: async () => '',
      evaluate: async () => '',
    } as unknown as Page;
    shared.context = {
      cookies: async () => [{
        name: 'unb', value: 'stale-member', domain: '.1688.com', path: '/',
        expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
      }],
    } as unknown as BrowserContext;
    const host = new SharedPersistentContextHost({
      profileId: 'profile-1', profileName: 'profile-1', daemonInstanceId: 'daemon-1',
      contextGeneration: 1, idFactory: () => 'receipt-4',
    });

    const receipt = await host.probeIdentity({
      expectedMemberId: DISCOVERY,
      probeRevision: 'discovery-v1',
      page,
    });

    expect(receipt).toMatchObject({
      observedMemberId: 'stale-member',
      pageState: 'unreachable',
      passed: false,
    });
  });
});
