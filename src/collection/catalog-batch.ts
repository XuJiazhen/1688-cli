import { randomUUID } from 'node:crypto';
import { CliError } from '../io/errors.js';
import type { StoreCatalogParseResult } from '../session/alisite-module.js';
import {
  redactDiagnosticMetadata,
  redactTextForDiagnostics,
} from '../session/redaction.js';
import {
  assertCheckpointCompatible,
  fingerprintCollectionUnit,
  normalizeCollectionBatch,
  normalizeCollectionUnit,
  type CollectionBatch,
  type CollectionWarning,
  type CollectionUnit,
} from './contracts.js';

export interface CatalogPageRequest {
  kind: 'store-catalog' | 'store-categories';
  page: number;
  pageSize?: number;
  memberId?: string;
  shopUrl?: string;
  sourceOfferId?: string;
  categoryId?: string;
  storeKeyword?: string;
  sort?: string;
  signal?: AbortSignal;
}

export interface CatalogPageAdapter {
  collectPage(request: CatalogPageRequest): Promise<StoreCatalogParseResult>;
  sourceRefForPage?(page: number): string | undefined;
  diagnosticsForPage?(page: number): CatalogPageDiagnostics | undefined;
  evidenceRefs?(): string[];
}

export interface CatalogPageDiagnostics {
  transport: 'runtime' | 'dom';
  targetPage: number;
  catalogRequestCount: number;
  runtimeReadyMs: number;
  responseWaitMs: number;
  parseMs: number;
  parserVersion: string;
  memberScopeHash?: string;
  runtimeResultStatus?: 'parsed' | 'unrecognized' | 'pending' | 'rejected';
  fallbackReason?: string;
}

export interface ExecuteCatalogBatchOptions {
  unit: unknown;
  checkpoint?: unknown;
  adapter: CatalogPageAdapter;
  signal?: AbortSignal;
  batchId?: string;
  now?: () => Date;
}

