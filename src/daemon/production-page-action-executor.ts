import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  canonicalCollectorSha256V1,
  computeExecutionLineageHashV1,
  computeExecutionAttemptReceiptHashV1,
  computeLogicalLineageHashV1,
  normalizeExecutionLineageV1,
  normalizeLogicalLineageV1,
  normalizePredecessorExecutionAttemptReceiptV1,
  normalizePageActionExecuteResponseV1,
  type CollectorErrorV1,
  type PageActionExecuteResponseV1,
  type PageActionRequestV1,
  type RemoteRequestAttemptReceiptV1,
  type SanitizedRemoteRequestSnapshotV1,
} from '../collection/page-action-contracts.js';
import {
  executeCollectorPageActionV1,
  type CollectorActionRunV1,
  type CollectorPageActionBatchEvidenceV1,
  type CollectorPageActionExecutorPortsV1,
  type TrustedCanonicalShopIdentityV1,
} from '../collection/page-action-executor.js';
import { createSearchPageBatch, encodeSearchCursor } from '../collection/search-batch.js';
import {
  createOfferPageActionBatchesV1,
  createOfferSkuManifestV1,
} from '../collection/offer-batch.js';
import { createQualificationBatch } from '../collection/qualification-batch.js';
import { createBoundedStoreSampleBatchesV1 } from '../collection/catalog-batch.js';
import { normalizeCollectionBatch, type CollectionBatch } from '../collection/contracts.js';
import {
  executeRaw as collectOfferOnPage,
  readOfferSourceCaptureEvidenceV1,
} from '../commands/offer.js';
import { buildStoreCatalogUrl } from '../commands/supplier-catalog.js';
import {
  buildOfferMediaManifestV2,
} from '../session/offer-media.js';
import {
  assertOfferSourceSidecarBindingV1,
  createOfferSourceSidecarV1,
  createOfferSourceTerminalReceiptV1,
  type OfferSourceSidecarV1,
} from '../session/offer-evidence.js';
import {
  buildQualificationMediaManifestV1,
  buildSupplierQualificationPageUrl,
  captureSupplierQualificationForAction,
  requestSupplierQualificationFromPage,
  requireSupplierQualificationResponse,
} from '../session/qualification-capture.js';
import { waitForCollectionPageAvailability } from '../session/recovery.js';
import {
  collectBoundedStoreSampleV1,
  assertStoreSampleProfileObservationV1,
  parseStoreProfileMemberAuthorityV1,
  requestStoreCatalogFromPage,
  waitForStoreCatalogRuntime,
  type StoreSampleCursorV1,
  type StoreSampleProfileObservationV1,
  type StoreSampleRuntimeResultV1,
} from '../session/catalog-runtime.js';
import {
  parseStoreCatalogModule,
  STORE_CATALOG_PARSER_VERSION,
} from '../session/alisite-module.js';
import {
  mapStoreProfilePayload,
  STORE_PROFILE_PARSER_VERSION,
} from '../session/store-profile.js';
import {
  assertStoreProfilePayloadState,
  captureStoreProfileForAction,
} from '../session/store-profile-capture.js';
import {
  createSearchTerminalReceiptV1,
  runCompiledSearchActionV1,
  type SearchPageAttemptBindingV1,
  type SearchRuntimeResultV1,
} from '../session/search-runtime.js';
import {
  startSearchPageCaptureV1,
  type SearchPageCaptureV1,
} from '../session/search-capture.js';
import {
  compileSearchParameterSetV1,
  verifyParameterSetHash,
  type CanonicalSearchParameterSetV1,
  type CompiledSearchPageRequestV1,
} from '../session/search-compiler.js';
import {
  resolveSearchIntentV1,
  type SearchFilterConfigSnapshotV1,
  type SearchIntentV1,
  type SearchSerializerCapabilitySnapshotV1,
} from '../session/search-contract.js';
import {
  createCollectorRawArchiveV1,
  persistCollectorRawArchiveV1,
  type CollectorRawArchiveKindV1,
} from '../session/collector-raw-archive.js';
import type {
  PageActionExecutionScope,
  PageActionExecutor,
} from './supervisor-runtime.js';
import type {
  RemoteAttemptAdmissionReceiptV2,
  RemoteAttemptAdmissionRequestV2,
} from './supervisor-rpc.js';
import { CliError } from '../io/errors.js';

export interface ProductionPageActionExecutorOptions {
  artifactDirectory: string;
  storeSampleFreshnessMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  pace?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  collectOfferOnPage?: typeof collectOfferOnPage;
}

interface SearchParameterSourceArtifactV1 {
  schema: 'collector.search-parameter-source.v1';
  intent: SearchIntentV1;
  filterSnapshot: SearchFilterConfigSnapshotV1;
  capabilitySnapshot: SearchSerializerCapabilitySnapshotV1;
}

/** Exact page authority shared by the signed draft and the daemon runtime. */
export function resolveSearchActionStartPageV1(request: PageActionRequestV1): number {
  if (request.action.kind !== 'search-list') {
    throw new TypeError('Search page authority requires a search-list PageAction.');
  }
  if (request.action.request.page === 1) return 1;
  if (request.action.recoveryHandle?.recoveryMode === 'safe-replay') {
    return request.action.recoveryHandle.allowedNextPage;
  }
  throw new CliError(
    9,
    'SEARCH_DIRECT_BEGIN_PAGE_PARITY_NOT_VERIFIED',
    'A page greater than 1 requires a signed safe-replay recovery handle until direct beginPage parity is enabled.',
    {
      category: 'contract',
      retryable: false,
      recoveryAction: 'use-page-one-or-safe-replay',
    },
  );
}

/** Offer core identity is authoritative and must agree with the signed target. */
export function assertOfferCoreMemberIdentityV1(
  offer: Readonly<{ supplier: Readonly<{ memberId: string | null }> }>,
  expectedMemberId: string,
): void {
  if (offer.supplier.memberId !== expectedMemberId) {
    throw new CliError(
      9,
      'OFFER_CORE_MEMBER_MISMATCH',
      'Offer core supplier identity differs from the signed PageAction member.',
      {
        category: 'protocol',
        retryable: false,
        recoveryAction: 'reject-cross-member-offer-evidence',
      },
    );
  }
}

export interface SearchRecoveryArchivePageV1 {
  logicalPage: number;
  responseBusinessHash: string;
  eligibleCandidateIdsHash: string;
  observationUniverseHash: string;
  batchContentHash: string;
  pageActionId: string;
  pageActionBusinessHash: string;
  searchSegmentId: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  requestId: string;
  logicalLineageHash: string;
  executionLineageHash: string;
  predecessorExecutionAttemptReceipt?: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
  batch: CollectionBatch;
}

export interface SearchRecoveryArchiveV1 {
  schema: 'collector.search-recovery-archive.v1';
  recoveryReceiptId: string;
  recoveryReceiptHash: string;
  searchQueryKeyHash: string;
  querySnapshotHash: string;
  checkpointPage: number;
  completedSearchSegmentIds: string[];
  completedPageActionIds: string[];
  predecessorExecutionAttemptReceipt: { receiptId: string; receiptHash: string };
  pages: SearchRecoveryArchivePageV1[];
}

/** Production bridge from the fenced daemon Page to the exact four Collector runners. */
export class ProductionPageActionExecutor implements PageActionExecutor {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly pace: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly storeSampleFreshnessMs: number;
  private readonly collectOfferOnPage: typeof collectOfferOnPage;

