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
const SEARCH_NO_PROGRESS_ATTEMPT_PREFIX = 'search-page:no-progress:';
const SEARCH_SNAPSHOT_TOO_LARGE_ATTEMPT_PREFIX =
  'search-page:snapshot-too-large:';
const SEARCH_REMOTE_PAGE_OVERSIZE_ATTEMPT_PREFIX =
  'search-page:remote-page-oversize:';
export const SEARCH_NO_PROGRESS_ATTEMPT_LIMIT = 3;
export const SEARCH_PENDING_ITEMS_LIMIT = SEARCH_REMOTE_PAGE_SIZE;
export const SEARCH_PENDING_ITEMS_MAX_BYTES = 256 * 1024;

export interface SearchPendingItem {
  [key: string]: unknown;
  snapshotVersion: 1;
  key: string;
  offer: Offer;
  sourcePage: number;
  remoteSort: string | null;
  pageRank: number;
  rawRank: number;
  collectedAt: string;
  remoteHasMore: boolean;
}

export interface SearchBatchPlan {
  unit: CollectionUnit;
  unitFingerprint: string;
  page: number;
  cursor: string | null;
  completedPages: number[];
  seenOfferIds: string[];
  pendingOfferIds: string[];
  pendingItems: SearchPendingItem[];
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

export interface DrainSearchCheckpointSnapshotInput {
  unit: unknown;
  checkpoint: unknown;
  batchId: string;
  startedAt: string;
  completedAt: string;
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
  const seenOfferIds = (checkpoint?.seenKeys ?? []).map((offerId, index) =>
    requireOfferId(offerId, `CollectionCheckpoint.seenKeys[${index}]`)
  );
  const pendingOfferIds = normalizeLegacySearchPendingKeys(
    checkpoint?.pendingKeys ?? [],
    page,
  );
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
  const pendingItems = normalizeSearchPendingItems(
    checkpoint?.pendingItems,
    page,
  );
  if (pendingItems.length > 0) {
    const pendingItemKeys = [...pendingItems.map((item) => item.key)].sort();
    const expectedPendingKeys = [...pendingOfferIds].sort();
    if (
      pendingItemKeys.length !== expectedPendingKeys.length ||
      pendingItemKeys.some((key, index) => key !== expectedPendingKeys[index])
    ) {
      throw new CliError(
        2,
        'CHECKPOINT_INCOMPATIBLE',
        'Search checkpoint pending item snapshots must match pendingKeys.',
        { pendingOfferIds, pendingItemKeys },
      );
    }
  }

