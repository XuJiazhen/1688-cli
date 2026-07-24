import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { createOfferCollectionBatch } from '../collection/offer-batch.js';
import { createQualificationBatch } from '../collection/qualification-batch.js';
import {
  createSearchPageBatch,
  drainSearchCheckpointSnapshot,
  encodeSearchCursor,
  planSearchBatch,
} from '../collection/search-batch.js';
import { executeCatalogBatch, type CatalogPageAdapter } from '../collection/catalog-batch.js';
import {
  assertCheckpointCompatible,
  fingerprintCollectionUnit,
  normalizeCollectionBatch,
  normalizeCollectionCheckpoint,
  normalizeCollectionUnit,
  type CollectionBatch,
  type CollectionCheckpoint,
  type CollectionUnit,
} from '../collection/contracts.js';
import { CliError } from '../io/errors.js';
import { emit } from '../io/output.js';
import {
  STORE_CATEGORIES_COMPONENT_KEY,
  parseStoreCatalogModule,
  startAlisiteModuleCapture,
  type StoreCatalogRequestMeta,
} from '../session/alisite-module.js';
import { buildOfferMediaManifest, parseOfferDetailsScript } from '../session/offer-media.js';
import { detectPageState } from '../session/page-state.js';
import {
  pageStateError,
  waitForCollectionPageAvailability,
} from '../session/recovery.js';
import {
  captureSupplierQualificationForAction,
  isSafeSupplierMemberKey,
  requestSupplierQualificationFromPage,
} from '../session/qualification-capture.js';
import {
  redactTextForDiagnostics,
  sanitizeEvidenceRef,
} from '../session/redaction.js';
import { parseOfferItemsFromMtopText, type Offer } from '../session/search-mtop.js';
import type { SupplierQualification } from '../session/supplier-qualification.js';
import { dispatch } from '../session/dispatch.js';
import type { OfferResult } from './offer.js';
import { execute as collectOffer } from './offer.js';
import { fetchIncrementalSearchPage } from './search.js';
import {
  execute as collectSupplierCatalog,
  resolveCatalogSupplier,
} from './supplier-catalog.js';
import { normalizeSearchSort } from './sourcing-utils.js';

export interface CollectOpts {
  unit: string;
  checkpoint?: string;
  fixture?: string;
  output?: string;
  profile?: string;
  headed?: boolean;
}

export interface CollectArgs {
  unit: CollectionUnit;
  checkpoint?: CollectionCheckpoint;
  headed?: boolean;
}

export interface CollectionRuntime {
  collect(
    unit: CollectionUnit,
    checkpoint?: CollectionCheckpoint,
  ): Promise<CollectionBatch>;
}

export interface ExecuteCollectionUnitOptions {
  unit: unknown;
  checkpoint?: unknown;
  runtime: CollectionRuntime;
  now?: () => Date;
}

export interface ParsedCollectInput {
  unit: CollectionUnit;
  checkpoint?: CollectionCheckpoint;
}

export interface CollectCommandDependencies {
  dispatchCollect?: (
    args: CollectArgs,
    options: {
      profile?: string;
      headed?: boolean;
      noDaemon: true;
    },
  ) => Promise<CollectionBatch>;
  now?: () => Date;
  batchId?: () => string;
}

export interface FixtureCatalogPage {
  payload: unknown;
  request?: StoreCatalogRequestMeta;
  sourceRef?: string;
}

export interface CollectionFixture {
  pages?: FixtureCatalogPage[];
  searchPage?: {
    page?: number;
    remoteSort?: string | null;
    offers?: Offer[];
    rawText?: string;
    hasMore?: boolean;
    collectedAt?: string;
    sourceRef?: string;
  };
  qualification?: unknown;
  qualificationPayload?: unknown;
  qualificationRequestMemberId?: string;
  qualificationSourceRef?: string;
  offerResult?: OfferResult;
  mediaScript?: string;
  mediaSourceRef?: string;
}

