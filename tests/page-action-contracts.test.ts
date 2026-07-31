import { describe, expect, it } from 'vitest';
import {
  PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  PAGE_ACTION_REQUEST_SCHEMA,
  STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID,
  STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA,
  STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID,
  canonicalCollectorJsonV1,
  canonicalCollectorSha256V1,
  computeCompletionReceiptHashV1,
  computeCollectorExecutionHandleSignatureV1,
  computeExecutionAttemptReceiptHashV1,
  computeExecutionLineageHashV1,
  computeLogicalLineageHashV1,
  computePageActionPayloadBusinessHashV1,
  computeStoreSampleExpansionApprovalSignatureV1,
  effectivePageActionDeadlineV1,
  normalizeCollectorWireResponseV1,
  normalizePageActionCancelV1,
  normalizePageActionExecuteResponseV1,
  normalizePageActionReceiptLookupV1,
  normalizePageActionRequestV1,
  pageActionBusinessFieldPathsV1,
  validatePageActionAttemptChainV1,
  validateUniquePageActionCompletionsV1,
} from '../src/collection/page-action-contracts.js';

const hash = (label: string): string => canonicalCollectorSha256V1(label);
const policyRevisionIds = ['policy-revision-1'];
const SIGNING_KEY = 'collector-test-signing-key-32-bytes-minimum';

function batch(id = 'batch-1') {
  return {
    schemaVersion: 1,
    batchId: id,
    unitId: 'work-unit-1',
    sourceRequestId: 'request-1',
    kind: 'store-catalog',
    status: 'completed',
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:01:00.000Z',
    subject: { memberId: 'member_1' },
    scope: { requestedScope: 'bounded-pages' },
    observations: [{ offerId: '123' }],
    completeness: {
      requestedScope: 'bounded-pages',
      state: 'complete',
      observedPages: [1],
      failedPages: [],
      uniqueItems: 1,
    },
    duplicateObservations: [],
    warnings: [],
    errors: [],
    rawEvidenceRefs: ['artifact:batch-1'],
    metrics: { requests: 1 },
  };
}

function actionFixture(kind: string) {
  if (kind === 'search-list') {
    const subject = {
      kind,
      searchQueryKeyHash: hash('search-query'),
      querySnapshotHash: hash('query-snapshot'),
    };
    return {
      subject,
      action: {
        kind,
        request: {
          schema: 'canonical-search-request-v1',
          searchQueryKeyHash: subject.searchQueryKeyHash,
          searchSegmentId: 'search-segment-1',
          querySnapshotHash: subject.querySnapshotHash,
          keyword: 'tent',
          filterConfigSnapshotId: 'filter-snapshot-1',
          filterConfigSnapshotHash: hash('filter-snapshot'),
          compilerRevision: 'compiler-1',
          serializerCapabilitySnapshotId: 'serializer-snapshot-1',
          serializerCapabilitySnapshotHash: hash('serializer-snapshot'),
          sort: 'relevance',
          canonicalParameterSetArtifactRef: 'artifact:canonical-search-1',
          canonicalParameterSetHash: hash('canonical-parameters'),
          requestedStartPage: 1,
          requestedEndPage: 3,
          maxOffers: 90,
          advertisementPolicy: 'exclude-p4p',
          forwardPageBudget: 3,
          replayPageBudget: 2,
          maxSafeReplayPages: 2,
        },
      },
    };
  }
  if (kind === 'offer-detail') {
    const subject = {
      kind,
      offerId: '123',
      memberId: 'member_1',
      searchOriginReceiptId: 'search-receipt-1',
      searchOriginReceiptHash: hash('search-receipt'),
    };
    return { subject, action: { ...subject } };
  }
  if (kind === 'store-qualification') {
    const subject = {
      kind,
      memberId: 'member_1',
      canonicalStoreIdentityReceiptId: 'store-identity-receipt-1',
      canonicalStoreIdentityReceiptHash: hash('store-identity-receipt'),
    };
    return { subject, action: { ...subject } };
  }
  const pageScope = { firstPage: 1, lastPageInclusive: 3 };
  const subject = {
    kind: 'store-sample',
    memberId: 'member_1',
    canonicalShopIdentityReceiptId: 'shop-identity-receipt-1',
    canonicalShopIdentityReceiptHash: hash('shop-identity-receipt'),
    pageScopeBusinessHash: canonicalCollectorSha256V1(pageScope),
  };
  return {
    subject,
    action: {
      kind: 'store-sample',
      memberId: subject.memberId,
      canonicalShopIdentityReceiptId: subject.canonicalShopIdentityReceiptId,
      canonicalShopIdentityReceiptHash: subject.canonicalShopIdentityReceiptHash,
      mode: 'phase-1-bounded',
      pageScope,
    },
  };
}

