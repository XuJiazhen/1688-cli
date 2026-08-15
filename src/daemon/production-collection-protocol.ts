import { createHash } from 'node:crypto';
import { SEARCH_FILTER_REQUEST_KEYS } from '../session/search-contract.js';

export const PRODUCTION_COLLECTION_RPC_SCHEMA =
  'production-collection.rpc.v1' as const;
export const PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA =
  'production-collection.rpc-response.v3' as const;
export const PRODUCTION_COLLECTION_RUNTIME_ADMISSION_SCHEMA =
  'production-collection.runtime-admission.v1' as const;
export const PRODUCTION_COLLECTION_RUNTIME_ADMISSION_RESPONSE_SCHEMA =
  'production-collection.runtime-admission-response.v1' as const;

export type ProductionCollectionRpcMethod =
  | 'production.collection.execute'
  | 'production.collection.lookupReceipt';

export type ProductionCollectionWorkKind =
  | 'search_page'
  | 'offer_detail'
  | 'store_qualification'
  | 'store_pages';

export interface ProductionCollectionQueryV1 {
  keyword: string;
  sort: 'relevance' | 'sales' | 'price-asc' | 'price-desc';
  filters: Record<string, string>;
  advertisementPolicy: 'archive-and-mark' | 'exclude-p4p';
  contractVersion: 'production-search-v1';
}

export interface ProductionCollectionRpcRequestV1 {
  schema: typeof PRODUCTION_COLLECTION_RPC_SCHEMA;
  rpcId: string;
  method: ProductionCollectionRpcMethod;
  deadlineAt: string;
  attemptId: string;
  executionToken: string;
  workItemId: string;
  profileId: string;
  supervisorLeaseId: string;
  supervisorGeneration: number;
  supervisorFencingToken: string;
  daemonInstanceId: string;
  contextGeneration: number;
  runtimeHostId: string;
  attemptOrdinal: number;
  freshnessSeconds: number;
  startNotBefore: string;
  subjectKey: string;
  workKind: ProductionCollectionWorkKind;
  workInput: Record<string, unknown>;
  query: ProductionCollectionQueryV1 | null;
}

export interface ProductionCollectionCleanupReceiptV1 {
  ownedPageCount: number;
  closedPageCount: number;
  transferredPageCount?: number;
  allOwnedPagesClosed: boolean;
  detail: Record<string, unknown>;
}

export interface ProductionCollectionRetainedPageReceiptV1 {
  schemaVersion: 'production-collection-retained-page.v1';
  pageSessionId: string;
  pendingInterventionSessionId: string;
  workItemId: string;
  workKind: ProductionCollectionWorkKind;
  url: string;
  transferredAt: string;
}

export interface ProductionCollectionResourceReceiptV1 {
  schemaVersion: 'production-collection-resource.v1';
  measurementScope: 'daemon-process-delta-and-owned-page-network';
  wallTimeMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssStartBytes: number;
  rssEndBytes: number;
  rssPeakObservedBytes: number;
  rssSamplingIntervalMs: number;
  rssSampleCount: number;
  fsReadOps: number;
  fsWriteOps: number;
  networkRequestCount: number;
  networkResponseCount: number;
  networkDeclaredResponseBytes: number;
  networkResponseBytesUnknownCount: number;
  artifactBytes: number;
}

export interface ProductionCollectionSourceTimingReceiptV1 {
  schemaVersion: 'production-collection-source-timing.v1';
  clock: 'playwright-request-and-daemon-monotonic-wall.v1';
  coverage: 'full' | 'partial';
  remoteActionStartedAt: string;
  firstSourceByteAt: string | null;
  sourcePayloadCompleteAt: string;
  rawArchiveCommittedAt: string;
}

export interface ProductionCollectionSourceTimingReceiptV2 {
  schemaVersion: 'production-collection-source-timing.v2';
  clock: 'playwright-request-and-daemon-monotonic-wall.v1';
  coverage: 'missing' | 'partial' | 'full';
  canonicalRequest: 'unobserved' | 'observed';
  remoteActionStartedAt: string | null;
  firstSourceByteAt: string | null;
  sourcePayloadCompleteAt: string;
  rawArchiveCommittedAt: string;
}