  return {
    unit,
    unitFingerprint: fingerprintCollectionUnit(unit),
    page,
    cursor,
    completedPages: checkpoint?.completedPages ?? [],
    seenOfferIds,
    pendingOfferIds,
    pendingItems,
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
  const availableOffers =
    plan.pendingItems.length > 0
      ? plan.pendingItems.length
      : input.offers.length;
  const emissionLimit = Math.min(
    plan.unit.scope?.pageSize ?? availableOffers,
    plan.unit.limits?.maxItems ?? availableOffers,
  );
  const firstSources = new Map(
    plan.seenOfferIds.map((offerId) => [
      offerId,
      `search-page:checkpoint;offer=${encodeURIComponent(offerId)}`,
    ]),
  );
  const checkpointSeenSet = new Set(plan.seenOfferIds);
  const pendingFromCheckpoint = plan.pendingOfferIds;
  const pendingSet = new Set(pendingFromCheckpoint);
  const resumingPartialPage = pendingFromCheckpoint.length > 0;
  const resumingSnapshot = plan.pendingItems.length > 0;
  const candidates: Array<{
    offer: Offer;
    pageRank: number;
    rawRank: number;
    collectedAt: string;
    remoteSort: string | null;
    remoteHasMore: boolean;
  }> = [];
  const duplicateObservations: DuplicateObservation[] = [];
  let replayedOffers = 0;
  const unexpectedOfferIds = new Set<string>();
  const capturedOfferIds = new Set<string>();
  if (resumingSnapshot) {
    candidates.push(
      ...plan.pendingItems.map((item) => ({
        offer: item.offer,
        pageRank: item.pageRank,
        rawRank: item.rawRank,
        collectedAt: item.collectedAt,
        remoteSort: item.remoteSort,
        remoteHasMore: item.remoteHasMore,
      })),
    );
  } else {
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
      candidates.push({
        offer,
        pageRank,
        rawRank,
        collectedAt,
        remoteSort: input.remoteSort,
        remoteHasMore: input.hasMore,
      });
    });
  }
  const missingPendingKeys = resumingSnapshot
    ? []
    : pendingFromCheckpoint.filter((offerId) => !capturedOfferIds.has(offerId));
  const remotePageOversize = input.offers.length > SEARCH_REMOTE_PAGE_SIZE;
  const initiallyEmittedCandidates = remotePageOversize
    ? []
    : candidates.slice(0, emissionLimit);
  const deferredCandidates = candidates.slice(initiallyEmittedCandidates.length);
  const rawCreatedPendingItems =
    !remotePageOversize && (resumingSnapshot || !resumingPartialPage)
      ? deferredCandidates.map(toSearchPendingItem)
      : undefined;
  const createdSnapshotBytes =
    rawCreatedPendingItems === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(rawCreatedPendingItems), 'utf8');
  const snapshotTooLarge =
    rawCreatedPendingItems !== undefined &&
    (rawCreatedPendingItems.length > SEARCH_PENDING_ITEMS_LIMIT ||
      createdSnapshotBytes > SEARCH_PENDING_ITEMS_MAX_BYTES);
  const createdPendingItems =
    rawCreatedPendingItems === undefined || snapshotTooLarge
      ? undefined
      : normalizeSearchPendingItems(rawCreatedPendingItems, input.page);
  const emittedCandidates =
    remotePageOversize || snapshotTooLarge ? [] : initiallyEmittedCandidates;
  const observations: SearchOfferObservation[] = emittedCandidates.map(
    ({ offer, pageRank, rawRank, collectedAt: itemCollectedAt, remoteSort }) => ({
      offerId: offer.offerId,
      offer,
      sourcePage: input.page,
      remoteSort,
      pageRank,
      rawRank,
      collectedAt: itemCollectedAt,
    }),
  );
  const emittedOfferIds = new Set(observations.map((item) => item.offerId));
  const pendingKeys = [
    ...new Set(
      remotePageOversize
        ? resumingPartialPage
          ? pendingFromCheckpoint
          : candidates.map(({ offer }) => offer.offerId)
        : snapshotTooLarge
        ? resumingPartialPage
          ? pendingFromCheckpoint
          : candidates.map(({ offer }) => offer.offerId)
        : resumingPartialPage
        ? resumingSnapshot
          ? candidates
              .slice(emittedCandidates.length)
              .map(({ offer }) => offer.offerId)
          : pendingFromCheckpoint.filter((offerId) => !emittedOfferIds.has(offerId))
        : candidates.slice(emittedCandidates.length).map(({ offer }) => offer.offerId),
    ),
  ].sort();
  const pendingItems =
    remotePageOversize || snapshotTooLarge
      ? undefined
      : createdPendingItems;
  const pageEmissionTruncated = pendingKeys.length > 0;
  const completedPages = pageEmissionTruncated
    ? [...plan.completedPages]
    : [...new Set([...plan.completedPages, input.page])].sort((a, b) => a - b);
  const seenKeys = [...new Set([...plan.seenOfferIds, ...observations.map((item) => item.offerId)])]
    .sort();
  const requestedScope = plan.unit.scope?.requestedScope ?? 'page';
  const remoteHasMore =
    emittedCandidates.at(-1)?.remoteHasMore ??
    plan.pendingItems.at(-1)?.remoteHasMore ??
    input.hasMore;
  const shouldContinueScope = remoteHasMore && requestedScope !== 'page';
  const reachedRemotePageBudget =
    !pageEmissionTruncated &&
    shouldContinueScope &&
    input.page === SEARCH_REMOTE_PAGE_LIMIT;
  const shouldAdvancePage =
    !pageEmissionTruncated &&
    shouldContinueScope &&
    input.page < SEARCH_REMOTE_PAGE_LIMIT;
  const shouldCheckpoint =
    pageEmissionTruncated || shouldAdvancePage;
  const nextPage = pageEmissionTruncated ? input.page : input.page + 1;
  const noProgressAttemptKey =
    `${SEARCH_NO_PROGRESS_ATTEMPT_PREFIX}${input.page}`;
  const snapshotTooLargeAttemptKey =
    `${SEARCH_SNAPSHOT_TOO_LARGE_ATTEMPT_PREFIX}${input.page}`;
  const remotePageOversizeAttemptKey =
    `${SEARCH_REMOTE_PAGE_OVERSIZE_ATTEMPT_PREFIX}${input.page}`;
  const noProgress =
    !remotePageOversize &&
    !snapshotTooLarge &&
    resumingPartialPage &&
    pageEmissionTruncated &&
    observations.length === 0;
  const attemptCounts = { ...(plan.checkpoint?.attemptCounts ?? {}) };
  if (noProgress) {
    attemptCounts[noProgressAttemptKey] =
      (attemptCounts[noProgressAttemptKey] ?? 0) + 1;
  } else {
    delete attemptCounts[noProgressAttemptKey];
  }
  if (snapshotTooLarge) {
    attemptCounts[snapshotTooLargeAttemptKey] =
      (attemptCounts[snapshotTooLargeAttemptKey] ?? 0) + 1;
  } else {
    delete attemptCounts[snapshotTooLargeAttemptKey];
  }
  if (remotePageOversize) {
    attemptCounts[remotePageOversizeAttemptKey] =
      (attemptCounts[remotePageOversizeAttemptKey] ?? 0) + 1;
  } else {
    delete attemptCounts[remotePageOversizeAttemptKey];
  }
  const noProgressAttempts = attemptCounts[noProgressAttemptKey] ?? 0;
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
        ...(pendingItems === undefined || pendingItems.length === 0
          ? {}
          : { pendingItems }),
        attemptCounts,
        updatedAt: completedAt,
      }
    : undefined;
  const warnings: CollectionWarning[] = [];
  if (pageEmissionTruncated) {
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
      message:
        `Search page ${input.page} changed while resuming; unresolved pending offers remain in the checkpoint.`,
      details: {
        page: input.page,
        missingPendingOfferIds: missingPendingKeys,
        unexpectedOfferIds: [...unexpectedOfferIds].sort(),
        continuationStopped: false,
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
  const partial = shouldCheckpoint;
  const errors: CollectionError[] = remotePageOversize
    ? [
        {
          code: 'SEARCH_REMOTE_PAGE_SIZE_EXCEEDED',
          message:
            `Search page ${input.page} returned more than the fixed ${SEARCH_REMOTE_PAGE_SIZE}-offer transport page.`,
          retryable: true,
          details: {
            page: input.page,
            capturedOffers: input.offers.length,
            remotePageSize: SEARCH_REMOTE_PAGE_SIZE,
          },
        },
      ]
    : snapshotTooLarge
    ? [
        {
          code: 'SEARCH_PAGE_CHECKPOINT_TOO_LARGE',
          message:
            `Search page ${input.page} cannot fit its pending-offer snapshot within the checkpoint safety limit.`,
          retryable: true,
          details: {
            page: input.page,
            pendingOffers: rawCreatedPendingItems?.length ?? 0,
            snapshotBytes: createdSnapshotBytes,
            maxPendingOffers: SEARCH_PENDING_ITEMS_LIMIT,
            maxSnapshotBytes: SEARCH_PENDING_ITEMS_MAX_BYTES,
          },
        },
      ]
    : noProgress
    ? [
        {
          code: 'SEARCH_PAGE_CHECKPOINT_NO_PROGRESS',
          message:
            `Search page ${input.page} did not expose any unresolved pending offers.`,
          retryable:
            noProgressAttempts < SEARCH_NO_PROGRESS_ATTEMPT_LIMIT,
          details: {
            page: input.page,
            attempt: noProgressAttempts,
            maxAttempts: SEARCH_NO_PROGRESS_ATTEMPT_LIMIT,
            pendingOffers: pendingKeys.length,
          },
        },
      ]
    : [];

  return {
    schemaVersion: 1,
    batchId: requireNonEmpty(input.batchId, 'batchId'),
    unitId: plan.unit.unitId,
    kind: 'search-page',
    status:
      remotePageOversize || snapshotTooLarge || noProgress
        ? 'failed'
        : partial
          ? 'partial'
          : 'completed',
    startedAt,
    completedAt,
    subject: { ...plan.unit.subject },
    scope: {
      ...(plan.unit.scope ?? {}),
      page: input.page,
      remoteSort: input.remoteSort,
      remotePageSize: SEARCH_REMOTE_PAGE_SIZE,
      remoteHasMore,
    },
    observations,
    completeness: {
      requestedScope,
      state: partial || reachedRemotePageBudget ? 'truncated' : 'complete',
      observedPages: [input.page],
      failedPages:
        remotePageOversize || snapshotTooLarge || noProgress
          ? [input.page]
          : [],
      uniqueItems: seenKeys.length,
    },
    duplicateObservations,
    warnings,
    errors,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    rawEvidenceRefs: input.rawEvidenceRefs ?? [],
    metrics: {
      capturedOffers: input.offers.length,
      snapshotPendingOffers: plan.pendingItems.length,
      uniqueNewOffers: observations.length,
      duplicateOffers: duplicateObservations.length,
      replayedOffers,
      deferredOffers: pendingKeys.length,
      unrecoverablePendingOffers: missingPendingKeys.length,
      emissionLimit,
      remotePageLimit: SEARCH_REMOTE_PAGE_LIMIT,
      noProgressAttempts,
      snapshotBytes: createdSnapshotBytes,
    },
  };
}

export function drainSearchCheckpointSnapshot(
  input: DrainSearchCheckpointSnapshotInput,
): SearchPageBatch {
  const plan = planSearchBatch(input.unit, input.checkpoint);
  const pending = plan.pendingItems[0];
  if (pending === undefined) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Search checkpoint does not contain a pending-offer snapshot to drain.',
    );
  }
  return createSearchPageBatch({
    unit: plan.unit,
    checkpoint: plan.checkpoint,
    batchId: input.batchId,
    page: plan.page,
    remoteSort: pending.remoteSort,
    offers: [],
    hasMore: pending.remoteHasMore,
    startedAt: input.startedAt,
    collectedAt: pending.collectedAt,
    completedAt: input.completedAt,
  });
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

