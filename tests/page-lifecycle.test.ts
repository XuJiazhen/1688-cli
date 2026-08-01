import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  withIsolatedOperationPages,
  withIsolatedOperationPagesReceipt,
} from '../src/session/page-lifecycle.js';

describe('withIsolatedOperationPages', () => {
  it('closes pages created by a successful operation but preserves baseline pages', async () => {
    const baseline = fakePage();
    const first = fakePage();
    const second = fakePage();
    let pages = [baseline.page];
    const ctx = { pages: () => pages } as unknown as BrowserContext;

    const result = await withIsolatedOperationPages(ctx, async () => {
      pages = [baseline.page, first.page, second.page];
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(baseline.close).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes created pages after an error and preserves the original error', async () => {
    const baseline = fakePage();
    const created = fakePage();
    let pages = [baseline.page];
    const ctx = { pages: () => pages } as unknown as BrowserContext;
    const failure = new Error('offer failed');

    await expect(withIsolatedOperationPages(ctx, async () => {
      pages = [baseline.page, created.page];
      throw failure;
    })).rejects.toBe(failure);

    expect(baseline.close).not.toHaveBeenCalled();
    expect(created.close).toHaveBeenCalledOnce();
  });
});

describe('withIsolatedOperationPagesReceipt', () => {
  it('records exact baseline/create/close counts and preserves transferred intervention pages', async () => {
    const baseline = statefulPage();
    const owned = statefulPage();
    const intervention = statefulPage();
    let pages = [baseline.page];
    const ctx = { pages: () => pages } as unknown as BrowserContext;
    const result = await withIsolatedOperationPagesReceipt(ctx, async (ownership) => {
      pages = [baseline.page, owned.page, intervention.page];
      ownership.transferToIntervention(intervention.page);
      return 'ok';
    });
    expect(result).toEqual({
      value: 'ok',
      pageLifecycle: {
        baselinePages: 1, createdPages: 2, closedPages: 1,
        transferredPages: 1, remainingOwnedPages: 0,
      },
    });
    expect(owned.close).toHaveBeenCalledOnce();
    expect(intervention.close).not.toHaveBeenCalled();
  });

  it('raises PAGE_CLEANUP_FAILED when a terminal owned page cannot close', async () => {
    const created = statefulPage(true);
    let pages: Page[] = [];
    const ctx = { pages: () => pages } as unknown as BrowserContext;
    await expect(withIsolatedOperationPagesReceipt(ctx, async () => {
      pages = [created.page];
      return 'never-terminal';
    }, { closeTimeoutMs: 5 })).rejects.toMatchObject({ code: 'PAGE_CLEANUP_FAILED' });
  });
});

function fakePage() {
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    close,
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Page;
  return { page, close };
}

function statefulPage(failClose = false) {
  let closed = false;
  const close = vi.fn(async () => {
    if (failClose) throw new Error('close failed');
    closed = true;
  });
  const page = {
    close,
    isClosed: vi.fn(() => closed),
  } as unknown as Page;
  return { page, close };
}
