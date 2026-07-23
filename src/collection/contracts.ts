import { createHash } from 'node:crypto';
import { CliError } from '../io/errors.js';

export const COLLECTION_SCHEMA_VERSION = 1 as const;

export const COLLECTION_KINDS = [
  'search-page',
  'store-catalog',
  'store-categories',
  'store-qualification',
  'offer-detail',
  'offer-media-manifest',
] as const;

export type CollectionKind = (typeof COLLECTION_KINDS)[number];
export type RequestedScope = 'page' | 'bounded-pages' | 'full-scan';

export interface SupplierRef {
  memberId?: string;
  shopUrl?: string;
  sourceOfferId?: string;
}

export interface CollectionSubject {
  keyword?: string;
  offerId?: string;
  supplier?: SupplierRef;
}

export interface CollectionScope {
  requestedScope?: RequestedScope;
  categoryId?: string;
  storeKeyword?: string;
  sort?: string;
  cursor?: string;
  pageSize?: number;
  maxPagesPerBatch?: number;
  requestedFacts?: string[];
}

export interface CollectionLimits {
  maxItems?: number;
  deadlineMs?: number;
}

export interface CollectionUnit {
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  unitId: string;
  taskId?: string;
  kind: CollectionKind;
  subject: CollectionSubject;
  scope?: CollectionScope;
  limits?: CollectionLimits;
}

export interface CollectionCheckpoint {
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  unitFingerprint: string;
  kind: CollectionKind;
  subject: Record<string, unknown>;
  scope: Record<string, unknown>;
  nextCursor?: string;
  nextPage?: number;
  completedPages: number[];
  seenKeys: string[];
  pendingKeys: string[];
  attemptCounts: Record<string, number>;
  updatedAt: string;
}

export type CollectionBatchStatus = 'completed' | 'partial' | 'blocked' | 'failed';
export type CompletenessState = 'complete' | 'truncated' | 'unknown';

export interface CollectionCompleteness {
  requestedScope: RequestedScope;
  state: CompletenessState;
  observedPages: number[];
  failedPages: number[];
  expectedItems?: number;
  uniqueItems: number;
}

export interface DuplicateObservation {
  key: string;
  firstSource: string;
  duplicateSource: string;
}

export interface CollectionWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CollectionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface CollectionActionRequired {
  type: 'login' | 'risk-control';
  message: string;
}

export interface CollectionBatch {
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  batchId: string;
  unitId: string;
  kind: CollectionKind;
  status: CollectionBatchStatus;
  startedAt: string;
  completedAt: string;
  subject: Record<string, unknown>;
  scope: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  completeness: CollectionCompleteness;
  duplicateObservations: DuplicateObservation[];
  warnings: CollectionWarning[];
  errors: CollectionError[];
  checkpoint?: CollectionCheckpoint;
  actionRequired?: CollectionActionRequired;
  rawEvidenceRefs: string[];
  metrics: Record<string, number>;
}

export const EVIDENCE_SOURCE_TYPES = [
  'search-payload',
  'offer-payload',
  'supplier-payload',
  'store-catalog',
  'page-dom',
] as const;

export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export interface EvidenceSource {
  sourceType: EvidenceSourceType;
  api?: string;
  componentKey?: string;
  fieldPath?: string;
  sourceRef: string;
  collectedAt: string;
  collectorVersion: string;
  parserVersion: string;
  rawRef?: string;
}

export interface EvidenceError {
  code: string;
  message: string;
}

export type Evidence<T> =
  | { availability: 'available'; value: T; source: EvidenceSource }
  | {
      availability: 'not-present' | 'not-collected' | 'failed';
      value: null;
      source: EvidenceSource;
      error?: EvidenceError;
    };

export function normalizeCollectionUnit(value: unknown): CollectionUnit {
  const record = requireRecord(value, 'CollectionUnit');
  requireSchemaVersion(record.schemaVersion, 'CollectionUnit');

  const kind = requireEnum(record.kind, COLLECTION_KINDS, 'CollectionUnit.kind');
  const subject = normalizeSubject(record.subject, kind);
  const scope = record.scope === undefined ? undefined : normalizeScope(record.scope);
  const limits = record.limits === undefined ? undefined : normalizeLimits(record.limits);

  return omitUndefined({
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    unitId: requireString(record.unitId, 'CollectionUnit.unitId'),
    taskId: optionalString(record.taskId, 'CollectionUnit.taskId'),
    kind,
    subject,
    scope,
    limits,
  });
}

