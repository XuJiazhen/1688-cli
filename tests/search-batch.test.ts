import { describe, expect, it } from 'vitest';
import type { Offer } from '../src/session/search-mtop.js';
import {
  createSearchPageBatch,
  encodeSearchCursor,
  planSearchBatch,
  SEARCH_PENDING_ITEMS_MAX_BYTES,
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
    price: { text: '', min: null, max: null },
    purchase: {
      priceTiers: [],
      minimumQuantity: null,
      onePieceEligible: null,
    },
    supplier: {
      name: `供应商 ${offerId}`,
      loginId: `supplier-${offerId}`,
      memberId: `b2b-member-${offerId}`,
      shopUrl: `https://supplier-${offerId}.1688.com`,
      years: null,
      badgeImageUrl: null,
      tradeService: {
        compositeScore: null,
        consultationScore: null,
        logisticsScore: null,
        disputeScore: null,
        returnScore: null,
        goodsScore: null,
        inspectionCreditUrl: null,
        sameDesignUrl: null,
      },
    },
    location: { province: null, city: null },
    bizType: null,
    verified: { factory: false, business: false, superFactory: false },
    tags: [],
    demand: {
      orderCountText: null,
      orderCount: null,
      repurchaseRateText: null,
      repurchaseRate: null,
      soldCountText: null,
      soldCount: null,
      shopReturnRateText: null,
      shopReturnRate: null,
    },
    isP4P: false,
    turnover: null,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    image: null,
    images: [],
  };
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
        replayedOffers: 0,
        snapshotPendingOffers: 2,
      },
    });
    expect(third).toMatchObject({
      status: 'completed',
      observations: [{ offerId: '1103', pageRank: 3, rawRank: 3 }],
      completeness: { state: 'complete', uniqueItems: 3 },
      metrics: {
        duplicateOffers: 0,
        replayedOffers: 0,
        snapshotPendingOffers: 1,
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
    const {
      pendingItems: _pendingItems,
      ...legacyCheckpoint
    } = first.checkpoint!;

    const resumed = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint: legacyCheckpoint,
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
      checkpoint: {
        nextPage: 1,
        seenKeys: ['1301', '1303'],
        pendingKeys: ['1302'],
      },
      metrics: {
        duplicateOffers: 0,
        replayedOffers: 1,
        unrecoverablePendingOffers: 1,
      },
    });
    expect(resumed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SEARCH_PAGE_CHECKPOINT_DRIFT',
          details: expect.objectContaining({
            page: 1,
            missingPendingOfferIds: ['1302'],
            unexpectedOfferIds: ['1399'],
            continuationStopped: false,
          }),
        }),
      ]),
    );
  });

  it('keeps the real multi-Profile smoke continuation after a heavily reordered page', () => {
    const smokeUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 5 },
    };
    const firstObserved = ids(
      '1059793092192,1050618667433,805574222044,1042595115533,698001036791',
    );
    const firstPending = ids(
      '1017517651845,1022878215374,1032174187642,1034699612708,1038453495092,1048115652360,1049423193368,1050526083894,1053537678793,1053703633920,1054489452736,1055111801891,1063567234034,537503836738,558018470815,568740007349,641942258251,665852455843,674138684473,674701942797,678763949336,679413061099,679509698575,681161111257,702837406692,708163243317,730201433842,732148977810,753609490289,770638561910,780576424689,797072626463,810369573221,810871651100,826568828766,832792795923,842829114636,846168451914,851346171982,856802594220,858677858958,865786768693,894732834864,896614766018,907437708699,909757696960,923042415603,926322061161,947642264117,950529191981,960413644018,986737179814,991416578049,992101479745,992184809034',
    );
    const presentPending = ids(
      '537503836738,641942258251,674138684473,679509698575,681161111257,708163243317,832792795923,842829114636,846168451914,851346171982,856802594220,858677858958,894732834864,896614766018,923042415603,950529191981,991416578049,992101479745,992184809034',
    );
    const driftArrivals = ids(
      '1026381572284,1048228496600,1050979239419,1054775893600,656133863755,657633531669,681171335287,733045376005,744881883927,756013979185,757776190424,768052791901,775621339563,781593863123,802314882480,814864901362,819529154318,820184139099,823277871281,841183531239,845638069912,852707422381,858080874662,863154072844,891868122849,906507120900,906511600711,907401488181,915565524031,927337168405,927365333459,930112399410,941462842909,941557357152,950873473568,978004114888',
    );
    const first = createSearchPageBatch({
      unit: smokeUnit,
      batchId: 'smoke-search-first',
      page: 1,
      remoteSort: null,
      offers: [...firstObserved, ...firstPending].map(offer),
      hasMore: true,
      startedAt: '2026-07-24T06:00:58Z',
      collectedAt: '2026-07-24T06:00:59.006Z',
      completedAt: '2026-07-24T06:00:59.007Z',
    });
    const {
      pendingItems: _pendingItems,
      ...legacyCheckpoint
    } = first.checkpoint!;
    const resumed = createSearchPageBatch({
      unit: smokeUnit,
      checkpoint: legacyCheckpoint,
      batchId: 'smoke-search-second',
      page: 1,
      remoteSort: null,
      offers: [...firstObserved, ...presentPending, ...driftArrivals].map(offer),
      hasMore: true,
      startedAt: '2026-07-24T06:01:07Z',
      collectedAt: '2026-07-24T06:01:08.023Z',
      completedAt: '2026-07-24T06:01:08.024Z',
    });

    expect(first).toMatchObject({
      status: 'partial',
      checkpoint: { nextPage: 1, pendingKeys: expect.any(Array) },
    });
    expect(first.checkpoint?.pendingKeys).toHaveLength(55);
    expect(resumed).toMatchObject({
      status: 'partial',
      errors: [],
      checkpoint: {
        nextPage: 1,
        pendingKeys: expect.any(Array),
      },
    });
    expect(resumed.observations).toHaveLength(5);
    expect(resumed.checkpoint?.pendingKeys).toHaveLength(50);
  });

  it('drains a captured page snapshot without reloading a reordered remote page', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-snapshot-1',
      page: 1,
      remoteSort: null,
      offers: [offer('1401'), offer('1402'), offer('1403')],
      hasMore: false,
      startedAt: '2026-07-22T02:27:00Z',
      collectedAt: '2026-07-22T02:27:01Z',
      completedAt: '2026-07-22T02:27:02Z',
    });
    const resumed = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint: first.checkpoint,
      batchId: 'batch-snapshot-2',
      page: 1,
      remoteSort: null,
      offers: [offer('1401'), offer('1499')],
      hasMore: false,
      startedAt: '2026-07-22T02:28:00Z',
      collectedAt: '2026-07-22T02:28:01Z',
      completedAt: '2026-07-22T02:28:02Z',
    });

    expect(resumed).toMatchObject({
      status: 'partial',
      observations: [{ offerId: '1402', pageRank: 2, rawRank: 2 }],
      checkpoint: {
        pendingKeys: ['1403'],
        pendingItems: [{ key: '1403' }],
      },
      metrics: {
        snapshotPendingOffers: 2,
        noProgressAttempts: 0,
      },
    });
    expect(resumed.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SEARCH_PAGE_CHECKPOINT_DRIFT' }),
      ]),
    );
  });

  it('drains all 60 captured offers in bounded chunks before advancing the page', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 5 },
    };
    const remotePage = Array.from({ length: 60 }, (_, index) =>
      offer(String(1600 + index)),
    );
    const batches = [
      createSearchPageBatch({
        unit: boundedUnit,
        batchId: 'batch-drain-1',
        page: 1,
        remoteSort: null,
        offers: remotePage,
        hasMore: true,
        startedAt: '2026-07-22T02:40:00Z',
        collectedAt: '2026-07-22T02:40:01Z',
        completedAt: '2026-07-22T02:40:02Z',
      }),
    ];

    while (batches.at(-1)?.checkpoint?.nextPage === 1) {
      const attempt = batches.length + 1;
      const checkpoint = batches.at(-1)!.checkpoint;
      const batch = createSearchPageBatch({
        unit: boundedUnit,
        checkpoint,
        batchId: `batch-drain-${attempt}`,
        page: 1,
        remoteSort: null,
        offers: [],
        hasMore: true,
        startedAt: `2026-07-22T02:${40 + attempt}:00Z`,
        collectedAt: `2026-07-22T02:${40 + attempt}:01Z`,
        completedAt: `2026-07-22T02:${40 + attempt}:02Z`,
      });
      batches.push(batch);
    }

    expect(batches).toHaveLength(12);
    expect(batches.flatMap((batch) =>
      batch.observations.map((item) => item.offerId)
    )).toEqual(remotePage.map((item) => item.offerId));
    expect(batches.every((batch) =>
      batch.status === 'partial' && batch.checkpoint !== undefined
    )).toBe(true);
    expect(batches.at(-1)).toMatchObject({
      completeness: { uniqueItems: 60 },
      checkpoint: {
        nextPage: 2,
        completedPages: [1],
        pendingKeys: [],
      },
    });
  });

  it('migrates the historical search page sentinel without treating it as an offer', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-legacy-sentinel-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1701'), offer('1702'), offer('1703')],
      hasMore: false,
      startedAt: '2026-07-22T02:50:00Z',
      collectedAt: '2026-07-22T02:50:01Z',
      completedAt: '2026-07-22T02:50:02Z',
    });
    const checkpoint = {
      ...first.checkpoint!,
      pendingKeys: ['page:1'],
      pendingItems: undefined,
    };

    const resumed = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint,
      batchId: 'batch-legacy-sentinel-resume',
      page: 1,
      remoteSort: null,
      offers: [offer('1701'), offer('1702'), offer('1703')],
      hasMore: false,
      startedAt: '2026-07-22T02:51:00Z',
      collectedAt: '2026-07-22T02:51:01Z',
      completedAt: '2026-07-22T02:51:02Z',
    });

    expect(resumed).toMatchObject({
      status: 'partial',
      observations: [{ offerId: '1702' }],
      checkpoint: {
        pendingKeys: ['1703'],
        pendingItems: [{ snapshotVersion: 1, key: '1703' }],
      },
    });
    expect(resumed.errors).toEqual([]);
  });

  it.each([
    ['mixed offer and page keys', ['page:1', '1702']],
    ['a sentinel for the wrong page', ['page:2']],
  ])('rejects %s in a historical search checkpoint', (_label, pendingKeys) => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-invalid-sentinel-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1701'), offer('1702')],
      hasMore: false,
      startedAt: '2026-07-22T02:52:00Z',
      collectedAt: '2026-07-22T02:52:01Z',
      completedAt: '2026-07-22T02:52:02Z',
    });

    expect(() =>
      planSearchBatch(boundedUnit, {
        ...first.checkpoint!,
        pendingKeys,
        pendingItems: undefined,
      })
    ).toThrow(/sentinels cannot be mixed|another page/i);
  });

  it('accepts a representative live-size snapshot above 128 KiB on stdin-safe checkpoints', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 5 },
    };
    const remotePage = Array.from({ length: 60 }, (_, index) => ({
      ...offer(String(1800 + index)),
      title: `${String(index).padStart(2, '0')}-${'帐篷'.repeat(350)}`,
    }));
    const batch = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-live-size-snapshot',
      page: 1,
      remoteSort: 'va_sales_amount_desc',
      offers: remotePage,
      hasMore: true,
      startedAt: '2026-07-22T02:53:00Z',
      collectedAt: '2026-07-22T02:53:01Z',
      completedAt: '2026-07-22T02:53:02Z',
    });
    const snapshotBytes = Buffer.byteLength(
      JSON.stringify(batch.checkpoint?.pendingItems),
      'utf8',
    );

    expect(snapshotBytes).toBeGreaterThan(128 * 1024);
    expect(snapshotBytes).toBeLessThan(SEARCH_PENDING_ITEMS_MAX_BYTES);
    expect(planSearchBatch(boundedUnit, batch.checkpoint).pendingItems)
      .toHaveLength(55);
  });

  it('returns an explicit retryable failure when a new snapshot exceeds its byte limit', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const remotePage = Array.from({ length: 60 }, (_, index) => ({
      ...offer(String(1900 + index)),
      title: '帐篷'.repeat(2_000),
    }));
    const batch = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-oversize-snapshot',
      page: 1,
      remoteSort: null,
      offers: remotePage,
      hasMore: true,
      startedAt: '2026-07-22T02:54:00Z',
      collectedAt: '2026-07-22T02:54:01Z',
      completedAt: '2026-07-22T02:54:02Z',
    });

    expect(batch).toMatchObject({
      status: 'failed',
      observations: [],
      completeness: { state: 'truncated', failedPages: [1], uniqueItems: 0 },
      errors: [{
        code: 'SEARCH_PAGE_CHECKPOINT_TOO_LARGE',
        retryable: true,
        details: {
          page: 1,
          maxPendingOffers: 60,
          maxSnapshotBytes: SEARCH_PENDING_ITEMS_MAX_BYTES,
        },
      }],
      checkpoint: {
        nextPage: 1,
        seenKeys: [],
        pendingKeys: expect.any(Array),
      },
    });
    expect(batch.checkpoint?.pendingKeys).toHaveLength(60);
    expect(batch.checkpoint?.pendingItems).toBeUndefined();
  });

  it('rejects a 61-offer remote page with a retryable, readable key-only checkpoint', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 5 },
    };
    const remotePage = Array.from({ length: 61 }, (_, index) =>
      offer(String(2200 + index)),
    );
    const batch = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-remote-page-oversize',
      page: 1,
      remoteSort: null,
      offers: remotePage,
      hasMore: true,
      startedAt: '2026-07-22T02:54:10Z',
      collectedAt: '2026-07-22T02:54:11Z',
      completedAt: '2026-07-22T02:54:12Z',
    });

    expect(batch).toMatchObject({
      status: 'failed',
      observations: [],
      completeness: {
        state: 'truncated',
        failedPages: [1],
        uniqueItems: 0,
      },
      errors: [{
        code: 'SEARCH_REMOTE_PAGE_SIZE_EXCEEDED',
        retryable: true,
        details: {
          page: 1,
          capturedOffers: 61,
          remotePageSize: 60,
        },
      }],
      checkpoint: {
        nextPage: 1,
        seenKeys: [],
        pendingKeys: expect.any(Array),
      },
    });
    expect(batch.checkpoint?.pendingKeys).toHaveLength(61);
    expect(batch.checkpoint?.pendingItems).toBeUndefined();
    expect(planSearchBatch(boundedUnit, batch.checkpoint)).toMatchObject({
      page: 1,
      pendingOfferIds: batch.checkpoint?.pendingKeys,
      pendingItems: [],
    });
  });

  it('rejects an oversized restored snapshot before it can be emitted', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-malicious-size-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1951'), offer('1952')],
      hasMore: false,
      startedAt: '2026-07-22T02:55:00Z',
      collectedAt: '2026-07-22T02:55:01Z',
      completedAt: '2026-07-22T02:55:02Z',
    });
    const checkpoint = structuredClone(first.checkpoint!);
    checkpoint.pendingItems![0]!.offer = {
      ...(checkpoint.pendingItems![0]!.offer as Record<string, unknown>),
      title: 'x'.repeat(SEARCH_PENDING_ITEMS_MAX_BYTES),
    };

    expect(() => planSearchBatch(boundedUnit, checkpoint))
      .toThrow(/snapshot byte limit/i);
  });

  it('rejects a restored snapshot with more than one remote page of items', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-malicious-count-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1953'), offer('1954')],
      hasMore: false,
      startedAt: '2026-07-22T02:55:10Z',
      collectedAt: '2026-07-22T02:55:11Z',
      completedAt: '2026-07-22T02:55:12Z',
    });
    const item = first.checkpoint?.pendingItems?.[0]!;
    const pendingItems = Array.from({ length: 61 }, (_, index) => {
      const key = String(3000 + index);
      return {
        ...structuredClone(item),
        key,
        offer: { ...(item.offer as Offer), offerId: key },
      };
    });

    expect(() =>
      planSearchBatch(boundedUnit, {
        ...first.checkpoint!,
        pendingKeys: pendingItems.map(({ key }) => key),
        pendingItems,
      })
    ).toThrow(/cannot exceed 60 entries/i);
  });

  it.each([
    ['unknown cookie metadata', (item: Record<string, unknown>) => {
      (item.offer as Record<string, unknown>).cookie = 'secret';
    }],
    ['a missing title', (item: Record<string, unknown>) => {
      delete (item.offer as Record<string, unknown>).title;
    }],
    ['a missing supplier', (item: Record<string, unknown>) => {
      delete (item.offer as Record<string, unknown>).supplier;
    }],
  ])('rejects %s in a restored pending-offer snapshot', (_label, mutate) => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-malicious-schema-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1961'), offer('1962')],
      hasMore: false,
      startedAt: '2026-07-22T02:56:00Z',
      collectedAt: '2026-07-22T02:56:01Z',
      completedAt: '2026-07-22T02:56:02Z',
    });
    const checkpoint = structuredClone(first.checkpoint!);
    mutate(checkpoint.pendingItems![0]!);

    expect(() => planSearchBatch(boundedUnit, checkpoint))
      .toThrow(/forbidden sensitive metadata|must be a string|must be an object/i);
  });

  it('rejects duplicate ranks and mixed snapshot provenance metadata', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-invalid-provenance-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1971'), offer('1972'), offer('1973')],
      hasMore: false,
      startedAt: '2026-07-22T02:57:00Z',
      collectedAt: '2026-07-22T02:57:01Z',
      completedAt: '2026-07-22T02:57:02Z',
    });
    const duplicateRank = structuredClone(first.checkpoint!);
    duplicateRank.pendingItems![1]!.pageRank =
      duplicateRank.pendingItems![0]!.pageRank;
    const mixedMetadata = structuredClone(first.checkpoint!);
    mixedMetadata.pendingItems![1]!.remoteHasMore = true;

    expect(() => planSearchBatch(boundedUnit, duplicateRank))
      .toThrow(/pageRank must be unique/i);
    expect(() => planSearchBatch(boundedUnit, mixedMetadata))
      .toThrow(/must share page, sort, hasMore, and collectedAt metadata/i);
  });

  it('canonicalizes a restored snapshot by pageRank before draining it', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-swapped-snapshot-source',
      page: 1,
      remoteSort: null,
      offers: [offer('1981'), offer('1982'), offer('1983')],
      hasMore: false,
      startedAt: '2026-07-22T02:58:00Z',
      collectedAt: '2026-07-22T02:58:01Z',
      completedAt: '2026-07-22T02:58:02Z',
    });
    const checkpoint = structuredClone(first.checkpoint!);
    checkpoint.pendingItems = [...checkpoint.pendingItems!].reverse();

    expect(planSearchBatch(boundedUnit, checkpoint).pendingItems.map(
      ({ pageRank }) => pageRank,
    )).toEqual([2, 3]);

    const resumed = createSearchPageBatch({
      unit: boundedUnit,
      checkpoint,
      batchId: 'batch-swapped-snapshot-resume',
      page: 1,
      remoteSort: null,
      offers: [],
      hasMore: false,
      startedAt: '2026-07-22T02:59:00Z',
      collectedAt: '2026-07-22T02:59:01Z',
      completedAt: '2026-07-22T02:59:02Z',
    });
    expect(resumed).toMatchObject({
      observations: [{ offerId: '1982', pageRank: 2, rawRank: 2 }],
      checkpoint: {
        pendingItems: [{ key: '1983', pageRank: 3, rawRank: 3 }],
      },
    });
  });

  it('fails a legacy key-only checkpoint explicitly after bounded no-progress retries', () => {
    const boundedUnit = {
      ...unit,
      scope: { ...unit.scope, pageSize: 1 },
    };
    const first = createSearchPageBatch({
      unit: boundedUnit,
      batchId: 'batch-stalled-1',
      page: 1,
      remoteSort: null,
      offers: [offer('1501'), offer('1502')],
      hasMore: false,
      startedAt: '2026-07-22T02:29:00Z',
      collectedAt: '2026-07-22T02:29:01Z',
      completedAt: '2026-07-22T02:29:02Z',
    });
    const {
      pendingItems: _pendingItems,
      ...legacyCheckpoint
    } = first.checkpoint!;
    let checkpoint = legacyCheckpoint;

    for (const attempt of [1, 2, 3]) {
      const stalled = createSearchPageBatch({
        unit: boundedUnit,
        checkpoint,
        batchId: `batch-stalled-${attempt + 1}`,
        page: 1,
        remoteSort: null,
        offers: [offer('1501'), offer(`159${attempt}`)],
        hasMore: false,
        startedAt: `2026-07-22T02:3${attempt}:00Z`,
        collectedAt: `2026-07-22T02:3${attempt}:01Z`,
        completedAt: `2026-07-22T02:3${attempt}:02Z`,
      });

      expect(stalled).toMatchObject({
        status: 'failed',
        observations: [],
        checkpoint: {
          nextPage: 1,
          pendingKeys: ['1502'],
          attemptCounts: {
            'search-page:no-progress:1': attempt,
          },
        },
        errors: [{
          code: 'SEARCH_PAGE_CHECKPOINT_NO_PROGRESS',
          retryable: attempt < 3,
          details: { attempt, maxAttempts: 3 },
        }],
      });
      checkpoint = stalled.checkpoint!;
    }
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
      status: 'completed',
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

  it('drains a small pageSize snapshot on page 20 before completing truncated', () => {
    const page20Unit = {
      ...unit,
      scope: {
        ...unit.scope,
        cursor: encodeSearchCursor(20),
        pageSize: 5,
      },
    };
    const remotePage = Array.from({ length: 60 }, (_, index) =>
      offer(String(2100 + index)),
    );
    const batches = [
      createSearchPageBatch({
        unit: page20Unit,
        batchId: 'batch-page-20-drain-1',
        page: 20,
        remoteSort: null,
        offers: remotePage,
        hasMore: true,
        startedAt: '2026-07-22T03:10:00Z',
        collectedAt: '2026-07-22T03:10:01Z',
        completedAt: '2026-07-22T03:10:02Z',
      }),
    ];

    while (batches.at(-1)?.checkpoint !== undefined) {
      const attempt = batches.length + 1;
      batches.push(createSearchPageBatch({
        unit: page20Unit,
        checkpoint: batches.at(-1)?.checkpoint,
        batchId: `batch-page-20-drain-${attempt}`,
        page: 20,
        remoteSort: null,
        offers: [],
        hasMore: true,
        startedAt: `2026-07-22T03:${10 + attempt}:00Z`,
        collectedAt: `2026-07-22T03:${10 + attempt}:01Z`,
        completedAt: `2026-07-22T03:${10 + attempt}:02Z`,
      }));
    }

    expect(batches).toHaveLength(12);
    expect(batches.slice(0, -1).every((batch) => batch.status === 'partial'))
      .toBe(true);
    expect(batches.at(-1)).toMatchObject({
      status: 'completed',
      completeness: {
        state: 'truncated',
        uniqueItems: 60,
      },
      warnings: [{ code: 'SEARCH_REMOTE_PAGE_BUDGET_EXHAUSTED' }],
    });
    expect(batches.at(-1)?.checkpoint).toBeUndefined();
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

function ids(value: string): string[] {
  return value.split(',');
}
