import { createHash, randomUUID } from 'node:crypto';
import type { OfferResult } from '../commands/offer.js';
import { CliError } from '../io/errors.js';
import type { OfferMediaManifest } from '../session/offer-media.js';
import { createOfferSingletonSourceKeyV1 } from '../session/offer-media.js';
import { sanitizeCollectorPayloadV1 } from '../session/collector-raw-archive.js';
import { normalizePublicSellerLoginIdV1 } from '../session/public-seller-identity.js';
import {
  redactDiagnosticMetadata,
  redactTextForDiagnostics,
  sanitizeEvidenceRef,
} from '../session/redaction.js';
import {
  normalizeCollectionBatch,
  normalizeCollectionUnit,
  type CollectionBatch,
  type CollectionUnit,
} from './contracts.js';

export type OfferCaptureOutcome =
  | { status: 'captured'; value: OfferResult }
  | { status: 'failed'; error: unknown };

export interface OfferSkuManifestV1 {
  schema: 'offer-sku-manifest-v1';
  offerId: string;
  state: 'explicit-variants' | 'offer-singleton';
  explicitSkuCount: number;
  skuIds: string[];
  singletonSourceKey: string | null;
  optionCount: number;
  nullFactsCarryAvailability: true;
  manifestHash: string;
}

export function createOfferSkuManifestV1(offer: OfferResult): OfferSkuManifestV1 {
  const skuIds = offer.skus.map((sku) => sku.skuId.trim());
  if (offer.skus.length === 0 && offer.options.length > 0) {
    throw new CliError(
      9,
      'OFFER_SKU_IDENTITY_UNRESOLVED',
      'Offer variants without stable platform skuId values cannot be downgraded to a singleton.',
      {
        category: 'protocol',
        retryable: false,
        recoveryAction: 'inspect-sku-parser',
      },
    );
  }
  if (skuIds.some((skuId) => !skuId) || new Set(skuIds).size !== skuIds.length) {
    throw new CliError(9, 'OFFER_SKU_IDENTITY_INVALID', 'Explicit Offer SKUs require unique stable skuId values.', {
      category: 'protocol', retryable: false, recoveryAction: 'inspect-sku-parser',
    });
  }
  for (const sku of offer.skus) {
    for (const field of ['price', 'stock', 'saleCount'] as const) {
      if (sku[field] === null && sku.availability[field] !== 'not-present') {
        throw new CliError(9, 'OFFER_SKU_AVAILABILITY_INVALID', `Null ${field} requires not-present availability.`);
      }
      if (sku[field] !== null && sku.availability[field] !== 'available') {
        throw new CliError(9, 'OFFER_SKU_AVAILABILITY_INVALID', `Present ${field} requires available availability.`);
      }
    }
  }
  const content = {
    schema: 'offer-sku-manifest-v1' as const,
    offerId: offer.offerId,
    state: offer.skus.length === 0 ? 'offer-singleton' as const : 'explicit-variants' as const,
    explicitSkuCount: offer.skus.length,
    skuIds,
    singletonSourceKey: offer.skus.length === 0
      ? createOfferSingletonSourceKeyV1(offer.offerId)
      : null,
    optionCount: offer.options.length,
    nullFactsCarryAvailability: true as const,
  };
  return {
    ...content,
    manifestHash: `sha256:${createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex')}`,
  };
}

export interface CreateOfferCollectionBatchInput {
  unit: unknown;
  outcome: OfferCaptureOutcome;
  batchId?: string;
  startedAt: string;
  completedAt: string;
  rawEvidenceRefs?: string[];
  sourceRequestId?: string;
}

