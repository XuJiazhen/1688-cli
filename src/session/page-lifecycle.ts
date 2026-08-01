import type { BrowserContext, Page } from 'playwright';
import { CliError } from '../io/errors.js';

export interface PageLifecycleReceiptV1 {
  baselinePages: number;
  createdPages: number;
  closedPages: number;
  transferredPages: number;
  remainingOwnedPages: 0;
}

export interface IsolatedPageOwnershipV1 {
  transferToIntervention(page: Page): void;
  isTransferred(page: Page): boolean;
}

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

export async function withIsolatedOperationPagesReceipt<T>(
  ctx: BrowserContext,
  operation: (ownership: IsolatedPageOwnershipV1) => Promise<T>,
  options: { closeTimeoutMs?: number } = {},
): Promise<{ value: T; pageLifecycle: PageLifecycleReceiptV1 }> {
  const baseline = new Set(ctx.pages());
  const transferred = new Set<Page>();
  const ownership: IsolatedPageOwnershipV1 = {
    transferToIntervention(page) {
      if (baseline.has(page)) {
        throw new CliError(9, 'PAGE_OWNERSHIP_TRANSFER_INVALID', 'Cannot transfer a baseline Page.');
      }
      transferred.add(page);
    },
    isTransferred: (page) => transferred.has(page),
  };
  let value!: T;
  let operationError: unknown;
  try {
    value = await operation(ownership);
  } catch (error) {
    operationError = error;
  }
  const created = ctx.pages().filter((page) => !baseline.has(page));
  const owned = created.filter((page) => !transferred.has(page));
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  const failures: Page[] = [];
  await Promise.all(owned.map(async (page) => {
    if (page.isClosed()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Page close timed out.')), closeTimeoutMs);
        }),
      ]);
    } catch {
      failures.push(page);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  const remainingOwned = ctx.pages().filter(
    (page) => !baseline.has(page) && !transferred.has(page) && !page.isClosed(),
  );
  if (failures.length > 0 || remainingOwned.length > 0) {
    throw new CliError(9, 'PAGE_CLEANUP_FAILED', 'One or more PageAction-owned pages could not be closed.', {
      category: 'protocol',
      retryable: false,
      recoveryAction: 'rebuild-profile-context',
      createdPages: created.length,
      closeFailures: failures.length,
      remainingOwnedPages: remainingOwned.length,
    });
  }
  if (operationError !== undefined) throw operationError;
  return {
    value,
    pageLifecycle: {
      baselinePages: baseline.size,
      createdPages: created.length,
      closedPages: owned.length,
      transferredPages: transferred.size,
      remainingOwnedPages: 0,
    },
  };
}

async function closeQuietly(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.close().catch(() => {});
}
