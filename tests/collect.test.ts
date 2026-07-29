import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  createFixtureCollectionRuntime,
  createPlaywrightCollectionRuntime,
  collectStoreProfileUnit,
  executeCollectCommand,
  executeCollectionUnit,
  navigateAndResolveQualificationMember,
  parseCollectInput,
  type CollectionRuntime,
} from '../src/commands/collect.js';
import type { CollectionUnit } from '../src/collection/contracts.js';
import { CliError } from '../src/io/errors.js';
import {
  ALISITE_MODULE_API,
  STORE_CATEGORIES_COMPONENT_KEY,
} from '../src/session/alisite-module.js';
import type { Offer } from '../src/session/search-mtop.js';
import { SUPPLIER_QUALIFICATION_COMPONENT_KEY } from '../src/session/supplier-qualification.js';

const catalogUnit: CollectionUnit = {
  schemaVersion: 1,
  unitId: 'collect-catalog-1',
  kind: 'store-catalog',
  subject: { supplier: { memberId: 'b2b-fixture-supplier' } },
  scope: { requestedScope: 'page', pageSize: 2, maxPagesPerBatch: 1 },
};

const storeProfileUnit: CollectionUnit = {
  schemaVersion: 1,
  unitId: 'collect-store-profile-1',
  kind: 'store-profile',
  subject: {
    supplier: {
      memberId: 'b2b-fixture-supplier',
      shopUrl: 'https://fixture-profile.1688.com/',
    },
  },
  scope: { requestedScope: 'page' },
};

function searchOffer(offerId: string): Offer {
  return {
    offerId,
    title: `脱敏帐篷商品 ${offerId}`,
    price: { text: '', min: null, max: null },
    purchase: {
      priceTiers: [],
      minimumQuantity: null,
      onePieceEligible: null,
    },
    supplier: {
      name: null,
      loginId: null,
      memberId: `b2b-${offerId}`,
      shopUrl: `https://shop-${offerId}.1688.com/`,
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
    isP4P: false,
    turnover: null,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    image: null,
    images: [],
  };
}

class QualificationMemberPage extends EventEmitter {
  readonly navigatedUrls: string[] = [];

  constructor(
    private readonly categoryPayload: unknown,
    private readonly resolvedMemberId?: string,
  ) {
    super();
  }

  async goto(url: string): Promise<null> {
    this.navigatedUrls.push(url);
    if (this.resolvedMemberId) {
      this.emit(
        'response',
        qualificationMemberResponse(
          this.categoryPayload,
          this.resolvedMemberId,
        ),
      );
    }
    return null;
  }

  isClosed(): boolean {
    return false;
  }

  url(): string {
    return this.navigatedUrls.at(-1) ?? 'https://fixture-shop.1688.com/';
  }

  async title(): Promise<string> {
    return 'Fixture shop';
  }

  async evaluate(): Promise<string> {
    return '';
  }
}

class QualificationCollectionPage extends EventEmitter {
  requestedMemberId: string | null = null;
  private currentUrl = 'https://fixture-shop.1688.com/';

  constructor(private readonly responseMemberId: string) {
    super();
  }

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Fixture shop';
  }

  isClosed(): boolean {
    return false;
  }

  async waitForFunction(): Promise<void> {}

  async evaluate(
    _pageFunction: unknown,
    runtimeRequest?: unknown,
  ): Promise<string> {
    if (
      runtimeRequest !== null &&
      typeof runtimeRequest === 'object' &&
      'data' in runtimeRequest
    ) {
      const request = runtimeRequest as { data: { params: string } };
      const params = JSON.parse(request.data.params) as { memberId: string };
      this.requestedMemberId = params.memberId;
      this.emit(
        'response',
        qualificationResponse(params.memberId, this.responseMemberId),
      );
    }
    return '';
  }

  async close(): Promise<void> {}
}

class StoreProfileCollectionPage extends EventEmitter {
  runtimeRequestCount = 0;
  private currentUrl = 'https://fixture-profile.1688.com/';