export type ProductionCollectionSourceTimingReceipt =
  | ProductionCollectionSourceTimingReceiptV1
  | ProductionCollectionSourceTimingReceiptV2;

export interface ProductionCollectionExecutionReceiptV3 {
  requestHash: string;
  attemptId: string;
  executionToken: string;
  workItemId: string;
  workKind: ProductionCollectionWorkKind;
  profileId: string;
  supervisorLeaseId: string;
  supervisorGeneration: number;
  supervisorFencingToken: string;
  daemonInstanceId: string;
  contextGeneration: number;
  runtimeHostId: string;
  runtimeAdmissionReceiptId: string;
  startedAt: string;
  completedAt: string;
  rawArtifactRef: string;
  rawArtifactHash: string;
  payloadSchemaVersion: 'collection-batch-v1';
  batch: Record<string, unknown>;
  cleanup: ProductionCollectionCleanupReceiptV1;
  retainedPage?: ProductionCollectionRetainedPageReceiptV1;
  resource: ProductionCollectionResourceReceiptV1;
  timing: ProductionCollectionSourceTimingReceipt;
}

export type ProductionCollectionRpcResponseV3 =
  | {
      schema: typeof PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA;
      rpcId: string;
      requestHash: string;
      ok: true;
      data: ProductionCollectionExecutionReceiptV3 | null;
    }
  | {
      schema: typeof PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA;
      rpcId: string;
      requestHash: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        category: string;
        details?: Record<string, unknown>;
      };
    };