  constructor(private readonly options: ProductionPageActionExecutorOptions) {
    if (!path.isAbsolute(options.artifactDirectory)) {
      throw new TypeError('Collector artifact directory must be absolute.');
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.pace = options.pace ?? abortableDelay;
    this.random = options.random ?? Math.random;
    this.collectOfferOnPage = options.collectOfferOnPage ?? collectOfferOnPage;
    this.storeSampleFreshnessMs = options.storeSampleFreshnessMs ?? 24 * 60 * 60_000;
  }

  async execute(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
  ) {
    const remoteLedger = new RemoteAttemptLedgerV1(request, scope, this.now);
    let response: PageActionExecuteResponseV1;
    try {
      response = await executeCollectorPageActionV1({
        request,
        ports: this.ports(request, remoteLedger.scope(), remoteLedger),
        signal: scope.signal,
      });
    } catch (error) {
      response = failedExecutionResponse(
        request,
        error,
        this.now(),
        this.idFactory(),
        remoteLedger.fallbackEvidence(this.now()),
      );
    }
    await scope.closeOwnedPage('collector_terminal');
    return response;
  }

  private ports(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
    remoteLedger: RemoteAttemptLedgerV1,
  ): CollectorPageActionExecutorPortsV1 {
    return {
      now: this.now,
      createId: (kind) => `${kind}-${this.idFactory()}`,
      resolveCanonicalSearchParameterSet: (artifactRef) =>
        this.resolveSearchParameterSet(artifactRef),
      runSearch: ({ parameterSet, signal }) =>
        this.runSearch(request, scope, remoteLedger, parameterSet, signal),
      runOffer: ({ offerId, memberId, signal }) =>
        this.runOffer(request, scope, remoteLedger, offerId, memberId, signal),
      runQualification: ({ memberId, signal }) =>
        this.runQualification(request, scope, remoteLedger, memberId, signal),
      runStoreSample: ({ identity, signal }) =>
        this.runStoreSample(request, scope, remoteLedger, identity, signal),
    };
  }

  private async runSearch(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
    remoteLedger: RemoteAttemptLedgerV1,
    parameterSet: CanonicalSearchParameterSetV1,
    signal?: AbortSignal,
  ): Promise<CollectorActionRunV1> {
    if (request.action.kind !== 'search-list') throw new TypeError('Search action mismatch.');
    const searchAction = request.action;
    const recovery = searchAction.recoveryHandle;
    if (recovery?.recoveryMode === 'direct-begin-page') {
      throw new CliError(
        9,
        'SEARCH_DIRECT_BEGIN_PAGE_PARITY_NOT_VERIFIED',
        'Direct beginPage recovery cannot run before the versioned live parity capability is enabled.',
        {
          category: 'contract',
          retryable: false,
          recoveryAction: 'use-safe-replay-or-renew-capability',
        },
      );
    }
    const startedAt = this.now().toISOString();
    const recoveryArchive = recovery?.recoveryMode === 'safe-replay'
      ? await this.resolveSearchRecoveryArchive(request, recovery.encryptedNavigationArchiveRef)
      : undefined;
    let supplied = false;
    const committedBatches: CollectionBatch[] = [];
    if (recoveryArchive) {
      remoteLedger.recordBatches(
        recoveryArchive.pages.map((page) => structuredClone(page.batch)),
      );
    }
    const batchIds = new Map<number, string>();
    const evidenceRefsByAttempt = new Map<number, string[]>();
    const selectedCandidateIds = new Set<string>();
    recoveryArchive?.pages.forEach((page) => {
      verifiedSearchBatchCutV1(
        page.batch,
        parameterSet.advertisementPolicy,
        false,
      ).eligibleCandidateIds.forEach((offerId) => selectedCandidateIds.add(offerId));
    });
    if (selectedCandidateIds.size > parameterSet.maxOffers) {
      throw new CliError(
        9,
        'SEARCH_RECOVERY_ARCHIVE_INVALID',
        'Search recovery archive exceeds the frozen maxOffers universe.',
        { category: 'contract', retryable: false, recoveryAction: 'rebuild-recovery-receipt' },
      );
    }
    const selectionStatesByObservation = new Map<
      string,
      'selected' | 'promoted-excluded' | 'offer-limit-overflow'
    >();
    const selectionStates = (
      capture: SearchRuntimeResultV1['pages'][number],
    ) => capture.page.offers.map((offer, index) => {
      const key = `${capture.page.responseBusinessHash}:${index}`;
      const existing = selectionStatesByObservation.get(key);
      if (existing !== undefined) return existing;
      let state: 'selected' | 'promoted-excluded' | 'offer-limit-overflow';
      if (parameterSet.advertisementPolicy === 'exclude-p4p' && offer.isP4P) {
        state = 'promoted-excluded';
      } else if (
        selectedCandidateIds.has(offer.offerId)
        || selectedCandidateIds.size < parameterSet.maxOffers
      ) {
        selectedCandidateIds.add(offer.offerId);
        state = 'selected';
      } else {
        state = 'offer-limit-overflow';
      }
      selectionStatesByObservation.set(key, state);
      return state;
    });
    const buildSearchBatch = (
      capture: SearchRuntimeResultV1['pages'][number],
      binding: SearchPageAttemptBindingV1,
      completedAt: string,
    ) => {
      const states = selectionStates(capture);
      const baseBatch = normalizeCollectionBatch({ ...createSearchPageBatch({
      unit: {
        schemaVersion: 1,
        unitId: `${request.logicalLineage.workUnitId}:search:${capture.compiledRequest.page}`,
        collectionTaskId: request.logicalLineage.collectionTaskId,
        kind: 'search-page',
        subject: { keyword: parameterSet.keyword },
        scope: {
          requestedScope: 'page',
          cursor: encodeSearchCursor(capture.compiledRequest.page),
          sort: parameterSet.sort,
          pageSize: parameterSet.pageSize,
        },
      },
      batchId: batchIds.get(binding.attemptOrdinal) ?? (() => {
        const batchId = `batch-${this.idFactory()}`;
        batchIds.set(binding.attemptOrdinal, batchId);
        return batchId;
      })(),
      page: capture.compiledRequest.page,
      remoteSort: parameterSet.sortType,
      offers: capture.page.offers,
      rawItems: capture.page.rawItems,
      hasMore: capture.page.hasMore,
      startedAt,
      collectedAt: capture.observedAt,
      completedAt,
      rawEvidenceRefs: [
        ...(evidenceRefsByAttempt.get(binding.attemptOrdinal)
          ?? [opaqueEvidence('search', capture.page.responseBusinessHash)]),
      ],
      requestSnapshot: {
        parameterSetHash: parameterSet.parameterSetHash,
        requestBusinessHash: capture.compiledRequest.requestBusinessHash,
        pageSessionHash: capture.compiledRequest.pageSessionHash,
        filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
        serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
        businessSort: parameterSet.sort,
        remoteSortType: parameterSet.sortType,
        remoteDescendOrder: parameterSet.descendOrder,
        filterParams: capture.sanitizedRequest.filterParams,
      },
      }), sourceRequestId: request.requestId });
      const batch = normalizeCollectionBatch({
        ...baseBatch,
        observations: baseBatch.observations.map((observation) => ({
          ...observation,
          candidateSelectionState:
            states[Number(observation['pageRank']) - 1],
        })),
      });
      return bindSearchBatchRecoveryCutV1({
      batch,
      logicalPage: capture.compiledRequest.page,
      responseBusinessHash: capture.page.responseBusinessHash,
      advertisementPolicy: parameterSet.advertisementPolicy,
      searchSegmentId: searchAction.request.searchSegmentId,
      pageActionId: request.pageActionId,
      pageActionBusinessHash: request.pageActionBusinessHash,
      pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
      executionAttemptOrdinal: request.executionAttemptOrdinal,
      requestId: request.requestId,
      logicalLineageHash: request.logicalLineageHash,
      executionLineageHash: request.executionLineageHash,
      ...(request.predecessorExecutionAttemptReceipt === undefined
        ? {}
        : {
            predecessorExecutionAttemptReceipt:
              request.predecessorExecutionAttemptReceipt,
          }),
      });
    };
    const runtime = await runCompiledSearchActionV1({
      parameterSet,
      startPage: resolveSearchActionStartPageV1(request),
      ...(recovery?.recoveryMode === 'safe-replay'
        ? { replayThroughPage: recovery.checkpointPage }
        : {}),
      forwardPageBudget: request.action.request.forwardPageBudget,
      replayPageBudget: request.action.request.replayPageBudget,
      signal,
      port: {
        createPage: async () => {
          if (supplied) throw new Error('Search runner attempted to create a second Page.');
          supplied = true;
          return scope.page as Page;
        },
        pageSessionId: async () => scope.pageSessionId,
        fetchPage: async ({ page, compiledRequest, ordinal, purpose }) => {
          const rawEvidenceRefs: string[] = [];
          try {
            const capture = await navigateCompiledSearchPageV1({
              page,
              compiledRequest,
              admitRemoteAttempt: async () => {
                const receipt = await scope.admitRemoteAttempt({
                  remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
                  ordinal,
                  logicalPage: compiledRequest.page,
                  purpose,
                  requestBusinessHash: compiledRequest.requestBusinessHash,
                });
                remoteLedger.confirmAdmission(ordinal, receipt);
              },
              assertCheckpointAuthorized: scope.assertAuthorized,
              onRawResponse: async (rawResponseText) => {
                const evidenceRef = await this.persistRawArchive({
                  kind: 'search-response',
                  parserRevision: 'search-response-v1@1',
                  request,
                  ordinal,
                  requestBusinessHash: compiledRequest.requestBusinessHash,
                  payload: rawResponseText,
                });
                rawEvidenceRefs.push(evidenceRef);
                evidenceRefsByAttempt.set(ordinal, [...rawEvidenceRefs]);
              },
            });
            return capture;
          } catch (error) {
            remoteLedger.recordFailure(
              ordinal,
              error,
              this.now().toISOString(),
              rawEvidenceRefs,
            );
            throw error;
          }
        },
        closePage: async () => {},
        onPageCommitted: async ({ capture, binding }) => {
          const rawEvidenceRefs = evidenceRefsByAttempt.get(binding.attemptOrdinal) ?? [];
          try {
            if (binding.purpose === 'replay') {
              assertReplayCaptureMatchesArchiveV1(capture, recoveryArchive, parameterSet);
            } else {
              committedBatches.push(buildSearchBatch(capture, binding, this.now().toISOString()));
              remoteLedger.recordBatches([
                ...(recoveryArchive?.pages.map((page) => structuredClone(page.batch)) ?? []),
                ...committedBatches,
              ]);
            }
            remoteLedger.recordSuccess(binding.attemptOrdinal, capture.observedAt, rawEvidenceRefs);
          } catch (error) {
            remoteLedger.recordFailure(
              binding.attemptOrdinal,
              error,
              this.now().toISOString(),
              rawEvidenceRefs,
            );
            throw error;
          }
        },
        pace: this.pace,
        randomDelayMs: () => sampleDelay(this.random, 3_000, 10_000),
      },
    });
    for (const attempt of runtime.attempts) {
      if (attempt.errorCode !== 'SEARCH_PAGINATION_NO_PROGRESS') continue;
      remoteLedger.recordFailure(
        attempt.ordinal,
        searchPaginationNoProgressErrorV1(),
        this.now().toISOString(),
        evidenceRefsByAttempt.get(attempt.ordinal) ?? [],
      );
    }
    const completedAt = terminalTime(startedAt, this.now().toISOString());
    const currentBatches = runtime.pages.flatMap((capture, index) => {
      const binding = runtime.pageAttemptBindings[index];
      return binding?.purpose === 'forward'
        ? [buildSearchBatch(capture, binding, completedAt)]
        : [];
    });
    const batches = [
      ...(recoveryArchive?.pages.map((page) => structuredClone(page.batch)) ?? []),
      ...currentBatches,
    ];
    const attempts = remoteLedger.fallbackEvidence(this.now()).attempts;
    const terminalCollectorError = runtime.errorCode === null
      ? undefined
      : [...attempts].reverse().find((attempt) => attempt.error !== undefined)?.error
        ?? collectorError(runtime.errorCode);
    const snapshots = bindSearchRequestSnapshotsV1({
      request,
      parameterSet,
      runtime,
      attempts,
    });
    remoteLedger.replaceTerminalEvidence(attempts, snapshots);
    remoteLedger.recordBatches(batches);
    const terminalObservations = batches.flatMap((batch) =>
      verifiedSearchBatchCutV1(
        batch,
        parameterSet.advertisementPolicy,
        false,
      ).eligibleObservations
    );
    const searchTerminalReceipt = runtime.status === 'completed'
      ? createSearchTerminalReceiptV1({
          collectionTaskId: request.logicalLineage.collectionTaskId,
          searchQueryKeyHash: request.action.request.searchQueryKeyHash,
          querySnapshotHash: request.action.request.querySnapshotHash,
          completedSearchSegmentIds: recovery
            ? [
                ...verifiedRecoveryIdentityV1(recoveryArchive!).searchSegmentIds,
                request.action.request.searchSegmentId,
              ]
            : [request.action.request.searchSegmentId],
          completedPageActionIds: [
            ...(recoveryArchive === undefined
              ? []
              : verifiedRecoveryIdentityV1(recoveryArchive).pageActionIds),
            request.pageActionId,
          ],
          result: runtime,
          eligibleCandidateIds: runtime.offers.map((offer) => offer.offerId),
          eligibleObservations: terminalObservations,
          advertisementPolicy: parameterSet.advertisementPolicy,
          terminalAt: completedAt,
        })
      : undefined;
    return {
      outcome: runtime.status === 'completed'
        ? 'completed'
        : runtime.status === 'cancelled' ? 'cancelled' : 'partial',
      batches,
      remoteRequestAttempts: attempts,
      requestSnapshots: snapshots,
      pageLifecycle: pageLifecycle(),
      metrics: { remoteRequests: attempts.length, uniqueOffers: runtime.offers.length },
      ...(searchTerminalReceipt === undefined ? {} : { searchTerminalReceipt }),
      ...(terminalCollectorError === undefined ? {} : { error: terminalCollectorError }),
    };
  }

  private async runOffer(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
    remoteLedger: RemoteAttemptLedgerV1,
    offerId: string,
    memberId: string,
    signal?: AbortSignal,
  ): Promise<CollectorActionRunV1> {
    throwIfAborted(signal);
    const requestBusinessHash = canonicalCollectorSha256V1({ offerId, memberId });
    let offer: Awaited<ReturnType<typeof collectOfferOnPage>> | undefined;
    let remoteRequestAttemptId = '';
    let startedAt = '';
    let successfulOrdinal = 0;
    let componentEvidenceRefs: string[] = [];
    let componentEvidenceRefByKind = new Map<string, string>();
    for (let retry = 0; retry < 3; retry++) {
      const ordinal = remoteLedger.nextOrdinal();
      const rawEvidenceRefs: string[] = [];
      const rawEvidenceRefByKind = new Map<string, string>();
      remoteRequestAttemptId = `remote-${request.pageActionExecutionAttemptId}-${ordinal}`;
      const admission = await scope.admitRemoteAttempt({
        remoteRequestAttemptId,
        ordinal,
        purpose: 'single-target',
        requestBusinessHash,
      });
      remoteLedger.confirmAdmission(ordinal, admission);
      startedAt ||= admission.admittedAt;
      try {
        offer = await this.collectOfferOnPage(singlePageContext(scope.page as Page), {
          offerId,
          // The daemon retains this already-headful Page for InterventionSession;
          // the Collector must never wait/retry a challenge itself.
          headed: false,
        });
        assertOfferCoreMemberIdentityV1(offer, memberId);
        await scope.assertAuthorized('checkpoint');
        const onRawComponent = async (
          component: 'core' | 'sku' | 'detail' | 'shop-card' | 'consignment',
          payload: unknown,
        ): Promise<void> => {
          const descriptor = offerRawArchiveDescriptor(component);
          const ref = await this.persistRawArchive({
            ...descriptor,
            request,
            ordinal,
            requestBusinessHash,
            payload,
          });
          rawEvidenceRefs.push(ref);
          rawEvidenceRefByKind.set(component, ref);
        };
        for (const [component, payload] of stagedOfferRawComponentsV1(offer)) {
          await onRawComponent(component, payload);
        }
        await scope.assertAuthorized('checkpoint');
        successfulOrdinal = ordinal;
        componentEvidenceRefs = [...rawEvidenceRefs];
        componentEvidenceRefByKind = rawEvidenceRefByKind;
        break;
      } catch (error) {
        remoteLedger.recordFailure(
          ordinal,
          error,
          this.now().toISOString(),
          rawEvidenceRefs,
        );
        if (!isRetryableCollectorBoundary(error) || retry === 2) throw error;
        await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
      }
    }
    if (!offer || successfulOrdinal === 0) throw new Error('Offer retry loop ended without evidence.');
    const completedAt = terminalTime(startedAt, this.now().toISOString());
    const detailBatchId = `batch-${this.idFactory()}`;
    const mediaBatchId = `batch-${this.idFactory()}`;
    remoteLedger.recordBatches(createOfferPageActionBatchesV1({
      offer,
      unitId: request.logicalLineage.workUnitId,
      sourceRequestId: request.requestId,
      detailBatchId,
      mediaBatchId,
      startedAt,
      completedAt,
      rawEvidenceRefs: componentEvidenceRefs,
    }));
    const sourceEvidence = readOfferSourceCaptureEvidenceV1(offer);
    const shopCardContextEvidenceRef =
      sourceEvidence?.shopCard.correlationAuthority?.kind
        === 'offer-page-context-v1'
        ? componentEvidenceRefByKind.get('core') ?? null
        : null;
    if (
      sourceEvidence?.shopCard.correlationAuthority !== undefined
      && shopCardContextEvidenceRef === null
    ) {
      throw new CliError(
        9,
        'SHOP_CARD_CORRELATION_EVIDENCE_MISSING',
        'Shop-card page-context correlation is missing its frozen core evidence.',
        {
          category: 'protocol',
          retryable: false,
          recoveryAction: 'recollect-offer-with-staged-raw-evidence',
        },
      );
    }
    const shopCardEvidenceRef = sourceEvidence?.shopCard.rawPayload === null || !sourceEvidence
      ? null
      : await persistOfferSourceSidecarV1({
          artifactDirectory: this.options.artifactDirectory,
          sidecar: createOfferSourceSidecarV1({
            source: 'shop-card', offerId, memberId,
            correlatedOfferId: sourceEvidence.shopCard.correlatedOfferId,
            correlatedMemberId: sourceEvidence.shopCard.correlatedMemberId,
            pageActionId: request.pageActionId,
            remoteRequestAttemptId, capturedAt: completedAt,
            rawPayload: sourceEvidence.shopCard.rawPayload,
            ...(sourceEvidence.shopCard.correlationAuthority === undefined
              ? {}
              : {
                  correlationEvidence: {
                    method: sourceEvidence.shopCard.correlationAuthority.kind,
                    rawEvidenceRef: shopCardContextEvidenceRef!,
                    offerIdFieldPath:
                      sourceEvidence.shopCard.correlationAuthority.offerIdFieldPath,
                    memberIdFieldPath:
                      sourceEvidence.shopCard.correlationAuthority.memberIdFieldPath,
                  },
                }),
          }),
        });
    const consignmentEvidenceRef = sourceEvidence?.consignment.rawPayload === null || !sourceEvidence
      ? null
      : await persistOfferSourceSidecarV1({
          artifactDirectory: this.options.artifactDirectory,
          sidecar: createOfferSourceSidecarV1({
            source: 'offer-consignment', offerId, memberId,
            correlatedOfferId: sourceEvidence.consignment.correlatedOfferId,
            correlatedMemberId: sourceEvidence.consignment.correlatedMemberId,
            pageActionId: request.pageActionId,
            remoteRequestAttemptId, capturedAt: completedAt,
            rawPayload: sourceEvidence.consignment.rawPayload,
          }),
        });
    const evidenceRefs = [
      ...componentEvidenceRefs,
      shopCardEvidenceRef,
      consignmentEvidenceRef,
    ].filter(
      (ref): ref is string => ref !== null,
    );
    remoteLedger.recordSuccess(successfulOrdinal, completedAt, evidenceRefs);
    const batches = createOfferPageActionBatchesV1({
      offer,
      unitId: request.logicalLineage.workUnitId,
      sourceRequestId: request.requestId,
      detailBatchId,
      mediaBatchId,
      startedAt,
      completedAt,
      rawEvidenceRefs: evidenceRefs,
    });
    remoteLedger.recordBatches(batches);
    const sourceInput = {
      offerId,
      memberId,
      pageActionId: request.pageActionId,
      remoteRequestAttemptId,
    };
    const shopCard = createOfferSourceTerminalReceiptV1({
      ...sourceInput,
      source: 'shop-card',
      correlatedOfferId: sourceEvidence?.shopCard.correlatedOfferId ?? null,
      correlatedMemberId: sourceEvidence?.shopCard.correlatedMemberId ?? null,
      responseObserved: sourceEvidence?.shopCard.responseObserved ?? false,
      responseSucceeded: sourceEvidence?.shopCard.responseSucceeded ?? false,
      parsedValue: offer.shopCard,
      rawEvidenceRefs: shopCardEvidenceRef ? [shopCardEvidenceRef] : [],
      ...(shopCardContextEvidenceRef === null
        ? {}
        : { fieldObservationRefs: [shopCardContextEvidenceRef] }),
      ...(sourceEvidence?.shopCard.authoritativeEmpty === undefined
        ? {}
        : { authoritativeEmpty: sourceEvidence.shopCard.authoritativeEmpty }),
    });
    const consignment = createOfferSourceTerminalReceiptV1({
      ...sourceInput,
      source: 'offer-consignment',
      correlatedOfferId: sourceEvidence?.consignment.correlatedOfferId ?? null,
      correlatedMemberId: sourceEvidence?.consignment.correlatedMemberId ?? null,
      responseObserved: sourceEvidence?.consignment.responseObserved ?? false,
      responseSucceeded: sourceEvidence?.consignment.responseSucceeded ?? false,
      parsedValue: offer.consignment,
      rawEvidenceRefs: consignmentEvidenceRef ? [consignmentEvidenceRef] : [],
      ...(sourceEvidence?.consignment.authoritativeEmpty === undefined
        ? {}
        : { authoritativeEmpty: sourceEvidence.consignment.authoritativeEmpty }),
    });
    const offerMediaV2 = buildOfferMediaManifestV2({
      offerId,
      sourceObservationId: request.pageActionExecutionAttemptId,
      sourcePayloadContentSha256: canonicalCollectorSha256V1(offer),
      mainImage: offer.mainImage,
      galleryImages: offer.images,
      skus: offer.skus.map((sku) => ({ platformSkuId: sku.skuId, image: sku.image })),
      explicitSingleSkuWithoutPlatformId:
        offer.skus.length === 0 && offer.options.length === 0,
      detailImages: offer.media.items.filter((item) => item.role === 'detail')
        .map((item) => item.normalizedUrl),
      detailSourceState: offer.sources.detailMediaResponseObserved
        ? offer.media.availability : 'failed',
    });
    const completed = shopCard.state !== 'failed'
      && consignment.state !== 'failed'
      && offerMediaV2.availability !== 'failed';
    const terminalEvidence = remoteLedger.fallbackEvidence(this.now());
    return {
      outcome: completed ? 'completed' : 'partial',
      batches,
      remoteRequestAttempts: terminalEvidence.attempts,
      requestSnapshots: terminalEvidence.snapshots,
      pageLifecycle: pageLifecycle(),
      metrics: { remoteRequests: terminalEvidence.attempts.length, capturedOffers: 1 },
      offerSources: { shopCard, consignment },
      offerMediaV2,
      offerSkuManifest: createOfferSkuManifestV1(offer),
      ...(completed ? {} : { error: collectorError('OFFER_REQUIRED_COMPONENT_INCOMPLETE') }),
    };
  }

  private async runQualification(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
    remoteLedger: RemoteAttemptLedgerV1,
    memberId: string,
    signal?: AbortSignal,
  ): Promise<CollectorActionRunV1> {
    throwIfAborted(signal);
    const page = scope.page as Page;
    const qualificationUrl = buildSupplierQualificationPageUrl(memberId);
    const navigationHash = canonicalCollectorSha256V1({
      operation: 'qualification-navigation', memberId, url: qualificationUrl,
    });
    let startedAt = '';
    for (let retry = 0; retry < 3; retry++) {
      const ordinal = remoteLedger.nextOrdinal();
      const admission = await scope.admitRemoteAttempt({
        remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
        ordinal,
        purpose: 'discovery',
        requestBusinessHash: navigationHash,
      });
      remoteLedger.confirmAdmission(ordinal, admission);
      startedAt ||= admission.admittedAt;
      try {
        await page.goto(qualificationUrl, {
          waitUntil: 'domcontentloaded', timeout: 30_000,
        });
        await waitForCollectionPageAvailability(page, { headed: false, signal });
        remoteLedger.recordSuccess(ordinal, this.now().toISOString(), []);
        break;
      } catch (error) {
        const typed = typedNavigationFailure(error, 'QUALIFICATION_NAVIGATION_FAILED');
        remoteLedger.recordFailure(ordinal, typed, this.now().toISOString());
        if (!isRetryableCollectorBoundary(typed) || retry === 2) throw typed;
        await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
      }
    }
    let capture: Awaited<ReturnType<typeof captureSupplierQualificationForAction>> | undefined;
    let qualification: ReturnType<typeof requireSupplierQualificationResponse> | undefined;
    let successfulOrdinal = 0;
    const batchId = `batch-${this.idFactory()}`;
    const requestBusinessHash = canonicalCollectorSha256V1({
      operation: 'qualification-runtime-request', memberId,
    });
    let evidenceRef = '';
    for (let retry = 0; retry < 3; retry++) {
      const ordinal = remoteLedger.nextOrdinal();
      const rawEvidenceRefs: string[] = [];
      const admission = await scope.admitRemoteAttempt({
        remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
        ordinal,
        purpose: 'single-target',
        requestBusinessHash,
      });
      remoteLedger.confirmAdmission(ordinal, admission);
      try {
        capture = await captureSupplierQualificationForAction(
          page,
          {
            memberId,
            timeoutMs: 15_000,
            onRawResponse: async (rawResponseText) => {
              const ref = await this.persistRawArchive({
                kind: 'qualification-response',
                parserRevision: 'supplier-qualification-v1@1',
                request,
                ordinal,
                requestBusinessHash,
                payload: rawResponseText,
              });
              rawEvidenceRefs.push(ref);
            },
          },
          () => requestSupplierQualificationFromPage(page, memberId),
        );
        qualification = requireSupplierQualificationResponse(capture, memberId);
        const observedAt = terminalTime(startedAt, this.now().toISOString());
        remoteLedger.recordBatches([createQualificationBatch({
          unit: {
            schemaVersion: 1,
            unitId: request.logicalLineage.workUnitId,
            collectionTaskId: request.logicalLineage.collectionTaskId,
            kind: 'store-qualification',
            subject: { supplier: { memberId } },
            scope: { requestedScope: 'page' },
          },
          batchId,
          sourceRequestId: request.requestId,
          qualification,
          requestMemberId: memberId,
          startedAt,
          completedAt: observedAt,
          sourceRef: opaqueEvidence(
            'qualification',
            canonicalCollectorSha256V1(qualification),
          ),
          rawEvidenceRefs,
        })]);
        await scope.assertAuthorized('checkpoint');
        evidenceRef = rawEvidenceRefs.at(-1) ?? '';
        if (!evidenceRef) {
          throw new CliError(
            9,
            'QUALIFICATION_RAW_ARCHIVE_MISSING',
            'Qualification response parsed without an immutable raw archive.',
            { category: 'protocol', retryable: false, recoveryAction: 'inspect-capture-bridge' },
          );
        }
        remoteLedger.recordSuccess(ordinal, this.now().toISOString(), rawEvidenceRefs);
        successfulOrdinal = ordinal;
        break;
      } catch (error) {
        remoteLedger.recordFailure(
          ordinal,
          error,
          this.now().toISOString(),
          rawEvidenceRefs,
        );
        if (!isRetryableCollectorBoundary(error) || retry === 2) throw error;
        await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
      }
    }
    if (!successfulOrdinal || !evidenceRef || !capture || !qualification) {
      throw new Error('Qualification retry loop ended without evidence.');
    }
    const completedAt = terminalTime(startedAt, this.now().toISOString());
    const batch = createQualificationBatch({
      unit: {
        schemaVersion: 1,
        unitId: request.logicalLineage.workUnitId,
        collectionTaskId: request.logicalLineage.collectionTaskId,
        kind: 'store-qualification',
        subject: { supplier: { memberId } },
        scope: { requestedScope: 'page' },
      },
      batchId,
      sourceRequestId: request.requestId,
      qualification,
      requestMemberId: memberId,
      startedAt,
      completedAt,
      sourceRef: evidenceRef,
      rawEvidenceRefs: [evidenceRef],
    });
    remoteLedger.recordBatches([batch]);
    const media = buildQualificationMediaManifestV1({
      memberId,
      sourceQualificationGeneration: request.pageActionExecutionAttemptId,
      sourceObservationId: request.pageActionExecutionAttemptId,
      sourcePayloadContentSha256: canonicalCollectorSha256V1(qualification),
      qualification,
      responseObserved: capture.diagnostics.matchedCount > 0,
      responseSucceeded: true,
      correlationMatched: qualification.memberId === null || qualification.memberId === memberId,
    });
    const completed = batch.status === 'completed' && media.sourceCoverage !== 'failed';
    const terminalEvidence = remoteLedger.fallbackEvidence(this.now());
    return {
      outcome: completed ? 'completed' : 'partial',
      batches: [batch],
      remoteRequestAttempts: terminalEvidence.attempts,
      requestSnapshots: terminalEvidence.snapshots,
      pageLifecycle: pageLifecycle(),
      metrics: {
        remoteRequests: terminalEvidence.attempts.length,
        qualificationSnapshots: 1,
      },
      qualificationMedia: media,
      ...(completed ? {} : { error: collectorError('QUALIFICATION_REQUIRED_COMPONENT_INCOMPLETE') }),
    };
  }

  private async runStoreSample(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
    remoteLedger: RemoteAttemptLedgerV1,
    identity: TrustedCanonicalShopIdentityV1,
    signal?: AbortSignal,
  ): Promise<CollectorActionRunV1> {
    if (request.action.kind !== 'store-sample') throw new TypeError('Store Sample action mismatch.');
    const action = request.action;
    const page = scope.page as Page;
    const startedAt = this.now().toISOString();
    const evidenceRefs = new Set<string>();
    let profileObservation: StoreSampleProfileObservationV1 | null = null;
    const resolvedCursor = action.mode === 'approved-expansion'
      ? await resolveStoreSampleCursorArtifactV1({
          artifactDirectory: this.options.artifactDirectory,
          baselineGeneration: action.expansionApproval!.baselineGeneration,
        })
      : undefined;
    const cursorInput = resolveStoreSampleCursorInputV1({
      request,
      identity,
      now: this.now(),
      storeSampleFreshnessMs: this.storeSampleFreshnessMs,
      ...(resolvedCursor === undefined ? {} : { resolvedCursor }),
    });
    const result = await collectBoundedStoreSampleV1({
      memberId: identity.memberId,
      canonicalShopUrl: identity.canonicalShopUrl,
      mode: request.action.mode,
      firstPage: action.pageScope.firstPage,
      lastPageInclusive: action.pageScope.lastPageInclusive,
      generation: cursorInput.generation,
      baselineExpiresAt: cursorInput.baselineExpiresAt,
      ...(cursorInput.previousCursor === undefined
        ? {}
        : { previousCursor: cursorInput.previousCursor }),
      now: this.now,
      collectProfileObservation: async () => {
        const logicalPage = action.pageScope.firstPage;
        const navigationUrl = buildStoreCatalogUrl(
          identity.canonicalShopUrl,
          { sort: 'wangpu_score' },
        );
        const navigationHash = canonicalCollectorSha256V1({
          operation: 'store-navigation-and-header',
          memberId: identity.memberId,
          logicalPage,
          navigationUrl,
        });
        for (let retry = 0; retry < 3; retry++) {
          const ordinal = remoteLedger.nextOrdinal();
          const rawEvidenceRefs: string[] = [];
          const receipt = await scope.admitRemoteAttempt({
            remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
            ordinal,
            logicalPage,
            purpose: 'discovery',
            requestBusinessHash: navigationHash,
          });
          remoteLedger.confirmAdmission(ordinal, receipt);
          try {
            const captured = await captureStoreProfileForAction(
              page,
              { memberId: identity.memberId, timeoutMs: 15_000 },
              async () => {
                await page.goto(navigationUrl, {
                  waitUntil: 'domcontentloaded', timeout: 30_000,
                });
                await waitForCollectionPageAvailability(page, { headed: false, signal });
                await waitForStoreCatalogRuntime(page, { timeoutMs: 15_000, signal });
              },
            );
            if (captured.captured === null) {
              throw new CliError(
                9,
                'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
                'Store navigation did not expose the required Wangpu header payload.',
                {
                  category: 'protocol',
                  retryable: false,
                  recoveryAction: 'refresh-store-header-capture',
                },
              );
            }
            const profileEvidenceRef = await this.persistRawArchive({
              kind: 'store-response',
              parserRevision: STORE_PROFILE_PARSER_VERSION,
              request,
              ordinal,
              requestBusinessHash: navigationHash,
              payload: captured.captured.payload,
            });
            rawEvidenceRefs.push(profileEvidenceRef);
            evidenceRefs.add(profileEvidenceRef);
            assertStoreProfilePayloadState(
              captured.captured.payload,
              captured.diagnostics,
            );
            const profile = mapStoreProfilePayload(
              captured.captured.payload,
              captured.captured.collectedAt,
              {
                sourceRef: captured.captured.sourceRef,
                rawRef: profileEvidenceRef,
              },
            );
            const memberAuthority = parseStoreProfileMemberAuthorityV1(
              captured.captured.payload,
              profile.source,
            );
            const capturedProfileObservation: StoreSampleProfileObservationV1 = {
              ...memberAuthority,
              canonicalShopUrl: identity.canonicalShopUrl,
              observedAt: captured.captured.collectedAt,
              profile,
            };
            assertStoreSampleProfileObservationV1(
              capturedProfileObservation,
              identity.memberId,
              identity.canonicalShopUrl,
            );
            profileObservation = capturedProfileObservation;
            await scope.assertAuthorized('checkpoint');
            remoteLedger.recordSuccess(
              ordinal,
              captured.captured.collectedAt,
              rawEvidenceRefs,
            );
            return profileObservation;
          } catch (error) {
            const typed = error instanceof CliError
              ? error
              : typedNavigationFailure(error, 'STORE_NAVIGATION_FAILED');
            remoteLedger.recordFailure(
              ordinal,
              typed,
              this.now().toISOString(),
              rawEvidenceRefs,
            );
            if (!isRetryableCollectorBoundary(typed) || retry === 2) throw typed;
            await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
          }
        }
        throw new Error('Store navigation retry loop ended without header evidence.');
      },
      collectPage: async (logicalPage) => {
        throwIfAborted(signal);
        const requestBusinessHash = canonicalCollectorSha256V1({
          operation: 'store-runtime-request',
          memberId: identity.memberId,
          logicalPage,
          count: 30,
          sortType: 'wangpu_score',
        });
        for (let retry = 0; retry < 3; retry++) {
          const ordinal = remoteLedger.nextOrdinal();
          let capturedEvidenceRef: string | undefined;
          const receipt = await scope.admitRemoteAttempt({
            remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
            ordinal,
            logicalPage,
            purpose: 'forward',
            requestBusinessHash,
          });
          remoteLedger.confirmAdmission(ordinal, receipt);
          try {
            const rawPayload = await requestStoreCatalogFromPage(
              page,
              {
                memberId: identity.memberId,
                pageNum: logicalPage,
                count: 30,
                sortType: 'wangpu_score',
              },
              { timeoutMs: 15_000, signal },
            );
            const parsed = parseStoreCatalogModule(rawPayload, {
              memberId: identity.memberId,
              pageNum: logicalPage,
              pageSize: 30,
              sortType: 'wangpu_score',
            });
            await scope.assertAuthorized('checkpoint');
            capturedEvidenceRef = await this.persistRawArchive({
              kind: 'store-response',
              parserRevision: STORE_CATALOG_PARSER_VERSION,
              request,
              ordinal,
              requestBusinessHash,
              payload: rawPayload,
            });
            evidenceRefs.add(capturedEvidenceRef);
            if (
              logicalPage === 1
              && (parsed.offerCount === null
                || parsed.totalPages === null
                || parsed.categories.length === 0)
            ) {
              throw new CliError(
                9,
                'STORE_SAMPLE_PAGE1_SUMMARY_INCOMPLETE',
                'Store page 1 must authoritatively expose offer totals, page totals, and categories.',
                {
                  category: 'protocol',
                  retryable: false,
                  recoveryAction: 'refresh-store-parser',
                },
              );
            }
            remoteLedger.recordSuccess(
              ordinal,
              this.now().toISOString(),
              [capturedEvidenceRef],
            );
            return parsed;
          } catch (error) {
            remoteLedger.recordFailure(
              ordinal,
              error,
              this.now().toISOString(),
              capturedEvidenceRef === undefined ? [] : [capturedEvidenceRef],
            );
            if (!isRetryableCollectorBoundary(error) || retry === 2) throw error;
            await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
          }
        }
        throw new Error('Store retry loop ended without evidence.');
      },
      afterPageCommitted: async (logicalPage) => {
        if (logicalPage < action.pageScope.lastPageInclusive) {
          await this.pace(sampleDelay(this.random, 3_000, 10_000), signal);
        }
      },
    }).catch((error: unknown) => {
      const terminalEvidence = remoteLedger.fallbackEvidence(this.now());
      const fallback = failedStoreSampleResultV1({
        request,
        identity,
        cursorInput,
        error,
        remoteRequests: terminalEvidence.attempts.length,
        observedAt: startedAt,
        profileObservation,
      });
      remoteLedger.recordBatches(createBoundedStoreSampleBatchesV1({
        result: fallback,
        unitId: request.logicalLineage.workUnitId,
        sourceRequestId: request.requestId,
        catalogBatchId: `batch-${this.idFactory()}`,
        categoriesBatchId: `batch-${this.idFactory()}`,
        profileBatchId: `batch-${this.idFactory()}`,
        startedAt,
        completedAt: terminalTime(startedAt, this.now().toISOString()),
        rawEvidenceRefs: [...evidenceRefs],
      }));
      throw error;
    });
    const completedAt = this.now().toISOString();
    const terminalEvidence = remoteLedger.fallbackEvidence(this.now());
    const snapshots = terminalEvidence.attempts.map((attempt) => snapshot({
      request,
      remoteRequestAttemptId: attempt.remoteRequestAttemptId,
      componentKey: 'store-catalog',
      observedAt: attempt.startedAt,
      ...(attempt.logicalPage === undefined ? {} : { logicalPage: attempt.logicalPage }),
      purpose: attempt.purpose,
      requestBusinessHash: attempt.requestBusinessHash,
    }));
    remoteLedger.replaceTerminalEvidence(terminalEvidence.attempts, snapshots);
    const materializedResult = result.remoteRequests === terminalEvidence.attempts.length
      ? result
      : { ...result, remoteRequests: terminalEvidence.attempts.length };
    const batches = createBoundedStoreSampleBatchesV1({
      result: materializedResult,
      unitId: request.logicalLineage.workUnitId,
      sourceRequestId: request.requestId,
      catalogBatchId: `batch-${this.idFactory()}`,
      categoriesBatchId: `batch-${this.idFactory()}`,
      profileBatchId: `batch-${this.idFactory()}`,
      startedAt,
      completedAt,
      rawEvidenceRefs: [...evidenceRefs],
    });
    remoteLedger.recordBatches(batches);
    if (result.status === 'completed' && action.mode === 'phase-1-bounded') {
      await persistStoreSampleCursorArtifactV1({
        artifactDirectory: this.options.artifactDirectory,
        cursor: result.cursor,
      });
    }
    return {
      outcome: result.status,
      batches,
      remoteRequestAttempts: terminalEvidence.attempts,
      requestSnapshots: snapshots,
      pageLifecycle: pageLifecycle(),
      metrics: {
        remoteRequests: terminalEvidence.attempts.length,
        catalogCandidatesPublished: 0,
      },
      storeCursor: result.cursor,
      storeSampleEvidenceUsage: result.evidenceUsage,
      catalogCandidatesPublished: 0,
      ...(result.errorCode === null ? {} : { error: collectorError(result.errorCode) }),
    };
  }

  private async resolveSearchParameterSet(
    artifactRef: string,
  ): Promise<CanonicalSearchParameterSetV1> {
    const value = await this.readArtifact(artifactRef);
    return resolveSearchParameterArtifactV1(value, this.now().toISOString());
  }

  private async resolveSearchRecoveryArchive(
    request: PageActionRequestV1,
    artifactRef: string,
  ): Promise<SearchRecoveryArchiveV1> {
    if (request.action.kind !== 'search-list' || !request.action.recoveryHandle) {
      throw new TypeError('Search recovery archive requires a recovery action.');
    }
    const archive = await this.readArtifact(artifactRef) as SearchRecoveryArchiveV1;
    assertSearchRecoveryArchiveBindingV1(archive, request);
    return structuredClone(archive);
  }

  private async readArtifact(reference: string): Promise<unknown> {
    if (/^sha256:[0-9a-f]{64}$/u.test(reference)) {
      return readContentAddressedArtifactV1(this.options.artifactDirectory, reference);
    }
    const match = reference.match(/^artifact:([A-Za-z0-9._-]+)$/u);
    if (!match?.[1]) throw new Error('Collector artifact reference is invalid.');
    const resolved = path.join(this.options.artifactDirectory, `${match[1]}.json`);
    const relative = path.relative(this.options.artifactDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Collector artifact reference escapes its configured root.');
    }
    return JSON.parse(await fs.readFile(resolved, 'utf8')) as unknown;
  }

  private async persistRawArchive(input: {
    kind: Parameters<typeof createCollectorRawArchiveV1>[0]['kind'];
    parserRevision: string;
    request: PageActionRequestV1;
    ordinal: number;
    requestBusinessHash: string;
    payload: unknown;
  }): Promise<string> {
    return persistCollectorRawArchiveV1({
      artifactDirectory: this.options.artifactDirectory,
      archive: createCollectorRawArchiveV1({
        kind: input.kind,
        parserRevision: input.parserRevision,
        pageActionId: input.request.pageActionId,
        remoteRequestAttemptId:
          `remote-${input.request.pageActionExecutionAttemptId}-${input.ordinal}`,
        requestBusinessHash: input.requestBusinessHash,
        payload: input.payload,
      }),
    });
  }
}

/**
 * Reads a producer-owned SHA-256 artifact from the shared CAS. This is kept
 * outside the executor so deterministic offline harnesses cannot substitute
 * in-memory bytes for the production artifact path.
 */
export async function readContentAddressedArtifactV1(
  artifactDirectory: string,
  reference: string,
): Promise<unknown> {
  const contentAddress = reference.match(/^sha256:([0-9a-f]{64})$/u);
  if (!path.isAbsolute(artifactDirectory) || !contentAddress?.[1]) {
    throw new CliError(
      9,
      'COLLECTOR_ARTIFACT_REFERENCE_INVALID',
      'Collector content-addressed artifact reference is invalid.',
      {
        category: 'contract',
        retryable: false,
        recoveryAction: 'restore-artifact-from-content-addressed-store',
      },
    );
  }
  const digest = contentAddress[1];
  const root = path.resolve(artifactDirectory);
  const resolved = path.resolve(root, digest.slice(0, 2), digest);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CliError(
      9,
      'COLLECTOR_ARTIFACT_REFERENCE_INVALID',
      'Collector content-addressed artifact escapes its configured root.',
      {
        category: 'contract',
        retryable: false,
        recoveryAction: 'restore-artifact-from-content-addressed-store',
      },
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(
        9,
        'COLLECTOR_ARTIFACT_NOT_FOUND',
        'Collector content-addressed artifact bytes are missing.',
        {
          category: 'contract',
          retryable: false,
          recoveryAction: 'restore-artifact-from-content-addressed-store',
        },
      );
    }
    throw error;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new CliError(
      9,
      'COLLECTOR_ARTIFACT_HASH_MISMATCH',
      'Collector content-addressed artifact bytes do not match the signed digest.',
      {
        category: 'contract',
        retryable: false,
        recoveryAction: 'restore-artifact-from-content-addressed-store',
      },
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new CliError(
      9,
      'COLLECTOR_ARTIFACT_INVALID_JSON',
      'Collector content-addressed artifact contains invalid JSON.',
      {
        category: 'contract',
        retryable: false,
        recoveryAction: 'restore-artifact-from-content-addressed-store',
      },
    );
  }
}

export function assertSearchRecoveryArchiveBindingV1(
  archive: SearchRecoveryArchiveV1,
  request: PageActionRequestV1,
): void {
    if (request.action.kind !== 'search-list' || !request.action.recoveryHandle) {
      throw new TypeError('Search recovery archive requires a recovery action.');
    }
    const { recoveryReceiptHash, ...content } = archive;
    const recovery = request.action.recoveryHandle;
    const pages = archive.pages?.map((page) => page.logicalPage) ?? [];
    const expectedPages = Array.from(
      { length: recovery.checkpointPage },
      (_, index) => index + 1,
    );
    let verifiedIdentity: ReturnType<typeof verifiedRecoveryIdentityV1> | null = null;
    try {
      verifiedIdentity = verifiedRecoveryIdentityV1(
        archive,
        request.action.request.advertisementPolicy,
        {
          collectionTaskId: request.logicalLineage.collectionTaskId,
          searchQueryKeyHash: request.action.request.searchQueryKeyHash,
          querySnapshotHash: request.action.request.querySnapshotHash,
          keyword: request.action.request.keyword,
        },
      );
    } catch {
      verifiedIdentity = null;
    }
    if (
      archive.schema !== 'collector.search-recovery-archive.v1'
      || archive.recoveryReceiptId !== recovery.recoveryReceiptId
      || recoveryReceiptHash !== recovery.recoveryReceiptHash
      || recoveryReceiptHash !== canonicalCollectorSha256V1(content)
      || archive.searchQueryKeyHash !== request.action.request.searchQueryKeyHash
      || archive.querySnapshotHash !== request.action.request.querySnapshotHash
      || archive.checkpointPage !== recovery.checkpointPage
      || verifiedIdentity === null
      || !verifiedIdentity.searchSegmentIds.includes(recovery.previousSearchSegmentId)
      || archive.predecessorExecutionAttemptReceipt.receiptId
        !== request.predecessorExecutionAttemptReceipt?.receiptId
      || archive.predecessorExecutionAttemptReceipt.receiptHash
        !== request.predecessorExecutionAttemptReceipt?.receiptHash
      || JSON.stringify(pages) !== JSON.stringify(expectedPages)
    ) {
      throw new CliError(
        9,
        'SEARCH_RECOVERY_ARCHIVE_INVALID',
        'Search recovery archive is incomplete, mutable, or belongs to another predecessor.',
        { category: 'contract', retryable: false, recoveryAction: 'rebuild-recovery-receipt' },
      );
    }
}

interface SearchBatchRecoveryCutV1 {
  schema: 'collector.search-batch-recovery-cut.v1';
  logicalPage: number;
  responseBusinessHash: string;
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'];
  eligibleCandidateIdsHash: string;
  observationUniverseHash: string;
  searchSegmentId: string;
  pageActionId: string;
  pageActionBusinessHash: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  requestId: string;
  logicalLineageHash: string;
  executionLineageHash: string;
  predecessorExecutionAttemptReceipt?: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
}

interface VerifiedSearchBatchCutV1 {
  cut: SearchBatchRecoveryCutV1;
  eligibleCandidateIds: string[];
  eligibleObservations: Array<{
    logicalPage: number;
    sourceOrdinal: number;
    offerId: string;
    isP4P: boolean;
    responseBusinessHash: string;
    candidateSelectionState?:
      | 'selected'
      | 'promoted-excluded'
      | 'offer-limit-overflow';
  }>;
}

export function bindSearchBatchRecoveryCutV1(input: {
  batch: CollectionBatch;
  logicalPage: number;
  responseBusinessHash: string;
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'];
  searchSegmentId: string;
  pageActionId: string;
  pageActionBusinessHash: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  requestId: string;
  logicalLineageHash: string;
  executionLineageHash: string;
  predecessorExecutionAttemptReceipt?: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
}): CollectionBatch {
  const base = normalizeCollectionBatch(input.batch);
  const observations = searchBatchObservationUniverseV1(
    base,
    input.logicalPage,
    input.responseBusinessHash,
  );
  const eligibleObservations = terminalEligibleSearchObservationsV1(
    observations,
    input.advertisementPolicy,
  );
  const cut: SearchBatchRecoveryCutV1 = {
    schema: 'collector.search-batch-recovery-cut.v1',
    logicalPage: input.logicalPage,
    responseBusinessHash: requireSha256V1(input.responseBusinessHash, 'responseBusinessHash'),
    advertisementPolicy: input.advertisementPolicy,
    eligibleCandidateIdsHash: eligibleCandidateIdsHashV1(
      eligibleObservations.map((item) => item.offerId),
    ),
    observationUniverseHash: searchObservationUniverseHashV1(observations),
    searchSegmentId: requiredIdentityV1(input.searchSegmentId, 'searchSegmentId'),
    pageActionId: requiredIdentityV1(input.pageActionId, 'pageActionId'),
    pageActionBusinessHash: requireSha256V1(
      input.pageActionBusinessHash,
      'pageActionBusinessHash',
    ),
    pageActionExecutionAttemptId: requiredIdentityV1(
      input.pageActionExecutionAttemptId,
      'pageActionExecutionAttemptId',
    ),
    executionAttemptOrdinal: requirePositiveIntegerV1(
      input.executionAttemptOrdinal,
      'executionAttemptOrdinal',
    ),
    requestId: requiredIdentityV1(input.requestId, 'requestId'),
    logicalLineageHash: requireSha256V1(input.logicalLineageHash, 'logicalLineageHash'),
    executionLineageHash: requireSha256V1(input.executionLineageHash, 'executionLineageHash'),
    ...(input.predecessorExecutionAttemptReceipt === undefined
      ? {}
      : {
          predecessorExecutionAttemptReceipt: structuredClone(
            input.predecessorExecutionAttemptReceipt,
          ),
        }),
  };
  return normalizeCollectionBatch({
    ...base,
    scope: { ...base.scope, searchRecoveryCut: cut },
  });
}

export function createSearchRecoveryArchivePageV1(
  batch: CollectionBatch,
): SearchRecoveryArchivePageV1 {
  const verified = verifiedSearchBatchCutV1(batch);
  return {
    logicalPage: verified.cut.logicalPage,
    responseBusinessHash: verified.cut.responseBusinessHash,
    eligibleCandidateIdsHash: verified.cut.eligibleCandidateIdsHash,
    observationUniverseHash: verified.cut.observationUniverseHash,
    batchContentHash: canonicalCollectorSha256V1(batch),
    pageActionId: verified.cut.pageActionId,
    pageActionBusinessHash: verified.cut.pageActionBusinessHash,
    searchSegmentId: verified.cut.searchSegmentId,
    pageActionExecutionAttemptId: verified.cut.pageActionExecutionAttemptId,
    executionAttemptOrdinal: verified.cut.executionAttemptOrdinal,
    requestId: verified.cut.requestId,
    logicalLineageHash: verified.cut.logicalLineageHash,
    executionLineageHash: verified.cut.executionLineageHash,
    ...(verified.cut.predecessorExecutionAttemptReceipt === undefined
      ? {}
      : {
          predecessorExecutionAttemptReceipt: structuredClone(
            verified.cut.predecessorExecutionAttemptReceipt,
          ),
        }),
    batch: structuredClone(batch),
  };
}

function verifiedRecoveryIdentityV1(
  archive: SearchRecoveryArchiveV1,
  advertisementPolicy?: CanonicalSearchParameterSetV1['advertisementPolicy'],
  expectedScope?: ExpectedSearchRecoveryScopeV1,
): { searchSegmentIds: string[]; pageActionIds: string[] } {
  if (!Array.isArray(archive.pages) || archive.pages.length === 0) {
    throw new TypeError('Search recovery archive must contain at least one verified page.');
  }
  const cuts = archive.pages.map((page) => {
    const verified = verifiedSearchBatchCutV1(
      page.batch,
      advertisementPolicy,
      true,
      expectedScope ?? {
        searchQueryKeyHash: archive.searchQueryKeyHash,
        querySnapshotHash: archive.querySnapshotHash,
      },
    );
    if (
      page.logicalPage !== verified.cut.logicalPage
      || page.responseBusinessHash !== verified.cut.responseBusinessHash
      || page.eligibleCandidateIdsHash !== verified.cut.eligibleCandidateIdsHash
      || page.observationUniverseHash !== verified.cut.observationUniverseHash
      || page.batchContentHash !== canonicalCollectorSha256V1(page.batch)
      || page.pageActionId !== verified.cut.pageActionId
      || page.pageActionBusinessHash !== verified.cut.pageActionBusinessHash
      || page.searchSegmentId !== verified.cut.searchSegmentId
      || page.pageActionExecutionAttemptId !== verified.cut.pageActionExecutionAttemptId
      || page.executionAttemptOrdinal !== verified.cut.executionAttemptOrdinal
      || page.requestId !== verified.cut.requestId
      || page.logicalLineageHash !== verified.cut.logicalLineageHash
      || page.executionLineageHash !== verified.cut.executionLineageHash
      || JSON.stringify(page.predecessorExecutionAttemptReceipt ?? null)
        !== JSON.stringify(verified.cut.predecessorExecutionAttemptReceipt ?? null)
    ) {
      throw new TypeError('Search recovery page declarations differ from their Batch cut.');
    }
    return verified.cut;
  });
  const searchSegmentIds = uniqueInOrderV1(cuts.map((cut) => cut.searchSegmentId));
  const pageActionIds = uniqueInOrderV1(cuts.map((cut) => cut.pageActionId));
  if (
    JSON.stringify(archive.completedSearchSegmentIds) !== JSON.stringify(searchSegmentIds)
    || JSON.stringify(archive.completedPageActionIds) !== JSON.stringify(pageActionIds)
  ) {
    throw new TypeError('Search recovery ancestor identities differ from the verified Batch cut.');
  }
  return { searchSegmentIds, pageActionIds };
}

function verifiedSearchBatchCutV1(
  batch: CollectionBatch,
  advertisementPolicy?: CanonicalSearchParameterSetV1['advertisementPolicy'],
  requirePageActionEvidence = true,
  expectedScope?: ExpectedSearchRecoveryScopeV1,
): VerifiedSearchBatchCutV1 {
  const normalized = normalizeCollectionBatch(batch);
  if (normalized.kind !== 'search-page' || normalized.status !== 'completed') {
    throw new TypeError('Search recovery cut requires one completed Search Batch.');
  }
  const value = normalized.scope['searchRecoveryCut'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Search Batch is missing its recovery cut.');
  }
  const cut = value as unknown as SearchBatchRecoveryCutV1;
  if (
    cut.schema !== 'collector.search-batch-recovery-cut.v1'
    || !Number.isSafeInteger(cut.logicalPage)
    || cut.logicalPage < 1
    || !['exclude-p4p', 'archive-and-mark'].includes(cut.advertisementPolicy)
    || (advertisementPolicy !== undefined && cut.advertisementPolicy !== advertisementPolicy)
    || !cut.searchSegmentId?.trim()
    || !cut.pageActionId?.trim()
    || !cut.pageActionExecutionAttemptId?.trim()
    || !Number.isSafeInteger(cut.executionAttemptOrdinal)
    || cut.executionAttemptOrdinal < 1
    || !cut.requestId?.trim()
  ) {
    throw new TypeError('Search Batch recovery cut is malformed or uses another policy.');
  }
  requireSha256V1(cut.responseBusinessHash, 'responseBusinessHash');
  requireSha256V1(cut.eligibleCandidateIdsHash, 'eligibleCandidateIdsHash');
  requireSha256V1(cut.observationUniverseHash, 'observationUniverseHash');
  requireSha256V1(cut.logicalLineageHash, 'logicalLineageHash');
  requireSha256V1(cut.executionLineageHash, 'executionLineageHash');
  requireSha256V1(cut.pageActionBusinessHash, 'pageActionBusinessHash');
  if (requirePageActionEvidence) {
    assertSearchBatchPageActionEvidenceV1(normalized, cut, expectedScope);
  }
  const observations = searchBatchObservationUniverseV1(
    normalized,
    cut.logicalPage,
    cut.responseBusinessHash,
  );
  const eligibleObservations = terminalEligibleSearchObservationsV1(
    observations,
    cut.advertisementPolicy,
  );
  const eligibleCandidateIds = uniqueInOrderV1(
    eligibleObservations.map((item) => item.offerId),
  );
  if (
    cut.observationUniverseHash !== searchObservationUniverseHashV1(observations)
    || cut.eligibleCandidateIdsHash !== eligibleCandidateIdsHashV1(eligibleCandidateIds)
  ) {
    throw new TypeError('Search Batch recovery cut hashes do not match its observation universe.');
  }
  return { cut, eligibleCandidateIds, eligibleObservations };
}

function searchBatchObservationUniverseV1(
  batch: CollectionBatch,
  logicalPage: number,
  responseBusinessHash: string,
): VerifiedSearchBatchCutV1['eligibleObservations'] {
  let previousPageRank = 0;
  return batch.observations.map((observation) => {
    const offer = observation['offer'];
    const offerRecord = offer !== null && typeof offer === 'object' && !Array.isArray(offer)
      ? offer as Record<string, unknown>
      : null;
    const offerId = String(observation['offerId'] ?? '');
    const sourcePage = observation['sourcePage'];
    const pageRank = observation['pageRank'];
    const rawRank = observation['rawRank'];
    const candidateSelectionState = observation['candidateSelectionState'];
    if (
      !/^\d+$/u.test(offerId)
      || sourcePage !== logicalPage
      || !Number.isSafeInteger(pageRank)
      || Number(pageRank) <= previousPageRank
      || !Number.isSafeInteger(rawRank)
      || Number(rawRank) < Number(pageRank)
      || typeof offerRecord?.['isP4P'] !== 'boolean'
      || (
        candidateSelectionState !== undefined
        && candidateSelectionState !== 'selected'
        && candidateSelectionState !== 'promoted-excluded'
        && candidateSelectionState !== 'offer-limit-overflow'
      )
    ) {
      throw new TypeError('Search recovery Batch observation has invalid page/rank/Offer identity.');
    }
    previousPageRank = Number(pageRank);
    return {
      logicalPage,
      sourceOrdinal: Number(pageRank) - 1,
      offerId,
      isP4P: offerRecord['isP4P'] as boolean,
      responseBusinessHash,
      ...(candidateSelectionState === undefined
        ? {}
        : { candidateSelectionState }),
    };
  });
}

function terminalEligibleSearchObservationsV1(
  observations: VerifiedSearchBatchCutV1['eligibleObservations'],
  advertisementPolicy: CanonicalSearchParameterSetV1['advertisementPolicy'],
): VerifiedSearchBatchCutV1['eligibleObservations'] {
  return observations.flatMap((observation) => {
    if (
      observation.candidateSelectionState === 'offer-limit-overflow'
      || observation.candidateSelectionState === 'promoted-excluded'
      || (advertisementPolicy === 'exclude-p4p' && observation.isP4P)
    ) return [];
    const { candidateSelectionState: _selectionState, ...terminal } = observation;
    return [terminal];
  });
}

function searchObservationUniverseHashV1(value: unknown): string {
  return canonicalCollectorSha256V1({
    schema: 'search-page-observation-universe-v1',
    observations: value,
  });
}

function eligibleCandidateIdsHashV1(candidateIds: string[]): string {
  return canonicalCollectorSha256V1({
    schema: 'search-page-eligible-candidate-ids-v1',
    candidateIds: uniqueInOrderV1(candidateIds),
  });
}

function uniqueInOrderV1(values: string[]): string[] {
  return [...new Set(values)];
}

function requireSha256V1(value: string, field: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a canonical SHA-256 reference.`);
  }
  return value;
}

function requiredIdentityV1(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} must be non-empty.`);
  return value;
}

