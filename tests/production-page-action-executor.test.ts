import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import {
  bindSearchRequestSnapshotsV1,
  bindSearchBatchRecoveryCutV1,
  collectorRemoteFailureV1,
  createSearchRecoveryArchivePageV1,
  assertReplayCaptureMatchesArchiveV1,
  assertOfferCoreMemberIdentityV1,
  assertSearchRecoveryArchiveBindingV1,
  persistOfferSourceSidecarV1,
  persistStoreSampleCursorArtifactV1,
  ProductionPageActionExecutor,
  navigateCompiledSearchPageV1,
  resolveStoreSampleCursorArtifactV1,
  resolveStoreSampleCursorInputV1,
  resolveSearchParameterArtifactV1,
  type SearchRecoveryArchiveV1,
} from '../src/daemon/production-page-action-executor.js';
import { createSearchPageBatch } from '../src/collection/search-batch.js';
import { normalizeCollectionBatch, type CollectionBatch } from '../src/collection/contracts.js';
import {
  canonicalCollectorSha256V1,
  computeExecutionLineageHashV1,
  computeLogicalLineageHashV1,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import {
  compileSearchPageRequestV1,
  compileSearchParameterSetV1,
} from '../src/session/search-compiler.js';
import { SEARCH_MTOP_API } from '../src/session/search-mtop.js';
import {
  createSearchSerializerCapabilitySnapshotV1,
  parseSearchFilterConfigSnapshotV1,
} from '../src/session/search-contract.js';
import {
  assertOfferSourceSidecarBindingV1,
  createOfferSourceSidecarV1,
} from '../src/session/offer-evidence.js';
import { CliError } from '../src/io/errors.js';

describe('Production PageAction bridge', () => {
  it('rejects an Offer core whose supplier differs from the signed member', () => {
    expect(() => assertOfferCoreMemberIdentityV1({
      supplier: { memberId: 'member-from-another-store' },
    }, 'member-signed')).toThrowError(expect.objectContaining({
      code: 'OFFER_CORE_MEMBER_MISMATCH',
    }));
  });

  it('fails an Offer PageAction before terminal publication on core member drift', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-offer-member-'));
    let remoteCalls = 0;
    let rawComponentCallbacks = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory,
      now: () => now,
      idFactory: () => 'offer-member-drift',
      collectOfferOnPage: async (_context, options) => {
        if (options.onRawComponent !== undefined) {
          rawComponentCallbacks++;
          await options.onRawComponent('core', '<html>wrong member</html>');
        }
        return {
          supplier: { memberId: 'member-from-another-store' },
        } as never;
      },
    }).execute(executableOfferRequest(now), {
      page: {} as never,
      pageSessionId: 'offer-member-page',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => {
        remoteCalls++;
        return {
          remoteActionStartId: `start-${input.ordinal}`,
          admittedAt: now.toISOString(),
        };
      },
      classifyUrl: async () => {},
      closeOwnedPage: async () => {},
    });
    expect(remoteCalls).toBe(1);
    expect(rawComponentCallbacks).toBe(0);
    expect(response.completionReceipt).toBeUndefined();
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      batches: [],
      remoteRequestAttempts: [{ rawEvidenceRefs: [] }],
      error: { code: 'OFFER_CORE_MEMBER_MISMATCH', retryable: false },
    });
    expect((await fs.readdir(artifactDirectory)).filter(
      (entry) => entry.startsWith('collector-raw-'),
    )).toEqual([]);
  });

  it('resolves a fresh Intent + filter snapshot through resolver/compiler without a seeded compiled artifact', () => {
    const filterSnapshot = parseSearchFilterConfigSnapshotV1({
      payload: {
        data: { data: { filterData: { filters: [{
          groupName: 'Supplier', label: 'Factory',
          urlKey: 'filtMemberTags', value: 'factory',
        }] } } },
      },
      snapshotId: 'filter-1', keyword: 'fixture',
      observedAt: '2026-07-31T07:00:00.000Z',
      expiresAt: '2026-07-31T09:00:00.000Z',
    });
    const capabilitySnapshot = createSearchSerializerCapabilitySnapshotV1({
      snapshotId: 'capability-1',
      observedAt: '2026-07-31T07:00:00.000Z',
      expiresAt: '2026-07-31T09:00:00.000Z',
      capabilities: [],
    });
    const parameterSet = resolveSearchParameterArtifactV1({
      schema: 'collector.search-parameter-source.v1',
      intent: {
        keyword: 'fixture', filterConfigSnapshotHash: filterSnapshot.snapshotHash,
        sort: 'relevance', selections: [], numeric: {}, maxPages: 2,
        maxOffers: 120, advertisementPolicy: 'exclude-p4p',
      },
      filterSnapshot,
      capabilitySnapshot,
    }, '2026-07-31T08:00:00.000Z');
    expect(parameterSet).toMatchObject({
      schema: 'canonical-search-parameter-set-v1', keyword: 'fixture',
      filterConfigSnapshotHash: filterSnapshot.snapshotHash,
      serializerCapabilitySnapshotHash: capabilitySnapshot.snapshotHash,
    });
  });

  it('binds safe replay to immutable predecessor page/candidate hashes before forwarding', () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 2, maxOffers: 120,
      advertisementPolicy: 'exclude-p4p',
    });
    const base = executableSearchRequest(now, parameterSet);
    if (base.action.kind !== 'search-list') throw new TypeError('Search action expected.');
    const baseAction = base.action;
    const predecessor = { receiptId: 'execution-receipt-1', receiptHash: canonicalCollectorSha256V1('receipt-1') };
    const request = {
      ...base,
      executionAttemptOrdinal: 2,
      predecessorExecutionAttemptReceipt: predecessor,
      action: {
        ...baseAction,
        request: {
          ...baseAction.request,
          searchSegmentId: 'segment-2', requestedStartPage: 2,
          forwardPageBudget: 1, replayPageBudget: 1, maxSafeReplayPages: 1,
        },
        recoveryHandle: {
          schema: 'search-recovery-handle-v1', handleId: 'recovery-handle-1',
          recoveryReceiptId: 'recovery-receipt-1', recoveryReceiptHash: '',
          searchQueryKeyHash: base.action.request.searchQueryKeyHash,
          previousSearchSegmentId: 'segment-1', checkpointPage: 1,
          allowedNextPage: 2, recoveryMode: 'safe-replay', maxSafeReplayPages: 1,
          encryptedNavigationArchiveRef: 'artifact:recovery-1',
          expiresAt: '2026-07-31T09:00:00.000Z', signingKeyId: 'key-1', signature: 'fixture',
        },
      },
    } as PageActionRequestV1;
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'session-1',
    });
    const mappedOffer = {
      offerId: '1001', title: 'Fixture',
      price: { text: '', min: null, max: null },
      purchase: { priceTiers: [], minimumQuantity: null, onePieceEligible: null },
      supplier: {
        name: null, loginId: null, memberId: null, shopUrl: null, years: null,
        badgeImageUrl: null, tradeService: {
          compositeScore: null, consultationScore: null, logisticsScore: null,
          disputeScore: null, returnScore: null, goodsScore: null,
          inspectionCreditUrl: null, sameDesignUrl: null,
        },
      },
      location: { province: null, city: null }, bizType: null,
      verified: { factory: false, business: false, superFactory: false },
      tags: [], demand: {
        orderCountText: null, orderCount: null, repurchaseRateText: null,
        repurchaseRate: null, soldCountText: null, soldCount: null,
        shopReturnRateText: null, shopReturnRate: null,
      },
      isP4P: false, turnover: null,
      url: 'https://detail.1688.com/offer/1001.html', image: null, images: [],
    };
    const responseBusinessHash = canonicalCollectorSha256V1('page-1-response');
    const capture = {
      compiledRequest, observedAt: now.toISOString(),
      page: {
        offers: [mappedOffer], rawItems: [], hasMore: true, found: 10,
        responseBusinessHash,
      },
      sanitizedRequest: {
        appId: '32517', method: 'getOfferList', page: 1, pageSize: 60,
        sort: 'normal', descendOrder: true,
        pageSessionHash: compiledRequest.pageSessionHash, filterParams: {},
        requestBusinessHash: compiledRequest.requestBusinessHash,
      },
    } as const;
    const ancestorCutBatch = bindSearchBatchRecoveryCutV1({
      batch: normalizeCollectionBatch({ ...createSearchPageBatch({
        unit: {
          schemaVersion: 1,
          unitId: `${base.logicalLineage.workUnitId}:search:1`,
          collectionTaskId: base.logicalLineage.collectionTaskId,
          kind: 'search-page',
          subject: { keyword: 'fixture' },
          scope: { requestedScope: 'page', pageSize: 60 },
        },
        batchId: 'ancestor-batch-1', page: 1, remoteSort: parameterSet.sortType,
        offers: [mappedOffer], rawItems: [], hasMore: true,
        startedAt: now.toISOString(), collectedAt: now.toISOString(),
        completedAt: now.toISOString(), rawEvidenceRefs: ['artifact:ancestor-search'],
      }), sourceRequestId: base.requestId }),
      logicalPage: 1,
      responseBusinessHash,
      advertisementPolicy: parameterSet.advertisementPolicy,
      searchSegmentId: 'segment-1',
      pageActionId: base.pageActionId,
      pageActionBusinessHash: base.pageActionBusinessHash,
      pageActionExecutionAttemptId: base.pageActionExecutionAttemptId,
      executionAttemptOrdinal: base.executionAttemptOrdinal,
      requestId: base.requestId,
      logicalLineageHash: base.logicalLineageHash,
      executionLineageHash: base.executionLineageHash,
    });
    const ancestorBatch = attachSearchPageActionEvidence(
      ancestorCutBatch,
      base,
      'segment-1',
    );
    const archiveContent = {
      schema: 'collector.search-recovery-archive.v1' as const,
      recoveryReceiptId: 'recovery-receipt-1',
      searchQueryKeyHash: baseAction.request.searchQueryKeyHash,
      querySnapshotHash: baseAction.request.querySnapshotHash,
      checkpointPage: 1,
      completedSearchSegmentIds: ['segment-1'],
      completedPageActionIds: [base.pageActionId],
      predecessorExecutionAttemptReceipt: predecessor,
      pages: [createSearchRecoveryArchivePageV1(ancestorBatch)],
    };
    const archive: SearchRecoveryArchiveV1 = {
      ...archiveContent,
      recoveryReceiptHash: canonicalCollectorSha256V1(archiveContent),
    };
    (request.action as Extract<PageActionRequestV1['action'], { kind: 'search-list' }>)
      .recoveryHandle!.recoveryReceiptHash = archive.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(archive, request)).not.toThrow();
    const inconsistentBatch = structuredClone(archive);
    inconsistentBatch.pages[0]!.batch.observations[0]!.offerId = '1002';
    inconsistentBatch.pages[0]!.batchContentHash = canonicalCollectorSha256V1(
      inconsistentBatch.pages[0]!.batch,
    );
    const { recoveryReceiptHash: _batchHash, ...inconsistentBatchContent } = inconsistentBatch;
    inconsistentBatch.recoveryReceiptHash = canonicalCollectorSha256V1(inconsistentBatchContent);
    const inconsistentBatchRequest = structuredClone(request);
    if (inconsistentBatchRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    inconsistentBatchRequest.action.recoveryHandle!.recoveryReceiptHash =
      inconsistentBatch.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(
      inconsistentBatch,
      inconsistentBatchRequest,
    ))
      .toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    const inconsistentDeclaration = structuredClone(archive);
    inconsistentDeclaration.pages[0]!.eligibleCandidateIdsHash = canonicalCollectorSha256V1('other');
    const { recoveryReceiptHash: _declarationHash, ...inconsistentDeclarationContent } =
      inconsistentDeclaration;
    inconsistentDeclaration.recoveryReceiptHash = canonicalCollectorSha256V1(
      inconsistentDeclarationContent,
    );
    const inconsistentDeclarationRequest = structuredClone(request);
    if (inconsistentDeclarationRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    inconsistentDeclarationRequest.action.recoveryHandle!.recoveryReceiptHash =
      inconsistentDeclaration.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(
      inconsistentDeclaration,
      inconsistentDeclarationRequest,
    ))
      .toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    const forgedCut = structuredClone(archive);
    const forgedScope = forgedCut.pages[0]!.batch.scope as Record<string, unknown>;
    const forgedRecoveryCut = forgedScope.searchRecoveryCut as Record<string, unknown>;
    forgedRecoveryCut.pageActionId = 'page-action-forged';
    forgedCut.pages[0]!.pageActionId = 'page-action-forged';
    forgedCut.completedPageActionIds = ['page-action-forged'];
    forgedCut.pages[0]!.batchContentHash = canonicalCollectorSha256V1(
      forgedCut.pages[0]!.batch,
    );
    const { recoveryReceiptHash: _forgedHash, ...forgedContent } = forgedCut;
    forgedCut.recoveryReceiptHash = canonicalCollectorSha256V1(forgedContent);
    const forgedRequest = structuredClone(request);
    if (forgedRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    forgedRequest.action.recoveryHandle!.recoveryReceiptHash = forgedCut.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(forgedCut, forgedRequest))
      .toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    const mutatedLineage = structuredClone(archive);
    const lineageEvidence = mutatedLineage.pages[0]!.batch.scope
      .collectorPageActionEvidence as Record<string, unknown>;
    const logicalLineage = lineageEvidence.logicalLineage as Record<string, unknown>;
    logicalLineage.collectionTaskId = 'task-forged-inside-lineage';
    mutatedLineage.pages[0]!.batchContentHash = canonicalCollectorSha256V1(
      mutatedLineage.pages[0]!.batch,
    );
    const { recoveryReceiptHash: _lineageHash, ...mutatedLineageContent } = mutatedLineage;
    mutatedLineage.recoveryReceiptHash = canonicalCollectorSha256V1(mutatedLineageContent);
    const mutatedLineageRequest = structuredClone(request);
    if (mutatedLineageRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    mutatedLineageRequest.action.recoveryHandle!.recoveryReceiptHash =
      mutatedLineage.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(
      mutatedLineage,
      mutatedLineageRequest,
    )).toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    const crossLineage = structuredClone(archive);
    const crossEvidence = crossLineage.pages[0]!.batch.scope
      .collectorPageActionEvidence as Record<string, unknown>;
    const crossExecution = crossEvidence.executionLineage as PageActionRequestV1['executionLineage'];
    crossExecution.logicalLineageId = 'logical-lineage-B';
    const crossExecutionHash = computeExecutionLineageHashV1(crossExecution);
    crossEvidence.executionLineageHash = crossExecutionHash;
    const crossCut = crossLineage.pages[0]!.batch.scope.searchRecoveryCut as Record<string, unknown>;
    crossCut.executionLineageHash = crossExecutionHash;
    crossLineage.pages[0]!.executionLineageHash = crossExecutionHash;
    crossLineage.pages[0]!.batchContentHash = canonicalCollectorSha256V1(
      crossLineage.pages[0]!.batch,
    );
    const { recoveryReceiptHash: _crossHash, ...crossContent } = crossLineage;
    crossLineage.recoveryReceiptHash = canonicalCollectorSha256V1(crossContent);
    const crossRequest = structuredClone(request);
    if (crossRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    crossRequest.action.recoveryHandle!.recoveryReceiptHash = crossLineage.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(crossLineage, crossRequest))
      .toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    const queryMismatch = structuredClone(archive);
    const queryEvidence = queryMismatch.pages[0]!.batch.scope
      .collectorPageActionEvidence as Record<string, unknown>;
    const queryLogical = queryEvidence.logicalLineage as PageActionRequestV1['logicalLineage'];
    if (queryLogical.businessSubject.kind !== 'search-list') throw new TypeError('Search expected.');
    queryLogical.businessSubject.searchQueryKeyHash = canonicalCollectorSha256V1('other-query');
    const queryLogicalHash = computeLogicalLineageHashV1(queryLogical);
    queryEvidence.logicalLineageHash = queryLogicalHash;
    const queryExecution = queryEvidence.executionLineage as PageActionRequestV1['executionLineage'];
    queryExecution.logicalLineageHash = queryLogicalHash;
    const queryExecutionHash = computeExecutionLineageHashV1(queryExecution);
    queryEvidence.executionLineageHash = queryExecutionHash;
    const queryCut = queryMismatch.pages[0]!.batch.scope.searchRecoveryCut as Record<string, unknown>;
    queryCut.logicalLineageHash = queryLogicalHash;
    queryCut.executionLineageHash = queryExecutionHash;
    queryMismatch.pages[0]!.logicalLineageHash = queryLogicalHash;
    queryMismatch.pages[0]!.executionLineageHash = queryExecutionHash;
    queryMismatch.pages[0]!.batchContentHash = canonicalCollectorSha256V1(
      queryMismatch.pages[0]!.batch,
    );
    const { recoveryReceiptHash: _queryHash, ...queryMismatchContent } = queryMismatch;
    queryMismatch.recoveryReceiptHash = canonicalCollectorSha256V1(queryMismatchContent);
    const queryMismatchRequest = structuredClone(request);
    if (queryMismatchRequest.action.kind !== 'search-list') throw new TypeError('Search expected.');
    queryMismatchRequest.action.recoveryHandle!.recoveryReceiptHash =
      queryMismatch.recoveryReceiptHash;
    expect(() => assertSearchRecoveryArchiveBindingV1(
      queryMismatch,
      queryMismatchRequest,
    )).toThrowError(expect.objectContaining({ code: 'SEARCH_RECOVERY_ARCHIVE_INVALID' }));
    expect(() => assertReplayCaptureMatchesArchiveV1(
      capture as never, archive, parameterSet,
    )).not.toThrow();
    expect(() => assertReplayCaptureMatchesArchiveV1(
      {
        ...capture,
        page: { ...capture.page, responseBusinessHash: canonicalCollectorSha256V1('drift') },
      } as never,
      archive,
      parameterSet,
    )).toThrowError(expect.objectContaining({ code: 'SEARCH_SAFE_REPLAY_DRIFT' }));

    const page2CompiledRequest = compileSearchPageRequestV1({
      parameterSet, page: 2, pageSessionId: 'session-1',
    });
    const page2ResponseBusinessHash = canonicalCollectorSha256V1('page-2-response');
    const page2Capture = {
      ...capture,
      compiledRequest: page2CompiledRequest,
      page: { ...capture.page, responseBusinessHash: page2ResponseBusinessHash },
      sanitizedRequest: {
        ...capture.sanitizedRequest,
        page: 2,
        pageSessionHash: page2CompiledRequest.pageSessionHash,
        requestBusinessHash: page2CompiledRequest.requestBusinessHash,
      },
    } as const;
    const page2BatchBase = structuredClone(ancestorBatch);
    page2BatchBase.batchId = 'ancestor-batch-2';
    page2BatchBase.unitId = `${base.logicalLineage.workUnitId}:search:2`;
    page2BatchBase.observations = page2BatchBase.observations.map((observation) => ({
      ...observation,
      sourcePage: 2,
      pageRank: 1,
      rawRank: 61,
    }));
    const page2Batch = bindSearchBatchRecoveryCutV1({
      batch: page2BatchBase,
      logicalPage: 2,
      responseBusinessHash: page2ResponseBusinessHash,
      advertisementPolicy: parameterSet.advertisementPolicy,
      searchSegmentId: 'segment-1',
      pageActionId: base.pageActionId,
      pageActionBusinessHash: base.pageActionBusinessHash,
      pageActionExecutionAttemptId: base.pageActionExecutionAttemptId,
      executionAttemptOrdinal: base.executionAttemptOrdinal,
      requestId: base.requestId,
      logicalLineageHash: base.logicalLineageHash,
      executionLineageHash: base.executionLineageHash,
    });
    const twoPageArchive = {
      ...archive,
      pages: [...archive.pages, createSearchRecoveryArchivePageV1(page2Batch)],
    };
    expect(() => assertReplayCaptureMatchesArchiveV1(
      page2Capture as never, twoPageArchive, parameterSet,
    )).not.toThrow();
  });

  it.each([
    [
      new CliError(9, 'NETWORK_ERROR', 'network', {
        category: 'network', retryable: true, recoveryAction: 'retry-admitted-navigation',
      }),
      { code: 'NETWORK_ERROR', category: 'network', retryable: true, actionRequired: null, recoveryAction: 'retry-admitted-navigation' },
    ],
    [
      new CliError(3, 'NOT_LOGGED_IN', 'login', {
        category: 'not_logged_in', retryable: false, recoveryAction: 'pause_for_manual_login',
      }),
      { code: 'NOT_LOGGED_IN', category: 'authentication', retryable: false, actionRequired: 'login', recoveryAction: 'pause_for_manual_login' },
    ],
    [
      new CliError(4, 'RISK_CONTROL', 'risk', {
        category: 'risk_challenge', retryable: false, recoveryAction: 'pause_for_manual_challenge',
      }),
      { code: 'RISK_CONTROL', category: 'risk-control', retryable: false, actionRequired: 'risk-control', recoveryAction: 'pause_for_manual_challenge' },
    ],
    [
      new CliError(9, 'SEARCH_RESPONSE_TIMEOUT', 'timeout', {
        category: 'timeout', retryable: true, recoveryAction: 'retry-search-page',
      }),
      { code: 'SEARCH_RESPONSE_TIMEOUT', category: 'timeout', retryable: true, actionRequired: null, recoveryAction: 'retry-search-page' },
    ],
    [
      new CliError(9, 'COLLECTION_CANCELLED', 'cancelled', {
        category: 'cancelled', retryable: false, recoveryAction: 'stop-no-new-remote-attempts',
      }),
      { code: 'COLLECTION_CANCELLED', category: 'cancelled', retryable: false, actionRequired: null, recoveryAction: 'stop-no-new-remote-attempts' },
    ],
  ])('preserves typed Collector remote failure semantics for %s', (error, expected) => {
    expect(collectorRemoteFailureV1(error)).toEqual(expected);
  });

  it('navigates Search only through the compiled URL and captures exact request parity', async () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture',
      sort: 'relevance',
      compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: { province: 'Zhejiang' },
      selectedOptions: [],
      maxPages: 1,
      maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet,
      page: 1,
      pageSessionId: 'owned-page-session-1',
    });
    const page = new FakeSearchPage(compiledRequest.outerDataJson);
    const authorization: string[] = [];

    const capture = await navigateCompiledSearchPageV1({
      page: page as unknown as Page,
      compiledRequest,
      admitRemoteAttempt: async () => { authorization.push('remote_attempt'); },
      assertCheckpointAuthorized: async (operation) => { authorization.push(operation); },
    });

    expect(page.navigationCalls).toEqual([{
      url: compiledRequest.navigationUrl,
      options: { waitUntil: 'domcontentloaded', timeout: 30_000 },
    }]);
    expect(page.clickCalls).toBe(0);
    expect(authorization).toEqual(['remote_attempt', 'checkpoint', 'checkpoint']);
    expect(capture).toMatchObject({
      compiledRequest,
      page: { offers: [], hasMore: false },
      sanitizedRequest: {
        page: 1,
        pageSize: 60,
        sort: 'normal',
        filterParams: { province: 'Zhejiang' },
      },
    });

    await expect(navigateCompiledSearchPageV1({
      page: new FakeSearchPage(
        compiledRequest.outerDataJson,
        false,
        false,
        null,
        true,
      ) as unknown as Page,
      compiledRequest,
      admitRemoteAttempt: async () => {},
      assertCheckpointAuthorized: async () => {},
    })).rejects.toMatchObject({
      code: 'SEARCH_RESPONSE_SCHEMA_INVALID',
      details: { category: 'protocol', retryable: true },
    });
  });

  it('rechecks authority after admission and before Search navigation', async () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture',
      sort: 'relevance',
      compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1',
      filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1',
      serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {},
      selectedOptions: [],
      maxPages: 1,
      maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet,
      page: 1,
      pageSessionId: 'owned-page-session-1',
    });
    const page = new FakeSearchPage(compiledRequest.outerDataJson);

    await expect(navigateCompiledSearchPageV1({
      page: page as unknown as Page,
      compiledRequest,
      admitRemoteAttempt: async () => {},
      assertCheckpointAuthorized: async () => {
        throw new Error('lease expired while admission journal was durable');
      },
    })).rejects.toThrow('lease expired while admission journal was durable');
    expect(page.navigationCalls).toEqual([]);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('closes the owned Page and commits an immutable failed receipt for pre-run errors', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-executor-'));
    const executor = new ProductionPageActionExecutor({
      artifactDirectory,
      now: () => now,
      idFactory: () => 'failure-1',
    });
    const closeReasons: string[] = [];
    const response = await executor.execute(failingSearchRequest(now), {
      page: new FakeSearchPage('{}') as never,
      pageSessionId: 'page-session-1',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async () => ({
        remoteActionStartId: 'remote-action-start-1',
        admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {},
      closeOwnedPage: async (reason) => { closeReasons.push(reason); },
    });
    expect(closeReasons).toEqual(['collector_terminal']);
    expect(response.completionReceipt).toBeUndefined();
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      terminal: true,
      batches: [],
      pageLifecycle: { remainingOwnedPages: 0 },
      error: { code: 'PAGE_ACTION_EXECUTION_FAILED' },
    });
  });

  it('preserves exact admitted Search evidence and its committed page batch when pacing fails', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-fallback-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 2, maxOffers: 120,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const compiled = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'page-session-1',
    });
    const admissions: Array<Record<string, unknown>> = [];
    const closeReasons: string[] = [];
    const executor = new ProductionPageActionExecutor({
      artifactDirectory,
      now: () => now,
      idFactory: () => 'fallback-1',
      pace: async () => { throw new Error('pacing transport interrupted'); },
    });
    const response = await executor.execute(
      executableSearchRequest(now, parameterSet),
      {
        page: new FakeSearchPage(compiled.outerDataJson, true) as never,
        pageSessionId: 'page-session-1',
        signal: new AbortController().signal,
        assertAuthorized: async () => {},
        admitRemoteAttempt: async (input) => {
          admissions.push(input);
          return {
            remoteActionStartId: `start-${input.ordinal}`,
            admittedAt: now.toISOString(),
          };
        },
        classifyUrl: async () => {},
        closeOwnedPage: async (reason) => { closeReasons.push(reason); },
      },
    );
    const receipt = response.executionAttemptReceipt;
    expect(closeReasons).toEqual(['collector_terminal']);
    expect(admissions).toEqual([expect.objectContaining({
      ordinal: 1, logicalPage: 1, purpose: 'forward',
      requestBusinessHash: compiled.requestBusinessHash,
    })]);
    expect(receipt).toMatchObject({
      outcome: 'failed',
      remoteRequestAttempts: [{
        remoteRequestAttemptId: 'remote-attempt-1-1',
        ordinal: 1, logicalPage: 1, purpose: 'forward', status: 'succeeded',
        requestBusinessHash: compiled.requestBusinessHash,
      }],
      requestSnapshots: [{
        remoteRequestAttemptId: 'remote-attempt-1-1',
        page: 1, purpose: 'forward', requestBusinessHash: compiled.requestBusinessHash,
      }],
      batches: [{ kind: 'search-page', status: 'completed' }],
      metrics: { remoteRequests: 1, admittedEvidencePreserved: 1, preservedBatches: 1 },
    });
  });

  it('rejects an ordinary page-2 Search action before any daemon remote call', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-page2-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 3, maxOffers: 120,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const request = executableSearchRequest(now, parameterSet);
    if (request.action.kind !== 'search-list') throw new TypeError('Search expected.');
    request.action.request.page = 2;
    let remoteCalls = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => 'page2-rejected',
      pace: async () => {},
    }).execute(request, {
      page: new FakeSearchPage('unused') as never,
      pageSessionId: 'page-session-1', signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async () => {
        remoteCalls++;
        return { remoteActionStartId: 'unexpected', admittedAt: now.toISOString() };
      },
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(remoteCalls).toBe(0);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      remoteRequestAttempts: [],
      error: { code: 'SEARCH_DIRECT_BEGIN_PAGE_PARITY_NOT_VERIFIED' },
    });
  });

  it('starts a page-1 Search at logical page 1 and covers its bounded reservation', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-page1-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 3, maxOffers: 120,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const outerRequests = [1, 2, 3].map((page) => compileSearchPageRequestV1({
      parameterSet, page, pageSessionId: 'page-session-1',
    }).outerDataJson);
    const admissions: Array<Record<string, unknown>> = [];
    let page1Id = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `page1-bounded-${++page1Id}`,
      pace: async () => {}, random: () => 0,
    }).execute(executableSearchRequest(now, parameterSet), {
      page: new FakeSearchPage(outerRequests, true) as never,
      pageSessionId: 'page-session-1', signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => {
        admissions.push(input);
        return { remoteActionStartId: `start-${input.ordinal}`, admittedAt: now.toISOString() };
      },
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(admissions.map((item) => item.logicalPage)).toEqual([1, 2, 3]);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'completed',
      batches: [
        { kind: 'search-page' },
        { kind: 'search-page' },
        { kind: 'search-page' },
      ],
    });
  });

  it('marks the maxOffers overflow cut in the committed Search Batch', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-overflow-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 2,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const compiled = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'page-session-1',
    });
    let id = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now,
      idFactory: () => `overflow-${++id}`, pace: async () => {},
    }).execute(executableSearchRequest(now, parameterSet), {
      page: new FakeSearchPage(compiled.outerDataJson, true, false, null, false, [
        { offerId: '9000', isP4P: true },
        { offerId: '1000', isP4P: false },
        { offerId: '1000', isP4P: false },
        { offerId: '2000', isP4P: false },
        { offerId: '3000', isP4P: false },
      ]) as never,
      pageSessionId: 'page-session-1', signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`, admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    const batch = response.executionAttemptReceipt.batches[0]!;
    expect(batch.observations.map((observation) => ({
      offerId: observation['offerId'],
      selection: observation['candidateSelectionState'],
      pageRank: observation['pageRank'],
    }))).toEqual([
      { offerId: '9000', selection: 'promoted-excluded', pageRank: 1 },
      { offerId: '1000', selection: 'selected', pageRank: 2 },
      { offerId: '2000', selection: 'selected', pageRank: 4 },
      { offerId: '3000', selection: 'offer-limit-overflow', pageRank: 5 },
    ]);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'completed',
      metrics: { uniqueOffers: 2 },
    });
  });

  it('records all no-progress Search responses as typed failed attempts before terminalizing', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-no-progress-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const compiled = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'page-session-1',
    });
    const request = executableSearchRequest(now, parameterSet);
    if (request.action.kind !== 'search-list') throw new TypeError('Search expected.');
    request.action.request.forwardPageBudget = 3;
    const page = new FakeSearchPage(compiled.outerDataJson, true, true);
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => 'no-progress-1',
      pace: async () => {}, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'page-session-1',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`, admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    const receipt = response.executionAttemptReceipt;
    expect(page.navigationCalls).toHaveLength(3);
    expect(receipt).toMatchObject({
      outcome: 'partial',
      batches: [],
      error: {
        code: 'SEARCH_PAGINATION_NO_PROGRESS', category: 'protocol', retryable: true,
        recoveryAction: 'open-new-search-generation',
      },
      remoteRequestAttempts: [
        { ordinal: 1, status: 'failed', error: { code: 'SEARCH_PAGINATION_NO_PROGRESS', category: 'protocol' } },
        { ordinal: 2, status: 'failed', error: { code: 'SEARCH_PAGINATION_NO_PROGRESS', category: 'protocol' } },
        { ordinal: 3, status: 'failed', error: { code: 'SEARCH_PAGINATION_NO_PROGRESS', category: 'protocol' } },
      ],
    });
    expect(receipt.remoteRequestAttempts.every((attempt) =>
      attempt.rawEvidenceRefs.length === 1
      && /^artifact:collector-raw-search-response-/u.test(attempt.rawEvidenceRefs[0]!)
    )).toBe(true);
  });

  it('preserves retryable Search network semantics through the terminal receipt', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-search-network-'));
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    await fs.writeFile(
      path.join(artifactDirectory, 'parameter-set.json'),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    const compiled = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'page-session-1',
    });
    const request = executableSearchRequest(now, parameterSet);
    if (request.action.kind !== 'search-list') throw new TypeError('Search expected.');
    request.action.request.forwardPageBudget = 3;
    const page = new FakeSearchPage(
      compiled.outerDataJson,
      false,
      false,
      new CliError(9, 'NETWORK_ERROR', 'fixture network failure', {
        category: 'network', retryable: true,
        recoveryAction: 'retry-admitted-navigation',
      }),
    );
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => 'network-1',
      pace: async () => {}, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'page-session-1',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`, admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    const receipt = response.executionAttemptReceipt;
    expect(page.navigationCalls).toHaveLength(3);
    expect(receipt.error).toEqual({
      code: 'NETWORK_ERROR', category: 'network', retryable: true,
      actionRequired: null, recoveryAction: 'retry-admitted-navigation',
    });
    expect(receipt.remoteRequestAttempts).toMatchObject([
      { ordinal: 1, status: 'failed', error: { category: 'network', retryable: true } },
      { ordinal: 2, status: 'failed', error: { category: 'network', retryable: true } },
      { ordinal: 3, status: 'failed', error: { category: 'network', retryable: true } },
    ]);
  });

  it('binds a Search capture to its successful retry instead of the same array index', () => {
    const parameterSet = compileSearchParameterSetV1({
      keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
      filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: `sha256:${'a'.repeat(64)}`,
      serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: `sha256:${'b'.repeat(64)}`,
      filterParams: {}, selectedOptions: [], maxPages: 1, maxOffers: 60,
      advertisementPolicy: 'exclude-p4p',
    });
    const compiledRequest = compileSearchPageRequestV1({
      parameterSet, page: 1, pageSessionId: 'session-1',
    });
    const responseBusinessHash = canonicalCollectorSha256V1('response');
    const runtime = {
      status: 'completed' as const,
      pages: [{
        compiledRequest, observedAt: '2026-07-31T08:00:01.000Z',
        page: { offers: [], rawItems: [], hasMore: false, found: 0, responseBusinessHash },
        sanitizedRequest: {
          appId: '32517', method: 'getOfferList', page: 1, pageSize: 60,
          sort: 'normal', descendOrder: true,
          pageSessionHash: compiledRequest.pageSessionHash, filterParams: {},
          requestBusinessHash: compiledRequest.requestBusinessHash,
        },
      }],
      attempts: [], offers: [], duplicates: [], terminalReason: 'source-end' as const,
      lastCompletedPage: 1, errorCode: null,
      createdPages: 1 as const, closedPages: 1 as const, remainingOwnedPages: 0 as const,
      pageAttemptBindings: [{
        logicalPage: 1, attemptOrdinal: 2, purpose: 'replay' as const,
        requestBusinessHash: compiledRequest.requestBusinessHash,
        responseBusinessHash,
      }],
    };
    const request = failingSearchRequest(new Date('2026-07-31T08:00:00.000Z'));
    const snapshots = bindSearchRequestSnapshotsV1({
      request, parameterSet, runtime,
      attempts: [
        {
          remoteRequestAttemptId: 'remote-1', ordinal: 1, logicalPage: 1,
          purpose: 'replay', requestBusinessHash: compiledRequest.requestBusinessHash,
          startedAt: '2026-07-31T08:00:00.000Z', completedAt: '2026-07-31T08:00:00.500Z',
          status: 'failed', rawEvidenceRefs: [],
        },
        {
          remoteRequestAttemptId: 'remote-2', ordinal: 2, logicalPage: 1,
          purpose: 'replay', requestBusinessHash: compiledRequest.requestBusinessHash,
          startedAt: '2026-07-31T08:00:00.500Z', completedAt: '2026-07-31T08:00:01.000Z',
          status: 'succeeded', rawEvidenceRefs: ['artifact:search'],
        },
      ],
    });
    expect(snapshots).toMatchObject([
      { remoteRequestAttemptId: 'remote-1', purpose: 'replay', page: 1 },
      { remoteRequestAttemptId: 'remote-2', purpose: 'replay', page: 1 },
    ]);
    expect(snapshots.map((snapshot) => snapshot.requestBusinessHash)).toEqual([
      compiledRequest.requestBusinessHash,
      compiledRequest.requestBusinessHash,
    ]);
  });

  it('persists content-addressed Offer source sidecars with private file mode', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'offer-sidecar-'));
    const sidecar = createOfferSourceSidecarV1({
      source: 'shop-card', offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T08:00:00.000Z',
      rawPayload: { data: { shopName: 'Fixture', contactPhone: '13800138000' } },
    });
    const artifactRef = await persistOfferSourceSidecarV1({ artifactDirectory, sidecar });
    const artifactId = artifactRef.slice('artifact:'.length);
    const artifactPath = path.join(artifactDirectory, `${artifactId}.json`);
    const archived = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    expect(() => assertOfferSourceSidecarBindingV1(artifactRef, archived)).not.toThrow();
    expect(archived.sanitizedRawPayload.data.contactPhone).toBe('[redacted]');
    expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);
  });

  it('resolves the persisted signed dormant baseline cursor for approved expansion', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-cursor-'));
    const request = {
      ...failingSearchRequest(now),
      pageActionExecutionAttemptId: 'expansion-attempt-1',
      actionKind: 'store-sample',
      action: {
        kind: 'store-sample', memberId: 'member-1',
        canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        canonicalShopUrl: 'https://fixture.1688.com/',
        canonicalShopIdentityReceiptId: 'identity-1',
        canonicalShopIdentityReceiptHash: canonicalCollectorSha256V1('identity'),
        mode: 'approved-expansion', pageScope: { firstPage: 4, lastPageInclusive: 6 },
        expansionApproval: {
          baselineGeneration: 'baseline-generation-1',
          baselineObservedAt: '2026-07-31T07:00:00.000Z',
          baselineExpiresAt: '2026-07-31T09:00:00.000Z',
          dormantNextPage: 4,
        },
      },
    } as unknown as PageActionRequestV1;
    const dormantCursor = {
      memberId: 'member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      sortType: 'wangpu_score' as const, count: 30 as const,
      generation: 'baseline-generation-1', observedPages: [1, 2, 3], nextPage: 4,
      sourceOfferCount: 590, sourceTotalPages: 20,
      categoriesObservedAt: '2026-07-31T07:00:00.000Z',
      baselineObservedAt: '2026-07-31T07:00:00.000Z',
      baselineExpiresAt: '2026-07-31T09:00:00.000Z',
      checkpointState: 'dormant' as const, exhausted: false,
    };
    await persistStoreSampleCursorArtifactV1({ artifactDirectory, cursor: dormantCursor });
    const resolvedCursor = await resolveStoreSampleCursorArtifactV1({
      artifactDirectory, baselineGeneration: 'baseline-generation-1',
    });
    const cursorInput = resolveStoreSampleCursorInputV1({
      request,
      identity: {
        memberId: 'member-1', canonicalShopUrl: 'https://fixture.1688.com/',
        receiptId: 'identity-1', receiptHash: canonicalCollectorSha256V1('identity'),
      },
      now, storeSampleFreshnessMs: 60_000, resolvedCursor,
    });
    expect(cursorInput).toMatchObject({
      generation: 'baseline-generation-1',
      baselineExpiresAt: '2026-07-31T09:00:00.000Z',
      previousCursor: {
        generation: 'baseline-generation-1', observedPages: [1, 2, 3],
        nextPage: 4, checkpointState: 'dormant', exhausted: false,
        sourceOfferCount: 590, sourceTotalPages: 20,
      },
    });
    expect(() => resolveStoreSampleCursorInputV1({
      request,
      identity: {
        memberId: 'member-1', canonicalShopUrl: 'https://fixture.1688.com/',
        receiptId: 'identity-1', receiptHash: canonicalCollectorSha256V1('identity'),
      },
      now, storeSampleFreshnessMs: 60_000,
    })).toThrowError(expect.objectContaining({
      code: 'STORE_SAMPLE_EXPANSION_CURSOR_INVALID',
    }));
    await expect(resolveStoreSampleCursorArtifactV1({
      artifactDirectory, baselineGeneration: 'unknown-generation',
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_EXPANSION_CURSOR_INVALID' });
  });

  it('admits Store navigation and every MTOP page as distinct exact network boundaries', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-store-'));
    const request = executableStoreRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-store.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'b2b-member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-store', receiptHash: canonicalCollectorSha256V1('identity-store'),
    }), { mode: 0o600 });
    const page = new FakeStorePage();
    const admissions: Array<Record<string, unknown>> = [];
    let id = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `store-fixture-${++id}`,
      pace: async () => {}, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'store-page-session',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => {
        admissions.push({ ...input, networkCallsBeforeBoundary: page.networkCalls });
        return {
          remoteActionStartId: `start-${input.ordinal}`,
          admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
        };
      },
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.networkCalls).toBe(4);
    expect(admissions.map((admission) => ({
      ordinal: admission.ordinal, logicalPage: admission.logicalPage,
      purpose: admission.purpose,
      networkCallsBeforeBoundary: admission.networkCallsBeforeBoundary,
    }))).toEqual([
      { ordinal: 1, logicalPage: 1, purpose: 'discovery', networkCallsBeforeBoundary: 0 },
      { ordinal: 2, logicalPage: 1, purpose: 'forward', networkCallsBeforeBoundary: 1 },
      { ordinal: 3, logicalPage: 2, purpose: 'forward', networkCallsBeforeBoundary: 2 },
      { ordinal: 4, logicalPage: 3, purpose: 'forward', networkCallsBeforeBoundary: 3 },
    ]);
    expect(admissions.every((admission) =>
      typeof admission.requestBusinessHash === 'string'
      && /^sha256:[0-9a-f]{64}$/u.test(admission.requestBusinessHash)
    )).toBe(true);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'completed',
      metrics: { remoteRequests: 4, catalogCandidatesPublished: 0 },
    });
    expect(response.executionAttemptReceipt.remoteRequestAttempts).toHaveLength(4);
    expect(response.executionAttemptReceipt.batches).toHaveLength(3);
    expect(response.executionAttemptReceipt.batches.every((batch) =>
      batch.rawEvidenceRefs.length === 4
      && batch.rawEvidenceRefs.every((ref) => /^artifact:collector-raw-store-response-/u.test(ref))
    )).toBe(true);
    expect(response.executionAttemptReceipt.batches.find(
      (batch) => batch.kind === 'store-profile',
    )?.observations).toEqual([
      expect.objectContaining({
        memberId: 'b2b-member-1',
        profile: expect.objectContaining({
          name: expect.objectContaining({
            availability: 'available', value: 'Fixture Store Header',
          }),
        }),
      }),
    ]);
  });

  it('archives an invalid Store page-1 response without publishing invented observations', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-store-invalid-'));
    const request = executableStoreRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-store.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'b2b-member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-store', receiptHash: canonicalCollectorSha256V1('identity-store'),
    }), { mode: 0o600 });
    const page = new FakeStorePage(true);
    let id = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `invalid-store-${++id}`,
      pace: async () => {}, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'store-page-session',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`,
        admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    const receipt = response.executionAttemptReceipt;
    expect(receipt).toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_SAMPLE_PAGE1_SUMMARY_INCOMPLETE' },
      metrics: { remoteRequests: 2, preservedBatches: 3 },
    });
    expect(receipt.remoteRequestAttempts[1]).toMatchObject({
      ordinal: 2, status: 'failed',
      rawEvidenceRefs: [expect.stringMatching(/^artifact:collector-raw-store-response-/u)],
    });
    expect(receipt.batches).toHaveLength(3);
    expect(receipt.batches.every((batch) => batch.rawEvidenceRefs.length === 2)).toBe(true);
    expect(receipt.batches.find((batch) => batch.kind === 'store-profile')?.observations)
      .toEqual([expect.objectContaining({ memberId: 'b2b-member-1' })]);
  });

  it('fails closed when the Store header omits required profile fields', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-store-header-'));
    const request = executableStoreRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-store.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'b2b-member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-store', receiptHash: canonicalCollectorSha256V1('identity-store'),
    }), { mode: 0o600 });
    const page = new FakeStorePage(false, true);
    let headerId = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `header-incomplete-${++headerId}`,
      pace: async () => {}, random: () => 0,
    }).execute(request, {
      page: page as never, pageSessionId: 'store-page-session',
      signal: new AbortController().signal, assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`,
        admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.networkCalls).toBe(1);
    expect(response.completionReceipt).toBeUndefined();
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' },
    });
    expect(response.executionAttemptReceipt.batches.find(
      (batch) => batch.kind === 'store-profile',
    )?.observations).toEqual([]);
  });

  it('fails closed when the parsed Store header URL belongs to another Store', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-store-url-'));
    const request = executableStoreRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-store.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'b2b-member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-store', receiptHash: canonicalCollectorSha256V1('identity-store'),
    }), { mode: 0o600 });
    const page = new FakeStorePage(
      false,
      false,
      'https://different-member.1688.com/',
    );
    let headerId = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `header-url-drift-${++headerId}`,
      pace: async () => {}, random: () => 0,
    }).execute(request, {
      page: page as never, pageSessionId: 'store-page-session',
      signal: new AbortController().signal, assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`,
        admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.networkCalls).toBe(1);
    expect(response.completionReceipt).toBeUndefined();
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' },
    });
    expect(response.executionAttemptReceipt.batches.find(
      (batch) => batch.kind === 'store-profile',
    )?.observations).toEqual([]);
  });

  it('fails closed when the parsed Store header member belongs to another Store', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-store-member-'));
    const request = executableStoreRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-store.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'b2b-member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-store', receiptHash: canonicalCollectorSha256V1('identity-store'),
    }), { mode: 0o600 });
    const page = new FakeStorePage(
      false,
      false,
      'https://fixture.1688.com/',
      'b2b-member-from-another-store',
    );
    let headerId = 0;
    const response = await new ProductionPageActionExecutor({
      artifactDirectory, now: () => now,
      idFactory: () => `header-member-drift-${++headerId}`,
      pace: async () => {}, random: () => 0,
    }).execute(request, {
      page: page as never, pageSessionId: 'store-page-session',
      signal: new AbortController().signal, assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`,
        admittedAt: now.toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.networkCalls).toBe(1);
    expect(response.completionReceipt).toBeUndefined();
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' },
    });
    expect(response.executionAttemptReceipt.batches.find(
      (batch) => batch.kind === 'store-profile',
    )?.observations).toEqual([]);
  });

  it('bounds Offer navigation retries and admits every retry independently', async () => {
    const now = new Date('2026-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-offer-retry-'));
    const request = executableOfferRequest(now);
    const page = new FakeFailingOfferPage();
    const admissions: Array<Record<string, unknown>> = [];
    let pacingCalls = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => 'offer-fixture',
      pace: async () => { pacingCalls++; }, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'offer-page-session',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => {
        admissions.push({ ...input, navigationCallsBeforeBoundary: page.navigationCalls });
        return {
          remoteActionStartId: `start-${input.ordinal}`,
          admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
        };
      },
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.navigationCalls).toBe(3);
    expect(pacingCalls).toBe(2);
    expect(admissions.map((admission) => ({
      ordinal: admission.ordinal,
      purpose: admission.purpose,
      navigationCallsBeforeBoundary: admission.navigationCallsBeforeBoundary,
    }))).toEqual([
      { ordinal: 1, purpose: 'single-target', navigationCallsBeforeBoundary: 0 },
      { ordinal: 2, purpose: 'single-target', navigationCallsBeforeBoundary: 1 },
      { ordinal: 3, purpose: 'single-target', navigationCallsBeforeBoundary: 2 },
    ]);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'failed',
      metrics: { remoteRequests: 3, admittedEvidencePreserved: 3 },
      remoteRequestAttempts: [
        { ordinal: 1, status: 'failed', error: {
          code: 'NETWORK_ERROR', category: 'network', retryable: true,
          actionRequired: null, recoveryAction: 'retry-admitted-navigation',
        } },
        { ordinal: 2, status: 'failed', error: {
          code: 'NETWORK_ERROR', category: 'network', retryable: true,
          actionRequired: null, recoveryAction: 'retry-admitted-navigation',
        } },
        { ordinal: 3, status: 'failed', error: {
          code: 'NETWORK_ERROR', category: 'network', retryable: true,
          actionRequired: null, recoveryAction: 'retry-admitted-navigation',
        } },
      ],
    });
  });

  it('admits Qualification navigation and every bounded runtime retry separately', async () => {
    // Qualification source mapping timestamps the observed payload internally;
    // keep the injected terminal clock deterministically later than that observation.
    const now = new Date('2030-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-qualification-'));
    const request = executableQualificationRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-qualification.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-qualification',
      receiptHash: canonicalCollectorSha256V1('identity-qualification'),
    }), { mode: 0o600 });
    const page = new FakeQualificationPage();
    const admissions: Array<Record<string, unknown>> = [];
    let pacingCalls = 0;
    let id = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now, idFactory: () => `qualification-fixture-${++id}`,
      pace: async () => { pacingCalls++; }, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: page as never, pageSessionId: 'qualification-page-session',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => {
        admissions.push({ ...input, networkCallsBeforeBoundary: page.networkCalls });
        return {
          remoteActionStartId: `start-${input.ordinal}`,
          admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
        };
      },
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    expect(page.networkCalls).toBe(4);
    expect(pacingCalls).toBe(2);
    expect(admissions.map((admission) => ({
      ordinal: admission.ordinal,
      purpose: admission.purpose,
      networkCallsBeforeBoundary: admission.networkCallsBeforeBoundary,
    }))).toEqual([
      { ordinal: 1, purpose: 'discovery', networkCallsBeforeBoundary: 0 },
      { ordinal: 2, purpose: 'single-target', networkCallsBeforeBoundary: 1 },
      { ordinal: 3, purpose: 'single-target', networkCallsBeforeBoundary: 2 },
      { ordinal: 4, purpose: 'single-target', networkCallsBeforeBoundary: 3 },
    ]);
    expect(response.executionAttemptReceipt).toMatchObject({
      outcome: 'completed',
      metrics: { remoteRequests: 4, qualificationSnapshots: 1 },
      remoteRequestAttempts: [
        { ordinal: 1, status: 'succeeded' },
        { ordinal: 2, status: 'failed', error: { code: 'QUALIFICATION_REQUEST_REJECTED' } },
        { ordinal: 3, status: 'failed', error: { code: 'QUALIFICATION_REQUEST_REJECTED' } },
        { ordinal: 4, status: 'succeeded' },
      ],
    });
  });

  it('retains archived Qualification bytes and its Batch when checkpoint cancellation is late', async () => {
    const now = new Date('2030-07-31T08:00:00.000Z');
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-qualification-cancel-'));
    const request = executableQualificationRequest(now);
    await fs.writeFile(path.join(artifactDirectory, 'identity-qualification.json'), JSON.stringify({
      schema: 'collector.canonical-shop-identity-artifact.v1',
      memberId: 'member-1', canonicalShopUrl: 'https://fixture.1688.com/',
      receiptId: 'identity-qualification',
      receiptHash: canonicalCollectorSha256V1('identity-qualification'),
    }), { mode: 0o600 });
    let id = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory, now: () => now,
      idFactory: () => `qualification-cancel-${++id}`,
      pace: async () => {}, random: () => 0,
    });
    const response = await executor.execute(request, {
      page: new FakeQualificationPage() as never,
      pageSessionId: 'qualification-page-session',
      signal: new AbortController().signal,
      assertAuthorized: async (operation) => {
        if (operation === 'checkpoint') {
          throw new CliError(9, 'COLLECTION_CANCELLED', 'fixture cancellation', {
            category: 'cancelled', retryable: false,
            recoveryAction: 'stop-no-new-remote-attempts',
          });
        }
      },
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `start-${input.ordinal}`,
        admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
      }),
      classifyUrl: async () => {}, closeOwnedPage: async () => {},
    });
    const receipt = response.executionAttemptReceipt;
    expect(receipt).toMatchObject({
      outcome: 'cancelled',
      error: {
        code: 'COLLECTION_CANCELLED', category: 'cancelled', retryable: false,
        recoveryAction: 'stop-no-new-remote-attempts',
      },
      batches: [expect.objectContaining({
        kind: 'store-qualification',
        rawEvidenceRefs: [expect.stringMatching(/^artifact:collector-raw-qualification-response-/u)],
      })],
    });
    expect(receipt.remoteRequestAttempts[3]).toMatchObject({
      ordinal: 4, status: 'cancelled',
      rawEvidenceRefs: [expect.stringMatching(/^artifact:collector-raw-qualification-response-/u)],
      error: { code: 'COLLECTION_CANCELLED', category: 'cancelled', retryable: false },
    });
  });
});

function attachSearchPageActionEvidence(
  batch: CollectionBatch,
  request: PageActionRequestV1,
  searchSegmentId: string,
): CollectionBatch {
  const evidence = {
    schema: 'collector.page-action-batch-evidence.v1' as const,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    logicalLineage: structuredClone(request.logicalLineage),
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: structuredClone(request.executionLineage),
    executionLineageHash: request.executionLineageHash,
    searchSegmentId,
  };
  return normalizeCollectionBatch({
    ...batch,
    scope: { ...batch.scope, collectorPageActionEvidence: evidence },
    observations: batch.observations.map((observation, index) => index === 0
      ? { ...observation, collectorPageActionEvidence: evidence }
      : observation),
  });
}

class FakeSearchPage extends EventEmitter {
  navigationCalls: Array<{ url: string; options: unknown }> = [];
  clickCalls = 0;

  constructor(
    private readonly outerDataJson: string | readonly string[],
    private readonly hasMore = false,
    private readonly emptyWithMore = false,
    private readonly navigationError: CliError | null = null,
    private readonly malformedResponse = false,
    private readonly responseOffers?: readonly Readonly<{
      offerId: string;
      isP4P: boolean;
    }>[],
  ) {
    super();
  }

  async goto(url: string, options: unknown): Promise<null> {
    this.navigationCalls.push({ url, options });
    if (this.navigationError) throw this.navigationError;
    const callIndex = this.navigationCalls.length - 1;
    const outerDataJson = Array.isArray(this.outerDataJson)
      ? this.outerDataJson[callIndex]!
      : this.outerDataJson;
    const responseUrl = `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${
      encodeURIComponent(outerDataJson)
    }`;
    this.emit('response', {
      url: () => responseUrl,
      text: async () => this.malformedResponse ? '{malformed-search-json' : JSON.stringify({
        ret: ['SUCCESS::ok'],
        data: {
          code: 200,
          success: true,
          data: {
            OFFER: {
              items: this.responseOffers?.map((offer) => ({ data: {
                offerId: offer.offerId,
                title: `Fixture offer ${offer.offerId}`,
                isP4P: String(offer.isP4P),
              } })) ?? (this.hasMore && !this.emptyWithMore
                ? [{ data: {
                    offerId: Array.isArray(this.outerDataJson)
                      ? String(1001 + callIndex)
                      : '1001',
                    title: 'Fixture offer',
                  } }]
                : []),
              hasMore: this.hasMore,
              found: this.hasMore ? 1 : 0,
            },
          },
        },
      }),
    });
    return null;
  }

  async click(): Promise<void> {
    this.clickCalls += 1;
    throw new Error('Search must not use click-driven pagination.');
  }
}

class FakeStorePage extends EventEmitter {
  networkCalls = 0;
  private currentUrl = 'about:blank';

  constructor(
    private readonly incompletePage1 = false,
    private readonly incompleteHeader = false,
    private readonly headerShopUrl = 'https://fixture.1688.com/',
    private readonly headerMemberId = 'b2b-member-1',
  ) { super(); }

  async goto(url: string): Promise<null> {
    this.networkCalls++;
    this.currentUrl = url;
    const data = encodeURIComponent(JSON.stringify({
      componentKey: 'wp_pc_common_header',
      params: JSON.stringify({ memberId: 'b2b-member-1' }),
    }));
    this.emit('response', {
      url: () => `https://h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.ModuleAsyncService/1.0/?data=${data}`,
      request: () => ({ postData: () => null }),
      text: async () => JSON.stringify({
        api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
        ret: ['SUCCESS::ok'],
        data: {
          success: true,
          data: this.incompleteHeader
            ? { mainCate: 'Tools' }
            : {
                memberId: this.headerMemberId,
                companyName: 'Fixture Store Header',
                commonUrl: { shopUrl: this.headerShopUrl },
              },
        },
      }),
    });
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Fixture Store'; }
  async waitForFunction(): Promise<void> {}

  async evaluate(_fn: unknown, arg?: { data?: { params?: string } }): Promise<unknown> {
    if (arg === undefined) return '';
    this.networkCalls++;
    const params = JSON.parse(arg.data?.params ?? '{}') as {
      memberId: string;
      appdata: { pageNum: number; count: number; sortType: string };
    };
    const page = params.appdata.pageNum;
    return {
      ret: ['SUCCESS::ok'],
      data: {
        content: {
          offerCount: 90,
          offerList: [{
            id: `${page}001`, memberId: params.memberId,
            subject: `Offer ${page}`, offerImages: [],
          }],
          offerCategoryDataModel: {
            offerCategoryList: this.incompletePage1 && page === 1
              ? []
              : [{ id: 'cat-1', name: 'Tools', count: 90 }],
          },
        },
      },
    };
  }
}

