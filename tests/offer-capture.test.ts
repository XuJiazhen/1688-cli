import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  executeRaw,
  bindShopCardSourceToPageContextV1,
  mapContextSkuBizModel,
  readContextConsignmentSourceV1,
  requireSkuSelectorModel,
  selectSkuSelectorModel,
} from '../src/commands/offer.js';
import type { ResponseCaptureDiagnostics } from '../src/session/response-capture.js';

function diagnostics(
  overrides: Partial<ResponseCaptureDiagnostics> = {},
): ResponseCaptureDiagnostics {
  return {
    timeoutMs: 18000,
    startedAt: '2026-07-23T00:00:00.000Z',
    endedAt: '2026-07-23T00:00:18.000Z',
    disposed: true,
    settled: false,
    timedOut: true,
    seenCount: 42,
    matchedCount: 0,
    parsedCount: 0,
    emptyResultCount: 0,
    failureCount: 0,
    failures: [],
    emptyResults: [],
    ...overrides,
  };
}

describe('requireSkuSelectorModel', () => {
  it('drains a deferred component archive before early navigation failure returns', async () => {
    const page = new EarlyFailureOfferPage();
    let archiveStarted!: () => void;
    const started = new Promise<void>((resolve) => { archiveStarted = resolve; });
    let releaseArchive!: () => void;
    const gate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    let archived = false;
    let returned = false;
    const pending = executeRaw(
      { newPage: async () => page } as never,
      {
        offerId: '1001', headed: false, captureTimeoutMs: 1_000,
        onRawComponent: async (component) => {
          if (component !== 'sku') return;
          archiveStarted();
          await gate;
          archived = true;
        },
      },
    ).finally(() => { returned = true; });
    await started;
    expect(returned).toBe(false);
    releaseArchive();
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(archived).toBe(true);
  });

  it('delivers received component bytes before SKU parsing or required-component failure', async () => {
    const page = new RawFirstOfferPage();
    const captured: Array<{ component: string; payload: unknown }> = [];
    await expect(executeRaw(
      { newPage: async () => page } as never,
      {
        offerId: '1001', headed: false, captureTimeoutMs: 5,
        onRawComponent: async (component, payload) => {
          captured.push({ component, payload });
          if (component === 'core') page.coreArchived = true;
        },
      },
    )).rejects.toMatchObject({ code: 'OFFER_SKU_RESPONSE_TIMEOUT' });
    expect(captured).toEqual(expect.arrayContaining([
      { component: 'sku', payload: '{malformed-sku-response' },
      { component: 'core', payload: '<html>fixture core</html>' },
    ]));
  });

  it('rejects a missing SKU selector model as a retryable response timeout', () => {
    expect(() => requireSkuSelectorModel(null, diagnostics())).toThrowError(
      expect.objectContaining({
        exitCode: 9,
        code: 'OFFER_SKU_RESPONSE_TIMEOUT',
        details: expect.objectContaining({
          retryable: true,
          legacyCode: 'OFFER_SKU_CAPTURE_INCOMPLETE',
          matchedCount: 0,
          parsedCount: 0,
          timedOut: true,
          responseCapture: expect.objectContaining({
            matchedCount: 0,
            timedOut: true,
          }),
        }),
      }),
    );
  });

  it('returns a captured SKU selector model unchanged', () => {
    const model = { skuInfoMap: {} };

    expect(
      requireSkuSelectorModel(
        model,
        diagnostics({
          settled: true,
          timedOut: false,
          matchedCount: 1,
          parsedCount: 1,
        }),
      ),
    ).toBe(model);
  });
});