function requirePositiveIntegerV1(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function assertSearchBatchPageActionEvidenceV1(
  batch: CollectionBatch,
  cut: SearchBatchRecoveryCutV1,
  expectedScope?: ExpectedSearchRecoveryScopeV1,
): void {
  const value = batch.scope['collectorPageActionEvidence'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Search recovery Batch is missing Collector PageAction evidence.');
  }
  const evidence = value as unknown as CollectorPageActionBatchEvidenceV1;
  let logicalLineage: PageActionRequestV1['logicalLineage'];
  let executionLineage: PageActionRequestV1['executionLineage'];
  let evidencePredecessor: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
  let cutPredecessor: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
  try {
    logicalLineage = normalizeLogicalLineageV1(evidence.logicalLineage);
    executionLineage = normalizeExecutionLineageV1(evidence.executionLineage);
    evidencePredecessor = normalizePredecessorExecutionAttemptReceiptV1(
      evidence.predecessorExecutionAttemptReceipt,
      cut.executionAttemptOrdinal,
    );
    cutPredecessor = normalizePredecessorExecutionAttemptReceiptV1(
      cut.predecessorExecutionAttemptReceipt,
      cut.executionAttemptOrdinal,
    );
  } catch {
    throw new TypeError('Search recovery Batch contains malformed PageAction lineage evidence.');
  }
  if (
    evidence.schema !== 'collector.page-action-batch-evidence.v1'
    || batch.sourceRequestId !== cut.requestId
    || evidence.pageActionId !== cut.pageActionId
    || evidence.pageActionExecutionAttemptId !== cut.pageActionExecutionAttemptId
    || evidence.searchSegmentId !== cut.searchSegmentId
    || evidence.logicalLineageHash !== cut.logicalLineageHash
    || evidence.executionLineageHash !== cut.executionLineageHash
    || computeLogicalLineageHashV1(logicalLineage) !== evidence.logicalLineageHash
    || computeExecutionLineageHashV1(executionLineage) !== evidence.executionLineageHash
    || executionLineage.logicalLineageId !== logicalLineage.logicalLineageId
    || logicalLineage.actionKind !== 'search-list'
    || logicalLineage.businessSubject.kind !== 'search-list'
    || logicalLineage.pageActionId !== cut.pageActionId
    || logicalLineage.pageActionBusinessHash !== cut.pageActionBusinessHash
    || executionLineage.pageActionExecutionAttemptId
      !== cut.pageActionExecutionAttemptId
    || executionLineage.executionAttemptOrdinal !== cut.executionAttemptOrdinal
    || executionLineage.requestId !== cut.requestId
    || executionLineage.logicalLineageHash !== cut.logicalLineageHash
    || batch.unitId !== `${logicalLineage.workUnitId}:search:${cut.logicalPage}`
    || JSON.stringify(evidencePredecessor ?? null)
      !== JSON.stringify(cutPredecessor ?? null)
    || (expectedScope?.collectionTaskId !== undefined
      && logicalLineage.collectionTaskId !== expectedScope.collectionTaskId)
    || (expectedScope?.searchQueryKeyHash !== undefined
      && logicalLineage.businessSubject.searchQueryKeyHash
        !== expectedScope.searchQueryKeyHash)
    || (expectedScope?.querySnapshotHash !== undefined
      && logicalLineage.businessSubject.querySnapshotHash
        !== expectedScope.querySnapshotHash)
    || (expectedScope?.keyword !== undefined
      && batch.subject['keyword'] !== expectedScope.keyword)
  ) {
    throw new TypeError('Search recovery cut differs from its Collector PageAction evidence.');
  }
}

interface ExpectedSearchRecoveryScopeV1 {
  collectionTaskId?: string;
  searchQueryKeyHash?: string;
  querySnapshotHash?: string;
  keyword?: string;
}

export function resolveSearchParameterArtifactV1(
  value: unknown,
  now: string,
): CanonicalSearchParameterSetV1 {
  if ((value as { schema?: unknown })?.schema === 'collector.search-parameter-source.v1') {
    const source = value as SearchParameterSourceArtifactV1;
    return compileSearchParameterSetV1(resolveSearchIntentV1({
      intent: source.intent,
      filterSnapshot: source.filterSnapshot,
      capabilitySnapshot: source.capabilitySnapshot,
      now,
    }));
  }
  verifyParameterSetHash(value as CanonicalSearchParameterSetV1);
  return value as CanonicalSearchParameterSetV1;
}

export function bindSearchRequestSnapshotsV1(input: {
  request: PageActionRequestV1;
  parameterSet: CanonicalSearchParameterSetV1;
  runtime: SearchRuntimeResultV1;
  attempts: RemoteRequestAttemptReceiptV1[];
}): SanitizedRemoteRequestSnapshotV1[] {
  if (input.runtime.pages.length !== input.runtime.pageAttemptBindings.length) {
    throw new TypeError('Search capture-to-attempt bindings are incomplete.');
  }
  const capturesByAttempt = new Map(input.runtime.pages.map((capture, index) => {
    const binding = input.runtime.pageAttemptBindings[index];
    const attempt = input.attempts.find(
      (candidate) => candidate.ordinal === binding?.attemptOrdinal,
    );
    if (
      !binding ||
      !attempt ||
      attempt.status !== 'succeeded' ||
      attempt.logicalPage !== binding.logicalPage ||
      attempt.purpose !== binding.purpose ||
      attempt.requestBusinessHash !== binding.requestBusinessHash ||
      capture.compiledRequest.page !== binding.logicalPage ||
      capture.compiledRequest.requestBusinessHash !== binding.requestBusinessHash ||
      capture.page.responseBusinessHash !== binding.responseBusinessHash
    ) {
      throw new TypeError('Search capture is not bound to its successful remote attempt.');
    }
    return [attempt.ordinal, { capture, binding }] as const;
  }));
  return input.attempts.map((attempt) => {
    const matched = capturesByAttempt.get(attempt.ordinal);
    if (attempt.status === 'succeeded' && matched === undefined) {
      throw new TypeError('Successful Search attempt is missing its captured response binding.');
    }
    if (attempt.status !== 'succeeded' && matched !== undefined) {
      throw new TypeError('Failed Search attempt cannot own a successful capture binding.');
    }
    const capture = matched?.capture;
    return {
      api: 'mtop.relationrecommend.wirelessrecommend.recommend',
      pageActionId: input.request.pageActionId,
      pageActionExecutionAttemptId: input.request.pageActionExecutionAttemptId,
      remoteRequestAttemptId: attempt.remoteRequestAttemptId,
      purpose: attempt.purpose,
      subjectHash: canonicalCollectorSha256V1(
        input.request.logicalLineage.businessSubject,
      ),
      ...(capture === undefined ? {} : { pageSessionHash: capture.compiledRequest.pageSessionHash }),
      ...(attempt.logicalPage === undefined ? {} : { page: attempt.logicalPage }),
      pageSize: input.parameterSet.pageSize,
      sort: input.parameterSet.sortType,
      filterParams: capture?.sanitizedRequest.filterParams ?? input.parameterSet.filterParams,
      requestBusinessHash: attempt.requestBusinessHash,
      observedAt: capture?.observedAt ?? attempt.startedAt,
    };
  });
}

export function assertReplayCaptureMatchesArchiveV1(
  capture: SearchRuntimeResultV1['pages'][number],
  archive: SearchRecoveryArchiveV1 | undefined,
  parameterSet: CanonicalSearchParameterSetV1,
): void {
  const expected = archive?.pages.find(
    (page) => page.logicalPage === capture.compiledRequest.page,
  );
  const observations = capture.page.offers.map((offer, sourceOrdinal) => ({
    logicalPage: capture.compiledRequest.page,
    sourceOrdinal,
    offerId: offer.offerId,
    isP4P: offer.isP4P,
    responseBusinessHash: capture.page.responseBusinessHash,
  }));
  const candidateIds = uniqueInOrderV1(capture.page.offers
    .filter((offer) =>
      parameterSet.advertisementPolicy === 'archive-and-mark' || !offer.isP4P
    )
    .map((offer) => offer.offerId));
  if (
    expected === undefined
    || expected.responseBusinessHash !== capture.page.responseBusinessHash
    || expected.eligibleCandidateIdsHash !== eligibleCandidateIdsHashV1(candidateIds)
    || expected.observationUniverseHash !== searchObservationUniverseHashV1(observations)
  ) {
    throw new CliError(
      9,
      'SEARCH_SAFE_REPLAY_DRIFT',
      'Safe replay differs from its immutable predecessor page archive.',
      {
        category: 'protocol',
        retryable: false,
        recoveryAction: 'open-new-search-generation',
      },
    );
  }
}

export function resolveStoreSampleCursorInputV1(input: {
  request: PageActionRequestV1;
  identity: TrustedCanonicalShopIdentityV1;
  now: Date;
  storeSampleFreshnessMs: number;
  resolvedCursor?: StoreSampleCursorV1;
}): {
  generation: string;
  baselineExpiresAt: string;
  previousCursor?: StoreSampleCursorV1;
} {
  if (input.request.action.kind !== 'store-sample') {
    throw new TypeError('Store cursor input requires a Store Sample action.');
  }
  const action = input.request.action;
  if (action.mode === 'phase-1-bounded') {
    return {
      generation: input.request.pageActionExecutionAttemptId,
      baselineExpiresAt: new Date(
        input.now.getTime() + input.storeSampleFreshnessMs,
      ).toISOString(),
    };
  }
  const approval = action.expansionApproval;
  const cursor = input.resolvedCursor;
  if (
    !approval ||
    !cursor ||
    action.memberId !== input.identity.memberId ||
    action.pageScope.firstPage !== approval.dormantNextPage ||
    Date.parse(approval.baselineExpiresAt) <= input.now.getTime() ||
    cursor.memberId !== input.identity.memberId ||
    cursor.canonicalShopUrl !== canonical1688ShopUrl(input.identity.canonicalShopUrl) ||
    cursor.sortType !== 'wangpu_score' ||
    cursor.count !== 30 ||
    cursor.generation !== approval.baselineGeneration ||
    cursor.baselineObservedAt !== approval.baselineObservedAt ||
    cursor.baselineExpiresAt !== approval.baselineExpiresAt ||
    cursor.nextPage !== approval.dormantNextPage ||
    cursor.checkpointState !== 'dormant' ||
    cursor.exhausted ||
    JSON.stringify(cursor.observedPages) !== JSON.stringify(
      Array.from(
        { length: approval.dormantNextPage - 1 },
        (_, index) => index + 1,
      ),
    )
  ) {
    throw new CliError(
      2,
      'STORE_SAMPLE_EXPANSION_CURSOR_INVALID',
      'Approved expansion does not identify a fresh signed dormant baseline.',
    );
  }
  return {
    generation: approval.baselineGeneration,
    baselineExpiresAt: approval.baselineExpiresAt,
    previousCursor: structuredClone(cursor),
  };
}

interface StoreSampleCursorArtifactV1 {
  schema: 'collector.store-sample-cursor-artifact.v1';
  generation: string;
  cursor: StoreSampleCursorV1;
  contentHash: string;
}

function failedStoreSampleResultV1(input: {
  request: PageActionRequestV1;
  identity: TrustedCanonicalShopIdentityV1;
  cursorInput: {
    generation: string;
    baselineExpiresAt: string;
    previousCursor?: StoreSampleCursorV1;
  };
  error: unknown;
  remoteRequests: number;
  observedAt: string;
  profileObservation: StoreSampleProfileObservationV1 | null;
}): StoreSampleRuntimeResultV1 {
  if (input.request.action.kind !== 'store-sample') {
    throw new TypeError('Failed Store Sample materialization requires a Store action.');
  }
  const previous = input.cursorInput.previousCursor;
  const mode = input.request.action.mode;
  return {
    status: 'partial',
    mode,
    pages: [],
    uniqueOffers: [],
    categories: [],
    profileObservation: input.profileObservation === null
      ? null
      : structuredClone(input.profileObservation),
    cursor: {
      memberId: input.identity.memberId,
      canonicalShopUrl: canonical1688ShopUrl(input.identity.canonicalShopUrl),
      sortType: 'wangpu_score',
      count: 30,
      generation: input.cursorInput.generation,
      observedPages: previous?.observedPages ?? [],
      nextPage: input.request.action.pageScope.firstPage,
      sourceOfferCount: previous?.sourceOfferCount ?? null,
      sourceTotalPages: previous?.sourceTotalPages ?? null,
      categoriesObservedAt: previous?.categoriesObservedAt ?? null,
      baselineObservedAt: previous?.baselineObservedAt ?? input.observedAt,
      baselineExpiresAt: input.cursorInput.baselineExpiresAt,
      checkpointState: 'incomplete',
      exhausted: false,
    },
    taskCandidateEligible: false,
    evidenceUsage: mode === 'phase-1-bounded' ? 'baseline-evidence' : 'cache-seed-only',
    remoteRequests: input.remoteRequests,
    failedPages: [input.request.action.pageScope.firstPage],
    errorCode: remoteFailureCode(input.error),
  };
}

export async function persistStoreSampleCursorArtifactV1(input: {
  artifactDirectory: string;
  cursor: StoreSampleCursorV1;
}): Promise<void> {
  const content = {
    schema: 'collector.store-sample-cursor-artifact.v1' as const,
    generation: input.cursor.generation,
    cursor: structuredClone(input.cursor),
  };
  const artifact: StoreSampleCursorArtifactV1 = {
    ...content,
    contentHash: canonicalCollectorSha256V1(content),
  };
  const destination = storeSampleCursorArtifactPath(
    input.artifactDirectory,
    input.cursor.generation,
  );
  await fs.mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomically(destination, artifact);
}

export async function resolveStoreSampleCursorArtifactV1(input: {
  artifactDirectory: string;
  baselineGeneration: string;
}): Promise<StoreSampleCursorV1> {
  const artifactPath = storeSampleCursorArtifactPath(
    input.artifactDirectory,
    input.baselineGeneration,
  );
  let artifact: StoreSampleCursorArtifactV1;
  try {
    artifact = JSON.parse(
      await fs.readFile(artifactPath, 'utf8'),
    ) as StoreSampleCursorArtifactV1;
  } catch {
    throw new CliError(
      2,
      'STORE_SAMPLE_EXPANSION_CURSOR_INVALID',
      'Persisted Store Sample cursor is unavailable or unreadable.',
    );
  }
  const { contentHash, ...content } = artifact;
  if (
    artifact.schema !== 'collector.store-sample-cursor-artifact.v1' ||
    artifact.generation !== input.baselineGeneration ||
    artifact.cursor?.generation !== input.baselineGeneration ||
    contentHash !== canonicalCollectorSha256V1(content)
  ) {
    throw new CliError(
      2,
      'STORE_SAMPLE_EXPANSION_CURSOR_INVALID',
      'Persisted Store Sample cursor is missing, corrupted, or belongs to another generation.',
    );
  }
  return structuredClone(artifact.cursor);
}

function storeSampleCursorArtifactPath(
  artifactDirectory: string,
  generation: string,
): string {
  if (!path.isAbsolute(artifactDirectory) || !generation.trim()) {
    throw new TypeError('Store Sample cursor artifact destination is invalid.');
  }
  const generationHash = createHash('sha256').update(generation, 'utf8').digest('hex');
  const destination = path.join(
    artifactDirectory,
    `store-sample-cursor-${generationHash}.json`,
  );
  const relative = path.relative(artifactDirectory, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('Store Sample cursor artifact destination escapes its root.');
  }
  return destination;
}

export async function persistOfferSourceSidecarV1(input: {
  artifactDirectory: string;
  sidecar: { artifactRef: string; artifact: OfferSourceSidecarV1 };
}): Promise<string> {
  assertOfferSourceSidecarBindingV1(
    input.sidecar.artifactRef,
    input.sidecar.artifact,
  );
  const match = input.sidecar.artifactRef.match(/^artifact:([A-Za-z0-9._-]+)$/u);
  if (!path.isAbsolute(input.artifactDirectory) || !match?.[1]) {
    throw new TypeError('Offer source artifact destination is invalid.');
  }
  const destination = path.join(input.artifactDirectory, `${match[1]}.json`);
  const relative = path.relative(input.artifactDirectory, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('Offer source artifact destination escapes its root.');
  }
  await fs.mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomically(destination, input.sidecar.artifact);
  return input.sidecar.artifactRef;
}

async function writePrivateJsonAtomically(
  destination: string,
  value: unknown,
): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(
      temporary,
      bytes,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await fs.readFile(destination, 'utf8') !== bytes) {
        throw new Error('Immutable Collector artifact already exists with different content.');
      }
    }
    await fs.chmod(destination, 0o600);
  } catch (error) {
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function canonical1688ShopUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/(?:^|\.)1688\.com$/iu.test(url.hostname)) {
    throw new TypeError('Canonical shop identity must contain an HTTPS 1688 URL.');
  }
  url.hash = '';
  return url.toString();
}