export function fingerprintCollectionUnit(value: unknown): string {
  const unit = normalizeCollectionUnit(value);
  // Retry identity and per-batch limits may change without invalidating observations.
  const semanticScope = unit.scope === undefined
    ? undefined
    : omitUndefined({
        requestedScope: unit.scope.requestedScope,
        categoryId: unit.scope.categoryId,
        storeKeyword: unit.scope.storeKeyword,
        sort: unit.scope.sort,
        cursor: unit.scope.cursor,
        pageSize: unit.scope.pageSize,
        requestedFacts: unit.scope.requestedFacts,
      });
  const canonical = JSON.stringify(
    omitUndefined({
      schemaVersion: unit.schemaVersion,
      kind: unit.kind,
      subject: unit.subject,
      scope:
        semanticScope === undefined || Object.keys(semanticScope).length === 0
          ? undefined
          : semanticScope,
    }),
  );
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function normalizeEvidence<T = unknown>(value: unknown): Evidence<T> {
  const record = requireRecord(value, 'Evidence');
  const availability = requireEnum(
    record.availability,
    ['available', 'not-present', 'not-collected', 'failed'] as const,
    'Evidence.availability',
  );
  const source = normalizeEvidenceSource(record.source);

  if (availability === 'available') {
    if (!Object.hasOwn(record, 'value') || record.value === undefined) {
      invalid('Evidence.value is required when availability is available.');
    }
    return {
      availability,
      value: normalizeJsonValue(record.value, 'Evidence.value') as T,
      source,
    };
  }

  if (record.value !== null) {
    invalid(`Evidence.value must be null when availability is ${availability}.`);
  }
  return omitUndefined({
    availability,
    value: null,
    source,
    error: record.error === undefined ? undefined : normalizeEvidenceError(record.error),
  });
}

export function normalizeCollectionCheckpoint(value: unknown): CollectionCheckpoint {
  const record = requireRecord(value, 'CollectionCheckpoint');
  requireSchemaVersion(record.schemaVersion, 'CollectionCheckpoint');
  const unitFingerprint = requireString(
    record.unitFingerprint,
    'CollectionCheckpoint.unitFingerprint',
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(unitFingerprint)) {
    invalid('CollectionCheckpoint.unitFingerprint must be a sha256 fingerprint.');
  }

  return omitUndefined({
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    unitFingerprint,
    kind: requireEnum(record.kind, COLLECTION_KINDS, 'CollectionCheckpoint.kind'),
    subject: requireJsonRecord(record.subject, 'CollectionCheckpoint.subject'),
    scope: requireJsonRecord(record.scope, 'CollectionCheckpoint.scope'),
    nextCursor: optionalString(record.nextCursor, 'CollectionCheckpoint.nextCursor'),
    nextPage: optionalPositiveInteger(record.nextPage, 'CollectionCheckpoint.nextPage'),
    completedPages: requireUniquePositiveIntegers(
      record.completedPages,
      'CollectionCheckpoint.completedPages',
    ),
    seenKeys: requireUniqueStrings(record.seenKeys, 'CollectionCheckpoint.seenKeys'),
    pendingKeys: requireUniqueStrings(record.pendingKeys, 'CollectionCheckpoint.pendingKeys'),
    attemptCounts: requireAttemptCounts(
      record.attemptCounts,
      'CollectionCheckpoint.attemptCounts',
    ),
    updatedAt: requireTimestamp(record.updatedAt, 'CollectionCheckpoint.updatedAt'),
  });
}

export function assertCheckpointCompatible(
  unitValue: unknown,
  checkpointValue: unknown,
): CollectionCheckpoint {
  const unit = normalizeCollectionUnit(unitValue);
  const checkpoint = normalizeCollectionCheckpoint(checkpointValue);
  const expectedFingerprint = fingerprintCollectionUnit(unit);

  if (checkpoint.kind !== unit.kind || checkpoint.unitFingerprint !== expectedFingerprint) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'CollectionCheckpoint is not compatible with the requested CollectionUnit.',
      {
        category: 'collection-contract',
        expectedKind: unit.kind,
        receivedKind: checkpoint.kind,
        expectedFingerprint,
        receivedFingerprint: checkpoint.unitFingerprint,
      },
    );
  }
  return checkpoint;
}

