import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  ALISITE_MODULE_API,
  AlisiteSchemaError,
  STORE_CATALOG_COMPONENT_KEY,
  parseStoreCatalogModule,
  readAlisiteModuleRequestMeta,
  startAlisiteModuleCapture,
} from '../src/session/alisite-module.js';

function alisiteUrl(
  params: Record<string, unknown>,
  componentKey = STORE_CATALOG_COMPONENT_KEY,
): string {
  return `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?api=${ALISITE_MODULE_API}&sign=fixture-secret&data=${encodeURIComponent(
    JSON.stringify({ componentKey, params: JSON.stringify(params) }),
  )}`;
}

function alisitePostBody(
  params: Record<string, unknown>,
  componentKey = STORE_CATALOG_COMPONENT_KEY,
): string {
  return new URLSearchParams({
    data: JSON.stringify({ componentKey, params: JSON.stringify(params) }),
  }).toString();
}

class MockPage extends EventEmitter {
  on(event: 'response', listener: (response: PWResponse) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: 'response', listener: (response: PWResponse) => void): this;
  off(event: 'close', listener: () => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  emitResponse(value: PWResponse): void {
    this.emit('response', value);
  }

  emitClose(): void {
    this.emit('close');
  }
}

function page(): Page & MockPage {
  return new MockPage() as Page & MockPage;
}

function response(
  url: string,
  payload: unknown | Promise<unknown>,
  postData?: string,
): PWResponse {
  return {
    url: () => url,
    request: () => ({ postData: () => postData ?? null }),
    text: async () => JSON.stringify(await payload),
  } as unknown as PWResponse;
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/store-catalog/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

interface MutableOfferListFixture {
  data: {
    content: {
      offerCount: unknown;
      offerList: unknown[];
      offerCategoryDataModel: { userDefined: unknown };
    };
  };
}

interface MutableCategoryFixture {
  data: {
    category: {
      offerCategoryList: Array<{
        count: unknown;
        children: unknown[];
      }>;
    };
  };
}

async function offerListFixture(name: string): Promise<MutableOfferListFixture> {
  return (await fixture(name)) as MutableOfferListFixture;
}

describe('parseStoreCatalogModule', () => {
  it('parses a real-shape ordinary-store offer-list fixture without losing raw sales evidence', async () => {
    const parsed = parseStoreCatalogModule(await fixture('ordinary-store'), {
      memberId: 'b2b-fixture-ordinary',
      pageNum: 1,
      pageSize: 30,
      categoryId: null,
      keyword: null,
      sortType: 'wangpu_score',
    });

    expect(parsed).toMatchObject({
      kind: 'offer-list',
      offerCount: 96,
      totalPages: 4,
      page: {
        memberId: 'b2b-fixture-ordinary',
        pageNum: 1,
        pageSize: 30,
        categoryId: null,
        keyword: null,
        sortType: 'wangpu_score',
      },
      userDefined: {
        raw: 'false',
        value: false,
        state: 'parsed',
      },
      categories: [
        {
          id: 'fixture-category-ordinary',
          name: '家用组合工具',
          fullName: '家用组合工具',
          count: 1,
          children: [],
        },
      ],
      offers: [
        {
          offerId: '900000000001',
          memberId: 'b2b-fixture-ordinary',
          title: '家用组合工具套装',
          imageUrl: 'https://img.example.test/ordinary-tool.jpg',
          categoryId: '0',
          sales: {
            vagueSaleQuantity: '300+',
            thirtySaleQuantity: '354',
            bookedCount: '17',
            ninetySaleQuantity: '0',
            saleQuantity: '0',
          },
        },
      ],
      warnings: [],
    });
  });

  it.each([
    ['ordinary-store', 96, false, '300+'],
    ['strong-merchant', 199, false, '1.1万+'],
    ['source-flagship', 67, true, ''],
    ['super-factory', 33, false, '500+'],
  ] as const)(
    'uses one parser for the %s response shape',
    async (name, offerCount, userDefined, vagueSaleQuantity) => {
      const parsed = parseStoreCatalogModule(await fixture(name), {
        pageNum: 1,
        pageSize: 30,
      });

      expect(parsed.offerCount).toBe(offerCount);
      expect(parsed.totalPages).toBe(Math.ceil(offerCount / 30));
      expect(parsed.offers).toHaveLength(1);
      expect(parsed.offers[0]?.sales.vagueSaleQuantity).toBe(
        vagueSaleQuantity,
      );
      expect(parsed.userDefined).toMatchObject({
        value: userDefined,
        state: 'parsed',
      });
    },
  );

  it('keeps duplicate-looking root and offerModel sales fields separate', async () => {
    const parsed = parseStoreCatalogModule(await fixture('strong-merchant'));

    expect(parsed.offers[0]?.sales).toMatchObject({
      bookedCount: '1706',
      thirtySaleQuantity: '1520',
      modelBookedCount: '0',
      modelAgentBookedCount: '0',
      modelQuantitySumMonth: '0',
      modelSaleQuantity: '0',
    });
  });

  it('preserves the primitive type of raw sales fields', async () => {
    const payload = await offerListFixture('ordinary-store');
    const firstOffer = payload.data.content.offerList[0] as Record<
      string,
      unknown
    >;
    firstOffer.thirtySaleQuantity = 12;

    const parsed = parseStoreCatalogModule(payload);

    expect(parsed.offers[0]?.sales.thirtySaleQuantity).toBe(12);
  });

  it('attaches one-based page and absolute positions from request metadata', async () => {
    const parsed = parseStoreCatalogModule(await fixture('ordinary-store'), {
      pageNum: 2,
      pageSize: 30,
      categoryId: 'fixture-category-ordinary',
      keyword: '工具',
      sortType: 'tradenumdown',
    });

    expect(parsed.offers[0]).toMatchObject({
      pagePosition: 1,
      absolutePosition: 31,
    });
    expect(parsed.page).toMatchObject({
      pageNum: 2,
      pageSize: 30,
      categoryId: 'fixture-category-ordinary',
      keyword: '工具',
      sortType: 'tradenumdown',
    });
  });

  it('distinguishes empty and invalid userDefined strings and warns on invalid data', async () => {
    const emptyPayload = await offerListFixture('ordinary-store');
    emptyPayload.data.content.offerCategoryDataModel.userDefined = '   ';
    const empty = parseStoreCatalogModule(emptyPayload);

    expect(empty.userDefined).toEqual({
      raw: '   ',
      value: null,
      state: 'empty',
    });
    expect(empty.warnings).toEqual([]);

    const invalidPayload = await offerListFixture('ordinary-store');
    invalidPayload.data.content.offerCategoryDataModel.userDefined =
      'not-a-boolean';
    const invalid = parseStoreCatalogModule(invalidPayload);

    expect(invalid.userDefined).toEqual({
      raw: 'not-a-boolean',
      value: null,
      state: 'invalid',
    });
    expect(invalid.warnings).toContainEqual({
      code: 'INVALID_USER_DEFINED',
      fieldPath: 'data.content.offerCategoryDataModel.userDefined',
      message: 'Expected userDefined to be true, false, or an empty string',
    });
  });

  it('parses the standalone category response through the same entry point', async () => {
    const parsed = parseStoreCatalogModule(await fixture('categories'));

    expect(parsed).toMatchObject({
      kind: 'categories',
      offerCount: null,
      totalPages: null,
      offers: [],
      page: { memberId: 'b2b-fixture-ordinary' },
      userDefined: { raw: 'false', value: false, state: 'parsed' },
      categories: [
        {
          id: 'fixture-category-tools',
          count: 3,
          children: [
            {
              id: 'fixture-category-hand-tools',
              count: 2,
              children: [],
            },
          ],
        },
      ],
      warnings: [],
    });
  });

  it('reports malformed count and offer entries rather than silently dropping evidence', async () => {
    const payload = await offerListFixture('ordinary-store');
    payload.data.content.offerCount = 'many';
    payload.data.content.offerList.push({ subject: 'missing offer id' });

    const parsed = parseStoreCatalogModule(payload);

    expect(parsed.offerCount).toBeNull();
    expect(parsed.offers).toHaveLength(1);
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        {
          code: 'INVALID_OFFER_COUNT',
          fieldPath: 'data.content.offerCount',
          message: 'Expected offerCount to be a non-negative integer',
        },
        {
          code: 'INVALID_OFFER_ITEM',
          fieldPath: 'data.content.offerList[1].id',
          message: 'Skipped offer item without an id',
        },
      ]),
    );
  });