class FakeFailingOfferPage extends EventEmitter {
  navigationCalls = 0;

  async goto(): Promise<never> {
    this.navigationCalls++;
    throw new Error('fixture transport failure');
  }
}

class FakeQualificationPage extends EventEmitter {
  networkCalls = 0;
  private currentUrl = 'about:blank';
  private runtimeCalls = 0;

  async goto(url: string): Promise<null> {
    this.networkCalls++;
    this.currentUrl = url;
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Fixture Qualification'; }
  async waitForFunction(): Promise<void> {}

  async evaluate(_fn: unknown, arg?: { data?: { componentKey?: string; params?: string } }): Promise<unknown> {
    if (arg === undefined) return '';
    this.networkCalls++;
    this.runtimeCalls++;
    if (this.runtimeCalls < 3) throw new Error('fixture runtime rejection');
    const params = JSON.parse(arg.data?.params ?? '{}') as { memberId?: string };
    const outer = encodeURIComponent(JSON.stringify({
      componentKey: arg.data?.componentKey,
      params: JSON.stringify({ memberId: params.memberId }),
    }));
    this.emit('response', {
      url: () => `https://h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.ModuleAsyncService/1.0/?data=${outer}`,
      request: () => ({ postData: () => null }),
      text: async () => JSON.stringify({
        ret: ['SUCCESS::ok'],
        data: { memberId: params.memberId, certList: [], propaganda: { companyImg: [] } },
      }),
    });
    return null;
  }
}

function executableSearchRequest(
  now: Date,
  parameterSet: ReturnType<typeof compileSearchParameterSetV1>,
): PageActionRequestV1 {
  const request = failingSearchRequest(now);
  const subject = request.logicalLineage.businessSubject;
  if (subject.kind !== 'search-list') throw new TypeError('Search subject expected.');
  return {
    ...request,
    action: {
      kind: 'search-list',
      request: {
        schema: 'canonical-search-request-v1',
        searchQueryKeyHash: subject.searchQueryKeyHash,
        searchSegmentId: 'segment-1',
        querySnapshotHash: subject.querySnapshotHash,
        searchQueryIdentity: 'query-1',
        page: 1,
        keyword: parameterSet.keyword,
        filterConfigSnapshotId: parameterSet.filterConfigSnapshotId,
        filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
        compilerRevision: parameterSet.compilerRevision,
        serializerCapabilitySnapshotId: parameterSet.serializerCapabilitySnapshotId,
        serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
        sort: parameterSet.sort,
        canonicalParameterSetArtifactRef: 'artifact:parameter-set',
        canonicalParameterSetHash: parameterSet.parameterSetHash,
        requestedStartPage: 1,
        requestedEndPage: parameterSet.maxPages,
        maxOffers: parameterSet.maxOffers,
        advertisementPolicy: parameterSet.advertisementPolicy,
        forwardPageBudget: parameterSet.maxPages,
        replayPageBudget: 0,
        maxSafeReplayPages: 0,
      },
      executionHandle: {} as never,
    },
  };
}

function failingSearchRequest(now: Date): PageActionRequestV1 {
  const leaseNotAfter = new Date(now.getTime() + 10 * 60_000).toISOString();
  const pageActionBusinessHash = canonicalCollectorSha256V1('business');
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: 'logical-failure-1',
    collectionTaskId: 'task-1',
    workUnitId: 'work-1',
    pageActionId: 'page-action-1',
    pageActionBusinessHash,
    actionKind: 'search-list' as const,
    businessSubject: {
      kind: 'search-list' as const,
      searchQueryKeyHash: canonicalCollectorSha256V1('query'),
      querySnapshotHash: canonicalCollectorSha256V1('snapshot'),
    },
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: 'work-attempt-1',
    pageActionExecutionAttemptId: 'attempt-1',
    executionAttemptOrdinal: 1,
    requestId: 'request-1',
    idempotencyKey: 'idem-1',
    profile: {
      profileId: 'profile-1', profileName: 'profile-1',
      daemonInstanceId: 'daemon-1', contextGeneration: 1, egressId: 'egress-1',
    },
    fences: {
      supervisor: failureFence('supervisor', leaseNotAfter),
      reservation: failureFence('reservation', leaseNotAfter),
      workUnit: failureFence('work', leaseNotAfter),
    },
  };
  return {
    schema: 'collector.page-action.request.v1',
    requestId: executionLineage.requestId,
    idempotencyKey: executionLineage.idempotencyKey,
    pageActionId: logicalLineage.pageActionId,
    pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
    executionAttemptOrdinal: 1,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: 'search-list',
    startNotBefore: now.toISOString(),
    leaseNotAfter,
    deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    policyRevisionIds: ['policy-1'],
    action: {
      kind: 'search-list',
      request: { canonicalParameterSetArtifactRef: 'artifact:missing' },
    } as never,
  };
}

