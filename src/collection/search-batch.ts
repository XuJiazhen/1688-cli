import { CliError } from '../io/errors.js';
import {
  SEARCH_REMOTE_PAGE_LIMIT,
  SEARCH_REMOTE_PAGE_SIZE,
} from '../session/search-limits.js';
import type { Offer } from '../session/search-mtop.js';
import {
  assertCheckpointCompatible,
  fingerprintCollectionUnit,
  normalizeCollectionUnit,
  type CollectionCheckpoint,
  type CollectionBatchStatus,
  type CollectionCompleteness,
  type CollectionUnit,
  type CollectionWarning,
  type CollectionError,
  type DuplicateObservation,
} from './contracts.js';

const SEARCH_CURSOR_PREFIX = 'search-page:v1:';

export interface SearchBatchPlan {
  unit: CollectionUnit;
  unitFingerprint: string;
  page: number;
  cursor: string | null;
  completedPages: number[];
  seenOfferIds: string[];
  checkpoint?: CollectionCheckpoint;
}

export interface SearchOfferObservation {
  [key: string]: unknown;
  offerId: string;
  offer: Offer;
  sourcePage: number;
  remoteSort: string | null;
  pageRank: number;
  rawRank: number;
  collectedAt: string;
}

export interface SearchPageBatch {
  schemaVersion: 1;
  batchId: string;
  unitId: string;
  kind: 'search-page';
  status: CollectionBatchStatus;
  startedAt: string;
  completedAt: string;
  subject: Record<string, unknown>;
  scope: Record<string, unknown>;
  observations: SearchOfferObservation[];
  completeness: CollectionCompleteness;
  duplicateObservations: DuplicateObservation[];
  warnings: CollectionWarning[];
  errors: CollectionError[];
  checkpoint?: CollectionCheckpoint;
  rawEvidenceRefs: string[];
  metrics: Record<string, number>;
}

export interface CreateSearchPageBatchInput {
  unit: unknown;
  checkpoint?: unknown;
  batchId: string;
  page: number;
  remoteSort: string | null;
  offers: readonly Offer[];
  hasMore: boolean;
  startedAt: string;
  collectedAt: string;
  completedAt: string;
  rawEvidenceRefs?: string[];
}

