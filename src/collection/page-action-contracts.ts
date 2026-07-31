import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  normalizeCollectionBatch,
  type CollectionBatch,
} from './contracts.js';

export const PAGE_ACTION_REQUEST_SCHEMA = 'collector.page-action.request.v1' as const;
export const PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA =
  'collector.page-action.execution-attempt-receipt.v1' as const;
export const PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA =
  'collector.page-action.completion-receipt.v1' as const;
export const PAGE_ACTION_CANCEL_SCHEMA = 'collector.page-action.cancel.v1' as const;
export const PAGE_ACTION_RECEIPT_LOOKUP_SCHEMA =
  'collector.page-action.lookup-receipt.v1' as const;
export const STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA =
  'store-catalog-enrichment-eligibility-policy-v1' as const;
export const STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID =
  'store-catalog-enrichment-eligibility-v1@1' as const;
export const STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID =
  'store-catalog-expansion-dispatch-v1@1' as const;

const STORE_CATALOG_EXPANSION_DISPATCH_POLICIES: Readonly<Record<string, {
  eligibilityPolicySchema: typeof STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA;
  eligibilityPolicyRevisionId: typeof STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID;
  pageLimitPerAction: number;
  evidenceUsage: 'cache-seed-only';
}>> = Object.freeze({
  [STORE_CATALOG_EXPANSION_DISPATCH_POLICY_REVISION_ID]: Object.freeze({
    eligibilityPolicySchema: STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA,
    eligibilityPolicyRevisionId: STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID,
    pageLimitPerAction: 3,
    evidenceUsage: 'cache-seed-only',
  }),
});

export const PAGE_ACTION_KINDS = [
  'search-list',
  'offer-detail',
  'store-qualification',
  'store-sample',
] as const;
export type PageActionKind = (typeof PAGE_ACTION_KINDS)[number];

export const COLLECTOR_ERROR_CATEGORIES = [
  'contract',
  'protocol',
  'authentication',
  'risk-control',
  'rate-limited',
  'timeout',
  'network',
  'cancelled',
  'source-empty',
] as const;
export type CollectorErrorCategoryV1 =
  (typeof COLLECTOR_ERROR_CATEGORIES)[number];

export const FIELD_AVAILABILITY_VALUES = [
  'available',
  'not-present',
  'not-collected',
  'failed',
] as const;
export type FieldAvailabilityV1 = (typeof FIELD_AVAILABILITY_VALUES)[number];

export const SEARCH_QUERY_TERMINAL_REASONS = [
  'source-end',
  'configured-page-limit',
  'configured-offer-limit',
] as const;
export type SearchQueryTerminalReasonV1 =
  (typeof SEARCH_QUERY_TERMINAL_REASONS)[number];

export const QUALIFICATION_MEDIA_SOURCE_COVERAGE_VALUES = [
  'complete',
  'authoritative-empty',
  'failed',
] as const;
export type QualificationMediaSourceCoverageV1 =
  (typeof QUALIFICATION_MEDIA_SOURCE_COVERAGE_VALUES)[number];

const SANITIZED_FILTER_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'bizType',
  'city',
  'complexTags',
  'featurePair',
  'filtMemberTags',
  'filtOfferTags',
  'freeShipping',
  'priceEnd',
  'priceStart',
  'province',
  'quantityBegin',
  'shopCountEnd',
  'shopCountStart',
  'tags',
  'uniqfield',
]);

const SENSITIVE_PARAMETER_NAME_FRAGMENTS = [
  'apikey',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'hmac',
  'secret',
  'session',
  'sign',
  'signature',
  'token',
  'useragent',
  'x5sec',
] as const;

export type CollectorJsonValue =
  | null
  | boolean
  | number
  | string
  | CollectorJsonValue[]
  | { [key: string]: CollectorJsonValue };
export type CollectorJsonObject = { [key: string]: CollectorJsonValue };

export interface CollectorErrorV1 {
  code: string;
  category: CollectorErrorCategoryV1;
  retryable: boolean;
  actionRequired: string | null;
  recoveryAction: string;
  details?: CollectorJsonObject;
}

export interface LeaseFenceV1 {
  leaseId: string;
  generation: number;
  fencingToken: string;
  leaseNotAfter: string;
}

export type LogicalPageActionBusinessSubjectV1 =
  | {
      kind: 'search-list';
      searchQueryKeyHash: string;
      querySnapshotHash: string;
    }
  | {
      kind: 'offer-detail';
      offerId: string;
      memberId: string;
      searchOriginReceiptId: string;
      searchOriginReceiptHash: string;
    }
  | {
      kind: 'store-qualification';
      memberId: string;
      canonicalStoreIdentityReceiptId: string;
      canonicalStoreIdentityReceiptHash: string;
    }
  | {
      kind: 'store-sample';
      memberId: string;
      canonicalShopIdentityReceiptId: string;
      canonicalShopIdentityReceiptHash: string;
      pageScopeBusinessHash: string;
    };

export interface LogicalPageActionLineageV1 {
  schema: 'collector.logical-page-action-lineage.v1';
  logicalLineageId: string;
  collectionTaskId: string;
  workUnitId: string;
  pageActionId: string;
  pageActionBusinessHash: string;
  actionKind: PageActionKind;
  businessSubject: LogicalPageActionBusinessSubjectV1;
}

export interface PageActionExecutionLineageV1 {
  schema: 'collector.page-action-execution-lineage.v1';
  logicalLineageId: string;
  logicalLineageHash: string;
  workUnitAttemptId: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  requestId: string;
  idempotencyKey: string;
  profile: {
    profileId: string;
    profileName: string;
    daemonInstanceId: string;
    contextGeneration: number;
    egressId: string;
  };
  fences: {
    supervisor: LeaseFenceV1;
    reservation: LeaseFenceV1;
    workUnit: LeaseFenceV1;
  };
}

export interface PageActionExecutionAttemptReceiptRefV1 {
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  receiptId: string;
  receiptHash: string;
  executionLineageHash: string;
}

export interface SignedCollectorExecutionHandleV1 {
  schema: 'collector-execution-handle-v1';
  handleId: string;
  issuer: 'trusted-page-capability-service';
  actionKind: PageActionKind;
  routeTemplateId: string;
  subjectHash: string;
  actionPayloadBusinessHash: string;
  allowedRequestKeysHash: string;
  policyRevisionIdsHash: string;
  notBefore: string;
  expiresAt: string;
  signingKeyId: string;
  signature: string;
}

export interface SignedSearchRecoveryHandleV1 {
  schema: 'search-recovery-handle-v1';
  handleId: string;
  recoveryReceiptId: string;
  recoveryReceiptHash: string;
  searchQueryKeyHash: string;
  previousSearchSegmentId: string;
  checkpointPage: number;
  allowedNextPage: number;
  recoveryMode: 'direct-begin-page' | 'safe-replay';
  maxSafeReplayPages: number;
  encryptedNavigationArchiveRef: string;
  expiresAt: string;
  signingKeyId: string;
  signature: string;
}

export interface SignedStoreSampleExpansionApprovalV1 {
  schema: 'store-sample-expansion-approval-v1';
  approvalReceiptId: string;
  eligibilityReceiptId: string;
  eligibilityReceiptHash: string;
  eligibilityPolicySchema: typeof STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA;
  eligibilityPolicyRevisionId: typeof STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID;
  eligibilityPolicyHash: string;
  baselineGeneration: string;
  baselineObservedAt: string;
  baselineExpiresAt: string;
  dormantNextPage: number;
  dispatchPolicyRevisionId: string;
  dispatchPolicyHash: string;
  pageLimitPerAction: number;
  evidenceUsage: 'cache-seed-only';
  dispatchGates: {
    eligibilityApproved: true;
    dailyQualifiedSkuTargetAccepted: true;
    independentReleaseApproved: true;
    dispatchEnabled: true;
    lowPriorityQueue: true;
    budgetReserved: true;
    profileOperationallyReady: true;
    profileId: string;
  };
  approvedAt: string;
  expiresAt: string;
  signingKeyId: string;
  signature: string;
}

export interface PageActionRouteAuthorizationV1 {
  actionKind: PageActionKind;
  allowedRequestKeys: readonly string[];
}

export interface StoreSampleExpansionPolicyAuthorizationV1 {
  eligibilityPolicyHash: string;
  dispatchPolicyHash: string;
}

export interface PageActionVerificationConfigV1 {
  keysById: Readonly<Record<string, string | Uint8Array>>;
  routesById: Readonly<Record<string, PageActionRouteAuthorizationV1>>;
  expansionPoliciesByDispatchRevisionId: Readonly<
    Record<string, StoreSampleExpansionPolicyAuthorizationV1>
  >;
}

export interface CanonicalSearchRequestV1 {
  schema: 'canonical-search-request-v1';
  searchQueryKeyHash: string;
  searchSegmentId: string;
  querySnapshotHash: string;
  keyword: string;
  filterConfigSnapshotId: string;
  filterConfigSnapshotHash: string;
  compilerRevision: string;
  serializerCapabilitySnapshotId: string;
  serializerCapabilitySnapshotHash: string;
  sort: 'relevance' | 'sales' | 'price-asc' | 'price-desc';
  canonicalParameterSetArtifactRef: string;
  canonicalParameterSetHash: string;
  requestedStartPage: number;
  requestedEndPage: number;
  maxOffers: number;
  advertisementPolicy: 'exclude-p4p' | 'archive-and-mark';
  forwardPageBudget: number;
  replayPageBudget: number;
  maxSafeReplayPages: number;
}

export interface SearchActionV1 {
  kind: 'search-list';
  request: CanonicalSearchRequestV1;
  executionHandle: SignedCollectorExecutionHandleV1;
  recoveryHandle?: SignedSearchRecoveryHandleV1;
}

export interface OfferActionV1 {
  kind: 'offer-detail';
  offerId: string;
  memberId: string;
  searchOriginReceiptId: string;
  searchOriginReceiptHash: string;
  executionHandle: SignedCollectorExecutionHandleV1;
}

export interface QualificationActionV1 {
  kind: 'store-qualification';
  memberId: string;
  canonicalStoreIdentityReceiptId: string;
  canonicalStoreIdentityReceiptHash: string;
  executionHandle: SignedCollectorExecutionHandleV1;
}

export interface StoreSampleActionV1 {
  kind: 'store-sample';
  memberId: string;
  canonicalShopIdentityReceiptId: string;
  canonicalShopIdentityReceiptHash: string;
  mode: 'phase-1-bounded' | 'approved-expansion';
  pageScope: {
    firstPage: number;
    lastPageInclusive: number;
  };
  expansionApproval?: SignedStoreSampleExpansionApprovalV1;
  executionHandle: SignedCollectorExecutionHandleV1;
}

export type PageActionPayloadV1 =
  | SearchActionV1
  | OfferActionV1
  | QualificationActionV1
  | StoreSampleActionV1;

export interface PageActionRequestV1 {
  schema: typeof PAGE_ACTION_REQUEST_SCHEMA;
  requestId: string;
  idempotencyKey: string;
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  predecessorExecutionAttemptReceipt?: {
    receiptId: string;
    receiptHash: string;
  };
  pageActionBusinessHash: string;
  logicalLineage: LogicalPageActionLineageV1;
  logicalLineageHash: string;
  executionLineage: PageActionExecutionLineageV1;
  executionLineageHash: string;
  actionKind: PageActionKind;
  startNotBefore: string;
  leaseNotAfter: string;
  deadlineAt: string;
  policyRevisionIds: string[];
  action: PageActionPayloadV1;
}

export interface SanitizedRemoteRequestSnapshotV1 {
  api: string;
  method?: string;
  componentKey?: string;
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  remoteRequestAttemptId: string;
  purpose: 'forward' | 'replay' | 'discovery' | 'single-target';
  subjectHash: string;
  pageSessionHash?: string;
  page?: number;
  pageSize?: number;
  sort?: string | null;
  filterParams?: Record<string, string | boolean | number>;
  requestBusinessHash: string;
  observedAt: string;
}