function normalizeSearchPendingItems(
  values: CollectionCheckpoint['pendingItems'],
  expectedPage: number,
): SearchPendingItem[] {
  if (values === undefined) return [];
  if (values.length > SEARCH_PENDING_ITEMS_LIMIT) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      `Search checkpoint pendingItems cannot exceed ${SEARCH_PENDING_ITEMS_LIMIT} entries.`,
      {
        pendingItems: values.length,
        maxPendingItems: SEARCH_PENDING_ITEMS_LIMIT,
      },
    );
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(values), 'utf8');
  if (snapshotBytes > SEARCH_PENDING_ITEMS_MAX_BYTES) {
    throw new CliError(
      2,
      'CHECKPOINT_INCOMPATIBLE',
      'Search checkpoint pendingItems exceeds the snapshot byte limit.',
      {
        snapshotBytes,
        maxSnapshotBytes: SEARCH_PENDING_ITEMS_MAX_BYTES,
      },
    );
  }
  const seenKeys = new Set<string>();
  const seenPageRanks = new Set<number>();
  let sharedMetadata:
    | Pick<
        SearchPendingItem,
        'sourcePage' | 'remoteSort' | 'remoteHasMore' | 'collectedAt'
      >
    | undefined;
  const items = values.map((value, index) => {
    const path = `CollectionCheckpoint.pendingItems[${index}]`;
    assertExactKeys(
      value,
      [
        'snapshotVersion',
        'key',
        'offer',
        'sourcePage',
        'remoteSort',
        'pageRank',
        'rawRank',
        'collectedAt',
        'remoteHasMore',
      ],
      path,
    );
    if (value.snapshotVersion !== 1) {
      throw checkpointError(`${path}.snapshotVersion must be 1.`);
    }
    const key = requireOfferId(value.key, `${path}.key`);
    if (seenKeys.has(key)) {
      throw checkpointError(
        'Search checkpoint pending item keys must be unique.',
        { duplicateKey: key },
      );
    }
    seenKeys.add(key);
    const offer = normalizeSnapshotOffer(value.offer, `${path}.offer`);
    if (offer.offerId !== key) {
      throw checkpointError(
        'Search checkpoint pending item key must match offer.offerId.',
        { key, offerId: offer.offerId },
      );
    }
    const sourcePage = requirePendingPositiveInteger(
      value.sourcePage,
      `${path}.sourcePage`,
    );
    if (sourcePage !== expectedPage) {
      throw checkpointError(
        'Search checkpoint pending items must belong to nextPage.',
        { expectedPage, sourcePage, key },
      );
    }
    const remoteSort =
      value.remoteSort === null
        ? null
        : requirePendingString(value.remoteSort, `${path}.remoteSort`);
    if (typeof value.remoteHasMore !== 'boolean') {
      throw checkpointError(`${path}.remoteHasMore must be a boolean.`);
    }
    const pageRank = requirePendingPositiveInteger(
      value.pageRank,
      `${path}.pageRank`,
    );
    if (pageRank > SEARCH_REMOTE_PAGE_SIZE || seenPageRanks.has(pageRank)) {
      throw checkpointError(
        `Search checkpoint pageRank must be unique and from 1 to ${SEARCH_REMOTE_PAGE_SIZE}.`,
        { pageRank },
      );
    }
    seenPageRanks.add(pageRank);
    const rawRank = requirePendingPositiveInteger(
      value.rawRank,
      `${path}.rawRank`,
    );
    const expectedRawRank =
      (sourcePage - 1) * SEARCH_REMOTE_PAGE_SIZE + pageRank;
    if (rawRank !== expectedRawRank) {
      throw checkpointError(
        'Search checkpoint rawRank does not match sourcePage and pageRank.',
        { rawRank, expectedRawRank, key },
      );
    }
    const itemCollectedAt = requirePendingTimestamp(
      value.collectedAt,
      `${path}.collectedAt`,
    );
    const item: SearchPendingItem = {
      snapshotVersion: 1,
      key,
      offer,
      sourcePage,
      remoteSort,
      pageRank,
      rawRank,
      collectedAt: itemCollectedAt,
      remoteHasMore: value.remoteHasMore,
    };
    const metadata = {
      sourcePage: item.sourcePage,
      remoteSort: item.remoteSort,
      remoteHasMore: item.remoteHasMore,
      collectedAt: item.collectedAt,
    };
    if (sharedMetadata === undefined) {
      sharedMetadata = metadata;
    } else if (
      sharedMetadata.sourcePage !== metadata.sourcePage ||
      sharedMetadata.remoteSort !== metadata.remoteSort ||
      sharedMetadata.remoteHasMore !== metadata.remoteHasMore ||
      sharedMetadata.collectedAt !== metadata.collectedAt
    ) {
      throw checkpointError(
        'Search checkpoint pending items must share page, sort, hasMore, and collectedAt metadata.',
      );
    }
    return item;
  });
  return items.sort((left, right) => left.pageRank - right.pageRank);
}