export function createOfferCollectionBatch(
  input: CreateOfferCollectionBatchInput,
): CollectionBatch {
  const unit = normalizeCollectionUnit(input.unit);
  assertOfferUnit(unit);
  if (input.outcome.status === 'failed') {
    return createFailedBatch(input, unit);
  }
  const offer = input.outcome.value;
  if (offer.offerId !== unit.subject.offerId) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Captured offer ${offer.offerId} does not match CollectionUnit offer ${unit.subject.offerId}.`,
      { category: 'collection-contract' },
    );
  }
  const collectedAt = normalizeTimestamp(input.completedAt);
  const media = sanitizeMediaManifest(offer.media);
  const sanitizedBase = sanitizeCollectorPayloadV1({
    ...offer,
    media,
  }) as OfferResult;
  const sanitizedOffer = {
    ...sanitizedBase,
    supplier: {
      ...sanitizedBase.supplier,
      sellerLoginId: normalizePublicSellerLoginIdV1(offer.supplier.loginId),
    },
  };
  const observations = unit.kind === 'offer-detail'
    ? [{ offerId: offer.offerId, offer: sanitizedOffer, collectedAt }]
    : [{ offerId: offer.offerId, media, collectedAt }];
  const warnings = media.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    details: {
      offerId: offer.offerId,
      ...(warning.order === undefined ? {} : { order: warning.order }),
      ...(warning.originalUrl === undefined
        ? {}
        : { originalUrl: warning.originalUrl }),
    },
  }));
  const mediaFailed =
    media.availability === 'failed' ||
    media.warnings.some(
      (warning) => warning.code === 'OFFER_DETAILS_CONTENT_UNREADABLE',
    );
  const errors = mediaFailed
    ? [
        {
          code: 'OFFER_MEDIA_CAPTURE_FAILED',
          message: 'Offer media evidence could not be completely collected.',
          retryable: true,
          details: { offerId: offer.offerId },
        },
      ]
    : [];

  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: input.batchId ?? randomUUID(),
    unitId: unit.unitId,
    ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
    kind: unit.kind,
    status: mediaFailed ? 'partial' : 'completed',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    subject: { ...unit.subject },
    scope: { ...(unit.scope ?? {}) },
    observations,
    completeness: {
      requestedScope: unit.scope?.requestedScope ?? 'page',
      state: mediaFailed ? 'truncated' : 'complete',
      observedPages: [],
      failedPages: [],
      expectedItems: 1,
      uniqueItems: 1,
    },
    duplicateObservations: [],
    warnings,
    errors,
    rawEvidenceRefs: sanitizeEvidenceRefs(input.rawEvidenceRefs ?? []),
    metrics: {
      capturedOffers: 1,
      ...(unit.kind === 'offer-media-manifest'
        ? { mediaItems: media.items.length }
        : {}),
    },
  });
}

function sanitizeMediaManifest(media: OfferMediaManifest): OfferMediaManifest {
  return {
    ...media,
    source: {
      ...media.source,
      sourceRef: sanitizeEvidenceRef(media.source.sourceRef),
      ...(media.source.rawRef === undefined
        ? {}
        : { rawRef: sanitizeEvidenceRef(media.source.rawRef) }),
    },
  };
}

function createFailedBatch(
  input: CreateOfferCollectionBatchInput,
  unit: CollectionUnit & {
    kind: 'offer-detail' | 'offer-media-manifest';
    subject: { offerId: string };
  },
): CollectionBatch {
  if (input.outcome.status !== 'failed') {
    throw new TypeError('Expected a failed offer capture outcome.');
  }
  const error = input.outcome.error;
  const code = error instanceof CliError ? error.code : 'OFFER_CAPTURE_FAILED';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactTextForDiagnostics(
    rawMessage.trim() || 'Offer capture failed.',
  );
  const retryable =
    error instanceof CliError && typeof error.details.retryable === 'boolean'
      ? error.details.retryable
      : true;
  const actionRequired =
    code === 'NOT_LOGGED_IN' || code === 'RISK_CONTROL'
      ? {
          type: code === 'NOT_LOGGED_IN' ? ('login' as const) : ('risk-control' as const),
          message,
        }
      : undefined;

  return normalizeCollectionBatch({
    schemaVersion: 1,
    batchId: input.batchId ?? randomUUID(),
    unitId: unit.unitId,
    ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
    kind: unit.kind,
    status: actionRequired === undefined ? 'failed' : 'blocked',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    subject: { ...unit.subject },
    scope: { ...(unit.scope ?? {}) },
    observations: [],
    completeness: {
      requestedScope: unit.scope?.requestedScope ?? 'page',
      state: 'unknown',
      observedPages: [],
      failedPages: [],
      expectedItems: 1,
      uniqueItems: 0,
    },
    duplicateObservations: [],
    warnings: [],
    errors: [
      {
        code,
        message,
        retryable,
        ...(error instanceof CliError
          ? {
              details: redactDiagnosticMetadata(
                error.details,
              ) as Record<string, unknown>,
            }
          : {}),
      },
    ],
    actionRequired,
    rawEvidenceRefs: sanitizeEvidenceRefs(input.rawEvidenceRefs ?? []),
    metrics: { capturedOffers: 0, failedOffers: 1 },
  });
}

export function createOfferPageActionBatchesV1(input: {
  offer: OfferResult;
  unitId: string;
  sourceRequestId: string;
  detailBatchId: string;
  mediaBatchId: string;
  startedAt: string;
  completedAt: string;
  rawEvidenceRefs: string[];
}): [CollectionBatch, CollectionBatch] {
  const unit = (kind: 'offer-detail' | 'offer-media-manifest'): CollectionUnit => ({
    schemaVersion: 1,
    unitId: input.unitId,
    kind,
    subject: { offerId: input.offer.offerId },
    scope: { requestedScope: 'page' },
  });
  const common = {
    outcome: { status: 'captured' as const, value: input.offer },
    sourceRequestId: input.sourceRequestId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    rawEvidenceRefs: input.rawEvidenceRefs,
  };
  return [
    createOfferCollectionBatch({ ...common, unit: unit('offer-detail'), batchId: input.detailBatchId }),
    createOfferCollectionBatch({ ...common, unit: unit('offer-media-manifest'), batchId: input.mediaBatchId }),
  ];
}

function sanitizeEvidenceRefs(refs: readonly string[]): string[] {
  return refs.map((ref) => sanitizeEvidenceRef(ref));
}

function assertOfferUnit(
  unit: CollectionUnit,
): asserts unit is CollectionUnit & {
  kind: 'offer-detail' | 'offer-media-manifest';
  subject: { offerId: string };
} {
  if (unit.kind !== 'offer-detail' && unit.kind !== 'offer-media-manifest') {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Offer batch requires offer-detail or offer-media-manifest, received ${unit.kind}.`,
      { category: 'collection-contract' },
    );
  }
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CliError(2, 'BAD_INPUT', 'Offer collection timestamp is invalid.', {
      category: 'collection-contract',
    });
  }
  return new Date(timestamp).toISOString();
}
