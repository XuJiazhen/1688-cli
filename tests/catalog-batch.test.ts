import { describe, expect, it } from 'vitest';
import type { CollectionUnit } from '../src/collection/contracts.js';
import {
  executeCatalogBatch,
  type CatalogPageAdapter,
} from '../src/collection/catalog-batch.js';
import type { StoreCatalogParseResult } from '../src/session/alisite-module.js';
import { CliError } from '../src/io/errors.js';

function unit(overrides: Partial<CollectionUnit> = {}): CollectionUnit {
  return {
    schemaVersion: 1,
    unitId: 'catalog-unit-1',
    kind: 'store-catalog',
    subject: { supplier: { memberId: 'b2b-fixture-supplier' } },
    scope: {
      requestedScope: 'bounded-pages',
      pageSize: 2,
      maxPagesPerBatch: 2,
      categoryId: 'category-1',
      storeKeyword: '帐篷',
      sort: 'tradenumdown',
    },
    ...overrides,
  };
}

function offerPage(
  page: number,
  offerIds: string[],
  options: { offerCount?: number; totalPages?: number } = {},
): StoreCatalogParseResult {
  const offerCount = options.offerCount ?? 4;
  return {
    kind: 'offer-list',
    offerCount,
    totalPages: options.totalPages ?? Math.ceil(offerCount / 2),
    offers: offerIds.map((offerId, index) => ({
      offerId,
      memberId: 'b2b-fixture-supplier',
      title: `offer-${offerId}`,
      url: `https://detail.1688.com/offer/${offerId}.html`,
      imageUrl: null,
      categoryId: 'category-1',
      price: '10.00',
      quantityBegin: '2',
      unit: '件',
      pagePosition: index + 1,
      absolutePosition: (page - 1) * 2 + index + 1,
      sales: {
        vagueSaleQuantity: null,
        thirtySaleQuantity: null,
        bookedCount: null,
        ninetySaleQuantity: null,
        saleQuantity: null,
        modelBookedCount: null,
        modelAgentBookedCount: null,
        modelQuantitySumMonth: null,
        modelSaleQuantity: null,
      },
    })),
    categories: [],
    userDefined: { raw: null, value: null, state: 'missing' },
    page: {
      memberId: 'b2b-fixture-supplier',
      pageNum: page,
      pageSize: 2,
      categoryId: 'category-1',
      keyword: '帐篷',
      sortType: 'tradenumdown',
    },
    warnings: [],
  };
}

function categoryPage(): StoreCatalogParseResult {
  return {
    kind: 'categories',
    offerCount: null,
    totalPages: null,
    offers: [],
    categories: [
      {
        id: 'outdoor',
        name: '户外',
        fullName: '户外用品',
        count: 3,
        children: [
          {
            id: 'tent',
            name: '帐篷',
            fullName: '户外用品 > 帐篷',
            count: 2,
            children: [],
          },
        ],
      },
    ],
    userDefined: { raw: 'true', value: true, state: 'parsed' },
    page: { memberId: 'b2b-fixture-supplier' },
    warnings: [],
  };
}

