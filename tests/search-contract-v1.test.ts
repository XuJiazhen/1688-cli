import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSearchSerializerCapabilitySnapshotV1,
  parseSearchFilterConfigSnapshotV1,
  resolveSearchIntentV1,
  type SearchIntentV1,
} from '../src/session/search-contract.js';
import {
  assertCapturedSearchRequestParityV1,
  assertSearchPageDerivationV1,
  compileSearchPageRequestV1,
  compileSearchParameterSetV1,
  verifyParameterSetHash,
} from '../src/session/search-compiler.js';

const NOW = '2026-07-31T00:00:00.000Z';
const LATER = '2026-08-01T00:00:00.000Z';

function snapshot() {
  return parseSearchFilterConfigSnapshotV1({
    snapshotId: 'filter-snapshot-1',
    keyword: '灭火器',
    observedAt: NOW,
    expiresAt: LATER,
    payload: {
      data: { data: { filterData: {
        filtbarBottom: [], filtbarLeft: [], filtbarRight: [],
        filters: [
          { groupName: '商家特色', children: [
            { label: '实力商家', urlKey: 'filtMemberTags', value: '5179713,5125953', filterId: 'power', isMultiple: true },
            { label: '深度验厂', urlKey: 'filtMemberTags', value: '3938689', filterId: 'factory', isMultiple: true },
          ] },
          { groupName: '动态属性', children: [
            { label: '红色', urlKey: 'featurePair', value: '1995:33711371', filterId: 'red', isMultiple: true },
            { label: '蓝色', urlKey: 'featurePair', value: '1995:4081', filterId: 'blue', isMultiple: true },
          ] },
          { groupName: '位置', children: [
            { label: '广州', urlKey: 'city', value: '广州', filterId: 'gz', parentRequestContext: { province: '广东' } },
          ] },
          { groupName: '经营模式', children: [
            { label: '生产加工', urlKey: 'bizType', value: '1', filterId: 'biz-1', isMultiple: true },
            { label: '经销批发', urlKey: 'bizType', value: '2', filterId: 'biz-2', isMultiple: true },
          ] },
          { groupName: '数值筛选', children: [
            { label: '最低价', urlKey: 'priceStart', type: 'decimal' },
            { label: '最高价', urlKey: 'priceEnd', type: 'decimal' },
            { label: '起订量', urlKey: 'quantityBegin', type: 'integer' },
            { label: '店铺商品数下限', urlKey: 'shopCountStart', type: 'integer' },
            { label: '店铺商品数上限', urlKey: 'shopCountEnd', type: 'integer' },
          ] },
        ],
      } } },
    },
  });
}

function capabilities(enabled = true) {
  return createSearchSerializerCapabilitySnapshotV1({
    snapshotId: 'serializer-snapshot-1',
    observedAt: NOW,
    expiresAt: LATER,
    capabilities: [
      ['filtMemberTags.multi', 'semicolon-atoms-v1'],
      ['featurePair.multi', 'feature-pair-grouped-v1'],
      ['bizType.multi', 'semicolon-atoms-v1'],
    ].map(([capability, serializerRevision]) => ({
      capability: capability!, serializerRevision: serializerRevision!,
      discovered: true, fixtureVerified: true,
      liveCaptureVerified: enabled,
      captureReceiptId: enabled ? `receipt-${capability}` : null,
      enabledForCompile: enabled,
    })),
  });
}

function intent(overrides: Partial<SearchIntentV1> = {}): SearchIntentV1 {
  const filterSnapshot = snapshot();
  return {
    keyword: '灭火器',
    filterConfigSnapshotHash: filterSnapshot.snapshotHash,
    sort: 'sales',
    selections: [
      { groupPath: ['filters', '商家特色'], label: '实力商家', filterId: 'power' },
      { groupPath: ['filters', '商家特色'], label: '深度验厂', filterId: 'factory' },
      { groupPath: ['filters', '动态属性'], label: '红色', filterId: 'red' },
      { groupPath: ['filters', '动态属性'], label: '蓝色', filterId: 'blue' },
      { groupPath: ['filters', '位置'], label: '广州', filterId: 'gz' },
    ],
    numeric: { priceStart: '01.50', priceEnd: '10.00', quantityBegin: '01' },
    maxPages: 3,
    maxOffers: 120,
    advertisementPolicy: 'exclude-p4p',
    ...overrides,
  };
}

