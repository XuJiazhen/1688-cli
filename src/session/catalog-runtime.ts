import type { Page } from 'playwright';
import { CliError } from '../io/errors.js';
import {
  ALISITE_MODULE_API,
  STORE_CATALOG_COMPONENT_KEY,
} from './alisite-module.js';
import { isSafeSupplierMemberKey } from './qualification-capture.js';
import type { StoreCatalogParseResult } from './alisite-module.js';
import {
  STORE_PROFILE_COMPONENT_KEY,
  type StoreProfileSnapshot,
} from './store-profile.js';

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

export interface StoreSampleCursorV1 {
  memberId: string;
  canonicalShopUrl: string;
  sortType: 'wangpu_score';
  count: 30;
  generation: string;
  observedPages: number[];
  nextPage: number | null;
  sourceOfferCount: number | null;
  sourceTotalPages: number | null;
  categoriesObservedAt: string | null;
  baselineObservedAt: string;
  baselineExpiresAt: string;
  checkpointState: 'incomplete' | 'dormant' | 'approved-expansion-active' | 'exhausted';
  exhausted: boolean;
}

export interface StoreSampleRuntimeResultV1 {
  status: 'completed' | 'partial';
  mode: 'phase-1-bounded' | 'approved-expansion';
  pages: Array<{ page: number; parsed: StoreCatalogParseResult }>;
  uniqueOffers: StoreCatalogParseResult['offers'];
  categories: StoreCatalogParseResult['categories'];
  profileObservation: StoreSampleProfileObservationV1 | null;
  cursor: StoreSampleCursorV1;
  taskCandidateEligible: false;
  evidenceUsage: 'baseline-evidence' | 'cache-seed-only';
  remoteRequests: number;
  failedPages: number[];
  errorCode: string | null;
}

export interface StoreSampleProfileObservationV1 {
  memberId: string;
  memberIdSource: StoreProfileSnapshot['source'];
  canonicalShopUrl: string;
  observedAt: string;
  profile: StoreProfileSnapshot;
}

