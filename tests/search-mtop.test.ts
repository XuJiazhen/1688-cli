import { describe, expect, it } from 'vitest';
import {
  SEARCH_APP_ID,
  SEARCH_MTOP_API,
  mapOffer,
  parseOfferItemsFromMtopText,
  parseSearchMtopPageV1,
  readCapturedSearchRequestBusinessV1,
  readSearchMtopRequestMeta,
} from '../src/session/search-mtop.js';

function mtopUrl(data: unknown): string {
  return `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(JSON.stringify(data))}`;
}

describe('readSearchMtopRequestMeta', () => {
  it('extracts appId, method, beginPage, and sortType from request URLs', () => {
    const url = mtopUrl({
      appId: SEARCH_APP_ID,
      params: JSON.stringify({
        method: 'getOfferList',
        beginPage: '2',
        sortType: 'va_price_asc',
      }),
    });

    expect(readSearchMtopRequestMeta(url)).toEqual({
      appId: SEARCH_APP_ID,
      method: 'getOfferList',
      beginPage: 2,
      sortType: 'va_price_asc',
    });
  });

  it('leaves beginPage undefined when it is absent', () => {
    const url = mtopUrl({
      appId: SEARCH_APP_ID,
      params: JSON.stringify({ method: 'getOfferList' }),
    });

    expect(readSearchMtopRequestMeta(url)).toEqual({
      appId: SEARCH_APP_ID,
      method: 'getOfferList',
      beginPage: undefined,
      sortType: undefined,
    });
  });

  it('returns null for unrelated URLs', () => {
    expect(readSearchMtopRequestMeta('https://example.com/')).toBeNull();
  });
});

describe('strict Search MTOP V1 envelope', () => {
  it('requires ret/code/success/items and reads the source hasMore independently of page size', () => {
    const parsed = parseSearchMtopPageV1(`mtopjsonp1(${JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        code: 200, success: true,
        data: { OFFER: { items: [{ data: { offerId: '1', title: 'One' } }], hasMore: 'true', found: '99' } },
      },
    })})`);
    expect(parsed).toMatchObject({ hasMore: true, found: '99', offers: [{ offerId: '1' }] });
    expect(parsed.responseBusinessHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('accepts the live MTOP string success flag with a string status code', () => {
    const parsed = parseSearchMtopPageV1(JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        code: '200', success: 'true',
        data: { OFFER: { items: [], hasMore: 'false', found: 0 } },
      },
    }));

    expect(parsed).toMatchObject({ hasMore: false, found: 0, offers: [] });
  });

  it.each([
    [{ ret: ['FAIL'], data: { code: 200, success: true, data: { OFFER: { items: [], hasMore: 'false' } } } }, 'ret'],
    [{ ret: ['SUCCESS'], data: { code: 500, success: false, data: { OFFER: { items: [], hasMore: 'false' } } } }, 'code/success'],
    [{ ret: ['SUCCESS'], data: { code: 200, success: true, data: { OFFER: { items: [] } } } }, 'hasMore'],
  ])('fails closed when required response state is missing', (body, _case) => {
    expect(() => parseSearchMtopPageV1(JSON.stringify(body))).toThrow();
  });

  it('reads all typed request keys without exposing outer signing fields', () => {
    const url = mtopUrl({
      appId: SEARCH_APP_ID,
      params: JSON.stringify({
        method: 'getOfferList', keywords: '%C3%F0', beginPage: '2', pageSize: 60,
        pageId: 'page-session', sortType: 'price', descendOrder: false,
        province: '广东', city: '广州', quantityBegin: '1',
      }),
    });
    expect(readCapturedSearchRequestBusinessV1(url)).toEqual({
      appId: SEARCH_APP_ID, method: 'getOfferList', keywords: '%C3%F0',
      beginPage: '2', pageSize: 60, pageId: 'page-session', sortType: 'price',
      descendOrder: false,
      filterParams: { city: '广州', province: '广东', quantityBegin: '1' },
    });
  });
});