describe('Search Contract Resolver and Compiler V1', () => {
  it('discovers the live sortType catalog with its exact supported directions', () => {
    const parsed = parseSearchFilterConfigSnapshotV1({
      snapshotId: 'live-sort-catalog-1', keyword: '暖炉',
      observedAt: NOW, expiresAt: LATER,
      payload: { data: { data: { filterData: {
        filtbarBottom: [
          { label: '综合', type: 'sort', urlKey: 'sortType', value: 'normal', supportAsc: 'false', supportDesc: 'true' },
          { label: '销量', type: 'sort', urlKey: 'sortType', value: 'va_sales360', supportAsc: 'false', supportDesc: 'true' },
          { label: '价格', type: 'sort', urlKey: 'sortType', value: 'price', supportAsc: 'true', supportDesc: 'true' },
        ],
        filtbarLeft: [], filtbarRight: [],
        filters: [{ label: '起订量', type: 'quantityBegin', urlKey: 'quantityBegin' }],
      } } } },
    });
    expect(parsed.sortNodes).toEqual([
      { label: '综合', sortType: 'normal', descendOrder: true },
      { label: '销量', sortType: 'va_sales360', descendOrder: true },
      { label: '价格', sortType: 'price', descendOrder: false },
      { label: '价格', sortType: 'price', descendOrder: true },
    ]);
  });

  it('resolves opaque atoms and all typed numeric/parent keys against one snapshot', () => {
    const filterSnapshot = snapshot();
    const resolved = resolveSearchIntentV1({
      intent: intent({ filterConfigSnapshotHash: filterSnapshot.snapshotHash }),
      filterSnapshot,
      capabilitySnapshot: capabilities(),
      now: NOW,
    });
    expect(resolved).toMatchObject({
      sort: 'sales',
      filterParams: {
        filtMemberTags: '5179713,5125953;3938689',
        featurePair: '1995:33711371,1995:4081',
        province: '广东', city: '广州',
        priceStart: '1.5', priceEnd: '10', quantityBegin: '1',
      },
    });
  });

  it('fails closed for an unactivated multi-value serializer while single value remains legal', () => {
    const filterSnapshot = snapshot();
    expect(() => resolveSearchIntentV1({
      intent: intent({
        filterConfigSnapshotHash: filterSnapshot.snapshotHash,
        selections: [
          { groupPath: ['filters', '经营模式'], label: '生产加工' },
          { groupPath: ['filters', '经营模式'], label: '经销批发' },
        ],
      }),
      filterSnapshot,
      capabilitySnapshot: capabilities(false),
      now: NOW,
    })).toThrow(/not enabled/i);

    expect(resolveSearchIntentV1({
      intent: intent({
        filterConfigSnapshotHash: filterSnapshot.snapshotHash,
        selections: [{ groupPath: ['filters', '经营模式'], label: '生产加工' }],
      }),
      filterSnapshot,
      capabilitySnapshot: capabilities(false),
      now: NOW,
    }).filterParams.bizType).toBe('1');
  });

  it.each([
    ['relevance', 'normal', true],
    ['sales', 'va_sales360', true],
    ['price-desc', 'price', true],
    ['price-asc', 'price', false],
  ] as const)('maps %s only to the frozen current protocol', (sort, sortType, descendOrder) => {
    const filterSnapshot = snapshot();
    const resolved = resolveSearchIntentV1({
      intent: intent({ sort, filterConfigSnapshotHash: filterSnapshot.snapshotHash }),
      filterSnapshot,
      capabilitySnapshot: capabilities(),
      now: NOW,
    });
    const compiled = compileSearchParameterSetV1(resolved);
    expect(compiled).toMatchObject({ sortType, descendOrder });
    expect(JSON.stringify(compiled)).not.toMatch(/va_rmdarkgmv30|va_price_(?:asc|desc)/);
  });

  it('derives page 2 by changing only beginPage and validates captured request parity', () => {
    const filterSnapshot = snapshot();
    const parameterSet = compileSearchParameterSetV1(resolveSearchIntentV1({
      intent: intent({ filterConfigSnapshotHash: filterSnapshot.snapshotHash }),
      filterSnapshot, capabilitySnapshot: capabilities(), now: NOW,
    }));
    const page1 = compileSearchPageRequestV1({ parameterSet, page: 1, pageSessionId: 'page-session-1' });
    const page2 = compileSearchPageRequestV1({ parameterSet, page: 2, pageSessionId: 'page-session-1' });
    expect(page1.navigationUrl).toContain('keywords=%C3%F0%BB%F0%C6%F7');
    expect(page1.navigationUrl).not.toContain('keywords=%25C3%25F0');
    expect(() => assertSearchPageDerivationV1(page1, page2)).not.toThrow();
    expect(() => assertCapturedSearchRequestParityV1({
      compiled: page2,
      captured: {
        appId: '32517', method: 'getOfferList',
        keywords: page2.params.keywords as string,
        beginPage: '2', pageSize: 60, pageId: 'page-session-1',
        sortType: 'va_sales360', descendOrder: true,
        filterParams: Object.fromEntries(Object.entries(parameterSet.filterParams)),
      },
    })).not.toThrow();
    expect(() => assertCapturedSearchRequestParityV1({
      compiled: page2,
      captured: {
        appId: '32517', method: 'getOfferList', keywords: page2.params.keywords as string,
        beginPage: '2', pageSize: 60, pageId: 'page-session-1',
        sortType: 'normal', descendOrder: true, filterParams: {},
      },
    })).toThrow(/differs/i);
  });

  it('keeps parameter compilation deterministic under option replay', () => {
    const filterSnapshot = snapshot();
    const hashes = new Set<string>();
    for (let index = 0; index < 100; index++) {
      hashes.add(compileSearchParameterSetV1(resolveSearchIntentV1({
        intent: intent({ filterConfigSnapshotHash: filterSnapshot.snapshotHash }),
        filterSnapshot, capabilitySnapshot: capabilities(), now: NOW,
      })).parameterSetHash);
    }
    expect(hashes.size).toBe(1);
  });

  it('fails closed when a numeric input was not discovered in the frozen catalog', () => {
    const filterSnapshot = parseSearchFilterConfigSnapshotV1({
      snapshotId: 'filter-snapshot-without-price-end',
      keyword: '暖炉',
      observedAt: NOW,
      expiresAt: LATER,
      payload: { data: { data: { filterData: {
        filtbarBottom: [], filtbarLeft: [], filtbarRight: [],
        filters: [
          { groupName: '商家特色', children: [
            { label: '一件代发', urlKey: 'filtOfferTags', value: 'opaque-drop-ship' },
          ] },
          { groupName: '数值筛选', children: [
            { label: '最低价', urlKey: 'priceStart', type: 'decimal' },
          ] },
        ],
      } } } },
    });
    expect(() => resolveSearchIntentV1({
      intent: {
        ...intent({
          keyword: '暖炉',
          filterConfigSnapshotHash: filterSnapshot.snapshotHash,
          selections: [],
        }),
        numeric: { priceEnd: '100' },
      },
      filterSnapshot,
      capabilitySnapshot: capabilities(),
      now: NOW,
    })).toThrowError(expect.objectContaining({
      code: 'SEARCH_NUMERIC_FILTER_NOT_DISCOVERED',
    }));
  });

  it('freezes the complete warm-stove filter matrix into one deterministic parameter set', () => {
    const filterSnapshot = warmStoveSnapshot();
    const resolved = resolveSearchIntentV1({
      intent: {
        keyword: '暖炉',
        filterConfigSnapshotHash: filterSnapshot.snapshotHash,
        sort: 'price-asc',
        selections: [
          selection('商家特色', '一件代发'),
          selection('商品特色', '新品'),
          selection('交易服务', '包邮'),
          selection('经营模式', '生产加工'),
          selection('平台标签', '严选'),
          selection('复合标签', '48H发货'),
          selection('唯一标签', '官方物流'),
          selection('动态属性', '家用'),
          selection('所在地区', '浙江'),
          selection('所在地区', '杭州'),
        ],
        numeric: {
          priceStart: '20',
          priceEnd: '200',
          quantityBegin: '1',
          shopCountStart: '30',
          shopCountEnd: '123',
        },
        maxPages: 3,
        maxOffers: 120,
        advertisementPolicy: 'exclude-p4p',
      },
      filterSnapshot,
      capabilitySnapshot: capabilities(false),
      now: NOW,
    });
    const parameterSet = compileSearchParameterSetV1(resolved);
    expect(parameterSet).toMatchObject({
      keyword: '暖炉',
      sort: 'price-asc',
      sortType: 'price',
      descendOrder: false,
      filterParams: {
        bizType: 'production',
        city: '杭州',
        complexTags: 'ship-48h',
        featurePair: 'usage:home',
        filtMemberTags: 'drop-ship',
        filtOfferTags: 'new-product',
        freeShipping: 'true',
        priceEnd: '200',
        priceStart: '20',
        province: '浙江',
        quantityBegin: '1',
        shopCountEnd: '123',
        shopCountStart: '30',
        tags: 'strict-selection',
        uniqfield: 'official-logistics',
      },
    });
    expect(compileSearchParameterSetV1(resolved).parameterSetHash)
      .toBe(parameterSet.parameterSetHash);
  });

  it('rejects removed compatibility sort aliases', () => {
    const filterSnapshot = snapshot();
    expect(() => resolveSearchIntentV1({
        intent: intent({
          sort: 'va_rmdarkgmv30' as SearchIntentV1['sort'],
          filterConfigSnapshotHash: filterSnapshot.snapshotHash,
        }),
        filterSnapshot,
        capabilitySnapshot: capabilities(),
        now: NOW,
      })).toThrow(/Unsupported search sort/u);
  });

  it.each([
    ['sort pair', (value: Record<string, unknown>) => {
      value['sortType'] = 'normal';
    }],
    ['GBK keyword encoding', (value: Record<string, unknown>) => {
      value['encodedKeyword'] = '%E6%BB%85%E7%81%AB%E5%99%A8';
    }],
    ['unknown filter', (value: Record<string, unknown>) => {
      value['filterParams'] = { arbitrary: 'caller-owned' };
    }],
    ['noncanonical numeric filter', (value: Record<string, unknown>) => {
      value['filterParams'] = { priceStart: '01.50' };
    }],
    ['unexpected field', (value: Record<string, unknown>) => {
      value['unexpected'] = true;
    }],
  ] as const)('rejects a self-hashed parameter artifact with %s drift', (_name, mutate) => {
    const filterSnapshot = snapshot();
    const compiled = compileSearchParameterSetV1(resolveSearchIntentV1({
      intent: intent({ filterConfigSnapshotHash: filterSnapshot.snapshotHash }),
      filterSnapshot,
      capabilitySnapshot: capabilities(),
      now: NOW,
    }));
    const corrupted = structuredClone(compiled) as Record<string, unknown>;
    mutate(corrupted);
    corrupted['parameterSetHash'] = hashParameterSet(corrupted);

    expect(() => verifyParameterSetHash(corrupted as typeof compiled)).toThrowError(
      expect.objectContaining({ code: 'SEARCH_PARAMETER_SET_CONTRACT_DRIFT' }),
    );
  });
});

