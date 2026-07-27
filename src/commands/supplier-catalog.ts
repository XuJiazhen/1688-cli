import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import {
  executeCatalogBatch,
  type CatalogPageAdapter,
  type CatalogPageDiagnostics,
  type CatalogPageRequest,
} from '../collection/catalog-batch.js';
import { normalizeCollectionUnit, type CollectionBatch, type CollectionCheckpoint, type CollectionUnit } from '../collection/contracts.js';
import { CliError } from '../io/errors.js';
import { emit } from '../io/output.js';
import {
  ALISITE_MODULE_API,
  AlisiteSchemaError,
  STORE_CATALOG_COMPONENT_KEY,
  STORE_CATEGORIES_COMPONENT_KEY,
  STORE_CATALOG_PARSER_VERSION,
  parseStoreCatalogModule,
  readAlisiteModuleRequestMeta,
  startAlisiteModuleCapture,
  type AlisiteModuleCaptureTarget,
  type AlisiteModuleCaptureDiagnostics,
  type CapturedAlisiteModule,
  type StoreCatalogCategory,
  type StoreCatalogParseResult,
} from '../session/alisite-module.js';
import {
  requestStoreCatalogFromPage,
  waitForStoreCatalogRuntime,
} from '../session/catalog-runtime.js';
import { dispatch } from '../session/dispatch.js';
import { detectPageState } from '../session/page-state.js';
import { sanitizeEvidenceRef } from '../session/redaction.js';
import { waitForCollectionPageAvailability } from '../session/recovery.js';
import { waitWithDeadline } from '../session/wait.js';
import { execute as inspectSupplier } from './supplier-inspect.js';

const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_SORT = 'wangpu_score';
const CATALOG_RUNTIME_READY_TIMEOUT_MS = 15_000;
const CATALOG_RUNTIME_REQUEST_TIMEOUT_MS = 15_000;
const CATALOG_RESPONSE_TIMEOUT_MS = 20_000;

export type CatalogTransportMode = 'runtime' | 'dom' | 'auto';

export interface CatalogAdapterDeadlineOptions {
  runtimeReadyMs?: number;
  runtimeRequestMs?: number;
  responseMs?: number;
}

export interface CatalogTarget {
  input: string;
  type: 'offerId' | 'memberId' | 'shopUrl';
  offerId: string | null;
  memberId: string | null;
  shopUrl: string | null;
}

export interface SupplierCatalogOpts {
  target: string;
  categories?: boolean;
  categoryId?: string;
  keyword?: string;
  sort?: string;
  pageSize?: string;
  maxPages?: string;
  maxItems?: string;
  full?: boolean;
  catalogTransport?: string;
  profile?: string;
  headed?: boolean;
}

export interface SupplierCatalogArgs {
  unit: CollectionUnit;
  checkpoint?: CollectionCheckpoint;
  headed?: boolean;
  catalogTransport?: CatalogTransportMode;
}

export interface ResolvedCatalogSupplier {
  memberId?: string;
  shopUrl: string;
  sourceOfferId?: string;
}

export function normalizeCatalogTarget(raw: string): CatalogTarget {
  const input = (raw ?? '').trim();
  if (!input) throw new CliError(2, 'BAD_INPUT', 'Supplier catalog target is required.');

  const urlTarget = catalogTargetFromUrl(input);
  if (urlTarget) return urlTarget;
  if (/^\d+$/.test(input)) {
    return { input, type: 'offerId', offerId: input, memberId: null, shopUrl: null };
  }
  if (/^b2b-[A-Za-z0-9_-]+$/.test(input)) {
    return { input, type: 'memberId', offerId: null, memberId: input, shopUrl: null };
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    'Unsupported supplier catalog target. Use an offerId, b2b-* memberId, or 1688 shop URL; loginId is not a stable identity.',
  );
}

export function buildStoreCatalogUrl(
  shopUrl: string,
  scope: { categoryId?: string; storeKeyword?: string; sort?: string },
): string {
  const origin = canonicalShopUrl(shopUrl);
  const url = new URL('/page/offerlist.html', origin);
  if (scope.categoryId) url.searchParams.set('categoryId', scope.categoryId);
  if (scope.storeKeyword) url.searchParams.set('keywords', scope.storeKeyword);
  if (scope.sort) url.searchParams.set('sortType', scope.sort);
  if (url.search) url.searchParams.set('charset', 'utf8');
  return url.toString();
}

