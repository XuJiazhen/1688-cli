import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import { fetchIncrementalSearchPage } from '../commands/search.js';
import { executeRaw as collectOfferRaw } from '../commands/offer.js';
import { buildStoreCatalogUrl } from '../commands/supplier-catalog.js';
import { createQualificationBatch } from '../collection/qualification-batch.js';
import { createOfferCollectionBatch } from '../collection/offer-batch.js';
import { createSearchPageBatch, encodeSearchCursor } from '../collection/search-batch.js';
import { normalizeCollectionBatch, type CollectionBatch, type CollectionUnit } from '../collection/contracts.js';
import { CliError } from '../io/errors.js';
import {
  assertStoreSampleProfileObservationV1,
  collectBoundedStoreSampleV1,
  parseStoreProfileMemberAuthorityV1,
  requestStoreCatalogFromPage,
  waitForStoreCatalogRuntime,
  type StoreSampleProfileObservationV1,
} from '../session/catalog-runtime.js';
import {
  STORE_CATALOG_COMPONENT_KEY,
  parseStoreCatalogModule,
  readAlisiteModuleRequestMeta,
} from '../session/alisite-module.js';
import { readSearchMtopRequestMeta } from '../session/search-mtop.js';
import {
  captureSupplierQualificationForAction,
  requestSupplierQualificationFromPage,
  requireSupplierQualificationResponse,
} from '../session/qualification-capture.js';
import { waitForCollectionPageAvailability } from '../session/recovery.js';
import { STORE_PROFILE_COMPONENT_KEY, mapStoreProfilePayload } from '../session/store-profile.js';
import {
  assertStoreProfilePayloadState,
  captureStoreProfileForAction,
  requestStoreProfileFromPage,
} from '../session/store-profile-capture.js';
import { runOnSharedCtx } from '../session/shared.js';
import { SUPPLIER_QUALIFICATION_COMPONENT_KEY } from '../session/supplier-qualification.js';
import {
  PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
  ProductionCollectionProtocolError,
  productionCollectionRequestHashV1,
  productionCollectionRpcFailureV1,
  type ProductionCollectionExecutionReceiptV3,
  type ProductionCollectionResourceReceiptV1,
  type ProductionCollectionSourceTimingReceiptV1,
  type ProductionCollectionRpcRequestV1,
  type ProductionCollectionRpcResponseV3,
} from './production-collection-protocol.js';

export interface ProductionCollectionRuntimeOptions {
  profileId: string;
  profileName: string;
  supervisorLeaseId: string;
  supervisorGeneration: number;
  supervisorFencingToken: string;
  daemonInstanceId: string;
  contextGeneration: number;
  runtimeHostId: string;
  artifactDirectory: string;
  now?: () => Date;
  runCollection?: (
    context: BrowserContext,
    request: ProductionCollectionRpcRequestV1,
  ) => Promise<CollectionBatch>;
  runWithContext?: (
    operation: (context: BrowserContext) => Promise<CollectionBatch>,
  ) => Promise<CollectionBatch>;
  authorizeRuntime?: (
    request: ProductionCollectionRpcRequestV1,
    requestHash: string,
  ) => Promise<Readonly<{
    runtimeAdmissionReceiptId: string;
    requestHash: string;
    admittedAt: string;
  }>>;
}

/**
 * The production task boundary inside one persistent Profile daemon.
 * It accepts only the database-issued execution token, runs one of four units,
 * and persists a replayable terminal receipt after closing every owned Page.
 */
export class ProductionCollectionRuntime {
  private readonly now: () => Date;
  private readonly receiptDirectory: string;
  private readonly batchDirectory: string;
  private activeAttemptId: string | null = null;

  public constructor(private readonly options: ProductionCollectionRuntimeOptions) {
    if (!path.isAbsolute(options.artifactDirectory)) {
      throw new TypeError('artifactDirectory must be absolute.');
    }
    this.now = options.now ?? (() => new Date());
    this.receiptDirectory = path.join(options.artifactDirectory, 'production-collection-receipts');
    this.batchDirectory = path.join(options.artifactDirectory, 'production-collection-batches');
  }