describe('executeCatalogBatch', () => {
  it('collects a bounded catalog batch and preserves the effective store query metadata', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const adapter: CatalogPageAdapter = {
      async collectPage(request) {
        requests.push(request);
        return offerPage(
          request.page,
          request.page === 1 ? ['101', '102'] : ['103', '104'],
        );
      },
    };

    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter,
      batchId: 'batch-1',
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(requests).toEqual([
      expect.objectContaining({
        page: 1,
        pageSize: 2,
        categoryId: 'category-1',
        storeKeyword: '帐篷',
        sort: 'tradenumdown',
      }),
      expect.objectContaining({ page: 2 }),
    ]);
    expect(batch).toMatchObject({
      schemaVersion: 1,
      batchId: 'batch-1',
      unitId: 'catalog-unit-1',
      kind: 'store-catalog',
      status: 'completed',
      scope: {
        categoryId: 'category-1',
        storeKeyword: '帐篷',
        sort: 'tradenumdown',
      },
      completeness: {
        requestedScope: 'bounded-pages',
        state: 'complete',
        observedPages: [1, 2],
        failedPages: [],
        expectedItems: 4,
        uniqueItems: 4,
      },
      metrics: {
        requestedPages: 2,
        successfulPages: 2,
        failedPages: 0,
        uniqueItems: 4,
      },
    });
    expect(batch.observations.map((item) => item.offerId)).toEqual([
      '101',
      '102',
      '103',
      '104',
    ]);
    expect(batch.observations[0]).toMatchObject({
      source: {
        page: 1,
        requestedPage: 1,
        pageSize: 2,
        offerCount: 4,
        totalPages: 2,
        categoryId: 'category-1',
        storeKeyword: '帐篷',
        sort: 'tradenumdown',
      },
      collectedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(batch.checkpoint).toBeUndefined();
  });

  it('deduplicates offers, warns on count drift, and checkpoints a truncated catalog', async () => {
    const adapter: CatalogPageAdapter = {
      async collectPage(request) {
        return request.page === 1
          ? offerPage(1, ['101', '102'], { offerCount: 4, totalPages: 2 })
          : offerPage(2, ['102', '103'], { offerCount: 5, totalPages: 3 });
      },
    };

    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter,
      batchId: 'batch-drift',
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.status).toBe('partial');
    expect(batch.observations.map((item) => item.offerId)).toEqual([
      '101',
      '102',
      '103',
    ]);
    expect(batch.duplicateObservations).toEqual([
      {
        key: '102',
        firstSource: 'page:1#position:2',
        duplicateSource: 'page:2#position:1',
      },
    ]);
    expect(batch.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OFFER_COUNT_DRIFT' }),
        expect.objectContaining({ code: 'TOTAL_PAGES_DRIFT' }),
      ]),
    );
    expect(batch.completeness).toMatchObject({
      state: 'truncated',
      observedPages: [1, 2],
      expectedItems: 4,
      uniqueItems: 3,
    });
    expect(batch.checkpoint).toMatchObject({
      schemaVersion: 1,
      kind: 'store-catalog',
      nextPage: 3,
      completedPages: [1, 2],
      seenKeys: ['101', '102', '103'],
      pendingKeys: ['page:3'],
      attemptCounts: { 'page:1': 1, 'page:2': 1 },
    });
  });

  it('resumes at nextPage without counting previously seen offers again', async () => {
    const first = await executeCatalogBatch({
      unit: unit({
        scope: {
          requestedScope: 'full-scan',
          pageSize: 2,
          maxPagesPerBatch: 1,
          sort: 'tradenumdown',
        },
      }),
      adapter: {
        async collectPage() {
          return offerPage(1, ['101', '102']);
        },
      },
      batchId: 'batch-first',
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });
    expect(first.checkpoint?.nextPage).toBe(2);

    const requestedPages: number[] = [];
    const resumed = await executeCatalogBatch({
      unit: unit({
        unitId: 'catalog-unit-resumed',
        scope: {
          requestedScope: 'full-scan',
          pageSize: 2,
          maxPagesPerBatch: 2,
          sort: 'tradenumdown',
        },
      }),
      checkpoint: first.checkpoint,
      adapter: {
        async collectPage(request) {
          requestedPages.push(request.page);
          return offerPage(2, ['102', '103']);
        },
      },
      batchId: 'batch-resumed',
      now: () => new Date('2026-07-22T00:01:00.000Z'),
    });

    expect(requestedPages).toEqual([2]);
    expect(resumed.status).toBe('completed');
    expect(resumed.observations.map((item) => item.offerId)).toEqual(['103']);
    expect(resumed.duplicateObservations).toEqual([
      {
        key: '102',
        firstSource: 'checkpoint:seen:102',
        duplicateSource: 'page:2#position:1',
      },
    ]);
    expect(resumed.completeness).toMatchObject({
      state: 'complete',
      observedPages: [1, 2],
      uniqueItems: 3,
    });
    expect(resumed.warnings).toContainEqual(
      expect.objectContaining({ code: 'OFFER_COUNT_UNIQUE_MISMATCH' }),
    );
    expect(resumed.checkpoint).toBeUndefined();
  });

  it('rejects a checkpoint whose collection fingerprint no longer matches', async () => {
    const first = await executeCatalogBatch({
      unit: unit({
        scope: { requestedScope: 'full-scan', maxPagesPerBatch: 1 },
      }),
      adapter: {
        async collectPage() {
          return offerPage(1, ['101']);
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    await expect(
      executeCatalogBatch({
        unit: unit({
          scope: {
            requestedScope: 'full-scan',
            maxPagesPerBatch: 1,
            categoryId: 'different-category',
          },
        }),
        checkpoint: first.checkpoint,
        adapter: {
          async collectPage() {
            return offerPage(2, ['102']);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' });
  });

  it('returns successful observations with a retryable page error and resume checkpoint', async () => {
    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter: {
        async collectPage(request) {
          if (request.page === 2) {
            throw new Error(
              'fixture network failure https://h5api.m.1688.com/?api=test&sign=secret&data=secret',
            );
          }
          return offerPage(1, ['101', '102']);
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.status).toBe('partial');
    expect(batch.observations.map((item) => item.offerId)).toEqual(['101', '102']);
    expect(batch.errors).toEqual([
      {
        code: 'CATALOG_PAGE_FAILED',
        message:
          'fixture network failure https://h5api.m.1688.com/?api=test&sign=%5Bredacted%5D&data=%5Bredacted%5D',
        retryable: true,
        details: { page: 2 },
      },
    ]);
    expect(batch.completeness).toMatchObject({
      state: 'truncated',
      observedPages: [1],
      failedPages: [2],
      uniqueItems: 2,
    });
    expect(batch.checkpoint).toMatchObject({
      nextPage: 2,
      completedPages: [1],
      pendingKeys: ['page:2'],
      attemptCounts: { 'page:1': 1, 'page:2': 1 },
    });
  });

  it('preserves stable collector error codes and sanitized diagnostics', async () => {
    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter: {
        async collectPage() {
          throw new CliError(
            9,
            'CAPTURE_TIMEOUT',
            'Capture timed out.',
            {
              retryable: true,
              diagnostics: {
                lastSeenUrl:
                  'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&sign=secret&data=private',
              },
            },
          );
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.errors).toEqual([
      {
        code: 'CAPTURE_TIMEOUT',
        message: 'Capture timed out.',
        retryable: true,
        details: {
          page: 1,
          retryable: true,
          diagnostics: {
            lastSeenUrl:
              'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&sign=%5Bredacted%5D&data=%5Bredacted%5D',
          },
        },
      },
    ]);
  });

  it('stops at maxItems without marking a partially emitted page complete', async () => {
    const batch = await executeCatalogBatch({
      unit: unit({
        scope: {
          requestedScope: 'page',
          pageSize: 2,
          maxPagesPerBatch: 2,
        },
        limits: { maxItems: 1 },
      }),
      adapter: {
        async collectPage() {
          return offerPage(1, ['101', '102']);
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.status).toBe('partial');
    expect(batch.observations.map((item) => item.offerId)).toEqual(['101']);
    expect(batch.warnings).toContainEqual(
      expect.objectContaining({ code: 'MAX_ITEMS_REACHED' }),
    );
    expect(batch.completeness).toMatchObject({
      state: 'truncated',
      observedPages: [],
      uniqueItems: 1,
    });
    expect(batch.checkpoint).toMatchObject({
      nextPage: 1,
      completedPages: [],
      seenKeys: ['101'],
      pendingKeys: ['page:1'],
    });
  });

  it('stops before another request when the batch deadline has elapsed', async () => {
    let currentTime = Date.parse('2026-07-22T00:00:00.000Z');
    const requestedPages: number[] = [];
    const batch = await executeCatalogBatch({
      unit: unit({ limits: { deadlineMs: 100 } }),
      adapter: {
        async collectPage(request) {
          requestedPages.push(request.page);
          currentTime += 150;
          return offerPage(1, ['101', '102']);
        },
      },
      now: () => new Date(currentTime),
    });

    expect(requestedPages).toEqual([1]);
    expect(batch.status).toBe('partial');
    expect(batch.warnings).toContainEqual(
      expect.objectContaining({ code: 'DEADLINE_REACHED' }),
    );
    expect(batch.completeness).toMatchObject({
      state: 'truncated',
      observedPages: [1],
    });
    expect(batch.checkpoint?.nextPage).toBe(2);
    expect(batch.metrics.elapsedMs).toBe(150);
  });

  it('collects the category tree and userDefined evidence as one complete snapshot', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const batch = await executeCatalogBatch({
      unit: unit({
        kind: 'store-categories',
        scope: undefined,
      }),
      adapter: {
        async collectPage(request) {
          requests.push(request);
          return categoryPage();
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(requests).toEqual([
      expect.objectContaining({ kind: 'store-categories', page: 1 }),
    ]);
    expect(batch).toMatchObject({
      kind: 'store-categories',
      status: 'completed',
      observations: [
        {
          memberId: 'b2b-fixture-supplier',
          categories: [
            {
              id: 'outdoor',
              children: [{ id: 'tent' }],
            },
          ],
          userDefined: { raw: 'true', value: true, state: 'parsed' },
          collectedAt: '2026-07-22T00:00:00.000Z',
        },
      ],
      completeness: {
        requestedScope: 'page',
        state: 'complete',
        observedPages: [1],
        uniqueItems: 2,
      },
      metrics: { categoryItems: 2 },
    });
    expect(batch.checkpoint).toBeUndefined();
  });

  it('fails deterministically when the adapter returns the wrong parsed module kind', async () => {
    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter: {
        async collectPage() {
          return categoryPage();
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.status).toBe('failed');
    expect(batch.observations).toEqual([]);
    expect(batch.errors).toEqual([
      {
        code: 'CATALOG_RESULT_KIND_MISMATCH',
        message: 'Expected offer-list result for store-catalog, received categories.',
        retryable: false,
        details: { page: 1 },
      },
    ]);
    expect(batch.completeness).toMatchObject({
      state: 'unknown',
      observedPages: [],
      failedPages: [1],
    });
    expect(batch.checkpoint?.nextPage).toBe(1);
  });

  it('turns a risk-control adapter failure into a blocked resumable batch', async () => {
    const batch = await executeCatalogBatch({
      unit: unit(),
      adapter: {
        async collectPage() {
          throw new CliError(4, 'RISK_CONTROL', '请完成滑块验证');
        },
      },
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(batch.status).toBe('blocked');
    expect(batch.actionRequired).toEqual({
      type: 'risk-control',
      message: '请完成滑块验证',
    });
    expect(batch.errors).toEqual([
      {
        code: 'RISK_CONTROL',
        message: '请完成滑块验证',
        retryable: true,
        details: { page: 1 },
      },
    ]);
    expect(batch.checkpoint?.nextPage).toBe(1);
  });
});