export async function run(opts: SupplierCatalogOpts): Promise<void> {
  const target = normalizeCatalogTarget(opts.target);
  const kind = opts.categories ? 'store-categories' : 'store-catalog';
  const maxPages = positiveInt(opts.maxPages, '--max-pages', 1, 100);
  const pageSize = positiveInt(opts.pageSize, '--page-size', DEFAULT_PAGE_SIZE, 100);
  const maxItems = optionalPositiveInt(opts.maxItems, '--max-items');
  const catalogTransport = normalizeCatalogTransport(opts.catalogTransport);
  const unit = normalizeCollectionUnit({
    schemaVersion: 1,
    unitId: `supplier-catalog-${Date.now()}`,
    kind,
    subject: {
      supplier:
        target.type === 'offerId'
          ? { sourceOfferId: target.offerId }
          : target.type === 'memberId'
            ? { memberId: target.memberId }
            : { shopUrl: target.shopUrl },
    },
    scope: {
      requestedScope: opts.categories
        ? 'page'
        : opts.full
          ? 'full-scan'
          : maxPages === 1
            ? 'page'
            : 'bounded-pages',
      pageSize,
      maxPagesPerBatch: opts.categories ? 1 : maxPages,
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      ...(opts.keyword ? { storeKeyword: opts.keyword } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
    },
    ...(maxItems ? { limits: { maxItems } } : {}),
  });
  const data = await dispatch<SupplierCatalogArgs, CollectionBatch>(
    'supplier-catalog',
    { unit, headed: opts.headed, catalogTransport },
    { profile: opts.profile, headed: opts.headed, noDaemon: true },
  );
  emit({
    data,
    human: () => {
      process.stdout.write(
        `${data.kind}: ${data.observations.length} observations (${data.status})\n`,
      );
      if (data.checkpoint) {
        process.stdout.write(`Next page: ${data.checkpoint.nextPage ?? 'unknown'}\n`);
      }
    },
  });
}

export async function execute(
  ctx: BrowserContext,
  args: SupplierCatalogArgs,
): Promise<CollectionBatch> {
  const unit = normalizeCollectionUnit(args.unit);
  if (unit.kind !== 'store-catalog' && unit.kind !== 'store-categories') {
    throw new CliError(2, 'BAD_INPUT', 'supplier catalog requires a store-catalog or store-categories unit.');
  }
  const resolved = await resolveCatalogSupplier(ctx, unit, args.headed === true);
  const page = await ctx.newPage();
  const adapter = createPlaywrightCatalogAdapter(
    page,
    resolved,
    args.headed === true,
    args.catalogTransport ?? 'auto',
  );
  try {
    return await executeCatalogBatch({ unit, checkpoint: args.checkpoint, adapter });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function resolveCatalogSupplier(
  ctx: BrowserContext,
  unit: CollectionUnit,
  headed: boolean,
): Promise<ResolvedCatalogSupplier> {
  const supplier = unit.subject.supplier;
  if (!supplier) throw new CliError(2, 'BAD_INPUT', 'A supplier reference is required.');
  if (supplier.shopUrl) {
    return {
      shopUrl: canonicalShopUrl(supplier.shopUrl),
      ...(supplier.memberId ? { memberId: supplier.memberId } : {}),
      ...(supplier.sourceOfferId ? { sourceOfferId: supplier.sourceOfferId } : {}),
    };
  }
  const target = supplierInspectionTarget(supplier);
  if (!target) throw new CliError(2, 'BAD_INPUT', 'Supplier reference is incomplete.');
  const inspected = await inspectSupplier(ctx, { target, headed });
  const shopUrl = inspected.supplier.shopUrl;
  if (!shopUrl) {
    throw new CliError(
      9,
      'SUPPLIER_SHOP_URL_MISSING',
      'Supplier inspection did not expose a canonical shop URL.',
    );
  }
  return {
    shopUrl: canonicalShopUrl(shopUrl),
    ...(inspected.supplier.memberId ? { memberId: inspected.supplier.memberId } : {}),
    ...(supplier.sourceOfferId ? { sourceOfferId: supplier.sourceOfferId } : {}),
  };
}

export function supplierInspectionTarget(
  supplier: NonNullable<CollectionUnit['subject']['supplier']>,
): string | null {
  const memberId = supplier.memberId?.trim();
  if (memberId && /^b2b-[A-Za-z0-9_-]+$/.test(memberId)) {
    return memberId;
  }
  return supplier.sourceOfferId?.trim() || memberId || null;
}

export function createPlaywrightCatalogAdapter(
  page: Page,
  supplier: ResolvedCatalogSupplier,
  headed = false,
  transportMode: CatalogTransportMode = 'auto',
  deadlineOptions: CatalogAdapterDeadlineOptions = {},
): CatalogPageAdapter {
  const captures = new Map<number, CapturedAlisiteModule>();
  const diagnostics = new Map<number, CatalogPageDiagnostics>();
  const evidence = new Set<string>();
  let currentCatalogPage: number | null = null;
  let runtimeInitialized = false;

  const saveCapture = (
    pageNumber: number,
    captured: CapturedAlisiteModule,
  ): StoreCatalogParseResult => {
    const sourceRef = sanitizeEvidenceRef(captured.sourceRef);
    captures.set(pageNumber, { ...captured, sourceRef });
    evidence.add(sourceRef);
    return captured.parsed;
  };

  const collectRuntimePage = async (
    request: CatalogPageRequest,
    allowManualRiskChallenge = true,
  ): Promise<StoreCatalogParseResult> => {
    const memberId = supplier.memberId;
    if (!memberId) {
      throw new CliError(
        9,
        'CATALOG_MTOP_RUNTIME_UNAVAILABLE',
        'Catalog runtime collection requires a resolved supplier memberId.',
        {
          category: 'catalog-runtime',
          failureKind: 'member-scope-unavailable',
          recoveryAction: 'use-dom-fallback',
          retryable: false,
          fallbackAllowed: true,
        },
      );
    }

    let runtimeReadyMs = 0;
    if (!runtimeInitialized) {
      await gotoStore(page, supplier.shopUrl);
      await waitForCollectionPageAvailability(page, {
        headed,
        signal: request.signal,
      });
      runtimeReadyMs = await waitForStoreCatalogRuntime(page, {
        timeoutMs:
          deadlineOptions.runtimeReadyMs ??
          CATALOG_RUNTIME_READY_TIMEOUT_MS,
        signal: request.signal,
      });
      runtimeInitialized = true;
    }

    const scopedRequest = { ...request, memberId };
    const expected = captureTarget(scopedRequest, {
      ...supplier,
      memberId,
    });
    const diagnosticTarget: AlisiteModuleCaptureTarget = {
      id: `store-catalog-scope-diagnostic-${request.page}`,
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      required: false,
    };
    const capture = startAlisiteModuleCapture({
      page,
      targets: [expected, diagnosticTarget],
      ...(headed && allowManualRiskChallenge
        ? {
            onRiskChallenge: async (challengeUrl: string) => {
              try {
                await page.goto(challengeUrl, {
                  waitUntil: 'domcontentloaded',
                  timeout: 30_000,
                });
                const availability = await waitForCollectionPageAvailability(
                  page,
                  {
                    headed: true,
                    signal: request.signal,
                  },
                );
                return availability.recoveredRiskChallenge;
              } catch {
                return false;
              }
            },
          }
        : {}),
    });
    const responseStartedAt = Date.now();
    let runtimeResultStatus: CatalogPageDiagnostics['runtimeResultStatus'] =
      'pending';
    let runtimeSettled = false;
    try {
      const captureResult = capture.wait(
        catalogCaptureWaitOptions(
          page,
          request,
          headed,
          deadlineOptions.responseMs,
        ),
      );
      const runtimeRequest = requestStoreCatalogFromPage(
        page,
        {
          memberId,
          pageNum: request.page,
          count: request.pageSize ?? DEFAULT_PAGE_SIZE,
          catId: request.categoryId,
          keywords: request.storeKeyword,
          sortType: request.sort ?? DEFAULT_SORT,
        },
        {
          timeoutMs:
            deadlineOptions.runtimeRequestMs ??
            CATALOG_RUNTIME_REQUEST_TIMEOUT_MS,
          signal: request.signal,
        },
      );
      const runtimeOutcome = runtimeRequest.then(
        (value) => {
          runtimeSettled = true;
          return { kind: 'fulfilled' as const, value };
        },
        (error: unknown) => {
          runtimeSettled = true;
          return { kind: 'rejected' as const, error };
        },
      );
      const first = await Promise.race([
        captureResult.then((result) => ({
          kind: 'capture' as const,
          result,
        })),
        runtimeOutcome,
      ]);
      if (first.kind === 'fulfilled') {
        const parseStartedAt = Date.now();
        try {
          const parsed = parseStoreCatalogModule(first.value, {
            memberId,
            pageNum: request.page,
            pageSize: request.pageSize ?? DEFAULT_PAGE_SIZE,
            categoryId: request.categoryId,
            keyword: request.storeKeyword,
            sortType: request.sort ?? DEFAULT_SORT,
          });
          runtimeResultStatus = 'parsed';
          const parseMs = Math.max(0, Date.now() - parseStartedAt);
          diagnostics.set(request.page, {
            transport: 'runtime',
            targetPage: request.page,
            catalogRequestCount: 1,
            runtimeReadyMs,
            responseWaitMs: Math.max(0, Date.now() - responseStartedAt),
            parseMs,
            parserVersion: STORE_CATALOG_PARSER_VERSION,
            memberScopeHash: hashMemberScope(memberId),
            runtimeResultStatus,
          });
          return saveCapture(request.page, {
            targetId: expected.id,
            request: {
              api: ALISITE_MODULE_API,
              componentKey: STORE_CATALOG_COMPONENT_KEY,
              memberId,
              pageNum: request.page,
              count: request.pageSize ?? DEFAULT_PAGE_SIZE,
              ...(request.categoryId === undefined
                ? {}
                : { catId: request.categoryId }),
              ...(request.storeKeyword === undefined
                ? {}
                : { keywords: request.storeKeyword }),
              sortType: request.sort ?? DEFAULT_SORT,
            },
            parsed,
            sourceRef: `runtime:store-catalog:${hashMemberScope(memberId)}:page:${request.page}`,
            collectedAt: new Date().toISOString(),
          });
        } catch (error) {
          if (!(error instanceof AlisiteSchemaError)) throw error;
          runtimeResultStatus = 'unrecognized';
        }
      } else if (first.kind === 'rejected') {
        runtimeResultStatus = 'rejected';
        const mayStillProduceResponse =
          first.error instanceof CliError &&
          first.error.details.retryable === true;
        if (
          capture.diagnostics().matchedCount === 0 &&
          !mayStillProduceResponse
        ) {
          throw first.error;
        }
      }
      const result =
        first.kind === 'capture' ? first.result : await captureResult;
      if (result.status === 'risk_control_recovered') {
        throw new CatalogManualRiskChallengeRecoveredError();
      }
      if (first.kind === 'capture' && !runtimeSettled) {
        // A navigation at the next page tears down a Runtime evaluate that did
        // not settle after its correlated network response.
        runtimeInitialized = false;
        currentCatalogPage = null;
      }
      diagnostics.set(request.page, {
        transport: 'runtime',
        targetPage: request.page,
        catalogRequestCount: 1,
        runtimeReadyMs,
        responseWaitMs: Math.max(0, Date.now() - responseStartedAt),
        parseMs: result.diagnostics.parseMs,
        parserVersion: STORE_CATALOG_PARSER_VERSION,
        memberScopeHash: hashMemberScope(memberId),
        runtimeResultStatus,
      });
      const captured = result.captures.find(
        (entry) => entry.targetId === expected.id,
      );
      if (result.status !== 'captured' || !captured) {
        throw captureStatusError(
          result.status,
          request.page,
          result.diagnostics,
          expected.id,
          result.captures,
          diagnosticTarget.id,
        );
      }
      return saveCapture(request.page, captured);
    } catch (error) {
      if (!diagnostics.has(request.page)) {
        const captureDiagnostics = capture.diagnostics();
        diagnostics.set(request.page, {
          transport: 'runtime',
          targetPage: request.page,
          catalogRequestCount: 1,
          runtimeReadyMs,
          responseWaitMs: Math.max(0, Date.now() - responseStartedAt),
          parseMs: captureDiagnostics.parseMs,
          parserVersion: STORE_CATALOG_PARSER_VERSION,
          memberScopeHash: hashMemberScope(memberId),
          runtimeResultStatus,
        });
      }
      throw error;
    } finally {
      capture.dispose();
    }
  };

  const collectDomPage = async (
    request: CatalogPageRequest,
    fallbackReason?: string,
  ): Promise<StoreCatalogParseResult> => {
    const expected = captureTarget(request, supplier);
    const capture = startAlisiteModuleCapture({
      page,
      targets: [expected, ...bootstrapTargets(request, supplier)],
    });
    const responseStartedAt = Date.now();
    try {
      const result = await capture.waitForAction(
        async () => {
          if (request.kind === 'store-categories') {
            await gotoStore(page, supplier.shopUrl);
            return;
          }
          const actions = planCatalogNavigation(
            request.page,
            currentCatalogPage !== null,
          );
          for (const action of actions) {
            if (action === 'goto') {
              await gotoStore(
                page,
                buildStoreCatalogUrl(supplier.shopUrl, {
                  categoryId: request.categoryId,
                  storeKeyword: request.storeKeyword,
                  sort: request.sort,
                }),
              );
              await applyCatalogScope(page, request, capture);
              currentCatalogPage = 1;
              continue;
            }
            const targetPage = Number(action.slice('next:'.length));
            if (targetPage < request.page) {
              await clickAndWaitForCatalogPage(page, targetPage);
            } else {
              await clickCatalogNextPage(page);
            }
            currentCatalogPage = targetPage;
          }
        },
        catalogCaptureWaitOptions(
          page,
          request,
          headed,
          deadlineOptions.responseMs,
        ),
      );
      diagnostics.set(request.page, {
        transport: 'dom',
        targetPage: request.page,
        catalogRequestCount: result.diagnostics.matchedCount,
        runtimeReadyMs: 0,
        responseWaitMs: Math.max(0, Date.now() - responseStartedAt),
        parseMs: result.diagnostics.parseMs,
        parserVersion: STORE_CATALOG_PARSER_VERSION,
        ...(supplier.memberId
          ? { memberScopeHash: hashMemberScope(supplier.memberId) }
          : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
      });
      const captured = result.captures.find(
        (entry) => entry.targetId === expected.id,
      );
      if (result.status !== 'captured' || !captured) {
        throw captureStatusError(
          result.status,
          request.page,
          result.diagnostics,
          expected.id,
          result.captures,
        );
      }
      const parsed = saveCapture(request.page, captured);
      return fallbackReason
        ? withCatalogFallbackWarning(parsed, fallbackReason)
        : parsed;
    } catch (error) {
      if (!diagnostics.has(request.page)) {
        const captureDiagnostics = capture.diagnostics();
        diagnostics.set(request.page, {
          transport: 'dom',
          targetPage: request.page,
          catalogRequestCount: captureDiagnostics.matchedCount,
          runtimeReadyMs: 0,
          responseWaitMs: Math.max(0, Date.now() - responseStartedAt),
          parseMs: captureDiagnostics.parseMs,
          parserVersion: STORE_CATALOG_PARSER_VERSION,
          ...(supplier.memberId
            ? { memberScopeHash: hashMemberScope(supplier.memberId) }
            : {}),
          ...(fallbackReason ? { fallbackReason } : {}),
        });
      }
      throw error;
    }
  };

  const collectRuntimeWithPageRebuild = async (
    request: CatalogPageRequest,
  ): Promise<StoreCatalogParseResult> => {
    try {
      return await collectRuntimePage(request);
    } catch (error) {
      if (error instanceof CatalogManualRiskChallengeRecoveredError) {
        runtimeInitialized = false;
        currentCatalogPage = null;
        diagnostics.delete(request.page);
        return collectRuntimePage(request, false);
      }
      if (
        !(error instanceof CliError) ||
        error.code !== 'CATALOG_MTOP_RUNTIME_UNAVAILABLE' ||
        error.details.failureKind !== 'runtime-unavailable'
      ) {
        throw error;
      }
      runtimeInitialized = false;
      currentCatalogPage = null;
      diagnostics.delete(request.page);
      try {
        return await collectRuntimePage(request);
      } catch (retryError) {
        if (!diagnostics.has(request.page)) {
          diagnostics.set(request.page, {
            transport: 'runtime',
            targetPage: request.page,
            catalogRequestCount: 0,
            runtimeReadyMs: 0,
            responseWaitMs: 0,
            parseMs: 0,
            parserVersion: STORE_CATALOG_PARSER_VERSION,
            ...(supplier.memberId
              ? { memberScopeHash: hashMemberScope(supplier.memberId) }
              : {}),
          });
        }
        throw retryError;
      }
    }
  };

  return {
    async collectPage(request) {
      if (request.kind === 'store-categories' || transportMode === 'dom') {
        return collectDomPage(request);
      }
      try {
        return await collectRuntimeWithPageRebuild(request);
      } catch (error) {
        if (
          transportMode !== 'auto' ||
          !(error instanceof CliError) ||
          error.details.fallbackAllowed !== true
        ) {
          throw error;
        }
        return collectDomPage(request, error.code);
      }
    },
    sourceRefForPage(pageNumber) {
      return captures.get(pageNumber)?.sourceRef;
    },
    diagnosticsForPage(pageNumber) {
      return diagnostics.get(pageNumber);
    },
    evidenceRefs() {
      return [...evidence];
    },
  };
}

class CatalogManualRiskChallengeRecoveredError extends Error {
  constructor() {
    super('Catalog manual risk challenge recovered.');
    this.name = 'CatalogManualRiskChallengeRecoveredError';
  }
}

export function catalogSortInteraction(sort: string | undefined): {
  label: '销量' | '价格' | null;
  clicks: number;
} {
  switch (sort ?? DEFAULT_SORT) {
    case DEFAULT_SORT:
      return { label: null, clicks: 0 };
    case 'tradenumdown':
      return { label: '销量', clicks: 1 };
    case 'pricedown':
      return { label: '价格', clicks: 1 };
    case 'priceup':
      return { label: '价格', clicks: 2 };
    default:
      throw new CliError(
        2,
        'BAD_INPUT',
        `Unsupported store sortType: ${sort}. Use wangpu_score, tradenumdown, pricedown, or priceup.`,
      );
  }
}

export function findCatalogCategoryName(
  categories: StoreCatalogCategory[],
  categoryId: string,
): string | null {
  for (const category of categories) {
    if (category.id === categoryId) {
      return category.name ?? category.fullName;
    }
    const nested = findCatalogCategoryName(category.children, categoryId);
    if (nested) return nested;
  }
  return null;
}

export function planCatalogNavigation(
  requestedPage: number,
  hasCurrentPage: boolean,
): string[] {
  if (!Number.isInteger(requestedPage) || requestedPage < 1) {
    throw new CliError(2, 'BAD_INPUT', 'Catalog page must be a positive integer.');
  }
  if (hasCurrentPage) return [`next:${requestedPage}`];
  return [
    'goto',
    ...Array.from(
      { length: requestedPage - 1 },
      (_, index) => `next:${index + 2}`,
    ),
  ];
}

function catalogCaptureWaitOptions(
  page: Page,
  request: CatalogPageRequest,
  headed: boolean,
  timeoutMs = CATALOG_RESPONSE_TIMEOUT_MS,
) {
  return {
    timeoutMs,
    signal: request.signal,
    isClosed: () => page.isClosed(),
    isNotLoggedIn: async () =>
      (await detectPageState(page)).kind === 'not_logged_in',
    isRateLimited: async () =>
      (await detectPageState(page)).kind === 'rate_limited',
    isBlocked: async () => {
      const state = await detectPageState(page);
      if (state.kind === 'risk_challenge' && headed) {
        await waitForCollectionPageAvailability(page, {
          headed: true,
          signal: request.signal,
        });
        return false;
      }
      return state.kind === 'risk_challenge';
    },
  };
}

function withCatalogFallbackWarning(
  parsed: StoreCatalogParseResult,
  fallbackReason: string,
): StoreCatalogParseResult {
  return {
    ...parsed,
    warnings: [
      ...parsed.warnings,
      {
        code: 'CATALOG_DOM_FALLBACK',
        fieldPath: '$transport',
        message: `Catalog collection used the DOM fallback after ${fallbackReason}.`,
      },
    ],
  };
}

function hashMemberScope(memberId: string): string {
  return `sha256:${createHash('sha256').update(memberId).digest('hex')}`;
}

function captureTarget(
  request: CatalogPageRequest,
  supplier: ResolvedCatalogSupplier,
): AlisiteModuleCaptureTarget {
  if (request.kind === 'store-categories') {
    return {
      id: 'store-categories',
      componentKey: STORE_CATEGORIES_COMPONENT_KEY,
      request: supplier.memberId ? { memberId: supplier.memberId } : {},
    };
  }
  return {
    id: `store-catalog-page-${request.page}`,
    componentKey: STORE_CATALOG_COMPONENT_KEY,
    request: {
      ...(supplier.memberId ? { memberId: supplier.memberId } : {}),
      pageNum: request.page,
      count: request.pageSize ?? DEFAULT_PAGE_SIZE,
      catId: request.categoryId ?? null,
      keywords: request.storeKeyword ?? null,
      sortType: request.sort ?? DEFAULT_SORT,
    },
  };
}

function bootstrapTargets(
  request: CatalogPageRequest,
  supplier: ResolvedCatalogSupplier,
): AlisiteModuleCaptureTarget[] {
  if (request.kind !== 'store-catalog' || !request.categoryId) return [];
  const memberScope = supplier.memberId
    ? { memberId: supplier.memberId }
    : {};
  return [
    {
      id: 'store-category-tree-bootstrap',
      componentKey: STORE_CATEGORIES_COMPONENT_KEY,
      request: memberScope,
      required: false,
    },
    {
      id: 'store-catalog-bootstrap',
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      request: {
        ...memberScope,
        pageNum: 1,
        count: request.pageSize ?? DEFAULT_PAGE_SIZE,
        catId: null,
        keywords: null,
        sortType: DEFAULT_SORT,
      },
      required: false,
    },
  ];
}

async function applyCatalogScope(
  page: Page,
  request: CatalogPageRequest,
  capture: { captures(): CapturedAlisiteModule[] },
): Promise<void> {
  if (request.categoryId) {
    const categoryName = await waitWithDeadline(
      async () => {
        for (const candidate of capture.captures()) {
          const name = findCatalogCategoryName(
            candidate.parsed.categories,
            request.categoryId!,
          );
          if (name) return name;
        }
        return null;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        onTimeout: () => null,
      },
    );
    if (!categoryName) {
      throw new CliError(
        9,
        'CATALOG_CATEGORY_NOT_FOUND',
        `Store category ${request.categoryId} was not present in the collected category tree.`,
      );
    }
    const label = page
      .locator('.first-category label')
      .filter({ hasText: new RegExp(`^${escapeRegExp(categoryName)}$`) })
      .first();
    await catalogActionAndResponse(
      page,
      (meta) => meta.catId === request.categoryId,
      async () => {
        await label.waitFor({ state: 'visible', timeout: 10_000 });
        await label.click();
      },
      'category filter',
    );
  }

  if (request.storeKeyword) {
    const input = page.locator('input.input-search[placeholder="请输入商品名称"]');
    await catalogActionAndResponse(
      page,
      (meta) =>
        meta.catId === (request.categoryId ?? undefined) &&
        meta.keywords === request.storeKeyword,
      async () => {
        await input.waitFor({ state: 'visible', timeout: 10_000 });
        await input.fill(request.storeKeyword!);
        await input.press('Enter');
      },
      'store keyword search',
    );
  }

  const sort = catalogSortInteraction(request.sort);
  for (let clickIndex = 0; clickIndex < sort.clicks; clickIndex += 1) {
    const expectedSort =
      sort.label === '价格' && clickIndex === 0
        ? 'pricedown'
        : request.sort;
    await catalogActionAndResponse(
      page,
      (meta) =>
        meta.catId === (request.categoryId ?? undefined) &&
        meta.keywords === (request.storeKeyword ?? undefined) &&
        meta.sortType === expectedSort,
      () => clickCatalogSort(page, sort.label!),
      `${sort.label} sort`,
    );
  }
}

async function catalogActionAndResponse(
  page: Page,
  predicate: (meta: NonNullable<ReturnType<typeof readAlisiteModuleRequestMeta>>) => boolean,
  action: () => Promise<void>,
  label: string,
): Promise<void> {
  const response = page.waitForResponse(
    (candidate) => {
      const meta = readAlisiteModuleRequestMeta(
        candidate.url(),
        candidate.request().postData(),
      );
      return !!(
        meta &&
        meta.componentKey === STORE_CATALOG_COMPONENT_KEY &&
        predicate(meta)
      );
    },
    { timeout: 20_000 },
  );
  let actionCompleted = false;
  try {
    await action();
    actionCompleted = true;
    await response;
  } catch (error) {
    await response.catch(() => {});
    throw new CliError(
      9,
      actionCompleted
        ? 'CATALOG_RESPONSE_TIMEOUT'
        : 'CATALOG_DOM_CONTROL_MISSING',
      `Store ${label} did not produce the expected catalog response: ${errorMessage(error)}`,
      {
        category: 'catalog-dom',
        failureKind: actionCompleted
          ? 'response-timeout'
          : 'control-missing',
        recoveryAction: actionCompleted ? 'retry-later' : 'inspect-page-template',
        retryable: actionCompleted,
        ...(actionCompleted
          ? {}
          : { legacyCode: 'CATALOG_NEXT_PAGE_MISSING' }),
      },
    );
  }
}

async function clickCatalogSort(
  page: Page,
  label: '销量' | '价格',
): Promise<void> {
  const locator = label === '价格'
    ? page.locator('xpath=//div[normalize-space(text()[1])="价格"]').first()
    : page.getByText('销量', { exact: true }).last();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await locator.click();
}

async function gotoStore(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    throw new CliError(9, 'NETWORK_ERROR', `Failed to load supplier shop: ${errorMessage(error)}`);
  }
}

async function clickCatalogNextPage(page: Page): Promise<void> {
  const candidates = [
    page.getByRole('button', { name: /下一页/ }),
    page.getByRole('link', { name: /下一页/ }),
    page.locator('[aria-label="下一页"], .next-next, .pagination-next').first(),
    page.getByText('下一页', { exact: true }).first(),
  ];
  await candidates[0]?.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 10_000 });
      return;
    }
  }
  throw new CliError(
    9,
    'CATALOG_DOM_CONTROL_MISSING',
    'Could not find the supplier catalog next-page control.',
    {
      category: 'catalog-dom',
      failureKind: 'control-missing',
      recoveryAction: 'inspect-page-template',
      retryable: false,
      legacyCode: 'CATALOG_NEXT_PAGE_MISSING',
    },
  );
}

