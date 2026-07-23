import { CliError } from '../io/errors.js';
import {
  mapSupplierQualificationPayload,
  type SupplierQualification,
} from '../session/supplier-qualification.js';
import {
  assertCheckpointCompatible,
  fingerprintCollectionUnit,
  normalizeCollectionBatch,
  normalizeCollectionUnit,
  normalizeEvidence,
  type CollectionBatch,
  type CollectionCheckpoint,
  type CollectionUnit,
  type Evidence,
  type EvidenceSource,
} from './contracts.js';

interface QualificationBatchBaseInput {
  unit: unknown;
  checkpoint?: unknown;
  batchId: string;
  startedAt: string;
  completedAt: string;
  requestMemberId?: string;
  sourceRef?: string;
  rawEvidenceRefs?: string[];
}

export type CreateQualificationBatchInput = QualificationBatchBaseInput &
  (
    | { payload: unknown; qualification?: never; collectedAt: string }
    | { qualification: SupplierQualification; payload?: never; collectedAt?: never }
  );

export interface QualificationObservation {
  /** Exact shop member key used to correlate the captured response. */
  requestMemberId: string | null;
  /** Member identifier reported by the response; it may be an alias. */
  memberId: string | null;
  companyName: Evidence<string>;
  registeredBusinessScope: Evidence<string>;
  socialCreditCode: Evidence<string>;
  establishedAt: Evidence<string>;
  shopSummary: Evidence<string>;
  productionService: Evidence<string>;
  businessLine: Evidence<string>;
  certificates: SupplierQualification['certificates'];
  certificateListAvailability: SupplierQualification['certificateListAvailability'];
  certificationImages: SupplierQualification['certificationImages'];
  source: EvidenceSource;
}

export function createQualificationBatch(
  input: CreateQualificationBatchInput,
): CollectionBatch {
  const unit = normalizeCollectionUnit(input.unit);
  assertQualificationUnit(unit);
  const restoredCheckpoint =
    input.checkpoint === undefined
      ? undefined
      : assertCheckpointCompatible(unit, input.checkpoint);
  if (
    restoredCheckpoint !== undefined &&
    restoredCheckpoint.nextPage !== undefined &&
    restoredCheckpoint.nextPage !== 1
  ) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Qualification checkpoint can only resume the single qualification page.',
    );
  }
  const qualification = resolveQualification(input);
  const requestMemberId = resolveRequestMemberId(
    input.requestMemberId,
    unit,
    qualification.memberId,
  );
  const rawEvidenceRefs = input.rawEvidenceRefs ?? [];
  const source = normalizeSource(
    qualification.source,
    input.sourceRef,
    rawEvidenceRefs[0],
  );
  const observation = rebaseQualification(
    qualification,
    source,
    requestMemberId,
  );
  const failedFacts = countAvailability(observation, 'failed');
  const availableFacts = countAvailability(observation, 'available');
  const notPresentFacts = countAvailability(observation, 'not-present');
  const hasFailure =
    failedFacts > 0 || observation.certificateListAvailability === 'failed';
  const payloadFailed =
    failedFacts === qualificationEvidence(observation).length &&
    observation.certificateListAvailability === 'failed';
  const completedAt = normalizeTimestamp(input.completedAt, 'completedAt');
  const checkpoint = hasFailure
    ? qualificationCheckpoint(unit, completedAt, restoredCheckpoint)
    : undefined;
  const errors = qualificationErrors(observation, source);

  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: input.batchId,
    unitId: unit.unitId,
    kind: 'store-qualification',
    status: payloadFailed ? 'failed' : hasFailure ? 'partial' : 'completed',
    startedAt: input.startedAt,
    completedAt,
    subject: { ...unit.subject },
    scope: { ...unit.scope },
    observations: [observation],
    completeness: {
      requestedScope: unit.scope?.requestedScope ?? 'page',
      state: hasFailure ? 'unknown' : 'complete',
      observedPages: payloadFailed ? [] : [1],
      failedPages: hasFailure ? [1] : [],
      uniqueItems: payloadFailed ? 0 : 1,
    },
    duplicateObservations: [],
    warnings: qualification.warnings.map((warning) => ({
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
      qualificationSnapshots: payloadFailed ? 0 : 1,
      availableFacts,
      notPresentFacts,
      failedFacts,
      certificates: observation.certificates.length,
      certificationImages: observation.certificationImages.length,
    },
  });
}

