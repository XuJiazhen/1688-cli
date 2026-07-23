import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFixtureCollectionRuntime,
  executeCollectionUnit,
  type CollectionRuntime,
} from '../src/commands/collect.js';
import type { CollectionUnit } from '../src/collection/contracts.js';
import { CliError } from '../src/io/errors.js';
import type { Offer } from '../src/session/search-mtop.js';

const catalogUnit: CollectionUnit = {
  schemaVersion: 1,
  unitId: 'collect-catalog-1',
  kind: 'store-catalog',
  subject: { supplier: { memberId: 'b2b-fixture-supplier' } },
  scope: { requestedScope: 'page', pageSize: 2, maxPagesPerBatch: 1 },
};

describe('collect entry', () => {
  it('executes one versioned unit and validates the returned batch identity', async () => {
    const runtime: CollectionRuntime = {
      async collect(unit) {
        return {
          schemaVersion: 1,
          batchId: 'runtime-batch-1',
          unitId: unit.unitId,
          kind: unit.kind,
          status: 'completed',
          startedAt: '2026-07-22T00:00:00.000Z',
          completedAt: '2026-07-22T00:00:01.000Z',
          subject: unit.subject,
          scope: unit.scope ?? {},
          observations: [],
          completeness: {
            requestedScope: 'page',
            state: 'complete',
            observedPages: [1],
            failedPages: [],
            uniqueItems: 0,
          },
          duplicateObservations: [],
          warnings: [],
          errors: [],
          rawEvidenceRefs: [],
          metrics: {},
        };
      },
    };

    const batch = await executeCollectionUnit({ unit: catalogUnit, runtime });
    expect(batch).toMatchObject({
      schemaVersion: 1,
      unitId: 'collect-catalog-1',
      kind: 'store-catalog',
      status: 'completed',
    });
  });

  it('replays a catalog fixture without launching a browser', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'tests/fixtures/store-catalog/page-1.json'),
        'utf8',
      ),
    );
    const runtime = createFixtureCollectionRuntime({
      pages: [{
        payload,
        request: {
          memberId: 'b2b-fixture-supplier',
          pageNum: 1,
          pageSize: 2,
          sortType: 'wangpu_score',
        },
      }],
    });

    const batch = await executeCollectionUnit({ unit: catalogUnit, runtime });
    expect(batch.status).toBe('completed');
    expect(batch.observations.map((item) => item.offerId)).toEqual([
      '900000000201',
      '900000000202',
    ]);
    expect(batch.rawEvidenceRefs).toEqual(['fixture:catalog:page:1']);
  });

  it('turns login and risk-control interruption into a resumable blocked batch', async () => {
    const runtime: CollectionRuntime = {
      async collect() {
        throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
      },
    };
    const batch = await executeCollectionUnit({ unit: catalogUnit, runtime });
    expect(batch).toMatchObject({
      status: 'blocked',
      actionRequired: { type: 'login' },
      errors: [{ code: 'NOT_LOGGED_IN', retryable: true }],
      checkpoint: {
        kind: 'store-catalog',
        nextPage: 1,
        pendingKeys: ['page:1'],
      },
    });
  });

  it('replays search and media fixtures through the same collection contract', async () => {
    const searchFixture = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'tests/fixtures/search-page/page-1.json'),
        'utf8',
      ),
    );
    const searchUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-search-1',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'bounded-pages', pageSize: 60 },
    };
    const search = await executeCollectionUnit({
      unit: searchUnit,
      runtime: createFixtureCollectionRuntime(searchFixture),
    });
    expect(search).toMatchObject({
      kind: 'search-page',
      status: 'partial',
      checkpoint: { nextPage: 2 },
      rawEvidenceRefs: ['fixture:search-page:1'],
    });
    expect(search.observations[0]).toMatchObject({
      offerId: '900000000101',
      offer: {
        turnover: null,
        supplier: {
          memberId: 'b2b-fixture-supplier',
          shopUrl: 'https://shop-fixture.1688.com/',
        },
      },
    });

    const mediaScript = await readFile(
      path.join(process.cwd(), 'tests/fixtures/offer-media/detail-14.js'),
      'utf8',
    );
    const media = await executeCollectionUnit({
      unit: {
        schemaVersion: 1,
        unitId: 'collect-media-1',
        kind: 'offer-media-manifest',
        subject: { offerId: '900000000001' },
      },
      runtime: createFixtureCollectionRuntime({ mediaScript }),
    });
    expect(media.observations[0]).toMatchObject({
      offerId: '900000000001',
      media: { availability: 'available' },
    });
    expect(
      (media.observations[0]?.media as { items: unknown[] }).items,
    ).toHaveLength(14);
  });

  it('enforces search observation limits through the worker collection entry point', async () => {
    const searchUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-search-bounded',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'bounded-pages', pageSize: 1 },
      limits: { maxItems: 1 },
    };
    const offers = ['910000000101', '910000000102', '910000000103'].map(
      (offerId) => ({
        offerId,
        title: `脱敏帐篷商品 ${offerId}`,
        supplier: {
          memberId: `b2b-${offerId}`,
          shopUrl: `https://shop-${offerId}.1688.com/`,
        },
      }) as Offer,
    );

    const batch = await executeCollectionUnit({
      unit: searchUnit,
      runtime: createFixtureCollectionRuntime({
        searchPage: {
          page: 1,
          offers,
          hasMore: false,
          collectedAt: '2026-07-22T05:00:00Z',
        },
      }),
    });

    expect(batch.observations.map((item) => item.offerId)).toEqual([
      '910000000101',
    ]);
    expect(batch).toMatchObject({
      status: 'partial',
      completeness: { state: 'truncated', uniqueItems: 1 },
      checkpoint: {
        nextPage: 1,
        completedPages: [],
        pendingKeys: ['910000000102', '910000000103'],
      },
    });
  });
});
