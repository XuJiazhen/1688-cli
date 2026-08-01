import { describe, expect, it } from 'vitest';
import {
  PageRegistryError,
  ProfilePageRegistry,
  type ManagedPage,
} from '../src/daemon/page-registry.js';

class FakePage implements ManagedPage {
  closed = false;
  closeAttempts = 0;
  failClose = false;

  isClosed(): boolean { return this.closed; }
  url(): string { return 'https://detail.1688.com/offer/secret?token=nope'; }
  async close(): Promise<void> {
    this.closeAttempts += 1;
    if (this.failClose) throw new Error('close failed');
    this.closed = true;
  }
}

describe('ProfilePageRegistry', () => {
  it('atomically transfers the challenge Page and rejects stale WorkUnit cleanup', async () => {
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 3,
      idFactory: () => 'generated-id',
    });
    const page = new FakePage();
    const session = await registry.register(page, {
      pageSessionId: 'page-session-1',
      playwrightPageId: 'pw-page-1',
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'OFFER_DETAIL',
    });
    expect(session.contextGeneration).toBe(3);
    const transferred = await registry.transferToIntervention(
      session.pageSessionId,
      'work-1',
      'pending-intervention-1',
    );
    expect(transferred).toMatchObject({
      ownerKind: 'intervention',
      ownerId: 'pending-intervention-1',
      taskType: null,
    });
    const adopted = await registry.adoptPendingIntervention(
      session.pageSessionId,
      'pending-intervention-1',
      'intervention-1',
    );
    expect(adopted).toMatchObject({
      ownerKind: 'intervention',
      ownerId: 'intervention-1',
      transferredAt: transferred.transferredAt,
    });
    await expect(registry.close(
      session.pageSessionId,
      { ownerKind: 'work_unit', ownerId: 'work-1' },
      'stale-finally',
    )).rejects.toMatchObject({ code: 'STALE_PAGE_OWNER' });
    expect(page.closed).toBe(false);
    await registry.close(
      session.pageSessionId,
      { ownerKind: 'intervention', ownerId: 'intervention-1' },
      'verified',
    );
    expect(page.closed).toBe(true);
  });

  it('rolls back ownership when the durable transfer event cannot be appended', async () => {
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
      onEvent: (event) => {
        if (event.type === 'owner_transferred') throw new Error('event sink failed');
      },
    });
    const page = new FakePage();
    const session = await registry.register(page, {
      ownerKind: 'work_unit', ownerId: 'work-1', taskType: 'OFFER_DETAIL',
    });
    await expect(registry.transferToIntervention(
      session.pageSessionId,
      'work-1',
      'pending-intervention-1',
    )).rejects.toThrow('event sink failed');
    expect(registry.get(session.pageSessionId)).toMatchObject({
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'OFFER_DETAIL',
      transferredAt: null,
      state: 'open',
    });
  });

  it('rolls back a rejected registration event and closes the unowned raw Page', async () => {
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
      onEvent: (event) => {
        if (event.type === 'registered') throw new Error('event sink unavailable');
      },
    });
    const page = new FakePage();
    await expect(registry.register(page, {
      pageSessionId: 'page-session-rejected',
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'OFFER_DETAIL',
    })).rejects.toMatchObject({ code: 'PAGE_REGISTRATION_EVENT_FAILED' });
    expect(page.closed).toBe(true);
    expect(registry.get('page-session-rejected')).toBeNull();
    expect(registry.activeAutomationCount()).toBe(0);
  });

  it('retains a recoverable cleanup entry when event rollback cannot close the Page', async () => {
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
      onEvent: (event) => {
        if (event.type === 'registered') throw new Error('event sink unavailable');
      },
    });
    const page = new FakePage();
    page.failClose = true;
    await expect(registry.register(page, {
      pageSessionId: 'page-session-recoverable',
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'OFFER_DETAIL',
    })).rejects.toMatchObject({ code: 'PAGE_REGISTRATION_EVENT_FAILED' });
    expect(registry.get('page-session-recoverable')).toMatchObject({
      state: 'cleanup_failed',
      cleanupAttempts: 1,
    });
    expect(registry.hasCleanupFailures()).toBe(true);
  });

  it('records cleanup failure and permits an expected-owner retry', async () => {
    const events: string[] = [];
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
      onEvent: (event) => { events.push(event.type); },
    });
    const page = new FakePage();
    page.failClose = true;
    const session = await registry.register(page, {
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'SEARCH_DISCOVERY',
    });
    await expect(registry.close(
      session.pageSessionId,
      { ownerKind: 'work_unit', ownerId: 'work-1' },
      'terminal',
    )).rejects.toBeInstanceOf(PageRegistryError);
    expect(registry.hasCleanupFailures()).toBe(true);
    page.failClose = false;
    await registry.close(
      session.pageSessionId,
      { ownerKind: 'work_unit', ownerId: 'work-1' },
      'cleanup-retry',
    );
    expect(page.closeAttempts).toBe(2);
    expect(events).toEqual([
      'registered', 'close_started', 'close_failed', 'close_started', 'closed',
    ]);
  });

  it('closes unknown Context Pages as orphans and never stores their URL', async () => {
    const orphan = new FakePage();
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
    });
    const reconciled = await registry.reconcileContextPages(
      [orphan],
      () => 'orphan-pw-page',
    );
    expect(reconciled).toEqual({ orphanCount: 1, closeFailures: 0 });
    expect(orphan.closed).toBe(true);
    expect(JSON.stringify(registry.snapshot())).not.toContain('token=nope');
  });

  it('allows only one active WorkUnit Page per Profile', async () => {
    const registry = new ProfilePageRegistry({
      profileId: 'profile-1',
      contextGeneration: 1,
    });
    await registry.register(new FakePage(), {
      ownerKind: 'work_unit',
      ownerId: 'work-1',
      taskType: 'OFFER_DETAIL',
    });
    await expect(registry.register(new FakePage(), {
      ownerKind: 'work_unit',
      ownerId: 'work-2',
      taskType: 'OFFER_DETAIL',
    })).rejects.toMatchObject({ code: 'PROFILE_WORK_UNIT_BUSY' });
  });
});