function normalizeLegacySearchPendingKeys(
  pendingKeys: string[],
  expectedPage: number,
): string[] {
  const sentinelKeys = pendingKeys.filter((key) => /^page:\d+$/u.test(key));
  if (sentinelKeys.length === 0) {
    return pendingKeys.map((offerId, index) =>
      requireOfferId(offerId, `CollectionCheckpoint.pendingKeys[${index}]`)
    );
  }
  if (
    pendingKeys.length === 1 &&
    sentinelKeys[0] === `page:${expectedPage}`
  ) {
    return [];
  }
  throw new CliError(
    2,
    'CHECKPOINT_INCOMPATIBLE',
    'Legacy search page sentinels cannot be mixed with offer IDs or reference another page.',
    {
      expectedSentinel: `page:${expectedPage}`,
      pendingKeys,
    },
  );
}

function normalizeSnapshotOffer(value: unknown, path: string): Offer {
  const record = assertExactKeys(
    value,
    [
      'offerId',
      'title',
      'price',
      'purchase',
      'supplier',
      'location',
      'bizType',
      'verified',
      'tags',
      'serviceTags',
      'productBadges',
      'specHighlights',
      'demand',
      'isP4P',
      'turnover',
      'url',
      'image',
      'images',
    ],
    path,
  );
  const price = assertExactKeys(
    record.price,
    ['text', 'min', 'max'],
    `${path}.price`,
  );
  const purchase = assertExactKeys(
    record.purchase,
    ['priceTiers', 'minimumQuantity', 'onePieceEligible'],
    `${path}.purchase`,
  );
  if (!Array.isArray(purchase.priceTiers)) {
    throw checkpointError(`${path}.purchase.priceTiers must be an array.`);
  }
  const priceTiers = purchase.priceTiers.map((value, index) => {
    const tier = assertExactKeys(
      value,
      ['quantityText', 'minimumQuantity', 'price'],
      `${path}.purchase.priceTiers[${index}]`,
    );
    return {
      quantityText: requireNullableString(
        tier.quantityText,
        `${path}.purchase.priceTiers[${index}].quantityText`,
      ),
      minimumQuantity: requireNullableFiniteNumber(
        tier.minimumQuantity,
        `${path}.purchase.priceTiers[${index}].minimumQuantity`,
      ),
      price: requireNullableFiniteNumber(
        tier.price,
        `${path}.purchase.priceTiers[${index}].price`,
      ),
    };
  });
  const supplier = assertExactKeys(
    record.supplier,
    [
      'name',
      'loginId',
      'memberId',
      'shopUrl',
      'years',
      'badgeImageUrl',
      'tradeService',
    ],
    `${path}.supplier`,
  );
  const tradeService = assertExactKeys(
    supplier.tradeService,
    [
      'compositeScore',
      'consultationScore',
      'logisticsScore',
      'disputeScore',
      'returnScore',
      'goodsScore',
      'inspectionCreditUrl',
      'sameDesignUrl',
    ],
    `${path}.supplier.tradeService`,
  );
  const location = assertExactKeys(
    record.location,
    ['province', 'city'],
    `${path}.location`,
  );
  const verified = assertExactKeys(
    record.verified,
    ['factory', 'business', 'superFactory'],
    `${path}.verified`,
  );
  const demand =
    record.demand === undefined
      ? undefined
      : normalizeSnapshotDemand(record.demand, `${path}.demand`);

  return {
    offerId: requireOfferId(record.offerId, `${path}.offerId`),
    title: requireStringValue(record.title, `${path}.title`),
    price: {
      text: requireStringValue(price.text, `${path}.price.text`),
      min: requireNullableFiniteNumber(price.min, `${path}.price.min`),
      max: requireNullableFiniteNumber(price.max, `${path}.price.max`),
    },
    purchase: {
      priceTiers,
      minimumQuantity: requireNullableFiniteNumber(
        purchase.minimumQuantity,
        `${path}.purchase.minimumQuantity`,
      ),
      onePieceEligible: requireNullableBoolean(
        purchase.onePieceEligible,
        `${path}.purchase.onePieceEligible`,
      ),
    },
    supplier: {
      name: requireNullableString(supplier.name, `${path}.supplier.name`),
      loginId: requireNullableString(
        supplier.loginId,
        `${path}.supplier.loginId`,
      ),
      memberId: requireNullableString(
        supplier.memberId,
        `${path}.supplier.memberId`,
      ),
      shopUrl: requireNullableString(
        supplier.shopUrl,
        `${path}.supplier.shopUrl`,
      ),
      years: requireNullableFiniteNumber(
        supplier.years,
        `${path}.supplier.years`,
      ),
      badgeImageUrl: requireNullableString(
        supplier.badgeImageUrl,
        `${path}.supplier.badgeImageUrl`,
      ),
      tradeService: {
        compositeScore: requireNullableFiniteNumber(
          tradeService.compositeScore,
          `${path}.supplier.tradeService.compositeScore`,
        ),
        consultationScore: requireNullableFiniteNumber(
          tradeService.consultationScore,
          `${path}.supplier.tradeService.consultationScore`,
        ),
        logisticsScore: requireNullableFiniteNumber(
          tradeService.logisticsScore,
          `${path}.supplier.tradeService.logisticsScore`,
        ),
        disputeScore: requireNullableFiniteNumber(
          tradeService.disputeScore,
          `${path}.supplier.tradeService.disputeScore`,
        ),
        returnScore: requireNullableFiniteNumber(
          tradeService.returnScore,
          `${path}.supplier.tradeService.returnScore`,
        ),
        goodsScore: requireNullableFiniteNumber(
          tradeService.goodsScore,
          `${path}.supplier.tradeService.goodsScore`,
        ),
        inspectionCreditUrl: requireNullableString(
          tradeService.inspectionCreditUrl,
          `${path}.supplier.tradeService.inspectionCreditUrl`,
        ),
        sameDesignUrl: requireNullableString(
          tradeService.sameDesignUrl,
          `${path}.supplier.tradeService.sameDesignUrl`,
        ),
      },
    },
    location: {
      province: requireNullableString(
        location.province,
        `${path}.location.province`,
      ),
      city: requireNullableString(location.city, `${path}.location.city`),
    },
    bizType: requireNullableString(record.bizType, `${path}.bizType`),
    verified: {
      factory: requireBoolean(verified.factory, `${path}.verified.factory`),
      business: requireBoolean(verified.business, `${path}.verified.business`),
      superFactory: requireBoolean(
        verified.superFactory,
        `${path}.verified.superFactory`,
      ),
    },
    tags: requireStringArray(record.tags, `${path}.tags`),
    ...(record.serviceTags === undefined
      ? {}
      : {
          serviceTags: requireStringArray(
            record.serviceTags,
            `${path}.serviceTags`,
          ),
        }),
    ...(record.productBadges === undefined
      ? {}
      : {
          productBadges: requireStringArray(
            record.productBadges,
            `${path}.productBadges`,
          ),
        }),
    ...(record.specHighlights === undefined
      ? {}
      : {
          specHighlights: requireStringArray(
            record.specHighlights,
            `${path}.specHighlights`,
          ),
        }),
    ...(demand === undefined ? {} : { demand }),
    isP4P: requireBoolean(record.isP4P, `${path}.isP4P`),
    turnover: requireNullableString(record.turnover, `${path}.turnover`),
    url: requireStringValue(record.url, `${path}.url`),
    image: requireNullableString(record.image, `${path}.image`),
    images: requireStringArray(record.images, `${path}.images`),
  };
}