function hashParameterSet(value: Record<string, unknown>): string {
  const { parameterSetHash: _ignored, ...content } = value;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(content)), 'utf8')
    .digest('hex')}`;
}

function warmStoveSnapshot() {
  const option = (
    groupName: string,
    label: string,
    urlKey: string,
    value: string,
    parentRequestContext?: Record<string, string>,
  ) => ({ groupName, label, urlKey, value, parentRequestContext });
  return parseSearchFilterConfigSnapshotV1({
    snapshotId: 'warm-stove-filter-snapshot-1',
    keyword: '暖炉',
    observedAt: NOW,
    expiresAt: LATER,
    payload: { data: { data: { filterData: {
      filtbarBottom: [], filtbarLeft: [], filtbarRight: [],
      filters: [
        option('商家特色', '一件代发', 'filtMemberTags', 'drop-ship'),
        option('商品特色', '新品', 'filtOfferTags', 'new-product'),
        option('交易服务', '包邮', 'freeShipping', 'true'),
        option('经营模式', '生产加工', 'bizType', 'production'),
        option('平台标签', '严选', 'tags', 'strict-selection'),
        option('复合标签', '48H发货', 'complexTags', 'ship-48h'),
        option('唯一标签', '官方物流', 'uniqfield', 'official-logistics'),
        option('动态属性', '家用', 'featurePair', 'usage:home'),
        option('所在地区', '浙江', 'province', '浙江'),
        option('所在地区', '杭州', 'city', '杭州', { province: '浙江' }),
        { groupName: '数值筛选', children: [
          { label: '最低价', urlKey: 'priceStart', type: 'decimal' },
          { label: '最高价', urlKey: 'priceEnd', type: 'decimal' },
          { label: '起订量', urlKey: 'quantityBegin', type: 'integer' },
          { label: '店铺商品数下限', urlKey: 'shopCountStart', type: 'integer' },
          { label: '店铺商品数上限', urlKey: 'shopCountEnd', type: 'integer' },
        ] },
      ],
    } } } },
  });
}

function selection(group: string, label: string) {
  return { groupPath: ['filters', group], label };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [
      key,
      canonicalize(record[key]),
    ]));
  }
  return value;
}
