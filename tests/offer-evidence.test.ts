import { describe, expect, it } from 'vitest';
import {
  mapConsignmentPayload,
  mapShopCardPayload,
} from '../src/session/offer-evidence.js';
import {
  matchesOfferDetailServiceResponseV1,
  offerSourceCorrelationDiagnosticsV1,
  preferredCanonicalSellerShopUrlV1,
  readOfferCoreConsignmentAbsenceV1,
  readOfferCoreSellerShopUrlAuthorityV1,
  readOfferSourceCorrelationScopeV1,
  resolveOfferSourceCorrelationScopeV1,
} from '../src/commands/offer.js';

describe('offer source response scope', () => {
  it('derives correlation only from the captured request and response identities', () => {
    const requestUrl = `https://h5api.m.1688.com/h5/source/1.0/?data=${encodeURIComponent(JSON.stringify({
      offerId: '100', memberId: 'member-1',
    }))}`;
    expect(readOfferSourceCorrelationScopeV1(requestUrl, {
      data: { offerId: '100', memberId: 'member-1' },
    })).toEqual({ correlatedOfferId: '100', correlatedMemberId: 'member-1' });

    expect(readOfferSourceCorrelationScopeV1(requestUrl, {
      data: { offerId: '999', memberId: 'member-1' },
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: 'member-1' });

    expect(readOfferSourceCorrelationScopeV1(
      'https://h5api.m.1688.com/h5/source/1.0/',
      { data: { value: 'available-without-scope' } },
    )).toEqual({ correlatedOfferId: null, correlatedMemberId: null });

    expect(readOfferSourceCorrelationScopeV1(
      `https://h5api.m.1688.com/h5/source/1.0/?data=${encodeURIComponent(JSON.stringify({
        offerId: '100', loginId: 'member-1',
      }))}`,
      { data: { offerId: '100', sellerLoginId: 'member-1' } },
    )).toEqual({ correlatedOfferId: '100', correlatedMemberId: null });
  });

  it('binds a store-scoped response through the observed offer seller identity', () => {
    const requestUrl = `https://h5api.m.1688.com/h5/source/1.0/?data=${encodeURIComponent(JSON.stringify({
      sellerLoginId: 'seller-login-1',
    }))}`;
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl,
      rawPayload: { data: { model: { shopName: 'Shop' } } },
      observedOfferId: '100',
      observedSellerLoginId: 'seller-login-1',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: '100', correlatedMemberId: 'member-1' });
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl,
      rawPayload: { data: { model: { shopName: 'Shop' } } },
      observedOfferId: '100',
      observedSellerLoginId: 'another-login',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl: 'https://h5api.m.1688.com/h5/source/1.0/',
      rawPayload: { data: { sellerLoginId: 'seller-login-1' } },
      observedOfferId: '100',
      observedSellerLoginId: 'seller-login-1',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl: `https://h5api.m.1688.com/h5/source/1.0/?data=${encodeURIComponent(JSON.stringify({
        offerId: '999', sellerLoginId: 'seller-login-1',
      }))}`,
      rawPayload: {},
      observedOfferId: '100',
      observedSellerLoginId: 'seller-login-1',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: '999', correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl,
      rawPayload: { data: { offerIds: [{ offerId: '100' }, { offerId: '999' }] } },
      observedOfferId: '100',
      observedSellerLoginId: 'seller-login-1',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
  });

  it('binds a shop card through the exact response-owned Store URL', () => {
    const input = {
      requestUrl: 'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/',
      rawPayload: {
        data: { model: { shopUrl: 'https://supplier.1688.com/' } },
      },
      observedOfferId: '100',
      observedSellerLoginId: null,
      observedSellerMemberId: 'member-1',
      observedSellerShopUrl: 'https://supplier.1688.com/',
      allowSellerShopUrlBinding: true,
    };
    expect(resolveOfferSourceCorrelationScopeV1(input)).toEqual({
      correlatedOfferId: '100',
      correlatedMemberId: 'member-1',
    });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      observedSellerShopUrl: 'https://another.1688.com/',
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      allowSellerShopUrlBinding: false,
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      rawPayload: {
        data: {
          model: { shopUrl: 'https://supplier.1688.com/' },
          conflicting: { shopUrl: 'https://another.1688.com/' },
        },
      },
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      rawPayload: {
        data: {
          model: { shopUrl: 'https://supplier.1688.com/' },
          duplicate: { shopUrl: 'https://supplier.1688.com/' },
        },
      },
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      observedSellerLoginId: 'seller-login-1',
      rawPayload: {
        data: {
          model: {
            sellerLoginId: 'another-login',
            shopUrl: 'https://supplier.1688.com/',
          },
        },
      },
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      observedSellerLoginId: 'seller-login-1',
      rawPayload: {
        data: {
          model: { shopUrl: 'https://supplier.1688.com/' },
          identities: [
            { sellerLoginId: 'seller-login-1' },
            { sellerLoginId: 'another-login' },
          ],
        },
      },
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
  });

  it('reports correlation decisions without replayable authority values', () => {
    const observed = {
      observedOfferId: 'offer-secret-100',
      observedSellerLoginId: 'login-secret-1',
      observedSellerMemberId: 'member-secret-1',
      observedSellerShopUrl: 'https://supplier.1688.com/',
      allowSellerShopUrlBinding: true,
    };
    const exactUrl = offerSourceCorrelationDiagnosticsV1({
      ...observed,
      requestUrl: 'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/',
      rawPayload: {
        data: { model: { shopUrl: 'https://supplier.1688.com/' } },
      },
    });
    expect(exactUrl).toMatchObject({
      request: {
        offer: 'none',
        member: 'none',
        login: 'none',
        scopeUnambiguous: true,
        scopeMatchesObserved: true,
        sellerMatched: false,
      },
      response: {
        offer: 'none',
        member: 'none',
        login: 'none',
        scopeUnambiguous: true,
        scopeMatchesObserved: true,
        shopUrlMatched: true,
      },
      predicates: {
        observedMemberPresent: true,
        observedShopUrlPresent: true,
        urlBranchEligible: true,
        loginBranchEligible: false,
      },
    });

    const requestMismatch = offerSourceCorrelationDiagnosticsV1({
      ...observed,
      requestUrl:
        'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/'
        + `?data=${encodeURIComponent(JSON.stringify({
          offerId: 'other-offer',
          memberId: 'other-member',
        }))}`,
      rawPayload: {
        data: { model: { shopUrl: 'https://supplier.1688.com/' } },
      },
    });
    expect(requestMismatch.request).toMatchObject({
      offer: 'mismatch',
      member: 'mismatch',
      scopeUnambiguous: true,
      scopeMatchesObserved: false,
    });
    expect(requestMismatch.predicates.urlBranchEligible).toBe(false);

    const responseConflict = offerSourceCorrelationDiagnosticsV1({
      ...observed,
      requestUrl: 'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/',
      rawPayload: {
        data: {
          model: {
            shopUrl: 'https://supplier.1688.com/',
            loginId: 'login-secret-1',
          },
          other: { sellerLoginId: 'other-login' },
        },
      },
    });
    expect(responseConflict.response).toMatchObject({
      login: 'conflict',
      scopeUnambiguous: false,
      scopeMatchesObserved: true,
      shopUrlMatched: true,
    });
    expect(responseConflict.predicates.urlBranchEligible).toBe(false);

    const serialized = JSON.stringify({ exactUrl, requestMismatch, responseConflict });
    for (const secret of [
      'offer-secret-100',
      'member-secret-1',
      'login-secret-1',
      'other-offer',
      'other-member',
      'other-login',
      'supplier.1688.com',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps response-owned Store URL authority separate from request identities', () => {
    const input = {
      requestUrl:
        'https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/'
        + `?data=${encodeURIComponent(JSON.stringify({
          offerId: 'request-offer',
          memberId: 'request-member',
        }))}`,
      rawPayload: {
        data: { model: { shopUrl: 'https://supplier.1688.com/' } },
      },
      observedOfferId: '100',
      observedSellerLoginId: null,
      observedSellerMemberId: 'member-1',
      observedSellerShopUrl: 'https://supplier.1688.com/',
      allowSellerShopUrlBinding: true,
    };
    expect(resolveOfferSourceCorrelationScopeV1(input)).toEqual({
      correlatedOfferId: 'request-offer',
      correlatedMemberId: 'request-member',
    });
    expect(resolveOfferSourceCorrelationScopeV1({
      ...input,
      rawPayload: {
        data: {
          model: {
            memberId: 'response-member-conflict',
            shopUrl: 'https://supplier.1688.com/',
          },
        },
      },
    })).toEqual({
      correlatedOfferId: 'request-offer',
      correlatedMemberId: null,
    });
    expect(resolveOfferSourceCorrelationScopeV1({
      requestUrl: `https://h5api.m.1688.com/h5/source/1.0/?data=${encodeURIComponent(JSON.stringify({
        sellerLoginId: 'seller-login-1',
      }))}`,
      rawPayload: { data: { sellerLoginId: 'another-login' } },
      observedOfferId: '100',
      observedSellerLoginId: 'seller-login-1',
      observedSellerMemberId: 'member-1',
    })).toEqual({ correlatedOfferId: null, correlatedMemberId: null });
  });

  it('prefers canonical Seller shop authority over a mobile winport URL', () => {
    expect(preferredCanonicalSellerShopUrlV1({
      sellerWinportUrl: 'https://shop97766603w5446.1688.com/',
      sellerWinportUrlMapDefaultUrl: 'https://shop97766603w5446.1688.com/',
      winportUrl:
        'https://winport.m.1688.com/page/index.html?memberId=b2b-32168485931208e',
    })).toBe('https://shop97766603w5446.1688.com/');
    expect(preferredCanonicalSellerShopUrlV1({
      sellerWinportUrl: null,
      sellerWinportUrlMapDefaultUrl: 'https://shop97766603w5446.1688.com/',
      winportUrl:
        'https://winport.m.1688.com/page/index.html?memberId=b2b-32168485931208e',
    })).toBe('https://shop97766603w5446.1688.com/');
    expect(preferredCanonicalSellerShopUrlV1({
      sellerWinportUrl: null,
      sellerWinportUrlMapDefaultUrl: null,
      winportUrl:
        'https://winport.m.1688.com/page/index.html?memberId=b2b-32168485931208e',
    })).toBeNull();
  });

  it('recovers exact Seller shop authority from the identity-bound Offer core', () => {
    const rawPayload = {
      contextResult: {
        data: { gallery: { fields: { offerId: '100' } } },
        global: { globalData: { model: { sellerModel: {
          memberId: 'member-1',
          loginId: 'seller-login-1',
          sellerWinportUrl: null,
          sellerWinportUrlMap: {
            defaultUrl: 'https://supplier.1688.com/',
          },
          winportUrl:
            'https://winport.m.1688.com/page/index.html?memberId=member-1',
        } } } },
      },
    };
    expect(readOfferCoreSellerShopUrlAuthorityV1(
      rawPayload,
      '100',
      'member-1',
      'seller-login-1',
    )).toBe('https://supplier.1688.com/');
    expect(readOfferCoreSellerShopUrlAuthorityV1(
      rawPayload,
      '999',
      'member-1',
      'seller-login-1',
    )).toBeNull();
    expect(readOfferCoreSellerShopUrlAuthorityV1(
      rawPayload,
      '100',
      'member-2',
      'seller-login-1',
    )).toBeNull();
    expect(readOfferCoreSellerShopUrlAuthorityV1(
      rawPayload,
      '100',
      'member-1',
      'another-login',
    )).toBeNull();
    expect(readOfferCoreSellerShopUrlAuthorityV1({
      ...rawPayload,
      contextResult: {
        ...rawPayload.contextResult,
        global: { globalData: { model: { sellerModel: {
          memberId: 'member-1',
          loginId: 'seller-login-1',
          sellerWinportUrl: 'https://supplier.1688.com/',
          sellerWinportUrlMap: {
            defaultUrl: 'https://conflicting-supplier.1688.com/',
          },
        } } } },
      },
    }, '100', 'member-1', 'seller-login-1')).toBeNull();
  });

  it('derives consignment not-present only from exact Offer core authority', () => {
    const rawPayload = {
      contextResult: {
        data: { gallery: { fields: { offerId: '100' } } },
        global: { globalData: { model: {
          sellerModel: { memberId: 'member-1' },
          consignModel: {
            consignOffer: false,
            hasConsignPrice: false,
            consignSign: {
              supportConsignIssuing: false,
              signs: { isSupportConsignIssuing: false },
            },
          },
        } } },
      },
    };
    expect(readOfferCoreConsignmentAbsenceV1(
      rawPayload,
      '100',
      'member-1',
    )).toMatchObject({
      authoritySource: 'offer-core',
      responseObserved: false,
      responseSucceeded: false,
      correlatedOfferId: '100',
      correlatedMemberId: 'member-1',
      authoritativeEmpty: {
        sourcePath: 'contextResult.global.globalData.model.consignModel.consignOffer',
        sourceValue: false,
        reasonCode: 'CONSIGNMENT_CORE_DECLARED_UNSUPPORTED',
      },
    });
    expect(readOfferCoreConsignmentAbsenceV1(rawPayload, '100', 'member-2')).toBeNull();
    expect(readOfferCoreConsignmentAbsenceV1({
      ...rawPayload,
      contextResult: {
        ...rawPayload.contextResult,
        global: { globalData: { model: {
          sellerModel: { memberId: 'member-1' },
          consignModel: {
            consignOffer: true,
            hasConsignPrice: false,
            consignSign: {
              supportConsignIssuing: false,
              signs: { isSupportConsignIssuing: false },
            },
          },
        } } },
      },
    }, '100', 'member-1')).toBeNull();
  });

  it('recognizes a percent-encoded offer detail service request exactly', () => {
    const requestUrl = `https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/?data=${encodeURIComponent(JSON.stringify({
      mmgaRequest: { serviceName: 'offerPCConsignInfoService' },
    }))}`;
    expect(matchesOfferDetailServiceResponseV1(
      requestUrl,
      'offerPCConsignInfoService',
    )).toBe(true);
    expect(matchesOfferDetailServiceResponseV1(
      requestUrl,
      'anotherService',
    )).toBe(false);
    expect(matchesOfferDetailServiceResponseV1(
      'https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/?serviceName=offerPCConsignInfoService',
      'offerPCConsignInfoService',
    )).toBe(true);
    expect(matchesOfferDetailServiceResponseV1(
      `https://example.com/?next=${encodeURIComponent(requestUrl)}`,
      'offerPCConsignInfoService',
    )).toBe(false);
  });
});

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