/** The new Search cohort has one navigation primitive: its compiled URL. */
export async function navigateCompiledSearchPageV1(input: {
  page: Page;
  compiledRequest: CompiledSearchPageRequestV1;
  admitRemoteAttempt(): Promise<void>;
  assertCheckpointAuthorized(operation: 'checkpoint'): Promise<void>;
  onRawResponse?: (rawResponseText: string) => Promise<void>;
}) {
  await input.admitRemoteAttempt();
  const capture = startSearchPageCaptureV1({
    page: input.page,
    compiledRequest: input.compiledRequest,
    timeoutMs: 20_000,
    ...(input.onRawResponse === undefined
      ? {}
      : { onRawResponse: input.onRawResponse }),
  });
  let observed: SearchPageCaptureV1;
  let navigationFailed = false;
  let authorizationFailed = false;
  try {
    const result = await capture.waitForAction(async () => {
      try {
        await input.assertCheckpointAuthorized('checkpoint');
      } catch (error) {
        authorizationFailed = true;
        throw error;
      }
      try {
        return await input.page.goto(
          input.compiledRequest.navigationUrl,
          { waitUntil: 'domcontentloaded', timeout: 30_000 },
        );
      } catch (error) {
        navigationFailed = true;
        throw error;
      }
    });
    observed = result.capture;
  } catch (error) {
    if (authorizationFailed) throw error;
    if (navigationFailed) throw typedNavigationFailure(error, 'SEARCH_NAVIGATION_FAILED');
    throw typedSearchCaptureFailureV1(error);
  }
  await input.assertCheckpointAuthorized('checkpoint');
  return observed;
}

