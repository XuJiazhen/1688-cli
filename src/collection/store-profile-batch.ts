import { CliError } from '../io/errors.js';
import { sanitizeEvidenceRef } from '../session/redaction.js';
import {
  mapStoreProfilePayload,
  normalizeStoreProfileSnapshot,
  storeProfileEvidence,
  type StoreProfileSnapshot,
} from '../session/store-profile.js';
import {
  assertCheckpointCompatible,
  fingerprintCollectionUnit,
  normalizeCollectionBatch,
  normalizeCollectionUnit,
  type CollectionBatch,
  type CollectionCheckpoint,
  type CollectionUnit,
} from './contracts.js';

interface StoreProfileBatchBaseInput {
  unit: unknown;
  checkpoint?: unknown;
  batchId: string;
  startedAt: string;
  completedAt: string;
  sourceRef?: string;
  rawEvidenceRefs?: string[];
}

export type CreateStoreProfileBatchInput = StoreProfileBatchBaseInput &
  (
    | { payload: unknown; profile?: never; collectedAt: string }
    | { profile: StoreProfileSnapshot; payload?: never; collectedAt?: never }
  );

export type StoreProfileObservation = Omit<StoreProfileSnapshot, 'warnings'> & {
  requestMemberId: string | null;
};

export function createStoreProfileBatch(
  input: CreateStoreProfileBatchInput,
): CollectionBatch {
  const unit = normalizeCollectionUnit(input.unit);
  assertStoreProfileUnit(unit);
  const restoredCheckpoint =
    input.checkpoint === undefined
      ? undefined
      : assertCheckpointCompatible(unit, input.checkpoint);
  const rawEvidenceRefs = (input.rawEvidenceRefs ?? []).map(sanitizeEvidenceRef);
  const profile = resolveStoreProfile(input, rawEvidenceRefs[0]);
  const evidence = storeProfileEvidence(profile);
  const failed = evidence.filter(
    (entry) => entry.evidence.availability === 'failed',
  );
  const notCollected = evidence.filter(
    (entry) => entry.evidence.availability === 'not-collected',
  );
  if (notCollected.length > 0) {
    throw new CliError(
      2,
      'BAD_INPUT',
      'Store profile evidence must use not-present or failed, never not-collected.',
      {
        category: 'collection-contract',
        fields: notCollected.map((entry) => entry.field).sort(),
      },
    );
  }
  const notPresent = evidence.filter(
    (entry) => entry.evidence.availability === 'not-present',
  );
  const available = evidence.filter(
    (entry) => entry.evidence.availability === 'available',
  );
  const payloadFailed = available.length === 0 && failed.length > 0;
  const incomplete = failed.length > 0;
  const completedAt = normalizeTimestamp(input.completedAt, 'completedAt');
  const pendingKeys = failed
    .map((entry) => `field:${String(entry.field)}`)
    .sort();
  const checkpoint = incomplete
    ? storeProfileCheckpoint(
        unit,
        completedAt,
        pendingKeys,
        restoredCheckpoint,
      )
    : undefined;
  const errors: CollectionBatch['errors'] = [];
  if (failed.length > 0) {
    errors.push({
      code: 'STORE_PROFILE_DATA_MISSING',
      message: 'The store profile payload could not be parsed completely.',
      retryable: true,
      details: { fields: failed.map((entry) => entry.field).sort() },
    });
  }
  const { warnings: _warnings, ...profileFacts } = profile;
  const observation: StoreProfileObservation = {
    requestMemberId: unit.subject.supplier?.memberId ?? null,
    ...profileFacts,
  };

  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: input.batchId,
    unitId: unit.unitId,
    kind: 'store-profile',
    status: payloadFailed ? 'failed' : incomplete ? 'partial' : 'completed',
    startedAt: input.startedAt,
    completedAt,
    subject: { ...unit.subject },
    scope: { ...unit.scope },
    observations: [observation],
    completeness: {
      requestedScope: unit.scope?.requestedScope ?? 'page',
      state: incomplete ? 'unknown' : 'complete',
      observedPages: payloadFailed ? [] : [1],
      failedPages: incomplete ? [1] : [],
      expectedItems: 1,
      uniqueItems: payloadFailed ? 0 : 1,
    },
    duplicateObservations: [],
    warnings: profile.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.fieldPath === undefined
        ? {}
        : { details: { fieldPath: warning.fieldPath } }),
    })),
    errors,
    checkpoint,
    rawEvidenceRefs,
    metrics: {
      profileSnapshots: payloadFailed ? 0 : 1,
      availableFacts: available.length,
      notPresentFacts: notPresent.length,
      notCollectedFacts: notCollected.length,
      failedFacts: failed.length,
    },
  });
}

function resolveStoreProfile(
  input: CreateStoreProfileBatchInput,
  rawRef?: string,
): StoreProfileSnapshot {
  const hasPayload = Object.hasOwn(input, 'payload');
  const hasProfile = Object.hasOwn(input, 'profile');
  if (hasPayload === hasProfile) {
    throw new CliError(
      2,
      'BAD_INPUT',
      'Store profile batch requires exactly one payload or parsed profile.',
    );
  }
  if (hasProfile) {
    return normalizeStoreProfileSnapshot(input.profile);
  }
  return normalizeStoreProfileSnapshot(
    mapStoreProfilePayload(input.payload, input.collectedAt, {
      ...(input.sourceRef === undefined
        ? {}
        : { sourceRef: sanitizeEvidenceRef(input.sourceRef) }),
      ...(rawRef === undefined ? {} : { rawRef }),
    }),
  );
}

function storeProfileCheckpoint(
  unit: CollectionUnit,
  updatedAt: string,
  pendingKeys: string[],
  restored?: CollectionCheckpoint,
): CollectionCheckpoint {
  return {
    schemaVersion: 1,
    unitFingerprint: fingerprintCollectionUnit(unit),
    kind: 'store-profile',
    subject: { ...unit.subject },
    scope: { ...unit.scope },
    nextPage: 1,
    completedPages: [],
    seenKeys: [],
    pendingKeys,
    attemptCounts: {
      ...restored?.attemptCounts,
      'store-profile': (restored?.attemptCounts['store-profile'] ?? 0) + 1,
    },
    updatedAt,
  };
}

function normalizeTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Store profile batch ${field} must be an ISO timestamp.`,
    );
  }
  return new Date(timestamp).toISOString();
}

function assertStoreProfileUnit(
  unit: CollectionUnit,
): asserts unit is CollectionUnit & { kind: 'store-profile' } {
  if (unit.kind !== 'store-profile') {
    throw new CliError(
      2,
      'BAD_INPUT',
      'Store profile batch requires a store-profile CollectionUnit.',
    );
  }
}