  constructor(
    private readonly payload: unknown,
    private readonly natural: boolean,
    private readonly emitRuntimeResponse = false,
    private readonly rejectRuntimeRequest = false,
  ) {
    super();
  }

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    if (this.natural) {
      this.emit(
        'response',
        storeProfileResponse('b2b-fixture-supplier', this.payload),
      );
    }
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Fixture supplier shop';
  }

  isClosed(): boolean {
    return false;
  }

  async waitForFunction(): Promise<void> {}

  async evaluate(
    _pageFunction: unknown,
    runtimeRequest?: unknown,
  ): Promise<unknown> {
    if (runtimeRequest !== undefined) {
      this.runtimeRequestCount += 1;
      if (this.emitRuntimeResponse) {
        this.emit(
          'response',
          storeProfileResponse('b2b-fixture-supplier', this.payload),
        );
      }
      if (this.rejectRuntimeRequest) {
        throw new Error('fixture runtime Promise rejected');
      }
      return this.payload;
    }
    return 'Fixture supplier shop';
  }

  async close(): Promise<void> {}
}

function qualificationMemberResponse(
  payload: unknown,
  memberId: string,
): PWResponse {
  const data = {
    componentKey: STORE_CATEGORIES_COMPONENT_KEY,
    params: JSON.stringify({ memberId }),
  };
  const url =
    `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
    `?data=${encodeURIComponent(JSON.stringify(data))}`;
  return {
    url: () => url,
    request: () => ({ postData: () => null }),
    text: async () => JSON.stringify(payload),
  } as unknown as PWResponse;
}

function qualificationResponse(
  requestMemberId: string,
  responseMemberId: string,
): PWResponse {
  const data = {
    componentKey: SUPPLIER_QUALIFICATION_COMPONENT_KEY,
    params: JSON.stringify({ memberId: requestMemberId }),
  };
  const url =
    `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
    `?data=${encodeURIComponent(JSON.stringify(data))}`;
  return {
    url: () => url,
    request: () => ({ postData: () => null }),
    text: async () =>
      JSON.stringify({
        data: {
          memberId: responseMemberId,
          businessInfo: {},
          certList: [],
        },
      }),
  } as unknown as PWResponse;
}