async function clickAndWaitForCatalogPage(
  page: Page,
  targetPage: number,
): Promise<void> {
  const response = page.waitForResponse(
    (candidate) => {
      const meta = readAlisiteModuleRequestMeta(
        candidate.url(),
        candidate.request().postData(),
      );
      return !!(
        meta &&
        meta.componentKey === STORE_CATALOG_COMPONENT_KEY &&
        meta.pageNum === targetPage
      );
    },
    { timeout: 20_000 },
  );
  try {
    await clickCatalogNextPage(page);
    await response;
  } catch (error) {
    await response.catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError(
      9,
      'CATALOG_RESPONSE_TIMEOUT',
      `Catalog DOM navigation did not produce page ${targetPage}.`,
      {
        category: 'catalog-dom',
        failureKind: 'response-timeout',
        recoveryAction: 'retry-later',
        retryable: true,
      },
    );
  }
}

function captureStatusError(
  status: string,
  pageNumber: number,
  diagnostics: AlisiteModuleCaptureDiagnostics,
  expectedTargetId: string,
  captures: CapturedAlisiteModule[],
  diagnosticTargetId?: string,
): CliError {
  if (status === 'not_logged_in') {
    return new CliError(
      3,
      'NOT_LOGGED_IN',
      'Session expired. Run `1688 login`.',
      {
        category: 'authentication',
        failureKind: 'not-logged-in',
        recoveryAction: 'login',
        retryable: true,
        diagnostics,
      },
    );
  }
  if (status === 'risk_control') {
    return new CliError(
      4,
      'RISK_CONTROL',
      '1688 risk control appeared. Retry with `--headed` and complete verification.',
      {
        category: 'risk-control',
        failureKind: 'risk-control',
        recoveryAction: 'verify-headed',
        retryable: true,
        diagnostics,
      },
    );
  }
  if (status === 'rate_limited') {
    return new CliError(
      9,
      'RATE_LIMITED',
      '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
      {
        category: 'rate_limited',
        failureKind: 'rate_limited',
        recoveryAction: 'backoff',
        retryable: true,
        diagnostics,
      },
    );
  }
  if (status === 'aborted') {
    return new CliError(9, 'COLLECTION_CANCELLED', `Catalog page ${pageNumber} collection was cancelled.`);
  }
  if (status === 'browser_closed') {
    return new CliError(9, 'PAGE_CLOSED', `Catalog page ${pageNumber} closed before capture completed.`);
  }
  if (
    diagnostics.failures.some((failure) =>
      failure.targetIds.includes(expectedTargetId),
    )
  ) {
    return new CliError(
      9,
      'CATALOG_RESPONSE_SCHEMA_CHANGED',
      `Catalog page ${pageNumber} matched the requested scope but could not be parsed.`,
      {
        category: 'catalog-response',
        failureKind: 'schema-changed',
        recoveryAction: 'inspect-capture-fixture',
        retryable: false,
        diagnostics,
      },
    );
  }
  const mismatchedCaptures = diagnosticTargetId
    ? captures.filter(
        (captured) => captured.targetId === diagnosticTargetId,
      )
    : [];
  if (mismatchedCaptures.length > 0) {
    return new CliError(
      9,
      'CATALOG_RESPONSE_SCOPE_MISMATCH',
      `Catalog page ${pageNumber} observed catalog responses, but none matched the requested scope.`,
      {
        category: 'catalog-response',
        failureKind: 'scope-mismatch',
        recoveryAction: 'inspect-request-correlation',
        retryable: false,
        observedScopes: mismatchedCaptures
          .slice(-3)
          .map((captured) => safeCatalogScopeSummary(captured.request)),
        diagnostics,
      },
    );
  }
  return new CliError(
    9,
    'CATALOG_RESPONSE_TIMEOUT',
    `Catalog page ${pageNumber} did not produce a correlated Alisite response.`,
    {
      category: 'catalog-response',
      failureKind: 'response-timeout',
      recoveryAction: 'retry-later',
      retryable: true,
      diagnostics,
    },
  );
}