describe('parseOfferItemsFromMtopText', () => {
  it('parses offer items from JSONP response bodies', () => {
    const offers = parseOfferItemsFromMtopText(
      'mtopjsonp1({"data":{"data":{"OFFER":{"items":[{"data":{"offerId":"123","title":"<font>Hat</font>","priceInfo":{"price":"3.50"},"offerPicUrl":"https://img","province":"浙江","city":"义乌","bookedCount":"100+","isP4P":"true","factoryInspection":"true","businessInspection":"false","superFactory":"true","tags":[{"text":"  退货包运费 "}],"winPortUrl":"https://shop-old","shop":{"text":"工厂店","tpYear":"5"},"shopAddition":{"shopLinkUrl":"https://shop"}}}]}}}})',
    );

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      offerId: '123',
      title: 'Hat',
      price: { text: '¥3.50', min: 3.5, max: 3.5 },
      supplier: { name: '工厂店', shopUrl: 'https://shop', years: 5 },
      location: { province: '浙江', city: '义乌' },
      verified: { factory: true, business: false, superFactory: true },
      tags: ['退货包运费'],
      isP4P: true,
      turnover: '100+',
      url: 'https://detail.1688.com/offer/123.html',
      image: 'https://img',
    });
  });
});

describe('mapOffer', () => {
  it('preserves cellType P4P semantics and redacts contacts embedded in title HTML', () => {
    const mapped = mapOffer({
      cellType: 'offer_p4p_card',
      data: {
        offerId: '1001',
        title: '<font>灭火器 13800138000 wx:fixture_shop</font>',
        isP4P: 'false',
      },
    });
    expect(mapped).toMatchObject({
      offerId: '1001',
      title: '灭火器 [redacted] [redacted]',
      isP4P: true,
    });
  });

  it('returns null when offerId is missing', () => {
    expect(mapOffer({ data: { title: 'missing id' } })).toBeNull();
  });

  it('retains supplier, badge, service, demand, and preview evidence from current listings', () => {
    const offer = mapOffer({
      data: {
        offerId: '658650538045',
        title: '飞虎<font color=red>电钻</font>',
        loginId: '浙江飞虎新能源科技公司',
        memberId: 'b2b-2209631154515e79f6',
        offerPicUrl: 'https://img/one.jpg,https://img/two.jpg',
        odPicUrl: 'https://img/original.jpg',
        bookedCount: '274',
        afterPrice: { text: '已售200+件' },
        offerRepurchaseRate: '6%',
        turnHead: { percent: '26%' },
        shop: {
          text: '浙江飞虎新能源科技有限公司',
          tpYear: '6',
          newPic: 'https://img/badge.png',
        },
        shopAddition: {
          shopLinkUrl: 'https://shop.example',
          quantityPrices: [{ quantity: '≥1台', value: '102.9' }],
          tradeService: {
            compositeNewScore: '4.0',
            logisticsScore: '3.0',
            goodsScore: '3.67',
            inspectionCreditUrl: 'https://auth.example/report',
          },
        },
        titleTags: [{ brandTitle: '飞虎' }],
        offerTags: { serviceTags: ['深度验厂'] },
        offerMiddle: [{ text: '48小时发货' }, { text: '运费险' }],
        marketTags: [{ text: '深度验厂' }],
        list: { guide: [{ text: '1电1充' }, { text: '28牛米' }] },
      },
    });

    expect(offer).toMatchObject({
      purchase: {
        priceTiers: [
          { quantityText: '≥1台', minimumQuantity: 1, price: 102.9 },
        ],
        minimumQuantity: 1,
        onePieceEligible: true,
      },
      supplier: {
        loginId: '浙江飞虎新能源科技公司',
        memberId: 'b2b-2209631154515e79f6',
        badgeImageUrl: 'https://img/badge.png',
        tradeService: {
          compositeScore: 4,
          logisticsScore: 3,
          goodsScore: 3.67,
          inspectionCreditUrl: 'https://auth.example/report',
        },
      },
      serviceTags: ['深度验厂', '48小时发货', '运费险'],
      productBadges: ['飞虎'],
      specHighlights: ['1电1充', '28牛米'],
      demand: {
        orderCount: 274,
        repurchaseRate: 6,
        soldCount: 200,
        shopReturnRate: 26,
      },
      image: 'https://img/original.jpg',
      images: [
        'https://img/original.jpg',
        'https://img/one.jpg',
        'https://img/two.jpg',
      ],
    });
  });
});
