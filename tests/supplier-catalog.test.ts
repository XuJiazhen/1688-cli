import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type {
  BrowserContext,
  Page,
  Response as PWResponse,
} from 'playwright';
import { describe, expect, it, vi } from 'vitest';

const { inspectSupplierMock, resolveSupplierNavigationMock } = vi.hoisted(() => ({
  inspectSupplierMock: vi.fn(),
  resolveSupplierNavigationMock: vi.fn(),
}));

vi.mock('../src/commands/supplier-inspect.js', () => ({
  execute: inspectSupplierMock,
  resolveSupplierNavigationFromOffer: resolveSupplierNavigationMock,
}));

import {
  buildStoreCatalogUrl,
  catalogSortInteraction,
  createPlaywrightCatalogAdapter,
  findCatalogCategoryName,
  normalizeCatalogTransport,
  normalizeCatalogTarget,
  planCatalogNavigation,
  resolveCatalogSupplier,
  supplierInspectionTarget,
} from '../src/commands/supplier-catalog.js';
import {
  ALISITE_MODULE_API,
  STORE_CATALOG_COMPONENT_KEY,
  STORE_CATEGORIES_COMPONENT_KEY,
} from '../src/session/alisite-module.js';

class RuntimeCatalogPage extends EventEmitter {
  readonly runtimeRequests: unknown[] = [];
  readonly navigations: string[] = [];
  private currentUrl = 'about:blank';
  private closed = false;
  private riskResponseCount = 0;
  private challengeProbeCount = 0;
  private readonly pendingRuntimeRejects = new Set<(error: Error) => void>();

  constructor(
    private readonly responseMode:
      | 'exact'
      | 'scope-mismatch'
      | 'schema-changed'
      | 'risk-control'
      | 'risk-control-once'
      | 'category-risk-control-once'
      | 'none' = 'exact',
    private readonly runtimeAvailable = true,
    private readonly runtimeSettles = true,
    private readonly runtimeResult: unknown = {
      ret: ['SUCCESS::调用成功'],
    },
  ) {
    super();
  }

  async goto(url: string): Promise<null> {
    this.rejectPendingRuntimeEvaluations(
      new Error('Execution context was destroyed by navigation.'),
    );
    this.currentUrl = url;
    this.navigations.push(url);
    if (
      this.responseMode === 'category-risk-control-once' &&
      url === 'https://shop-example.1688.com/'
    ) {
      await this.emitCategoryResponse();
    }
    if (url.includes('/page/offerlist.html')) {
      await this.emitCatalogResponse({
        memberId: 'b2b-fixture-ordinary',
        appdata: {
          pageNum: 1,
          count: 30,
          catId: null,
          keywords: null,
          sortType: 'wangpu_score',
        },
      });
    }
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Fixture supplier';
  }

  isClosed(): boolean {
    return this.closed;
  }

  get pendingRuntimeEvaluationCount(): number {
    return this.pendingRuntimeRejects.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPendingRuntimeEvaluations(
      new Error('Target page was closed.'),
    );
  }

  async waitForFunction(): Promise<void> {
    if (!this.runtimeAvailable) {
      throw new Error('Runtime unavailable in fixture.');
    }
  }

  async evaluate(_callback: unknown, request?: unknown): Promise<unknown> {
    if (request === undefined) {
      if (this.currentUrl.includes('punish.1688.com')) {
        this.challengeProbeCount += 1;
        if (this.challengeProbeCount < 3) return '请完成滑块验证';
        this.currentUrl = 'https://shop-example.1688.com/';
      }
      return '';
    }
    this.runtimeRequests.push(request);
    const runtimeRequest = request as {
      data: { componentKey: string; params: string };
    };
    const params = JSON.parse(runtimeRequest.data.params) as {
      memberId: string;
      appdata: Record<string, unknown>;
    };
    const appdata = {
      ...params.appdata,
      ...(this.responseMode === 'scope-mismatch'
        ? { pageNum: Number(params.appdata.pageNum) + 1 }
        : {}),
    };
    if (this.responseMode !== 'none') {
      await this.emitCatalogResponse({
        memberId: params.memberId,
        appdata,
      });
    }
    if (!this.runtimeSettles) {
      return new Promise<never>((_resolve, reject) => {
        const rejectPending = (error: Error) => {
          this.pendingRuntimeRejects.delete(rejectPending);
          reject(error);
        };
        this.pendingRuntimeRejects.add(rejectPending);
      });
    }
    return this.runtimeResult;
  }