function safeCatalogScopeSummary(
  request: CapturedAlisiteModule['request'],
): Record<string, unknown> {
  return {
    ...(request.memberId
      ? { memberScopeHash: hashMemberScope(request.memberId) }
      : {}),
    pageNum: request.pageNum ?? null,
    count: request.count ?? null,
    catId: request.catId ?? null,
    keywordHash: request.keywords
      ? `sha256:${createHash('sha256').update(request.keywords).digest('hex')}`
      : null,
    sortType: request.sortType ?? null,
  };
}

function catalogTargetFromUrl(input: string): CatalogTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const offerId = url.pathname.match(/\/offer\/(\d+)(?:\.html)?/)?.[1] ?? url.searchParams.get('offerId');
  if (offerId && /^\d+$/.test(offerId)) {
    return { input, type: 'offerId', offerId, memberId: null, shopUrl: null };
  }
  const memberId = url.searchParams.get('memberId');
  if (memberId && /^b2b-[A-Za-z0-9_-]+$/.test(memberId)) {
    return { input, type: 'memberId', offerId: null, memberId, shopUrl: null };
  }
  if (url.protocol === 'https:' && /(^|\.)1688\.com$/i.test(url.hostname) && isShopHost(url.hostname)) {
    return {
      input,
      type: 'shopUrl',
      offerId: null,
      memberId: null,
      shopUrl: `${url.protocol}//${url.host}/`,
    };
  }
  return null;
}

function canonicalShopUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(2, 'BAD_INPUT', 'Supplier shop URL is invalid.');
  }
  if (url.protocol !== 'https:' || !/(^|\.)1688\.com$/i.test(url.hostname) || !isShopHost(url.hostname)) {
    throw new CliError(2, 'BAD_INPUT', 'Supplier shop URL must use HTTPS on a 1688 shop host.');
  }
  return `${url.protocol}//${url.host}/`;
}

function isShopHost(hostname: string): boolean {
  return !/^(?:www|s|detail|login|passport|h5api|trade|order|cart|factory)\.1688\.com$/i.test(hostname);
}

export function normalizeCatalogTransport(
  value: string | undefined,
): CatalogTransportMode {
  const normalized = value?.trim().toLowerCase() ?? 'auto';
  if (
    normalized === 'runtime' ||
    normalized === 'dom' ||
    normalized === 'auto'
  ) {
    return normalized;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    '--catalog-transport must be runtime, dom, or auto.',
  );
}

function positiveInt(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new CliError(2, 'BAD_INPUT', `${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  return positiveInt(raw, name, 1, 1_000_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
