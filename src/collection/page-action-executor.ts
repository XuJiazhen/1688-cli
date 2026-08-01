import type {
  CollectorErrorV1,
  PageActionCompletionReceiptV1,
  PageActionExecutionAttemptReceiptV1,
  PageActionExecuteResponseV1,
  PageActionExecutionAttemptReceiptRefV1,
  PageActionRequestV1,
  RemoteRequestAttemptReceiptV1,
  SanitizedRemoteRequestSnapshotV1,
} from './page-action-contracts.js';
import {
  PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  canonicalCollectorSha256V1,
  computeCompletionReceiptHashV1,
  computeExecutionAttemptReceiptHashV1,
  normalizePageActionExecuteResponseV1,
} from './page-action-contracts.js';
import type { CollectionBatch } from './contracts.js';
import { normalizeCollectionBatch } from './contracts.js';
import type { CanonicalSearchParameterSetV1 } from '../session/search-compiler.js';
import { verifyParameterSetHash } from '../session/search-compiler.js';
import type { OfferSourceTerminalReceiptV1 } from '../session/offer-evidence.js';
import { assertOfferSourceReceiptsCompleteV1 } from '../session/offer-evidence.js';
import type { QualificationMediaManifestV1 } from '../session/qualification-capture.js';
import { assertQualificationMediaManifestV1 } from '../session/qualification-capture.js';
import type { StoreSampleCursorV1 } from '../session/catalog-runtime.js';
import type { OfferMediaManifestV2 } from '../session/offer-media.js';
import type { OfferSkuManifestV1 } from './offer-batch.js';
import type { SearchTerminalReceiptV1 } from '../session/search-runtime.js';
import { assertSearchTerminalReceiptV1 } from '../session/search-runtime.js';
import { CliError } from '../io/errors.js';

export interface TrustedCanonicalShopIdentityV1 {
  memberId: string;
  canonicalShopUrl: string;
  receiptId: string;
  receiptHash: string;
}

export interface CollectorActionRunV1 {
  outcome: 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled';
  batches: CollectionBatch[];
  remoteRequestAttempts: RemoteRequestAttemptReceiptV1[];
  requestSnapshots: SanitizedRemoteRequestSnapshotV1[];
  pageLifecycle: PageActionExecutionAttemptReceiptV1['pageLifecycle'];
  metrics: Record<string, number>;
  error?: CollectorErrorV1;
  offerSources?: {
    shopCard: OfferSourceTerminalReceiptV1;
    consignment: OfferSourceTerminalReceiptV1;
  };
  offerMediaV2?: OfferMediaManifestV2;
  offerSkuManifest?: OfferSkuManifestV1;
  qualificationMedia?: QualificationMediaManifestV1;
  storeCursor?: StoreSampleCursorV1;
  searchTerminalReceipt?: SearchTerminalReceiptV1;
  storeSampleEvidenceUsage?: 'baseline-evidence' | 'cache-seed-only';
  catalogCandidatesPublished?: number;
  priorExecutionAttemptReceiptRefs?: PageActionExecutionAttemptReceiptRefV1[];
}

export interface CollectorPageActionExecutorPortsV1 {
  now(): Date;
  createId(kind: 'execution-receipt' | 'completion-receipt'): string;
  resolveCanonicalSearchParameterSet(
    artifactRef: string,
  ): Promise<CanonicalSearchParameterSetV1>;
  resolveCanonicalShopIdentity(
    receiptId: string,
    receiptHash: string,
  ): Promise<TrustedCanonicalShopIdentityV1>;
  runSearch(input: {
    request: PageActionRequestV1;
    parameterSet: CanonicalSearchParameterSetV1;
    signal?: AbortSignal;
  }): Promise<CollectorActionRunV1>;
  runOffer(input: {
    request: PageActionRequestV1;
    offerId: string;
    memberId: string;
    signal?: AbortSignal;
  }): Promise<CollectorActionRunV1>;
  runQualification(input: {
    request: PageActionRequestV1;
    memberId: string;
    signal?: AbortSignal;
  }): Promise<CollectorActionRunV1>;
  runStoreSample(input: {
    request: PageActionRequestV1;
    identity: TrustedCanonicalShopIdentityV1;
    signal?: AbortSignal;
  }): Promise<CollectorActionRunV1>;
}