function storeProfileResponse(
  memberId: string,
  payload: unknown,
): PWResponse {
  const data = {
    componentKey: 'wp_pc_common_header',
    params: JSON.stringify({
      memberId,
      appdata: { version: '2025V2' },
    }),
  };
  const url =
    `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
    `?data=${encodeURIComponent(JSON.stringify(data))}`;
  return {
    url: () => url,
    request: () => ({ postData: () => null }),
    text: async () => JSON.stringify(payload),
  } as unknown as PWResponse;
}

describe('collect entry', () => {
  it('accepts both the legacy naked unit and the stdin collect envelope', () => {
    const checkpoint = {
      schemaVersion: 1,
      unitFingerprint: `sha256:${'a'.repeat(64)}`,
      kind: 'store-catalog',
      subject: catalogUnit.subject,
      scope: catalogUnit.scope,
      nextPage: 2,
      completedPages: [1],
      seenKeys: ['offer-1'],
      pendingKeys: ['page:2'],
      attemptCounts: { 'page:2': 1 },
      updatedAt: '2026-07-24T00:00:00.000Z',
    };

    expect(parseCollectInput(catalogUnit)).toEqual({ unit: catalogUnit });
    expect(parseCollectInput({ unit: catalogUnit, checkpoint })).toEqual({
      unit: catalogUnit,
      checkpoint,
    });
    expect(parseCollectInput({ unit: catalogUnit }, checkpoint)).toEqual({
      unit: catalogUnit,
      checkpoint,
    });
    expect(() =>
      parseCollectInput({ unit: catalogUnit, checkpoint }, checkpoint),
    ).toThrow(/either the collect envelope or --checkpoint/i);
  });

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

  it('replays a store-profile fixture without launching a browser or inventing location facts', async () => {
    const batch = await executeCollectCommand({
      unit: JSON.stringify(storeProfileUnit),
      fixture: path.join(
        process.cwd(),
        'tests/fixtures/store-profile/basic.json',
      ),
      requestId: 'attempt:store-profile-fixture',
    });

    expect(batch).toMatchObject({
      sourceRequestId: 'attempt:store-profile-fixture',
      kind: 'store-profile',
      status: 'completed',
      observations: [
        {
          name: {
            availability: 'available',
            value: '脱敏电动工具商行',
          },
          region: { availability: 'not-present', value: null },
          address: { availability: 'not-present', value: null },
        },
      ],
    });
    expect(batch.checkpoint).toBeUndefined();
    expect(batch.rawEvidenceRefs).toEqual(['fixture:store-profile']);
  });

  it('collects the natural Store-page common-header response without an active request', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          'tests/fixtures/store-profile/common-header.json',
        ),
        'utf8',
      ),
    );
    const page = new StoreProfileCollectionPage(payload, true);
    const context = {
      newPage: async () => page,
    } as unknown as BrowserContext;

    const batch = await executeCollectionUnit({
      unit: storeProfileUnit,
      runtime: createPlaywrightCollectionRuntime(context, false),
    });

    expect(batch).toMatchObject({
      kind: 'store-profile',
      status: 'completed',
      observations: [
        {
          name: {
            availability: 'available',
            value: '脱敏五金工具有限公司',
          },
          region: {
            availability: 'available',
            value: '浙江省 杭州市',
          },
        },
      ],
    });
    expect(page.runtimeRequestCount).toBe(0);
    expect(page.listenerCount('response')).toBe(0);
    expect(batch.rawEvidenceRefs[0]).toMatch(
      /h5\/mtop\.alibaba\.alisite\.cbu\.server\.moduleasyncservice\/1\.0\//,
    );
  });

  it('falls back to the same Store-page MTOP runtime after natural capture is absent', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          'tests/fixtures/store-profile/common-header.json',
        ),
        'utf8',
      ),
    );
    const page = new StoreProfileCollectionPage(payload, false);
    const context = {
      newPage: async () => page,
    } as unknown as BrowserContext;

    const batch = await collectStoreProfileUnit(
      context,
      storeProfileUnit,
      undefined,
      false,
      {
        naturalCaptureTimeoutMs: 2,
        runtimeCaptureTimeoutMs: 2,
        runtimeReadyTimeoutMs: 5,
        runtimeRequestTimeoutMs: 5,
      },
    );

    expect(batch).toMatchObject({
      kind: 'store-profile',
      status: 'completed',
      observations: [
        {
          name: {
            availability: 'available',
            value: '脱敏五金工具有限公司',
          },
        },
      ],
    });
    expect(page.runtimeRequestCount).toBe(1);
    expect(page.listenerCount('response')).toBe(0);
    expect(batch.rawEvidenceRefs).toEqual([
      'mtop:mtop.alibaba.alisite.cbu.server.moduleasyncservice:wp_pc_common_header',
    ]);
  });

  it('preserves risk-control semantics from a natural store-profile response', async () => {
    const page = new StoreProfileCollectionPage(
      { ret: ['FAIL_SYS_USER_VALIDATE::验证失败'] },
      true,
    );
    const context = {
      newPage: async () => page,
    } as unknown as BrowserContext;

    const batch = await executeCollectionUnit({
      unit: storeProfileUnit,
      runtime: createPlaywrightCollectionRuntime(context, false),
    });

    expect(batch).toMatchObject({
      kind: 'store-profile',
      status: 'blocked',
      actionRequired: { type: 'risk-control' },
      errors: [{ code: 'RISK_CONTROL', retryable: true }],
      checkpoint: {
        nextPage: 1,
        pendingKeys: ['page:1'],
      },
    });
  });

  it('prefers a correlated fallback risk response when the runtime Promise rejects', async () => {
    const page = new StoreProfileCollectionPage(
      { ret: ['FAIL_SYS_USER_VALIDATE::验证失败'] },
      false,
      true,
      true,
    );
    const context = {
      newPage: async () => page,
    } as unknown as BrowserContext;
    const runtime: CollectionRuntime = {
      collect: (unit, checkpoint) =>
        collectStoreProfileUnit(
          context,
          unit,
          checkpoint,
          false,
          {
            naturalCaptureTimeoutMs: 2,
            runtimeCaptureTimeoutMs: 10,
            runtimeReadyTimeoutMs: 5,
            runtimeRequestTimeoutMs: 5,
          },
        ),
    };

    const batch = await executeCollectionUnit({
      unit: storeProfileUnit,
      runtime,
    });

    expect(batch).toMatchObject({
      status: 'blocked',
      errors: [{ code: 'RISK_CONTROL', retryable: true }],
    });
    expect(page.runtimeRequestCount).toBe(1);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('attaches an injected requestId to a fixture batch for correlation', async () => {
    const batch = await executeCollectCommand({
      unit: JSON.stringify(catalogUnit),
      fixture: path.join(
        process.cwd(),
        'tests/fixtures/store-catalog/page-1.json',
      ),
      requestId: 'attempt:fixture-001',
    });

    expect(batch.sourceRequestId).toBe('attempt:fixture-001');
    await expect(
      executeCollectCommand({
        unit: JSON.stringify(catalogUnit),
        fixture: path.join(
          process.cwd(),
          'tests/fixtures/store-catalog/page-1.json',
        ),
        requestId: 'unsafe request id',
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      executeCollectCommand({
        unit: JSON.stringify(catalogUnit),
        fixture: path.join(
          process.cwd(),
          'tests/fixtures/store-catalog/page-1.json',
        ),
        requestId: '..',
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
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

  it('retains redacted qualification capture diagnostics at the batch boundary', async () => {
    const qualificationUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-qualification-timeout',
      kind: 'store-qualification',
      subject: {
        supplier: {
          memberId: 'b2b-fixture-supplier',
          shopUrl: 'https://fixture.1688.com/',
        },
      },
      scope: { requestedScope: 'page' },
    };
    const runtime: CollectionRuntime = {
      async collect() {
        throw new CliError(
          9,
          'QUALIFICATION_RESPONSE_TIMEOUT',
          'Qualification response timed out.',
          {
            retryable: true,
            responseCapture: {
              matchedCount: 1,
              lastMatchedUrl:
                'https://h5api.m.1688.com/h5/qualification?api=test&sign=secret&data=secret',
            },
          },
        );
      },
    };

    const batch = await executeCollectionUnit({
      unit: qualificationUnit,
      runtime,
    });

    expect(batch.errors[0]).toMatchObject({
      code: 'QUALIFICATION_RESPONSE_TIMEOUT',
      retryable: true,
      details: {
        responseCapture: {
          matchedCount: 1,
          lastMatchedUrl:
            'https://h5api.m.1688.com/h5/qualification?api=test&sign=%5Bredacted%5D&data=%5Bredacted%5D',
        },
      },
    });
    expect(JSON.stringify(batch.errors[0])).not.toContain('sign=secret');
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
    const offers = ['910000000101', '910000000102', '910000000103']
      .map(searchOffer);

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

  it('drains a search checkpoint snapshot without touching the browser again', async () => {
    const searchUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-search-snapshot',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'page', pageSize: 1 },
    };
    const offers = ['920000000101', '920000000102', '920000000103']
      .map(searchOffer);
    const first = await executeCollectionUnit({
      unit: searchUnit,
      runtime: createFixtureCollectionRuntime({
        searchPage: {
          page: 1,
          offers,
          hasMore: false,
          collectedAt: '2026-07-24T05:00:00Z',
        },
      }),
    });
    let browserTouched = false;
    const browserContext = new Proxy({}, {
      get() {
        browserTouched = true;
        throw new Error('browser must not be touched while draining a snapshot');
      },
    }) as BrowserContext;

    const resumed = await executeCollectionUnit({
      unit: searchUnit,
      checkpoint: first.checkpoint,
      runtime: createPlaywrightCollectionRuntime(browserContext, false),
    });

    expect(browserTouched).toBe(false);
    expect(resumed).toMatchObject({
      status: 'partial',
      observations: [{ offerId: '920000000102', pageRank: 2 }],
      checkpoint: {
        nextPage: 1,
        pendingKeys: ['920000000103'],
        pendingItems: [{ key: '920000000103' }],
      },
    });
  });

  it('drains a snapshot at the command boundary without dispatching a browser session', async () => {
    const searchUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-command-local-drain',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'page', pageSize: 1 },
    };
    const first = await executeCollectionUnit({
      unit: searchUnit,
      runtime: createFixtureCollectionRuntime({
        searchPage: {
          page: 1,
          offers: [
            searchOffer('925000000101'),
            searchOffer('925000000102'),
            searchOffer('925000000103'),
          ],
          hasMore: false,
          collectedAt: '2026-07-24T05:05:00Z',
        },
      }),
    });
    let dispatchCalls = 0;

    const resumed = await executeCollectCommand(
      {
        unit: JSON.stringify({
          unit: searchUnit,
          checkpoint: first.checkpoint,
        }),
        profile: 'reader-01',
      },
      {
        async dispatchCollect() {
          dispatchCalls += 1;
          throw new Error('dispatch must not run while draining a snapshot');
        },
        batchId: () => 'batch-command-local-drain',
        now: sequenceClock(
          '2026-07-24T05:06:00.000Z',
          '2026-07-24T05:06:01.000Z',
        ),
      },
    );

    expect(dispatchCalls).toBe(0);
    expect(resumed).toMatchObject({
      batchId: 'batch-command-local-drain',
      status: 'partial',
      observations: [{ offerId: '925000000102', pageRank: 2 }],
      checkpoint: {
        pendingKeys: ['925000000103'],
        pendingItems: [{ snapshotVersion: 1, key: '925000000103' }],
      },
    });
  });

  it('preserves search continuation identity when collection fails before a batch', async () => {
    const searchUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-search-failure-checkpoint',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'bounded-pages', pageSize: 1 },
    };
    const offers = ['930000000101', '930000000102', '930000000103']
      .map(searchOffer);
    const first = await executeCollectionUnit({
      unit: searchUnit,
      runtime: createFixtureCollectionRuntime({
        searchPage: {
          page: 1,
          offers,
          hasMore: true,
          collectedAt: '2026-07-24T05:10:00Z',
        },
      }),
    });
    const failedRuntime: CollectionRuntime = {
      async collect() {
        throw new Error('simulated transport reset');
      },
    };

    const failed = await executeCollectionUnit({
      unit: searchUnit,
      checkpoint: first.checkpoint,
      runtime: failedRuntime,
      now: sequenceClock(
        '2026-07-24T05:11:00.000Z',
        '2026-07-24T05:11:01.000Z',
      ),
    });
    expect(failed).toMatchObject({
      status: 'failed',
      errors: [{ code: 'COLLECTION_FAILED', retryable: true }],
      checkpoint: {
        nextPage: 1,
        completedPages: [],
        seenKeys: ['930000000101'],
        pendingKeys: ['930000000102', '930000000103'],
        pendingItems: [
          { key: '930000000102' },
          { key: '930000000103' },
        ],
        attemptCounts: { 'page:1': 1 },
        updatedAt: '2026-07-24T05:11:01.000Z',
      },
    });
    expect(failed.checkpoint?.nextCursor).toBe(first.checkpoint?.nextCursor);
    expect(failed.checkpoint?.pendingKeys).toEqual(
      first.checkpoint?.pendingKeys,
    );
    expect(failed.checkpoint?.pendingItems).toEqual(
      first.checkpoint?.pendingItems,
    );

    const freshFailure = await executeCollectionUnit({
      unit: searchUnit,
      runtime: failedRuntime,
      now: sequenceClock(
        '2026-07-24T05:12:00.000Z',
        '2026-07-24T05:12:01.000Z',
      ),
    });
    expect(freshFailure).toMatchObject({
      status: 'failed',
      checkpoint: {
        nextPage: 1,
        completedPages: [],
        seenKeys: [],
        pendingKeys: [],
        attemptCounts: { 'page:1': 1 },
      },
    });

    const {
      pendingItems: _pendingItems,
      ...checkpointWithoutSnapshot
    } = first.checkpoint!;
    const migratedLegacyFailure = await executeCollectionUnit({
      unit: searchUnit,
      checkpoint: {
        ...checkpointWithoutSnapshot,
        pendingKeys: ['page:1'],
      },
      runtime: failedRuntime,
      now: sequenceClock(
        '2026-07-24T05:13:00.000Z',
        '2026-07-24T05:13:01.000Z',
      ),
    });
    expect(migratedLegacyFailure).toMatchObject({
      status: 'failed',
      checkpoint: {
        nextPage: 1,
        pendingKeys: [],
        attemptCounts: { 'page:1': 1 },
      },
    });
  });

  it('uses the fixture request identity independently from the response member alias', async () => {
    const qualificationUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-qualification-fixture',
      kind: 'store-qualification',
      subject: {
        supplier: { shopUrl: 'https://fixture-shop.1688.com/' },
      },
    };

    const batch = await executeCollectionUnit({
      unit: qualificationUnit,
      runtime: createFixtureCollectionRuntime({
        qualificationRequestMemberId: 'fixtureLogin_01',
        qualificationPayload: {
          data: {
            memberId: 'b2b-canonical-supplier',
            businessInfo: {},
            certList: [],
          },
        },
      }),
    });

    expect(batch.observations[0]).toMatchObject({
      requestMemberId: 'fixtureLogin_01',
      memberId: 'b2b-canonical-supplier',
    });
  });

  it('records the actual online qualification request key in the observation', async () => {
    const page = new QualificationCollectionPage('b2b-canonical-supplier');
    const qualificationUnit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'collect-qualification-online',
      kind: 'store-qualification',
      subject: {
        supplier: {
          memberId: 'fixtureLogin_01',
          shopUrl: 'https://fixture-shop.1688.com/',
        },
      },
    };
    const context = {
      newPage: async () => page,
    } as unknown as import('playwright').BrowserContext;

    const batch = await executeCollectionUnit({
      unit: qualificationUnit,
      runtime: createPlaywrightCollectionRuntime(context, false),
    });

    expect(page.requestedMemberId).toBe('fixtureLogin_01');
    expect(batch.observations[0]).toMatchObject({
      requestMemberId: 'fixtureLogin_01',
      memberId: 'b2b-canonical-supplier',
    });
  });

  it('keeps a valid login-style supplier key after checking the shop page', async () => {
    const page = new QualificationMemberPage(null);

    await expect(
      navigateAndResolveQualificationMember(
        page as unknown as Page,
        'https://fixture-shop.1688.com/',
        'fixture-login-name',
      ),
    ).resolves.toBe('fixture-login-name');
    expect(page.navigatedUrls).toEqual([
      'https://fixture-shop.1688.com/',
    ]);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('keeps a validated b2b supplier identity after checking the shop page', async () => {
    const page = new QualificationMemberPage(null);

    await expect(
      navigateAndResolveQualificationMember(
        page as unknown as Page,
        'https://fixture-shop.1688.com/',
        'b2b-fixture-known',
      ),
    ).resolves.toBe('b2b-fixture-known');
    expect(page.navigatedUrls).toEqual([
      'https://fixture-shop.1688.com/',
    ]);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('keeps the headed qualification command alive until risk control clears', async () => {
    const page = new HeadedRiskQualificationPage();

    await expect(
      navigateAndResolveQualificationMember(
        page as unknown as Page,
        'https://fixture-shop.1688.com/',
        'b2b-fixture-known',
        true,
      ),
    ).resolves.toBe('b2b-fixture-known');
    expect(page.probeCount).toBeGreaterThanOrEqual(2);
  });

  it('resolves a missing or unsafe supplier key from the shop Alisite request', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          'tests/fixtures/store-catalog/categories.json',
        ),
        'utf8',
      ),
    );
    const page = new QualificationMemberPage(
      payload,
      'b2b-fixture-resolved',
    );

    await expect(
      navigateAndResolveQualificationMember(
        page as unknown as Page,
        'https://fixture-shop.1688.com/',
        'unsafe/member',
      ),
    ).resolves.toBe('b2b-fixture-resolved');
    expect(page.navigatedUrls).toEqual([
      'https://fixture-shop.1688.com/',
    ]);
    expect(page.listenerCount('response')).toBe(0);
  });
});

class HeadedRiskQualificationPage extends EventEmitter {
  probeCount = 0;

  async goto(): Promise<null> {
    return null;
  }

  isClosed(): boolean {
    return false;
  }

  url(): string {
    return this.probeCount < 1
      ? 'https://punish.1688.com/punish'
      : 'https://fixture-shop.1688.com/';
  }

  async title(): Promise<string> {
    return 'Fixture';
  }

  async evaluate(): Promise<string> {
    this.probeCount += 1;
    return this.probeCount === 1 ? '请完成滑块验证' : 'Fixture shop';
  }
}

function sequenceClock(...timestamps: string[]): () => Date {
  const values = timestamps.map((timestamp) => new Date(timestamp));
  return () => values.shift() ?? new Date(timestamps.at(-1)!);
}
