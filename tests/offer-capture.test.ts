import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  assertOfferPageIdentityV1,
  executeRaw,
  mapContextSkuBizModel,
  offerSourceCaptureTimeoutMsV1,
  parseConsignmentSourceResponseV1,
  parseShopCardSourceResponseV1,
  requireSkuSelectorModel,
  selectSkuSelectorModel,
} from '../src/commands/offer.js';
import type { ResponseCaptureDiagnostics } from '../src/session/response-capture.js';
import { startResponseCapture } from '../src/session/response-capture.js';

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
  it('waits past an initial token-empty ShopCard response for the successful retry', async () => {
    const page = new EventEmitter();
    const capture = startResponseCapture({
      page: page as never,
      timeoutMs: 50,
      matcher: /mtop\.1688\.moga\.pc\.shopcard/iu,
      parse: async (response) => parseShopCardSourceResponseV1(
        await response.text(),
        response.url(),
      ),
    });
    const response = (payload: unknown) => ({
      url: () =>
        'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/',
      text: async () => JSON.stringify(payload),
    });
    const result = capture.wait();
    page.emit('response', response({
      ret: ['FAIL_SYS_TOKEN_EMPTY::token empty'],
      data: {},
    }));
    page.emit('response', response({
      ret: ['SUCCESS::success'],
      data: { model: { shopName: 'Replay Shop' } },
    }));

    await expect(result).resolves.toMatchObject({
      responseSucceeded: true,
      value: { name: 'Replay Shop' },
    });
    expect(capture.diagnostics()).toMatchObject({
      matchedCount: 2,
      emptyResultCount: 1,
      parsedCount: 1,
      settled: true,
    });
  });

  it('waits past an initial token-empty Consignment response for the successful retry', async () => {
    const page = new EventEmitter();
    const capture = startResponseCapture({
      page: page as never,
      timeoutMs: 50,
      matcher: /mtop\.1688\.mmga\.offerdetail\.service/iu,
      parse: async (response) => parseConsignmentSourceResponseV1(
        await response.text(),
        response.url(),
      ),
    });
    const requestUrl =
      'https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/'
      + '?serviceName=offerPCConsignInfoService';
    const response = (payload: unknown) => ({
      url: () => requestUrl,
      text: async () => JSON.stringify(payload),
    });
    const result = capture.wait();
    page.emit('response', response({
      ret: ['FAIL_SYS_TOKEN_EMPTY::token empty'],
      data: {},
    }));
    page.emit('response', response({
      ret: ['SUCCESS::success'],
      data: { data: { data: { name: 'Consignment Replay' } } },
    }));

    await expect(result).resolves.toMatchObject({
      responseSucceeded: true,
      value: { name: 'Consignment Replay' },
    });
    expect(capture.diagnostics()).toMatchObject({
      matchedCount: 2,
      emptyResultCount: 1,
      parsedCount: 1,
      settled: true,
    });
  });

  it('keeps a bounded late-response window for the Consignment source', () => {
    expect(offerSourceCaptureTimeoutMsV1(undefined, 'shop-card')).toBe(18_000);
    expect(offerSourceCaptureTimeoutMsV1(undefined, 'offer-consignment')).toBe(
      30_000,
    );
    expect(offerSourceCaptureTimeoutMsV1(5, 'offer-consignment')).toBe(5);
  });

  it('rejects an unproven or mismatched canonical Offer page identity', () => {
    expect(() => assertOfferPageIdentityV1('1001', '1001')).not.toThrow();
    expect(() => assertOfferPageIdentityV1(null, '1001')).toThrowError(
      expect.objectContaining({ code: 'OFFER_PAGE_SCOPE_MISMATCH' }),
    );
    expect(() => assertOfferPageIdentityV1('1002', '1001')).toThrowError(
      expect.objectContaining({ code: 'OFFER_PAGE_SCOPE_MISMATCH' }),
    );
  });

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
