import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildOfferMediaManifest,
  parseOfferDetailsScript,
} from '../src/session/offer-media.js';

describe('parseOfferDetailsScript', () => {
  it('extracts detail images in document order without evaluating script', () => {
    const result = parseOfferDetailsScript(
      String.raw`var offer_details = { content: '<p><img src="//img.example.test/one.jpg"/><img data-src="https://img.example.test/two.jpg?__r__=123&amp;x=1"/></p>' };`,
      'https://itemcdn.tmall.com/1688offer/sanitized',
      '2026-07-22T00:00:00.000Z',
    );

    expect(result.availability).toBe('available');
    expect(result.items).toEqual([
      {
        role: 'detail',
        order: 0,
        originalUrl: '//img.example.test/one.jpg',
        normalizedUrl: 'https://img.example.test/one.jpg',
        sourceField: 'offer_details.content',
      },
      {
        role: 'detail',
        order: 1,
        originalUrl: 'https://img.example.test/two.jpg?__r__=123&x=1',
        normalizedUrl: 'https://img.example.test/two.jpg?x=1',
        sourceField: 'offer_details.content',
      },
    ]);
    expect(result.source.sourceRef).toBe(
      'https://itemcdn.tmall.com/1688offer/sanitized',
    );
  });

  it('reports an invalid image without discarding valid detail images', () => {
    const result = parseOfferDetailsScript(
      `var offer_details={content:'<img src="javascript:alert(1)"><img src="https://img.example.test/valid.jpg">'};`,
    );

    expect(result.availability).toBe('available');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      order: 1,
      normalizedUrl: 'https://img.example.test/valid.jpg',
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'MEDIA_URL_INVALID', order: 0 }),
    ]);
  });

  it('parses the live JSON-style quoted content property', () => {
    const result = parseOfferDetailsScript(
      String.raw`var offer_details={"content":"<p><img src=\"https://img.example.test/live.jpg?__r__=123\"/></p>"};`,
    );

    expect(result).toMatchObject({
      availability: 'available',
      items: [
        {
          role: 'detail',
          order: 0,
          normalizedUrl: 'https://img.example.test/live.jpg',
        },
      ],
    });
  });

  it.each([
    ['detail-14.js', 14, 'detail-a-14.jpg'],
    ['detail-19.js', 19, 'detail-b-19.jpg'],
  ] as const)('replays %s with stable image order', async (name, count, lastImage) => {
    const script = await readFile(
      new URL(`./fixtures/offer-media/${name}`, import.meta.url),
      'utf8',
    );
    const result = parseOfferDetailsScript(script);

    expect(result.items).toHaveLength(count);
    expect(result.items.map((item) => item.order)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    );
    expect(result.items.at(-1)?.normalizedUrl).toContain(lastImage);
  });

  it('does not duplicate the gallery main image in the URL manifest', () => {
    const manifest = buildOfferMediaManifest({
      offerId: '900000000001',
      mainImage: 'https://img.example.test/main.jpg',
      images: [
        'https://img.example.test/main.jpg',
        'https://img.example.test/alternate.jpg',
      ],
      skuImages: ['https://img.example.test/main.jpg'],
      detail: null,
    });

    expect(manifest.items.filter((item) => item.role === 'main')).toHaveLength(2);
    expect(manifest.items.filter((item) => item.role === 'sku')).toHaveLength(1);
  });
});