function typedSearchCaptureFailureV1(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    9,
    'SEARCH_RESPONSE_SCHEMA_INVALID',
    'The correlated Search response did not satisfy its frozen response schema.',
    {
      category: 'protocol',
      retryable: true,
      recoveryAction: 'retry-search-page',
      cause: error instanceof Error ? error.name : 'UnknownSearchCaptureFailure',
    },
  );
}

type ScopedRemoteAdmissionInputV1 = Omit<
  RemoteAttemptAdmissionRequestV2,
  'pageActionId' | 'pageActionExecutionAttemptId'
>;

interface RemoteAttemptLedgerEntryV1 {
  input: ScopedRemoteAdmissionInputV1;
  receipt: RemoteAttemptAdmissionReceiptV2;
  terminal: RemoteRequestAttemptReceiptV1 | null;
  snapshot: SanitizedRemoteRequestSnapshotV1;
}

class RemoteAttemptLedgerV1 {
  private readonly entries = new Map<number, RemoteAttemptLedgerEntryV1>();
  private batches: CollectionBatch[] = [];

  constructor(
    private readonly request: PageActionRequestV1,
    private readonly delegate: PageActionExecutionScope,
    private readonly now: () => Date,
  ) {}

  scope(): PageActionExecutionScope {
    return {
      ...this.delegate,
      admitRemoteAttempt: async (input) => {
        try {
          const receipt = await this.delegate.admitRemoteAttempt(input);
          this.rememberAdmission(input, receipt);
          return receipt;
        } catch (error) {
          const admitted = admittedFailureEvidence(error);
          if (admitted !== null) {
            this.rememberAdmission(admitted.input, admitted.receipt);
          }
          throw error;
        }
      },
    };
  }