  it('reports malformed nested category evidence with its source path', async () => {
    const payload = (await fixture('categories')) as MutableCategoryFixture;
    payload.data.category.offerCategoryList[0]!.count = 'many';
    payload.data.category.offerCategoryList[0]!.children.push({
      name: 'missing id',
    });

    const parsed = parseStoreCatalogModule(payload);

    expect(parsed.categories[0]?.count).toBeNull();
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        {
          code: 'INVALID_CATEGORY_COUNT',
          fieldPath: 'data.category.offerCategoryList[0].count',
          message: 'Expected category count to be a non-negative integer',
        },
        {
          code: 'INVALID_CATEGORY_ITEM',
          fieldPath:
            'data.category.offerCategoryList[0].children[1].id',
          message: 'Skipped category item without an id',
        },
      ]),
    );
  });

  it('throws a diagnostic schema error for unrelated payloads', () => {
    expect(() => parseStoreCatalogModule({ data: { content: {} } })).toThrow(
      expect.objectContaining<Partial<AlisiteSchemaError>>({
        name: 'AlisiteSchemaError',
        code: 'ALISITE_SCHEMA_UNRECOGNIZED',
      }),
    );
  });

  it.each([
    ['category-filter', { categoryId: 'fixture-category-tools' }],
    ['keyword-search', { keyword: '工具' }],
    ['sales-sort', { sortType: 'tradenumdown' }],
  ] as const)('keeps %s request scope in page metadata', async (name, scope) => {
    const parsed = parseStoreCatalogModule(await fixture(name), {
      memberId: 'b2b-fixture-ordinary',
      pageNum: 1,
      pageSize: 30,
      ...scope,
    });
    expect(parsed.page).toMatchObject(scope);
    expect(parsed.offers.length).toBeGreaterThan(0);
  });
});

