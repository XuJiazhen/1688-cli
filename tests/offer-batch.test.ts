import { describe, expect, it } from 'vitest';
import {
  createOfferCollectionBatch,
  type OfferCaptureOutcome,
} from '../src/collection/offer-batch.js';
import type { CollectionUnit } from '../src/collection/contracts.js';
import type { OfferResult } from '../src/commands/offer.js';
import { CliError } from '../src/io/errors.js';

const NOW = '2026-07-22T08:00:00.000Z';

function unit(kind: 'offer-detail' | 'offer-media-manifest'): CollectionUnit {
  return {
    schemaVersion: 1,
    unitId: `${kind}-unit`,
    kind,
    subject: { offerId: '1001' },
    scope: { requestedScope: 'page' },
  };
}

function offer(overrides: Partial<OfferResult> = {}): OfferResult {
  return {
    offerId: '1001',
    title: 'fixture offer',
    url: 'https://detail.1688.com/offer/1001.html',
    priceRange: null,
    priceMin: null,
    priceMax: null,
    unitName: null,
    minOrderQty: null,
    mixOrderQty: null,
    priceTiers: [],
    detailUrl: null,
    attributes: [],
    packageInfo: [],
    supplier: { name: null, loginId: null, memberId: null, userId: null },
    shopCard: null,
    consignment: null,
    freight: {
      receiveAddress: null,
      sendArea: null,
      province: null,
      city: null,
      unitWeight: null,
    },
    saledCount: null,
    categoryId: null,
    options: [],
    skus: [
      {
        skuId: 'sku-unknown',
        specs: '颜色:灰色',
        price: null,
        multiPrice: null,
        stock: null,
        saleCount: null,
        availability: {
          price: 'not-present',
          stock: 'not-present',
          saleCount: 'not-present',
        },
        image: null,
      },
    ],
    mainImage: null,
    images: [],
    media: {
      availability: 'not-present',
      items: [],
      source: {
        sourceType: 'offer-payload',
        fieldPath: 'offer.media',
        sourceRef: 'offer:1001:media',
        collectedAt: NOW,
        collectorVersion: '1688-cli',
        parserVersion: '1',
      },
      warnings: [],
    },
    sources: {
      shopCardResponseObserved: false,
      shopCardCaptured: false,
      consignmentResponseObserved: false,
      consignmentCaptured: false,
      detailMediaResponseObserved: false,
      detailMediaCaptured: false,
    },
    ...overrides,
  };
}

function captured(value = offer()): OfferCaptureOutcome {
  return { status: 'captured', value };
}

