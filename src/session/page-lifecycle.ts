import type { BrowserContext, Page } from 'playwright';

export async function withIsolatedOperationPages<T>(
  ctx: BrowserContext,
  operation: () => Promise<T>,
): Promise<T> {
  const baseline = new Set(ctx.pages());
  try {
    return await operation();
  } finally {
    const created = ctx.pages().filter((page) => !baseline.has(page));
    await Promise.all(created.map((page) => closeQuietly(page)));
  }
}

async function closeQuietly(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.close().catch(() => {});
}