function requestFixture(kind = 'store-sample', ordinal = 1, predecessor?: unknown) {
  const { subject, action } = actionFixture(kind);
  const pageActionBusinessHash = computePageActionPayloadBusinessHashV1({
    ...action,
    executionHandle: {},
  } as never);
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1',
    logicalLineageId: `logical-${kind}`,
    collectionTaskId: 'collection-task-1',
    workUnitId: 'work-unit-1',
    pageActionId: `page-action-${kind}`,
    pageActionBusinessHash,
    actionKind: kind,
    businessSubject: subject,
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage as never);
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1',
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: `work-unit-attempt-${ordinal}`,
    pageActionExecutionAttemptId: `page-action-attempt-${ordinal}`,
    executionAttemptOrdinal: ordinal,
    requestId: `request-${ordinal}`,
    idempotencyKey: `idempotency-${ordinal}`,
    profile: {
      profileId: `profile-${ordinal}`,
      profileName: `profile-${ordinal}`,
      daemonInstanceId: `daemon-${ordinal}`,
      contextGeneration: ordinal,
      egressId: `egress-${ordinal}`,
    },
    fences: {
      supervisor: fence('supervisor', '2026-07-31T00:10:00.000Z'),
      reservation: fence('reservation', '2026-07-31T00:08:00.000Z'),
      workUnit: fence('work-unit', '2026-07-31T00:09:00.000Z'),
    },
  };
  const routeTemplateId = `route-${kind}`;
  const allowedRequestKeys = pageActionBusinessFieldPathsV1({
    ...action,
    executionHandle: {},
  } as never);
  const executionHandleContent = {
    schema: 'collector-execution-handle-v1',
    handleId: `execution-handle-${kind}`,
    issuer: 'trusted-page-capability-service',
    actionKind: kind,
    routeTemplateId,
    subjectHash: canonicalCollectorSha256V1(subject),
    actionPayloadBusinessHash: pageActionBusinessHash,
    allowedRequestKeysHash: canonicalCollectorSha256V1(allowedRequestKeys),
    policyRevisionIdsHash: canonicalCollectorSha256V1(policyRevisionIds),
    notBefore: '2026-07-30T23:59:00.000Z',
    expiresAt: '2026-07-31T00:30:00.000Z',
    signingKeyId: 'signing-key-1',
  };
  const executionHandle = {
    ...executionHandleContent,
    signature: computeCollectorExecutionHandleSignatureV1(
      executionHandleContent as never,
      SIGNING_KEY,
    ),
  };
  return {
    schema: PAGE_ACTION_REQUEST_SCHEMA,
    requestId: executionLineage.requestId,
    idempotencyKey: executionLineage.idempotencyKey,
    pageActionId: logicalLineage.pageActionId,
    pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
    executionAttemptOrdinal: ordinal,
    ...(predecessor === undefined ? {} : { predecessorExecutionAttemptReceipt: predecessor }),
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage as never),
    actionKind: kind,
    startNotBefore: '2026-07-31T00:00:00.000Z',
    leaseNotAfter: '2026-07-31T00:08:00.000Z',
    deadlineAt: '2026-07-31T00:07:00.000Z',
    policyRevisionIds,
    action: { ...action, executionHandle },
  };
}