export interface CollectorPageActionBatchEvidenceV1 {
  schema: 'collector.page-action-batch-evidence.v1';
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  logicalLineage: PageActionRequestV1['logicalLineage'];
  logicalLineageHash: string;
  executionLineage: PageActionRequestV1['executionLineage'];
  executionLineageHash: string;
  searchSegmentId?: string;
  predecessorExecutionAttemptReceipt?: PageActionRequestV1['predecessorExecutionAttemptReceipt'];
  search?: {
    terminalReceipt: SearchTerminalReceiptV1;
  };
  offer?: {
    sourceReceipts: NonNullable<CollectorActionRunV1['offerSources']>;
    skuManifest: OfferSkuManifestV1;
    mediaManifestV2: OfferMediaManifestV2;
  };
  qualification?: {
    mediaManifest: QualificationMediaManifestV1;
  };
  storeSample?: {
    cursor: StoreSampleCursorV1;
    evidenceUsage: NonNullable<CollectorActionRunV1['storeSampleEvidenceUsage']>;
  };
}

/** Executes only normalized PageAction requests; capability verification stays at daemon ingress. */
export async function executeCollectorPageActionV1(input: {
  request: PageActionRequestV1;
  ports: CollectorPageActionExecutorPortsV1;
  signal?: AbortSignal;
}): Promise<PageActionExecuteResponseV1> {
  const { request, ports } = input;
  assertPrePageDeadline(request, ports.now());
  let run: CollectorActionRunV1;
  let trustedStoreIdentity: TrustedCanonicalShopIdentityV1 | undefined;
  if (request.action.kind === 'search-list') {
    const parameterSet = await ports.resolveCanonicalSearchParameterSet(
      request.action.request.canonicalParameterSetArtifactRef,
    );
    verifyParameterSetHash(parameterSet);
    if (
      parameterSet.parameterSetHash !== request.action.request.canonicalParameterSetHash ||
      parameterSet.keyword !== request.action.request.keyword ||
      parameterSet.compilerRevision !== request.action.request.compilerRevision ||
      parameterSet.filterConfigSnapshotId !== request.action.request.filterConfigSnapshotId ||
      parameterSet.filterConfigSnapshotHash !== request.action.request.filterConfigSnapshotHash ||
      parameterSet.serializerCapabilitySnapshotId !== request.action.request.serializerCapabilitySnapshotId ||
      parameterSet.serializerCapabilitySnapshotHash !== request.action.request.serializerCapabilitySnapshotHash ||
      parameterSet.sort !== request.action.request.sort ||
      parameterSet.maxPages !== request.action.request.requestedEndPage ||
      parameterSet.maxOffers !== request.action.request.maxOffers ||
      parameterSet.advertisementPolicy !== request.action.request.advertisementPolicy
    ) {
      throw contractError('SEARCH_PARAMETER_SET_ARTIFACT_MISMATCH', 'Resolved search artifact does not match the signed PageAction request.');
    }
    run = await ports.runSearch({ request, parameterSet, signal: input.signal });
  } else if (request.action.kind === 'offer-detail') {
    run = await ports.runOffer({
      request,
      offerId: request.action.offerId,
      memberId: request.action.memberId,
      signal: input.signal,
    });
  } else if (request.action.kind === 'store-qualification') {
    const identity = await ports.resolveCanonicalShopIdentity(
      request.action.canonicalStoreIdentityReceiptId,
      request.action.canonicalStoreIdentityReceiptHash,
    );
    if (
      identity.memberId !== request.action.memberId ||
      identity.receiptId !== request.action.canonicalStoreIdentityReceiptId ||
      identity.receiptHash !== request.action.canonicalStoreIdentityReceiptHash
    ) {
      throw contractError('QUALIFICATION_IDENTITY_RECEIPT_MISMATCH', 'Qualification identity receipt belongs to another member.');
    }
    run = await ports.runQualification({
      request,
      memberId: request.action.memberId,
      signal: input.signal,
    });
  } else {
    const identity = await ports.resolveCanonicalShopIdentity(
      request.action.canonicalShopIdentityReceiptId,
      request.action.canonicalShopIdentityReceiptHash,
    );
    if (
      identity.memberId !== request.action.memberId ||
      identity.receiptId !== request.action.canonicalShopIdentityReceiptId ||
      identity.receiptHash !== request.action.canonicalShopIdentityReceiptHash
    ) {
      throw contractError('STORE_SAMPLE_IDENTITY_RECEIPT_MISMATCH', 'Store Sample identity receipt belongs to another member.');
    }
    trustedStoreIdentity = identity;
    assertStoreScopeBeforePage(request);
    run = await ports.runStoreSample({ request, identity, signal: input.signal });
  }
  assertTerminalRun(request, run, trustedStoreIdentity);
  run = persistCollectorPageActionEvidenceV1(request, run);
  assertPreTerminalDeadline(request, ports.now(), run);
  return buildResponse(request, run, ports);
}