export async function executeCatalogBatch(
  options: ExecuteCatalogBatchOptions,
): Promise<CollectionBatch> {
  const unit = normalizeCollectionUnit(options.unit);
  assertCatalogUnit(unit);
  const restoredCheckpoint =
    options.checkpoint === undefined
      ? undefined
      : assertCheckpointCompatible(unit, options.checkpoint);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const supplier = unit.subject.supplier ?? {};
  const requestedScope =
    unit.scope?.requestedScope ??
    (unit.kind === 'store-categories' ? 'page' : 'bounded-pages');
  const maxPages =
    unit.kind === 'store-categories'
      ? 1
      : unit.scope?.maxPagesPerBatch ?? 1;
  const observations: Array<Record<string, unknown>> = [];
  const completedPages = new Set(restoredCheckpoint?.completedPages ?? []);
  const batchObservedPages: number[] = [];
  const failedPages: number[] = [];
  const duplicateObservations: CollectionBatch['duplicateObservations'] = [];
  const warnings: CollectionWarning[] = [];
  const errors: CollectionBatch['errors'] = [];
  const seenSources = new Map<string, string>(
    (restoredCheckpoint?.seenKeys ?? []).map((key) => [
      key,
      `checkpoint:seen:${key}`,
    ]),
  );
  const attemptCounts: Record<string, number> = {
    ...restoredCheckpoint?.attemptCounts,
  };
  let expectedItems = restoredCheckpoint?.expectedItems;
  let expectedPages = restoredCheckpoint?.expectedPages;
  let pageCeiling = restoredCheckpoint?.pageCeiling ?? expectedPages;
  let page = restoredCheckpoint?.nextPage ?? 1;
  let requestedPageCount = 0;
  let stoppedByItemLimit = false;
  let stoppedByDeadline = false;
  let categoryItems = 0;
  let actionRequired: CollectionBatch['actionRequired'];
  const pageDiagnostics = new Map<number, CatalogPageDiagnostics>();

  for (let requestedPages = 0; requestedPages < maxPages; requestedPages += 1) {
    if (
      unit.limits?.deadlineMs !== undefined &&
      now().getTime() - startedAt.getTime() >= unit.limits.deadlineMs
    ) {
      stoppedByDeadline = true;
      warnings.push({
        code: 'DEADLINE_REACHED',
        message: 'Catalog collection stopped at the batch deadline.',
        details: { deadlineMs: unit.limits.deadlineMs, nextPage: page },
      });
      break;
    }
    requestedPageCount += 1;
    attemptCounts[`page:${page}`] = (attemptCounts[`page:${page}`] ?? 0) + 1;
    let parsed: StoreCatalogParseResult;
    try {
      parsed = await options.adapter.collectPage({
        kind: unit.kind,
        page,
        pageSize: unit.scope?.pageSize,
        memberId: supplier.memberId,
        shopUrl: supplier.shopUrl,
        sourceOfferId: supplier.sourceOfferId,
        categoryId: unit.scope?.categoryId,
        storeKeyword: unit.scope?.storeKeyword,
        sort: unit.scope?.sort,
        signal: options.signal,
      });
    } catch (error) {
      rememberPageDiagnostics(options.adapter, page, pageDiagnostics);
      failedPages.push(page);
      if (
        error instanceof CliError &&
        (error.code === 'NOT_LOGGED_IN' || error.code === 'RISK_CONTROL')
      ) {
        const message = safeErrorMessage(
          error.message,
          error.code === 'NOT_LOGGED_IN'
            ? 'Session expired. Run `1688 login`.'
            : 'Complete the 1688 risk-control challenge and retry.',
        );
        actionRequired = {
          type: error.code === 'NOT_LOGGED_IN' ? 'login' : 'risk-control',
          message,
        };
        errors.push({
          code: error.code,
          message,
          retryable: true,
          details: {
            page,
            ...(
              redactDiagnosticMetadata(error.details) as Record<
                string,
                unknown
              >
            ),
          },
        });
      } else {
        const cliError = error instanceof CliError ? error : null;
        errors.push({
          code: cliError?.code ?? 'CATALOG_PAGE_FAILED',
          message: safeErrorMessage(
            error instanceof Error ? error.message : String(error),
            `Catalog page ${page} failed.`,
          ),
          retryable:
            typeof cliError?.details.retryable === 'boolean'
              ? cliError.details.retryable
              : true,
          details: {
            page,
            ...(
              cliError
                ? redactDiagnosticMetadata(cliError.details)
                : {}
            ) as Record<string, unknown>,
          },
        });
      }
      break;
    }
    const diagnostics = rememberPageDiagnostics(
      options.adapter,
      page,
      pageDiagnostics,
    );
    const expectedResultKind =
      unit.kind === 'store-catalog' ? 'offer-list' : 'categories';
    if (parsed.kind !== expectedResultKind) {
      failedPages.push(page);
      errors.push({
        code: 'CATALOG_RESULT_KIND_MISMATCH',
        message: `Expected ${expectedResultKind} result for ${unit.kind}, received ${parsed.kind}.`,
        retryable: false,
        details: { page },
      });
      break;
    }
    const collectedAt = now().toISOString();
    batchObservedPages.push(page);
    if (parsed.offerCount !== null) {
      if (expectedItems === undefined) {
        expectedItems = parsed.offerCount;
      } else if (parsed.offerCount !== expectedItems) {
        warnings.push({
          code: 'OFFER_COUNT_DRIFT',
          message: 'Store offerCount changed while collecting the catalog.',
          details: {
            firstOfferCount: expectedItems,
            observedOfferCount: parsed.offerCount,
            page,
          },
        });
      }
    }
    if (parsed.totalPages !== null) {
      if (expectedPages === undefined) {
        expectedPages = parsed.totalPages;
        pageCeiling = parsed.totalPages;
      } else if (parsed.totalPages !== expectedPages) {
        warnings.push({
          code: 'TOTAL_PAGES_DRIFT',
          message: 'Store totalPages changed while collecting the catalog.',
          details: {
            firstTotalPages: expectedPages,
            observedTotalPages: parsed.totalPages,
            page,
          },
        });
        pageCeiling = Math.max(
          pageCeiling ?? expectedPages,
          parsed.totalPages,
        );
      }
    }
    warnings.push(
      ...parsed.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        details: { fieldPath: warning.fieldPath, page },
      })),
    );
    if (unit.kind === 'store-categories') {
      categoryItems = countCategories(parsed.categories);
      observations.push({
        memberId: parsed.page.memberId ?? supplier.memberId ?? null,
        categories: parsed.categories,
        userDefined: parsed.userDefined,
        source: {
          page,
          sourceRef:
            options.adapter.sourceRefForPage?.(page) ??
            `store-categories:page:${page}`,
          ...(diagnostics ?? {}),
        },
        collectedAt,
      });
    }
    let pageWasTruncated = false;
    for (const offer of parsed.offers) {
      const duplicateSource = `page:${page}#position:${offer.pagePosition}`;
      const firstSource = seenSources.get(offer.offerId);
      if (firstSource !== undefined) {
        duplicateObservations.push({
          key: offer.offerId,
          firstSource,
          duplicateSource,
        });
        continue;
      }
      if (
        unit.limits?.maxItems !== undefined &&
        observations.length >= unit.limits.maxItems
      ) {
        pageWasTruncated = true;
        stoppedByItemLimit = true;
        break;
      }
      seenSources.set(offer.offerId, duplicateSource);
      observations.push({
        ...offer,
        source: {
          page: parsed.page.pageNum ?? page,
          requestedPage: page,
          pageSize: parsed.page.pageSize ?? unit.scope?.pageSize ?? null,
          offerCount: parsed.offerCount,
          totalPages: parsed.totalPages,
          categoryId: parsed.page.categoryId ?? unit.scope?.categoryId ?? null,
          storeKeyword: parsed.page.keyword ?? unit.scope?.storeKeyword ?? null,
          sort: parsed.page.sortType ?? unit.scope?.sort ?? null,
          sourceRef:
            options.adapter.sourceRefForPage?.(page) ??
            `store-catalog:page:${page}`,
          ...(diagnostics ?? {}),
        },
        collectedAt,
      });
    }
    if (!pageWasTruncated) completedPages.add(page);
    if (
      (requestedScope === 'page' && completedPages.has(page)) ||
      (pageCeiling !== undefined &&
        Array.from({ length: pageCeiling }, (_, index) => index + 1).every(
          (candidate) => completedPages.has(candidate),
        ))
    ) {
      break;
    }
    if (
      stoppedByItemLimit ||
      (unit.limits?.maxItems !== undefined &&
        observations.length >= unit.limits.maxItems)
    ) {
      stoppedByItemLimit = true;
      warnings.push({
        code: 'MAX_ITEMS_REACHED',
        message: 'Catalog collection stopped at the batch maxItems limit.',
        details: { maxItems: unit.limits?.maxItems, page },
      });
      break;
    }
    const nextIncomplete = Array.from(
      { length: pageCeiling ?? page + 1 },
      (_, index) => index + 1,
    ).find((candidate) => !completedPages.has(candidate));
    page = nextIncomplete ?? page + 1;
  }

  const completedAt = now();
  const observedPages = [...completedPages].sort((a, b) => a - b);
  const catalogNaturallyComplete =
    pageCeiling !== undefined &&
    Array.from({ length: pageCeiling }, (_, index) => index + 1).every(
      (page) => completedPages.has(page),
    );
  const reachedRequestedEnd =
    (requestedScope === 'page' && completedPages.size > 0) ||
    catalogNaturallyComplete;
  if (
    unit.kind === 'store-catalog' &&
    catalogNaturallyComplete &&
    expectedItems !== undefined &&
    expectedItems !== seenSources.size
  ) {
    warnings.push({
      code: 'OFFER_COUNT_UNIQUE_MISMATCH',
      message: 'The completed catalog unique offer count differs from offerCount.',
      details: {
        offerCount: expectedItems,
        uniqueItems: seenSources.size,
      },
    });
  }
  const nextPage = reachedRequestedEnd
    ? undefined
    : Array.from(
        { length: pageCeiling ?? observedPages.length + 1 },
        (_, index) => index + 1,
      ).find((page) => !observedPages.includes(page));
  const checkpoint =
    nextPage === undefined
      ? undefined
      : {
          schemaVersion: 1 as const,
          unitFingerprint: fingerprintCollectionUnit(unit),
          kind: unit.kind,
          subject: { ...unit.subject },
          scope: { ...unit.scope },
          nextPage,
          expectedItems,
          expectedPages,
          pageCeiling,
          completedPages: observedPages,
          seenKeys: [...seenSources.keys()],
          pendingKeys: [`page:${nextPage}`],
          attemptCounts,
          updatedAt: completedAt.toISOString(),
        };
  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: options.batchId ?? randomUUID(),
    unitId: unit.unitId,
    kind: unit.kind,
    status: actionRequired
      ? 'blocked'
      : errors.length > 0
        ? observations.length > 0 ? 'partial' : 'failed'
        : checkpoint || stoppedByItemLimit || stoppedByDeadline
          ? 'partial'
          : 'completed',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    subject: { ...unit.subject },
    scope: { ...unit.scope },
    observations,
    completeness: {
      requestedScope,
      state: reachedRequestedEnd
        ? 'complete'
        : completedPages.size === 0 && expectedPages === undefined
          ? 'unknown'
          : 'truncated',
      observedPages,
      failedPages,
      expectedItems,
      uniqueItems:
        unit.kind === 'store-categories' ? categoryItems : seenSources.size,
    },
    duplicateObservations,
    warnings,
    errors,
    checkpoint,
    actionRequired,
    rawEvidenceRefs: options.adapter.evidenceRefs?.() ?? [],
    metrics: {
      requestedPages: requestedPageCount,
      successfulPages: batchObservedPages.length,
      failedPages: failedPages.length,
      uniqueItems:
        unit.kind === 'store-categories' ? categoryItems : seenSources.size,
      newUniqueItems:
        unit.kind === 'store-categories' ? categoryItems : observations.length,
      categoryItems,
      duplicateItems: duplicateObservations.length,
      elapsedMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      catalogRuntimePages: [...pageDiagnostics.values()].filter(
        (entry) => entry.transport === 'runtime',
      ).length,
      catalogDomPages: [...pageDiagnostics.values()].filter(
        (entry) => entry.transport === 'dom',
      ).length,
      catalogRequestCount: sumPageDiagnostic(
        pageDiagnostics,
        'catalogRequestCount',
      ),
      catalogRuntimeReadyMs: sumPageDiagnostic(
        pageDiagnostics,
        'runtimeReadyMs',
      ),
      catalogResponseWaitMs: sumPageDiagnostic(
        pageDiagnostics,
        'responseWaitMs',
      ),
      catalogParseMs: sumPageDiagnostic(pageDiagnostics, 'parseMs'),
      catalogFallbackPages: [...pageDiagnostics.values()].filter(
        (entry) => entry.fallbackReason !== undefined,
      ).length,
    },
  });
}