describe('SSR consignment source fallback', () => {
  const sourcePayload = {
    contextResult: {
      data: {
        gallery: { fields: { offerId: 671182185805 } },
      },
      global: {
        globalData: {
          model: {
            sellerModel: { memberId: 'b2b-22114100897724d9dd' },
            consignModel: {
              consignOffer: false,
              consignSign: {
                canIgnoreConsignRelation: false,
                signs: {
                  supportDistribution: true,
                  isSupportConsignIssuing: false,
                  hasConsignReation: false,
                },
              },
              distributeChannels: [
                { name: '淘宝', typeCode: 'thyny' },
                { name: 'Amazon', typeCode: 'amazon' },
              ],
              hasConsignPrice: false,
            },
          },
        },
      },
    },
    feGlobals: { memberId: 'unrelated-signed-in-profile' },
  };

  it('uses exact offer and seller paths to preserve the Offer-scoped SSR model', () => {
    expect(
      readContextConsignmentSourceV1(
        sourcePayload,
        '671182185805',
        'b2b-22114100897724d9dd',
      ),
    ).toMatchObject({
      responseSucceeded: true,
      correlatedOfferId: '671182185805',
      correlatedMemberId: 'b2b-22114100897724d9dd',
      rawPayload: sourcePayload,
      value: {
        offerFlags: {
          consignOffer: false,
          hasConsignPrice: false,
          'consignSign.canIgnoreConsignRelation': false,
          'consignSign.signs.supportDistribution': true,
          'consignSign.signs.isSupportConsignIssuing': false,
          'consignSign.signs.hasConsignReation': false,
        },
        supportedChannels: [
          { name: '淘宝', iconUrl: null },
          { name: 'Amazon', iconUrl: null },
        ],
      },
    });
  });

  it.each([
    ['offer mismatch', { contextResult: { ...sourcePayload.contextResult, data: { gallery: { fields: { offerId: 'other' } } } } }, 'b2b-22114100897724d9dd'],
    ['missing seller', { contextResult: { ...sourcePayload.contextResult, global: { globalData: { model: { consignModel: sourcePayload.contextResult.global.globalData.model.consignModel } } } } }, 'b2b-22114100897724d9dd'],
    ['seller mismatch', sourcePayload, 'b2b-other-member'],
    ['malformed model', { contextResult: { ...sourcePayload.contextResult, global: { globalData: { model: { sellerModel: { memberId: 'b2b-22114100897724d9dd' }, consignModel: {} } } } } }, 'b2b-22114100897724d9dd'],
  ])('rejects %s instead of manufacturing consignment evidence', (_label, payload, expectedMemberId) => {
    expect(
      readContextConsignmentSourceV1(
        payload,
        '671182185805',
        expectedMemberId,
      ),
    ).toBeNull();
  });

  it('binds an identity-free ShopCard response to exact archived page context', () => {
    const captured = {
      value: { shopName: 'Fixture shop' },
      responseSucceeded: true,
      correlatedOfferId: null,
      correlatedMemberId: null,
      rawPayload: { data: { shopName: 'Fixture shop' } },
    };
    expect(bindShopCardSourceToPageContextV1(
      captured,
      sourcePayload,
      '671182185805',
      'b2b-22114100897724d9dd',
    )).toMatchObject({
      correlatedOfferId: '671182185805',
      correlatedMemberId: 'b2b-22114100897724d9dd',
      correlationAuthority: {
        kind: 'offer-page-context-v1',
      },
    });
  });

  it('does not override missing, contradictory, or partially correlated ShopCard scope', () => {
    const captured = {
      value: { shopName: 'Fixture shop' },
      responseSucceeded: true,
      correlatedOfferId: null,
      correlatedMemberId: null,
      rawPayload: { data: { shopName: 'Fixture shop' } },
    };
    expect(bindShopCardSourceToPageContextV1(
      captured,
      sourcePayload,
      'different-offer',
      'b2b-22114100897724d9dd',
    )).toBe(captured);
    expect(bindShopCardSourceToPageContextV1(
      { ...captured, correlatedOfferId: '671182185805' },
      sourcePayload,
      '671182185805',
      'b2b-22114100897724d9dd',
    )).toMatchObject({
      correlatedOfferId: '671182185805',
      correlatedMemberId: null,
    });
  });
});

class RawFirstOfferPage extends EventEmitter {
  private currentUrl = 'about:blank';
  coreArchived = false;

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    this.emit('response', {
      url: () => 'https://h5api.m.1688.com/h5/mtop.1688.wosc.queryofferskuselectormodel/1.0/',
      text: async () => '{malformed-sku-response',
      headers: () => ({ 'content-type': 'application/json' }),
    });
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Fixture Offer - Alibaba'; }
  async waitForFunction(): Promise<never> { throw new Error('no SSR context'); }
  async content(): Promise<string> { return '<html>fixture core</html>'; }
  async evaluate(fn: unknown): Promise<unknown> {
    if (!this.coreArchived) throw new Error('core raw page must be archived before extraction');
    return String(fn).includes('document.body')
      ? ''
      : { supplierName: null, mainImage: null };
  }
}