function executableStoreRequest(now: Date): PageActionRequestV1 {
  const base = failingSearchRequest(now);
  const pageActionBusinessHash = canonicalCollectorSha256V1('store-business');
  const logicalLineage = {
    ...base.logicalLineage,
    logicalLineageId: 'logical-store-1',
    pageActionId: 'page-action-store-1',
    pageActionBusinessHash,
    actionKind: 'store-sample' as const,
    businessSubject: {
      kind: 'store-sample' as const,
      memberId: 'b2b-member-1',
      canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonicalShopUrl: 'https://fixture.1688.com/',
      canonicalShopIdentityReceiptId: 'identity-store',
      canonicalShopIdentityReceiptHash: canonicalCollectorSha256V1('identity-store'),
      pageScopeBusinessHash: canonicalCollectorSha256V1({ firstPage: 1, lastPageInclusive: 3 }),
    },
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    ...base.executionLineage,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
  };
  return {
    ...base,
    pageActionId: logicalLineage.pageActionId,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: 'store-sample',
    action: {
      kind: 'store-sample', memberId: 'b2b-member-1',
      canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonicalShopUrl: 'https://fixture.1688.com/',
      canonicalShopIdentityReceiptId: 'identity-store',
      canonicalShopIdentityReceiptHash: canonicalCollectorSha256V1('identity-store'),
      mode: 'phase-1-bounded', pageScope: { firstPage: 1, lastPageInclusive: 3 },
      executionHandle: {} as never,
    },
  };
}