export interface RemoteRequestAttemptReceiptV1 {
  remoteRequestAttemptId: string;
  ordinal: number;
  logicalPage?: number;
  purpose: 'forward' | 'replay' | 'discovery' | 'single-target';
  requestBusinessHash: string;
  startedAt: string;
  completedAt: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  rawEvidenceRefs: string[];
  error?: CollectorErrorV1;
}

export interface PageActionExecutionAttemptReceiptV1 {
  schema: typeof PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA;
  receiptId: string;
  receiptHash: string;
  requestId: string;
  idempotencyKey: string;
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  executionAttemptOrdinal: number;
  predecessorExecutionAttemptReceipt?: {
    receiptId: string;
    receiptHash: string;
  };
  pageActionBusinessHash: string;
  logicalLineage: LogicalPageActionLineageV1;
  logicalLineageHash: string;
  executionLineage: PageActionExecutionLineageV1;
  executionLineageHash: string;
  outcome: 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled';
  terminal: true;
  actionKind: PageActionKind;
  remoteRequestAttempts: RemoteRequestAttemptReceiptV1[];
  batches: CollectionBatch[];
  requestSnapshots: SanitizedRemoteRequestSnapshotV1[];
  pageLifecycle: {
    baselinePages: number;
    createdPages: number;
    closedPages: number;
    remainingOwnedPages: 0;
  };
  metrics: Record<string, number>;
  error?: CollectorErrorV1;
}

export interface PageActionCompletionReceiptV1 {
  schema: typeof PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA;
  completionReceiptId: string;
  completionReceiptHash: string;
  pageActionId: string;
  pageActionBusinessHash: string;
  logicalLineage: LogicalPageActionLineageV1;
  logicalLineageHash: string;
  actionKind: PageActionKind;
  status: 'completed';
  terminal: true;
  executionAttemptReceiptRefs: [
    PageActionExecutionAttemptReceiptRefV1,
    ...PageActionExecutionAttemptReceiptRefV1[],
  ];
  finalizedByExecutionRef?: PageActionExecutionAttemptReceiptRefV1;
  batches: [CollectionBatch, ...CollectionBatch[]];
  completedAt: string;
}

export interface PageActionExecuteResponseV1 {
  executionAttemptReceipt: PageActionExecutionAttemptReceiptV1;
  completionReceipt?: PageActionCompletionReceiptV1;
}

export interface PageActionCancelV1 {
  schema: 'collector.page-action.cancel.v1';
  requestId: string;
  idempotencyKey: string;
  pageActionId: string;
  logicalLineage: LogicalPageActionLineageV1;
  logicalLineageHash: string;
  executionLineage: PageActionExecutionLineageV1;
  executionLineageHash: string;
  reason: string;
}

export interface PageActionReceiptLookupV1 {
  schema: 'collector.page-action.lookup-receipt.v1';
  requestId: string;
  idempotencyKey: string;
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  logicalLineageId: string;
  logicalLineageHash: string;
  targetExecutionLineageHash: string;
  readFences: {
    supervisor: LeaseFenceV1;
    reservation: LeaseFenceV1;
    workUnit: LeaseFenceV1;
  };
}

export type CollectorWireResponseV1 = CollectionBatch | PageActionExecuteResponseV1;

