import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { withIsolatedOperationPages } from '../src/session/page-lifecycle.js';

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

function fakePage() {
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    close,
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Page;
  return { page, close };
}