  public async handle(
    request: ProductionCollectionRpcRequestV1,
    authorizeRuntime?: ProductionCollectionRuntimeOptions['authorizeRuntime'],
  ): Promise<ProductionCollectionRpcResponseV3> {
    const requestHash = productionCollectionRequestHashV1(request);
    try {
      this.assertProfile(request);
      this.assertRuntimeAuthority(request);
      if (request.method === 'production.collection.lookupReceipt') {
        const receipt = await this.readReceipt(request.attemptId);
        if (receipt !== null) this.assertReceiptIdentity(request, receipt);
        return {
          schema: PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
          rpcId: request.rpcId,
          requestHash,
          ok: true,
          data: receipt,
        };
      }
      const replay = await this.readReceipt(request.attemptId);
      if (replay !== null) {
        this.assertReceiptIdentity(request, replay);
        if (replay.requestHash !== requestHash) {
          throw new ProductionCollectionProtocolError(
            'PRODUCTION_COLLECTION_EXECUTION_CONFLICT',
            'Attempt receipt is bound to a different canonical execute request.',
          );
        }
        return {
          schema: PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
          rpcId: request.rpcId,
          requestHash,
          ok: true,
          data: replay,
        };
      }
      if (this.activeAttemptId !== null) {
        throw new ProductionCollectionProtocolError(
          'PROFILE_COLLECTION_BUSY',
          `Profile is already executing attempt ${this.activeAttemptId}.`,
          true,
          'scheduling',
        );
      }
      this.activeAttemptId = request.attemptId;
      try {
        const receipt = await this.execute(request, requestHash, authorizeRuntime);
        await this.writeReceipt(receipt);
        return {
          schema: PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
          rpcId: request.rpcId,
          requestHash,
          ok: true,
          data: receipt,
        };
      } finally {
        this.activeAttemptId = null;
      }
    } catch (error) {
      return productionCollectionRpcFailureV1({ rpcId: request.rpcId, requestHash, error });
    }
  }

