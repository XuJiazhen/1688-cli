import type { Page } from 'playwright';
import { CliError } from '../io/errors.js';
import {
  STORE_CATALOG_COMPONENT_KEY,
} from './alisite-module.js';
import { isSafeSupplierMemberKey } from './qualification-capture.js';

export interface StoreCatalogRuntimeRequestInput {
  memberId: string;
  pageNum: number;
  count: number;
  catId?: string | null;
  keywords?: string | null;
  sortType?: string | null;
}

export interface StoreCatalogRuntimeRequest {
  api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService';
  v: '1.0';
  type: 'POST';
  dataType: 'json';
  data: {
    componentKey: typeof STORE_CATALOG_COMPONENT_KEY;
    params: string;
  };
}

export interface CatalogRuntimeDeadlineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

const CATALOG_PAGE_MAX = 100_000;
const CATALOG_PAGE_SIZE_MAX = 100;

export function buildStoreCatalogRuntimeRequest(
  input: StoreCatalogRuntimeRequestInput,
): StoreCatalogRuntimeRequest {
  if (!isSafeSupplierMemberKey(input.memberId)) {
    throw new TypeError(
      'Store catalog runtime requires a safe, non-empty 1688 shop member key.',
    );
  }
  assertPositiveInteger(input.pageNum, 'pageNum', CATALOG_PAGE_MAX);
  assertPositiveInteger(input.count, 'count', CATALOG_PAGE_SIZE_MAX);
  const catId = optionalRuntimeString(input.catId, 'catId', 128);
  const keywords = optionalRuntimeString(input.keywords, 'keywords', 256);
  const sortType = optionalRuntimeString(input.sortType, 'sortType', 64);

  return {
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    v: '1.0',
    type: 'POST',
    dataType: 'json',
    data: {
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      params: JSON.stringify({
        memberId: input.memberId,
        appdata: {
          pageNum: input.pageNum,
          count: input.count,
          catId,
          keywords,
          sortType,
        },
      }),
    },
  };
}

export async function waitForStoreCatalogRuntime(
  page: Page,
  options: CatalogRuntimeDeadlineOptions,
): Promise<number> {
  const startedAt = Date.now();
  throwIfAborted(options.signal);
  try {
    await raceRuntimeOperation(
      page.waitForFunction(
        () => {
          const win = window as unknown as {
            lib?: { mtop?: { request?: unknown } };
          };
          return typeof win.lib?.mtop?.request === 'function';
        },
        undefined,
        { timeout: options.timeoutMs },
      ),
      options,
    );
  } catch (error) {
    if (isCollectionCancelled(error)) throw error;
    throw new CliError(
      9,
      'CATALOG_MTOP_RUNTIME_UNAVAILABLE',
      'The loaded 1688 shop page did not expose its MTOP runtime.',
      {
        category: 'catalog-runtime',
        failureKind: 'runtime-unavailable',
        recoveryAction: 'rebuild-page',
        retryable: true,
        fallbackAllowed: true,
        timeoutMs: options.timeoutMs,
      },
    );
  }
  return Math.max(0, Date.now() - startedAt);
}

/** Uses the loaded page runtime so the page owns Cookie, token, and signing. */
export async function requestStoreCatalogFromPage(
  page: Page,
  input: StoreCatalogRuntimeRequestInput,
  options: CatalogRuntimeDeadlineOptions,
): Promise<unknown> {
  let request: StoreCatalogRuntimeRequest;
  try {
    request = buildStoreCatalogRuntimeRequest(input);
  } catch (error) {
    throw new CliError(
      2,
      'CATALOG_REQUEST_INVALID',
      'The store catalog Runtime request contains invalid collection scope.',
      {
        category: 'collection-contract',
        failureKind: 'request-invalid',
        recoveryAction: 'fix-collection-unit',
        retryable: false,
        cause:
          error instanceof Error
            ? error.name
            : 'UnknownCatalogRequestValidationFailure',
      },
    );
  }
  throwIfAborted(options.signal);
  try {
    return await raceRuntimeOperation(
      page.evaluate(async (runtimeRequest) => {
        const win = window as unknown as {
          lib?: {
            mtop?: {
              request?: (value: typeof runtimeRequest) => Promise<unknown>;
            };
          };
        };
        const requestFn = win.lib?.mtop?.request;
        if (typeof requestFn !== 'function') {
          throw new Error('1688 page MTOP runtime is unavailable.');
        }
        return requestFn.call(win.lib?.mtop, runtimeRequest);
      }, request),
      options,
    );
  } catch (error) {
    if (isCollectionCancelled(error)) throw error;
    const retryable = isTransientRuntimeRequestFailure(error);
    throw new CliError(
      9,
      'CATALOG_REQUEST_REJECTED',
      'The 1688 page MTOP runtime rejected the catalog request.',
      {
        category: 'catalog-runtime',
        failureKind: retryable
          ? error instanceof CatalogRuntimeTimeoutError
            ? 'request-timeout'
            : 'runtime-context-lost'
          : 'request-rejected',
        recoveryAction: retryable ? 'retry-later' : 'inspect-runtime-rejection',
        retryable,
        timeoutMs: options.timeoutMs,
        cause:
          error instanceof Error
            ? error.name
            : 'UnknownRuntimeRequestFailure',
      },
    );
  }
}

function assertPositiveInteger(
  value: number,
  field: string,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(
      `Store catalog runtime ${field} must be an integer between 1 and ${maximum}.`,
    );
  }
}

function optionalRuntimeString(
  value: string | null | undefined,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `Store catalog runtime ${field} must be a non-empty string of at most ${maximumLength} characters without control characters.`,
    );
  }
  return value;
}

async function raceRuntimeOperation<T>(
  operation: Promise<T>,
  options: CatalogRuntimeDeadlineOptions,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CatalogRuntimeTimeoutError()),
          options.timeoutMs,
        );
        if (options.signal) {
          abortListener = () =>
            reject(
              new CliError(
                9,
                'COLLECTION_CANCELLED',
                'Catalog collection was cancelled.',
                {
                  category: 'collection',
                  failureKind: 'cancelled',
                  retryable: true,
                },
              ),
            );
          options.signal.addEventListener('abort', abortListener, {
            once: true,
          });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && abortListener) {
      options.signal.removeEventListener('abort', abortListener);
    }
  }
}

class CatalogRuntimeTimeoutError extends Error {
  override readonly name = 'CatalogRuntimeTimeoutError';

  constructor() {
    super('Catalog runtime operation timed out.');
  }
}

function isTransientRuntimeRequestFailure(error: unknown): boolean {
  if (error instanceof CatalogRuntimeTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return /(?:target|page|browser|context).*(?:closed|destroyed)|execution context was destroyed|navigation/i.test(
    `${error.name} ${error.message}`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new CliError(
    9,
    'COLLECTION_CANCELLED',
    'Catalog collection was cancelled.',
    {
      category: 'collection',
      failureKind: 'cancelled',
      retryable: true,
    },
  );
}

function isCollectionCancelled(error: unknown): boolean {
  return error instanceof CliError && error.code === 'COLLECTION_CANCELLED';
}