function assertTerminalRun(
  request: PageActionRequestV1,
  run: CollectorActionRunV1,
  trustedStoreIdentity?: TrustedCanonicalShopIdentityV1,
): void {
  if (
    run.pageLifecycle.remainingOwnedPages !== 0
    || run.pageLifecycle.createdPages
      !== run.pageLifecycle.closedPages + run.pageLifecycle.transferredPages
  ) {
    throw contractError('PAGE_CLEANUP_FAILED', 'Terminal action run contains owned Page leakage.');
  }
  run.batches.forEach(normalizeCollectionBatch);
  if (run.outcome === 'completed' && run.batches.length === 0) {
    throw contractError('PAGE_ACTION_OUTPUT_MISSING', 'Completed PageAction requires at least one CollectionBatch.');
  }
  if (
    run.outcome === 'completed' &&
    run.batches.some((batch) => batch.status !== 'completed')
  ) {
    throw contractError('PAGE_ACTION_BATCH_INCOMPLETE', 'Completed PageAction cannot contain a partial, blocked, or failed Batch.');
  }
  if (request.action.kind === 'search-list') {
    const receipt = run.searchTerminalReceipt;
    if (run.outcome === 'completed' && receipt === undefined) {
      throw contractError('SEARCH_TERMINAL_RECEIPT_MISSING', 'Completed Search action requires a full terminal receipt.');
    }
    if (receipt) {
      assertSearchTerminalReceiptV1(receipt);
      if (
        receipt.collectionTaskId !== request.logicalLineage.collectionTaskId ||
        receipt.searchQueryKeyHash !== request.action.request.searchQueryKeyHash ||
        receipt.querySnapshotHash !== request.action.request.querySnapshotHash ||
        !receipt.completedSearchSegmentIds.includes(request.action.request.searchSegmentId) ||
        !receipt.completedPageActionIds.includes(request.pageActionId)
      ) {
        throw contractError('SEARCH_TERMINAL_RECEIPT_SCOPE_MISMATCH', 'Search terminal receipt belongs to another query, segment, or PageAction.');
      }
    }
    if (run.batches.some((batch) => batch.kind !== 'search-page')) {
      throw contractError('SEARCH_BATCH_KIND_INVALID', 'Search PageAction can emit only search-page batches.');
    }
  } else if (request.action.kind === 'offer-detail') {
    if (!run.offerSources) {
      if (run.outcome === 'completed') throw contractError('OFFER_SOURCE_RECEIPTS_MISSING', 'Completed Offer action requires both source receipts.');
    } else if (run.outcome === 'completed') {
      const sourceAttempt = run.remoteRequestAttempts.at(-1);
      if (!sourceAttempt || sourceAttempt.status !== 'succeeded') {
        throw contractError('OFFER_SOURCE_ATTEMPT_MISSING', 'Completed Offer action requires a successful terminal remote attempt.');
      }
      assertOfferSourceReceiptsCompleteV1({
        offerId: request.action.offerId,
        memberId: request.action.memberId,
        pageActionId: request.pageActionId,
        remoteRequestAttemptId: sourceAttempt.remoteRequestAttemptId,
        remoteRawEvidenceRefs: sourceAttempt.rawEvidenceRefs,
        ...run.offerSources,
      });
    }
    if (
      run.outcome === 'completed' &&
      (
        run.offerMediaV2?.offerId !== request.action.offerId ||
        run.offerMediaV2.availability === 'failed' ||
        run.offerSkuManifest?.offerId !== request.action.offerId ||
        run.offerSkuManifest.explicitSkuCount !== run.offerSkuManifest.skuIds.length
      )
    ) {
      throw contractError('OFFER_REQUIRED_COMPONENT_INCOMPLETE', 'Completed Offer action requires a valid SKU manifest and non-failed Media V2 manifest.');
    }
    if (run.batches.some((batch) => !['offer-detail', 'offer-media-manifest'].includes(batch.kind))) {
      throw contractError('OFFER_BATCH_KIND_INVALID', 'Offer PageAction emitted an unrelated Batch kind.');
    }
    if (run.outcome === 'completed') {
      const kinds = new Set(run.batches.map((batch) => batch.kind));
      if (!kinds.has('offer-detail') || !kinds.has('offer-media-manifest')) {
        throw contractError('OFFER_REQUIRED_BATCH_MISSING', 'Completed Offer action requires detail and Media V2 Batches.');
      }
    }
  } else if (request.action.kind === 'store-qualification') {
    if (run.batches.some((batch) => batch.kind !== 'store-qualification')) {
      throw contractError('QUALIFICATION_CATEGORY_FALLBACK_FORBIDDEN', 'Qualification cannot emit store-categories or any other Batch kind.');
    }
    if (
      run.outcome === 'completed' &&
      (!run.qualificationMedia || run.qualificationMedia.sourceCoverage === 'failed')
    ) {
      throw contractError('QUALIFICATION_MEDIA_INCOMPLETE', 'Completed Qualification requires complete or authoritative-empty media coverage.');
    }
    if (run.outcome === 'completed') {
      assertQualificationRunScope(request.action.memberId, run);
    }
  } else {
    if ((run.catalogCandidatesPublished ?? 0) !== 0) {
      throw contractError('STORE_SAMPLE_CANDIDATE_EXPANSION_FORBIDDEN', 'Store catalog observations can never publish Candidates.');
    }
    const kinds = new Set(run.batches.map((batch) => batch.kind));
    if (run.outcome === 'completed' && (!kinds.has('store-catalog') || !kinds.has('store-categories'))) {
      throw contractError('STORE_SAMPLE_OUTPUT_INCOMPLETE', 'Completed baseline Store Sample requires catalog and category Batches.');
    }
    if (
      request.action.mode === 'approved-expansion' &&
      run.storeSampleEvidenceUsage !== 'cache-seed-only'
    ) {
      throw contractError('STORE_SAMPLE_EXPANSION_EVIDENCE_FORBIDDEN', 'Approved expansion is cache-seed-only.');
    }
    if (run.outcome === 'completed') {
      if (!trustedStoreIdentity) {
        throw contractError('STORE_SAMPLE_IDENTITY_RECEIPT_MISSING', 'Completed Store Sample requires its resolved canonical identity.');
      }
      assertCompletedStoreCursor(request, run, trustedStoreIdentity);
    }
  }
}