  private async execute(
    request: ProductionCollectionRpcRequestV1,
    requestHash: string,
    authorizeRuntime?: ProductionCollectionRuntimeOptions['authorizeRuntime'],
  ): Promise<ProductionCollectionExecutionReceiptV3> {
    const nowMs = this.now().getTime();
    const startMs = Date.parse(request.startNotBefore);
    const deadlineMs = Date.parse(request.deadlineAt);
    if (deadlineMs <= nowMs) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_DEADLINE_EXCEEDED',
        'Execution deadline expired before the task started.',
        true,
        'timeout',
      );
    }
    if (startMs > nowMs) await delayUntil(startMs, deadlineMs);
    const eventNow = monotonicWallClock(this.now());
    const startedAt = eventNow();
    const lifecycle: {
      cleanup: ProductionCollectionExecutionReceiptV3['cleanup'] | null;
    } = { cleanup: null };
    const resources = beginResourceMeasurement();
    const network = {
      requestCount: 0,
      responseCount: 0,
      declaredResponseBytes: 0,
      responseBytesUnknownCount: 0,
    };
    const sourceTiming: {
      remoteActionStartedAt: string | null;
      firstSourceByteAt: string | null;
      sourcePayloadCompleteAt: string | null;
    } = {
      remoteActionStartedAt: null,
      firstSourceByteAt: null,
      sourcePayloadCompleteAt: null,
    };
    const authorize = authorizeRuntime ?? this.options.authorizeRuntime;
    if (authorize === undefined) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_REQUIRED',
        'Managed collection execution requires current database Runtime admission.',
        false,
        'fencing',
      );
    }
    const admission = await authorize(request, requestHash);
    if (admission.requestHash !== requestHash) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_MISMATCH',
        'Runtime admission receipt differs from the execution request.',
        false,
        'fencing',
      );
    }
    try {
      let batch: CollectionBatch | null = null;
      try {
        const operation = async (context: BrowserContext): Promise<CollectionBatch> => {
          const pages = new Set<Page>();
          const onPage = (page: Page): void => { pages.add(page); };
          const onRequest = (ownerRequest: Request): void => {
            if (!belongsToOwnedPage(ownerRequest, pages)) return;
            network.requestCount += 1;
            observeCanonicalSourceTiming(request.workKind, ownerRequest, sourceTiming, false);
          };
          const onResponse = (response: Response): void => {
            const ownerRequest = response.request();
            if (!belongsToOwnedPage(ownerRequest, pages)) return;
            observeCanonicalSourceTiming(request.workKind, ownerRequest, sourceTiming, true);
            network.responseCount += 1;
            const declaredBytes = parseDeclaredContentLength(response.headers()['content-length']);
            if (declaredBytes === null) network.responseBytesUnknownCount += 1;
            else network.declaredResponseBytes += declaredBytes;
          };
          context.on('page', onPage);
          context.on('request', onRequest);
          context.on('response', onResponse);
          try {
            batch = await (this.options.runCollection?.(context, request)
              ?? runProductionCollection(context, request, this.options.artifactDirectory));
            sourceTiming.sourcePayloadCompleteAt = notEarlierThan(
              eventNow(),
              sourceTiming.firstSourceByteAt,
            );
          } finally {
            context.off('page', onPage);
            context.off('request', onRequest);
            context.off('response', onResponse);
            const closedBeforeCleanup = [...pages].filter((page) => page.isClosed()).length;
            const remaining = [...pages].filter((page) => !page.isClosed());
            const failures: string[] = [];
            for (const page of remaining) {
              await page.close().catch((error: unknown) => {
                failures.push(error instanceof Error ? error.message : String(error));
              });
            }
            const closedPageCount = [...pages].filter((page) => page.isClosed()).length;
            lifecycle.cleanup = {
              ownedPageCount: pages.size,
              closedPageCount,
              allOwnedPagesClosed: closedPageCount === pages.size && failures.length === 0,
              detail: {
                closedBeforeCleanup,
                forcedCloseCount: remaining.length,
                closeFailureCount: failures.length,
              },
            };
          }
          if (batch === null) throw new Error('Collector returned no batch.');
          return batch;
        };
        const result = this.options.runWithContext === undefined
          ? await runOnSharedCtx(
              operation,
              { cmd: 'production-collection', args: { attemptId: request.attemptId } },
              this.options.profileName,
              { headful: true },
            )
          : await this.options.runWithContext(operation);
        batch = result;
      } catch (error) {
        if (lifecycle.cleanup !== null && !lifecycle.cleanup.allOwnedPagesClosed) {
          throw new ProductionCollectionProtocolError(
            'PAGE_CLEANUP_FAILED',
            'Owned production collection Pages could not be closed.',
            false,
            'page-cleanup',
            lifecycle.cleanup.detail,
          );
        }
        throw classifyRuntimeError(error);
      }
      if (lifecycle.cleanup === null || !lifecycle.cleanup.allOwnedPagesClosed) {
        throw new ProductionCollectionProtocolError(
          'PAGE_CLEANUP_FAILED',
          'Owned production collection Page cleanup is incomplete.',
          false,
          'page-cleanup',
          lifecycle.cleanup?.detail,
        );
      }
      if (batch === null) {
        throw new ProductionCollectionProtocolError(
          'PRODUCTION_COLLECTION_EMPTY_RESULT',
          'Collector returned no terminal batch.',
          true,
          'runtime',
        );
      }
      const serialized = `${JSON.stringify(batch)}\n`;
      const rawArtifactHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
      const artifactPath = path.join(this.batchDirectory, `${rawArtifactHash}.json`);
      await writeAtomic(artifactPath, serialized);
      const rawArchiveCommittedAt = notEarlierThan(
        eventNow(),
        sourceTiming.sourcePayloadCompleteAt,
      );
      const completedAt = notEarlierThan(eventNow(), rawArchiveCommittedAt);
      if (batch.status !== 'completed' && sourceTiming.remoteActionStartedAt === null) {
        // Preserve the collector's terminal failure instead of masking it when the
        // source rejected the operation before a canonical request was observable.
        sourceTiming.remoteActionStartedAt = startedAt;
      }
      if (
        sourceTiming.remoteActionStartedAt === null
        || sourceTiming.sourcePayloadCompleteAt === null
      ) {
        throw new ProductionCollectionProtocolError(
          'PRODUCTION_COLLECTION_SOURCE_TIMING_INCOMPLETE',
          'Canonical source action timing was not observed.',
        );
      }
      const resource = resources.finish(Buffer.byteLength(serialized, 'utf8'), network);
      const timing: ProductionCollectionSourceTimingReceiptV1 = {
        schemaVersion: 'production-collection-source-timing.v1',
        clock: 'playwright-request-and-daemon-monotonic-wall.v1',
        coverage: sourceTiming.firstSourceByteAt === null ? 'partial' : 'full',
        remoteActionStartedAt: sourceTiming.remoteActionStartedAt,
        firstSourceByteAt: sourceTiming.firstSourceByteAt,
        sourcePayloadCompleteAt: sourceTiming.sourcePayloadCompleteAt,
        rawArchiveCommittedAt,
      };
      return {
        requestHash,
        attemptId: request.attemptId,
        executionToken: request.executionToken,
        workItemId: request.workItemId,
        workKind: request.workKind,
        profileId: request.profileId,
        supervisorLeaseId: request.supervisorLeaseId,
        supervisorGeneration: request.supervisorGeneration,
        supervisorFencingToken: request.supervisorFencingToken,
        daemonInstanceId: request.daemonInstanceId,
        contextGeneration: request.contextGeneration,
        runtimeHostId: request.runtimeHostId,
        runtimeAdmissionReceiptId: admission.runtimeAdmissionReceiptId,
        startedAt,
        completedAt,
        rawArtifactRef: `production-collection-batch:sha256:${rawArtifactHash}`,
        rawArtifactHash,
        payloadSchemaVersion: 'collection-batch-v1',
        batch: structuredClone(batch) as unknown as Record<string, unknown>,
        cleanup: lifecycle.cleanup,
        resource,
        timing,
      };
    } finally {
      resources.stop();
    }
  }

  private assertProfile(request: ProductionCollectionRpcRequestV1): void {
    if (request.profileId !== this.options.profileId) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_PROFILE_MISMATCH',
        'Execution token was assigned to a different Profile.',
        false,
        'identity-mismatch',
      );
    }
  }

  private assertRuntimeAuthority(request: ProductionCollectionRpcRequestV1): void {
    if (
      request.supervisorLeaseId !== this.options.supervisorLeaseId
      || request.supervisorGeneration !== this.options.supervisorGeneration
      || request.supervisorFencingToken !== this.options.supervisorFencingToken
      || request.daemonInstanceId !== this.options.daemonInstanceId
      || request.contextGeneration !== this.options.contextGeneration
      || request.runtimeHostId !== this.options.runtimeHostId
    ) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RUNTIME_FENCE_STALE',
        'Execution authority does not match this Profile Runtime owner.',
        false,
        'fencing',
      );
    }
  }

  private assertReceiptIdentity(
    request: ProductionCollectionRpcRequestV1,
    receipt: ProductionCollectionExecutionReceiptV3,
  ): void {
    if (
      receipt.attemptId !== request.attemptId
      || receipt.executionToken !== request.executionToken
      || receipt.workItemId !== request.workItemId
      || receipt.workKind !== request.workKind
      || receipt.profileId !== request.profileId
      || receipt.supervisorLeaseId !== request.supervisorLeaseId
      || receipt.supervisorGeneration !== request.supervisorGeneration
      || receipt.supervisorFencingToken !== request.supervisorFencingToken
      || receipt.daemonInstanceId !== request.daemonInstanceId
      || receipt.contextGeneration !== request.contextGeneration
      || receipt.runtimeHostId !== request.runtimeHostId
    ) {
      throw new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RECEIPT_CONFLICT',
        'Stored receipt identity does not match the execution assignment.',
      );
    }
  }

  private async readReceipt(
    attemptId: string,
  ): Promise<ProductionCollectionExecutionReceiptV3 | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.receiptPath(attemptId), 'utf8'));
      return validateReceipt(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeReceipt(receipt: ProductionCollectionExecutionReceiptV3): Promise<void> {
    await writeAtomic(this.receiptPath(receipt.attemptId), `${JSON.stringify(receipt)}\n`);
  }

  private receiptPath(attemptId: string): string {
    return path.join(this.receiptDirectory, `${attemptId}.json`);
  }
}