describe('readAlisiteModuleRequestMeta', () => {
  it('reads the API, component, and store catalog scope from an MTOP URL', () => {
    expect(
      readAlisiteModuleRequestMeta(
        alisiteUrl({
          memberId: 'b2b-fixture-ordinary',
          pageNum: '2',
          count: 30,
          catId: 'fixture-category',
          keywords: '工具',
          sortType: 'tradenumdown',
        }),
      ),
    ).toEqual({
      api: ALISITE_MODULE_API,
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      memberId: 'b2b-fixture-ordinary',
      pageNum: 2,
      count: 30,
      catId: 'fixture-category',
      keywords: '工具',
      sortType: 'tradenumdown',
    });
  });

  it('reads the real request shape where catalog scope is nested in params.appdata', () => {
    const data = {
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      params: JSON.stringify({
        memberId: 'b2b-fixture-ordinary',
        appdata: {
          pageNum: 2,
          count: 30,
          catId: 'fixture-category',
          keywords: '工具',
          sortType: 'tradenumdown',
        },
      }),
    };
    const url = `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?data=${encodeURIComponent(JSON.stringify(data))}`;

    expect(readAlisiteModuleRequestMeta(url)).toMatchObject({
      memberId: 'b2b-fixture-ordinary',
      pageNum: 2,
      count: 30,
      catId: 'fixture-category',
      keywords: '工具',
      sortType: 'tradenumdown',
    });
  });

  it('reads request metadata from the real POST form body when data is absent from the URL', () => {
    const url = `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?api=${ALISITE_MODULE_API}&v=1.0`;
    expect(
      readAlisiteModuleRequestMeta(
        url,
        alisitePostBody({
          memberId: 'b2b-fixture-ordinary',
          appdata: {
            pageNum: 2,
            count: 30,
            sortType: 'tradenumdown',
          },
        }),
      ),
    ).toMatchObject({
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      memberId: 'b2b-fixture-ordinary',
      pageNum: 2,
      count: 30,
      sortType: 'tradenumdown',
    });
  });

  it('correlates a response whose scope is carried in the POST form body', async () => {
    const mockPage = page();
    const request = {
      memberId: 'b2b-fixture-ordinary',
      appdata: { pageNum: 1, count: 30, sortType: 'wangpu_score' },
    };
    const capture = startAlisiteModuleCapture({
      page: mockPage,
      targets: [{
        id: 'post-catalog',
        componentKey: STORE_CATALOG_COMPONENT_KEY,
        request: {
          memberId: 'b2b-fixture-ordinary',
          pageNum: 1,
          count: 30,
          sortType: 'wangpu_score',
        },
      }],
    });
    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(
        `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?api=${ALISITE_MODULE_API}`,
        fixture('ordinary-store'),
        alisitePostBody(request),
      ),
    );

    expect(await wait).toMatchObject({
      status: 'captured',
      captures: [{ targetId: 'post-catalog' }],
    });
  });

  it('returns null for unrelated or malformed request URLs', () => {
    expect(
      readAlisiteModuleRequestMeta('https://example.test/not-alisite?data={}'),
    ).toBeNull();
    expect(
      readAlisiteModuleRequestMeta(
        `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?data=not-json`,
      ),
    ).toBeNull();
  });
});