export function canonicalCollectorJsonV1(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

export function canonicalCollectorSha256V1(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalCollectorJsonV1(value), 'utf8')
    .digest('hex')}`;
}

export function pageActionBusinessFieldPathsV1(
  action: PageActionPayloadV1,
): readonly string[] {
  const businessPayload = pageActionBusinessPayload(action);
  const paths: string[] = [];
  const visit = (value: CollectorJsonValue, path: string): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value).sort()) {
        visit(value[key]!, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    paths.push(path);
  };
  visit(canonicalize(businessPayload, 'actionBusinessPayload'), '');
  return Object.freeze(paths);
}

export function computePageActionPayloadBusinessHashV1(
  action: PageActionPayloadV1,
): string {
  return canonicalCollectorSha256V1(pageActionBusinessPayload(action));
}

export function computeCollectorExecutionHandleSignatureV1(
  handle: Omit<SignedCollectorExecutionHandleV1, 'signature'> & {
    signature?: string;
  },
  key: string | Uint8Array,
): string {
  return signCanonicalPayload(handle, key, 'collector execution handle key');
}

export function computeSearchRecoveryHandleSignatureV1(
  handle: Omit<SignedSearchRecoveryHandleV1, 'signature'> & {
    signature?: string;
  },
  key: string | Uint8Array,
): string {
  return signCanonicalPayload(handle, key, 'search recovery handle key');
}

export function computeStoreSampleExpansionApprovalSignatureV1(
  approval: Omit<SignedStoreSampleExpansionApprovalV1, 'signature'> & {
    signature?: string;
  },
  key: string | Uint8Array,
): string {
  return signCanonicalPayload(approval, key, 'store expansion approval key');
}

export function effectivePageActionDeadlineV1(
  request: Pick<PageActionRequestV1, 'deadlineAt' | 'executionLineage'>,
): string {
  return earliestTimestamp([
    request.deadlineAt,
    request.executionLineage.fences.supervisor.leaseNotAfter,
    request.executionLineage.fences.reservation.leaseNotAfter,
    request.executionLineage.fences.workUnit.leaseNotAfter,
  ]);
}

export function computeLogicalLineageHashV1(
  lineage: LogicalPageActionLineageV1,
): string {
  return canonicalCollectorSha256V1(lineage);
}

export function computeExecutionLineageHashV1(
  lineage: PageActionExecutionLineageV1,
): string {
  return canonicalCollectorSha256V1(lineage);
}

export function computeExecutionAttemptReceiptHashV1(
  receipt: Omit<PageActionExecutionAttemptReceiptV1, 'receiptHash'> & {
    receiptHash?: string;
  },
): string {
  const { receiptHash: _ignored, ...content } = receipt;
  return canonicalCollectorSha256V1(content);
}

export function computeCompletionReceiptHashV1(
  receipt: Omit<PageActionCompletionReceiptV1, 'completionReceiptHash'> & {
    completionReceiptHash?: string;
  },
): string {
  const { completionReceiptHash: _ignored, ...content } = receipt;
  return canonicalCollectorSha256V1(content);
}

export function normalizeFieldAvailabilityV1(value: unknown): FieldAvailabilityV1 {
  return requireEnum(value, FIELD_AVAILABILITY_VALUES, 'availability');
}

export function normalizeSearchQueryTerminalReasonV1(
  value: unknown,
): SearchQueryTerminalReasonV1 {
  return requireEnum(value, SEARCH_QUERY_TERMINAL_REASONS, 'terminalReason');
}

export function normalizeQualificationMediaSourceCoverageV1(
  value: unknown,
): QualificationMediaSourceCoverageV1 {
  return requireEnum(
    value,
    QUALIFICATION_MEDIA_SOURCE_COVERAGE_VALUES,
    'qualificationMediaSourceCoverage',
  );
}

export function normalizePageActionRequestV1(
  value: unknown,
  verification: PageActionVerificationConfigV1,
): PageActionRequestV1 {
  const record = strictRecord(value, 'PageActionRequestV1', [
    'schema', 'requestId', 'idempotencyKey', 'pageActionId',
    'pageActionExecutionAttemptId', 'executionAttemptOrdinal',
    'predecessorExecutionAttemptReceipt', 'pageActionBusinessHash',
    'logicalLineage', 'logicalLineageHash', 'executionLineage',
    'executionLineageHash', 'actionKind', 'startNotBefore', 'leaseNotAfter',
    'deadlineAt', 'policyRevisionIds', 'action',
  ]);
  requireLiteral(record.schema, PAGE_ACTION_REQUEST_SCHEMA, 'PageActionRequestV1.schema');
  const requestId = requireId(record.requestId, 'PageActionRequestV1.requestId');
  const idempotencyKey = requireId(record.idempotencyKey, 'PageActionRequestV1.idempotencyKey');
  const pageActionId = requireId(record.pageActionId, 'PageActionRequestV1.pageActionId');
  const pageActionExecutionAttemptId = requireId(
    record.pageActionExecutionAttemptId,
    'PageActionRequestV1.pageActionExecutionAttemptId',
  );
  const executionAttemptOrdinal = requirePositiveInteger(
    record.executionAttemptOrdinal,
    'PageActionRequestV1.executionAttemptOrdinal',
  );
  const predecessorExecutionAttemptReceipt = normalizePredecessor(
    record.predecessorExecutionAttemptReceipt,
    executionAttemptOrdinal,
    'PageActionRequestV1.predecessorExecutionAttemptReceipt',
  );
  const pageActionBusinessHash = requireHash(
    record.pageActionBusinessHash,
    'PageActionRequestV1.pageActionBusinessHash',
  );
  const logicalLineage = normalizeLogicalLineage(record.logicalLineage);
  const logicalLineageHash = requireComputedHash(
    record.logicalLineageHash,
    logicalLineage,
    'PageActionRequestV1.logicalLineageHash',
  );
  const executionLineage = normalizeExecutionLineage(record.executionLineage);
  const executionLineageHash = requireComputedHash(
    record.executionLineageHash,
    executionLineage,
    'PageActionRequestV1.executionLineageHash',
  );
  const actionKind = requireEnum(
    record.actionKind,
    PAGE_ACTION_KINDS,
    'PageActionRequestV1.actionKind',
  );
  const startNotBefore = requireTimestamp(record.startNotBefore, 'PageActionRequestV1.startNotBefore');
  const leaseNotAfter = requireTimestamp(record.leaseNotAfter, 'PageActionRequestV1.leaseNotAfter');
  const deadlineAt = requireTimestamp(record.deadlineAt, 'PageActionRequestV1.deadlineAt');
  const policyRevisionIds = requireUniqueIds(
    record.policyRevisionIds,
    'PageActionRequestV1.policyRevisionIds',
    true,
  );
  const action = normalizePageActionPayload(record.action);

  equal(actionKind, action.kind, 'actionKind/action.kind');
  equal(logicalLineage.actionKind, actionKind, 'logicalLineage.actionKind/actionKind');
  equal(logicalLineage.businessSubject.kind, actionKind, 'businessSubject.kind/actionKind');
  equal(logicalLineage.pageActionId, pageActionId, 'logicalLineage.pageActionId/pageActionId');
  equal(
    logicalLineage.pageActionBusinessHash,
    pageActionBusinessHash,
    'logicalLineage.pageActionBusinessHash/pageActionBusinessHash',
  );
  equal(
    executionLineage.logicalLineageId,
    logicalLineage.logicalLineageId,
    'executionLineage.logicalLineageId/logicalLineage.logicalLineageId',
  );
  equal(executionLineage.logicalLineageHash, logicalLineageHash, 'executionLineage.logicalLineageHash');
  equal(executionLineage.requestId, requestId, 'executionLineage.requestId/requestId');
  equal(executionLineage.idempotencyKey, idempotencyKey, 'executionLineage.idempotencyKey/idempotencyKey');
  equal(
    executionLineage.pageActionExecutionAttemptId,
    pageActionExecutionAttemptId,
    'executionLineage.pageActionExecutionAttemptId/pageActionExecutionAttemptId',
  );
  equal(
    executionLineage.executionAttemptOrdinal,
    executionAttemptOrdinal,
    'executionLineage.executionAttemptOrdinal/executionAttemptOrdinal',
  );
  assertActionMatchesSubject(action, logicalLineage.businessSubject);
  equal(
    pageActionBusinessHash,
    computePageActionPayloadBusinessHashV1(action),
    'pageActionBusinessHash/action payload canonical business hash',
  );
  equal(action.executionHandle.actionKind, actionKind, 'executionHandle.actionKind/actionKind');
  equal(
    action.executionHandle.subjectHash,
    canonicalCollectorSha256V1(logicalLineage.businessSubject),
    'executionHandle.subjectHash/businessSubject hash',
  );
  verifyExecutionHandle(action, verification);
  equal(
    action.executionHandle.actionPayloadBusinessHash,
    pageActionBusinessHash,
    'executionHandle.actionPayloadBusinessHash/pageActionBusinessHash',
  );
  equal(
    action.executionHandle.policyRevisionIdsHash,
    canonicalCollectorSha256V1(policyRevisionIds),
    'executionHandle.policyRevisionIdsHash/policyRevisionIds hash',
  );

  const earliestFenceExpiry = earliestTimestamp([
    executionLineage.fences.supervisor.leaseNotAfter,
    executionLineage.fences.reservation.leaseNotAfter,
    executionLineage.fences.workUnit.leaseNotAfter,
  ]);
  equal(leaseNotAfter, earliestFenceExpiry, 'leaseNotAfter/earliest fence expiry');
  if (Date.parse(startNotBefore) > Math.min(Date.parse(leaseNotAfter), Date.parse(deadlineAt))) {
    invalid('PageActionRequestV1.startNotBefore must not be after its effective deadline.');
  }
  if (Date.parse(startNotBefore) < Date.parse(action.executionHandle.notBefore)) {
    invalid('PageActionRequestV1.startNotBefore must be within the execution handle validity window.');
  }
  if (
    Math.min(Date.parse(leaseNotAfter), Date.parse(deadlineAt)) >
    Date.parse(action.executionHandle.expiresAt)
  ) {
    invalid('PageActionRequestV1 effective deadline must not exceed execution handle expiry.');
  }
  if (action.kind === 'search-list' && action.recoveryHandle !== undefined) {
    verifySignedPayload(
      action.recoveryHandle,
      action.recoveryHandle.signingKeyId,
      action.recoveryHandle.signature,
      verification,
      'search recovery handle',
    );
    equal(
      action.recoveryHandle.allowedNextPage,
      action.request.requestedStartPage,
      'recovery handle allowedNextPage/requestedStartPage',
    );
    if (
      action.recoveryHandle.recoveryMode === 'safe-replay' &&
      action.recoveryHandle.checkpointPage > action.recoveryHandle.maxSafeReplayPages
    ) {
      invalid('Safe replay recovery checkpoint exceeds its signed replay bound.');
    }
  }
  if (action.kind === 'store-sample' && action.expansionApproval !== undefined) {
    verifySignedPayload(
      action.expansionApproval,
      action.expansionApproval.signingKeyId,
      action.expansionApproval.signature,
      verification,
      'store expansion approval',
    );
    verifyExpansionPolicyAuthorization(action.expansionApproval, verification);
    equal(
      action.expansionApproval.dispatchGates.profileId,
      executionLineage.profile.profileId,
      'expansion approval dispatch profile/execution profile',
    );
    if (
      Date.parse(startNotBefore) < Date.parse(action.expansionApproval.baselineObservedAt) ||
      Math.min(Date.parse(leaseNotAfter), Date.parse(deadlineAt)) >
        Date.parse(action.expansionApproval.baselineExpiresAt)
    ) {
      invalid('Approved expansion requires a fresh baseline for the entire effective execution window.');
    }
    if (
      Date.parse(startNotBefore) < Date.parse(action.expansionApproval.approvedAt) ||
      Math.min(Date.parse(leaseNotAfter), Date.parse(deadlineAt)) >
        Date.parse(action.expansionApproval.expiresAt)
    ) {
      invalid('Approved expansion must remain within its independent approval window.');
    }
  }
  if (
    action.kind === 'search-list' &&
    action.recoveryHandle !== undefined &&
    Date.parse(startNotBefore) > Date.parse(action.recoveryHandle.expiresAt)
  ) {
    invalid('PageActionRequestV1 recovery handle must be valid at startNotBefore.');
  }

  return omitUndefined({
    schema: PAGE_ACTION_REQUEST_SCHEMA,
    requestId,
    idempotencyKey,
    pageActionId,
    pageActionExecutionAttemptId,
    executionAttemptOrdinal,
    predecessorExecutionAttemptReceipt,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash,
    actionKind,
    startNotBefore,
    leaseNotAfter,
    deadlineAt,
    policyRevisionIds,
    action,
  });
}

export function normalizePageActionExecutionAttemptReceiptV1(
  value: unknown,
): PageActionExecutionAttemptReceiptV1 {
  const record = strictRecord(value, 'PageActionExecutionAttemptReceiptV1', [
    'schema', 'receiptId', 'receiptHash', 'requestId', 'idempotencyKey',
    'pageActionId', 'pageActionExecutionAttemptId', 'executionAttemptOrdinal',
    'predecessorExecutionAttemptReceipt', 'pageActionBusinessHash',
    'logicalLineage', 'logicalLineageHash', 'executionLineage',
    'executionLineageHash', 'outcome', 'terminal', 'actionKind',
    'remoteRequestAttempts', 'batches', 'requestSnapshots', 'pageLifecycle',
    'metrics', 'error',
  ]);
  requireLiteral(record.schema, PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA, 'execution receipt schema');
  const receiptId = requireId(record.receiptId, 'execution receipt receiptId');
  const receiptHash = requireHash(record.receiptHash, 'execution receipt receiptHash');
  const requestId = requireId(record.requestId, 'execution receipt requestId');
  const idempotencyKey = requireId(record.idempotencyKey, 'execution receipt idempotencyKey');
  const pageActionId = requireId(record.pageActionId, 'execution receipt pageActionId');
  const pageActionExecutionAttemptId = requireId(
    record.pageActionExecutionAttemptId,
    'execution receipt pageActionExecutionAttemptId',
  );
  const executionAttemptOrdinal = requirePositiveInteger(
    record.executionAttemptOrdinal,
    'execution receipt executionAttemptOrdinal',
  );
  const predecessorExecutionAttemptReceipt = normalizePredecessor(
    record.predecessorExecutionAttemptReceipt,
    executionAttemptOrdinal,
    'execution receipt predecessorExecutionAttemptReceipt',
  );
  const pageActionBusinessHash = requireHash(record.pageActionBusinessHash, 'execution receipt business hash');
  const logicalLineage = normalizeLogicalLineage(record.logicalLineage);
  const logicalLineageHash = requireComputedHash(record.logicalLineageHash, logicalLineage, 'execution receipt logicalLineageHash');
  const executionLineage = normalizeExecutionLineage(record.executionLineage);
  const executionLineageHash = requireComputedHash(record.executionLineageHash, executionLineage, 'execution receipt executionLineageHash');
  const outcome = requireEnum(
    record.outcome,
    ['completed', 'partial', 'blocked', 'failed', 'cancelled'] as const,
    'execution receipt outcome',
  );
  requireLiteral(record.terminal, true, 'execution receipt terminal');
  const actionKind = requireEnum(record.actionKind, PAGE_ACTION_KINDS, 'execution receipt actionKind');
  const remoteRequestAttempts = requireArray(record.remoteRequestAttempts, 'remoteRequestAttempts')
    .map((entry, index) => normalizeRemoteRequestAttempt(entry, index));
  assertContiguousOrdinals(
    remoteRequestAttempts.map((attempt) => attempt.ordinal),
    'remoteRequestAttempts',
  );
  requireUniqueValues(
    remoteRequestAttempts.map((attempt) => attempt.remoteRequestAttemptId),
    'remoteRequestAttempts.remoteRequestAttemptId',
  );
  const batches = requireArray(record.batches, 'execution receipt batches').map((batch) =>
    normalizeCollectionBatch(batch)
  );
  requireUniqueValues(
    batches.map((batch) => batch.batchId),
    'execution receipt batches.batchId',
  );
  const requestSnapshots = requireArray(record.requestSnapshots, 'requestSnapshots')
    .map((entry, index) => normalizeRequestSnapshot(entry, index));
  const pageLifecycle = normalizePageLifecycle(record.pageLifecycle);
  const metrics = requireNumberRecord(record.metrics, 'execution receipt metrics');
  const error = record.error === undefined ? undefined : normalizeCollectorErrorV1(record.error);

  if (outcome === 'completed' && error !== undefined) {
    invalid('A completed execution attempt receipt must not contain an error.');
  }
  if (
    (outcome === 'blocked' || outcome === 'failed' || outcome === 'cancelled') &&
    error === undefined
  ) {
    invalid(`A ${outcome} execution attempt receipt requires an error.`);
  }

  equal(logicalLineage.pageActionId, pageActionId, 'execution receipt logical pageActionId');
  equal(logicalLineage.pageActionBusinessHash, pageActionBusinessHash, 'execution receipt logical business hash');
  equal(logicalLineage.actionKind, actionKind, 'execution receipt logical actionKind');
  equal(executionLineage.logicalLineageId, logicalLineage.logicalLineageId, 'execution receipt logicalLineageId');
  equal(executionLineage.logicalLineageHash, logicalLineageHash, 'execution receipt lineage hash');
  equal(executionLineage.requestId, requestId, 'execution receipt requestId');
  equal(executionLineage.idempotencyKey, idempotencyKey, 'execution receipt idempotencyKey');
  equal(executionLineage.pageActionExecutionAttemptId, pageActionExecutionAttemptId, 'execution receipt attemptId');
  equal(executionLineage.executionAttemptOrdinal, executionAttemptOrdinal, 'execution receipt ordinal');
  const attemptsById = new Map(
    remoteRequestAttempts.map((attempt) => [attempt.remoteRequestAttemptId, attempt]),
  );
  requireUniqueValues(
    requestSnapshots.map((snapshot) => snapshot.remoteRequestAttemptId),
    'requestSnapshots.remoteRequestAttemptId',
  );
  for (const snapshot of requestSnapshots) {
    equal(snapshot.pageActionId, pageActionId, 'request snapshot pageActionId');
    equal(snapshot.pageActionExecutionAttemptId, pageActionExecutionAttemptId, 'request snapshot attemptId');
    const attempt = attemptsById.get(snapshot.remoteRequestAttemptId);
    if (attempt === undefined) invalid('Request snapshot must reference a remote request attempt in the same receipt.');
    equal(snapshot.purpose, attempt.purpose, 'request snapshot purpose');
    equal(snapshot.page, attempt.logicalPage, 'request snapshot page/remote logicalPage');
    equal(snapshot.requestBusinessHash, attempt.requestBusinessHash, 'request snapshot business hash');
    equal(
      snapshot.subjectHash,
      canonicalCollectorSha256V1(logicalLineage.businessSubject),
      'request snapshot subject hash',
    );
  }
  if (requestSnapshots.length !== remoteRequestAttempts.length) {
    invalid('Every remote request attempt must have exactly one sanitized request snapshot.');
  }

  const normalized = omitUndefined({
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId,
    receiptHash,
    requestId,
    idempotencyKey,
    pageActionId,
    pageActionExecutionAttemptId,
    executionAttemptOrdinal,
    predecessorExecutionAttemptReceipt,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash,
    outcome,
    terminal: true as const,
    actionKind,
    remoteRequestAttempts,
    batches,
    requestSnapshots,
    pageLifecycle,
    metrics,
    error,
  });
  equal(receiptHash, computeExecutionAttemptReceiptHashV1(normalized), 'execution receipt content hash');
  return deepFreeze(normalized);
}

export function normalizePageActionCompletionReceiptV1(
  value: unknown,
): PageActionCompletionReceiptV1 {
  const record = strictRecord(value, 'PageActionCompletionReceiptV1', [
    'schema', 'completionReceiptId', 'completionReceiptHash', 'pageActionId',
    'pageActionBusinessHash', 'logicalLineage', 'logicalLineageHash',
    'actionKind', 'status', 'terminal', 'executionAttemptReceiptRefs',
    'finalizedByExecutionRef', 'batches', 'completedAt',
  ]);
  requireLiteral(record.schema, PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA, 'completion receipt schema');
  const completionReceiptId = requireId(record.completionReceiptId, 'completion receipt id');
  const completionReceiptHash = requireHash(record.completionReceiptHash, 'completion receipt hash');
  const pageActionId = requireId(record.pageActionId, 'completion pageActionId');
  const pageActionBusinessHash = requireHash(record.pageActionBusinessHash, 'completion business hash');
  const logicalLineage = normalizeLogicalLineage(record.logicalLineage);
  const logicalLineageHash = requireComputedHash(record.logicalLineageHash, logicalLineage, 'completion logicalLineageHash');
  const actionKind = requireEnum(record.actionKind, PAGE_ACTION_KINDS, 'completion actionKind');
  requireLiteral(record.status, 'completed', 'completion status');
  requireLiteral(record.terminal, true, 'completion terminal');
  const refs = requireArray(record.executionAttemptReceiptRefs, 'completion refs')
    .map((entry, index) => normalizeAttemptRef(entry, `completion refs[${index}]`));
  if (refs.length === 0) invalid('PageActionCompletionReceiptV1 requires at least one execution attempt ref.');
  assertContiguousOrdinals(refs.map((ref) => ref.executionAttemptOrdinal), 'completion refs');
  requireUniqueValues(refs.map((ref) => ref.receiptId), 'completion refs.receiptId');
  requireUniqueValues(
    refs.map((ref) => ref.pageActionExecutionAttemptId),
    'completion refs.pageActionExecutionAttemptId',
  );
  const sortedRefs = [...refs].sort(compareAttemptRefs);
  if (refs.some((ref, index) => compareAttemptRefs(ref, sortedRefs[index]!) !== 0)) {
    invalid('PageActionCompletionReceiptV1 refs must be sorted by ordinal then receiptHash.');
  }
  const finalizedByExecutionRef = record.finalizedByExecutionRef === undefined
    ? undefined
    : normalizeAttemptRef(record.finalizedByExecutionRef, 'completion finalizedByExecutionRef');
  if (
    finalizedByExecutionRef !== undefined &&
    !refs.some((ref) => canonicalCollectorJsonV1(ref) === canonicalCollectorJsonV1(finalizedByExecutionRef))
  ) {
    invalid('finalizedByExecutionRef must exactly match one executionAttemptReceiptRef.');
  }
  const batches = requireArray(record.batches, 'completion batches').map((batch) =>
    normalizeCollectionBatch(batch)
  );
  if (batches.length === 0) invalid('PageActionCompletionReceiptV1 requires at least one CollectionBatch.');
  requireUniqueValues(batches.map((batch) => batch.batchId), 'completion batches.batchId');
  const completedAt = requireTimestamp(record.completedAt, 'completion completedAt');
  equal(logicalLineage.pageActionId, pageActionId, 'completion logical pageActionId');
  equal(logicalLineage.pageActionBusinessHash, pageActionBusinessHash, 'completion logical business hash');
  equal(logicalLineage.actionKind, actionKind, 'completion logical actionKind');

  const normalized = omitUndefined({
    schema: PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
    completionReceiptId,
    completionReceiptHash,
    pageActionId,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    actionKind,
    status: 'completed' as const,
    terminal: true as const,
    executionAttemptReceiptRefs: refs as [
      PageActionExecutionAttemptReceiptRefV1,
      ...PageActionExecutionAttemptReceiptRefV1[],
    ],
    finalizedByExecutionRef,
    batches: batches as [CollectionBatch, ...CollectionBatch[]],
    completedAt,
  });
  equal(completionReceiptHash, computeCompletionReceiptHashV1(normalized), 'completion receipt content hash');
  return deepFreeze(normalized);
}

export function normalizePageActionExecuteResponseV1(
  value: unknown,
): PageActionExecuteResponseV1 {
  const record = strictRecord(value, 'PageActionExecuteResponseV1', [
    'executionAttemptReceipt', 'completionReceipt',
  ]);
  const executionAttemptReceipt = normalizePageActionExecutionAttemptReceiptV1(
    record.executionAttemptReceipt,
  );
  const completionReceipt = record.completionReceipt === undefined
    ? undefined
    : normalizePageActionCompletionReceiptV1(record.completionReceipt);
  if (completionReceipt !== undefined) {
    equal(completionReceipt.pageActionId, executionAttemptReceipt.pageActionId, 'response pageActionId');
    equal(completionReceipt.logicalLineageHash, executionAttemptReceipt.logicalLineageHash, 'response logicalLineageHash');
    const returnedAttemptRef = executionAttemptReceiptRef(executionAttemptReceipt);
    if (
      !completionReceipt.executionAttemptReceiptRefs.some(
        (ref) => canonicalCollectorJsonV1(ref) === canonicalCollectorJsonV1(returnedAttemptRef),
      )
    ) {
      invalid('PageActionExecuteResponseV1 completion must exactly reference its execution attempt receipt.');
    }
    assertCompletionPreservesReturnedAttemptBatches(
      executionAttemptReceipt,
      completionReceipt,
    );
  }
  return deepFreeze(omitUndefined({ executionAttemptReceipt, completionReceipt }));
}

export function normalizeCollectorWireResponseV1(value: unknown): CollectorWireResponseV1 {
  if (isRecord(value) && Object.hasOwn(value, 'executionAttemptReceipt')) {
    return normalizePageActionExecuteResponseV1(value);
  }
  return normalizeCollectionBatch(value);
}

export function normalizePageActionCancelV1(value: unknown): PageActionCancelV1 {
  const record = strictRecord(value, 'PageActionCancelV1', [
    'schema', 'requestId', 'idempotencyKey', 'pageActionId', 'logicalLineage',
    'logicalLineageHash', 'executionLineage', 'executionLineageHash', 'reason',
  ]);
  requireLiteral(record.schema, PAGE_ACTION_CANCEL_SCHEMA, 'cancel schema');
  const requestId = requireId(record.requestId, 'cancel requestId');
  const idempotencyKey = requireId(record.idempotencyKey, 'cancel idempotencyKey');
  const pageActionId = requireId(record.pageActionId, 'cancel pageActionId');
  const logicalLineage = normalizeLogicalLineage(record.logicalLineage);
  const logicalLineageHash = requireComputedHash(record.logicalLineageHash, logicalLineage, 'cancel logicalLineageHash');
  const executionLineage = normalizeExecutionLineage(record.executionLineage);
  const executionLineageHash = requireComputedHash(record.executionLineageHash, executionLineage, 'cancel executionLineageHash');
  const reason = requireText(record.reason, 'cancel reason');
  equal(logicalLineage.pageActionId, pageActionId, 'cancel pageActionId lineage');
  equal(executionLineage.logicalLineageId, logicalLineage.logicalLineageId, 'cancel logicalLineageId');
  equal(executionLineage.logicalLineageHash, logicalLineageHash, 'cancel logicalLineageHash');
  equal(executionLineage.requestId, requestId, 'cancel requestId');
  equal(executionLineage.idempotencyKey, idempotencyKey, 'cancel idempotencyKey');
  return {
    schema: PAGE_ACTION_CANCEL_SCHEMA, requestId, idempotencyKey,
    pageActionId, logicalLineage, logicalLineageHash, executionLineage,
    executionLineageHash, reason,
  };
}

export function normalizePageActionReceiptLookupV1(
  value: unknown,
): PageActionReceiptLookupV1 {
  const record = strictRecord(value, 'PageActionReceiptLookupV1', [
    'schema', 'requestId', 'idempotencyKey', 'pageActionId',
    'pageActionExecutionAttemptId', 'logicalLineageId', 'logicalLineageHash',
    'targetExecutionLineageHash', 'readFences',
  ]);
  requireLiteral(record.schema, PAGE_ACTION_RECEIPT_LOOKUP_SCHEMA, 'lookup schema');
  const fencesRecord = strictRecord(record.readFences, 'lookup readFences', [
    'supervisor', 'reservation', 'workUnit',
  ]);
  return {
    schema: PAGE_ACTION_RECEIPT_LOOKUP_SCHEMA,
    requestId: requireId(record.requestId, 'lookup requestId'),
    idempotencyKey: requireId(record.idempotencyKey, 'lookup idempotencyKey'),
    pageActionId: requireId(record.pageActionId, 'lookup pageActionId'),
    pageActionExecutionAttemptId: requireId(record.pageActionExecutionAttemptId, 'lookup attemptId'),
    logicalLineageId: requireId(record.logicalLineageId, 'lookup logicalLineageId'),
    logicalLineageHash: requireHash(record.logicalLineageHash, 'lookup logicalLineageHash'),
    targetExecutionLineageHash: requireHash(record.targetExecutionLineageHash, 'lookup targetExecutionLineageHash'),
    readFences: {
      supervisor: normalizeLeaseFence(fencesRecord.supervisor, 'lookup supervisor fence'),
      reservation: normalizeLeaseFence(fencesRecord.reservation, 'lookup reservation fence'),
      workUnit: normalizeLeaseFence(fencesRecord.workUnit, 'lookup workUnit fence'),
    },
  };
}

export function validatePageActionAttemptChainV1(
  attemptsInput: readonly unknown[],
  completionInput?: unknown,
): readonly PageActionExecutionAttemptReceiptV1[] {
  const attempts = attemptsInput.map(normalizePageActionExecutionAttemptReceiptV1)
    .sort((a, b) => a.executionAttemptOrdinal - b.executionAttemptOrdinal);
  if (attempts.length === 0) invalid('A PageAction attempt chain must contain at least one receipt.');
  assertContiguousOrdinals(attempts.map((attempt) => attempt.executionAttemptOrdinal), 'attempt chain');
  const first = attempts[0]!;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]!;
    equal(attempt.pageActionId, first.pageActionId, 'attempt chain pageActionId');
    equal(attempt.pageActionBusinessHash, first.pageActionBusinessHash, 'attempt chain business hash');
    equal(attempt.logicalLineageHash, first.logicalLineageHash, 'attempt chain logical lineage');
    equal(attempt.actionKind, first.actionKind, 'attempt chain actionKind');
    if (index === 0) continue;
    const previous = attempts[index - 1]!;
    equal(
      attempt.predecessorExecutionAttemptReceipt?.receiptId,
      previous.receiptId,
      'attempt chain predecessor receiptId',
    );
    equal(
      attempt.predecessorExecutionAttemptReceipt?.receiptHash,
      previous.receiptHash,
      'attempt chain predecessor receiptHash',
    );
  }
  if (completionInput !== undefined) {
    const completion = normalizePageActionCompletionReceiptV1(completionInput);
    equal(completion.pageActionId, first.pageActionId, 'completion chain pageActionId');
    equal(completion.logicalLineageHash, first.logicalLineageHash, 'completion chain logicalLineageHash');
    if (completion.executionAttemptReceiptRefs.length !== attempts.length) {
      invalid('Completion receipt must reference every immutable execution attempt exactly once.');
    }
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      const ref = completion.executionAttemptReceiptRefs[index]!;
      equal(ref.pageActionExecutionAttemptId, attempt.pageActionExecutionAttemptId, 'completion ref attemptId');
      equal(ref.executionAttemptOrdinal, attempt.executionAttemptOrdinal, 'completion ref ordinal');
      equal(ref.receiptId, attempt.receiptId, 'completion ref receiptId');
      equal(ref.receiptHash, attempt.receiptHash, 'completion ref receiptHash');
      equal(ref.executionLineageHash, attempt.executionLineageHash, 'completion ref executionLineageHash');
    }
    if (!attempts.some((attempt) => attempt.outcome === 'completed')) {
      invalid('A completion receipt requires at least one completed execution attempt.');
    }
    if (completion.finalizedByExecutionRef !== undefined) {
      const finalAttempt = attempts.find(
        (attempt) =>
          attempt.receiptId === completion.finalizedByExecutionRef?.receiptId &&
          attempt.receiptHash === completion.finalizedByExecutionRef.receiptHash,
      );
      if (finalAttempt?.outcome !== 'completed') {
        invalid('finalizedByExecutionRef must reference a completed execution attempt.');
      }
    }
    assertCompletionPreservesAttemptBatches(attempts, completion);
  }
  return attempts;
}

export function validateUniquePageActionCompletionsV1(
  values: readonly unknown[],
): readonly PageActionCompletionReceiptV1[] {
  const completions = values.map(normalizePageActionCompletionReceiptV1);
  const seen = new Set<string>();
  for (const completion of completions) {
    if (seen.has(completion.pageActionId)) {
      invalid(`PageAction ${completion.pageActionId} has more than one completion receipt.`);
    }
    seen.add(completion.pageActionId);
  }
  return completions;
}

export function normalizeCollectorErrorV1(value: unknown): CollectorErrorV1 {
  const record = strictRecord(value, 'CollectorErrorV1', [
    'code', 'category', 'retryable', 'actionRequired', 'recoveryAction', 'details',
  ]);
  const actionRequired = record.actionRequired === null
    ? null
    : requireText(record.actionRequired, 'CollectorErrorV1.actionRequired');
  return omitUndefined({
    code: requireCode(record.code, 'CollectorErrorV1.code'),
    category: requireEnum(record.category, COLLECTOR_ERROR_CATEGORIES, 'CollectorErrorV1.category'),
    retryable: requireBoolean(record.retryable, 'CollectorErrorV1.retryable'),
    actionRequired,
    recoveryAction: requireText(record.recoveryAction, 'CollectorErrorV1.recoveryAction'),
    details: record.details === undefined
      ? undefined
      : requireJsonObject(record.details, 'CollectorErrorV1.details'),
  });
}

function normalizeLogicalLineage(value: unknown): LogicalPageActionLineageV1 {
  const record = strictRecord(value, 'LogicalPageActionLineageV1', [
    'schema', 'logicalLineageId', 'collectionTaskId', 'workUnitId',
    'pageActionId', 'pageActionBusinessHash', 'actionKind', 'businessSubject',
  ]);
  requireLiteral(record.schema, 'collector.logical-page-action-lineage.v1', 'logical lineage schema');
  const actionKind = requireEnum(record.actionKind, PAGE_ACTION_KINDS, 'logical lineage actionKind');
  const businessSubject = normalizeBusinessSubject(record.businessSubject);
  equal(actionKind, businessSubject.kind, 'logical lineage actionKind/businessSubject.kind');
  return {
    schema: 'collector.logical-page-action-lineage.v1',
    logicalLineageId: requireId(record.logicalLineageId, 'logicalLineageId'),
    collectionTaskId: requireId(record.collectionTaskId, 'collectionTaskId'),
    workUnitId: requireId(record.workUnitId, 'workUnitId'),
    pageActionId: requireId(record.pageActionId, 'pageActionId'),
    pageActionBusinessHash: requireHash(record.pageActionBusinessHash, 'pageActionBusinessHash'),
    actionKind,
    businessSubject,
  };
}

function normalizeBusinessSubject(value: unknown): LogicalPageActionBusinessSubjectV1 {
  const record = requireRecord(value, 'businessSubject');
  const kind = requireEnum(record.kind, PAGE_ACTION_KINDS, 'businessSubject.kind');
  if (kind === 'search-list') {
    assertKeys(record, 'search businessSubject', ['kind', 'searchQueryKeyHash', 'querySnapshotHash']);
    return {
      kind,
      searchQueryKeyHash: requireHash(record.searchQueryKeyHash, 'searchQueryKeyHash'),
      querySnapshotHash: requireHash(record.querySnapshotHash, 'querySnapshotHash'),
    };
  }
  if (kind === 'offer-detail') {
    assertKeys(record, 'offer businessSubject', [
      'kind', 'offerId', 'memberId', 'searchOriginReceiptId', 'searchOriginReceiptHash',
    ]);
    return {
      kind,
      offerId: requireOfferId(record.offerId, 'offer businessSubject offerId'),
      memberId: requireMemberId(record.memberId, 'offer businessSubject memberId'),
      searchOriginReceiptId: requireId(record.searchOriginReceiptId, 'searchOriginReceiptId'),
      searchOriginReceiptHash: requireHash(record.searchOriginReceiptHash, 'searchOriginReceiptHash'),
    };
  }
  if (kind === 'store-qualification') {
    assertKeys(record, 'qualification businessSubject', [
      'kind', 'memberId', 'canonicalStoreIdentityReceiptId', 'canonicalStoreIdentityReceiptHash',
    ]);
    return {
      kind,
      memberId: requireMemberId(record.memberId, 'qualification businessSubject memberId'),
      canonicalStoreIdentityReceiptId: requireId(record.canonicalStoreIdentityReceiptId, 'canonicalStoreIdentityReceiptId'),
      canonicalStoreIdentityReceiptHash: requireHash(record.canonicalStoreIdentityReceiptHash, 'canonicalStoreIdentityReceiptHash'),
    };
  }
  assertKeys(record, 'store sample businessSubject', [
    'kind', 'memberId', 'canonicalShopIdentityReceiptId',
    'canonicalShopIdentityReceiptHash', 'pageScopeBusinessHash',
  ]);
  return {
    kind,
    memberId: requireMemberId(record.memberId, 'store sample businessSubject memberId'),
    canonicalShopIdentityReceiptId: requireId(record.canonicalShopIdentityReceiptId, 'canonicalShopIdentityReceiptId'),
    canonicalShopIdentityReceiptHash: requireHash(record.canonicalShopIdentityReceiptHash, 'canonicalShopIdentityReceiptHash'),
    pageScopeBusinessHash: requireHash(record.pageScopeBusinessHash, 'pageScopeBusinessHash'),
  };
}

function normalizeExecutionLineage(value: unknown): PageActionExecutionLineageV1 {
  const record = strictRecord(value, 'PageActionExecutionLineageV1', [
    'schema', 'logicalLineageId', 'logicalLineageHash', 'workUnitAttemptId',
    'pageActionExecutionAttemptId', 'executionAttemptOrdinal', 'requestId',
    'idempotencyKey', 'profile', 'fences',
  ]);
  requireLiteral(record.schema, 'collector.page-action-execution-lineage.v1', 'execution lineage schema');
  const profile = strictRecord(record.profile, 'execution lineage profile', [
    'profileId', 'profileName', 'daemonInstanceId', 'contextGeneration', 'egressId',
  ]);
  const fences = strictRecord(record.fences, 'execution lineage fences', [
    'supervisor', 'reservation', 'workUnit',
  ]);
  return {
    schema: 'collector.page-action-execution-lineage.v1',
    logicalLineageId: requireId(record.logicalLineageId, 'execution logicalLineageId'),
    logicalLineageHash: requireHash(record.logicalLineageHash, 'execution logicalLineageHash'),
    workUnitAttemptId: requireId(record.workUnitAttemptId, 'workUnitAttemptId'),
    pageActionExecutionAttemptId: requireId(record.pageActionExecutionAttemptId, 'pageActionExecutionAttemptId'),
    executionAttemptOrdinal: requirePositiveInteger(record.executionAttemptOrdinal, 'executionAttemptOrdinal'),
    requestId: requireId(record.requestId, 'execution requestId'),
    idempotencyKey: requireId(record.idempotencyKey, 'execution idempotencyKey'),
    profile: {
      profileId: requireId(profile.profileId, 'profile.profileId'),
      profileName: requireProfileName(profile.profileName, 'profile.profileName'),
      daemonInstanceId: requireId(profile.daemonInstanceId, 'profile.daemonInstanceId'),
      contextGeneration: requireNonNegativeInteger(profile.contextGeneration, 'profile.contextGeneration'),
      egressId: requireId(profile.egressId, 'profile.egressId'),
    },
    fences: {
      supervisor: normalizeLeaseFence(fences.supervisor, 'supervisor fence'),
      reservation: normalizeLeaseFence(fences.reservation, 'reservation fence'),
      workUnit: normalizeLeaseFence(fences.workUnit, 'workUnit fence'),
    },
  };
}

function normalizeLeaseFence(value: unknown, path: string): LeaseFenceV1 {
  const record = strictRecord(value, path, [
    'leaseId', 'generation', 'fencingToken', 'leaseNotAfter',
  ]);
  return {
    leaseId: requireId(record.leaseId, `${path}.leaseId`),
    generation: requireNonNegativeInteger(record.generation, `${path}.generation`),
    fencingToken: requireId(record.fencingToken, `${path}.fencingToken`),
    leaseNotAfter: requireTimestamp(record.leaseNotAfter, `${path}.leaseNotAfter`),
  };
}

function normalizePageActionPayload(value: unknown): PageActionPayloadV1 {
  const record = requireRecord(value, 'PageActionPayloadV1');
  const kind = requireEnum(record.kind, PAGE_ACTION_KINDS, 'PageActionPayloadV1.kind');
  if (kind === 'search-list') {
    assertKeys(record, 'SearchActionV1', ['kind', 'request', 'executionHandle', 'recoveryHandle']);
    const request = normalizeCanonicalSearchRequest(record.request);
    const executionHandle = normalizeExecutionHandle(record.executionHandle);
    const recoveryHandle = record.recoveryHandle === undefined
      ? undefined
      : normalizeRecoveryHandle(record.recoveryHandle);
    if (recoveryHandle !== undefined) {
      equal(recoveryHandle.searchQueryKeyHash, request.searchQueryKeyHash, 'recovery/search query hash');
    }
    return omitUndefined({ kind, request, executionHandle, recoveryHandle });
  }
  if (kind === 'offer-detail') {
    assertKeys(record, 'OfferActionV1', [
      'kind', 'offerId', 'memberId', 'searchOriginReceiptId',
      'searchOriginReceiptHash', 'executionHandle',
    ]);
    return {
      kind,
      offerId: requireOfferId(record.offerId, 'OfferActionV1.offerId'),
      memberId: requireMemberId(record.memberId, 'OfferActionV1.memberId'),
      searchOriginReceiptId: requireId(record.searchOriginReceiptId, 'OfferActionV1.searchOriginReceiptId'),
      searchOriginReceiptHash: requireHash(record.searchOriginReceiptHash, 'OfferActionV1.searchOriginReceiptHash'),
      executionHandle: normalizeExecutionHandle(record.executionHandle),
    };
  }
  if (kind === 'store-qualification') {
    assertKeys(record, 'QualificationActionV1', [
      'kind', 'memberId', 'canonicalStoreIdentityReceiptId',
      'canonicalStoreIdentityReceiptHash', 'executionHandle',
    ]);
    return {
      kind,
      memberId: requireMemberId(record.memberId, 'QualificationActionV1.memberId'),
      canonicalStoreIdentityReceiptId: requireId(record.canonicalStoreIdentityReceiptId, 'QualificationActionV1.canonicalStoreIdentityReceiptId'),
      canonicalStoreIdentityReceiptHash: requireHash(record.canonicalStoreIdentityReceiptHash, 'QualificationActionV1.canonicalStoreIdentityReceiptHash'),
      executionHandle: normalizeExecutionHandle(record.executionHandle),
    };
  }
  assertKeys(record, 'StoreSampleActionV1', [
    'kind', 'memberId', 'canonicalShopIdentityReceiptId',
    'canonicalShopIdentityReceiptHash', 'mode', 'pageScope',
    'expansionApproval', 'executionHandle',
  ]);
  const mode = requireEnum(
    record.mode,
    ['phase-1-bounded', 'approved-expansion'] as const,
    'StoreSampleActionV1.mode',
  );
  const pageScopeRecord = strictRecord(record.pageScope, 'StoreSampleActionV1.pageScope', [
    'firstPage', 'lastPageInclusive',
  ]);
  const pageScope = {
    firstPage: requirePositiveInteger(pageScopeRecord.firstPage, 'StoreSampleActionV1.pageScope.firstPage'),
    lastPageInclusive: requirePositiveInteger(pageScopeRecord.lastPageInclusive, 'StoreSampleActionV1.pageScope.lastPageInclusive'),
  };
  if (pageScope.lastPageInclusive < pageScope.firstPage) {
    invalid('StoreSampleActionV1.pageScope must be an ascending inclusive range.');
  }
  if (mode === 'phase-1-bounded' && (pageScope.firstPage !== 1 || pageScope.lastPageInclusive !== 3)) {
    invalid('phase-1-bounded store sample must have pageScope 1 through 3.');
  }
  const expansionApproval = record.expansionApproval === undefined
    ? undefined
    : normalizeExpansionApproval(record.expansionApproval);
  if (mode === 'phase-1-bounded' && expansionApproval !== undefined) {
    invalid('phase-1-bounded store sample must not carry expansion approval.');
  }
  if (mode === 'approved-expansion' && expansionApproval === undefined) {
    invalid('approved-expansion store sample requires an independent signed expansion approval.');
  }
  if (expansionApproval !== undefined) {
    if (pageScope.firstPage !== expansionApproval.dormantNextPage) {
      invalid('approved-expansion must start at the signed fresh baseline dormantNextPage.');
    }
    const requestedPageCount = pageScope.lastPageInclusive - pageScope.firstPage + 1;
    if (requestedPageCount !== expansionApproval.pageLimitPerAction) {
      invalid('approved-expansion page scope must match its signed dispatch page limit.');
    }
  }
  return {
    kind,
    memberId: requireMemberId(record.memberId, 'StoreSampleActionV1.memberId'),
    canonicalShopIdentityReceiptId: requireId(record.canonicalShopIdentityReceiptId, 'StoreSampleActionV1.canonicalShopIdentityReceiptId'),
    canonicalShopIdentityReceiptHash: requireHash(record.canonicalShopIdentityReceiptHash, 'StoreSampleActionV1.canonicalShopIdentityReceiptHash'),
    mode,
    pageScope,
    ...(expansionApproval === undefined ? {} : { expansionApproval }),
    executionHandle: normalizeExecutionHandle(record.executionHandle),
  };
}

function normalizeCanonicalSearchRequest(value: unknown): CanonicalSearchRequestV1 {
  const record = strictRecord(value, 'CanonicalSearchRequestV1', [
    'schema', 'searchQueryKeyHash', 'searchSegmentId', 'querySnapshotHash',
    'keyword', 'filterConfigSnapshotId', 'filterConfigSnapshotHash',
    'compilerRevision', 'serializerCapabilitySnapshotId',
    'serializerCapabilitySnapshotHash', 'sort', 'canonicalParameterSetArtifactRef',
    'canonicalParameterSetHash', 'requestedStartPage', 'requestedEndPage',
    'maxOffers', 'advertisementPolicy', 'forwardPageBudget', 'replayPageBudget',
    'maxSafeReplayPages',
  ]);
  requireLiteral(record.schema, 'canonical-search-request-v1', 'canonical search schema');
  const requestedStartPage = requirePositiveInteger(record.requestedStartPage, 'requestedStartPage');
  const requestedEndPage = requirePositiveInteger(record.requestedEndPage, 'requestedEndPage');
  if (requestedEndPage < requestedStartPage) invalid('Canonical search page range must be ascending.');
  const replayPageBudget = requireNonNegativeInteger(record.replayPageBudget, 'replayPageBudget');
  const maxSafeReplayPages = requireNonNegativeInteger(record.maxSafeReplayPages, 'maxSafeReplayPages');
  if (maxSafeReplayPages > replayPageBudget) {
    invalid('maxSafeReplayPages cannot exceed replayPageBudget.');
  }
  return {
    schema: 'canonical-search-request-v1',
    searchQueryKeyHash: requireHash(record.searchQueryKeyHash, 'searchQueryKeyHash'),
    searchSegmentId: requireId(record.searchSegmentId, 'searchSegmentId'),
    querySnapshotHash: requireHash(record.querySnapshotHash, 'querySnapshotHash'),
    keyword: requireText(record.keyword, 'keyword'),
    filterConfigSnapshotId: requireId(record.filterConfigSnapshotId, 'filterConfigSnapshotId'),
    filterConfigSnapshotHash: requireHash(record.filterConfigSnapshotHash, 'filterConfigSnapshotHash'),
    compilerRevision: requireId(record.compilerRevision, 'compilerRevision'),
    serializerCapabilitySnapshotId: requireId(record.serializerCapabilitySnapshotId, 'serializerCapabilitySnapshotId'),
    serializerCapabilitySnapshotHash: requireHash(record.serializerCapabilitySnapshotHash, 'serializerCapabilitySnapshotHash'),
    sort: requireEnum(record.sort, ['relevance', 'sales', 'price-asc', 'price-desc'] as const, 'canonical search sort'),
    canonicalParameterSetArtifactRef: requireArtifactRef(record.canonicalParameterSetArtifactRef, 'canonicalParameterSetArtifactRef'),
    canonicalParameterSetHash: requireHash(record.canonicalParameterSetHash, 'canonicalParameterSetHash'),
    requestedStartPage,
    requestedEndPage,
    maxOffers: requirePositiveInteger(record.maxOffers, 'maxOffers'),
    advertisementPolicy: requireEnum(record.advertisementPolicy, ['exclude-p4p', 'archive-and-mark'] as const, 'advertisementPolicy'),
    forwardPageBudget: requirePositiveInteger(record.forwardPageBudget, 'forwardPageBudget'),
    replayPageBudget,
    maxSafeReplayPages,
  };
}

function normalizeExecutionHandle(value: unknown): SignedCollectorExecutionHandleV1 {
  const record = strictRecord(value, 'SignedCollectorExecutionHandleV1', [
    'schema', 'handleId', 'issuer', 'actionKind', 'routeTemplateId',
    'subjectHash', 'actionPayloadBusinessHash', 'allowedRequestKeysHash',
    'policyRevisionIdsHash', 'notBefore', 'expiresAt', 'signingKeyId', 'signature',
  ]);
  requireLiteral(record.schema, 'collector-execution-handle-v1', 'execution handle schema');
  requireLiteral(record.issuer, 'trusted-page-capability-service', 'execution handle issuer');
  const notBefore = requireTimestamp(record.notBefore, 'execution handle notBefore');
  const expiresAt = requireTimestamp(record.expiresAt, 'execution handle expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(notBefore)) {
    invalid('SignedCollectorExecutionHandleV1 expiresAt must be after notBefore.');
  }
  return {
    schema: 'collector-execution-handle-v1',
    handleId: requireId(record.handleId, 'execution handle handleId'),
    issuer: 'trusted-page-capability-service',
    actionKind: requireEnum(record.actionKind, PAGE_ACTION_KINDS, 'execution handle actionKind'),
    routeTemplateId: requireId(record.routeTemplateId, 'execution handle routeTemplateId'),
    subjectHash: requireHash(record.subjectHash, 'execution handle subjectHash'),
    actionPayloadBusinessHash: requireHash(record.actionPayloadBusinessHash, 'execution handle actionPayloadBusinessHash'),
    allowedRequestKeysHash: requireHash(record.allowedRequestKeysHash, 'execution handle allowedRequestKeysHash'),
    policyRevisionIdsHash: requireHash(record.policyRevisionIdsHash, 'execution handle policyRevisionIdsHash'),
    notBefore,
    expiresAt,
    signingKeyId: requireId(record.signingKeyId, 'execution handle signingKeyId'),
    signature: requireSignature(record.signature, 'execution handle signature'),
  };
}

function normalizeRecoveryHandle(value: unknown): SignedSearchRecoveryHandleV1 {
  const record = strictRecord(value, 'SignedSearchRecoveryHandleV1', [
    'schema', 'handleId', 'recoveryReceiptId', 'recoveryReceiptHash',
    'searchQueryKeyHash', 'previousSearchSegmentId', 'checkpointPage',
    'allowedNextPage', 'recoveryMode', 'maxSafeReplayPages',
    'encryptedNavigationArchiveRef', 'expiresAt', 'signingKeyId', 'signature',
  ]);
  requireLiteral(record.schema, 'search-recovery-handle-v1', 'recovery handle schema');
  const checkpointPage = requirePositiveInteger(record.checkpointPage, 'recovery checkpointPage');
  const allowedNextPage = requirePositiveInteger(record.allowedNextPage, 'recovery allowedNextPage');
  if (allowedNextPage !== checkpointPage + 1) {
    invalid('SignedSearchRecoveryHandleV1.allowedNextPage must immediately follow checkpointPage.');
  }
  return {
    schema: 'search-recovery-handle-v1',
    handleId: requireId(record.handleId, 'recovery handleId'),
    recoveryReceiptId: requireId(record.recoveryReceiptId, 'recovery receiptId'),
    recoveryReceiptHash: requireHash(record.recoveryReceiptHash, 'recovery receiptHash'),
    searchQueryKeyHash: requireHash(record.searchQueryKeyHash, 'recovery searchQueryKeyHash'),
    previousSearchSegmentId: requireId(record.previousSearchSegmentId, 'previousSearchSegmentId'),
    checkpointPage,
    allowedNextPage,
    recoveryMode: requireEnum(record.recoveryMode, ['direct-begin-page', 'safe-replay'] as const, 'recovery mode'),
    maxSafeReplayPages: requireNonNegativeInteger(record.maxSafeReplayPages, 'recovery maxSafeReplayPages'),
    encryptedNavigationArchiveRef: requireArtifactRef(record.encryptedNavigationArchiveRef, 'encryptedNavigationArchiveRef'),
    expiresAt: requireTimestamp(record.expiresAt, 'recovery expiresAt'),
    signingKeyId: requireId(record.signingKeyId, 'recovery signingKeyId'),
    signature: requireSignature(record.signature, 'recovery signature'),
  };
}

function normalizeExpansionApproval(
  value: unknown,
): SignedStoreSampleExpansionApprovalV1 {
  const record = strictRecord(value, 'SignedStoreSampleExpansionApprovalV1', [
    'schema', 'approvalReceiptId', 'eligibilityReceiptId',
    'eligibilityReceiptHash', 'eligibilityPolicySchema', 'eligibilityPolicyRevisionId',
    'eligibilityPolicyHash', 'baselineGeneration', 'baselineObservedAt',
    'baselineExpiresAt', 'dormantNextPage', 'dispatchPolicyRevisionId',
    'dispatchPolicyHash', 'pageLimitPerAction', 'evidenceUsage', 'dispatchGates',
    'approvedAt', 'expiresAt', 'signingKeyId', 'signature',
  ]);
  requireLiteral(
    record.schema,
    'store-sample-expansion-approval-v1',
    'expansion approval schema',
  );
  const baselineObservedAt = requireTimestamp(
    record.baselineObservedAt,
    'expansion approval baselineObservedAt',
  );
  const baselineExpiresAt = requireTimestamp(
    record.baselineExpiresAt,
    'expansion approval baselineExpiresAt',
  );
  if (Date.parse(baselineExpiresAt) <= Date.parse(baselineObservedAt)) {
    invalid('Expansion approval baselineExpiresAt must be after baselineObservedAt.');
  }
  const approvedAt = requireTimestamp(record.approvedAt, 'expansion approval approvedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'expansion approval expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    invalid('Expansion approval expiresAt must be after approvedAt.');
  }
  const pageLimitPerAction = requirePositiveInteger(
    record.pageLimitPerAction,
    'expansion approval pageLimitPerAction',
  );
  if (pageLimitPerAction < 3 || pageLimitPerAction > 10) {
    invalid('Expansion approval pageLimitPerAction must be between 3 and 10.');
  }
  const dormantNextPage = requirePositiveInteger(
    record.dormantNextPage,
    'expansion dormantNextPage',
  );
  if (dormantNextPage < 4) {
    invalid('Expansion approval dormantNextPage must follow the bounded first three pages.');
  }
  const eligibilityPolicySchema = requireEnum(
    record.eligibilityPolicySchema,
    [STORE_CATALOG_ELIGIBILITY_POLICY_SCHEMA] as const,
    'expansion eligibility policy schema',
  );
  const eligibilityPolicyRevisionId = requireEnum(
    record.eligibilityPolicyRevisionId,
    [STORE_CATALOG_ELIGIBILITY_POLICY_REVISION_ID] as const,
    'expansion eligibility policy revision',
  );
  const dispatchPolicyRevisionId = requireId(
    record.dispatchPolicyRevisionId,
    'expansion dispatch policy revision',
  );
  const dispatchPolicy = STORE_CATALOG_EXPANSION_DISPATCH_POLICIES[
    dispatchPolicyRevisionId
  ];
  if (dispatchPolicy === undefined) {
    invalid('Expansion approval dispatch policy revision is not registered.');
  }
  equal(
    eligibilityPolicySchema,
    dispatchPolicy.eligibilityPolicySchema,
    'expansion eligibility policy schema/dispatch policy',
  );
  equal(
    eligibilityPolicyRevisionId,
    dispatchPolicy.eligibilityPolicyRevisionId,
    'expansion eligibility policy revision/dispatch policy',
  );
  equal(
    pageLimitPerAction,
    dispatchPolicy.pageLimitPerAction,
    'expansion pageLimitPerAction/dispatch policy revision',
  );
  const evidenceUsage = requireEnum(
    record.evidenceUsage,
    ['cache-seed-only'] as const,
    'expansion evidenceUsage',
  );
  equal(
    evidenceUsage,
    dispatchPolicy.evidenceUsage,
    'expansion evidenceUsage/dispatch policy revision',
  );
  const dispatchGatesRecord = strictRecord(
    record.dispatchGates,
    'expansion dispatchGates',
    [
      'eligibilityApproved', 'dailyQualifiedSkuTargetAccepted',
      'independentReleaseApproved', 'dispatchEnabled', 'lowPriorityQueue',
      'budgetReserved', 'profileOperationallyReady', 'profileId',
    ],
  );
  const dispatchGates = {
    eligibilityApproved: requireLiteral(
      dispatchGatesRecord.eligibilityApproved,
      true,
      'expansion dispatch eligibilityApproved',
    ),
    dailyQualifiedSkuTargetAccepted: requireLiteral(
      dispatchGatesRecord.dailyQualifiedSkuTargetAccepted,
      true,
      'expansion dispatch dailyQualifiedSkuTargetAccepted',
    ),
    independentReleaseApproved: requireLiteral(
      dispatchGatesRecord.independentReleaseApproved,
      true,
      'expansion dispatch independentReleaseApproved',
    ),
    dispatchEnabled: requireLiteral(
      dispatchGatesRecord.dispatchEnabled,
      true,
      'expansion dispatch dispatchEnabled',
    ),
    lowPriorityQueue: requireLiteral(
      dispatchGatesRecord.lowPriorityQueue,
      true,
      'expansion dispatch lowPriorityQueue',
    ),
    budgetReserved: requireLiteral(
      dispatchGatesRecord.budgetReserved,
      true,
      'expansion dispatch budgetReserved',
    ),
    profileOperationallyReady: requireLiteral(
      dispatchGatesRecord.profileOperationallyReady,
      true,
      'expansion dispatch profileOperationallyReady',
    ),
    profileId: requireId(
      dispatchGatesRecord.profileId,
      'expansion dispatch profileId',
    ),
  };
  return {
    schema: 'store-sample-expansion-approval-v1',
    approvalReceiptId: requireId(record.approvalReceiptId, 'expansion approval receiptId'),
    eligibilityReceiptId: requireId(record.eligibilityReceiptId, 'expansion eligibility receiptId'),
    eligibilityReceiptHash: requireHash(record.eligibilityReceiptHash, 'expansion eligibility receiptHash'),
    eligibilityPolicySchema,
    eligibilityPolicyRevisionId,
    eligibilityPolicyHash: requireHash(record.eligibilityPolicyHash, 'expansion eligibility policy hash'),
    baselineGeneration: requireId(record.baselineGeneration, 'expansion baseline generation'),
    baselineObservedAt,
    baselineExpiresAt,
    dormantNextPage,
    dispatchPolicyRevisionId,
    dispatchPolicyHash: requireHash(record.dispatchPolicyHash, 'expansion dispatch policy hash'),
    pageLimitPerAction,
    evidenceUsage,
    dispatchGates,
    approvedAt,
    expiresAt,
    signingKeyId: requireId(record.signingKeyId, 'expansion approval signingKeyId'),
    signature: requireSignature(record.signature, 'expansion approval signature'),
  };
}

function pageActionBusinessPayload(
  action: PageActionPayloadV1,
): CollectorJsonObject {
  if (action.kind === 'search-list') {
    return { kind: action.kind, request: action.request as unknown as CollectorJsonObject };
  }
  if (action.kind === 'offer-detail') {
    return {
      kind: action.kind,
      offerId: action.offerId,
      memberId: action.memberId,
      searchOriginReceiptId: action.searchOriginReceiptId,
      searchOriginReceiptHash: action.searchOriginReceiptHash,
    };
  }
  if (action.kind === 'store-qualification') {
    return {
      kind: action.kind,
      memberId: action.memberId,
      canonicalStoreIdentityReceiptId: action.canonicalStoreIdentityReceiptId,
      canonicalStoreIdentityReceiptHash: action.canonicalStoreIdentityReceiptHash,
    };
  }
  return {
    kind: action.kind,
    memberId: action.memberId,
    canonicalShopIdentityReceiptId: action.canonicalShopIdentityReceiptId,
    canonicalShopIdentityReceiptHash: action.canonicalShopIdentityReceiptHash,
    mode: action.mode,
    pageScope: action.pageScope,
    ...(action.expansionApproval === undefined
      ? {}
      : { expansionApproval: action.expansionApproval as unknown as CollectorJsonObject }),
  };
}

function verifyExecutionHandle(
  action: PageActionPayloadV1,
  verification: PageActionVerificationConfigV1,
): void {
  if (verification === undefined || verification === null) {
    invalid('PageAction verification config is required.');
  }
  const handle = action.executionHandle;
  const route = verification.routesById[handle.routeTemplateId];
  if (route === undefined) {
    invalid('Execution handle routeTemplateId is not in the configured route allowlist.');
  }
  equal(route.actionKind, action.kind, 'execution handle route actionKind');
  const allowedRequestKeys = [...route.allowedRequestKeys].sort();
  requireUniqueValues(allowedRequestKeys, 'configured route allowedRequestKeys');
  equal(
    handle.allowedRequestKeysHash,
    canonicalCollectorSha256V1(allowedRequestKeys),
    'executionHandle.allowedRequestKeysHash/configured route keys',
  );
  const actualKeys = pageActionBusinessFieldPathsV1(action);
  for (const key of actualKeys) {
    if (!allowedRequestKeys.includes(key)) {
      invalid(`Action business field ${key} is not authorized by its route.`);
    }
  }
  verifySignedPayload(
    handle,
    handle.signingKeyId,
    handle.signature,
    verification,
    'collector execution handle',
  );
}

function verifyExpansionPolicyAuthorization(
  approval: SignedStoreSampleExpansionApprovalV1,
  verification: PageActionVerificationConfigV1,
): void {
  const authorizations = verification.expansionPoliciesByDispatchRevisionId;
  if (authorizations === undefined || authorizations === null) {
    invalid('Expansion policy authorization config is required.');
  }
  const authorization = authorizations[
    approval.dispatchPolicyRevisionId
  ];
  if (authorization === undefined) {
    invalid('Expansion dispatch policy revision is not authorized by the verifier.');
  }
  equal(
    approval.eligibilityPolicyHash,
    requireHash(
      authorization.eligibilityPolicyHash,
      'configured expansion eligibility policy hash',
    ),
    'expansion eligibility policy hash/configured policy',
  );
  equal(
    approval.dispatchPolicyHash,
    requireHash(
      authorization.dispatchPolicyHash,
      'configured expansion dispatch policy hash',
    ),
    'expansion dispatch policy hash/configured policy',
  );
}

function verifySignedPayload(
  payload: object,
  signingKeyId: string,
  signature: string,
  verification: PageActionVerificationConfigV1,
  path: string,
): void {
  const key = verification.keysById[signingKeyId];
  if (key === undefined) invalid(`${path} signingKeyId is not trusted.`);
  const expected = signCanonicalPayload(payload, key, `${path} key`);
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = Buffer.from(signature, 'base64url');
  if (
    actualBytes.length !== 32 ||
    actualBytes.toString('base64url') !== signature
  ) {
    invalid(`${path} signature is not valid base64url.`);
  }
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    invalid(`${path} signature verification failed.`);
  }
}

function signCanonicalPayload(
  payload: object,
  key: string | Uint8Array,
  path: string,
): string {
  const keyBytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (keyBytes.length < 32) invalid(`${path} must contain at least 32 bytes.`);
  const { signature: _ignored, ...content } = payload as Record<string, unknown>;
  return createHmac('sha256', keyBytes)
    .update(canonicalCollectorJsonV1(content), 'utf8')
    .digest('base64url');
}

function assertActionMatchesSubject(
  action: PageActionPayloadV1,
  subject: LogicalPageActionBusinessSubjectV1,
): void {
  if (action.kind !== subject.kind) invalid('PageAction action and business subject discriminators differ.');
  if (action.kind === 'search-list' && subject.kind === 'search-list') {
    equal(action.request.searchQueryKeyHash, subject.searchQueryKeyHash, 'search query key hash');
    equal(action.request.querySnapshotHash, subject.querySnapshotHash, 'search query snapshot hash');
  } else if (action.kind === 'offer-detail' && subject.kind === 'offer-detail') {
    equal(action.offerId, subject.offerId, 'offerId');
    equal(action.memberId, subject.memberId, 'offer memberId');
    equal(action.searchOriginReceiptId, subject.searchOriginReceiptId, 'search origin receiptId');
    equal(action.searchOriginReceiptHash, subject.searchOriginReceiptHash, 'search origin receiptHash');
  } else if (
    action.kind === 'store-qualification' &&
    subject.kind === 'store-qualification'
  ) {
    equal(action.memberId, subject.memberId, 'qualification memberId');
    equal(action.canonicalStoreIdentityReceiptId, subject.canonicalStoreIdentityReceiptId, 'store identity receiptId');
    equal(action.canonicalStoreIdentityReceiptHash, subject.canonicalStoreIdentityReceiptHash, 'store identity receiptHash');
  } else if (action.kind === 'store-sample' && subject.kind === 'store-sample') {
    equal(action.memberId, subject.memberId, 'store sample memberId');
    equal(action.canonicalShopIdentityReceiptId, subject.canonicalShopIdentityReceiptId, 'shop identity receiptId');
    equal(action.canonicalShopIdentityReceiptHash, subject.canonicalShopIdentityReceiptHash, 'shop identity receiptHash');
    equal(canonicalCollectorSha256V1(action.pageScope), subject.pageScopeBusinessHash, 'page scope business hash');
  }
}

function normalizeRemoteRequestAttempt(value: unknown, index: number): RemoteRequestAttemptReceiptV1 {
  const path = `remoteRequestAttempts[${index}]`;
  const record = strictRecord(value, path, [
    'remoteRequestAttemptId', 'ordinal', 'logicalPage', 'purpose',
    'requestBusinessHash', 'startedAt', 'completedAt', 'status',
    'rawEvidenceRefs', 'error',
  ]);
  const startedAt = requireTimestamp(record.startedAt, `${path}.startedAt`);
  const completedAt = requireTimestamp(record.completedAt, `${path}.completedAt`);
  if (Date.parse(completedAt) < Date.parse(startedAt)) invalid(`${path}.completedAt precedes startedAt.`);
  const status = requireEnum(record.status, ['succeeded', 'failed', 'cancelled'] as const, `${path}.status`);
  const error = record.error === undefined ? undefined : normalizeCollectorErrorV1(record.error);
  if (status === 'succeeded' && error !== undefined) invalid(`${path} succeeded but contains an error.`);
  if (status !== 'succeeded' && error === undefined) invalid(`${path} ${status} requires an error.`);
  return omitUndefined({
    remoteRequestAttemptId: requireId(record.remoteRequestAttemptId, `${path}.remoteRequestAttemptId`),
    ordinal: requirePositiveInteger(record.ordinal, `${path}.ordinal`),
    logicalPage: record.logicalPage === undefined
      ? undefined
      : requirePositiveInteger(record.logicalPage, `${path}.logicalPage`),
    purpose: requireEnum(record.purpose, ['forward', 'replay', 'discovery', 'single-target'] as const, `${path}.purpose`),
    requestBusinessHash: requireHash(record.requestBusinessHash, `${path}.requestBusinessHash`),
    startedAt,
    completedAt,
    status,
    rawEvidenceRefs: requireArtifactRefs(record.rawEvidenceRefs, `${path}.rawEvidenceRefs`),
    error,
  });
}

function normalizeRequestSnapshot(value: unknown, index: number): SanitizedRemoteRequestSnapshotV1 {
  const path = `requestSnapshots[${index}]`;
  const record = strictRecord(value, path, [
    'api', 'method', 'componentKey', 'pageActionId',
    'pageActionExecutionAttemptId', 'remoteRequestAttemptId', 'purpose',
    'subjectHash', 'pageSessionHash', 'page', 'pageSize', 'sort',
    'filterParams', 'requestBusinessHash', 'observedAt',
  ]);
  const filterParams = record.filterParams === undefined
    ? undefined
    : requireScalarRecord(record.filterParams, `${path}.filterParams`);
  return omitUndefined({
    api: requireText(record.api, `${path}.api`),
    method: optionalText(record.method, `${path}.method`),
    componentKey: optionalText(record.componentKey, `${path}.componentKey`),
    pageActionId: requireId(record.pageActionId, `${path}.pageActionId`),
    pageActionExecutionAttemptId: requireId(record.pageActionExecutionAttemptId, `${path}.pageActionExecutionAttemptId`),
    remoteRequestAttemptId: requireId(record.remoteRequestAttemptId, `${path}.remoteRequestAttemptId`),
    purpose: requireEnum(record.purpose, ['forward', 'replay', 'discovery', 'single-target'] as const, `${path}.purpose`),
    subjectHash: requireHash(record.subjectHash, `${path}.subjectHash`),
    pageSessionHash: record.pageSessionHash === undefined
      ? undefined
      : requireHash(record.pageSessionHash, `${path}.pageSessionHash`),
    page: record.page === undefined ? undefined : requirePositiveInteger(record.page, `${path}.page`),
    pageSize: record.pageSize === undefined ? undefined : requirePositiveInteger(record.pageSize, `${path}.pageSize`),
    sort: record.sort === null ? null : optionalText(record.sort, `${path}.sort`),
    filterParams,
    requestBusinessHash: requireHash(record.requestBusinessHash, `${path}.requestBusinessHash`),
    observedAt: requireTimestamp(record.observedAt, `${path}.observedAt`),
  });
}

function normalizePageLifecycle(value: unknown): PageActionExecutionAttemptReceiptV1['pageLifecycle'] {
  const record = strictRecord(value, 'pageLifecycle', [
    'baselinePages', 'createdPages', 'closedPages', 'remainingOwnedPages',
  ]);
  const createdPages = requireNonNegativeInteger(record.createdPages, 'pageLifecycle.createdPages');
  const closedPages = requireNonNegativeInteger(record.closedPages, 'pageLifecycle.closedPages');
  if (closedPages !== createdPages) invalid('pageLifecycle.closedPages must equal createdPages at terminal receipt.');
  requireLiteral(record.remainingOwnedPages, 0, 'pageLifecycle.remainingOwnedPages');
  return {
    baselinePages: requireNonNegativeInteger(record.baselinePages, 'pageLifecycle.baselinePages'),
    createdPages,
    closedPages,
    remainingOwnedPages: 0,
  };
}

function normalizeAttemptRef(value: unknown, path: string): PageActionExecutionAttemptReceiptRefV1 {
  const record = strictRecord(value, path, [
    'pageActionExecutionAttemptId', 'executionAttemptOrdinal', 'receiptId',
    'receiptHash', 'executionLineageHash',
  ]);
  return {
    pageActionExecutionAttemptId: requireId(record.pageActionExecutionAttemptId, `${path}.pageActionExecutionAttemptId`),
    executionAttemptOrdinal: requirePositiveInteger(record.executionAttemptOrdinal, `${path}.executionAttemptOrdinal`),
    receiptId: requireId(record.receiptId, `${path}.receiptId`),
    receiptHash: requireHash(record.receiptHash, `${path}.receiptHash`),
    executionLineageHash: requireHash(record.executionLineageHash, `${path}.executionLineageHash`),
  };
}

function normalizePredecessor(
  value: unknown,
  ordinal: number,
  path: string,
): { receiptId: string; receiptHash: string } | undefined {
  if (ordinal === 1) {
    if (value !== undefined) invalid(`${path} must be absent for execution attempt ordinal 1.`);
    return undefined;
  }
  if (value === undefined) invalid(`${path} is required after execution attempt ordinal 1.`);
  const record = strictRecord(value, path, ['receiptId', 'receiptHash']);
  return {
    receiptId: requireId(record.receiptId, `${path}.receiptId`),
    receiptHash: requireHash(record.receiptHash, `${path}.receiptHash`),
  };
}

function canonicalize(value: unknown, path: string): CollectorJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (!isRecord(value)) invalid(`${path} is not canonical JSON.`);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) invalid(`${path}.${key} is undefined.`);
      return [key, canonicalize(value[key], `${path}.${key}`)];
    }),
  );
}

function requireJsonObject(value: unknown, path: string): CollectorJsonObject {
  const canonical = canonicalize(value, path);
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    invalid(`${path} must be a JSON object.`);
  }
  return canonical as CollectorJsonObject;
}

function strictRecord(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  const record = requireRecord(value, path);
  assertKeys(record, path, allowed);
  return record;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${path} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`${path} contains unknown field(s): ${unknown.join(', ')}.`);
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    invalid(`${path} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) invalid(`${path} must be ${JSON.stringify(expected)}.`);
  return expected;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    invalid(`${path} must be a non-empty trimmed string.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalid(`${path} contains control characters.`);
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireText(value, path);
}

function requireId(value: unknown, path: string): string {
  const id = requireText(value, path);
  if (id.length > 256 || /:\/\//u.test(id)) invalid(`${path} must be a bounded opaque identifier, not a URL.`);
  return id;
}

function requireProfileName(value: unknown, path: string): string {
  const name = requireText(value, path);
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) invalid(`${path} is not a safe profile name.`);
  return name;
}

function requireMemberId(value: unknown, path: string): string {
  const memberId = requireText(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(memberId)) invalid(`${path} is not a safe memberId.`);
  return memberId;
}

function requireOfferId(value: unknown, path: string): string {
  const offerId = requireText(value, path);
  if (!/^[1-9][0-9]*$/u.test(offerId)) invalid(`${path} must be a normalized numeric offerId.`);
  return offerId;
}

function requireCode(value: unknown, path: string): string {
  const code = requireText(value, path);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code)) invalid(`${path} must be an uppercase underscore code.`);
  return code;
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    invalid(`${path} must be a lowercase sha256: hash.`);
  }
  return value;
}

function requireComputedHash(value: unknown, content: unknown, path: string): string {
  const hash = requireHash(value, path);
  equal(hash, canonicalCollectorSha256V1(content), `${path}/canonical content hash`);
  return hash;
}

function requireTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(`${path} must be an ISO timestamp.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    invalid(`${path} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${path} must be a positive safe integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean.`);
  return value;
}