function collectionUnit(request: ProductionCollectionRpcRequestV1): CollectionUnit {
  const input = request.workInput;
  const base = {
    schemaVersion: 1 as const,
    unitId: request.workItemId,
  };
  switch (request.workKind) {
    case 'search_page': {
      if (request.query === null) throw new TypeError('search query is missing');
      return {
        ...base,
        kind: 'search-page',
        subject: { keyword: request.query.keyword },
        scope: {
          requestedScope: 'page',
          cursor: encodeSearchCursor(Number(input['page'])),
          sort: request.query.sort,
          pageSize: 60,
        },
      };
    }
    case 'offer_detail':
      return {
        ...base,
        kind: 'offer-detail',
        subject: { offerId: String(input['offerId']) },
        scope: { requestedScope: 'page' },
      };
    case 'store_qualification':
      return {
        ...base,
        kind: 'store-qualification',
        subject: {
          supplier: {
            memberId: String(input['memberId']),
            shopUrl: String(input['normalizedStoreUrl']),
          },
        },
        scope: { requestedScope: 'page' },
      };
    case 'store_pages':
      return {
        ...base,
        kind: 'store-catalog',
        subject: {
          supplier: {
            memberId: String(input['memberId']),
            shopUrl: String(input['normalizedStoreUrl']),
          },
        },
        scope: {
          requestedScope: 'bounded-pages',
          pageSize: 30,
          maxPagesPerBatch: 3,
          sort: 'wangpu_score',
        },
      };
  }
}