function assertQualificationRunScope(
  memberId: string,
  run: CollectorActionRunV1,
): void {
  if (run.qualificationMedia) assertQualificationMediaManifestV1(run.qualificationMedia);
  if (
    run.qualificationMedia?.memberId !== memberId ||
    !run.qualificationMedia.sourceQualificationGeneration.trim() ||
    run.qualificationMedia.items.some(
      (item) =>
        item.role !== 'qualification' ||
        item.ownerKind !== 'store-qualification' ||
        item.memberId !== memberId,
    )
  ) {
    throw contractError('QUALIFICATION_SCOPE_MISMATCH', 'Qualification media evidence belongs to another member or generation.');
  }
  const qualificationBatch = run.batches.find((batch) => batch.kind === 'store-qualification');
  const observation = qualificationBatch?.observations[0];
  if (
    !observation ||
    observation['requestMemberId'] !== memberId ||
    observation['memberId'] !== memberId
  ) {
    throw contractError('QUALIFICATION_RESPONSE_SCOPE_MISMATCH', 'Completed Qualification Batch is not correlated to its requested member.');
  }
}

function assertCompletedStoreCursor(
  request: PageActionRequestV1,
  run: CollectorActionRunV1,
  identity: TrustedCanonicalShopIdentityV1,
): void {
  if (request.action.kind !== 'store-sample') {
    throw contractError('STORE_SAMPLE_ACTION_KIND_INVALID', 'Store cursor validation requires a Store Sample action.');
  }
  const action = request.action;
  const cursor = run.storeCursor;
  if (!cursor) {
    throw contractError('STORE_SAMPLE_CURSOR_MISSING', 'Completed Store Sample requires a durable cursor.');
  }
  const observedPages = cursor.observedPages;
  const lastObserved = observedPages.at(-1) ?? 0;
  const contiguousPages = Array.from({ length: lastObserved }, (_, index) => index + 1);
  if (
    cursor.memberId !== action.memberId ||
    canonicalStoreUrl(cursor.canonicalShopUrl) !== canonicalStoreUrl(identity.canonicalShopUrl) ||
    cursor.sortType !== 'wangpu_score' ||
    cursor.count !== 30 ||
    !cursor.generation.trim() ||
    JSON.stringify(observedPages) !== JSON.stringify(contiguousPages)
  ) {
    throw contractError('STORE_SAMPLE_CURSOR_SCOPE_MISMATCH', 'Store Sample cursor identity, generation, or observed pages are invalid.');
  }
  if (
    cursor.sourceTotalPages !== null &&
    (
      (cursor.exhausted && lastObserved < cursor.sourceTotalPages) ||
      (!cursor.exhausted && lastObserved >= cursor.sourceTotalPages)
    )
  ) {
    throw contractError('STORE_SAMPLE_CURSOR_EXHAUSTION_MISMATCH', 'Store Sample cursor exhaustion contradicts the observed source page total.');
  }
  const expectedActionPages = action.mode === 'phase-1-bounded'
    ? observedPages
    : observedPages.filter((page) => page >= action.pageScope.firstPage);
  const expectedPageSet = new Set(expectedActionPages);
  const succeededPages = [...new Set(
    run.remoteRequestAttempts
      .filter((attempt) => attempt.status === 'succeeded')
      .map((attempt) => attempt.logicalPage),
  )].sort((a, b) => (a ?? 0) - (b ?? 0));
  if (
    run.remoteRequestAttempts.some(
      (attempt) => attempt.logicalPage === undefined || !expectedPageSet.has(attempt.logicalPage),
    ) ||
    JSON.stringify(succeededPages) !== JSON.stringify(expectedActionPages)
  ) {
    throw contractError('STORE_SAMPLE_REMOTE_PAGE_SET_MISMATCH', 'Store Sample remote attempts do not exactly match its observed page set.');
  }
  if (action.mode === 'phase-1-bounded') {
    const endedBeforePage3 = lastObserved < action.pageScope.lastPageInclusive;
    if (
      lastObserved < 1 ||
      lastObserved > 3 ||
      (endedBeforePage3 && !cursor.exhausted) ||
      (!cursor.exhausted && (
        lastObserved !== 3 ||
        cursor.nextPage !== 4 ||
        cursor.checkpointState !== 'dormant'
      ))
    ) {
      throw contractError('STORE_SAMPLE_BASELINE_CURSOR_INVALID', 'Phase-1 Store Sample must end exhausted or at a dormant page-4 checkpoint.');
    }
  } else {
    const approval = action.expansionApproval;
    if (
      !approval ||
      cursor.generation !== approval.baselineGeneration ||
      cursor.baselineObservedAt !== approval.baselineObservedAt ||
      cursor.baselineExpiresAt !== approval.baselineExpiresAt ||
      action.pageScope.firstPage !== approval.dormantNextPage ||
      lastObserved < action.pageScope.firstPage
    ) {
      throw contractError('STORE_SAMPLE_EXPANSION_CURSOR_INVALID', 'Expansion cursor does not extend its signed fresh baseline generation.');
    }
    if (
      !cursor.exhausted &&
      (
        cursor.nextPage !== lastObserved + 1 ||
        cursor.checkpointState !== 'approved-expansion-active'
      )
    ) {
      throw contractError('STORE_SAMPLE_EXPANSION_CURSOR_INVALID', 'Non-exhausted expansion cursor must advance contiguously.');
    }
  }
  if (
    cursor.exhausted &&
    (cursor.nextPage !== null || cursor.checkpointState !== 'exhausted')
  ) {
    throw contractError('STORE_SAMPLE_EXHAUSTED_CURSOR_INVALID', 'Exhausted Store Sample cursor must have no next page.');
  }
}

function canonicalStoreUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(?:^|\.)1688\.com$/i.test(url.hostname)) throw new Error('host');
    url.hash = '';
    return url.toString();
  } catch {
    throw contractError('STORE_SAMPLE_CANONICAL_URL_INVALID', 'Store Sample identity contains an invalid canonical 1688 URL.');
  }
}

function persistCollectorPageActionEvidenceV1(
  request: PageActionRequestV1,
  run: CollectorActionRunV1,
): CollectorActionRunV1 {
  const base = {
    schema: 'collector.page-action-batch-evidence.v1' as const,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    logicalLineage: structuredClone(request.logicalLineage),
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: structuredClone(request.executionLineage),
    executionLineageHash: request.executionLineageHash,
    ...(request.action.kind === 'search-list'
      ? { searchSegmentId: request.action.request.searchSegmentId }
      : {}),
    ...(request.predecessorExecutionAttemptReceipt === undefined
      ? {}
      : {
          predecessorExecutionAttemptReceipt: structuredClone(
            request.predecessorExecutionAttemptReceipt,
          ),
        }),
  };
  let evidence: CollectorPageActionBatchEvidenceV1 = base;
  if (request.action.kind === 'search-list' && run.searchTerminalReceipt) {
    evidence = {
      ...base,
      search: { terminalReceipt: structuredClone(run.searchTerminalReceipt) },
    };
  } else if (
    request.action.kind === 'offer-detail' &&
    run.offerSources &&
    run.offerSkuManifest &&
    run.offerMediaV2
  ) {
    evidence = {
      ...base,
      offer: {
        sourceReceipts: structuredClone(run.offerSources),
        skuManifest: structuredClone(run.offerSkuManifest),
        mediaManifestV2: structuredClone(run.offerMediaV2),
      },
    };
  } else if (request.action.kind === 'store-qualification' && run.qualificationMedia) {
    evidence = {
      ...base,
      qualification: { mediaManifest: structuredClone(run.qualificationMedia) },
    };
  } else if (
    request.action.kind === 'store-sample' &&
    run.storeCursor &&
    run.storeSampleEvidenceUsage
  ) {
    evidence = {
      ...base,
      storeSample: {
        cursor: structuredClone(run.storeCursor),
        evidenceUsage: run.storeSampleEvidenceUsage,
      },
    };
  }
  const batches = run.batches.map((batch) =>
    batch.sourceRequestId === request.requestId
      ? attachBatchEvidence(batch, evidence)
      : batch
  );
  return { ...run, batches };
}