function requireSignature(value: unknown, path: string): string {
  const signature = requireText(value, path);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
    invalid(`${path} must be a canonical unpadded HMAC-SHA256 base64url value.`);
  }
  return signature;
}

function requireArtifactRef(value: unknown, path: string): string {
  const ref = requireText(value, path);
  if (/^(?:https?|javascript|data):/iu.test(ref) || ref.includes('://')) {
    invalid(`${path} must be an opaque artifact reference, not a URL.`);
  }
  if (ref.length > 1024) invalid(`${path} is too large.`);
  return ref;
}

function requireArtifactRefs(value: unknown, path: string): string[] {
  return requireArray(value, path).map((entry, index) =>
    requireArtifactRef(entry, `${path}[${index}]`)
  );
}

function requireUniqueIds(value: unknown, path: string, nonEmpty: boolean): string[] {
  const ids = requireArray(value, path).map((entry, index) => requireId(entry, `${path}[${index}]`));
  if (nonEmpty && ids.length === 0) invalid(`${path} must not be empty.`);
  requireUniqueValues(ids, path);
  return ids;
}

function requireUniqueValues(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`${path} must contain unique values.`);
}

function requireNumberRecord(value: unknown, path: string): Record<string, number> {
  const record = requireRecord(value, path);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) invalid(`${path}.${key} must be finite.`);
    result[key] = entry;
  }
  return result;
}