function verificationFixture(request: ReturnType<typeof requestFixture>) {
  return {
    keysById: { 'signing-key-1': SIGNING_KEY },
    routesById: {
      [request.action.executionHandle.routeTemplateId]: {
        actionKind: request.actionKind,
        allowedRequestKeys: pageActionBusinessFieldPathsV1(request.action as never),
      },
    },
    expansionPoliciesByDispatchRevisionId: {
      [STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID]: {
        eligibilityPolicyHash: hash('eligibility-policy'),
        dispatchPolicyHash: hash('dispatch-policy'),
      },
    },
  } as const;
}

function rebindStoreSampleAction(
  request: ReturnType<typeof requestFixture>,
  action: Record<string, unknown>,
) {
  const pageActionBusinessHash = computePageActionPayloadBusinessHashV1({
    ...action,
    executionHandle: {},
  } as never);
  const businessSubject = {
    ...request.logicalLineage.businessSubject,
    pageScopeBusinessHash: canonicalCollectorSha256V1(action['pageScope']),
  };
  const logicalLineage = {
    ...request.logicalLineage,
    pageActionBusinessHash,
    businessSubject,
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage as never);
  const executionLineage = {
    ...request.executionLineage,
    logicalLineageHash,
  };
  const handleContent = {
    ...request.action.executionHandle,
    subjectHash: canonicalCollectorSha256V1(businessSubject),
    actionPayloadBusinessHash: pageActionBusinessHash,
    allowedRequestKeysHash: canonicalCollectorSha256V1(
      pageActionBusinessFieldPathsV1({ ...action, executionHandle: {} } as never),
    ),
  };
  const { signature: _oldSignature, ...unsignedHandle } = handleContent;
  const executionHandle = {
    ...unsignedHandle,
    signature: computeCollectorExecutionHandleSignatureV1(
      unsignedHandle as never,
      SIGNING_KEY,
    ),
  };
  return {
    ...request,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage as never),
    action: { ...action, executionHandle },
  };
}

function expansionApproval(overrides: Record<string, unknown> = {}) {
  const content = {
    schema: 'store-sample-expansion-approval-v1',
    approvalReceiptId: 'expansion-approval-1',
    eligibilityReceiptId: 'eligibility-receipt-1',
    eligibilityReceiptHash: hash('eligibility-receipt'),
    eligibilityPolicySchema: STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA,
    eligibilityPolicyRevisionId: STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID,
    eligibilityPolicyHash: hash('eligibility-policy'),
    baselineGeneration: 'baseline-generation-1',
    baselineObservedAt: '2026-07-30T23:30:00.000Z',
    baselineExpiresAt: '2026-07-31T00:20:00.000Z',
    dormantNextPage: 4,
    dispatchPolicyRevisionId: STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID,
    dispatchPolicyHash: hash('dispatch-policy'),
    pageLimitPerAction: 3,
    evidenceUsage: 'cache-seed-only',
    dispatchGates: {
      eligibilityApproved: true,
      dailyQualifiedSkuTargetAccepted: true,
      independentReleaseApproved: true,
      dispatchEnabled: true,
      lowPriorityQueue: true,
      budgetReserved: true,
      profileOperationallyReady: true,
      profileId: 'profile-1',
    },
    approvedAt: '2026-07-30T23:50:00.000Z',
    expiresAt: '2026-07-31T00:20:00.000Z',
    signingKeyId: 'signing-key-1',
    ...overrides,
  };
  return {
    ...content,
    signature: computeStoreSampleExpansionApprovalSignatureV1(
      content as never,
      SIGNING_KEY,
    ),
  };
}

function fence(name: string, leaseNotAfter: string) {
  return {
    leaseId: `${name}-lease-1`,
    generation: 1,
    fencingToken: `${name}-token-1`,
    leaseNotAfter,
  };
}