export async function run(opts: CollectOpts): Promise<void> {
  const data = await executeCollectCommand(opts);
  if (opts.output) {
    await writeFile(opts.output, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  emit({ data, human: () => printSummary(data, opts.output) });
}

export async function executeCollectCommand(
  opts: CollectOpts,
  dependencies: CollectCommandDependencies = {},
): Promise<CollectionBatch> {
  const input = await readJsonValue(opts.unit, 'CollectionUnit or collect envelope');
  const explicitCheckpoint = opts.checkpoint
    ? await readJsonValue(opts.checkpoint, 'CollectionCheckpoint')
    : undefined;
  const { unit, checkpoint } = parseCollectInput(input, explicitCheckpoint);
  if (unit.kind === 'search-page' && checkpoint !== undefined) {
    const plan = planSearchBatch(unit, checkpoint);
    if (plan.pendingItems.length > 0) {
      const now = dependencies.now ?? (() => new Date());
      const startedAt = now().toISOString();
      return drainSearchCheckpointSnapshot({
        unit,
        checkpoint,
        batchId: (dependencies.batchId ?? randomUUID)(),
        startedAt,
        completedAt: now().toISOString(),
      });
    }
  }
  if (opts.fixture) {
    const fixture = await readFixture(opts.fixture, unit.kind);
    return executeCollectionUnit({
      unit,
      checkpoint,
      runtime: createFixtureCollectionRuntime(fixture),
    });
  }
  const dispatchCollect =
    dependencies.dispatchCollect ??
    ((args: CollectArgs, options: {
      profile?: string;
      headed?: boolean;
      noDaemon: true;
    }) =>
      dispatch<CollectArgs, CollectionBatch>(
        'collect',
        args,
        options,
      ));
  return dispatchCollect(
    { unit, checkpoint, headed: opts.headed },
    { profile: opts.profile, headed: opts.headed, noDaemon: true },
  );
}

export function parseCollectInput(
  value: unknown,
  explicitCheckpoint?: unknown,
): ParsedCollectInput {
  const envelope =
    isPlainRecord(value) && Object.hasOwn(value, 'unit')
      ? value
      : undefined;
  if (
    envelope?.checkpoint !== undefined &&
    explicitCheckpoint !== undefined
  ) {
    throw new CliError(
      2,
      'BAD_INPUT',
      'CollectionCheckpoint must be supplied in either the collect envelope or --checkpoint, not both.',
    );
  }
  const unit = normalizeCollectionUnit(envelope?.unit ?? value);
  const checkpointValue =
    explicitCheckpoint ?? envelope?.checkpoint;
  const checkpoint =
    checkpointValue === undefined
      ? undefined
      : normalizeCollectionCheckpoint(checkpointValue);
  return {
    unit,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export async function execute(
  ctx: BrowserContext,
  args: CollectArgs,
): Promise<CollectionBatch> {
  return executeCollectionUnit({
    unit: args.unit,
    checkpoint: args.checkpoint,
    runtime: createPlaywrightCollectionRuntime(ctx, args.headed === true),
  });
}

export async function executeCollectionUnit(
  options: ExecuteCollectionUnitOptions,
): Promise<CollectionBatch> {
  const unit = normalizeCollectionUnit(options.unit);
  const checkpoint = options.checkpoint === undefined
    ? undefined
    : assertCheckpointCompatible(unit, options.checkpoint);
  const startedAt = (options.now ?? (() => new Date()))();
  try {
    const batch = normalizeCollectionBatch(await options.runtime.collect(unit, checkpoint));
    if (batch.unitId !== unit.unitId || batch.kind !== unit.kind) {
      throw new CliError(
        2,
        'COLLECTION_BATCH_MISMATCH',
        'Collection runtime returned a batch for a different unit or kind.',
      );
    }
    return batch;
  } catch (error) {
    if (isContractError(error)) throw error;
    return failedCollectionBatch(unit, checkpoint, error, startedAt, options.now);
  }
}

export function createPlaywrightCollectionRuntime(
  ctx: BrowserContext,
  headed: boolean,
): CollectionRuntime {
  return {
    async collect(unit, checkpoint) {
      switch (unit.kind) {
        case 'search-page':
          return collectSearchUnit(ctx, unit, checkpoint, headed);
        case 'store-catalog':
        case 'store-categories':
          return collectSupplierCatalog(ctx, { unit, checkpoint, headed });
        case 'store-qualification':
          return collectQualificationUnit(ctx, unit, checkpoint, headed);
        case 'offer-detail':
        case 'offer-media-manifest':
          return collectOfferUnit(ctx, unit, headed);
      }
    },
  };
}

export function createFixtureCollectionRuntime(
  fixture: CollectionFixture,
): CollectionRuntime {
  return {
    async collect(unit, checkpoint) {
      const startedAt = new Date().toISOString();
      switch (unit.kind) {
        case 'store-catalog':
        case 'store-categories': {
          const pages = fixture.pages ?? [];
          const evidence = new Map<number, string>();
          const adapter: CatalogPageAdapter = {
            async collectPage(request) {
              const entry = pages[request.page - 1];
              if (!entry) throw new CliError(9, 'FIXTURE_PAGE_MISSING', `Fixture page ${request.page} is missing.`);
              evidence.set(request.page, entry.sourceRef ?? `fixture:catalog:page:${request.page}`);
              return parseStoreCatalogModule(entry.payload, entry.request ?? {
                memberId: request.memberId ?? null,
                pageNum: request.page,
                pageSize: request.pageSize ?? null,
                categoryId: request.categoryId ?? null,
                keyword: request.storeKeyword ?? null,
                sortType: request.sort ?? null,
              });
            },
            sourceRefForPage(page) {
              return evidence.get(page);
            },
            evidenceRefs() {
              return [...evidence.values()];
            },
          };
          return executeCatalogBatch({ unit, checkpoint, adapter });
        }
        case 'search-page': {
          const pageFixture = fixture.searchPage;
          if (!pageFixture) throw new CliError(9, 'FIXTURE_MISSING', 'searchPage fixture is required.');
          const plan = planSearchBatch(unit, checkpoint);
          const offers = pageFixture.offers ?? (pageFixture.rawText ? parseOfferItemsFromMtopText(pageFixture.rawText) : []);
          const completedAt = new Date().toISOString();
          return createSearchPageBatch({
            unit,
            checkpoint,
            batchId: randomUUID(),
            page: pageFixture.page ?? plan.page,
            remoteSort: pageFixture.remoteSort ?? null,
            offers,
            hasMore: pageFixture.hasMore ?? false,
            startedAt,
            collectedAt: pageFixture.collectedAt ?? completedAt,
            completedAt,
            rawEvidenceRefs: pageFixture.sourceRef ? [pageFixture.sourceRef] : [],
          });
        }
        case 'store-qualification': {
          const completedAt = new Date().toISOString();
          if (fixture.qualification !== undefined) {
            return createQualificationBatch({
              unit,
              checkpoint,
              batchId: randomUUID(),
              qualification: fixture.qualification as SupplierQualification,
              requestMemberId: fixture.qualificationRequestMemberId,
              startedAt,
              completedAt,
              sourceRef: fixture.qualificationSourceRef,
            });
          }
          if (fixture.qualificationPayload === undefined) {
            throw new CliError(9, 'FIXTURE_MISSING', 'qualificationPayload fixture is required.');
          }
          return createQualificationBatch({
            unit,
            checkpoint,
            batchId: randomUUID(),
            payload: fixture.qualificationPayload,
            requestMemberId: fixture.qualificationRequestMemberId,
            collectedAt: completedAt,
            startedAt,
            completedAt,
            sourceRef: fixture.qualificationSourceRef,
          });
        }
        case 'offer-detail':
        case 'offer-media-manifest': {
          const completedAt = new Date().toISOString();
          const offer = fixture.offerResult ?? offerFromMediaFixture(unit, fixture, completedAt);
          return createOfferCollectionBatch({
            unit,
            outcome: { status: 'captured', value: offer },
            startedAt,
            completedAt,
          });
        }
      }
    },
  };
}

async function collectSearchUnit(
  ctx: BrowserContext,
  unit: CollectionUnit,
  checkpoint: CollectionCheckpoint | undefined,
  headed: boolean,
): Promise<CollectionBatch> {
  const plan = planSearchBatch(unit, checkpoint);
  const startedAt = new Date().toISOString();
  if (plan.pendingItems.length > 0) {
    return drainSearchCheckpointSnapshot({
      unit,
      checkpoint: checkpoint!,
      batchId: randomUUID(),
      startedAt,
      completedAt: new Date().toISOString(),
    });
  }
  const result = await fetchIncrementalSearchPage(ctx, {
    keyword: unit.subject.keyword!,
    page: plan.page,
    sort: normalizeSearchSort(unit.scope?.sort),
    headed,
  });
  return createSearchPageBatch({
    unit,
    checkpoint,
    batchId: randomUUID(),
    page: result.page,
    remoteSort: result.remoteSort,
    offers: result.offers,
    hasMore: result.hasMore,
    startedAt,
    collectedAt: result.collectedAt,
    completedAt: new Date().toISOString(),
  });
}

async function collectQualificationUnit(
  ctx: BrowserContext,
  unit: CollectionUnit,
  checkpoint: CollectionCheckpoint | undefined,
  headed: boolean,
): Promise<CollectionBatch> {
  const startedAt = new Date().toISOString();
  const supplier = await resolveCatalogSupplier(ctx, unit, headed);
  const page = await ctx.newPage();
  try {
    const memberId = await navigateAndResolveQualificationMember(
      page,
      supplier.shopUrl,
      supplier.memberId,
      headed,
    );
    let capture = await captureSupplierQualificationForAction(
      page,
      { memberId, timeoutMs: 15_000 },
      () => requestSupplierQualificationFromPage(page, memberId),
    );
    if (!capture.qualification) {
      const availability = await waitForCollectionPageAvailability(page, {
        headed,
      });
      if (availability.recoveredRiskChallenge) {
        capture = await captureSupplierQualificationForAction(
          page,
          { memberId, timeoutMs: 15_000 },
          () => requestSupplierQualificationFromPage(page, memberId),
        );
      }
      if (!capture.qualification) {
        const stateError = pageStateError(await detectPageState(page), headed);
        if (stateError !== null) throw stateError;
      }
    }
    const completedAt = new Date().toISOString();
    const sourceRef = capture.diagnostics.lastParsedUrl
      ? sanitizeEvidenceRef(capture.diagnostics.lastParsedUrl)
      : undefined;
    const missingSourceRef = capture.diagnostics.lastMatchedUrl
      ? sanitizeEvidenceRef(capture.diagnostics.lastMatchedUrl)
      : 'capture:qualification:missing';
    return capture.qualification
      ? createQualificationBatch({
          unit,
          checkpoint,
          batchId: randomUUID(),
          qualification: capture.qualification,
          requestMemberId: memberId,
          startedAt,
          completedAt,
          sourceRef,
          rawEvidenceRefs: sourceRef ? [sourceRef] : [],
        })
      : createQualificationBatch({
          unit,
          checkpoint,
          batchId: randomUUID(),
          payload: null,
          requestMemberId: memberId,
          collectedAt: completedAt,
          startedAt,
          completedAt,
          sourceRef: missingSourceRef,
        });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function navigateAndResolveQualificationMember(
  page: Page,
  shopUrl: string,
  knownMemberId?: string,
  headed = false,
): Promise<string> {
  if (isSafeSupplierMemberKey(knownMemberId)) {
    await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForCollectionPageAvailability(page, { headed });
    return knownMemberId;
  }
  const capture = startAlisiteModuleCapture({
    page,
    targets: [
      {
        id: 'qualification-member',
        componentKey: STORE_CATEGORIES_COMPONENT_KEY,
      },
    ],
  });
  const result = await capture.waitForAction(
    () => page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    {
      timeoutMs: 15_000,
      isClosed: () => page.isClosed(),
      isNotLoggedIn: async () => (await detectPageState(page)).kind === 'not_logged_in',
      isRateLimited: async () =>
        (await detectPageState(page)).kind === 'rate_limited',
      isBlocked: async () => {
        const state = await detectPageState(page);
        if (state.kind === 'risk_challenge' && headed) {
          await waitForCollectionPageAvailability(page, { headed: true });
          return false;
        }
        return state.kind === 'risk_challenge';
      },
    },
  );
  if (result.status === 'not_logged_in') {
    throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
  }
  if (result.status === 'risk_control') {
    throw new CliError(
      4,
      'RISK_CONTROL',
      '1688 risk control appeared. Retry with `--headed` and complete verification.',
    );
  }
  if (result.status === 'rate_limited') {
    throw new CliError(
      9,
      'RATE_LIMITED',
      '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
      {
        category: 'rate_limited',
        failureKind: 'rate_limited',
        recoveryAction: 'backoff',
        retryable: true,
      },
    );
  }
  const memberId = result.captures
    .map((captured) => captured.request.memberId)
    .find(isSafeSupplierMemberKey);
  if (result.status !== 'captured' || !memberId) {
    throw new CliError(
      9,
      'CAPTURE_TIMEOUT',
      'Supplier shop did not expose a correlated memberId.',
      { responseCapture: result.diagnostics, retryable: true },
    );
  }
  return memberId;
}

async function collectOfferUnit(
  ctx: BrowserContext,
  unit: CollectionUnit,
  headed: boolean,
): Promise<CollectionBatch> {
  const startedAt = new Date().toISOString();
  try {
    const value = await collectOffer(ctx, { offerId: unit.subject.offerId!, headed });
    return createOfferCollectionBatch({
      unit,
      outcome: { status: 'captured', value },
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    return createOfferCollectionBatch({
      unit,
      outcome: { status: 'failed', error },
      startedAt,
      completedAt: new Date().toISOString(),
    });
  }
}

function failedCollectionBatch(
  unit: CollectionUnit,
  restored: CollectionCheckpoint | undefined,
  error: unknown,
  startedAt: Date,
  now: (() => Date) | undefined,
): CollectionBatch {
  const completedAt = (now ?? (() => new Date()))();
  const code = error instanceof CliError ? error.code : 'COLLECTION_FAILED';
  const message = redactTextForDiagnostics(error instanceof Error ? error.message : String(error));
  const actionRequired = code === 'NOT_LOGGED_IN' || code === 'RISK_CONTROL'
    ? {
        type: code === 'NOT_LOGGED_IN' ? ('login' as const) : ('risk-control' as const),
        message,
      }
    : undefined;
  const nextPage =
    unit.kind === 'search-page'
      ? planSearchBatch(unit, restored).page
      : restored?.nextPage ?? (isPageKind(unit.kind) ? 1 : undefined);
  const pendingKey = nextPage === undefined
    ? `${unit.kind}:${unit.subject.offerId ?? 'subject'}`
    : `page:${nextPage}`;
  const checkpoint =
    unit.kind === 'search-page'
      ? searchFailureCheckpoint(unit, restored, completedAt)
      : {
          schemaVersion: 1 as const,
          unitFingerprint: fingerprintCollectionUnit(unit),
          kind: unit.kind,
          subject: { ...unit.subject },
          scope: { ...(unit.scope ?? {}) },
          ...(nextPage === undefined ? {} : { nextPage }),
          completedPages: restored?.completedPages ?? [],
          seenKeys: restored?.seenKeys ?? [],
          pendingKeys: [pendingKey],
          attemptCounts: {
            ...restored?.attemptCounts,
            [pendingKey]: (restored?.attemptCounts[pendingKey] ?? 0) + 1,
          },
          updatedAt: completedAt.toISOString(),
        };
  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: randomUUID(),
    unitId: unit.unitId,
    kind: unit.kind,
    status: actionRequired ? 'blocked' : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    subject: { ...unit.subject },
    scope: { ...(unit.scope ?? {}) },
    observations: [],
    completeness: {
      requestedScope: unit.scope?.requestedScope ?? 'page',
      state: 'unknown',
      observedPages: restored?.completedPages ?? [],
      failedPages: nextPage === undefined ? [] : [nextPage],
      uniqueItems: restored?.seenKeys.length ?? 0,
    },
    duplicateObservations: [],
    warnings: [],
    errors: [{ code, message, retryable: true }],
    checkpoint,
    actionRequired,
    rawEvidenceRefs: [],
    metrics: { failedUnits: 1 },
  });
}

function searchFailureCheckpoint(
  unit: CollectionUnit,
  restored: CollectionCheckpoint | undefined,
  completedAt: Date,
): CollectionCheckpoint {
  const plan = planSearchBatch(unit, restored);
  const page = plan.page;
  const attemptKey = `page:${page}`;
  return {
    schemaVersion: 1,
    unitFingerprint: fingerprintCollectionUnit(unit),
    kind: 'search-page',
    subject: { ...unit.subject },
    scope: { ...(unit.scope ?? {}) },
    nextCursor:
      restored?.nextCursor ??
      encodeSearchCursor(page),
    nextPage: page,
    completedPages: plan.completedPages,
    seenKeys: plan.seenOfferIds,
    pendingKeys: plan.pendingOfferIds,
    ...(plan.pendingItems.length === 0
      ? {}
      : { pendingItems: plan.pendingItems }),
    attemptCounts: {
      ...restored?.attemptCounts,
      [attemptKey]: (restored?.attemptCounts[attemptKey] ?? 0) + 1,
    },
    updatedAt: completedAt.toISOString(),
  };
}

function offerFromMediaFixture(
  unit: CollectionUnit,
  fixture: CollectionFixture,
  collectedAt: string,
): OfferResult {
  if (unit.kind !== 'offer-media-manifest' || fixture.mediaScript === undefined) {
    throw new CliError(9, 'FIXTURE_MISSING', 'offerResult fixture is required for offer-detail.');
  }
  const detail = parseOfferDetailsScript(
    fixture.mediaScript,
    fixture.mediaSourceRef ?? 'fixture:offer_details.content',
    collectedAt,
  );
  const offerId = unit.subject.offerId!;
  return {
    offerId,
    title: '',
    url: `https://detail.1688.com/offer/${offerId}.html`,
    priceRange: null,
    priceMin: null,
    priceMax: null,
    unitName: null,
    minOrderQty: null,
    mixOrderQty: null,
    priceTiers: [],
    detailUrl: null,
    attributes: [],
    packageInfo: [],
    supplier: { name: null, loginId: null, memberId: null, userId: null },
    shopCard: null,
    consignment: null,
    freight: { receiveAddress: null, sendArea: null, province: null, city: null, unitWeight: null },
    saledCount: null,
    categoryId: null,
    options: [],
    skus: [],
    mainImage: null,
    images: [],
    media: buildOfferMediaManifest({
      offerId,
      mainImage: null,
      images: [],
      skuImages: [],
      detail,
      collectedAt,
    }),
    sources: {
      shopCardResponseObserved: false,
      shopCardCaptured: false,
      consignmentResponseObserved: false,
      consignmentCaptured: false,
      detailMediaResponseObserved: true,
      detailMediaCaptured: detail.availability !== 'failed',
    },
  };
}

async function readJsonValue(input: string, label: string): Promise<unknown> {
  const raw = input === '-'
    ? await readStdin()
    : input.startsWith('@')
      ? await readFile(input.slice(1), 'utf8')
      : input;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError(2, 'BAD_INPUT', `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readFixture(
  file: string,
  kind: CollectionUnit['kind'],
): Promise<CollectionFixture> {
  const raw = await readFile(file, 'utf8');
  if (file.endsWith('.js')) return { mediaScript: raw, mediaSourceRef: `fixture:${file}` };
  const parsed = JSON.parse(raw) as CollectionFixture;
  if (
    parsed.pages || parsed.searchPage || parsed.qualification !== undefined ||
    parsed.qualificationPayload !== undefined || parsed.offerResult || parsed.mediaScript
  ) return parsed;
  if (kind === 'store-catalog' || kind === 'store-categories') {
    return { pages: [{ payload: parsed }] };
  }
  if (kind === 'store-qualification') {
    return { qualificationPayload: parsed };
  }
  if (kind === 'offer-detail' || kind === 'offer-media-manifest') {
    return { offerResult: parsed as unknown as OfferResult };
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    'A search replay fixture must contain a searchPage envelope.',
  );
}

async function readStdin(): Promise<string> {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function isPageKind(kind: CollectionUnit['kind']): boolean {
  return kind === 'search-page' || kind === 'store-catalog' || kind === 'store-categories' || kind === 'store-qualification';
}

function isContractError(error: unknown): boolean {
  return error instanceof CliError && (
    error.code === 'BAD_INPUT' ||
    error.code === 'CHECKPOINT_INCOMPATIBLE' ||
    error.code === 'COLLECTION_BATCH_MISMATCH'
  );
}

function printSummary(batch: CollectionBatch, output?: string): void {
  process.stdout.write(
    `${batch.kind} ${batch.status}: ${batch.observations.length} observations; batchId=${batch.batchId}\n`,
  );
  if (batch.checkpoint) {
    process.stdout.write(
      `Checkpoint ready: ${batch.checkpoint.nextCursor ?? batch.checkpoint.nextPage ?? 'pending facts'}\n`,
    );
  }
  if (output) process.stdout.write(`Wrote collection batch to ${output}\n`);
}