function normalizeSnapshotDemand(
  value: unknown,
  path: string,
): NonNullable<Offer['demand']> {
  const record = assertExactKeys(
    value,
    [
      'orderCountText',
      'orderCount',
      'repurchaseRateText',
      'repurchaseRate',
      'soldCountText',
      'soldCount',
      'shopReturnRateText',
      'shopReturnRate',
    ],
    path,
  );
  return {
    orderCountText: requireNullableString(
      record.orderCountText,
      `${path}.orderCountText`,
    ),
    orderCount: requireNullableFiniteNumber(
      record.orderCount,
      `${path}.orderCount`,
    ),
    repurchaseRateText: requireNullableString(
      record.repurchaseRateText,
      `${path}.repurchaseRateText`,
    ),
    repurchaseRate: requireNullableFiniteNumber(
      record.repurchaseRate,
      `${path}.repurchaseRate`,
    ),
    soldCountText: requireNullableString(
      record.soldCountText,
      `${path}.soldCountText`,
    ),
    soldCount: requireNullableFiniteNumber(
      record.soldCount,
      `${path}.soldCount`,
    ),
    shopReturnRateText: requireNullableString(
      record.shopReturnRateText,
      `${path}.shopReturnRateText`,
    ),
    shopReturnRate: requireNullableFiniteNumber(
      record.shopReturnRate,
      `${path}.shopReturnRate`,
    ),
  };
}