export class ProductionCollectionProtocolError extends Error {
  public override readonly name = 'ProductionCollectionProtocolError';

  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly category = 'protocol',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function parseProductionCollectionRpcRequestV1(
  value: unknown,
): ProductionCollectionRpcRequestV1 {
  const record = strictRecord(value, 'ProductionCollectionRpcRequest', [
    'schema', 'rpcId', 'method', 'deadlineAt', 'attemptId', 'executionToken',
    'workItemId', 'profileId', 'supervisorLeaseId', 'supervisorGeneration',
    'supervisorFencingToken', 'daemonInstanceId', 'contextGeneration',
    'runtimeHostId',
    'attemptOrdinal', 'freshnessSeconds',
    'startNotBefore', 'subjectKey',
    'workKind', 'workInput', 'query',
  ]);
  if (record['schema'] !== PRODUCTION_COLLECTION_RPC_SCHEMA) {
    invalid('Unsupported production collection RPC schema.');
  }
  const method = oneOf(record['method'], [
    'production.collection.execute',
    'production.collection.lookupReceipt',
  ] as const, 'method');
  const workKind = oneOf(record['workKind'], [
    'search_page', 'offer_detail', 'store_qualification', 'store_pages',
  ] as const, 'workKind');
  const workInput = strictRecord(
    record['workInput'],
    'workInput',
    workInputKeys(workKind),
  );
  if (workInput['kind'] !== workKind) invalid('workInput.kind must match workKind.');
  validateWorkInput(workKind, workInput);
  const query = record['query'] === null
    ? null
    : parseQuery(record['query']);
  if (workKind === 'search_page' && query === null) {
    invalid('search_page requires its frozen query snapshot.');
  }
  if (workKind !== 'search_page' && query !== null) {
    invalid('Only search_page may carry a query snapshot.');
  }
  const deadlineAt = timestamp(record['deadlineAt'], 'deadlineAt');
  const startNotBefore = timestamp(record['startNotBefore'], 'startNotBefore');
  if (Date.parse(deadlineAt) <= Date.parse(startNotBefore)) {
    invalid('deadlineAt must be later than startNotBefore.');
  }
  return {
    schema: PRODUCTION_COLLECTION_RPC_SCHEMA,
    rpcId: identifier(record['rpcId'], 'rpcId'),
    method,
    deadlineAt,
    attemptId: uuid(record['attemptId'], 'attemptId'),
    executionToken: uuid(record['executionToken'], 'executionToken'),
    workItemId: uuid(record['workItemId'], 'workItemId'),
    profileId: uuid(record['profileId'], 'profileId'),
    supervisorLeaseId: uuid(record['supervisorLeaseId'], 'supervisorLeaseId'),
    supervisorGeneration: positiveInteger(record['supervisorGeneration'], 'supervisorGeneration'),
    supervisorFencingToken: positiveBigInteger(record['supervisorFencingToken'], 'supervisorFencingToken'),
    daemonInstanceId: uuid(record['daemonInstanceId'], 'daemonInstanceId'),
    contextGeneration: positiveInteger(record['contextGeneration'], 'contextGeneration'),
    runtimeHostId: boundedText(record['runtimeHostId'], 'runtimeHostId', 256),
    attemptOrdinal: positiveInteger(record['attemptOrdinal'], 'attemptOrdinal'),
    freshnessSeconds: positiveInteger(record['freshnessSeconds'], 'freshnessSeconds'),
    startNotBefore,
    subjectKey: boundedText(record['subjectKey'], 'subjectKey', 1_024),
    workKind,
    workInput,
    query,
  };
}

export function productionCollectionRequestHashV1(
  request: ProductionCollectionRpcRequestV1,
): string {
  return createHash('sha256')
    .update(canonicalJson(request), 'utf8')
    .digest('hex');
}

export function productionCollectionRpcFailureV1(
  input: {
    rpcId: string;
    requestHash: string;
    error: unknown;
  },
): ProductionCollectionRpcResponseV3 {
  const error = input.error instanceof ProductionCollectionProtocolError
    ? input.error
    : new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_EXECUTION_FAILED',
        input.error instanceof Error ? input.error.message : 'Production collection failed.',
        true,
        'runtime',
      );
  return {
    schema: PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
    rpcId: input.rpcId,
    requestHash: input.requestHash,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      category: error.category,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function parseQuery(value: unknown): ProductionCollectionQueryV1 {
  const record = strictRecord(value, 'query', [
    'keyword', 'sort', 'filters', 'advertisementPolicy', 'contractVersion',
  ]);
  if (record['contractVersion'] !== 'production-search-v1') {
    invalid('query.contractVersion must be production-search-v1.');
  }
  return {
    keyword: boundedText(record['keyword'], 'query.keyword', 512),
    sort: oneOf(record['sort'], [
      'relevance', 'sales', 'price-asc', 'price-desc',
    ] as const, 'query.sort'),
    filters: parseSearchFilters(record['filters']),
    advertisementPolicy: oneOf(record['advertisementPolicy'], [
      'archive-and-mark', 'exclude-p4p',
    ] as const, 'query.advertisementPolicy'),
    contractVersion: 'production-search-v1',
  };
}

function parseSearchFilters(value: unknown): Record<string, string> {
  const record = strictRecord(value, 'query.filters');
  const allowed = new Set<string>(SEARCH_FILTER_REQUEST_KEYS);
  const filters: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!allowed.has(key)) invalid(`query.filters.${key} is not an approved remote filter.`);
    if (typeof item !== 'string' || item.length > 2_048) {
      invalid(`query.filters.${key} must be a string of at most 2048 characters.`);
    }
    filters[key] = item;
  }
  return filters;
}

function workInputKeys(kind: ProductionCollectionWorkKind): readonly string[] {
  switch (kind) {
    case 'search_page':
      return [
        'kind', 'querySnapshotHash', 'page', 'maxSearchPages', 'maxCandidates',
        'candidatesPerPage',
      ];
    case 'offer_detail':
      return ['kind', 'offerId', 'offerUrl', 'normalizedStoreUrl', 'memberId'];
    case 'store_qualification':
      return ['kind', 'normalizedStoreUrl', 'memberId'];
    case 'store_pages':
      return ['kind', 'normalizedStoreUrl', 'memberId', 'firstPage', 'lastPageInclusive'];
  }
}