function qualificationErrors(
  qualification: QualificationObservation,
  source: EvidenceSource,
): CollectionBatch['errors'] {
  const uniqueErrors = new Map<string, { code: string; message: string }>();
  for (const evidence of qualificationEvidence(qualification)) {
    if (evidence.availability !== 'failed') continue;
    const error = evidence.error ?? {
      code: 'QUALIFICATION_FACT_FAILED',
      message: 'A qualification fact could not be collected or parsed.',
    };
    uniqueErrors.set(`${error.code}\u0000${error.message}`, error);
  }
  if (
    qualification.certificateListAvailability === 'failed' &&
    uniqueErrors.size === 0
  ) {
    const error = {
      code: 'QUALIFICATION_CERTIFICATE_LIST_FAILED',
      message: 'The qualification certificate list could not be collected or parsed.',
    };
    uniqueErrors.set(`${error.code}\u0000${error.message}`, error);
  }
  return [...uniqueErrors.values()].map((error) => ({
    ...error,
    retryable: true,
    details: { sourceRef: source.sourceRef },
  }));
}

function resolveQualification(
  input: CreateQualificationBatchInput,
): SupplierQualification {
  const hasPayload = Object.hasOwn(input, 'payload');
  const hasQualification = Object.hasOwn(input, 'qualification');
  if (hasPayload === hasQualification) {
    throw new CliError(
      2,
      'BAD_INPUT',
      'Qualification batch requires exactly one payload or parsed qualification.',
    );
  }
  if (hasQualification) return input.qualification as SupplierQualification;
  return mapSupplierQualificationPayload(input.payload, input.collectedAt);
}

function rebaseQualification(
  qualification: SupplierQualification,
  source: EvidenceSource,
  requestMemberId: string | null,
): QualificationObservation {
  return {
    requestMemberId,
    memberId: qualification.memberId,
    companyName: rebaseEvidence(qualification.companyName, source),
    registeredBusinessScope: rebaseEvidence(
      qualification.registeredBusinessScope,
      source,
    ),
    socialCreditCode: rebaseEvidence(qualification.socialCreditCode, source),
    establishedAt: rebaseEvidence(qualification.establishedAt, source),
    shopSummary: rebaseEvidence(qualification.shopSummary, source),
    productionService: rebaseEvidence(qualification.productionService, source),
    businessLine: rebaseEvidence(qualification.businessLine, source),
    certificates: qualification.certificates.map((certificate) => ({ ...certificate })),
    certificateListAvailability: qualification.certificateListAvailability,
    certificationImages: qualification.certificationImages.map((image) => ({ ...image })),
    source,
  };
}

function resolveRequestMemberId(
  requestMemberId: string | undefined,
  unit: CollectionUnit,
  responseMemberId: string | null,
): string | null {
  if (requestMemberId !== undefined) {
    const normalized = requestMemberId.trim();
    if (normalized.length === 0) {
      throw new CliError(
        2,
        'BAD_INPUT',
        'Qualification batch requestMemberId must be a non-empty string.',
      );
    }
    return normalized;
  }
  return unit.subject.supplier?.memberId ?? responseMemberId;
}

function rebaseEvidence<T>(
  evidence: Evidence<T>,
  source: EvidenceSource,
): Evidence<T> {
  return normalizeEvidence<T>({
    ...evidence,
    source: {
      ...source,
      fieldPath: evidence.source.fieldPath,
    },
  });
}

function normalizeSource(
  source: EvidenceSource,
  sourceRef?: string,
  rawRef?: string,
): EvidenceSource {
  const normalized = normalizeEvidence<string>({
    availability: 'available',
    value: 'qualification-source',
    source: {
      ...source,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(rawRef === undefined ? {} : { rawRef }),
    },
  });
  return normalized.source;
}

function countAvailability(
  qualification: QualificationObservation,
  availability: Evidence<string>['availability'],
): number {
  return qualificationEvidence(qualification).filter(
    (evidence) => evidence.availability === availability,
  ).length;
}

function qualificationEvidence(
  qualification: QualificationObservation,
): Array<Evidence<string>> {
  return [
    qualification.companyName,
    qualification.registeredBusinessScope,
    qualification.socialCreditCode,
    qualification.establishedAt,
    qualification.shopSummary,
    qualification.productionService,
    qualification.businessLine,
  ];
}

function qualificationCheckpoint(
  unit: CollectionUnit,
  updatedAt: string,
  restored?: CollectionCheckpoint,
): CollectionCheckpoint {
  return {
    schemaVersion: 1,
    unitFingerprint: fingerprintCollectionUnit(unit),
    kind: 'store-qualification',
    subject: { ...unit.subject },
    scope: { ...unit.scope },
    nextPage: 1,
    completedPages: [],
    seenKeys: [],
    pendingKeys: ['qualification'],
    attemptCounts: {
      ...restored?.attemptCounts,
      qualification: (restored?.attemptCounts.qualification ?? 0) + 1,
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
      `Qualification batch ${field} must be an ISO timestamp.`,
    );
  }
  return new Date(timestamp).toISOString();
}

function assertQualificationUnit(
  unit: CollectionUnit,
): asserts unit is CollectionUnit & { kind: 'store-qualification' } {
  if (unit.kind !== 'store-qualification') {
    throw new CliError(
      2,
      'BAD_INPUT',
      'Qualification batch requires a store-qualification CollectionUnit.',
    );
  }
}