export function normalizeCollectionBatch(value: unknown): CollectionBatch {
  const record = requireRecord(value, 'CollectionBatch');
  requireSchemaVersion(record.schemaVersion, 'CollectionBatch');
  const kind = requireEnum(record.kind, COLLECTION_KINDS, 'CollectionBatch.kind');
  const startedAt = requireTimestamp(record.startedAt, 'CollectionBatch.startedAt');
  const completedAt = requireTimestamp(record.completedAt, 'CollectionBatch.completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    invalid('CollectionBatch.completedAt must not be before startedAt.');
  }
  const checkpoint =
    record.checkpoint === undefined
      ? undefined
      : normalizeCollectionCheckpoint(record.checkpoint);
  if (checkpoint !== undefined && checkpoint.kind !== kind) {
    invalid('CollectionBatch.checkpoint.kind must match CollectionBatch.kind.');
  }

  return omitUndefined({
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    batchId: requireString(record.batchId, 'CollectionBatch.batchId'),
    unitId: requireString(record.unitId, 'CollectionBatch.unitId'),
    kind,
    status: requireEnum(
      record.status,
      ['completed', 'partial', 'blocked', 'failed'] as const,
      'CollectionBatch.status',
    ),
    startedAt,
    completedAt,
    subject: requireJsonRecord(record.subject, 'CollectionBatch.subject'),
    scope: requireJsonRecord(record.scope, 'CollectionBatch.scope'),
    observations: requireJsonRecords(record.observations, 'CollectionBatch.observations'),
    completeness: normalizeCompleteness(record.completeness),
    duplicateObservations: normalizeDuplicateObservations(record.duplicateObservations),
    warnings: normalizeWarnings(record.warnings),
    errors: normalizeErrors(record.errors),
    checkpoint,
    actionRequired:
      record.actionRequired === undefined
        ? undefined
        : normalizeActionRequired(record.actionRequired),
    rawEvidenceRefs: requireUniqueSafeRefs(
      record.rawEvidenceRefs,
      'CollectionBatch.rawEvidenceRefs',
    ),
    metrics: requireMetrics(record.metrics, 'CollectionBatch.metrics'),
  });
}

function normalizeCompleteness(value: unknown): CollectionCompleteness {
  const record = requireRecord(value, 'CollectionBatch.completeness');
  return omitUndefined({
    requestedScope: requireEnum(
      record.requestedScope,
      ['page', 'bounded-pages', 'full-scan'] as const,
      'CollectionBatch.completeness.requestedScope',
    ),
    state: requireEnum(
      record.state,
      ['complete', 'truncated', 'unknown'] as const,
      'CollectionBatch.completeness.state',
    ),
    observedPages: requireUniquePositiveIntegers(
      record.observedPages,
      'CollectionBatch.completeness.observedPages',
    ),
    failedPages: requireUniquePositiveIntegers(
      record.failedPages,
      'CollectionBatch.completeness.failedPages',
    ),
    expectedItems: optionalNonNegativeInteger(
      record.expectedItems,
      'CollectionBatch.completeness.expectedItems',
    ),
    uniqueItems: requireNonNegativeInteger(
      record.uniqueItems,
      'CollectionBatch.completeness.uniqueItems',
    ),
  });
}

function normalizeDuplicateObservations(value: unknown): DuplicateObservation[] {
  if (!Array.isArray(value)) {
    invalid('CollectionBatch.duplicateObservations must be an array.');
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `CollectionBatch.duplicateObservations[${index}]`);
    return {
      key: requireString(record.key, `CollectionBatch.duplicateObservations[${index}].key`),
      firstSource: requireString(
        record.firstSource,
        `CollectionBatch.duplicateObservations[${index}].firstSource`,
      ),
      duplicateSource: requireString(
        record.duplicateSource,
        `CollectionBatch.duplicateObservations[${index}].duplicateSource`,
      ),
    };
  });
}

function normalizeWarnings(value: unknown): CollectionWarning[] {
  if (!Array.isArray(value)) invalid('CollectionBatch.warnings must be an array.');
  return value.map((entry, index) => {
    const path = `CollectionBatch.warnings[${index}]`;
    const record = requireRecord(entry, path);
    return omitUndefined({
      code: requireString(record.code, `${path}.code`),
      message: requireString(record.message, `${path}.message`),
      details:
        record.details === undefined ? undefined : requireJsonRecord(record.details, `${path}.details`),
    });
  });
}

function normalizeErrors(value: unknown): CollectionError[] {
  if (!Array.isArray(value)) invalid('CollectionBatch.errors must be an array.');
  return value.map((entry, index) => {
    const path = `CollectionBatch.errors[${index}]`;
    const record = requireRecord(entry, path);
    return omitUndefined({
      code: requireString(record.code, `${path}.code`),
      message: requireString(record.message, `${path}.message`),
      retryable: optionalBoolean(record.retryable, `${path}.retryable`),
      details:
        record.details === undefined ? undefined : requireJsonRecord(record.details, `${path}.details`),
    });
  });
}