  nextOrdinal(): number {
    return this.entries.size + 1;
  }

  confirmAdmission(ordinal: number, receipt: RemoteAttemptAdmissionReceiptV2): void {
    const entry = this.requiredEntry(ordinal);
    if (
      entry.receipt.remoteActionStartId !== receipt.remoteActionStartId
      || entry.receipt.admittedAt !== receipt.admittedAt
    ) {
      throw new CliError(
        9,
        'REMOTE_ATTEMPT_ADMISSION_CONFLICT',
        `Remote attempt ${ordinal} received conflicting database admission receipts.`,
        { category: 'contract', retryable: false },
      );
    }
  }

  admittedAt(ordinal: number): string {
    return this.requiredEntry(ordinal).receipt.admittedAt;
  }

  recordSuccess(ordinal: number, completedAt: string, rawEvidenceRefs: string[]): void {
    const entry = this.entries.get(ordinal);
    if (entry === undefined) return;
    entry.terminal = {
      remoteRequestAttemptId: entry.input.remoteRequestAttemptId,
      ordinal,
      ...(entry.input.logicalPage === undefined ? {} : { logicalPage: entry.input.logicalPage }),
      purpose: entry.input.purpose,
      requestBusinessHash: entry.input.requestBusinessHash,
      startedAt: entry.receipt.admittedAt,
      completedAt: terminalTime(entry.receipt.admittedAt, completedAt),
      status: 'succeeded',
      rawEvidenceRefs: rawEvidenceRefs.length > 0
        ? [...rawEvidenceRefs]
        : [...(entry.terminal?.rawEvidenceRefs ?? [])],
    };
  }

