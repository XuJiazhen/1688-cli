import { describe, expect, it } from 'vitest';
import {
  mapContextSkuBizModel,
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
  it('rejects a missing SKU selector model as retryable capture failure', () => {
    expect(() => requireSkuSelectorModel(null, diagnostics())).toThrowError(
      expect.objectContaining({
        exitCode: 9,
        code: 'OFFER_SKU_CAPTURE_INCOMPLETE',
        details: expect.objectContaining({
          retryable: true,
          matchedCount: 0,
          parsedCount: 0,
          timedOut: true,
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
});