function normalizeActionRequired(value: unknown): CollectionActionRequired {
  const record = requireRecord(value, 'CollectionBatch.actionRequired');
  return {
    type: requireEnum(
      record.type,
      ['login', 'risk-control'] as const,
      'CollectionBatch.actionRequired.type',
    ),
    message: requireString(record.message, 'CollectionBatch.actionRequired.message'),
  };
}

function normalizeEvidenceSource(value: unknown): EvidenceSource {
  const record = requireRecord(value, 'Evidence.source');
  return omitUndefined({
    sourceType: requireEnum(
      record.sourceType,
      EVIDENCE_SOURCE_TYPES,
      'Evidence.source.sourceType',
    ),
    api: optionalString(record.api, 'Evidence.source.api'),
    componentKey: optionalString(record.componentKey, 'Evidence.source.componentKey'),
    fieldPath: optionalString(record.fieldPath, 'Evidence.source.fieldPath'),
    sourceRef: requireSafeRef(record.sourceRef, 'Evidence.source.sourceRef'),
    collectedAt: requireTimestamp(record.collectedAt, 'Evidence.source.collectedAt'),
    collectorVersion: requireString(
      record.collectorVersion,
      'Evidence.source.collectorVersion',
    ),
    parserVersion: requireString(record.parserVersion, 'Evidence.source.parserVersion'),
    rawRef:
      record.rawRef === undefined
        ? undefined
        : requireSafeRef(record.rawRef, 'Evidence.source.rawRef'),
  });
}

function normalizeEvidenceError(value: unknown): EvidenceError {
  const record = requireRecord(value, 'Evidence.error');
  return {
    code: requireString(record.code, 'Evidence.error.code'),
    message: requireString(record.message, 'Evidence.error.message'),
  };
}

function normalizeSubject(value: unknown, kind: CollectionKind): CollectionSubject {
  const record = requireRecord(value, 'CollectionUnit.subject');
  const subject = omitUndefined({
    keyword: optionalString(record.keyword, 'CollectionUnit.subject.keyword'),
    offerId: optionalOfferId(record.offerId, 'CollectionUnit.subject.offerId'),
    supplier:
      record.supplier === undefined
        ? undefined
        : normalizeSupplierRef(record.supplier),
  });

  if (kind === 'search-page' && subject.keyword === undefined) {
    invalid('CollectionUnit.subject.keyword is required for search-page.');
  }
  if (
    (kind === 'store-catalog' ||
      kind === 'store-categories' ||
      kind === 'store-qualification') &&
    subject.supplier === undefined
  ) {
    invalid(`CollectionUnit.subject.supplier is required for ${kind}.`);
  }
  if (
    (kind === 'offer-detail' || kind === 'offer-media-manifest') &&
    subject.offerId === undefined
  ) {
    invalid(`CollectionUnit.subject.offerId is required for ${kind}.`);
  }
  return subject;
}

function normalizeSupplierRef(value: unknown): SupplierRef {
  const record = requireRecord(value, 'CollectionUnit.subject.supplier');
  const result = omitUndefined({
    memberId: optionalString(record.memberId, 'CollectionUnit.subject.supplier.memberId'),
    shopUrl: optionalUrl(record.shopUrl, 'CollectionUnit.subject.supplier.shopUrl'),
    sourceOfferId: optionalOfferId(
      record.sourceOfferId,
      'CollectionUnit.subject.supplier.sourceOfferId',
    ),
  });
  if (Object.keys(result).length === 0) {
    invalid('CollectionUnit.subject.supplier requires memberId, shopUrl, or sourceOfferId.');
  }
  return result;
}

function normalizeScope(value: unknown): CollectionScope {
  const record = requireRecord(value, 'CollectionUnit.scope');
  return omitUndefined({
    requestedScope: optionalEnum(
      record.requestedScope,
      ['page', 'bounded-pages', 'full-scan'] as const,
      'CollectionUnit.scope.requestedScope',
    ),
    categoryId: optionalString(record.categoryId, 'CollectionUnit.scope.categoryId'),
    storeKeyword: optionalString(record.storeKeyword, 'CollectionUnit.scope.storeKeyword'),
    sort: optionalString(record.sort, 'CollectionUnit.scope.sort'),
    cursor: optionalString(record.cursor, 'CollectionUnit.scope.cursor'),
    pageSize: optionalPositiveInteger(record.pageSize, 'CollectionUnit.scope.pageSize'),
    maxPagesPerBatch: optionalPositiveInteger(
      record.maxPagesPerBatch,
      'CollectionUnit.scope.maxPagesPerBatch',
    ),
    requestedFacts: optionalUniqueStrings(
      record.requestedFacts,
      'CollectionUnit.scope.requestedFacts',
    ),
  });
}