  private rejectPendingRuntimeEvaluations(error: Error): void {
    for (const reject of [...this.pendingRuntimeRejects]) {
      reject(error);
    }
  }

  private async emitCatalogResponse(params: {
    memberId: string;
    appdata: Record<string, unknown>;
  }): Promise<void> {
    const payload = JSON.parse(
      await readFile(
        new URL('./fixtures/store-catalog/ordinary-store.json', import.meta.url),
        'utf8',
      ),
    );
    const data = {
      componentKey: STORE_CATALOG_COMPONENT_KEY,
      params: JSON.stringify({
        memberId: params.memberId,
        appdata: params.appdata,
      }),
    };
    const url =
      `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
      `?api=${ALISITE_MODULE_API}&sign=fixture-secret&data=${encodeURIComponent(JSON.stringify(data))}`;
    const riskControl =
      this.responseMode === 'risk-control' ||
      (this.responseMode === 'risk-control-once' &&
        this.riskResponseCount++ === 0);
    this.emit('response', {
      url: () => url,
      request: () => ({ postData: () => null }),
      text: async () =>
        JSON.stringify(
          riskControl
            ? {
                ret: ['FAIL_SYS_USER_VALIDATE::验证失败'],
                data: {
                  url:
                    this.responseMode === 'risk-control-once'
                      ? 'https://punish.1688.com/punish?token=ephemeral-secret'
                      : 'https://challenge.invalid/?token=secret',
                },
              }
            : this.responseMode === 'schema-changed'
            ? { data: { unexpected: true } }
            : payload,
        ),
    } as unknown as PWResponse);
  }

  private async emitCategoryResponse(): Promise<void> {
    const payload = JSON.parse(
      await readFile(
        new URL('./fixtures/store-catalog/categories.json', import.meta.url),
        'utf8',
      ),
    );
    const data = {
      componentKey: STORE_CATEGORIES_COMPONENT_KEY,
      params: JSON.stringify({
        memberId: 'b2b-fixture-ordinary',
      }),
    };
    const url =
      `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
      `?api=${ALISITE_MODULE_API}&sign=fixture-secret&data=${encodeURIComponent(JSON.stringify(data))}`;
    const riskControl = this.riskResponseCount++ === 0;
    this.emit('response', {
      url: () => url,
      request: () => ({ postData: () => null }),
      text: async () =>
        JSON.stringify(
          riskControl
            ? {
                ret: ['FAIL_SYS_USER_VALIDATE::验证失败'],
                data: {
                  url:
                    'https://punish.1688.com/punish?token=ephemeral-secret',
                },
              }
            : payload,
        ),
    } as unknown as PWResponse);
  }

  locator(): never {
    throw new Error('Runtime collection must not query a DOM locator.');
  }

  getByRole(): never {
    throw new Error('Runtime collection must not query a DOM role.');
  }

  getByText(): never {
    throw new Error('Runtime collection must not query DOM text.');
  }
}

