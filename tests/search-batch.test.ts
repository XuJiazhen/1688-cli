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
