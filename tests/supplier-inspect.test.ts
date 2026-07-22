import { describe, expect, it } from 'vitest';
import {
  assembleSupplierInspectResult,
  mapFactoryCardPayload,
  mapShopCardPayload,
  normalizeSupplierTarget,
  parseAvailableOfferCount,
} from '../src/commands/supplier-inspect.js';

describe('supplier inspect helpers', () => {
  it('normalizes supported supplier targets', () => {
    expect(normalizeSupplierTarget('628196518518')).toMatchObject({
      type: 'offerId',
      offerId: '628196518518',
      memberId: null,
    });
    expect(
      normalizeSupplierTarget('https://detail.1688.com/offer/628196518518.html'),
    ).toMatchObject({
      type: 'offerId',
      offerId: '628196518518',
    });
    expect(normalizeSupplierTarget('b2b-22066467246504ba0d')).toMatchObject({
      type: 'memberId',
      memberId: 'b2b-22066467246504ba0d',
    });
    expect(
      normalizeSupplierTarget(
        'https://sale.1688.com/factory/card.html?memberId=b2b-22066467246504ba0d',
      ),
    ).toMatchObject({
      type: 'memberId',
      memberId: 'b2b-22066467246504ba0d',
    });
  });

  it('rejects loginId-only input', () => {
    expect(() => normalizeSupplierTarget('前海狼途实业')).toThrow(
      'loginId-only lookup is not reliable yet',
    );
  });

  it('maps shopcard and factory-card payloads', () => {
    const shopCard = mapShopCardPayload({
      data: {
        companyName: '深圳狼途实业科技有限公司',
        companyId: 37712893,
        companyLabel: '实力商家',
        retentionRate: '0.40',
        companyIcons: [{ title: '买家保障', link: '//page.1688.com/buyer.html' }],
        factoryInfo: {
          shopTag: [{ text: 'ISO 9000认证' }, { text: 'AAA诚信等级' }],
          shopProperty: {
            authText: '由TUV机构深度认证',
            pcLinkUrl:
              'https://sale.1688.com/factory/card.html?memberId=b2b-22066467246504ba0d',
          },
        },
        appData: {
          serviceList: [
            { serviceKey: 'lgt_group_value_new', score: '4.0' },
            { serviceKey: 'goods_group_value', score: '3.7' },
          ],
        },
      },
    });
    expect(shopCard).toMatchObject({
      name: '深圳狼途实业科技有限公司',
      companyId: '37712893',
      companyLabel: '实力商家',
      returnRate: 0.4,
      shopTags: ['ISO 9000认证', 'AAA诚信等级'],
    });
    expect(shopCard?.companyIcons[0]).toMatchObject({
      title: '买家保障',
      link: 'https://page.1688.com/buyer.html',
    });
    expect(shopCard?.serviceScores.map((x) => [x.label, x.score])).toEqual([
      ['logistics', 4],
      ['goods', 3.7],
    ]);

    const factory = mapFactoryCardPayload({
      data: {
        result: {
          name: '深圳狼途实业科技有限公司',
          loginId: '前海狼途实业',
          memberId: 'b2b-22066467246504ba0d',
          shopPcWpIndexUrl: 'https://shop22z83403cs673.1688.com',
          tpYears: '7',
          medalLevel: '4',
          factory3rdPartyAuthProvider: 'tuv',
          companyYearStarted: '2016年10月19日',
          location: '深圳',
          factoryDetailedAddress: '广东深圳沙井西环西部工业区西一栋',
          factoryLatitude: '22.752427',
          factoryLongitude: '113.836712',
          productionService: '键盘;机械鼠标;光电鼠标',
          employeeData: { workerNum2: '51~100人', deepWorkerNum2: '12' },
          highQualityTagList: [{ text: '深圳数码' }],
          fcProcessTag: [{ name: '来样加工' }],
        },
      },
    });
    expect(factory).toMatchObject({
      name: '深圳狼途实业科技有限公司',
      loginId: '前海狼途实业',
      memberId: 'b2b-22066467246504ba0d',
      tpYears: 7,
      latitude: 22.752427,
      longitude: 113.836712,
      employeeScale: '51~100人',
      workerCount: '12',
      tags: ['深圳数码', '来样加工'],
    });
  });

  it('maps current shopcard data.model fields used by detail pages', () => {
    const shopCard = mapShopCardPayload({
      data: {
        model: {
          iconType: 'slsj',
          mainCategoryName: '电动工具',
          shopData: [
            { dataKey: '店铺回头率', dataValue: '29%' },
            { dataKey: '准时发货率', dataValue: '99%' },
          ],
          shopName: '南通发财树工具有限公司',
          shopType: 'slsj',
          shopUrl: 'https://tiaisjd.1688.com',
          tpYear: 4,
        },
      },
    });

    expect(shopCard).toMatchObject({
      name: '南通发财树工具有限公司',
      badge: { code: 'slsj', label: '实力商家' },
      mainCategoryName: '电动工具',
      years: 4,
      returnRate: 0.29,
      onTimeDeliveryRate: 0.99,
    });
  });

  it('assembles supplier inspect output with source metadata', () => {
    const shopCard = mapShopCardPayload({
      data: {
        companyName: '深圳狼途实业科技有限公司',
        factoryInfo: { shopTag: [{ text: 'CCC认证' }] },
      },
    });
    const factory = mapFactoryCardPayload({
      data: {
        result: {
          name: '深圳狼途实业科技有限公司',
          loginId: '前海狼途实业',
          memberId: 'b2b-22066467246504ba0d',
          shopPcWpIndexUrl: 'https://shop22z83403cs673.1688.com',
          tpYears: '7',
          productionService: '键盘;机械鼠标',
        },
      },
    });
    const result = assembleSupplierInspectResult({
      target: {
        input: '628196518518',
        type: 'offerId',
        offerId: '628196518518',
        memberId: 'b2b-22066467246504ba0d',
      },
      offerProbe: {
        offerUrl: 'https://detail.1688.com/offer/628196518518.html',
        seller: {
          name: '深圳狼途实业科技有限公司',
          loginId: '前海狼途实业',
          memberId: 'b2b-22066467246504ba0d',
          userId: '2206646724650',
          identity: 'slsj',
          signs: { isFactoryDealer: true },
          shopUrl: 'https://shop22z83403cs673.1688.com',
          shopUrls: {},
        },
        shopCard,
        shopcardCaptured: true,
      } as never,
      factoryProbe: {
        factoryCardUrl:
          'https://sale.1688.com/factory/card.html?memberId=b2b-22066467246504ba0d',
        factory,
        availableOfferCount: 34,
        factoryCardCaptured: true,
      } as never,
    });

    expect(result.supplier).toMatchObject({
      name: '深圳狼途实业科技有限公司',
      loginId: '前海狼途实业',
      memberId: 'b2b-22066467246504ba0d',
      userId: '2206646724650',
      shopUrl: 'https://shop22z83403cs673.1688.com',
    });
    expect(result.factory).toMatchObject({
      isFactory: true,
      tpYears: 7,
      productionService: '键盘;机械鼠标',
      tags: ['CCC认证'],
    });
    expect(result.offers).toEqual({
      availableCount: 34,
      source: 'factory-card-dom',
    });
    expect(result.sources).toMatchObject({
      shopcardCaptured: true,
      factoryCardCaptured: true,
    });
  });

  it('parses visible factory-card offer count', () => {
    expect(parseAvailableOfferCount('工厂店 共34个商品 全部')).toBe(34);
    expect(parseAvailableOfferCount('暂无商品')).toBeNull();
  });
});