function validateWorkInput(
  kind: ProductionCollectionWorkKind,
  input: Record<string, unknown>,
): void {
  if (kind === 'search_page') {
    sha256(input['querySnapshotHash'], 'workInput.querySnapshotHash');
    const page = positiveInteger(input['page'], 'workInput.page');
    const maxSearchPages = nonNegativeInteger(
      input['maxSearchPages'],
      'workInput.maxSearchPages',
    );
    const maxCandidates = positiveInteger(
      input['maxCandidates'],
      'workInput.maxCandidates',
    );
    const candidatesPerPage = positiveInteger(
      input['candidatesPerPage'],
      'workInput.candidatesPerPage',
    );
    if (maxCandidates > 500) {
      invalid('workInput.maxCandidates cannot exceed 500.');
    }
    if (candidatesPerPage > maxCandidates) {
      invalid('workInput.candidatesPerPage cannot exceed workInput.maxCandidates.');
    }
    if (maxSearchPages > 0 && page > maxSearchPages) {
      invalid('workInput.page cannot exceed a positive workInput.maxSearchPages.');
    }
    return;
  }
  boundedText(input['memberId'], 'workInput.memberId', 256);
  httpUrl(input['normalizedStoreUrl'], 'workInput.normalizedStoreUrl');
  if (kind === 'offer_detail') {
    numericId(input['offerId'], 'workInput.offerId');
    httpUrl(input['offerUrl'], 'workInput.offerUrl');
  }
  if (kind === 'store_pages') {
    if (input['firstPage'] !== 1 || input['lastPageInclusive'] !== 3) {
      invalid('store_pages must cover exactly pages 1-3.');
    }
  }
}

function strictRecord(
  value: unknown,
  path: string,
  keys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (keys !== undefined) {
    const expected = new Set(keys);
    for (const key of Object.keys(record)) {
      if (!expected.has(key)) invalid(`${path}.${key} is not allowed.`);
    }
    for (const key of keys) {
      if (!Object.hasOwn(record, key)) invalid(`${path}.${key} is required.`);
    }
  }
  return record;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    invalid(`${path} is invalid.`);
  }
  return value as T;
}

function identifier(value: unknown, path: string): string {
  const text = boundedText(value, path, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) invalid(`${path} is invalid.`);
  return text;
}

function uuid(value: unknown, path: string): string {
  const text = boundedText(value, path, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    invalid(`${path} must be a UUID.`);
  }
  return text;
}

function sha256(value: unknown, path: string): string {
  const text = boundedText(value, path, 71).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/i.test(text)) invalid(`${path} must be a SHA-256 digest.`);
  return text;
}

function numericId(value: unknown, path: string): string {
  const text = boundedText(value, path, 64);
  if (!/^\d+$/.test(text)) invalid(`${path} must be numeric.`);
  return text;
}

function httpUrl(value: unknown, path: string): string {
  const text = boundedText(value, path, 2_048);
  let parsed: URL;
  try { parsed = new URL(text); } catch { invalid(`${path} must be a URL.`); }
  if (parsed!.protocol !== 'https:' && parsed!.protocol !== 'http:') {
    invalid(`${path} must be an HTTP URL.`);
  }
  return text;
}

function timestamp(value: unknown, path: string): string {
  const text = boundedText(value, path, 64);
  if (!Number.isFinite(Date.parse(text))) invalid(`${path} must be a timestamp.`);
  return new Date(text).toISOString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`${path} must be positive.`);
  return Number(value);
}

function positiveBigInteger(value: unknown, path: string): string {
  const text = typeof value === 'string' ? value : String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) invalid(`${path} must be a positive integer.`);
  return text;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${path} must be non-negative.`);
  return Number(value);
}

function boundedText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    invalid(`${path} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function invalid(message: string): never {
  throw new ProductionCollectionProtocolError('PRODUCTION_COLLECTION_CONTRACT_INVALID', message);
}