function error(category = 'network') {
  return {
    code: 'REMOTE_REQUEST_FAILED',
    category,
    retryable: true,
    actionRequired: null,
    recoveryAction: 'retry-next-attempt',
    details: { attempt: 1 },
  };
}

function receiptFixture(request: ReturnType<typeof requestFixture>, outcome: 'failed' | 'completed') {
  const remoteRequestAttemptId = `remote-${request.executionAttemptOrdinal}`;
  const requestBusinessHash = hash(`remote-business-${request.executionAttemptOrdinal}`);
  const failed = outcome === 'failed';
  const content: Record<string, unknown> = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `attempt-receipt-${request.executionAttemptOrdinal}`,
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
    outcome,
    terminal: true,
    actionKind: request.actionKind,
    remoteRequestAttempts: [{
      remoteRequestAttemptId,
      ordinal: 1,
      purpose: request.actionKind === 'store-sample' ? 'forward' : 'single-target',
      requestBusinessHash,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:30.000Z',
      status: failed ? 'failed' : 'succeeded',
      rawEvidenceRefs: ['artifact:remote-1'],
      ...(failed ? { error: error() } : {}),
    }],
    batches: failed ? [] : [batch()],
    requestSnapshots: [{
      api: 'mtop.example.query',
      pageActionId: request.pageActionId,
      pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
      remoteRequestAttemptId,
      purpose: request.actionKind === 'store-sample' ? 'forward' : 'single-target',
      subjectHash: canonicalCollectorSha256V1(request.logicalLineage.businessSubject),
      requestBusinessHash,
      observedAt: '2026-07-31T00:00:01.000Z',
    }],
    pageLifecycle: {
      baselinePages: 1,
      createdPages: 1,
      closedPages: 1,
      remainingOwnedPages: 0,
    },
    metrics: { requests: 1 },
    ...(failed ? { error: error() } : {}),
  };
  return { ...content, receiptHash: computeExecutionAttemptReceiptHashV1(content as never) };
}

function completionFixture(receipts: ReturnType<typeof receiptFixture>[]) {
  const last = receipts.at(-1)!;
  const refs = receipts.map((receipt) => ({
    pageActionExecutionAttemptId: receipt.pageActionExecutionAttemptId,
    executionAttemptOrdinal: receipt.executionAttemptOrdinal,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    executionLineageHash: receipt.executionLineageHash,
  }));
  const content: Record<string, unknown> = {
    schema: PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
    completionReceiptId: 'completion-receipt-1',
    pageActionId: last.pageActionId,
    pageActionBusinessHash: last.pageActionBusinessHash,
    logicalLineage: last.logicalLineage,
    logicalLineageHash: last.logicalLineageHash,
    actionKind: last.actionKind,
    status: 'completed',
    terminal: true,
    executionAttemptReceiptRefs: refs,
    finalizedByExecutionRef: refs.at(-1),
    batches: [batch()],
    completedAt: '2026-07-31T00:02:00.000Z',
  };
  return { ...content, completionReceiptHash: computeCompletionReceiptHashV1(content as never) };
}