export function planSearchBatch(
  unitValue: unknown,
  checkpointValue?: unknown,
): SearchBatchPlan {
  const unit = normalizeCollectionUnit(unitValue);
  if (unit.kind !== 'search-page') {
    throw new CliError(2, 'BAD_INPUT', 'Search batch requires a search-page CollectionUnit.');
  }

  const checkpoint =
    checkpointValue === undefined
      ? undefined
      : assertCheckpointCompatible(unit, checkpointValue);
  const cursor = checkpoint?.nextCursor ?? unit.scope?.cursor ?? null;
  const cursorPage = cursor === null ? undefined : decodeSearchCursor(cursor);
  if (
    checkpoint?.nextPage !== undefined &&
    cursorPage !== undefined &&
    checkpoint.nextPage !== cursorPage
  ) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Search checkpoint page and cursor disagree.',
      { nextPage: checkpoint.nextPage, cursorPage },
    );
  }
  const page = checkpoint?.nextPage ?? cursorPage ?? 1;
  if (page > SEARCH_REMOTE_PAGE_LIMIT) {
    throw new CliError(
      2,
      checkpoint === undefined ? 'BAD_INPUT' : 'CHECKPOINT_INCOMPATIBLE',
      `Search collection cannot continue beyond remote page ${SEARCH_REMOTE_PAGE_LIMIT}.`,
      {
        page,
        remotePageLimit: SEARCH_REMOTE_PAGE_LIMIT,
      },
    );
  }
  const seenOfferIds = checkpoint?.seenKeys ?? [];
  const pendingOfferIds = checkpoint?.pendingKeys ?? [];
  const seenSet = new Set(seenOfferIds);
  const overlappingOfferIds = pendingOfferIds.filter((offerId) => seenSet.has(offerId));
  if (overlappingOfferIds.length > 0) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Search checkpoint pending offers must not already be marked as seen.',
      { overlappingOfferIds },
    );
  }
  if (pendingOfferIds.length > 0 && (checkpoint?.completedPages ?? []).includes(page)) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Search checkpoint cannot complete a page that still has pending offers.',
      { page, pendingOfferIds },
    );
  }

  return {
    unit,
    unitFingerprint: fingerprintCollectionUnit(unit),
    page,
    cursor,
    completedPages: checkpoint?.completedPages ?? [],
    seenOfferIds,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export function createSearchPageBatch(
  input: CreateSearchPageBatchInput,
): SearchPageBatch {
  const plan = planSearchBatch(input.unit, input.checkpoint);
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new CliError(2, 'BAD_INPUT', 'Search source page must be a positive integer.');
  }
  if (input.page !== plan.page) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      `Search batch planned page ${plan.page}, but received page ${input.page}.`,
    );
  }

  const startedAt = normalizeTimestamp(input.startedAt, 'startedAt');
  const collectedAt = normalizeTimestamp(input.collectedAt, 'collectedAt');
  const completedAt = normalizeTimestamp(input.completedAt, 'completedAt');
  const emissionLimit = Math.min(
    plan.unit.scope?.pageSize ?? input.offers.length,
    plan.unit.limits?.maxItems ?? input.offers.length,
  );
  const firstSources = new Map(
    plan.seenOfferIds.map((offerId) => [
      offerId,
      `search-page:checkpoint;offer=${encodeURIComponent(offerId)}`,
    ]),
  );
  const checkpointSeenSet = new Set(plan.seenOfferIds);
  const pendingFromCheckpoint = plan.checkpoint?.pendingKeys ?? [];
  const pendingSet = new Set(pendingFromCheckpoint);
  const resumingPartialPage = pendingFromCheckpoint.length > 0;
  const candidates: Array<{
    offer: Offer;
    pageRank: number;
    rawRank: number;
  }> = [];
  const duplicateObservations: DuplicateObservation[] = [];
  let replayedOffers = 0;
  const unexpectedOfferIds = new Set<string>();
  const capturedOfferIds = new Set<string>();
  input.offers.forEach((offer, index) => {
    const pageRank = index + 1;
    const rawRank = (input.page - 1) * SEARCH_REMOTE_PAGE_SIZE + pageRank;
    const source = formatObservationSource(input.page, rawRank, collectedAt);
    const firstSource = firstSources.get(offer.offerId);
    if (firstSource !== undefined) {
      if (resumingPartialPage && checkpointSeenSet.has(offer.offerId)) {
        replayedOffers++;
        return;
      }
      duplicateObservations.push({
        key: offer.offerId,
        firstSource,
        duplicateSource: source,
      });
      return;
    }
    firstSources.set(offer.offerId, source);
    capturedOfferIds.add(offer.offerId);
    if (resumingPartialPage && !pendingSet.has(offer.offerId)) {
      unexpectedOfferIds.add(offer.offerId);
      return;
    }
    candidates.push({ offer, pageRank, rawRank });
  });
  const missingPendingKeys = pendingFromCheckpoint.filter(
    (offerId) => !capturedOfferIds.has(offerId),
  );
  const terminalCheckpointDrift = missingPendingKeys.length > 0;
  const emittedCandidates = candidates.slice(0, emissionLimit);
  const observations: SearchOfferObservation[] = emittedCandidates.map(
    ({ offer, pageRank, rawRank }) => ({
      offerId: offer.offerId,
      offer,
      sourcePage: input.page,
      remoteSort: input.remoteSort,
      pageRank,
      rawRank,
      collectedAt,
    }),
  );
  const emittedOfferIds = new Set(observations.map((item) => item.offerId));
  const pendingKeys = [
    ...new Set(
      resumingPartialPage
        ? pendingFromCheckpoint.filter((offerId) => !emittedOfferIds.has(offerId))
        : candidates.slice(emittedCandidates.length).map(({ offer }) => offer.offerId),
    ),
  ].sort();
  const pageEmissionTruncated = pendingKeys.length > 0;
  const completedPages = pageEmissionTruncated
    ? [...plan.completedPages]
    : [...new Set([...plan.completedPages, input.page])].sort((a, b) => a - b);
  const seenKeys = [...new Set([...plan.seenOfferIds, ...observations.map((item) => item.offerId)])]
    .sort();
  const requestedScope = plan.unit.scope?.requestedScope ?? 'page';
  const shouldContinueScope = input.hasMore && requestedScope !== 'page';
  const reachedRemotePageBudget =
    !pageEmissionTruncated &&
    shouldContinueScope &&
    input.page === SEARCH_REMOTE_PAGE_LIMIT;
  const shouldAdvancePage =
    !pageEmissionTruncated &&
    shouldContinueScope &&
    input.page < SEARCH_REMOTE_PAGE_LIMIT;
  const shouldCheckpoint =
    (pageEmissionTruncated && !terminalCheckpointDrift) || shouldAdvancePage;
  const nextPage = pageEmissionTruncated ? input.page : input.page + 1;
  const checkpoint: CollectionCheckpoint | undefined = shouldCheckpoint
    ? {
        schemaVersion: 1,
        unitFingerprint: plan.unitFingerprint,
        kind: 'search-page',
        subject: { ...plan.unit.subject },
        scope: { ...(plan.unit.scope ?? {}) },
        nextCursor: encodeSearchCursor(nextPage),
        nextPage,
        completedPages,
        seenKeys,
        pendingKeys,
        attemptCounts: { ...(plan.checkpoint?.attemptCounts ?? {}) },
        updatedAt: completedAt,
      }
    : undefined;
  const warnings: CollectionWarning[] = [];
  if (pageEmissionTruncated && !terminalCheckpointDrift) {
    warnings.push({
      code: 'SEARCH_PAGE_EMISSION_TRUNCATED',
      message: `Search page ${input.page} has un-emitted offers; resume the same remote page from the checkpoint.`,
      details: {
        page: input.page,
        emissionLimit,
        pendingOffers: pendingKeys.length,
      },
    });
  }
  if (missingPendingKeys.length > 0 || unexpectedOfferIds.size > 0) {
    warnings.push({
      code: 'SEARCH_PAGE_CHECKPOINT_DRIFT',
      message: terminalCheckpointDrift
        ? `Search page ${input.page} lost pending offers while resuming; collection stopped without another checkpoint.`
        : `Search page ${input.page} changed while resuming a partial-page checkpoint.`,
      details: {
        page: input.page,
        missingPendingOfferIds: missingPendingKeys,
        unexpectedOfferIds: [...unexpectedOfferIds].sort(),
        continuationStopped: terminalCheckpointDrift,
      },
    });
  }
  if (reachedRemotePageBudget) {
    warnings.push({
      code: 'SEARCH_REMOTE_PAGE_BUDGET_EXHAUSTED',
      message: `Search collection reached the technical remote-page budget at page ${SEARCH_REMOTE_PAGE_LIMIT}.`,
      details: {
        page: input.page,
        remotePageLimit: SEARCH_REMOTE_PAGE_LIMIT,
        remoteHasMore: true,
      },
    });
  }
  const partial = shouldCheckpoint || reachedRemotePageBudget || terminalCheckpointDrift;

  return {
    schemaVersion: 1,
    batchId: requireNonEmpty(input.batchId, 'batchId'),
    unitId: plan.unit.unitId,
    kind: 'search-page',
    status: partial ? 'partial' : 'completed',
    startedAt,
    completedAt,
    subject: { ...plan.unit.subject },
    scope: {
      ...(plan.unit.scope ?? {}),
      page: input.page,
      remoteSort: input.remoteSort,
      remotePageSize: SEARCH_REMOTE_PAGE_SIZE,
    },
    observations,
    completeness: {
      requestedScope,
      state: partial ? 'truncated' : 'complete',
      observedPages: [input.page],
      failedPages: [],
      uniqueItems: seenKeys.length,
    },
    duplicateObservations,
    warnings,
    errors: [],
    ...(checkpoint === undefined ? {} : { checkpoint }),
    rawEvidenceRefs: input.rawEvidenceRefs ?? [],
    metrics: {
      capturedOffers: input.offers.length,
      uniqueNewOffers: observations.length,
      duplicateOffers: duplicateObservations.length,
      replayedOffers,
      deferredOffers: pendingKeys.length,
      unrecoverablePendingOffers: missingPendingKeys.length,
      emissionLimit,
      remotePageLimit: SEARCH_REMOTE_PAGE_LIMIT,
    },
  };
}