function normalizeLimits(value: unknown): CollectionLimits {
  const record = requireRecord(value, 'CollectionUnit.limits');
  return omitUndefined({
    maxItems: optionalPositiveInteger(record.maxItems, 'CollectionUnit.limits.maxItems'),
    deadlineMs: optionalPositiveInteger(record.deadlineMs, 'CollectionUnit.limits.deadlineMs'),
  });
}

function optionalOfferId(value: unknown, path: string): string | undefined {
  const result = optionalString(value, path);
  if (result !== undefined && !/^\d+$/.test(result)) {
    invalid(`${path} must contain only digits.`);
  }
  return result;
}

function optionalUrl(value: unknown, path: string): string | undefined {
  const result = optionalString(value, path);
  if (result === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    invalid(`${path} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid(`${path} must be an absolute HTTP(S) URL.`);
  }
  url.hash = '';
  url.searchParams.sort();
  return url.toString();
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireSchemaVersion(value: unknown, contract: string): void {
  if (value !== COLLECTION_SCHEMA_VERSION) {
    invalid(`${contract}.schemaVersion must be ${COLLECTION_SCHEMA_VERSION}.`, {
      contract,
      expectedSchemaVersion: COLLECTION_SCHEMA_VERSION,
      receivedSchemaVersion: value,
    });
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

const SENSITIVE_QUERY_KEYS = new Set([
  '_m_h5_tk',
  '_m_h5_tk_enc',
  'access_token',
  'authorization',
  'cookie',
  'password',
  'session',
  'sign',
  'token',
]);

function requireSafeRef(value: unknown, path: string): string {
  const ref = requireString(value, path);
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return ref;
  }
  if (url.username !== '' || url.password !== '') {
    invalid(`${path} must not contain embedded credentials.`);
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      invalid(`${path} must not contain sensitive query parameter ${key}.`);
    }
  }
  return ref;
}

function requireTimestamp(value: unknown, path: string): string {
  const text = requireString(value, path);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) invalid(`${path} must be a valid timestamp.`);
  return new Date(timestamp).toISOString();
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

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  return requireEnum(value, values, path);
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(`${path} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean.`);
  return value;
}

function optionalUniqueStrings(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  return requireUniqueStrings(value, path);
}

function requireUniqueStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  const normalized = value.map((entry, index) => requireString(entry, `${path}[${index}]`));
  return [...new Set(normalized)].sort();
}

function requireUniquePositiveIntegers(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  const normalized = value.map((entry, index) => {
    const result = optionalPositiveInteger(entry, `${path}[${index}]`);
    if (result === undefined) invalid(`${path}[${index}] is required.`);
    return result;
  });
  return [...new Set(normalized)].sort((left, right) => left - right);
}

function requireAttemptCounts(value: unknown, path: string): Record<string, number> {
  const record = requireRecord(value, path);
  const result: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    const normalizedKey = requireString(key, `${path} key`);
    const count = record[key];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      invalid(`${path}.${key} must be a non-negative integer.`);
    }
    result[normalizedKey] = count;
  }
  return result;
}

function requireJsonRecord(value: unknown, path: string): Record<string, unknown> {
  const record = requireRecord(value, path);
  return normalizeJsonValue(record, path) as Record<string, unknown>;
}

function requireJsonRecords(value: unknown, path: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  return value.map((entry, index) => requireJsonRecord(entry, `${path}[${index}]`));
}

function requireUniqueSafeRefs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  const refs = value.map((entry, index) => requireSafeRef(entry, `${path}[${index}]`));
  return [...new Set(refs)].sort();
}

function requireMetrics(value: unknown, path: string): Record<string, number> {
  const record = requireRecord(value, path);
  const result: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    const metric = record[key];
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
      invalid(`${path}.${key} must be a non-negative finite number.`);
    }
    result[requireString(key, `${path} key`)] = metric;
  }
  return result;
}

function normalizeJsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite numbers.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      invalid(`${path} must contain only JSON values.`);
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) invalid(`${path}.${key} must not be undefined.`);
      result[key] = normalizeJsonValue(record[key], `${path}.${key}`);
    }
    return result;
  }
  invalid(`${path} must contain only JSON values.`);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new CliError(2, 'BAD_INPUT', message, {
    category: 'collection-contract',
    ...details,
  });
}