describe('PageAction V1 wire contracts', () => {
  it.each(['search-list', 'offer-detail', 'store-qualification', 'store-sample'])(
    'round-trips the strict %s action codec',
    (kind) => {
      const request = requestFixture(kind);
      expect(normalizePageActionRequestV1(request, verificationFixture(request))).toEqual(request);
    },
  );

  it.each(['baseline', 'expansion', 'BASELINE', 'phase_1_bounded', 'unknown'])(
    'rejects the unsupported store sample mode %s',
    (mode) => {
      const request = requestFixture();
      expect(() => normalizePageActionRequestV1({
        ...request,
        action: { ...request.action, mode },
      }, verificationFixture(request))).toThrow(/mode must be one of: phase-1-bounded, approved-expansion/);
    },
  );

  it('uses the earliest of all three fences and the request deadline', () => {
    const request = requestFixture();
    request.executionLineage.fences.supervisor.leaseNotAfter = '2026-07-31T00:06:00.000Z';
    expect(effectivePageActionDeadlineV1(request as never)).toBe('2026-07-31T00:06:00.000Z');
  });

  it('rejects repeated lineage, handle, and top-level fields that disagree', () => {
    const request = requestFixture();
    expect(() => normalizePageActionRequestV1({ ...request, actionKind: 'offer-detail' }, verificationFixture(request)))
      .toThrow(/actionKind\/action.kind/);
    expect(() => normalizePageActionRequestV1({
      ...request,
      action: {
        ...request.action,
        executionHandle: { ...request.action.executionHandle, subjectHash: hash('wrong') },
      },
    }, verificationFixture(request))).toThrow(/executionHandle.subjectHash/);
    expect(() => normalizePageActionRequestV1({ ...request, leaseNotAfter: request.deadlineAt }, verificationFixture(request)))
      .toThrow(/earliest fence expiry/);
  });

  it('binds the signed capability to canonical payload, route, and allowed keys', () => {
    const request = requestFixture('search-list');
    const verification = verificationFixture(request);
    expect(() => normalizePageActionRequestV1({
      ...request,
      action: {
        ...request.action,
        request: { ...request.action.request, maxOffers: 9_000 },
      },
    }, verification)).toThrow(/canonical business hash/);
    expect(() => normalizePageActionRequestV1({
      ...request,
      action: {
        ...request.action,
        executionHandle: {
          ...request.action.executionHandle,
          signature: 'A'.repeat(43),
        },
      },
    }, verification)).toThrow(/signature verification failed/);
    expect(() => normalizePageActionRequestV1(request, {
      ...verification,
      routesById: {},
    })).toThrow(/routeTemplateId.*allowlist/);
    expect(() => normalizePageActionRequestV1(request, {
      ...verification,
      keysById: {},
    })).toThrow(/signingKeyId is not trusted/);

    for (const suffix of ['=', '!']) {
      expect(() => normalizePageActionRequestV1({
        ...request,
        action: {
          ...request.action,
          executionHandle: {
            ...request.action.executionHandle,
            signature: `${request.action.executionHandle.signature}${suffix}`,
          },
        },
      }, verification)).toThrow(/canonical unpadded HMAC-SHA256 base64url/);
    }
  });

  it('requires an independently signed fresh dormant baseline for approved expansion', () => {
    const baseline = requestFixture();
    expect(() => normalizePageActionRequestV1({
      ...baseline,
      action: { ...baseline.action, mode: 'approved-expansion' },
    }, verificationFixture(baseline))).toThrow(/requires an independent signed expansion approval/);

    const approval = expansionApproval();
    const approved = rebindStoreSampleAction(baseline, {
      ...baseline.action,
      mode: 'approved-expansion',
      pageScope: { firstPage: 4, lastPageInclusive: 6 },
      expansionApproval: approval,
    });
    expect(normalizePageActionRequestV1(
      approved,
      verificationFixture(approved as never),
    ).action).toMatchObject({
      mode: 'approved-expansion',
      pageScope: { firstPage: 4, lastPageInclusive: 6 },
    });

    const wrongStart = rebindStoreSampleAction(baseline, {
      ...baseline.action,
      mode: 'approved-expansion',
      pageScope: { firstPage: 1, lastPageInclusive: 3 },
      expansionApproval: approval,
    });
    expect(() => normalizePageActionRequestV1(
      wrongStart,
      verificationFixture(wrongStart as never),
    )).toThrow(/dormantNextPage/);
  });

  it('freezes expansion policy identity, hashes, initial limit, and dispatch gates', () => {
    const baseline = requestFixture();
    const approvedAction = (
      approval: ReturnType<typeof expansionApproval>,
      lastPageInclusive = 6,
    ) => rebindStoreSampleAction(baseline, {
      ...baseline.action,
      mode: 'approved-expansion',
      pageScope: { firstPage: 4, lastPageInclusive },
      expansionApproval: approval,
    });

    const wrongEligibilitySchema = approvedAction(expansionApproval({
      eligibilityPolicySchema: 'untrusted-eligibility-policy-v1',
    }));
    expect(() => normalizePageActionRequestV1(
      wrongEligibilitySchema,
      verificationFixture(wrongEligibilitySchema as never),
    )).toThrow(/eligibility policy schema/);

    const wrongEligibilityRevision = approvedAction(expansionApproval({
      eligibilityPolicyRevisionId: 'store-catalog-enrichment-eligibility-v1@2',
    }));
    expect(() => normalizePageActionRequestV1(
      wrongEligibilityRevision,
      verificationFixture(wrongEligibilityRevision as never),
    )).toThrow(/eligibility policy revision/);

    const unknownDispatchRevision = approvedAction(expansionApproval({
      dispatchPolicyRevisionId: 'store-catalog-expansion-dispatch-v1@2',
    }));
    expect(() => normalizePageActionRequestV1(
      unknownDispatchRevision,
      verificationFixture(unknownDispatchRevision as never),
    )).toThrow(/dispatch policy revision is not registered/);

    const inflatedInitialLimit = approvedAction(expansionApproval({
      pageLimitPerAction: 4,
    }), 7);
    expect(() => normalizePageActionRequestV1(
      inflatedInitialLimit,
      verificationFixture(inflatedInitialLimit as never),
    )).toThrow(/pageLimitPerAction\/dispatch policy revision/);

    const gates = expansionApproval().dispatchGates;
    const disabledDispatch = approvedAction(expansionApproval({
      dispatchGates: { ...gates, dispatchEnabled: false },
    }));
    expect(() => normalizePageActionRequestV1(
      disabledDispatch,
      verificationFixture(disabledDispatch as never),
    )).toThrow(/dispatchEnabled must be true/);

    const wrongProfile = approvedAction(expansionApproval({
      dispatchGates: { ...gates, profileId: 'profile-other' },
    }));
    expect(() => normalizePageActionRequestV1(
      wrongProfile,
      verificationFixture(wrongProfile as never),
    )).toThrow(/dispatch profile\/execution profile/);

    const approved = approvedAction(expansionApproval());
    const verification = verificationFixture(approved as never);
    expect(() => normalizePageActionRequestV1(approved, {
      ...verification,
      expansionPoliciesByDispatchRevisionId: {
        [STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID]: {
          ...verification.expansionPoliciesByDispatchRevisionId[
            STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID
          ],
          eligibilityPolicyHash: hash('wrong-eligibility-policy'),
        },
      },
    })).toThrow(/eligibility policy hash\/configured policy/);

    expect(() => normalizePageActionRequestV1(approved, {
      ...verification,
      expansionPoliciesByDispatchRevisionId: {
        [STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID]: {
          ...verification.expansionPoliciesByDispatchRevisionId[
            STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID
          ],
          dispatchPolicyHash: hash('wrong-dispatch-policy'),
        },
      },
    })).toThrow(/dispatch policy hash\/configured policy/);
  });

  it('validates immutable terminal receipts and their complete predecessor chain', () => {
    const firstRequest = requestFixture();
    const firstReceipt = receiptFixture(firstRequest, 'failed');
    const secondRequest = requestFixture('store-sample', 2, {
      receiptId: firstReceipt.receiptId,
      receiptHash: firstReceipt.receiptHash,
    });
    const secondReceipt = receiptFixture(secondRequest, 'completed');
    const completion = completionFixture([firstReceipt, secondReceipt]);
    const response = normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: secondReceipt,
      completionReceipt: completion,
    });

    expect(validatePageActionAttemptChainV1([secondReceipt, firstReceipt], completion))
      .toHaveLength(2);
    expect(Object.isFrozen(response.executionAttemptReceipt)).toBe(true);
    expect(Object.isFrozen(response.executionAttemptReceipt.executionLineage.profile)).toBe(true);
    expect(Object.isFrozen(response.completionReceipt)).toBe(true);
    expect(canonicalCollectorJsonV1({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');

    expect(() => validatePageActionAttemptChainV1([
      firstReceipt,
      { ...secondReceipt, predecessorExecutionAttemptReceipt: {
        receiptId: firstReceipt.receiptId,
        receiptHash: hash('wrong-predecessor'),
      }, receiptHash: computeExecutionAttemptReceiptHashV1({
        ...secondReceipt,
        predecessorExecutionAttemptReceipt: {
          receiptId: firstReceipt.receiptId,
          receiptHash: hash('wrong-predecessor'),
        },
        receiptHash: undefined,
      } as never) },
    ], completion)).toThrow(/predecessor receiptHash/);
  });

  it('requires completion to preserve every immutable batch from every attempt', () => {
    const firstRequest = requestFixture();
    const failed = receiptFixture(firstRequest, 'failed');
    const partialContent = {
      ...failed,
      outcome: 'partial',
      batches: [batch('batch-from-partial')],
    };
    const partial = {
      ...partialContent,
      receiptHash: computeExecutionAttemptReceiptHashV1(partialContent as never),
    };
    const secondRequest = requestFixture('store-sample', 2, {
      receiptId: partial.receiptId,
      receiptHash: partial.receiptHash,
    });
    const completed = receiptFixture(secondRequest, 'completed');
    const incompleteCompletion = completionFixture([partial, completed]);
    expect(() => validatePageActionAttemptChainV1(
      [partial, completed],
      incompleteCompletion,
    )).toThrow(/preserve every immutable CollectionBatch/);

    const currentCompleted = receiptFixture(requestFixture(), 'completed');
    const completedWithExtraBatchContent = {
      ...currentCompleted,
      batches: [batch(), batch('batch-from-current-attempt')],
    };
    const completedWithExtraBatch = {
      ...completedWithExtraBatchContent,
      receiptHash: computeExecutionAttemptReceiptHashV1(
        completedWithExtraBatchContent as never,
      ),
    };
    const missingCurrentBatch = completionFixture([completedWithExtraBatch]);
    expect(() => normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: completedWithExtraBatch,
      completionReceipt: missingCurrentBatch,
    })).toThrow(/preserve every immutable CollectionBatch from the returned attempt/);
  });

  it('requires a direct completion to exactly reference the returned attempt', () => {
    const receipt = receiptFixture(requestFixture(), 'completed');
    const completion = completionFixture([receipt]);
    const mismatchedRef = {
      ...completion.executionAttemptReceiptRefs[0],
      pageActionExecutionAttemptId: 'different-attempt',
      executionLineageHash: hash('different-execution-lineage'),
    };
    const mismatchedCompletion = {
      ...completion,
      executionAttemptReceiptRefs: [mismatchedRef],
      finalizedByExecutionRef: mismatchedRef,
    };
    mismatchedCompletion.completionReceiptHash = computeCompletionReceiptHashV1(
      mismatchedCompletion as never,
    );

    expect(() => normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: receipt,
      completionReceipt: mismatchedCompletion,
    })).toThrow(/exactly reference its execution attempt receipt/);
  });

  it('binds each sanitized snapshot page to its remote attempt logical page', () => {
    const receipt = receiptFixture(requestFixture(), 'completed');
    const mismatched = {
      ...receipt,
      remoteRequestAttempts: receipt.remoteRequestAttempts.map((attempt) => ({
        ...attempt,
        logicalPage: 1,
      })),
      requestSnapshots: receipt.requestSnapshots.map((snapshot) => ({
        ...snapshot,
        page: 2,
      })),
    };
    mismatched.receiptHash = computeExecutionAttemptReceiptHashV1(mismatched as never);

    expect(() => normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: mismatched,
    })).toThrow(/snapshot page\/remote logicalPage/);
  });

  it('rejects credential and signing material in sanitized request snapshots', () => {
    const receipt = receiptFixture(requestFixture(), 'completed');
    for (const sensitiveKey of [
      'Cookie',
      'access_token',
      'request-signature',
      'x5sec',
    ]) {
      const content = {
        ...receipt,
        requestSnapshots: receipt.requestSnapshots.map((snapshot) => ({
          ...snapshot,
          filterParams: { [sensitiveKey]: 'must-not-be-persisted' },
        })),
      };
      const mutated = {
        ...content,
        receiptHash: computeExecutionAttemptReceiptHashV1(content as never),
      };
      expect(() => normalizePageActionExecuteResponseV1({
        executionAttemptReceipt: mutated,
      })).toThrow(/sensitive signing or credential material/);
    }

    const allowedContent = {
      ...receipt,
      requestSnapshots: receipt.requestSnapshots.map((snapshot) => ({
        ...snapshot,
        filterParams: {
          province: '广东',
          priceStart: '10',
          freeShipping: '1',
        },
      })),
    };
    const allowed = {
      ...allowedContent,
      receiptHash: computeExecutionAttemptReceiptHashV1(allowedContent as never),
    };
    expect(normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: allowed,
    }).executionAttemptReceipt.requestSnapshots[0]?.filterParams).toEqual({
      province: '广东',
      priceStart: '10',
      freeShipping: '1',
    });
  });

  it('requires structured errors for failed attempts and rejects errors on success', () => {
    const failed = receiptFixture(requestFixture(), 'failed');
    const completed = receiptFixture(requestFixture(), 'completed');
    const { error: _failedError, ...failedWithoutError } = failed;
    failedWithoutError.receiptHash = computeExecutionAttemptReceiptHashV1(failedWithoutError as never);
    const completedWithError = { ...completed, error: error() };
    completedWithError.receiptHash = computeExecutionAttemptReceiptHashV1(completedWithError as never);
    expect(() => normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: failedWithoutError,
    })).toThrow(/failed.*requires an error/);
    expect(() => normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: completedWithError,
    })).toThrow(/completed.*must not contain an error/);
  });

  it('normalizes cancel and receipt lookup wires without weakening fence checks', () => {
    const request = requestFixture();
    expect(normalizePageActionCancelV1({
      schema: 'collector.page-action.cancel.v1',
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      pageActionId: request.pageActionId,
      logicalLineage: request.logicalLineage,
      logicalLineageHash: request.logicalLineageHash,
      executionLineage: request.executionLineage,
      executionLineageHash: request.executionLineageHash,
      reason: 'caller requested cancellation',
    }).pageActionId).toBe(request.pageActionId);
    expect(normalizePageActionReceiptLookupV1({
      schema: 'collector.page-action.lookup-receipt.v1',
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      pageActionId: request.pageActionId,
      pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
      logicalLineageId: request.logicalLineage.logicalLineageId,
      logicalLineageHash: request.logicalLineageHash,
      targetExecutionLineageHash: request.executionLineageHash,
      readFences: request.executionLineage.fences,
    }).readFences.reservation.leaseId).toBe('reservation-lease-1');
  });

  it('dual-reads legacy bare CollectionBatch V1 and new envelopes', () => {
    expect(normalizeCollectorWireResponseV1(batch())).toMatchObject({ schemaVersion: 1 });
    const receipt = receiptFixture(requestFixture(), 'completed');
    expect(normalizeCollectorWireResponseV1({ executionAttemptReceipt: receipt }))
      .toMatchObject({ executionAttemptReceipt: { terminal: true } });
  });

  it('rejects duplicate logical completion receipts', () => {
    const receipt = receiptFixture(requestFixture(), 'completed');
    const completion = completionFixture([receipt]);
    expect(() => validateUniquePageActionCompletionsV1([completion, completion]))
      .toThrow(/more than one completion receipt/);
  });
});