function attachBatchEvidence(
  batch: CollectionBatch,
  evidence: CollectorPageActionBatchEvidenceV1,
): CollectionBatch {
  const observations = batch.observations.map((observation, index) =>
    index === 0
      ? { ...observation, collectorPageActionEvidence: structuredClone(evidence) }
      : { ...observation }
  );
  return normalizeCollectionBatch({
    ...batch,
    scope: {
      ...batch.scope,
      collectorPageActionEvidence: structuredClone(evidence),
    },
    observations,
  });
}

function buildResponse(
  request: PageActionRequestV1,
  run: CollectorActionRunV1,
  ports: CollectorPageActionExecutorPortsV1,
): PageActionExecuteResponseV1 {
  const executionContent = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: ports.createId('execution-receipt'),
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    ...(request.predecessorExecutionAttemptReceipt
      ? { predecessorExecutionAttemptReceipt: request.predecessorExecutionAttemptReceipt }
      : {}),
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: request.executionLineage,
    executionLineageHash: request.executionLineageHash,
    outcome: run.outcome,
    terminal: true as const,
    actionKind: request.actionKind,
    remoteRequestAttempts: run.remoteRequestAttempts,
    batches: run.batches,
    requestSnapshots: run.requestSnapshots,
    pageLifecycle: run.pageLifecycle,
    metrics: run.metrics,
    ...(run.error ? { error: run.error } : {}),
  };
  const executionAttemptReceipt: PageActionExecutionAttemptReceiptV1 = {
    ...executionContent,
    receiptHash: computeExecutionAttemptReceiptHashV1(executionContent),
  };
  if (run.outcome !== 'completed') {
    return normalizePageActionExecuteResponseV1({ executionAttemptReceipt });
  }
  const attemptRef = {
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    receiptId: executionAttemptReceipt.receiptId,
    receiptHash: executionAttemptReceipt.receiptHash,
    executionLineageHash: request.executionLineageHash,
  };
  const priorRefs = run.priorExecutionAttemptReceiptRefs ?? [];
  if (request.executionAttemptOrdinal > 1 && priorRefs.length === 0) {
    // A replacement daemon knows only the signed direct predecessor. The DB
    // Archive owns the full immutable attempt chain and finalizes completion.
    return normalizePageActionExecuteResponseV1({ executionAttemptReceipt });
  }
  if (priorRefs.length !== request.executionAttemptOrdinal - 1) {
    throw contractError('PAGE_ACTION_ATTEMPT_CHAIN_INCOMPLETE', 'Completion requires every prior immutable execution-attempt receipt ref.');
  }
  if (request.executionAttemptOrdinal > 1) {
    const direct = priorRefs.at(-1);
    if (
      !direct ||
      direct.executionAttemptOrdinal !== request.executionAttemptOrdinal - 1 ||
      direct.receiptId !== request.predecessorExecutionAttemptReceipt?.receiptId ||
      direct.receiptHash !== request.predecessorExecutionAttemptReceipt?.receiptHash
    ) {
      throw contractError('PAGE_ACTION_PREDECESSOR_MISMATCH', 'Completion refs do not end at the signed direct predecessor.');
    }
  }
  const allRefs = [...priorRefs, attemptRef].sort(
    (a, b) => a.executionAttemptOrdinal - b.executionAttemptOrdinal || a.receiptHash.localeCompare(b.receiptHash),
  ) as [PageActionExecutionAttemptReceiptRefV1, ...PageActionExecutionAttemptReceiptRefV1[]];
  const completionContent = {
    schema: PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
    completionReceiptId: ports.createId('completion-receipt'),
    pageActionId: request.pageActionId,
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    actionKind: request.actionKind,
    status: 'completed' as const,
    terminal: true as const,
    executionAttemptReceiptRefs: allRefs,
    finalizedByExecutionRef: attemptRef,
    batches: run.batches as [CollectionBatch, ...CollectionBatch[]],
    completedAt: ports.now().toISOString(),
  };
  const completionReceipt: PageActionCompletionReceiptV1 = {
    ...completionContent,
    completionReceiptHash: computeCompletionReceiptHashV1(completionContent),
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt,
    completionReceipt,
  });
}

