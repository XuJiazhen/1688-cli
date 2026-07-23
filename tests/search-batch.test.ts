import { describe, expect, it } from 'vitest';
import type { Offer } from '../src/session/search-mtop.js';
import {
  createSearchPageBatch,
  encodeSearchCursor,
  planSearchBatch,
} from '../src/collection/search-batch.js';

const unit = {
  schemaVersion: 1 as const,
  unitId: 'search-unit-1',
  kind: 'search-page' as const,
  subject: { keyword: '帐篷' },
  scope: {
    requestedScope: 'bounded-pages' as const,
    sort: 'best-selling',
    pageSize: 60,
    maxPagesPerBatch: 1,
  },
};

function offer(offerId: string): Offer {
  return {
    offerId,
    title: `帐篷 ${offerId}`,
    demand: { soldCountText: null, soldCount: null },
    supplier: {
      loginId: `supplier-${offerId}`,
      memberId: `b2b-member-${offerId}`,
      shopUrl: `https://supplier-${offerId}.1688.com`,
    },
  } as Offer;
}

describe('incremental search batches', () => {
  it('plans page 1 explicitly when no checkpoint or cursor was supplied', () => {
    expect(planSearchBatch(unit)).toMatchObject({
      page: 1,
      cursor: null,
      completedPages: [],
      seenOfferIds: [],
    });
  });

  it('starts from an explicit opaque continuation cursor', () => {
    const cursor = encodeSearchCursor(4);

    expect(
      planSearchBatch({
        ...unit,
        scope: { ...unit.scope, cursor },
      }),
    ).toMatchObject({ page: 4, cursor });
  });

  it('returns page provenance and a checkpoint that resumes page 2', () => {
    const sourceOffer = offer('1001');

    const batch = createSearchPageBatch({
      unit,
      batchId: 'batch-page-1',
      page: 1,
      remoteSort: 'va_sales_amount_desc',
      offers: [sourceOffer],
      hasMore: true,
      startedAt: '2026-07-22T01:59:00Z',
      collectedAt: '2026-07-22T02:00:00Z',
      completedAt: '2026-07-22T02:00:01Z',
    });

    expect(batch.observations).toEqual([
      {
        offerId: '1001',
        offer: sourceOffer,
        sourcePage: 1,
        remoteSort: 'va_sales_amount_desc',
        pageRank: 1,
        rawRank: 1,
        collectedAt: '2026-07-22T02:00:00.000Z',
      },
    ]);
    expect(batch.checkpoint).toMatchObject({
      nextPage: 2,
      completedPages: [1],
      seenKeys: ['1001'],
    });
    expect(planSearchBatch(unit, batch.checkpoint)).toMatchObject({
      page: 2,
      completedPages: [1],
      seenOfferIds: ['1001'],
    });
  });

  it('deduplicates offerIds across pages and preserves duplicate observations', () => {
    const first = createSearchPageBatch({
      unit,
      batchId: 'batch-page-1',
      page: 1,
      remoteSort: 'va_sales_amount_desc',
      offers: [offer('1001')],
      hasMore: true,
      startedAt: '2026-07-22T02:00:00Z',
      collectedAt: '2026-07-22T02:00:01Z',
      completedAt: '2026-07-22T02:00:02Z',
    });
    const second = createSearchPageBatch({
      unit,
      checkpoint: first.checkpoint,
      batchId: 'batch-page-2',
      page: 2,
      remoteSort: 'va_sales_amount_desc',
      offers: [offer('1001'), offer('1002'), offer('1002')],
      hasMore: true,
      startedAt: '2026-07-22T02:01:00Z',
      collectedAt: '2026-07-22T02:01:01Z',
      completedAt: '2026-07-22T02:01:02Z',
    });

    expect(second.observations).toHaveLength(1);
    expect(second.observations[0]).toMatchObject({
      offerId: '1002',
      sourcePage: 2,
      pageRank: 2,
      rawRank: 62,
    });
    expect(second.duplicateObservations).toHaveLength(2);
    expect(second.duplicateObservations[0]).toMatchObject({
      key: '1001',
      firstSource: expect.stringContaining('checkpoint'),
      duplicateSource: expect.stringContaining('page=2;rank=61'),
    });
    expect(second.duplicateObservations[1]).toMatchObject({
      key: '1002',
      firstSource: expect.stringContaining('page=2;rank=62'),
      duplicateSource: expect.stringContaining('page=2;rank=63'),
    });
    expect(second.checkpoint).toMatchObject({
      nextPage: 3,
      completedPages: [1, 2],
      seenKeys: ['1001', '1002'],
    });
    expect(second.metrics).toMatchObject({
      capturedOffers: 3,
      uniqueNewOffers: 1,
      duplicateOffers: 2,
    });
  });

  it('emits at most pageSize observations and resumes the un-emitted remote-page offers', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const remotePage = [offer('1101'), offer('1102'), offer('1103')];

    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-page-subset-1',
      page: 1,
      remoteSort: null,
      offers: remotePage,
      hasMore: false,
      startedAt: '2026-07-22T02:10:00Z',
      collectedAt: '2026-07-22T02:10:01Z',
      completedAt: '2026-07-22T02:10:02Z',
    });

    expect(first).toMatchObject({
      status: 'partial',
      observations: [{ offerId: '1101', pageRank: 1, rawRank: 1 }],
      completeness: { state: 'truncated', uniqueItems: 1 },
      checkpoint: {
        nextPage: 1,
        completedPages: [],
        seenKeys: ['1101'],
        pendingKeys: ['1102', '1103'],
      },
      warnings: [{ code: 'SEARCH_PAGE_EMISSION_TRUNCATED' }],
      metrics: {
        capturedOffers: 3,
        uniqueNewOffers: 1,
        deferredOffers: 2,
        emissionLimit: 1,
      },
    });

    const second = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint: first.checkpoint,
      batchId: 'batch-page-subset-2',
      page: 1,
      remoteSort: null,
      offers: remotePage,
      hasMore: false,
      startedAt: '2026-07-22T02:11:00Z',
      collectedAt: '2026-07-22T02:11:01Z',
      completedAt: '2026-07-22T02:11:02Z',
    });
    const third = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint: second.checkpoint,
      batchId: 'batch-page-subset-3',
      page: 1,
      remoteSort: null,
      offers: remotePage,
      hasMore: false,
      startedAt: '2026-07-22T02:12:00Z',
      collectedAt: '2026-07-22T02:12:01Z',
      completedAt: '2026-07-22T02:12:02Z',
    });

    expect(second).toMatchObject({
      status: 'partial',
      observations: [{ offerId: '1102', pageRank: 2, rawRank: 2 }],
      checkpoint: {
        nextPage: 1,
        seenKeys: ['1101', '1102'],
        pendingKeys: ['1103'],
      },
      metrics: {
        duplicateOffers: 0,
        replayedOffers: 1,
      },
    });
    expect(third).toMatchObject({
      status: 'completed',
      observations: [{ offerId: '1103', pageRank: 3, rawRank: 3 }],
      completeness: { state: 'complete', uniqueItems: 3 },
      metrics: {
        duplicateOffers: 0,
        replayedOffers: 2,
      },
    });
    expect(third.checkpoint).toBeUndefined();
  });

  it('uses maxItems as a stricter per-batch observation limit', () => {
    const batch = createSearchPageBatch({
      unit: {
        ...unit,
        limits: { maxItems: 1 },
      },
      batchId: 'batch-max-items',
      page: 1,
      remoteSort: null,
      offers: [offer('1201'), offer('1202')],
      hasMore: true,
      startedAt: '2026-07-22T02:20:00Z',
      collectedAt: '2026-07-22T02:20:01Z',
      completedAt: '2026-07-22T02:20:02Z',
    });

    expect(batch.observations.map((item) => item.offerId)).toEqual(['1201']);
    expect(batch.checkpoint).toMatchObject({
      nextPage: 1,
      pendingKeys: ['1202'],
    });
    expect(batch.metrics).toMatchObject({
      emissionLimit: 1,
      deferredOffers: 1,
    });
  });

  it('preserves missing pending offers and does not substitute page-drift arrivals', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-drift-1',
      page: 1,
      remoteSort: null,
      offers: [offer('1301'), offer('1302'), offer('1303')],
      hasMore: false,
      startedAt: '2026-07-22T02:25:00Z',
      collectedAt: '2026-07-22T02:25:01Z',
      completedAt: '2026-07-22T02:25:02Z',
    });

    const resumed = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint: first.checkpoint,
      batchId: 'batch-drift-2',
      page: 1,
      remoteSort: null,
      offers: [offer('1301'), offer('1303'), offer('1399')],
      hasMore: false,
      startedAt: '2026-07-22T02:26:00Z',
      collectedAt: '2026-07-22T02:26:01Z',
      completedAt: '2026-07-22T02:26:02Z',
    });

    expect(resumed.observations.map((item) => item.offerId)).toEqual(['1303']);
    expect(resumed).toMatchObject({
      status: 'partial',
      completeness: { state: 'truncated' },
      metrics: {
        duplicateOffers: 0,
        replayedOffers: 1,
        unrecoverablePendingOffers: 1,
      },
    });
    expect(resumed.checkpoint).toBeUndefined();
    expect(resumed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SEARCH_PAGE_CHECKPOINT_DRIFT',
          details: expect.objectContaining({
            page: 1,
            missingPendingOfferIds: ['1302'],
            unexpectedOfferIds: ['1399'],
            continuationStopped: true,
          }),
        }),
      ]),
    );
    expect(resumed.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SEARCH_PAGE_EMISSION_TRUNCATED' }),
      ]),
    );
  });

  it('archives remote page-budget exhaustion instead of checkpointing page 21', () => {
    const page20Unit = {
      ...unit,
      scope: {
        ...unit.scope,
        cursor: encodeSearchCursor(20),
      },
    };
    const remotePage = Array.from({ length: 60 }, (_, index) =>
      offer(String(2000 + index)),
    );

    const batch = createSearchPageBatch({
      unit: page20Unit,
      batchId: 'batch-page-20',
      page: 20,
      remoteSort: null,
      offers: remotePage,
      hasMore: true,
      startedAt: '2026-07-22T02:30:00Z',
      collectedAt: '2026-07-22T02:30:01Z',
      completedAt: '2026-07-22T02:30:02Z',
    });

    expect(batch).toMatchObject({
      status: 'partial',
      completeness: {
        requestedScope: 'bounded-pages',
        state: 'truncated',
        observedPages: [20],
        uniqueItems: 60,
      },
      warnings: [
        {
          code: 'SEARCH_REMOTE_PAGE_BUDGET_EXHAUSTED',
          details: {
            page: 20,
            remotePageLimit: 20,
            remoteHasMore: true,
          },
        },
      ],
    });
    expect(batch.observations).toHaveLength(60);
    expect(batch.checkpoint).toBeUndefined();
  });

  it('keeps unknown sales evidence unknown instead of coercing it to zero', () => {
    const unknownSales = {
      ...offer('2001'),
      turnover: null,
      demand: {
        orderCountText: null,
        orderCount: null,
        soldCountText: null,
        soldCount: null,
      },
    } as Offer;

    const batch = createSearchPageBatch({
      unit,
      batchId: 'batch-unknown-sales',
      page: 1,
      remoteSort: null,
      offers: [unknownSales],
      hasMore: false,
      startedAt: '2026-07-22T03:00:00Z',
      collectedAt: '2026-07-22T03:00:01Z',
      completedAt: '2026-07-22T03:00:02Z',
    });

    expect(batch.observations[0]?.offer).toMatchObject({
      turnover: null,
      demand: {
        orderCountText: null,
        orderCount: null,
        soldCountText: null,
        soldCount: null,
      },
    });
    expect(batch).toMatchObject({
      status: 'completed',
      completeness: { state: 'complete' },
    });
    expect(batch.checkpoint).toBeUndefined();
  });

  it('rejects a checkpoint when the keyword or sort fingerprint changes', () => {
    const first = createSearchPageBatch({
      unit,
      batchId: 'batch-page-1',
      page: 1,
      remoteSort: 'va_sales_amount_desc',
      offers: [offer('3001')],
      hasMore: true,
      startedAt: '2026-07-22T04:00:00Z',
      collectedAt: '2026-07-22T04:00:01Z',
      completedAt: '2026-07-22T04:00:02Z',
    });

    expect(() =>
      planSearchBatch(
        { ...unit, scope: { ...unit.scope, sort: 'price-asc' } },
        first.checkpoint,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CHECKPOINT_INCOMPATIBLE' }));
  });
});