describe('startAlisiteModuleCapture', () => {
  it('captures only the response whose component and complete request scope match', async () => {
    const mockPage = page();
    const request = {
      memberId: 'b2b-fixture-ordinary',
      pageNum: 2,
      count: 30,
      catId: 'fixture-category',
      keywords: '工具',
      sortType: 'tradenumdown',
    };
    const capture = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'catalog-page-2',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request,
        },
      ],
    });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(
        alisiteUrl({ ...request, pageNum: 1 }),
        fixture('ordinary-store'),
      ),
    );
    mockPage.emitResponse(
      response(
        alisiteUrl(request, 'Wp_pc_unrelated_component'),
        fixture('ordinary-store'),
      ),
    );
    mockPage.emitResponse(
      response(alisiteUrl(request), fixture('ordinary-store')),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      targetId: 'catalog-page-2',
      request: {
        api: ALISITE_MODULE_API,
        componentKey: STORE_CATALOG_COMPONENT_KEY,
        ...request,
      },
      parsed: {
        kind: 'offer-list',
        offerCount: 96,
        page: {
          memberId: 'b2b-fixture-ordinary',
          pageNum: 2,
          pageSize: 30,
          categoryId: 'fixture-category',
          keyword: '工具',
          sortType: 'tradenumdown',
        },
      },
    });
    expect(result.captures[0]?.sourceRef).toContain(ALISITE_MODULE_API);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result.diagnostics).toMatchObject({
      seenCount: 3,
      matchedCount: 1,
      parsedCount: 1,
      finalStatus: 'captured',
    });
  });

  it('treats an explicitly absent filter as part of the request scope', async () => {
    const mockPage = page();
    const capture = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'unfiltered',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { pageNum: 1, catId: null, keywords: null },
        },
      ],
    });
    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(
        alisiteUrl({ pageNum: 1, catId: 'other' }),
        fixture('ordinary-store'),
      ),
    );
    mockPage.emitResponse(
      response(alisiteUrl({ pageNum: 1 }), fixture('ordinary-store')),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.diagnostics.matchedCount).toBe(1);
  });

  it('waits for every required target and retains parallel response candidates', async () => {
    const mockPage = page();
    const payload = await fixture('ordinary-store');
    const baseRequest = {
      memberId: 'b2b-fixture-ordinary',
      count: 30,
      catId: '',
      keywords: '',
      sortType: 'wangpu_score',
    };
    const capture = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'page-1',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { ...baseRequest, pageNum: 1 },
        },
        {
          id: 'page-2',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { ...baseRequest, pageNum: 2 },
        },
      ],
    });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(
        alisiteUrl({ ...baseRequest, pageNum: 2 }),
        payload,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(capture.captures().map((candidate) => candidate.targetId)).toEqual([
      'page-2',
    ]);
    mockPage.emitResponse(
      response(
        alisiteUrl({ ...baseRequest, pageNum: 1 }),
        payload,
      ),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.captures.map((candidate) => candidate.targetId).sort()).toEqual(
      ['page-1', 'page-2'],
    );
  });

  it('does not admit a disposed batch late response into a parallel batch', async () => {
    const mockPage = page();
    let releaseLate!: (value: unknown) => void;
    const latePayload = new Promise<unknown>((resolve) => {
      releaseLate = resolve;
    });
    const first = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'first-page',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { pageNum: 1 },
        },
      ],
    });
    mockPage.emitResponse(
      response(alisiteUrl({ pageNum: 1 }), latePayload),
    );
    first.dispose();

    const second = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'second-page',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { pageNum: 2 },
        },
      ],
    });
    const wait = second.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(
      response(alisiteUrl({ pageNum: 2 }), fixture('ordinary-store')),
    );
    releaseLate(await fixture('ordinary-store'));

    const result = await wait;
    expect(result.captures.map((candidate) => candidate.targetId)).toEqual([
      'second-page',
    ]);
    expect(first.captures()).toEqual([]);
  });

  it('continues after a malformed matching candidate and redacts diagnostics', async () => {
    const mockPage = page();
    const capture = startAlisiteModuleCapture({
      page: mockPage,
      targets: [
        {
          id: 'catalog',
          componentKey: STORE_CATALOG_COMPONENT_KEY,
          request: { pageNum: 1 },
        },
      ],
    });
    const sensitiveUrl = alisiteUrl({ pageNum: 1 });

    const wait = capture.wait({ timeoutMs: 50, intervalMs: 1 });
    mockPage.emitResponse(response(sensitiveUrl, { unrelated: true }));
    mockPage.emitResponse(
      response(sensitiveUrl, fixture('ordinary-store')),
    );

    const result = await wait;
    expect(result.status).toBe('captured');
    expect(result.diagnostics.failureCount).toBe(1);
    expect(result.diagnostics.failures[0]).toMatchObject({
      targetIds: ['catalog'],
      name: 'AlisiteSchemaError',
    });
    const diagnosticsText = JSON.stringify(result.diagnostics);
    expect(diagnosticsText).toContain(ALISITE_MODULE_API);
    expect(diagnosticsText).not.toContain('fixture-secret');
    expect(diagnosticsText).not.toContain('pageNum');
  });

  it('reports timeout, cancellation, page close, and disposal distinctly', async () => {
    const target = {
      id: 'catalog',
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      request: { pageNum: 1 },
    };

    const timedOut = startAlisiteModuleCapture({ page: page(), targets: [target] });
    expect(
      await timedOut.wait({ timeoutMs: 2, intervalMs: 1 }),
    ).toMatchObject({
      status: 'timeout',
      diagnostics: { timedOut: true, finalStatus: 'timeout' },
    });

    const controller = new AbortController();
    const aborted = startAlisiteModuleCapture({ page: page(), targets: [target] });
    const abortedWait = aborted.wait({
      timeoutMs: 10,
      intervalMs: 50,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1);
    expect(await abortedWait).toMatchObject({ status: 'aborted' });

    const closingPage = page();
    const closed = startAlisiteModuleCapture({
      page: closingPage,
      targets: [target],
    });
    const closedWait = closed.wait({ timeoutMs: 50, intervalMs: 1 });
    closingPage.emitClose();
    expect(await closedWait).toMatchObject({ status: 'browser_closed' });

    const disposed = startAlisiteModuleCapture({ page: page(), targets: [target] });
    disposed.dispose();
    expect(
      await disposed.wait({ timeoutMs: 50, intervalMs: 1 }),
    ).toMatchObject({
      status: 'stream_closed',
      diagnostics: { disposed: true },
    });
  });

  it('keeps login expiry, rate limiting, and risk control distinct', async () => {
    const target = {
      id: 'catalog',
      componentKey: STORE_CATALOG_COMPONENT_KEY,
    };
    const loggedOut = startAlisiteModuleCapture({
      page: page(),
      targets: [target],
    });
    expect(
      await loggedOut.wait({
        timeoutMs: 50,
        intervalMs: 1,
        isNotLoggedIn: () => true,
      }),
    ).toMatchObject({ status: 'not_logged_in', captures: [] });

    const blocked = startAlisiteModuleCapture({
      page: page(),
      targets: [target],
    });
    expect(
      await blocked.wait({
        timeoutMs: 50,
        intervalMs: 1,
        isBlocked: () => true,
      }),
    ).toMatchObject({ status: 'risk_control', captures: [] });

    const rateLimited = startAlisiteModuleCapture({
      page: page(),
      targets: [target],
    });
    expect(
      await rateLimited.wait({
        timeoutMs: 50,
        intervalMs: 1,
        isRateLimited: () => true,
      }),
    ).toMatchObject({ status: 'rate_limited', captures: [] });
  });

  it('scopes listeners to waitForAction even when the action fails', async () => {
    const mockPage = page();
    const target = {
      id: 'catalog',
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      request: { pageNum: 1 },
    };
    const successful = startAlisiteModuleCapture({
      page: mockPage,
      targets: [target],
    });
    const result = await successful.waitForAction(
      async () => {
        mockPage.emitResponse(
          response(alisiteUrl({ pageNum: 1 }), fixture('ordinary-store')),
        );
        return 'navigated';
      },
      { timeoutMs: 50, intervalMs: 1 },
    );
    expect(result).toMatchObject({
      actionResult: 'navigated',
      status: 'captured',
    });
    expect(mockPage.listenerCount('response')).toBe(0);
    expect(mockPage.listenerCount('close')).toBe(0);

    const failing = startAlisiteModuleCapture({
      page: mockPage,
      targets: [target],
    });
    await expect(
      failing.waitForAction(
        async () => {
          throw new Error('navigation failed');
        },
        { timeoutMs: 50, intervalMs: 1 },
      ),
    ).rejects.toThrow('navigation failed');
    expect(mockPage.listenerCount('response')).toBe(0);
    expect(mockPage.listenerCount('close')).toBe(0);
  });
});
