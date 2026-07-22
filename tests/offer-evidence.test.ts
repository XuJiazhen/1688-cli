import { describe, expect, it } from 'vitest';
import {
  mapConsignmentPayload,
  mapShopCardPayload,
} from '../src/session/offer-evidence.js';

describe('shop-card evidence', () => {
  it('maps the modern shop card and normalizes percentage metrics to ratios', () => {
    const shop = mapShopCardPayload({
      data: {
        model: {
          iconType: 'cjgc_global',
          mainCategoryName: '电动工具',
          shopButton: {
            attentionRelation: false,
            fuzzyFavCount: '145粉丝',
            type: 'ATTENTION',
          },
          shopData: [
            { dataKey: '店铺回头率', dataValue: '27%' },
            { dataKey: '店铺服务分', dataValue: '4.0', unit: '分' },
            { dataKey: '准时发货率', dataValue: '96%' },
            { dataKey: '店铺好评率', dataValue: '99.5%' },
          ],
          shopName: '永康市旭珺工贸有限公司',
          shopType: 'cjgc',
          shopUrl: 'https://example.1688.com',
          tpYear: 1,
        },
      },
    });

    expect(shop).toMatchObject({
      name: '永康市旭珺工贸有限公司',
      shopType: 'cjgc',
      iconType: 'cjgc_global',
      badge: { code: 'cjgc_global', label: '超级工厂全球供' },
      mainCategoryName: '电动工具',
      years: 1,
      attention: { isFollowing: false, followersText: '145粉丝' },
      returnRate: 0.27,
      serviceScore: 4,
      onTimeDeliveryRate: 0.96,
      positiveReviewRate: 0.995,
    });
    expect(shop?.metrics).toHaveLength(4);
  });

  it('recognizes known badge codes, keeps no-badge shops empty, and preserves unknown codes', () => {
    const shop = (iconType?: string) =>
      mapShopCardPayload({
        data: {
          model: {
            ...(iconType ? { iconType } : {}),
            shopName: '样本店铺',
          },
        },
      });

    expect(shop('slsj')?.badge?.label).toBe('实力商家');
    expect(shop('ytqj')?.badge?.label).toBe('源头旗舰');
    expect(shop()?.badge).toBeNull();
    expect(shop('future_shop_type')?.badge).toEqual({
      code: 'future_shop_type',
      label: null,
      imageUrl: null,
    });
  });
});

describe('consignment evidence', () => {
  it('maps one-piece consignment prices, metrics, protections, and channels', () => {
    const requestUrl = `https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/?data=${encodeURIComponent(
      JSON.stringify({
        mmgaRequest: {
          serviceName: 'offerPCConsignInfoService',
          offerModelSign: {
            isOnePsale: true,
            isCrossBorderOffer: true,
            nonBooleanField: 'ignored',
          },
        },
      }),
    )}`;
    const consignment = mapConsignmentPayload(
      {
        data: {
          data: {
            data: {
              name: '密文代发',
              adviseList: [
                {
                  key: 'orderCnt30d',
                  name: '近30天代发数量',
                  value: '100以内',
                },
                {
                  key: 'offerDelivery48hRate',
                  name: '48h揽收率',
                  value: '100.00%',
                },
                {
                  key: 'offerDelivery24hRate',
                  name: '24h揽收率',
                  value: '89.00%',
                },
                {
                  key: 'offerPublishDate',
                  name: '商品发布时间',
                  value: '2024年5月',
                },
              ],
              priceInfoList: [{ price: '39.9', text: '1件价格' }],
              operateButtonList: [
                {
                  name: '代发下单',
                  operateType: 'DX_ORDER',
                  operateDisplayStatus: 'DX_ORDER',
                  buttonType: 'normal',
                },
              ],
              protectionInfoList: [
                {
                  serviceName: '官方仓退货',
                  description: '退货仓保障',
                  actions: [{ text: '去开通', url: '//example.com/open' }],
                },
              ],
              supportList: [
                {
                  name: '淘宝(菜鸟)',
                  icon: 'https://img.example/channel.png',
                },
              ],
            },
          },
        },
      },
      requestUrl,
    );

    expect(consignment).toMatchObject({
      name: '密文代发',
      offerFlags: { isOnePsale: true, isCrossBorderOffer: true },
      orderCount30dText: '100以内',
      delivery24hRate: 0.89,
      delivery48hRate: 1,
      offerPublishedAtText: '2024年5月',
      minimumQuantity: 1,
      onePieceEligible: true,
      onePiecePrice: 39.9,
    });
    expect(consignment?.operations[0]?.operationType).toBe('DX_ORDER');
    expect(consignment?.protections[0]?.actions[0]?.url).toBe(
      'https://example.com/open',
    );
    expect(consignment?.supportedChannels[0]?.name).toBe('淘宝(菜鸟)');
  });

  it('does not mistake a two-piece consignment tier for one-piece support', () => {
    const consignment = mapConsignmentPayload({
      data: {
        data: {
          data: {
            data: {
              name: '分销代发',
              priceInfoList: [{ price: '51', text: '>=2件价格' }],
            },
          },
        },
      },
    });

    expect(consignment).toMatchObject({
      minimumQuantity: 2,
      onePieceEligible: false,
      onePiecePrice: null,
    });
    expect(mapConsignmentPayload({ data: { data: { data: {} } } })).toBeNull();
  });
});