function toSearchPendingItem(candidate: {
  offer: Offer;
  pageRank: number;
  rawRank: number;
  collectedAt: string;
  remoteSort: string | null;
  remoteHasMore: boolean;
}): SearchPendingItem {
  return {
    snapshotVersion: 1,
    key: candidate.offer.offerId,
    offer: normalizeSnapshotOffer(candidate.offer, 'Search pending offer'),
    sourcePage: Math.floor((candidate.rawRank - 1) / SEARCH_REMOTE_PAGE_SIZE) + 1,
    remoteSort: candidate.remoteSort,
    pageRank: candidate.pageRank,
    rawRank: candidate.rawRank,
    collectedAt: candidate.collectedAt,
    remoteHasMore: candidate.remoteHasMore,
  };
}

function assertExactKeys(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  const record = requirePendingRecord(value, path);
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    const sensitiveKeys = unknownKeys.filter((key) =>
      /(auth|cookie|password|session|sign|token)/iu.test(key)
    );
    throw checkpointError(
      sensitiveKeys.length > 0
        ? `${path} contains forbidden sensitive metadata.`
        : `${path} contains unknown fields.`,
      {
        unknownKeys,
        ...(sensitiveKeys.length === 0 ? {} : { sensitiveKeys }),
      },
    );
  }
  return record;
}

function requirePendingRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw checkpointError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkpointError(
  message: string,
  details?: Record<string, unknown>,
): CliError {
  return new CliError(
    2,
    'CHECKPOINT_INCOMPATIBLE',
    message,
    details,
  );
}

function requireOfferId(value: unknown, path: string): string {
  const offerId = requirePendingString(value, path);
  if (!/^\d+$/u.test(offerId)) {
    throw checkpointError(`${path} must contain only digits.`);
  }
  return offerId;
}

function requirePendingString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw checkpointError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireStringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw checkpointError(`${path} must be a string.`);
  }
  return value;
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requireStringValue(value, path);
}

function requireNullableFiniteNumber(
  value: unknown,
  path: string,
): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw checkpointError(`${path} must be a finite number or null.`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw checkpointError(`${path} must be a boolean.`);
  }
  return value;
}

function requireNullableBoolean(
  value: unknown,
  path: string,
): boolean | null {
  if (value === null) return null;
  return requireBoolean(value, path);
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw checkpointError(`${path} must be an array of strings.`);
  }
  return value.map((item, index) =>
    requireStringValue(item, `${path}[${index}]`)
  );
}

function requirePendingPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw checkpointError(`${path} must be a positive integer.`);
  }
  return value as number;
}

function requirePendingTimestamp(value: unknown, path: string): string {
  const text = requirePendingString(value, path);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    throw checkpointError(`${path} must be an ISO timestamp.`);
  }
  return new Date(time).toISOString();
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
