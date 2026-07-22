import { describe, expect, it } from 'vitest';
import type { Offer } from '../src/session/search-mtop.js';
import {
  applySearchControls,
  demandSignals,
  makeResearchItem,
  normalizeFilters,
  parseCountText,
  parseEnrichTop,
  parsePositiveInt,
  researchItemsToCsv,
  researchItemsToJsonl,
  scoreOffer,
} from '../src/commands/sourcing-utils.js';

function offer(
  partial: Omit<Partial<Offer>, 'supplier'> & {
    offerId: string;
    supplier?: Partial<Offer['supplier']>;
  },
): Offer {
  const supplier: Offer['supplier'] = {
    name: '工厂',
    loginId: null,
    memberId: null,
    shopUrl: null,
    years: 3,
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
    ...partial.supplier,
  };
  return {
    offerId: partial.offerId,
    title: partial.title ?? `Offer ${partial.offerId}`,
    price: partial.price ?? { text: '¥10', min: 10, max: 10 },
    purchase: partial.purchase ?? {
      priceTiers: [],
      minimumQuantity: null,
      onePieceEligible: null,
    },
    supplier,
    location: partial.location ?? { province: '广东', city: '深圳' },
    bizType: partial.bizType ?? null,
    verified:
      partial.verified ?? { factory: true, business: false, superFactory: false },
    tags: partial.tags ?? ['退货包运费'],
    serviceTags: partial.serviceTags,
    productBadges: partial.productBadges,
    demand: partial.demand,
    isP4P: partial.isP4P ?? false,
    turnover: partial.turnover ?? '100+',
    url: partial.url ?? `https://detail.1688.com/offer/${partial.offerId}.html`,
    image: partial.image ?? null,
    images: partial.images ?? [],
  };
}

describe('sourcing utils', () => {
  it('parses Chinese count text', () => {
    expect(parseCountText('100+')).toBe(100);
    expect(parseCountText('1.2万+')).toBe(12000);
    expect(parseCountText('3k')).toBe(3000);
    expect(parseCountText('成交 2,345 件')).toBe(2345);
    expect(parseCountText(null)).toBeNull();
  });

  it('filters and sorts search offers deterministically', () => {
    const offers = [
      offer({ offerId: '1', price: { text: '¥99', min: 99, max: 99 }, turnover: '10+', isP4P: true }),
      offer({ offerId: '2', price: { text: '¥5', min: 5, max: 5 }, turnover: '1万+', verified: { factory: true, business: false, superFactory: true } }),
      offer({ offerId: '3', price: { text: '¥20', min: 20, max: 20 }, turnover: '200+', location: { province: '浙江', city: '义乌' } }),
    ];
    const filters = normalizeFilters({
      priceMax: 50,
      province: '广东',
      verified: 'super-factory',
      excludeAds: true,
    });

    const out = applySearchControls(offers, 'best-selling', filters);
    expect(out.map((x) => x.offerId)).toEqual(['2']);
  });

  it('keeps missing prices last for price sorts', () => {
    const offers = [
      offer({ offerId: 'missing', price: { text: '', min: null, max: null } }),
      offer({ offerId: 'cheap', price: { text: '¥5', min: 5, max: 5 } }),
      offer({ offerId: 'expensive', price: { text: '¥99', min: 99, max: 99 } }),
    ];

    expect(applySearchControls(offers, 'price-asc', normalizeFilters({})).map((x) => x.offerId)).toEqual([
      'cheap',
      'expensive',
      'missing',
    ]);
    expect(applySearchControls(offers, 'price-desc', normalizeFilters({})).map((x) => x.offerId)).toEqual([
      'expensive',
      'cheap',
      'missing',
    ]);
  });

  it('scores offers with explainable parts', () => {
    const scored = scoreOffer(
      offer({
        offerId: 'score',
        price: { text: '¥4', min: 4, max: 4 },
        turnover: '1万+',
        supplier: { name: '超级工厂', shopUrl: null, years: 5 },
        verified: { factory: true, business: true, superFactory: true },
        tags: ['退货包运费', '48小时发货'],
      }),
    );

    expect(scored.score).toBeGreaterThan(80);
    expect(scored.scoreBreakdown.map((p) => p.name)).toContain('demand');
  });

  it('builds research items and export formats', () => {
    const item = makeResearchItem({
      sourceKeyword: '手机壳',
      sourceRank: 1,
      globalRank: 1,
      offer: offer({ offerId: '888', title: 'A, B "quoted"', turnover: '300+' }),
    });

    expect(demandSignals(item.offer)).toMatchObject({ orderCount: 300 });
    expect(JSON.parse(researchItemsToJsonl([item]).trim())).toMatchObject({
      sourceKeyword: '手机壳',
      offer: { offerId: '888' },
    });
    expect(researchItemsToCsv([item])).toContain('"A, B ""quoted"""');
  });

  it('parses enrichment options', () => {
    expect(parseEnrichTop(undefined)).toBe(0);
    expect(parseEnrichTop('none')).toBe(0);
    expect(parseEnrichTop('top:12')).toBe(12);
    expect(parseEnrichTop('99')).toBe(50);
  });

  it('validates positive integer options', () => {
    expect(parsePositiveInt(undefined, '--max', 20)).toBe(20);
    expect(parsePositiveInt('999', '--max', 20, 600)).toBe(600);
    expect(() => parsePositiveInt('nope', '--max', 20)).toThrow('--max must be a positive integer.');
  });
});