class EarlyFailureOfferPage extends EventEmitter {
  async goto(): Promise<never> {
    this.emit('response', {
      url: () => 'https://h5api.m.1688.com/h5/mtop.1688.wosc.queryofferskuselectormodel/1.0/',
      text: async () => '{"data":{}}',
      headers: () => ({ 'content-type': 'application/json' }),
    });
    await Promise.resolve();
    throw new Error('fixture early navigation failure');
  }
}

describe('SSR SKU selector fallback', () => {
  it('normalizes the redacted SSR model and enriches stock from tradeModel', () => {
    const mapped = mapContextSkuBizModel({
      skuModel: {
        skuPriceScale: '10.00-20.00',
        skuProps: [
          {
            prop: '颜色',
            value: [
              { name: '样本A', imageUrl: '//img.example/a.jpg' },
              { name: '样本B' },
            ],
          },
        ],
        skuInfoMap: {
          '样本A': {
            skuId: 101,
            specAttrs: '颜色:样本A',
            price: 12,
            discountPrice: '10.00',
          },
          '样本B': {
            skuId: '102',
            specAttrs: '颜色:样本B',
            price: '20.00',
          },
        },
      },
      tradeModel: {
        beginAmount: 2,
        unit: '件',
        skuMap: [
          { skuId: 101, canBookCount: 7, saleCount: 3 },
          { skuId: '102', canBookCount: '9', saleCount: '4' },
        ],
        offerPriceModel: {
          currentPrices: [{ beginAmount: 2, price: '10.00' }],
        },
      },
    });

    expect(mapped).toMatchObject({
      skuPriceScale: '10.00-20.00',
      skuProps: [
        {
          prop: '颜色',
          value: [
            { name: '样本A', imageUrl: '//img.example/a.jpg' },
            { name: '样本B' },
          ],
        },
      ],
      skuInfoMap: {
        '样本A': {
          skuId: '101',
          specAttrs: '颜色:样本A',
          price: '12',
          discountPrice: '10.00',
          canBookCount: '7',
          saleCount: 3,
        },
        '样本B': {
          skuId: '102',
          canBookCount: '9',
          saleCount: '4',
        },
      },
      skuSelectorModel: {
        tradeModel: {
          beginAmount: 2,
          unit: '件',
          offerPriceModel: {
            currentPrices: [{ beginAmount: 2, price: '10.00' }],
          },
        },
      },
    });
  });

  it('falls back to skuModelOrigin and keeps network capture precedence', () => {
    const ssr = mapContextSkuBizModel({
      skuModel: { skuInfoMap: { invalid: { skuId: null } } },
      skuModelOrigin: {
        skuPriceScale: '8.00',
        skuProps: [],
        skuInfoMap: { sample: { skuId: 201, price: 8 } },
      },
    });
    const network = { skuInfoMap: {} };

    expect(ssr).toMatchObject({
      skuPriceScale: '8.00',
      skuInfoMap: { sample: { skuId: '201', price: '8' } },
    });
    expect(selectSkuSelectorModel(network, ssr)).toBe(network);
    expect(selectSkuSelectorModel(null, ssr)).toBe(ssr);
    expect(selectSkuSelectorModel(null, null)).toBeNull();
    expect(
      mapContextSkuBizModel({
        skuModel: { skuInfoMap: { invalid: { skuId: '' } } },
      }),
    ).toBeNull();
  });

  it.each([
    ['empty object', {}],
    ['empty array', []],
  ])('treats an explicit %s SKU list as a valid complete empty model', (_label, skuInfoMap) => {
    expect(
      mapContextSkuBizModel({
        skuModel: { skuInfoMap },
      }),
    ).toMatchObject({
      skuInfoMap: {},
      skuProps: [],
    });
  });

  it('rejects a non-empty SSR SKU list when every row is malformed', () => {
    expect(
      mapContextSkuBizModel({
        skuModel: {
          skuInfoMap: {
            invalid: { skuId: null },
          },
        },
      }),
    ).toBeNull();
  });
});