export async function collectBoundedStoreSampleV1(input: {
  memberId: string;
  canonicalShopUrl: string;
  mode: 'phase-1-bounded' | 'approved-expansion';
  firstPage: number;
  lastPageInclusive: number;
  generation: string;
  baselineExpiresAt: string;
  collectProfileObservation(): Promise<StoreSampleProfileObservationV1>;
  previousCursor?: StoreSampleCursorV1;
  now?: () => Date;
  collectPage(page: number): Promise<StoreCatalogParseResult>;
  afterPageCommitted?(page: number): Promise<void>;
}): Promise<StoreSampleRuntimeResultV1> {
  if (!isSafeSupplierMemberKey(input.memberId)) throw new TypeError('Store sample memberId is invalid.');
  const now = input.now ?? (() => new Date());
  const observedAt = now().toISOString();
  if (!Number.isFinite(Date.parse(input.baselineExpiresAt)) || Date.parse(input.baselineExpiresAt) <= Date.parse(observedAt)) {
    throw new CliError(2, 'STORE_SAMPLE_BASELINE_EXPIRY_INVALID', 'Store sample generation expiry must be in the future.');
  }
  if (input.mode === 'phase-1-bounded') {
    if (input.firstPage !== 1 || input.lastPageInclusive !== 3) {
      throw new CliError(2, 'STORE_SAMPLE_BASELINE_SCOPE_INVALID', 'Phase-1 Store Sample scope is exactly pages 1 through 3.', {
        category: 'contract',
        retryable: false,
        recoveryAction: 'repair-page-action-scope',
      });
    }
  } else {
    assertApprovedExpansionScope(input);
  }
  const profileObservation = await input.collectProfileObservation();
  assertStoreSampleProfileObservationV1(
    profileObservation,
    input.memberId,
    input.canonicalShopUrl,
  );

  const pages: StoreSampleRuntimeResultV1['pages'] = [];
  const uniqueOffers = new Map<string, StoreCatalogParseResult['offers'][number]>();
  let sourceOfferCount: number | null = input.mode === 'approved-expansion'
    ? input.previousCursor!.sourceOfferCount
    : null;
  let sourceTotalPages: number | null = input.mode === 'approved-expansion'
    ? input.previousCursor!.sourceTotalPages
    : null;
  let categories: StoreCatalogParseResult['categories'] = [];
  const failedPages: number[] = [];
  let errorCode: string | null = null;
  for (let page = input.firstPage; page <= input.lastPageInclusive; page++) {
    let parsed: StoreCatalogParseResult;
    try {
      parsed = await input.collectPage(page);
      if (parsed.kind !== 'offer-list' || parsed.page.pageNum !== page) {
        throw catalogProtocolError('STORE_SAMPLE_RESPONSE_PAGE_MISMATCH', `Store sample response does not match page ${page}.`);
      }
      if (parsed.page.memberId !== input.memberId) {
        throw catalogProtocolError('STORE_SAMPLE_MEMBER_SCOPE_MISMATCH', 'Store sample response belongs to another member.');
      }
      if (parsed.page.pageSize !== 30 || parsed.page.sortType !== 'wangpu_score') {
        throw catalogProtocolError('STORE_SAMPLE_REQUEST_PARITY_MISMATCH', 'Store sample count/sort differs from the frozen contract.');
      }
      if (page === input.firstPage) {
        if (input.mode === 'phase-1-bounded') {
          sourceOfferCount = parsed.offerCount;
          sourceTotalPages = parsed.totalPages;
          categories = parsed.categories;
          if (
            parsed.offerCount === null
            || parsed.totalPages === null
            || parsed.categories.length === 0
          ) {
            throw catalogProtocolError(
              'STORE_SAMPLE_PAGE1_SUMMARY_INCOMPLETE',
              'Page 1 must authoritatively expose offer totals, page totals, and categories.',
            );
          }
        } else {
          assertExpansionTotalsMatchBaseline(input.previousCursor!, parsed);
          sourceOfferCount ??= parsed.offerCount;
          sourceTotalPages ??= parsed.totalPages;
        }
      } else if (
        (parsed.offerCount !== null && sourceOfferCount !== null && parsed.offerCount !== sourceOfferCount) ||
        (parsed.totalPages !== null && sourceTotalPages !== null && parsed.totalPages !== sourceTotalPages)
      ) {
        throw catalogProtocolError('STORE_SAMPLE_TOTAL_DRIFT', 'Store sample total changed within one bounded action.');
      }
      for (const offer of parsed.offers) {
        if (offer.memberId !== input.memberId) {
          throw catalogProtocolError('STORE_SAMPLE_OFFER_MEMBER_MISMATCH', `Catalog offer ${offer.offerId} belongs to another member.`);
        }
        if (!uniqueOffers.has(offer.offerId)) uniqueOffers.set(offer.offerId, offer);
      }
      pages.push({ page, parsed });
    } catch (error) {
      if (pages.length === 0) throw error;
      failedPages.push(page);
      errorCode = storeSampleFailureCode(error);
      break;
    }
    if (parsed.totalPages !== null && page >= parsed.totalPages) break;
    if (input.afterPageCommitted !== undefined) {
      try {
        await input.afterPageCommitted(page);
      } catch (error) {
        errorCode = storeSampleFailureCode(error);
        break;
      }
    }
  }

  const lastObserved = pages.at(-1)?.page ?? input.firstPage - 1;
  const exhausted = sourceTotalPages !== null && lastObserved >= sourceTotalPages;
  const nextPage = exhausted ? null : lastObserved + 1;
  const result: StoreSampleRuntimeResultV1 = {
    status: errorCode === null ? 'completed' : 'partial',
    mode: input.mode,
    pages,
    uniqueOffers: [...uniqueOffers.values()],
    categories,
    profileObservation: structuredClone(profileObservation),
    cursor: {
      memberId: input.memberId,
      canonicalShopUrl: canonicalShopUrl(input.canonicalShopUrl),
      sortType: 'wangpu_score' as const,
      count: 30 as const,
      generation: input.generation,
      observedPages: input.mode === 'phase-1-bounded'
        ? pages.map((entry) => entry.page)
        : [...input.previousCursor!.observedPages, ...pages.map((entry) => entry.page)],
      nextPage,
      sourceOfferCount,
      sourceTotalPages,
      categoriesObservedAt:
        input.mode === 'phase-1-bounded' ? observedAt : input.previousCursor?.categoriesObservedAt ?? null,
      baselineObservedAt:
        input.mode === 'phase-1-bounded' ? observedAt : input.previousCursor!.baselineObservedAt,
      baselineExpiresAt: input.baselineExpiresAt,
      checkpointState: errorCode !== null
        ? 'incomplete'
        : exhausted
        ? 'exhausted'
        : input.mode === 'phase-1-bounded'
          ? 'dormant'
          : 'approved-expansion-active',
      exhausted,
    },
    taskCandidateEligible: false,
    evidenceUsage: input.mode === 'phase-1-bounded' ? 'baseline-evidence' : 'cache-seed-only',
    remoteRequests: pages.length + failedPages.length,
    failedPages,
    errorCode,
  };
  return Object.freeze(result);
}