function requireScalarRecord(
  value: unknown,
  path: string,
): Record<string, string | boolean | number> {
  const record = requireRecord(value, path);
  const result: Record<string, string | boolean | number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (
      SENSITIVE_PARAMETER_NAME_FRAGMENTS.some((fragment) =>
        normalizedKey.includes(fragment)
      )
    ) {
      invalid(`${path}.${key} is sensitive signing or credential material.`);
    }
    if (!SANITIZED_FILTER_PARAMETER_KEYS.has(key)) {
      invalid(`${path}.${key} is not an approved sanitized filter parameter.`);
    }
    if (
      typeof entry !== 'string' && typeof entry !== 'boolean' &&
      (typeof entry !== 'number' || !Number.isFinite(entry))
    ) {
      invalid(`${path}.${key} must be a string, boolean, or finite number.`);
    }
    result[key] = entry as string | boolean | number;
  }
  return result;
}

function earliestTimestamp(values: readonly string[]): string {
  return [...values].sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
}

function assertContiguousOrdinals(values: readonly number[], path: string): void {
  values.forEach((value, index) => {
    if (value !== index + 1) invalid(`${path} ordinals must be contiguous and start at 1.`);
  });
}

function compareAttemptRefs(
  left: PageActionExecutionAttemptReceiptRefV1,
  right: PageActionExecutionAttemptReceiptRefV1,
): number {
  return left.executionAttemptOrdinal - right.executionAttemptOrdinal ||
    left.receiptHash.localeCompare(right.receiptHash);
}

