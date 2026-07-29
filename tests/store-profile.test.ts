import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  mapStoreProfilePayload,
  storeProfileEvidence,
} from '../src/session/store-profile.js';

describe('mapStoreProfilePayload', () => {
  it('maps a backwards-compatible shop-card and marks source-absent location fields explicitly', async () => {
    const payload = JSON.parse(
      await readFile(
        new URL('./fixtures/store-profile/basic.json', import.meta.url),
        'utf8',
      ),
    );
    const profile = mapStoreProfilePayload(
      payload,
      '2026-07-28T00:00:00.000Z',
      {
        sourceRef: 'fixture:store-profile',
        rawRef: 'artifact:store-profile/basic',
      },
    );

    expect(profile).toMatchObject({
      name: {
        availability: 'available',
        value: '脱敏电动工具商行',
      },
      shopUrl: {
        availability: 'available',
        value: 'https://fixture-profile.1688.com',
      },
      mainCategoryName: {
        availability: 'available',
        value: '电动工具',
      },
      years: { availability: 'available', value: 3 },
      followersText: { availability: 'available', value: '145粉丝' },
      serviceScore: { availability: 'available', value: 4 },
      returnRate: { availability: 'available', value: 0.27 },
      shopTags: { availability: 'not-present', value: null },
      region: {
        availability: 'not-present',
        value: null,
      },
      address: {
        availability: 'not-present',
        value: null,
      },
      source: {
        sourceType: 'supplier-payload',
        api: 'mtop.1688.moga.pc.shopcard',
        sourceRef: 'fixture:store-profile',
        rawRef: 'artifact:store-profile/basic',
        parserVersion: 'store-profile-v1',
      },
    });
    expect(profile.metrics).toMatchObject({
      availability: 'available',
      value: expect.arrayContaining([
        expect.objectContaining({ key: '店铺服务分', value: 4 }),
      ]),
    });
    expect(profile.warnings).toEqual([]);
  });

  it('maps the Store-page common header including location and trust evidence', async () => {
    const payload = JSON.parse(
      await readFile(
        new URL(
          './fixtures/store-profile/common-header.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const profile = mapStoreProfilePayload(
      payload,
      '2026-07-28T00:00:00.000Z',
      { sourceRef: 'capture:store-profile/common-header' },
    );

    expect(profile).toMatchObject({
      name: {
        availability: 'available',
        value: '脱敏五金工具有限公司',
      },
      shopUrl: {
        availability: 'available',
        value: 'https://fixture-profile.1688.com/page/index.html',
      },
      shopType: {
        availability: 'available',
        value: 'shili_factory',
      },
      mainCategoryName: {
        availability: 'available',
        value: '五金、工具',
      },
      years: { availability: 'available', value: 4 },
      isFollowing: { availability: 'available', value: false },
      followersText: { availability: 'available', value: '1.3w' },
      returnRate: { availability: 'available', value: 0.315 },
      serviceScore: { availability: 'available', value: 4.5 },
      positiveReviewRate: {
        availability: 'available',
        value: 0.986,
      },
      companyId: {
        availability: 'available',
        value: 'fixture-company-001',
      },
      companyLabel: {
        availability: 'available',
        value: '深度认证',
      },
      factoryAuthText: {
        availability: 'available',
        value: '深度认证 编号:SANITIZED-001',
      },
      region: {
        availability: 'available',
        value: '浙江省 杭州市',
      },
      address: {
        availability: 'available',
        value: '浙江省杭州市示例区脱敏路 88 号',
      },
      source: {
        api: 'mtop.alibaba.alisite.cbu.server.moduleasyncservice',
        componentKey: 'wp_pc_common_header',
        fieldPath: 'data.data',
      },
    });
    expect(profile.metrics).toMatchObject({
      availability: 'available',
      value: expect.arrayContaining([
        expect.objectContaining({
          key: 'goodRate',
          value: 98.6,
          unit: '%',
        }),
      ]),
    });
    expect(profile.onTimeDeliveryRate.availability).toBe('available');
    expect(profile.onTimeDeliveryRate.value).toBeCloseTo(0.942);
    expect(profile.companyIcons).toMatchObject({
      availability: 'available',
      value: [
        {
          title: '质量保障',
          link: 'https://fixture-profile.1688.com/page/quality.html',
        },
      ],
    });
    expect(profile.serviceScores).toMatchObject({
      availability: 'available',
      value: expect.arrayContaining([
        { key: '售后体验', label: '售后体验', score: 4.2 },
      ]),
    });
    expect(
      storeProfileEvidence(profile).some(
        (entry) => entry.evidence.availability === 'not-collected',
      ),
    ).toBe(false);
  });

  it('marks an unrecognized payload as failed instead of claiming absent fields', () => {
    const profile = mapStoreProfilePayload(
      { ret: ['FAIL_SYS::sanitized failure'] },
      '2026-07-28T01:00:00.000Z',
    );
    const availability = new Map(
      storeProfileEvidence(profile).map((entry) => [
        entry.field,
        entry.evidence.availability,
      ]),
    );

    expect(availability.get('name')).toBe('failed');
    expect(availability.get('shopUrl')).toBe('failed');
    expect(availability.get('region')).toBe('failed');
    expect(profile.warnings[0]).toMatchObject({
      code: 'STORE_PROFILE_DATA_MISSING',
      fieldPath: 'data',
    });
  });

  it('preserves legacy shop-card trust fields through the shared mapper', () => {
    const profile = mapStoreProfilePayload({
      data: {
        companyName: '脱敏工具有限公司',
        companyId: 37712893,
        companyLabel: '实力商家',
        retentionRate: '0.40',
        companyIcons: [
          {
            title: '买家保障',
            link: '//page.example.test/buyer.html',
          },
        ],
        factoryInfo: {
          shopTag: [{ text: 'ISO 9000认证' }],
        },
        appData: {
          serviceList: [
            { serviceKey: 'lgt_group_value_new', score: '4.0' },
          ],
        },
      },
    });

    expect(profile.companyId).toMatchObject({
      availability: 'available',
      value: '37712893',
    });
    expect(profile.companyIcons).toMatchObject({
      availability: 'available',
      value: [
        {
          title: '买家保障',
          link: 'https://page.example.test/buyer.html',
        },
      ],
    });
    expect(profile.shopTags).toMatchObject({
      availability: 'available',
      value: ['ISO 9000认证'],
    });
    expect(profile.serviceScores).toMatchObject({
      availability: 'available',
      value: [
        {
          key: 'lgt_group_value_new',
          label: 'logistics',
          score: 4,
        },
      ],
    });
  });
});