describe('createOfferCollectionBatch', () => {
  it('preserves the complete offer observation and unknown SKU facts', () => {
    const batch = createOfferCollectionBatch({
      unit: unit('offer-detail'),
      outcome: captured(),
      batchId: 'offer-detail-batch',
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch).toMatchObject({
      schemaVersion: 1,
      batchId: 'offer-detail-batch',
      unitId: 'offer-detail-unit',
      kind: 'offer-detail',
      status: 'completed',
      completeness: {
        requestedScope: 'page',
        state: 'complete',
        observedPages: [],
        failedPages: [],
        expectedItems: 1,
        uniqueItems: 1,
      },
    });
    expect(batch.observations).toEqual([
      {
        offerId: '1001',
        offer: expect.objectContaining({
          title: 'fixture offer',
          skus: [
            expect.objectContaining({
              price: null,
              stock: null,
              saleCount: null,
              availability: {
                price: 'not-present',
                stock: 'not-present',
                saleCount: 'not-present',
              },
            }),
          ],
        }),
        collectedAt: NOW,
      },
    ]);
  });

  it('emits only the URL manifest for an offer-media-manifest unit', () => {
    const media = {
      availability: 'available' as const,
      items: [
        {
          role: 'main' as const,
          order: 0,
          originalUrl: '//img.alicdn.com/main.jpg',
          normalizedUrl: 'https://img.alicdn.com/main.jpg',
          sourceField: 'gallery.mainImage',
        },
        {
          role: 'detail' as const,
          order: 1,
          originalUrl: 'https://img.alicdn.com/detail.jpg',
          normalizedUrl: 'https://img.alicdn.com/detail.jpg',
          sourceField: 'offer_details.content',
        },
      ],
      source: {
        sourceType: 'offer-payload' as const,
        fieldPath: 'offer.media',
        sourceRef: 'offer:1001:media',
        collectedAt: NOW,
        collectorVersion: '1688-cli',
        parserVersion: '1',
      },
      warnings: [],
    };
    const batch = createOfferCollectionBatch({
      unit: unit('offer-media-manifest'),
      outcome: captured(offer({ media })),
      batchId: 'offer-media-batch',
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch.observations).toEqual([
      { offerId: '1001', media, collectedAt: NOW },
    ]);
    expect(batch.observations[0]).not.toHaveProperty('offer');
    expect(batch.metrics).toMatchObject({ capturedOffers: 1, mediaItems: 2 });
  });

  it('keeps the media observation when one URL produces a warning', () => {
    const sourceOffer = offer({
      media: {
        ...offer().media,
        availability: 'available',
        items: [
          {
            role: 'main',
            order: 0,
            originalUrl: 'https://img.alicdn.com/main.jpg',
            normalizedUrl: 'https://img.alicdn.com/main.jpg',
            sourceField: 'gallery.mainImage',
          },
        ],
        warnings: [
          {
            code: 'MEDIA_URL_INVALID',
            message: 'detail image URL is not a supported HTTP(S) URL.',
            order: 1,
            originalUrl: 'data:image/png;base64,fixture',
          },
        ],
      },
    });

    const batch = createOfferCollectionBatch({
      unit: unit('offer-media-manifest'),
      outcome: captured(sourceOffer),
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch.status).toBe('completed');
    expect(batch.observations).toHaveLength(1);
    expect(batch.warnings).toEqual([
      {
        code: 'MEDIA_URL_INVALID',
        message: 'detail image URL is not a supported HTTP(S) URL.',
        details: {
          offerId: '1001',
          order: 1,
          originalUrl: 'data:image/png;base64,fixture',
        },
      },
    ]);
    expect(batch.errors).toEqual([]);
  });

  it('returns a partial batch when the media component failed after the offer was captured', () => {
    const sourceOffer = offer({
      media: {
        ...offer().media,
        availability: 'failed',
        warnings: [
          {
            code: 'OFFER_DETAILS_CONTENT_UNREADABLE',
            message: 'offer_details.content could not be parsed.',
          },
        ],
      },
    });

    const batch = createOfferCollectionBatch({
      unit: unit('offer-detail'),
      outcome: captured(sourceOffer),
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch.status).toBe('partial');
    expect(batch.observations).toHaveLength(1);
    expect(batch.completeness).toMatchObject({
      state: 'truncated',
      expectedItems: 1,
      uniqueItems: 1,
    });
    expect(batch.errors).toEqual([
      {
        code: 'OFFER_MEDIA_CAPTURE_FAILED',
        message: 'Offer media evidence could not be completely collected.',
        retryable: true,
        details: { offerId: '1001' },
      },
    ]);
  });

  it('keeps recovered main images but marks an unreadable detail-media component partial', () => {
    const sourceOffer = offer({
      media: {
        ...offer().media,
        availability: 'available',
        items: [
          {
            role: 'main',
            order: 0,
            originalUrl: 'https://img.alicdn.com/main.jpg',
            normalizedUrl: 'https://img.alicdn.com/main.jpg',
            sourceField: 'gallery.mainImage',
          },
        ],
        warnings: [
          {
            code: 'OFFER_DETAILS_CONTENT_UNREADABLE',
            message: 'offer_details.content could not be parsed.',
          },
        ],
      },
    });

    const batch = createOfferCollectionBatch({
      unit: unit('offer-media-manifest'),
      outcome: captured(sourceOffer),
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch).toMatchObject({
      status: 'partial',
      observations: [
        {
          offerId: '1001',
          media: { availability: 'available', items: [{ role: 'main' }] },
        },
      ],
      completeness: { state: 'truncated', uniqueItems: 1 },
      errors: [{ code: 'OFFER_MEDIA_CAPTURE_FAILED', retryable: true }],
    });
  });

  it('returns a failed batch for a capture failure and sanitizes diagnostics', () => {
    const batch = createOfferCollectionBatch({
      unit: unit('offer-detail'),
      outcome: {
        status: 'failed',
        error: new CliError(
          9,
          'CAPTURE_TIMEOUT',
          'Timed out at https://h5api.m.1688.com/h5/offer?api=test&sign=secret&data=secret',
        ),
      },
      rawEvidenceRefs: [
        'https://h5api.m.1688.com/h5/offer?api=test&sign=secret&data=secret',
      ],
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch).toMatchObject({
      status: 'failed',
      observations: [],
      completeness: { state: 'unknown', expectedItems: 1, uniqueItems: 0 },
      errors: [
        {
          code: 'CAPTURE_TIMEOUT',
          retryable: true,
          message:
            'Timed out at https://h5api.m.1688.com/h5/offer?api=test&sign=%5Bredacted%5D&data=%5Bredacted%5D',
        },
      ],
      rawEvidenceRefs: ['https://h5api.m.1688.com/h5/offer?api=test'],
      metrics: { capturedOffers: 0, failedOffers: 1 },
    });
  });

  it.each([
    ['NOT_LOGGED_IN', 3, 'login'],
    ['RISK_CONTROL', 4, 'risk-control'],
  ] as const)(
    'returns a blocked batch with actionRequired for %s',
    (code, exitCode, actionType) => {
      const batch = createOfferCollectionBatch({
        unit: unit('offer-detail'),
        outcome: {
          status: 'failed',
          error: new CliError(exitCode, code, `${code} requires user action.`),
        },
        startedAt: NOW,
        completedAt: NOW,
      });

      expect(batch).toMatchObject({
        status: 'blocked',
        observations: [],
        completeness: { state: 'unknown', uniqueItems: 0 },
        errors: [{ code, retryable: true }],
        actionRequired: {
          type: actionType,
          message: `${code} requires user action.`,
        },
      });
    },
  );

  it('sanitizes media evidence refs without mutating the captured offer', () => {
    const sensitiveRef =
      'https://h5api.m.1688.com/h5/media?api=test&sign=secret&data=secret';
    const sourceOffer = offer({
      media: {
        ...offer().media,
        source: {
          ...offer().media.source,
          sourceRef: sensitiveRef,
          rawRef: sensitiveRef,
        },
      },
    });

    const batch = createOfferCollectionBatch({
      unit: unit('offer-media-manifest'),
      outcome: captured(sourceOffer),
      rawEvidenceRefs: [sensitiveRef],
      startedAt: NOW,
      completedAt: NOW,
    });

    expect(batch.observations[0]).toMatchObject({
      media: {
        source: {
          sourceRef: 'https://h5api.m.1688.com/h5/media?api=test',
          rawRef: 'https://h5api.m.1688.com/h5/media?api=test',
        },
      },
    });
    expect(batch.rawEvidenceRefs).toEqual([
      'https://h5api.m.1688.com/h5/media?api=test',
    ]);
    expect(sourceOffer.media.source.sourceRef).toBe(sensitiveRef);
  });
});