function executionAttemptReceiptRef(
  attempt: PageActionExecutionAttemptReceiptV1,
): PageActionExecutionAttemptReceiptRefV1 {
  return {
    pageActionExecutionAttemptId: attempt.pageActionExecutionAttemptId,
    executionAttemptOrdinal: attempt.executionAttemptOrdinal,
    receiptId: attempt.receiptId,
    receiptHash: attempt.receiptHash,
    executionLineageHash: attempt.executionLineageHash,
  };
}

function assertCompletionPreservesAttemptBatches(
  attempts: readonly PageActionExecutionAttemptReceiptV1[],
  completion: PageActionCompletionReceiptV1,
): void {
  const expected = new Map<string, string>();
  for (const batch of attempts.flatMap((attempt) => attempt.batches)) {
    const content = canonicalCollectorJsonV1(batch);
    const previous = expected.get(batch.batchId);
    if (previous !== undefined && previous !== content) {
      invalid(`Attempt receipts disagree on immutable CollectionBatch ${batch.batchId}.`);
    }
    expected.set(batch.batchId, content);
  }
  if (completion.batches.length !== expected.size) {
    invalid('Completion receipt must preserve every immutable CollectionBatch from its attempts.');
  }
  for (const batch of completion.batches) {
    if (expected.get(batch.batchId) !== canonicalCollectorJsonV1(batch)) {
      invalid('Completion receipt must preserve every immutable CollectionBatch from its attempts.');
    }
  }
}

function assertCompletionPreservesReturnedAttemptBatches(
  attempt: PageActionExecutionAttemptReceiptV1,
  completion: PageActionCompletionReceiptV1,
): void {
  const completionById = new Map(
    completion.batches.map((batch) => [
      batch.batchId,
      canonicalCollectorJsonV1(batch),
    ]),
  );
  for (const batch of attempt.batches) {
    if (
      completionById.get(batch.batchId) !== canonicalCollectorJsonV1(batch)
    ) {
      invalid(
        'Completion receipt must preserve every immutable CollectionBatch from the returned attempt.',
      );
    }
  }
}

function equal(left: unknown, right: unknown, path: string): void {
  if (left !== right) invalid(`${path} values must be identical.`);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function invalid(message: string): never {
  throw new TypeError(message);
}
