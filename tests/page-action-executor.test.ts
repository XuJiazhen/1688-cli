import { describe, expect, it, vi } from 'vitest';
import {
  canonicalCollectorSha256V1,
  computeExecutionLineageHashV1,
  computeLogicalLineageHashV1,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import {
  executeCollectorPageActionV1,
  type CollectorActionRunV1,
  type CollectorPageActionExecutorPortsV1,
} from '../src/collection/page-action-executor.js';
import { compileSearchParameterSetV1 } from '../src/session/search-compiler.js';
import { createOfferSourceTerminalReceiptV1 } from '../src/session/offer-evidence.js';
import { createSearchTerminalReceiptV1 } from '../src/session/search-runtime.js';
import type { CollectionBatch, CollectionKind } from '../src/collection/contracts.js';
import { buildOfferMediaManifestV2 } from '../src/session/offer-media.js';

const NOW = '2026-07-31T00:01:00.000Z';
const HASH = (value: string) => canonicalCollectorSha256V1(value);
const SHOP_SOURCE_REF = `artifact:offer-source-shop-card-${'a'.repeat(64)}`;
const CONSIGNMENT_SOURCE_REF = `artifact:offer-source-offer-consignment-${'b'.repeat(64)}`;

function batch(kind: CollectionKind, id = kind): CollectionBatch {
  const storePages = kind === 'store-catalog' ? [1, 2, 3] : [1];
  return {
    schemaVersion: 1, batchId: `batch-${id}`, unitId: 'work-unit-1',
    sourceRequestId: 'request-1', kind, status: 'completed',
    startedAt: NOW, completedAt: NOW,
    subject: {}, scope: { requestedScope: kind === 'store-catalog' ? 'bounded-pages' : 'page' },
    observations: [{
      fixture: true,
      ...(kind === 'store-qualification'
        ? { requestMemberId: 'b2b-member', memberId: 'b2b-member' }
        : {}),
    }],
    completeness: {
      requestedScope: kind === 'store-catalog' ? 'bounded-pages' : 'page',
      state: 'complete', observedPages: storePages, failedPages: [], uniqueItems: 1,
    },
    duplicateObservations: [], warnings: [], errors: [],
    rawEvidenceRefs: ['artifact:fixture'], metrics: { remoteRequests: 1 },
  };
}

function request(kind: PageActionRequestV1['actionKind']): PageActionRequestV1 {
  const subject = kind === 'search-list'
    ? { kind, searchQueryKeyHash: HASH('query'), querySnapshotHash: HASH('snapshot') }
    : kind === 'offer-detail'
      ? { kind, offerId: '100', memberId: 'b2b-member', searchOriginReceiptId: 'search-receipt', searchOriginReceiptHash: HASH('search') }
      : kind === 'store-qualification'
        ? { kind, memberId: 'b2b-member', canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', canonicalShopUrl: 'https://fixture.1688.com/', canonicalStoreIdentityReceiptId: 'identity-receipt', canonicalStoreIdentityReceiptHash: HASH('identity') }
        : { kind, memberId: 'b2b-member', canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', canonicalShopUrl: 'https://fixture.1688.com/', canonicalShopIdentityReceiptId: 'identity-receipt', canonicalShopIdentityReceiptHash: HASH('identity'), pageScopeBusinessHash: HASH('scope') };
  const action = kind === 'search-list'
    ? {
        kind,
        request: {
          schema: 'canonical-search-request-v1' as const,
          searchQueryKeyHash: subject.searchQueryKeyHash!, searchSegmentId: 'segment-1',
          querySnapshotHash: subject.querySnapshotHash!, keyword: 'fixture',
          searchQueryIdentity: 'query-1', page: 1,
          filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: HASH('filter'),
          compilerRevision: 'search-compiler-v1@1',
          serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: HASH('serializer'),
          sort: 'relevance' as const, canonicalParameterSetArtifactRef: 'artifact:parameter-set',
          canonicalParameterSetHash: '', requestedStartPage: 1, requestedEndPage: 3,
          maxOffers: 90, advertisementPolicy: 'exclude-p4p' as const,
          forwardPageBudget: 3, replayPageBudget: 0, maxSafeReplayPages: 0,
        },
        executionHandle: {} as never,
      }
    : kind === 'offer-detail'
      ? { ...subject, executionHandle: {} as never }
      : kind === 'store-qualification'
        ? { ...subject, executionHandle: {} as never }
        : {
            kind, memberId: subject.memberId!,
            canonicalStoreId: subject.canonicalStoreId!,
            canonicalShopUrl: subject.canonicalShopUrl!,
            canonicalShopIdentityReceiptId: subject.canonicalShopIdentityReceiptId!,
            canonicalShopIdentityReceiptHash: subject.canonicalShopIdentityReceiptHash!,
            mode: 'phase-1-bounded' as const,
            pageScope: { firstPage: 1, lastPageInclusive: 3 },
            executionHandle: {} as never,
          };
  const parameterSet = compileSearchParameterSetV1({
    keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
    filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: HASH('filter'),
    serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: HASH('serializer'),
    filterParams: {}, selectedOptions: [], maxPages: 3, maxOffers: 90,
    advertisementPolicy: 'exclude-p4p',
  });
  if (kind === 'search-list') action.request.canonicalParameterSetHash = parameterSet.parameterSetHash;
  const pageActionBusinessHash = HASH(`business-${kind}`);
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: `logical-${kind}`, collectionTaskId: 'collection-task-1',
    workUnitId: 'work-unit-1', pageActionId: `page-action-${kind}`,
    pageActionBusinessHash, actionKind: kind, businessSubject: subject,
  } as PageActionRequestV1['logicalLineage'];
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId, logicalLineageHash,
    workUnitAttemptId: 'work-attempt-1', pageActionExecutionAttemptId: `attempt-${kind}`,
    executionAttemptOrdinal: 1, requestId: 'request-1', idempotencyKey: `idem-${kind}`,
    profile: { profileId: 'profile-1', profileName: 'profile-1', daemonInstanceId: 'daemon-1', contextGeneration: 1, egressId: 'egress-1' },
    fences: Object.fromEntries(['supervisor', 'reservation', 'workUnit'].map((name) => [name, {
      leaseId: `${name}-lease`, generation: 1, fencingToken: `${name}-token`,
      leaseNotAfter: '2026-07-31T00:10:00.000Z',
    }])) as PageActionRequestV1['executionLineage']['fences'],
  };
  return {
    schema: 'collector.page-action.request.v1', requestId: 'request-1',
    idempotencyKey: `idem-${kind}`, pageActionId: `page-action-${kind}`,
    pageActionExecutionAttemptId: `attempt-${kind}`, executionAttemptOrdinal: 1,
    pageActionBusinessHash, logicalLineage, logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: kind, startNotBefore: '2026-07-31T00:00:00.000Z',
    leaseNotAfter: '2026-07-31T00:10:00.000Z', deadlineAt: '2026-07-31T00:09:00.000Z',
    policyRevisionIds: ['policy-1'], action: action as PageActionRequestV1['action'],
  };
}

function runFor(requestValue: PageActionRequestV1): CollectorActionRunV1 {
  const remoteRequestAttemptId = 'remote-1';
  const common = {
    offerId: '100', memberId: 'b2b-member', pageActionId: requestValue.pageActionId,
    remoteRequestAttemptId, responseObserved: true, responseSucceeded: true,
    correlatedOfferId: '100', correlatedMemberId: 'b2b-member',
  };
  const batches = requestValue.actionKind === 'search-list'
    ? [batch('search-page')]
    : requestValue.actionKind === 'offer-detail'
      ? [batch('offer-detail'), batch('offer-media-manifest')]
      : requestValue.actionKind === 'store-qualification'
        ? [batch('store-qualification')]
        : [batch('store-catalog'), batch('store-categories'), batch('store-profile')];
  const attemptPages = requestValue.actionKind === 'store-sample' ? [1, 2, 3] : [1];
  return {
    outcome: 'completed', batches,
    remoteRequestAttempts: attemptPages.map((logicalPage, index) => ({
      remoteRequestAttemptId: requestValue.actionKind === 'store-sample'
        ? `remote-${logicalPage}`
        : remoteRequestAttemptId,
      ordinal: index + 1, logicalPage, purpose: 'single-target' as const,
      requestBusinessHash: HASH('remote'), startedAt: NOW, completedAt: NOW,
      status: 'succeeded' as const,
      rawEvidenceRefs: requestValue.actionKind === 'offer-detail'
        ? [SHOP_SOURCE_REF, CONSIGNMENT_SOURCE_REF]
        : ['artifact:raw'],
    })),
    requestSnapshots: attemptPages.map((page) => ({
      api: 'fixture.api', pageActionId: requestValue.pageActionId,
      pageActionExecutionAttemptId: requestValue.pageActionExecutionAttemptId,
      remoteRequestAttemptId: requestValue.actionKind === 'store-sample'
        ? `remote-${page}`
        : remoteRequestAttemptId,
      purpose: 'single-target' as const,
      subjectHash: canonicalCollectorSha256V1(requestValue.logicalLineage.businessSubject),
      page, requestBusinessHash: HASH('remote'), observedAt: NOW,
    })),
    pageLifecycle: {
      baselinePages: 1, createdPages: 1, closedPages: 1,
      transferredPages: 0, remainingOwnedPages: 0,
    },
    metrics: { remoteRequests: 1 },
    ...(requestValue.action.kind === 'search-list' ? {
      searchTerminalReceipt: createSearchTerminalReceiptV1({
        collectionTaskId: requestValue.logicalLineage.collectionTaskId,
        searchQueryKeyHash: requestValue.action.request.searchQueryKeyHash,
        querySnapshotHash: requestValue.action.request.querySnapshotHash,
        completedSearchSegmentIds: [requestValue.action.request.searchSegmentId],
        completedPageActionIds: [requestValue.pageActionId],
        result: {
          status: 'completed', pages: [{
            compiledRequest: { page: 1 },
            page: { offers: [], responseBusinessHash: HASH('search-page-1') },
          }], attempts: [], pageAttemptBindings: [],
          offers: [], duplicates: [], terminalReason: 'source-end',
          lastCompletedPage: 1, errorCode: null,
          createdPages: 1, closedPages: 1, remainingOwnedPages: 0,
        } as never,
        eligibleCandidateIds: [], advertisementPolicy: 'exclude-p4p', terminalAt: NOW,
      }),
    } : {}),
    ...(requestValue.actionKind === 'offer-detail' ? {
      offerSources: {
        shopCard: createOfferSourceTerminalReceiptV1({ ...common, source: 'shop-card', rawEvidenceRefs: [SHOP_SOURCE_REF], parsedValue: { name: 'Shop' } as never }),
        consignment: createOfferSourceTerminalReceiptV1({ ...common, source: 'offer-consignment', rawEvidenceRefs: [CONSIGNMENT_SOURCE_REF], parsedValue: { name: 'Dropship' } as never }),
      },
      offerMediaV2: buildOfferMediaManifestV2({
        offerId: '100', sourceObservationId: 'offer-observation-1',
        sourcePayloadContentSha256: HASH('payload'),
        mainImage: 'https://cbu01.alicdn.com/main.jpg', galleryImages: [], skus: [],
        explicitSingleSkuWithoutPlatformId: true, detailImages: [],
        detailSourceState: 'not-present',
      }),
      offerSkuManifest: {
        schema: 'offer-sku-manifest-v1' as const, offerId: '100', state: 'offer-singleton' as const,
        explicitSkuCount: 0, skuIds: [], singletonSourceKey: 'singleton',
        optionCount: 0, nullFactsCarryAvailability: true as const, manifestHash: HASH('sku-manifest'),
      },
    } : {}),
    ...(requestValue.actionKind === 'store-qualification' ? {
      qualificationMedia: {
        memberId: 'b2b-member', sourceQualificationGeneration: 'qgen-1', role: 'qualification' as const,
        sourceCoverage: 'authoritative-empty' as const, items: [], itemSetHash: canonicalCollectorSha256V1([]),
        reasonCode: 'QUALIFICATION_MEDIA_SOURCE_EMPTY',
      },
    } : {}),
    ...(requestValue.actionKind === 'store-sample' ? {
      storeCursor: {
        memberId: 'b2b-member', canonicalShopUrl: 'https://fixture.1688.com/', sortType: 'wangpu_score' as const,
        count: 30 as const, generation: 'generation-1', observedPages: [1, 2, 3], nextPage: 4,
        sourceOfferCount: 590, sourceTotalPages: 20, categoriesObservedAt: NOW,
        baselineObservedAt: NOW, baselineExpiresAt: '2026-08-01T00:00:00.000Z',
        checkpointState: 'dormant' as const, exhausted: false,
      },
      storeSampleEvidenceUsage: 'baseline-evidence' as const,
      catalogCandidatesPublished: 0,
    } : {}),
  };
}

function ports(requestValue: PageActionRequestV1): CollectorPageActionExecutorPortsV1 {
  const parameterSet = compileSearchParameterSetV1({
    keyword: 'fixture', sort: 'relevance', compatibilitySortInput: null,
    filterConfigSnapshotId: 'filter-1', filterConfigSnapshotHash: HASH('filter'),
    serializerCapabilitySnapshotId: 'serializer-1', serializerCapabilitySnapshotHash: HASH('serializer'),
    filterParams: {}, selectedOptions: [], maxPages: 3, maxOffers: 90,
    advertisementPolicy: 'exclude-p4p',
  });
  return {
    now: () => new Date(NOW),
    createId: (kind) => `${kind}-1`,
    resolveCanonicalSearchParameterSet: async () => parameterSet,
    runSearch: vi.fn(async () => runFor(requestValue)),
    runOffer: vi.fn(async () => runFor(requestValue)),
    runQualification: vi.fn(async () => runFor(requestValue)),
    runStoreSample: vi.fn(async () => runFor(requestValue)),
  };
}

describe('exact four Collector PageAction executor', () => {
  it.each(['search-list', 'offer-detail', 'store-qualification', 'store-sample'] as const)(
    'executes %s and publishes one terminal attempt plus completion',
    async (kind) => {
      const requestValue = request(kind);
      const response = await executeCollectorPageActionV1({ request: requestValue, ports: ports(requestValue) });
      expect(response.executionAttemptReceipt).toMatchObject({
        actionKind: kind, outcome: 'completed', terminal: true,
        pageLifecycle: { remainingOwnedPages: 0 },
      });
      expect(response.completionReceipt).toMatchObject({ actionKind: kind, status: 'completed', terminal: true });
      const evidence = response.executionAttemptReceipt.batches
        .flatMap((entry) => entry.observations)
        .map((observation) => observation.collectorPageActionEvidence)
        .find(Boolean) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        schema: 'collector.page-action-batch-evidence.v1',
        pageActionId: requestValue.pageActionId,
        pageActionExecutionAttemptId: requestValue.pageActionExecutionAttemptId,
        logicalLineageHash: requestValue.logicalLineageHash,
        executionLineageHash: requestValue.executionLineageHash,
      });
      expect(response.executionAttemptReceipt.batches.every((entry) => {
        const batchEvidence = entry.scope.collectorPageActionEvidence as Record<string, unknown>;
        return batchEvidence?.pageActionId === requestValue.pageActionId
          && batchEvidence?.pageActionExecutionAttemptId
            === requestValue.pageActionExecutionAttemptId
          && batchEvidence?.logicalLineageHash === requestValue.logicalLineageHash
          && batchEvidence?.executionLineageHash === requestValue.executionLineageHash;
      })).toBe(true);
      if (kind === 'search-list') {
        expect(evidence).toHaveProperty('search.terminalReceipt.terminalReason', 'source-end');
        expect(evidence).toHaveProperty('search.terminalReceipt.eligibleSearchHitObservationSetHash');
        expect(evidence).toHaveProperty('search.terminalReceipt.eligibleCandidateSetHash');
      }
      if (kind === 'offer-detail') {
        expect(evidence).toHaveProperty('offer.sourceReceipts.shopCard.receiptContentHash');
        expect(evidence).toHaveProperty('offer.sourceReceipts.consignment.receiptContentHash');
        expect(evidence).toHaveProperty('offer.skuManifest.manifestHash');
        expect(evidence).toHaveProperty('offer.mediaManifestV2.itemSetHash');
      }
      if (kind === 'store-qualification') {
        expect(evidence).toHaveProperty('qualification.mediaManifest.itemSetHash');
      }
      if (kind === 'store-sample') {
        expect(evidence).toHaveProperty('storeSample.cursor.observedPages', [1, 2, 3]);
        expect(evidence).toHaveProperty('storeSample.evidenceUsage', 'baseline-evidence');
      }
    },
  );

  it('leaves replacement-attempt completion finalization to the authoritative Archive', async () => {
    const first = request('offer-detail');
    const executionLineage = {
      ...first.executionLineage,
      workUnitAttemptId: 'work-attempt-2',
      pageActionExecutionAttemptId: 'attempt-offer-detail-2',
      executionAttemptOrdinal: 2,
      requestId: 'request-2',
      idempotencyKey: 'idem-offer-detail-2',
    };
    const replacement: PageActionRequestV1 = {
      ...first,
      requestId: executionLineage.requestId,
      idempotencyKey: executionLineage.idempotencyKey,
      pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
      executionAttemptOrdinal: executionLineage.executionAttemptOrdinal,
      predecessorExecutionAttemptReceipt: {
        receiptId: 'execution-receipt-previous',
        receiptHash: HASH('previous-execution-receipt'),
      },
      executionLineage,
      executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    };

    const response = await executeCollectorPageActionV1({
      request: replacement,
      ports: ports(replacement),
    });

    expect(response.executionAttemptReceipt).toMatchObject({
      pageActionExecutionAttemptId: replacement.pageActionExecutionAttemptId,
      executionAttemptOrdinal: 2,
      predecessorExecutionAttemptReceipt: replacement.predecessorExecutionAttemptReceipt,
      outcome: 'completed',
    });
    expect(response.completionReceipt).toBeUndefined();
  });

  it('rejects invalid baseline scope before Store runner/page creation', async () => {
    const requestValue = request('store-sample');
    if (requestValue.action.kind !== 'store-sample') throw new Error('fixture');
    requestValue.action.pageScope = { firstPage: 2, lastPageInclusive: 4 };
    const transport = ports(requestValue);
    await expect(executeCollectorPageActionV1({ request: requestValue, ports: transport })).rejects.toMatchObject({
      code: 'STORE_SAMPLE_BASELINE_SCOPE_INVALID',
    });
    expect(transport.runStoreSample).not.toHaveBeenCalled();
  });

  it('rejects catalog-to-Candidate expansion and failed required Qualification media', async () => {
    const store = request('store-sample');
    const storePorts = ports(store);
    storePorts.runStoreSample = async () => ({ ...runFor(store), catalogCandidatesPublished: 1 });
    await expect(executeCollectorPageActionV1({ request: store, ports: storePorts })).rejects.toMatchObject({
      code: 'STORE_SAMPLE_CANDIDATE_EXPANSION_FORBIDDEN',
    });
    const qualification = request('store-qualification');
    const qualificationPorts = ports(qualification);
    qualificationPorts.runQualification = async () => ({
      ...runFor(qualification),
      qualificationMedia: { ...runFor(qualification).qualificationMedia!, sourceCoverage: 'failed' },
    });
    await expect(executeCollectorPageActionV1({ request: qualification, ports: qualificationPorts })).rejects.toMatchObject({
      code: 'QUALIFICATION_MEDIA_INCOMPLETE',
    });
  });

  it('binds the resolved Search artifact keyword before running a Page', async () => {
    const search = request('search-list');
    if (search.action.kind !== 'search-list') throw new Error('fixture');
    search.action.request.keyword = 'another-keyword';
    const searchPorts = ports(search);
    await expect(executeCollectorPageActionV1({ request: search, ports: searchPorts })).rejects.toMatchObject({
      code: 'SEARCH_PARAMETER_SET_ARTIFACT_MISMATCH',
    });
    expect(searchPorts.runSearch).not.toHaveBeenCalled();
  });

  it('rejects a Search terminal receipt whose frozen Candidate set hash was altered', async () => {
    const search = request('search-list');
    const searchPorts = ports(search);
    searchPorts.runSearch = async () => {
      const run = runFor(search);
      return {
        ...run,
        searchTerminalReceipt: {
          ...run.searchTerminalReceipt!,
          eligibleCandidateSetHash: HASH('tampered-candidates'),
        },
      };
    };
    await expect(executeCollectorPageActionV1({
      request: search, ports: searchPorts,
    })).rejects.toThrow(/invalid or corrupted/i);
  });

  it('rejects forged Offer receipts and does not accept missing raw proof', async () => {
    const offer = request('offer-detail');
    const offerPorts = ports(offer);
    offerPorts.runOffer = async () => {
      const run = runFor(offer);
      return {
        ...run,
        offerSources: {
          ...run.offerSources!,
          shopCard: { ...run.offerSources!.shopCard, pageActionId: 'wrong-action' },
        },
      };
    };
    await expect(executeCollectorPageActionV1({ request: offer, ports: offerPorts })).rejects.toThrow(/another scope/i);
  });

  it('rejects completed Qualification and Store outputs with unbound scope or cursor gaps', async () => {
    const qualification = request('store-qualification');
    const qualificationPorts = ports(qualification);
    qualificationPorts.runQualification = async () => {
      const run = runFor(qualification);
      return {
        ...run,
        batches: run.batches.map((entry) => entry.kind === 'store-qualification'
          ? { ...entry, observations: [{ ...entry.observations[0], memberId: 'other-member' }] }
          : entry),
      };
    };
    await expect(executeCollectorPageActionV1({ request: qualification, ports: qualificationPorts })).rejects.toMatchObject({
      code: 'QUALIFICATION_RESPONSE_SCOPE_MISMATCH',
    });

    const store = request('store-sample');
    const storePorts = ports(store);
    storePorts.runStoreSample = async () => {
      const run = runFor(store);
      return { ...run, storeCursor: { ...run.storeCursor!, observedPages: [1, 3] } };
    };
    await expect(executeCollectorPageActionV1({ request: store, ports: storePorts })).rejects.toMatchObject({
      code: 'STORE_SAMPLE_CURSOR_SCOPE_MISMATCH',
    });
  });
});