describe('supplier catalog command helpers', () => {
  it('normalizes offer, member, and shop URL targets without using loginId as identity', () => {
    expect(normalizeCatalogTarget('900000000001')).toMatchObject({
      type: 'offerId',
      offerId: '900000000001',
    });
    expect(normalizeCatalogTarget('b2b-fixture-member')).toMatchObject({
      type: 'memberId',
      memberId: 'b2b-fixture-member',
    });
    expect(
      normalizeCatalogTarget('https://shop-example.1688.com/page/offerlist.html?secret=ignored#x'),
    ).toEqual({
      input: 'https://shop-example.1688.com/page/offerlist.html?secret=ignored#x',
      type: 'shopUrl',
      offerId: null,
      memberId: null,
      shopUrl: 'https://shop-example.1688.com/',
    });
    expect(() => normalizeCatalogTarget('seller-login-id')).toThrow(/offerId.*memberId.*shop URL/i);
  });

  it('prefers a source Offer navigation hint over direct member inspection', () => {
    expect(
      supplierInspectionTarget({
        memberId: 'seller-login-id',
        sourceOfferId: '1234567890',
      }),
    ).toBe('1234567890');
    expect(
      supplierInspectionTarget({
        memberId: '721241300563',
        sourceOfferId: '9876543210',
      }),
    ).toBe('9876543210');
    expect(
      supplierInspectionTarget({
        memberId: 'b2b-valid-member',
        sourceOfferId: '9876543210',
      }),
    ).toBe('9876543210');
    expect(
      supplierInspectionTarget({
        memberId: 'b2b-valid-member',
      }),
    ).toBe('b2b-valid-member');
  });

  it('keeps the stable member identity when a source Offer resolves navigation', async () => {
    inspectSupplierMock.mockReset();
    resolveSupplierNavigationMock.mockReset();
    resolveSupplierNavigationMock.mockResolvedValue({
      memberId: 'b2b-inspected-alias',
      shopUrl: 'https://resolved-shop.1688.com/page/index.html',
    });

    const result = await resolveCatalogSupplier(
      {} as BrowserContext,
      {
        schemaVersion: 1,
        unitId: 'catalog-source-offer',
        kind: 'store-catalog',
        subject: {
          supplier: {
            memberId: 'b2b-stable-store',
            sourceOfferId: '9876543210',
          },
        },
      },
      false,
    );

    expect(resolveSupplierNavigationMock).toHaveBeenCalledWith(
      expect.anything(),
      { offerId: '9876543210', headed: false },
    );
    expect(inspectSupplierMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      memberId: 'b2b-stable-store',
      shopUrl: 'https://resolved-shop.1688.com/',
      sourceOfferId: '9876543210',
    });
  });

  it('builds all-products, category, and keyword URLs on the resolved shop origin', () => {
    expect(buildStoreCatalogUrl('https://shop-example.1688.com/', {})).toBe(
      'https://shop-example.1688.com/page/offerlist.html',
    );
    const scoped = new URL(buildStoreCatalogUrl('https://shop-example.1688.com/', {
      categoryId: 'category-1',
      storeKeyword: '帐篷',
    }));
    expect(scoped.pathname).toBe('/page/offerlist.html');
    expect(scoped.searchParams.get('categoryId')).toBe('category-1');
    expect(scoped.searchParams.get('keywords')).toBe('帐篷');
    expect(scoped.searchParams.get('charset')).toBe('utf8');
  });

  it('replays earlier UI pages before collecting a resumed page in a fresh browser', () => {
    expect(planCatalogNavigation(1, false)).toEqual(['goto']);
    expect(planCatalogNavigation(2, false)).toEqual(['goto', 'next:2']);
    expect(planCatalogNavigation(4, false)).toEqual([
      'goto',
      'next:2',
      'next:3',
      'next:4',
    ]);
    expect(planCatalogNavigation(4, true)).toEqual(['next:4']);
  });

  it('collects a resumed page with one Runtime request and no DOM replay', async () => {
    const mockPage = new RuntimeCatalogPage();
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
    );

    const parsed = await adapter.collectPage({
      kind: 'store-catalog',
      page: 4,
      pageSize: 30,
      memberId: 'b2b-fixture-ordinary',
      sort: 'wangpu_score',
    });

    expect(parsed.page.pageNum).toBe(4);
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
    ]);
    expect(mockPage.runtimeRequests).toHaveLength(1);
    expect(
      JSON.parse(
        (
          mockPage.runtimeRequests[0] as {
            data: { params: string };
          }
        ).data.params,
      ),
    ).toMatchObject({
      memberId: 'b2b-fixture-ordinary',
      appdata: { pageNum: 4 },
    });
    expect(adapter.diagnosticsForPage?.(4)).toMatchObject({
      transport: 'runtime',
      targetPage: 4,
      catalogRequestCount: 1,
      parserVersion: 'alisite-store-catalog-v1',
    });
    expect(JSON.stringify(adapter.diagnosticsForPage?.(4))).not.toContain(
      'b2b-fixture-ordinary',
    );
    expect(JSON.stringify(parsed)).not.toContain('fixture-secret');
  });

  it.each([
    ['scope-mismatch', 'CATALOG_RESPONSE_SCOPE_MISMATCH'],
    ['schema-changed', 'CATALOG_RESPONSE_SCHEMA_CHANGED'],
  ] as const)(
    'classifies a %s Runtime response without DOM fallback',
    async (responseMode, code) => {
      const mockPage = new RuntimeCatalogPage(responseMode);
      const adapter = createPlaywrightCatalogAdapter(
        mockPage as unknown as Page,
        {
          shopUrl: 'https://shop-example.1688.com/',
          memberId: 'b2b-fixture-ordinary',
        },
        false,
        'runtime',
        { responseMs: 100 },
      );

      await expect(
        adapter.collectPage({
          kind: 'store-catalog',
          page: 2,
          pageSize: 30,
          memberId: 'b2b-fixture-ordinary',
          sort: 'wangpu_score',
        }),
      ).rejects.toMatchObject({ code });
      expect(mockPage.runtimeRequests).toHaveLength(1);
      expect(mockPage.navigations).toEqual([
        'https://shop-example.1688.com/',
      ]);
    },
  );

  it('classifies an MTOP validation response as risk control', async () => {
    const mockPage = new RuntimeCatalogPage('risk-control');
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { responseMs: 50 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 1,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).rejects.toMatchObject({
      code: 'RISK_CONTROL',
      exitCode: 4,
      details: {
        retryable: true,
        diagnostics: {
          failures: [{
            payloadSummary: {
              retCodes: ['FAIL_SYS_USER_VALIDATE'],
            },
          }],
        },
      },
    });
  });

  it('keeps headed Runtime collection open for an MTOP challenge and retries once', async () => {
    const mockPage = new RuntimeCatalogPage('risk-control-once');
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      true,
      'runtime',
      { runtimeRequestMs: 500, responseMs: 500 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 2,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).resolves.toMatchObject({
      kind: 'offer-list',
      page: { pageNum: 2 },
    });
    expect(mockPage.runtimeRequests).toHaveLength(2);
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
      'https://punish.1688.com/punish?token=ephemeral-secret',
      'https://shop-example.1688.com/',
    ]);
    expect(
      JSON.stringify(adapter.diagnosticsForPage?.(2)),
    ).not.toContain('ephemeral-secret');
  });

  it('keeps headed category collection open for an MTOP challenge and retries once', async () => {
    const mockPage = new RuntimeCatalogPage('category-risk-control-once');
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      true,
      'auto',
      { responseMs: 500 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-categories',
        page: 1,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).resolves.toMatchObject({
      kind: 'categories',
      categories: [
        expect.objectContaining({ id: 'fixture-category-tools' }),
      ],
    });
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
      'https://punish.1688.com/punish?token=ephemeral-secret',
      'https://shop-example.1688.com/',
    ]);
    expect(
      JSON.stringify(adapter.diagnosticsForPage?.(1)),
    ).not.toContain('ephemeral-secret');
  });

  it('classifies a missing correlated Runtime response before process timeout', async () => {
    const mockPage = new RuntimeCatalogPage('none');
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { responseMs: 5 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 2,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).rejects.toMatchObject({
      code: 'CATALOG_RESPONSE_TIMEOUT',
      details: { retryable: true },
    });
    expect(mockPage.runtimeRequests).toHaveLength(1);
  });

  it('uses a correlated response even when the Runtime Promise never settles', async () => {
    const mockPage = new RuntimeCatalogPage('exact', true, false);
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { runtimeRequestMs: 500, responseMs: 500 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 2,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).resolves.toMatchObject({
      kind: 'offer-list',
      page: { pageNum: 2 },
    });
    expect(mockPage.runtimeRequests).toHaveLength(1);
  });

  it('rebuilds the page before another request after an unsettled Runtime fulfillment', async () => {
    const mockPage = new RuntimeCatalogPage('exact', true, false);
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { runtimeRequestMs: 500, responseMs: 500 },
    );

    await adapter.collectPage({
      kind: 'store-catalog',
      page: 1,
      pageSize: 30,
      memberId: 'b2b-fixture-ordinary',
    });
    expect(mockPage.pendingRuntimeEvaluationCount).toBe(1);
    await adapter.collectPage({
      kind: 'store-catalog',
      page: 2,
      pageSize: 30,
      memberId: 'b2b-fixture-ordinary',
    });

    expect(mockPage.runtimeRequests).toHaveLength(2);
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
      'https://shop-example.1688.com/',
    ]);
    expect(mockPage.pendingRuntimeEvaluationCount).toBe(1);
    await mockPage.close();
    expect(mockPage.pendingRuntimeEvaluationCount).toBe(0);
  });

  it('parses a valid Runtime fulfillment when no network event is observable', async () => {
    const payload = JSON.parse(
      await readFile(
        new URL(
          './fixtures/store-catalog/ordinary-store.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const mockPage = new RuntimeCatalogPage(
      'none',
      true,
      true,
      payload,
    );
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { responseMs: 500 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 3,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).resolves.toMatchObject({
      kind: 'offer-list',
      page: { pageNum: 3 },
    });
    expect(adapter.diagnosticsForPage?.(3)).toMatchObject({
      transport: 'runtime',
      catalogRequestCount: 1,
      runtimeResultStatus: 'parsed',
    });
    expect(adapter.sourceRefForPage?.(3)).toMatch(
      /^runtime:store-catalog:sha256:[a-f0-9]{64}:page:3$/,
    );
  });

  it('falls back to DOM only when auto mode explicitly allows it', async () => {
    const mockPage = new RuntimeCatalogPage('exact', false);
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'auto',
      { runtimeReadyMs: 5, responseMs: 20 },
    );

    const parsed = await adapter.collectPage({
      kind: 'store-catalog',
      page: 1,
      pageSize: 30,
      memberId: 'b2b-fixture-ordinary',
      sort: 'wangpu_score',
    });

    expect(mockPage.runtimeRequests).toEqual([]);
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
      'https://shop-example.1688.com/',
      'https://shop-example.1688.com/page/offerlist.html?sortType=wangpu_score&charset=utf8',
    ]);
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: 'CATALOG_DOM_FALLBACK',
      }),
    );
    expect(adapter.diagnosticsForPage?.(1)).toMatchObject({
      transport: 'dom',
      fallbackReason: 'CATALOG_MTOP_RUNTIME_UNAVAILABLE',
    });
  });

  it('rebuilds the loaded page once before explicit Runtime mode fails', async () => {
    const mockPage = new RuntimeCatalogPage('exact', false);
    const adapter = createPlaywrightCatalogAdapter(
      mockPage as unknown as Page,
      {
        shopUrl: 'https://shop-example.1688.com/',
        memberId: 'b2b-fixture-ordinary',
      },
      false,
      'runtime',
      { runtimeReadyMs: 5 },
    );

    await expect(
      adapter.collectPage({
        kind: 'store-catalog',
        page: 2,
        pageSize: 30,
        memberId: 'b2b-fixture-ordinary',
      }),
    ).rejects.toMatchObject({
      code: 'CATALOG_MTOP_RUNTIME_UNAVAILABLE',
    });
    expect(mockPage.navigations).toEqual([
      'https://shop-example.1688.com/',
      'https://shop-example.1688.com/',
    ]);
    expect(adapter.diagnosticsForPage?.(2)).toMatchObject({
      transport: 'runtime',
      targetPage: 2,
      catalogRequestCount: 0,
    });
  });

  it('validates the explicit catalog transport mode', () => {
    expect(normalizeCatalogTransport(undefined)).toBe('auto');
    expect(normalizeCatalogTransport('RUNTIME')).toBe('runtime');
    expect(normalizeCatalogTransport('dom')).toBe('dom');
    expect(() => normalizeCatalogTransport('other')).toThrow(
      /runtime, dom, or auto/,
    );
  });

  it('maps stable sort values and category ids to page interactions', () => {
    expect(catalogSortInteraction(undefined)).toEqual({ label: null, clicks: 0 });
    expect(catalogSortInteraction('wangpu_score')).toEqual({ label: null, clicks: 0 });
    expect(catalogSortInteraction('tradenumdown')).toEqual({ label: '销量', clicks: 1 });
    expect(catalogSortInteraction('pricedown')).toEqual({ label: '价格', clicks: 1 });
    expect(catalogSortInteraction('priceup')).toEqual({ label: '价格', clicks: 2 });
    expect(() => catalogSortInteraction('unknown-sort')).toThrow(/sortType/i);

    expect(
      findCatalogCategoryName(
        [
          {
            id: 'root',
            name: '工具',
            fullName: null,
            count: 2,
            children: [
              {
                id: 'category-1',
                name: '电圆锯',
                fullName: null,
                count: 2,
                children: [],
              },
            ],
          },
        ],
        'category-1',
      ),
    ).toBe('电圆锯');
  });
});