function rememberPageDiagnostics(
  adapter: CatalogPageAdapter,
  page: number,
  target: Map<number, CatalogPageDiagnostics>,
): CatalogPageDiagnostics | undefined {
  const diagnostics = adapter.diagnosticsForPage?.(page);
  if (diagnostics) target.set(page, diagnostics);
  return diagnostics;
}

function sumPageDiagnostic(
  diagnostics: Map<number, CatalogPageDiagnostics>,
  field:
    | 'catalogRequestCount'
    | 'runtimeReadyMs'
    | 'responseWaitMs'
    | 'parseMs',
): number {
  return [...diagnostics.values()].reduce(
    (total, entry) => total + entry[field],
    0,
  );
}

function assertCatalogUnit(
  unit: CollectionUnit,
): asserts unit is CollectionUnit & {
  kind: 'store-catalog' | 'store-categories';
} {
  if (unit.kind !== 'store-catalog' && unit.kind !== 'store-categories') {
    throw new TypeError(
      `executeCatalogBatch only supports store-catalog and store-categories, received ${unit.kind}`,
    );
  }
}

function countCategories(
  categories: StoreCatalogParseResult['categories'],
): number {
  return categories.reduce(
    (count, category) => count + 1 + countCategories(category.children),
    0,
  );
}

function safeErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim() || fallback;
  return redactTextForDiagnostics(normalized);
}