export function encodeSearchCursor(nextPage: number): string {
  if (!Number.isInteger(nextPage) || nextPage < 1) {
    throw new CliError(2, 'BAD_INPUT', 'Search cursor page must be a positive integer.');
  }
  return `${SEARCH_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({ nextPage }),
  ).toString('base64url')}`;
}

export function decodeSearchCursor(cursor: string): number {
  if (!cursor.startsWith(SEARCH_CURSOR_PREFIX)) {
    throw new CliError(2, 'BAD_INPUT', 'Unsupported search continuation cursor.');
  }
  try {
    const encoded = cursor.slice(SEARCH_CURSOR_PREFIX.length);
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      nextPage?: unknown;
    };
    if (!Number.isInteger(value.nextPage) || (value.nextPage as number) < 1) {
      throw new Error('invalid page');
    }
    return value.nextPage as number;
  } catch {
    throw new CliError(2, 'BAD_INPUT', 'Invalid search continuation cursor.');
  }
}

function normalizeTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new CliError(2, 'BAD_INPUT', `Search batch ${field} must be an ISO timestamp.`);
  }
  return new Date(time).toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliError(2, 'BAD_INPUT', `Search batch ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function formatObservationSource(
  page: number,
  rawRank: number,
  collectedAt: string,
): string {
  return `search-page:page=${page};rank=${rawRank};collectedAt=${collectedAt}`;
}
