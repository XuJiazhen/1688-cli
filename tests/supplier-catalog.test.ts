import { describe, expect, it } from 'vitest';
import {
  buildStoreCatalogUrl,
  catalogSortInteraction,
  findCatalogCategoryName,
  normalizeCatalogTarget,
  planCatalogNavigation,
} from '../src/commands/supplier-catalog.js';

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