  recordFailure(
    ordinal: number,
    error: unknown,
    completedAt: string,
    rawEvidenceRefs: string[] = [],
  ): void {
    const entry = this.entries.get(ordinal);
    if (entry === undefined) return;
    const collectorFailure = collectorRemoteFailureV1(error);
    entry.terminal = {
      remoteRequestAttemptId: entry.input.remoteRequestAttemptId,
      ordinal,
      ...(entry.input.logicalPage === undefined ? {} : { logicalPage: entry.input.logicalPage }),
      purpose: entry.input.purpose,
      requestBusinessHash: entry.input.requestBusinessHash,
      startedAt: entry.receipt.admittedAt,
      completedAt: terminalTime(entry.receipt.admittedAt, completedAt),
      status: collectorFailure.category === 'cancelled' ? 'cancelled' : 'failed',
      rawEvidenceRefs: rawEvidenceRefs.length > 0
        ? [...rawEvidenceRefs]
        : [...(entry.terminal?.rawEvidenceRefs ?? [])],
      error: collectorFailure,
    };
  }

  recordBatches(batches: CollectionBatch[]): void {
    this.batches = structuredClone(batches);
  }

  replaceTerminalEvidence(
    attempts: RemoteRequestAttemptReceiptV1[],
    snapshots: SanitizedRemoteRequestSnapshotV1[],
  ): void {
    if (attempts.length !== this.entries.size || snapshots.length !== attempts.length) {
      throw new CliError(
        9,
        'REMOTE_ATTEMPT_EVIDENCE_INCOMPLETE',
        'Terminal remote-attempt evidence does not cover every database admission.',
        { category: 'contract', retryable: false },
      );
    }
    for (const attempt of attempts) {
      const entry = this.requiredEntry(attempt.ordinal);
      const requestSnapshot = snapshots.find(
        (candidate) => candidate.remoteRequestAttemptId === attempt.remoteRequestAttemptId,
      );
      if (
        attempt.remoteRequestAttemptId !== entry.input.remoteRequestAttemptId
        || attempt.requestBusinessHash !== entry.input.requestBusinessHash
        || attempt.purpose !== entry.input.purpose
        || attempt.logicalPage !== entry.input.logicalPage
        || requestSnapshot === undefined
      ) {
        throw new CliError(
          9,
          'REMOTE_ATTEMPT_EVIDENCE_CONFLICT',
          `Terminal remote attempt ${attempt.ordinal} differs from its database admission.`,
          { category: 'contract', retryable: false },
        );
      }
      entry.terminal = structuredClone(attempt);
      entry.snapshot = structuredClone(requestSnapshot);
    }
  }

  fallbackEvidence(terminalAt: Date): {
    attempts: RemoteRequestAttemptReceiptV1[];
    snapshots: SanitizedRemoteRequestSnapshotV1[];
    batches: CollectionBatch[];
  } {
    const completedAt = terminalAt.toISOString();
    const entries = [...this.entries.values()].sort(
      (left, right) => left.input.ordinal - right.input.ordinal,
    );
    for (const entry of entries) {
      if (entry.terminal === null) {
        entry.terminal = {
          remoteRequestAttemptId: entry.input.remoteRequestAttemptId,
          ordinal: entry.input.ordinal,
          ...(entry.input.logicalPage === undefined ? {} : { logicalPage: entry.input.logicalPage }),
          purpose: entry.input.purpose,
          requestBusinessHash: entry.input.requestBusinessHash,
          startedAt: entry.receipt.admittedAt,
          completedAt: terminalTime(entry.receipt.admittedAt, completedAt),
          status: 'failed',
          rawEvidenceRefs: [],
          error: {
            code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN',
            category: 'protocol',
            retryable: false,
            actionRequired: null,
            recoveryAction: 'manual-reconcile-before-any-replacement-attempt',
          },
        };
      }
    }
    return {
      attempts: entries.map((entry) => structuredClone(entry.terminal!)),
      snapshots: entries.map((entry) => structuredClone(entry.snapshot)),
      batches: structuredClone(this.batches),
    };
  }