function executableOfferRequest(now: Date): PageActionRequestV1 {
  const base = failingSearchRequest(now);
  const pageActionBusinessHash = canonicalCollectorSha256V1('offer-business');
  const logicalLineage = {
    ...base.logicalLineage,
    logicalLineageId: 'logical-offer-1',
    pageActionId: 'page-action-offer-1',
    pageActionBusinessHash,
    actionKind: 'offer-detail' as const,
    businessSubject: {
      kind: 'offer-detail' as const,
      offerId: '1001',
      memberId: 'member-1',
      searchOriginReceiptId: 'search-receipt-1',
      searchOriginReceiptHash: canonicalCollectorSha256V1('search-receipt'),
    },
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    ...base.executionLineage,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
  };
  return {
    ...base,
    pageActionId: logicalLineage.pageActionId,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: 'offer-detail',
    action: {
      kind: 'offer-detail', offerId: '1001', memberId: 'member-1',
      searchOriginReceiptId: 'search-receipt-1',
      searchOriginReceiptHash: canonicalCollectorSha256V1('search-receipt'),
      executionHandle: {} as never,
    },
  };
}

function executableQualificationRequest(now: Date): PageActionRequestV1 {
  const base = failingSearchRequest(now);
  const identityHash = canonicalCollectorSha256V1('identity-qualification');
  const pageActionBusinessHash = canonicalCollectorSha256V1('qualification-business');
  const logicalLineage = {
    ...base.logicalLineage,
    logicalLineageId: 'logical-qualification-1',
    pageActionId: 'page-action-qualification-1',
    pageActionBusinessHash,
    actionKind: 'store-qualification' as const,
    businessSubject: {
      kind: 'store-qualification' as const,
      memberId: 'member-1',
      canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonicalShopUrl: 'https://fixture-qualification.1688.com/',
      canonicalStoreIdentityReceiptId: 'identity-qualification',
      canonicalStoreIdentityReceiptHash: identityHash,
    },
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    ...base.executionLineage,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
  };
  return {
    ...base,
    pageActionId: logicalLineage.pageActionId,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: 'store-qualification',
    action: {
      kind: 'store-qualification', memberId: 'member-1',
      canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonicalShopUrl: 'https://fixture-qualification.1688.com/',
      canonicalStoreIdentityReceiptId: 'identity-qualification',
      canonicalStoreIdentityReceiptHash: identityHash,
      executionHandle: {} as never,
    },
  };
}

function failureFence(prefix: string, leaseNotAfter: string) {
  return {
    leaseId: `${prefix}-lease`,
    generation: 1,
    fencingToken: `${prefix}-fence`,
    leaseNotAfter,
  };
}