async function runProductionCollection(
  context: BrowserContext,
  request: ProductionCollectionRpcRequestV1,
  artifactDirectory: string,
): Promise<CollectionBatch> {
  const unit = collectionUnit(request);
  if (request.workKind === 'offer_detail') {
    const startedAt = new Date().toISOString();
    const rawEvidenceRefs: string[] = [];
    try {
      const offer = await collectOfferRaw(context, {
        offerId: String(request.workInput['offerId']),
        headed: true,
        allowDomFallback: false,
        onRawComponent: async (component, payload) => {
          rawEvidenceRefs.push(await persistProductionCollectionRawEvidence(
            artifactDirectory,
            payload,
          ));
        },
      });
      return createOfferCollectionBatch({
        unit,
        outcome: { status: 'captured', value: offer },
        startedAt,
        completedAt: new Date().toISOString(),
        rawEvidenceRefs,
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
  if (request.workKind === 'store_qualification') {
    return runProductionQualification(context, request, unit, artifactDirectory);
  }
  if (request.workKind === 'store_pages') {
    return runProductionStorePages(context, request, unit, artifactDirectory);
  }
  if (request.query === null) throw new TypeError('search query is missing');
  const startedAt = new Date().toISOString();
  const page = Number(request.workInput['page']);
  const result = await fetchIncrementalSearchPage(context, {
    keyword: request.query.keyword,
    page,
    sort: request.query.sort === 'sales' ? 'best-selling' : request.query.sort,
    headed: true,
    remoteFilterParams: request.query.filters as Record<string, string>,
  });
  const rawEvidenceRef = await persistProductionCollectionRawEvidence(
    artifactDirectory,
    result.rawResponseText,
  );
  return createSearchPageBatch({
    unit,
    batchId: randomUUID(),
    page,
    remoteSort: result.remoteSort,
    offers: result.offers,
    hasMore: result.hasMore,
    startedAt,
    collectedAt: result.collectedAt,
    completedAt: new Date().toISOString(),
    rawEvidenceRefs: [rawEvidenceRef],
  });
}

async function runProductionQualification(
  context: BrowserContext,
  request: ProductionCollectionRpcRequestV1,
  unit: CollectionUnit,
  artifactDirectory: string,
): Promise<CollectionBatch> {
  const startedAt = new Date().toISOString();
  const memberId = String(request.workInput['memberId']);
  const storeUrl = String(request.workInput['normalizedStoreUrl']);
  const page = await context.newPage();
  const rawEvidenceRefs: string[] = [];
  try {
    await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForCollectionPageAvailability(page, { headed: true });
    const captured = await captureSupplierQualificationForAction(
      page,
      {
        memberId,
        timeoutMs: 15_000,
        onRawResponse: async (payload) => {
          rawEvidenceRefs.push(await persistProductionCollectionRawEvidence(
            artifactDirectory,
            payload,
          ));
        },
        onRiskChallenge: async (challengeUrl) => {
          await page.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await waitForCollectionPageAvailability(page, { headed: true });
        },
      },
      () => requestSupplierQualificationFromPage(page, memberId),
    );
    const qualification = requireSupplierQualificationResponse(captured);
    const completedAt = new Date().toISOString();
    return createQualificationBatch({
      unit,
      batchId: randomUUID(),
      sourceRequestId: request.attemptId,
      qualification,
      requestMemberId: memberId,
      startedAt,
      completedAt,
      sourceRef: rawEvidenceRefs[0],
      rawEvidenceRefs,
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function runProductionStorePages(
  context: BrowserContext,
  request: ProductionCollectionRpcRequestV1,
  unit: CollectionUnit,
  artifactDirectory: string,
): Promise<CollectionBatch> {
  const startedAt = new Date().toISOString();
  const memberId = String(request.workInput['memberId']);
  const storeUrl = String(request.workInput['normalizedStoreUrl']);
  const page = await context.newPage();
  const rawEvidenceRefs: string[] = [];
  try {
    const result = await collectBoundedStoreSampleV1({
      memberId,
      canonicalShopUrl: storeUrl,
      mode: 'phase-1-bounded',
      firstPage: 1,
      lastPageInclusive: 3,
      generation: request.attemptId,
      baselineExpiresAt: new Date(
        new Date(startedAt).getTime() + request.freshnessSeconds * 1_000,
      ).toISOString(),
      collectProfileObservation: async () => {
        const navigationUrl = buildStoreCatalogUrl(storeUrl, { sort: 'wangpu_score' });
        await page.goto(navigationUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await waitForCollectionPageAvailability(page, { headed: true });
        await waitForStoreCatalogRuntime(page, { timeoutMs: 15_000 });
        const captured = await captureStoreProfileForAction(
          page,
          { memberId, timeoutMs: 15_000 },
          () => requestStoreProfileFromPage(page, memberId, {
            runtimeReadyTimeoutMs: 15_000,
            requestTimeoutMs: 15_000,
          }),
        );
        if (captured.captured === null) {
          throw new CliError(
            9,
            'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
            'Store page 1 did not expose its canonical header profile.',
            { category: 'protocol', retryable: false, recoveryAction: 'refresh-store-header-parser' },
          );
        }
        const rawRef = await persistProductionCollectionRawEvidence(
          artifactDirectory,
          captured.captured.payload,
        );
        rawEvidenceRefs.push(rawRef);
        assertStoreProfilePayloadState(captured.captured.payload, captured.diagnostics);
        const profile = mapStoreProfilePayload(
          captured.captured.payload,
          captured.captured.collectedAt,
          { sourceRef: captured.captured.sourceRef, rawRef },
        );
        const memberAuthority = parseStoreProfileMemberAuthorityV1(
          captured.captured.payload,
          profile.source,
        );
        const observation: StoreSampleProfileObservationV1 = {
          ...memberAuthority,
          canonicalShopUrl: storeUrl,
          observedAt: captured.captured.collectedAt,
          profile,
        };
        assertStoreSampleProfileObservationV1(observation, memberId, storeUrl);
        return observation;
      },
      collectPage: async (logicalPage) => {
        const rawPayload = await requestStoreCatalogFromPage(page, {
          memberId,
          pageNum: logicalPage,
          count: 30,
          sortType: 'wangpu_score',
        }, { timeoutMs: 15_000 });
        rawEvidenceRefs.push(await persistProductionCollectionRawEvidence(
          artifactDirectory,
          rawPayload,
        ));
        return parseStoreCatalogModule(rawPayload, {
          memberId,
          pageNum: logicalPage,
          pageSize: 30,
          sortType: 'wangpu_score',
        });
      },
      afterPageCommitted: async (logicalPage) => {
        if (logicalPage < 3) await sleep(3_000 + Math.floor(Math.random() * 7_001));
      },
    }).catch((error: unknown) => {
      if (
        error instanceof CliError
        && error.code === 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE'
      ) {
        throw new CliError(9, error.code, error.message, {
          ...error.details,
          category: 'store-profile-runtime',
          retryable: true,
          recoveryAction: 'retry-store-sample-generation',
        });
      }
      throw error;
    });
    const observations = result.pages.flatMap(({ page: logicalPage, parsed }) =>
      parsed.offers.map((offer) => ({ ...offer, page: logicalPage })),
    );
    const completedAt = new Date().toISOString();
    return normalizeCollectionBatch({
      schemaVersion: 1,
      batchId: randomUUID(),
      sourceRequestId: request.attemptId,
      unitId: unit.unitId,
      kind: 'store-catalog',
      status: result.status,
      startedAt,
      completedAt,
      subject: { ...unit.subject },
      scope: {
        ...(unit.scope ?? {}),
        observedPages: result.cursor.observedPages,
        sourceOfferCount: result.cursor.sourceOfferCount,
        sourceTotalPages: result.cursor.sourceTotalPages,
        sourceEnded: result.cursor.exhausted,
        categories: result.categories,
        profile: result.profileObservation,
      },
      observations,
      completeness: {
        requestedScope: 'bounded-pages',
        state: result.status === 'completed' ? 'complete' : 'truncated',
        observedPages: result.cursor.observedPages,
        failedPages: result.failedPages,
        ...(result.cursor.sourceOfferCount === null
          ? {}
          : { expectedItems: result.cursor.sourceOfferCount }),
        uniqueItems: result.uniqueOffers.length,
      },
      duplicateObservations: [],
      warnings: [],
      errors: result.errorCode === null
        ? []
        : [{
            code: result.errorCode,
            message: 'Store pages stopped before the frozen 1-3 scope completed.',
            retryable: true,
          }],
      rawEvidenceRefs,
      metrics: {
        remoteRequests: result.remoteRequests,
        storePages: result.cursor.observedPages.length,
        storeOffers: result.uniqueOffers.length,
        storeCategories: result.categories.length,
      },
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function persistProductionCollectionRawEvidence(
  artifactDirectory: string,
  payload: unknown,
): Promise<string> {
  const serialized = typeof payload === 'string'
    ? payload
    : `${JSON.stringify(payload)}\n`;
  const hash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  const filePath = path.join(
    artifactDirectory,
    'production-collection-raw',
    `${hash}.json`,
  );
  try {
    await fs.access(filePath);
  } catch {
    await writeAtomic(filePath, serialized);
  }
  return `artifact:production-collection-raw-${hash}`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function validateReceipt(value: unknown): ProductionCollectionExecutionReceiptV3 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionCollectionProtocolError(
      'PRODUCTION_COLLECTION_RECEIPT_CORRUPT',
      'Stored receipt is not an object.',
    );
  }
  const receipt = value as ProductionCollectionExecutionReceiptV3;
  if (
    typeof receipt.requestHash !== 'string'
    || typeof receipt.attemptId !== 'string'
    || typeof receipt.executionToken !== 'string'
    || typeof receipt.workItemId !== 'string'
    || typeof receipt.profileId !== 'string'
    || typeof receipt.supervisorLeaseId !== 'string'
    || !isPositiveSafeInteger(receipt.supervisorGeneration)
    || typeof receipt.supervisorFencingToken !== 'string'
    || !/^[1-9][0-9]*$/u.test(receipt.supervisorFencingToken)
    || typeof receipt.daemonInstanceId !== 'string'
    || !isPositiveSafeInteger(receipt.contextGeneration)
    || typeof receipt.runtimeHostId !== 'string'
    || typeof receipt.runtimeAdmissionReceiptId !== 'string'
    || receipt.payloadSchemaVersion !== 'collection-batch-v1'
    || receipt.cleanup?.allOwnedPagesClosed !== true
    || !isValidResourceReceipt(receipt.resource)
    || !isValidSourceTimingReceipt(receipt.timing, receipt.completedAt)
  ) {
    throw new ProductionCollectionProtocolError(
      'PRODUCTION_COLLECTION_RECEIPT_CORRUPT',
      'Stored receipt is incomplete or lacks proven Page cleanup.',
    );
  }
  return receipt;
}

function isValidSourceTimingReceipt(
  value: unknown,
  completedAt: string,
): value is ProductionCollectionSourceTimingReceiptV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const timing = value as Record<string, unknown>;
  if (
    timing['schemaVersion'] !== 'production-collection-source-timing.v1'
    || timing['clock'] !== 'playwright-request-and-daemon-monotonic-wall.v1'
    || !['full', 'partial'].includes(String(timing['coverage']))
  ) return false;
  const remote = instantMs(timing['remoteActionStartedAt']);
  const firstByte = timing['firstSourceByteAt'] === null
    ? null
    : instantMs(timing['firstSourceByteAt']);
  const payloadComplete = instantMs(timing['sourcePayloadCompleteAt']);
  const archiveCommitted = instantMs(timing['rawArchiveCommittedAt']);
  const completed = instantMs(completedAt);
  if ([remote, payloadComplete, archiveCommitted, completed].some((item) => item === null)) {
    return false;
  }
  if (timing['coverage'] === 'full' && firstByte === null) return false;
  if (timing['coverage'] === 'partial' && firstByte !== null) return false;
  return remote! <= (firstByte ?? payloadComplete!)
    && (firstByte ?? remote!) <= payloadComplete!
    && payloadComplete! <= archiveCommitted!
    && archiveCommitted! <= completed!;
}

function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function monotonicWallClock(anchor: Date): () => string {
  const anchorMs = anchor.getTime();
  const anchorHr = process.hrtime.bigint();
  return () => new Date(
    anchorMs + Number((process.hrtime.bigint() - anchorHr) / 1_000_000n),
  ).toISOString();
}

function isValidResourceReceipt(value: unknown): value is ProductionCollectionResourceReceiptV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  if (
    resource['schemaVersion'] !== 'production-collection-resource.v1'
    || resource['measurementScope'] !== 'daemon-process-delta-and-owned-page-network'
  ) return false;
  const nonNegativeFields = [
    'wallTimeMs', 'cpuUserMicros', 'cpuSystemMicros', 'rssStartBytes',
    'rssEndBytes', 'rssPeakObservedBytes', 'fsReadOps', 'fsWriteOps',
    'networkRequestCount', 'networkResponseCount', 'networkDeclaredResponseBytes',
    'networkResponseBytesUnknownCount', 'artifactBytes',
  ];
  if (nonNegativeFields.some((field) => !isNonNegativeSafeInteger(resource[field]))) return false;
  return isPositiveSafeInteger(resource['rssSamplingIntervalMs'])
    && isPositiveSafeInteger(resource['rssSampleCount']);
}

function beginResourceMeasurement(): Readonly<{
  stop: () => void;
  finish: (
    artifactBytes: number,
    network: Readonly<{
      requestCount: number;
      responseCount: number;
      declaredResponseBytes: number;
      responseBytesUnknownCount: number;
    }>,
  ) => ProductionCollectionResourceReceiptV1;
}> {
  const rssSamplingIntervalMs = 250;
  const startedHrtime = process.hrtime.bigint();
  const startedCpu = process.cpuUsage();
  const startedUsage = process.resourceUsage();
  const rssStartBytes = process.memoryUsage().rss;
  let rssPeakObservedBytes = rssStartBytes;
  let rssSampleCount = 1;
  let stopped = false;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    rssPeakObservedBytes = Math.max(rssPeakObservedBytes, rss);
    rssSampleCount += 1;
  };
  const timer = setInterval(sampleRss, rssSamplingIntervalMs);
  timer.unref();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    sampleRss();
  };
  return Object.freeze({
    stop,
    finish: (artifactBytes, network) => {
      stop();
      const completedCpu = process.cpuUsage(startedCpu);
      const completedUsage = process.resourceUsage();
      const rssEndBytes = process.memoryUsage().rss;
      rssPeakObservedBytes = Math.max(rssPeakObservedBytes, rssEndBytes);
      return Object.freeze({
        schemaVersion: 'production-collection-resource.v1',
        measurementScope: 'daemon-process-delta-and-owned-page-network',
        wallTimeMs: metric(Number(process.hrtime.bigint() - startedHrtime) / 1_000_000),
        cpuUserMicros: metric(completedCpu.user),
        cpuSystemMicros: metric(completedCpu.system),
        rssStartBytes: metric(rssStartBytes),
        rssEndBytes: metric(rssEndBytes),
        rssPeakObservedBytes: metric(rssPeakObservedBytes),
        rssSamplingIntervalMs,
        rssSampleCount: metric(rssSampleCount),
        fsReadOps: metric(completedUsage.fsRead - startedUsage.fsRead),
        fsWriteOps: metric(completedUsage.fsWrite - startedUsage.fsWrite),
        networkRequestCount: metric(network.requestCount),
        networkResponseCount: metric(network.responseCount),
        networkDeclaredResponseBytes: metric(network.declaredResponseBytes),
        networkResponseBytesUnknownCount: metric(network.responseBytesUnknownCount),
        artifactBytes: metric(artifactBytes),
      });
    },
  });
}

function belongsToOwnedPage(request: Request, pages: ReadonlySet<Page>): boolean {
  try {
    return pages.has(request.frame().page());
  } catch {
    return false;
  }
}

function observeCanonicalSourceTiming(
  workKind: ProductionCollectionRpcRequestV1['workKind'],
  request: Request,
  timing: {
    remoteActionStartedAt: string | null;
    firstSourceByteAt: string | null;
  },
  includeFirstByte: boolean,
): void {
  if (!isCanonicalSourceRequest(workKind, request)) return;
  const nativeTiming = request.timing();
  if (!Number.isFinite(nativeTiming.startTime) || nativeTiming.startTime <= 0) return;
  timing.remoteActionStartedAt = earlierInstant(
    timing.remoteActionStartedAt,
    nativeTiming.startTime,
  );
  if (
    includeFirstByte
    && Number.isFinite(nativeTiming.responseStart)
    && nativeTiming.responseStart >= 0
  ) {
    timing.firstSourceByteAt = earlierInstant(
      timing.firstSourceByteAt,
      nativeTiming.startTime + nativeTiming.responseStart,
    );
  }
}

function isCanonicalSourceRequest(
  workKind: ProductionCollectionRpcRequestV1['workKind'],
  request: Request,
): boolean {
  if (workKind === 'search_page') {
    return readSearchMtopRequestMeta(request.url()) !== null;
  }
  if (workKind === 'store_qualification' || workKind === 'store_pages') {
    const meta = readAlisiteModuleRequestMeta(request.url(), request.postData());
    if (meta === null) return false;
    if (workKind === 'store_qualification') {
      return meta.componentKey === SUPPLIER_QUALIFICATION_COMPONENT_KEY;
    }
    return meta.componentKey === STORE_CATALOG_COMPONENT_KEY
      || meta.componentKey?.toLowerCase() === STORE_PROFILE_COMPONENT_KEY.toLowerCase();
  }
  try {
    const url = new URL(request.url());
    return url.hostname === 'detail.1688.com'
      || url.hostname === 'itemcdn.tmall.com'
      || url.hostname === 'h5api.m.1688.com'
      || url.hostname === 'mtop.1688.com';
  } catch {
    return false;
  }
}

function earlierInstant(current: string | null, candidateMs: number): string {
  if (current === null || candidateMs < Date.parse(current)) {
    return new Date(candidateMs).toISOString();
  }
  return current;
}

function notEarlierThan(observed: string, lowerBound: string | null): string {
  if (lowerBound !== null && Date.parse(observed) < Date.parse(lowerBound)) return lowerBound;
  return observed;
}

function parseDeclaredContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function metric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function classifyRuntimeError(error: unknown): ProductionCollectionProtocolError {
  if (error instanceof ProductionCollectionProtocolError) return error;
  if (error instanceof CliError) {
    const category = error.code === 'NOT_LOGGED_IN'
      ? 'authentication'
      : error.code === 'RISK_CONTROL'
        ? 'risk-control'
        : typeof error.details.category === 'string'
          ? error.details.category
          : 'runtime';
    const retryable = typeof error.details.retryable === 'boolean'
      ? error.details.retryable
      : category !== 'authentication' && category !== 'risk-control';
    return new ProductionCollectionProtocolError(
      error.code,
      error.message,
      retryable,
      category,
      error.details,
    );
  }
  return new ProductionCollectionProtocolError(
    'PRODUCTION_COLLECTION_EXECUTION_FAILED',
    error instanceof Error ? error.message : 'Production collection failed.',
    true,
    'runtime',
  );
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function delayUntil(startMs: number, deadlineMs: number): Promise<void> {
  const delayMs = startMs - Date.now();
  if (delayMs <= 0) return;
  if (startMs >= deadlineMs) {
    throw new ProductionCollectionProtocolError(
      'PRODUCTION_COLLECTION_DEADLINE_EXCEEDED',
      'Pacing delay exceeds the execution deadline.',
      true,
      'timeout',
    );
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