  private rememberAdmission(
    input: ScopedRemoteAdmissionInputV1,
    receipt: RemoteAttemptAdmissionReceiptV2,
  ): void {
    const existing = this.entries.get(input.ordinal);
    if (existing !== undefined) {
      this.confirmAdmission(input.ordinal, receipt);
      return;
    }
    if (input.ordinal !== this.entries.size + 1) {
      throw new CliError(
        9,
        'REMOTE_ATTEMPT_ADMISSION_GAP',
        'Remote-attempt admission ordinals must be contiguous.',
        { category: 'contract', retryable: false },
      );
    }
    this.entries.set(input.ordinal, {
      input: structuredClone(input),
      receipt: structuredClone(receipt),
      terminal: null,
      snapshot: snapshot({
        request: this.request,
        remoteRequestAttemptId: input.remoteRequestAttemptId,
        componentKey: this.request.actionKind,
        observedAt: receipt.admittedAt,
        purpose: input.purpose,
        requestBusinessHash: input.requestBusinessHash,
        ...(input.logicalPage === undefined ? {} : { logicalPage: input.logicalPage }),
      }),
    });
  }

  private requiredEntry(ordinal: number): RemoteAttemptLedgerEntryV1 {
    const entry = this.entries.get(ordinal);
    if (entry === undefined) {
      throw new CliError(
        9,
        'REMOTE_ATTEMPT_ADMISSION_MISSING',
        `Remote attempt ${ordinal} has no database admission receipt.`,
        { category: 'coordination', retryable: false },
      );
    }
    return entry;
  }
}

function admittedFailureEvidence(error: unknown): {
  input: ScopedRemoteAdmissionInputV1;
  receipt: RemoteAttemptAdmissionReceiptV2;
} | null {
  if (error === null || typeof error !== 'object') return null;
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  const input = (details as Record<string, unknown>)['admissionRequest'];
  const receipt = (details as Record<string, unknown>)['admissionReceipt'];
  if (
    input === null || typeof input !== 'object' || Array.isArray(input)
    || receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
  ) return null;
  return {
    input: input as ScopedRemoteAdmissionInputV1,
    receipt: receipt as unknown as RemoteAttemptAdmissionReceiptV2,
  };
}

function terminalTime(startedAt: string, completedAt: string): string {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return new Date(Math.max(started, completed)).toISOString();
}

function remoteFailureCode(error: unknown): string {
  if (
    error !== null
    && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'REMOTE_REQUEST_FAILED';
}

function singlePageContext(page: Page): BrowserContext {
  return { newPage: async () => page } as unknown as BrowserContext;
}

function remoteAttempt(
  id: string,
  requestBusinessHash: string,
  startedAt: string,
  completedAt: string,
  evidenceRef: string | string[],
  ordinal = 1,
  logicalPage?: number,
): RemoteRequestAttemptReceiptV1 {
  return {
    remoteRequestAttemptId: id,
    ordinal,
    ...(logicalPage === undefined ? {} : { logicalPage }),
    purpose: logicalPage === undefined ? 'single-target' : 'forward',
    requestBusinessHash,
    startedAt,
    completedAt,
    status: 'succeeded',
    rawEvidenceRefs: Array.isArray(evidenceRef) ? [...evidenceRef] : [evidenceRef],
  };
}

function snapshot(input: {
  request: PageActionRequestV1;
  remoteRequestAttemptId: string;
  componentKey: string;
  observedAt: string;
  purpose: SanitizedRemoteRequestSnapshotV1['purpose'];
  requestBusinessHash: string;
  logicalPage?: number;
}): SanitizedRemoteRequestSnapshotV1 {
  return {
    api: 'profile-daemon-page-action',
    componentKey: input.componentKey,
    pageActionId: input.request.pageActionId,
    pageActionExecutionAttemptId: input.request.pageActionExecutionAttemptId,
    remoteRequestAttemptId: input.remoteRequestAttemptId,
    purpose: input.purpose,
    subjectHash: canonicalCollectorSha256V1(input.request.logicalLineage.businessSubject),
    ...(input.logicalPage === undefined ? {} : { page: input.logicalPage }),
    requestBusinessHash: input.requestBusinessHash,
    observedAt: input.observedAt,
  };
}

function pageLifecycle() {
  return {
    baselinePages: 0,
    createdPages: 1,
    closedPages: 1,
    transferredPages: 0,
    remainingOwnedPages: 0 as const,
  };
}

function collectorError(code: string): CollectorErrorV1 {
  return {
    code,
    category: 'protocol',
    retryable: true,
    actionRequired: null,
    recoveryAction: 'lookup-terminal-receipt',
  };
}

function searchPaginationNoProgressErrorV1(): CliError {
  return new CliError(
    9,
    'SEARCH_PAGINATION_NO_PROGRESS',
    'Search reported more pages without advancing its verified observation universe.',
    {
      category: 'protocol',
      retryable: true,
      recoveryAction: 'open-new-search-generation',
    },
  );
}

function typedNavigationFailure(error: unknown, code: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError(9, code, 'The admitted browser navigation failed.', {
    category: 'network',
    retryable: true,
    recoveryAction: 'retry-admitted-navigation',
    cause: error instanceof Error ? error.name : 'UnknownNavigationFailure',
  });
}

function stagedOfferRawComponentsV1(
  offer: Awaited<ReturnType<typeof collectOfferOnPage>>,
): Array<readonly [
  'core' | 'sku' | 'detail' | 'shop-card' | 'consignment',
  unknown,
]> {
  const captured = readOfferSourceCaptureEvidenceV1(offer);
  if (
    captured === null
    || captured.components.core === null
    || captured.components.core === undefined
    || captured.components.sku === null
    || captured.components.sku === undefined
  ) {
    throw new CliError(
      9,
      'OFFER_RAW_CAPTURE_INCOMPLETE',
      'Offer authority passed, but required staged core/SKU evidence is unavailable.',
      {
        category: 'protocol',
        retryable: false,
        recoveryAction: 'recollect-offer-with-staged-raw-evidence',
      },
    );
  }
  const components: Array<readonly [
    'core' | 'sku' | 'detail' | 'shop-card' | 'consignment',
    unknown,
  ]> = [
    ['core', captured.components.core],
    ['sku', captured.components.sku],
    ['detail', captured.components.detail],
    ['shop-card', captured.shopCard.rawPayload],
    ['consignment', captured.consignment.rawPayload],
  ];
  return components.flatMap(([component, payload]) =>
    payload === null || payload === undefined
      ? []
      : [[component, payload] as const]
  );
}

function offerRawArchiveDescriptor(
  component: 'core' | 'sku' | 'detail' | 'shop-card' | 'consignment',
): { kind: CollectorRawArchiveKindV1; parserRevision: string } {
  switch (component) {
    case 'core':
      return { kind: 'offer-core', parserRevision: 'offer-core-v1@1' };
    case 'sku':
      return { kind: 'offer-sku', parserRevision: 'offer-sku-v1@1' };
    case 'detail':
      return { kind: 'offer-detail', parserRevision: 'offer-detail-media-v2@1' };
    case 'shop-card':
      return { kind: 'offer-shop-card', parserRevision: 'offer-shop-card-v1@1' };
    case 'consignment':
      return { kind: 'offer-consignment', parserRevision: 'offer-consignment-v1@1' };
  }
}

function isRetryableCollectorBoundary(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  if (['RISK_CONTROL', 'NOT_LOGGED_IN', 'COLLECTION_CANCELLED'].includes(error.code)) {
    return false;
  }
  if (error.details['retryable'] === false) return false;
  return error.details['retryable'] === true
    || ['network', 'timeout', 'protocol', 'catalog-runtime', 'qualification-runtime']
      .includes(String(error.details['category'] ?? ''));
}

function failedExecutionResponse(
  request: PageActionRequestV1,
  error: unknown,
  terminalAt: Date,
  receiptId: string,
  remoteEvidence: {
    attempts: RemoteRequestAttemptReceiptV1[];
    snapshots: SanitizedRemoteRequestSnapshotV1[];
    batches: CollectionBatch[];
  },
): PageActionExecuteResponseV1 {
  const outcomeUnknown = remoteEvidence.attempts.some(
    (attempt) => attempt.error?.code === 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN',
  );
  const collectorFailure = outcomeUnknown
    ? {
        code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN',
        category: 'protocol' as const,
        retryable: false,
        actionRequired: null,
        recoveryAction: 'manual-reconcile-before-any-replacement-attempt',
      }
    : collectorRemoteFailureV1(error);
  const content = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `execution-receipt-${receiptId}`,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    ...(request.predecessorExecutionAttemptReceipt === undefined
      ? {}
      : { predecessorExecutionAttemptReceipt: request.predecessorExecutionAttemptReceipt }),
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: request.executionLineage,
    executionLineageHash: request.executionLineageHash,
    outcome: scopeFailureOutcome(error),
    terminal: true as const,
    actionKind: request.actionKind,
    remoteRequestAttempts: remoteEvidence.attempts,
    batches: remoteEvidence.batches,
    requestSnapshots: remoteEvidence.snapshots,
    pageLifecycle: pageLifecycle(),
    metrics: {
      remoteRequests: remoteEvidence.attempts.length,
      terminalAtMs: terminalAt.getTime(),
      admittedEvidencePreserved: remoteEvidence.attempts.length,
      preservedBatches: remoteEvidence.batches.length,
    },
    error: collectorFailure,
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: {
      ...content,
      receiptHash: computeExecutionAttemptReceiptHashV1(content),
    },
  });
}

function collectorCategory(value: unknown): CollectorErrorV1['category'] {
  if (value === 'not_logged_in' || value === 'authentication') return 'authentication';
  if (value === 'risk_challenge' || value === 'risk-control') return 'risk-control';
  if (value === 'rate_limited' || value === 'rate-limited') return 'rate-limited';
  if (value === 'navigation_timeout') return 'timeout';
  return [
    'contract', 'protocol', 'authentication', 'risk-control', 'rate-limited',
    'timeout', 'network', 'cancelled', 'source-empty',
  ].includes(String(value))
    ? value as CollectorErrorV1['category']
    : 'protocol';
}

export function collectorRemoteFailureV1(error: unknown): CollectorErrorV1 {
  if (!(error instanceof CliError)) {
    return {
      code: 'PAGE_ACTION_EXECUTION_FAILED',
      category: 'protocol',
      retryable: false,
      actionRequired: null,
      recoveryAction: 'inspect-before-retry',
    };
  }
  const codeCategory: Partial<Record<string, CollectorErrorV1['category']>> = {
    NOT_LOGGED_IN: 'authentication',
    RISK_CONTROL: 'risk-control',
    RATE_LIMITED: 'rate-limited',
    COLLECTION_CANCELLED: 'cancelled',
    CANCELED: 'cancelled',
    SEARCH_RESPONSE_TIMEOUT: 'timeout',
    QUALIFICATION_RESPONSE_TIMEOUT: 'timeout',
    NETWORK_ERROR: 'network',
  };
  const category = codeCategory[error.code]
    ?? collectorCategory(error.details['category']);
  const actionRequired = typeof error.details['actionRequired'] === 'string'
    ? error.details['actionRequired']
    : category === 'authentication'
      ? 'login'
      : category === 'risk-control'
        ? 'risk-control'
        : null;
  const codeRecovery: Partial<Record<string, string>> = {
    COLLECTION_CANCELLED: 'stop-no-new-remote-attempts',
    CANCELED: 'stop-no-new-remote-attempts',
    NOT_LOGGED_IN: 'pause_for_manual_login',
    RISK_CONTROL: 'pause_for_manual_challenge',
    RATE_LIMITED: 'backoff',
  };
  return {
    code: error.code,
    category,
    retryable: error.details['retryable'] === true,
    actionRequired,
    recoveryAction: typeof error.details['recoveryAction'] === 'string'
      ? error.details['recoveryAction']
      : codeRecovery[error.code]
        ? codeRecovery[error.code]!
      : typeof error.details['failureKind'] === 'string'
        ? `handle-${error.details['failureKind']}`
        : 'inspect-before-retry',
  };
}

function scopeFailureOutcome(
  error: unknown,
): 'failed' | 'cancelled' | 'blocked' {
  const category = collectorRemoteFailureV1(error).category;
  return category === 'cancelled'
    ? 'cancelled'
    : category === 'authentication' || category === 'risk-control'
      ? 'blocked'
      : 'failed';
}

function opaqueEvidence(kind: string, value: string): string {
  return `runtime:${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

function sampleDelay(random: () => number, minimum: number, maximum: number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError('Random source must return a number in [0, 1).');
  }
  return minimum + Math.floor(value * (maximum - minimum + 1));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw collectionCancelledErrorV1();
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw collectionCancelledErrorV1();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(collectionCancelledErrorV1());
    };
    function done(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function collectionCancelledErrorV1(): CliError {
  return new CliError(9, 'COLLECTION_CANCELLED', 'PageAction was cancelled.', {
    category: 'cancelled',
    retryable: false,
    recoveryAction: 'stop-no-new-remote-attempts',
  });
}