export function assertStoreSampleProfileObservationV1(
  observation: StoreSampleProfileObservationV1,
  expectedMemberId: string,
  expectedCanonicalShopUrl: string,
): void {
  const profile = observation?.profile;
  const memberIdSource = observation?.memberIdSource;
  let observedCanonicalShopUrl: string;
  let expectedShopUrl: string;
  let payloadShopUrl: string;
  try {
    observedCanonicalShopUrl = canonicalProfileShopUrl(
      observation?.canonicalShopUrl,
    );
    expectedShopUrl = canonicalProfileShopUrl(expectedCanonicalShopUrl);
    payloadShopUrl = canonicalProfileShopUrl(profile?.shopUrl.value);
  } catch {
    throw catalogProtocolError(
      'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
      'Store Sample requires an unambiguous same-member Wangpu header URL.',
    );
  }
  if (
    observation?.memberId !== expectedMemberId
    || memberIdSource === undefined
    || profile === undefined
    || memberIdSource.api !== profile.source.api
    || memberIdSource.componentKey !== profile.source.componentKey
    || memberIdSource.parserVersion !== profile.source.parserVersion
    || memberIdSource.rawRef !== profile.source.rawRef
    || memberIdSource.sourceRef !== profile.source.sourceRef
    || memberIdSource.fieldPath !== 'data.data.memberId'
    || observedCanonicalShopUrl !== expectedShopUrl
    || payloadShopUrl !== expectedShopUrl
    || profile?.source.api !== ALISITE_MODULE_API
    || profile.source.componentKey !== STORE_PROFILE_COMPONENT_KEY
    || !profile.source.rawRef?.startsWith('artifact:')
    || profile.name.availability !== 'available'
    || typeof profile.name.value !== 'string'
    || profile.name.value.trim().length === 0
    || profile.name.source.api !== profile.source.api
    || profile.name.source.componentKey !== profile.source.componentKey
    || profile.name.source.parserVersion !== profile.source.parserVersion
    || profile.name.source.rawRef !== profile.source.rawRef
    || profile.name.source.fieldPath !== 'data.data.companyName'
    || profile.shopUrl.availability !== 'available'
    || typeof profile.shopUrl.value !== 'string'
    || profile.shopUrl.source.api !== profile.source.api
    || profile.shopUrl.source.componentKey !== profile.source.componentKey
    || profile.shopUrl.source.parserVersion !== profile.source.parserVersion
    || profile.shopUrl.source.rawRef !== profile.source.rawRef
    || profile.shopUrl.source.fieldPath !== 'data.data.commonUrl.shopUrl'
  ) {
    throw catalogProtocolError(
      'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
      'Store Sample requires an archived same-member Wangpu header with name and shop URL.',
    );
  }
}

export function parseStoreProfileMemberAuthorityV1(
  payload: unknown,
  source: StoreProfileSnapshot['source'],
): Pick<StoreSampleProfileObservationV1, 'memberId' | 'memberIdSource'> {
  const root = recordValue(payload);
  const envelope = recordValue(root?.['data']);
  const header = recordValue(envelope?.['data']);
  const memberId = header?.['memberId'];
  if (typeof memberId !== 'string' || !isSafeSupplierMemberKey(memberId)) {
    throw catalogProtocolError(
      'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
      'Store Sample requires member authority parsed from data.data.memberId.',
    );
  }
  return {
    memberId,
    memberIdSource: {
      ...source,
      fieldPath: 'data.data.memberId',
    },
  };
}

function canonicalProfileShopUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Store profile shop URL is missing.');
  }
  // Validate the raw form before WHATWG erases default ports or normalizes paths and IDNs.
  const authorityMatch = /^https:\/\/([^/?#]+)\/$/.exec(value);
  if (authorityMatch === null || authorityMatch[0] !== value) {
    throw new TypeError('Store profile shop URL is not canonical.');
  }
  const rawAuthority = authorityMatch[1]!;
  const hostname = rawAuthority.toLowerCase();
  if (
    rawAuthority.includes('@')
    || rawAuthority.includes(':')
    || !isCanonical1688ShopHostname(rawAuthority)
  ) {
    throw new TypeError('Store profile shop URL is not canonical.');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/'
    || url.hostname !== hostname
    || url.host !== hostname
  ) {
    throw new TypeError('Store profile shop URL is not canonical.');
  }
  return `https://${hostname}/`;
}

function isCanonical1688ShopHostname(hostname: string): boolean {
  if (hostname.length > 253 || !/^[\x00-\x7f]+$/.test(hostname)) return false;
  const labels = hostname.split('.');
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  return labels.length >= 3
    && normalizedLabels.at(-2) === '1688'
    && normalizedLabels.at(-1) === 'com'
    && labels.every(isDnsHostnameLabel);
}

function isDnsHostnameLabel(label: string): boolean {
  return label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storeSampleFailureCode(error: unknown): string {
  if (
    error !== null
    && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'STORE_SAMPLE_PAGE_FAILED';
}

export function materializeFreshStoreSampleCacheV1(input: {
  cursor: StoreSampleCursorV1;
  parserRevisionMatches: boolean;
  now: string;
  originBatchRefs: string[];
  contentHash: string;
}): {
  hit: true;
  remoteRequests: 0;
  originBatchRefs: string[];
  observedAt: string;
  contentHash: string;
  cursor: StoreSampleCursorV1;
} | { hit: false; remoteRequests: 0; reason: 'expired' | 'parser-revision-changed' } {
  const now = Date.parse(input.now);
  if (!input.parserRevisionMatches) return { hit: false, remoteRequests: 0, reason: 'parser-revision-changed' };
  if (!Number.isFinite(now) || now >= Date.parse(input.cursor.baselineExpiresAt)) {
    return { hit: false, remoteRequests: 0, reason: 'expired' };
  }
  return {
    hit: true,
    remoteRequests: 0,
    originBatchRefs: [...new Set(input.originBatchRefs)].sort(),
    observedAt: input.cursor.baselineObservedAt,
    contentHash: input.contentHash,
    cursor: structuredClone(input.cursor),
  };
}

function assertApprovedExpansionScope(input: {
  memberId: string;
  canonicalShopUrl: string;
  firstPage: number;
  lastPageInclusive: number;
  previousCursor?: StoreSampleCursorV1;
  generation: string;
  baselineExpiresAt: string;
}): void {
  const pageCount = input.lastPageInclusive - input.firstPage + 1;
  if (!Number.isInteger(pageCount) || pageCount < 3 || pageCount > 10) {
    throw new CliError(2, 'STORE_SAMPLE_EXPANSION_SCOPE_INVALID', 'Approved expansion page count must be an integer from 3 through 10.');
  }
  const cursor = input.previousCursor;
  if (
    !cursor ||
    cursor.checkpointState !== 'dormant' ||
    cursor.nextPage !== input.firstPage ||
    cursor.generation !== input.generation ||
    cursor.memberId !== input.memberId ||
    cursor.canonicalShopUrl !== canonicalShopUrl(input.canonicalShopUrl) ||
    cursor.sortType !== 'wangpu_score' ||
    cursor.count !== 30 ||
    cursor.baselineExpiresAt !== input.baselineExpiresAt ||
    JSON.stringify(cursor.observedPages) !== JSON.stringify(
      Array.from({ length: input.firstPage - 1 }, (_, index) => index + 1),
    ) ||
    cursor.exhausted
  ) {
    throw new CliError(2, 'STORE_SAMPLE_EXPANSION_CURSOR_INVALID', 'Approved expansion must start at a fresh dormant checkpoint.');
  }
}

function assertExpansionTotalsMatchBaseline(
  cursor: StoreSampleCursorV1,
  parsed: StoreCatalogParseResult,
): void {
  if (
    (cursor.sourceOfferCount !== null && parsed.offerCount !== null && cursor.sourceOfferCount !== parsed.offerCount) ||
    (cursor.sourceTotalPages !== null && parsed.totalPages !== null && cursor.sourceTotalPages !== parsed.totalPages)
  ) {
    throw catalogProtocolError(
      'STORE_SAMPLE_BASELINE_TOTAL_DRIFT',
      'Approved expansion no longer matches its fresh baseline totals.',
    );
  }
}

function canonicalShopUrl(value: string): string {
  return canonicalProfileShopUrl(value);
}

function catalogProtocolError(code: string, message: string): CliError {
  return new CliError(9, code, message, {
    category: 'protocol',
    retryable: false,
    recoveryAction: 'retry-store-sample-generation',
  });
}

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