function assertStoreScopeBeforePage(request: PageActionRequestV1): void {
  if (request.action.kind !== 'store-sample') return;
  const count = request.action.pageScope.lastPageInclusive - request.action.pageScope.firstPage + 1;
  if (
    request.action.mode === 'phase-1-bounded' &&
    (request.action.pageScope.firstPage !== 1 || request.action.pageScope.lastPageInclusive !== 3)
  ) {
    throw contractError('STORE_SAMPLE_BASELINE_SCOPE_INVALID', 'Phase-1 scope is exactly pages 1 through 3.');
  }
  if (request.action.mode === 'approved-expansion' && (!Number.isInteger(count) || count < 3 || count > 10)) {
    throw contractError('STORE_SAMPLE_EXPANSION_SCOPE_INVALID', 'Approved expansion scope must contain 3 through 10 pages.');
  }
}

function assertPrePageDeadline(request: PageActionRequestV1, now: Date): void {
  if (now.getTime() < Date.parse(request.startNotBefore)) {
    throw contractError('PAGE_ACTION_NOT_STARTED', 'PageAction startNotBefore has not arrived.');
  }
  if (now.getTime() >= effectiveDeadline(request)) {
    throw contractError('PAGE_ACTION_DEADLINE_EXPIRED', 'PageAction effective deadline expired before Page creation.');
  }
}

function assertPreTerminalDeadline(
  request: PageActionRequestV1,
  now: Date,
  run: CollectorActionRunV1,
): void {
  if (run.outcome === 'completed' && now.getTime() >= effectiveDeadline(request)) {
    throw contractError('PAGE_ACTION_FENCE_EXPIRED', 'PageAction cannot write success after its deadline or fence expiry.');
  }
}

function effectiveDeadline(request: PageActionRequestV1): number {
  return Math.min(
    Date.parse(request.deadlineAt),
    Date.parse(request.leaseNotAfter),
    Date.parse(request.executionLineage.fences.supervisor.leaseNotAfter),
    Date.parse(request.executionLineage.fences.reservation.leaseNotAfter),
    Date.parse(request.executionLineage.fences.workUnit.leaseNotAfter),
  );
}

function contractError(code: string, message: string): CliError {
  return new CliError(9, code, message, {
    category: 'contract',
    retryable: false,
    recoveryAction: 'repair-page-action-request',
    detailsHash: canonicalCollectorSha256V1({ code, message }),
  });
}
