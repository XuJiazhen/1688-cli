import { describe, expect, it } from 'vitest';
import {
  collectBoundedStoreSampleV1,
  materializeFreshStoreSampleCacheV1,
  parseStoreProfileMemberAuthorityV1,
  type StoreSampleCursorV1,
} from '../src/session/catalog-runtime.js';
import type { StoreCatalogParseResult } from '../src/session/alisite-module.js';
import { createBoundedStoreSampleBatchesV1 } from '../src/collection/catalog-batch.js';
import { mapStoreProfilePayload } from '../src/session/store-profile.js';

const MEMBER = 'b2b-member-1';
const SHOP = 'https://fixture.1688.com/';
const NOW = '2026-07-31T00:00:00.000Z';
const LATER = '2026-08-01T00:00:00.000Z';

const VALID_CANONICAL_STORE_URL_CASES = [
  ['single-label shop', 'https://fixture.1688.com/', 'https://fixture.1688.com/'],
  ['uppercase hostname', 'https://Fixture.1688.COM/', 'https://fixture.1688.com/'],
  ['multi-label shop', 'https://north.shop-2.1688.com/', 'https://north.shop-2.1688.com/'],
] as const;

const INVALID_CANONICAL_STORE_URL_CASES = [
  ['non-HTTPS scheme', 'http://fixture.1688.com/'],
  ['uppercase scheme', 'HTTPS://fixture.1688.com/'],
  ['username', 'https://user@fixture.1688.com/'],
  ['username and password', 'https://user:password@fixture.1688.com/'],
  ['explicit default port', 'https://fixture.1688.com:443/'],
  ['explicit zero-padded default port', 'https://fixture.1688.com:0443/'],
  ['explicit alternate port', 'https://fixture.1688.com:8443/'],
  ['query', 'https://fixture.1688.com/?member=other'],
  ['fragment', 'https://fixture.1688.com/#other'],
  ['missing explicit root path', 'https://fixture.1688.com'],
  ['non-root path', 'https://fixture.1688.com/offer'],
  ['double-slash path', 'https://fixture.1688.com//'],
  ['backslash path delimiter', 'https://fixture.1688.com\\other'],
  ['dot-normalized path', 'https://fixture.1688.com/a/../'],
  ['percent-encoded dot path', 'https://fixture.1688.com/%2e/'],
  ['percent-encoded hostname byte', 'https://%66ixture.1688.com/'],
  ['percent-encoded hostname dot', 'https://fixture%2e1688.com/'],
  ['percent-encoded Unicode hostname', 'https://%E5%BA%97%E9%93%BA.1688.com/'],
  ['Unicode hostname', 'https://店铺.1688.com/'],
  ['non-ASCII hostname', 'https://café.1688.com/'],
  ['empty shop label', 'https://.1688.com/'],
  ['double-dot hostname', 'https://foo..1688.com/'],
  ['trailing empty hostname label', 'https://foo.1688.com./'],
  ['hostname underscore', 'https://fixture_shop.1688.com/'],
  ['leading hostname hyphen', 'https://-fixture.1688.com/'],
  ['trailing hostname hyphen', 'https://fixture-.1688.com/'],
  ['oversized hostname label', `https://${'a'.repeat(64)}.1688.com/`],
  ['apex host', 'https://1688.com/'],
  ['lookalike suffix', 'https://fixture1688.com/'],
  ['unapproved suffix', 'https://fixture.1688.com.evil.example/'],
  ['leading whitespace', ' https://fixture.1688.com/'],
  ['trailing whitespace', 'https://fixture.1688.com/ '],
  ['trailing newline', 'https://fixture.1688.com/\n'],
] as const;

function profileObservation(input: Readonly<{
  memberId?: string;
  memberSourceFieldPath?: string;
  memberSourceRawRef?: string;
  canonicalShopUrl?: string;
  payloadShopUrl?: string;
  companyName?: string;
}> = {}) {
  const profile = mapStoreProfilePayload({
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    data: {
      success: true,
      data: {
        memberId: input.memberId ?? MEMBER,
        companyName: input.companyName ?? 'Fixture Store',
        commonUrl: { shopUrl: input.payloadShopUrl ?? SHOP },
      },
    },
  }, NOW, {
    sourceRef: 'fixture:wangpu-header',
    rawRef: 'artifact:wangpu-header',
  });
  return Promise.resolve({
    memberId: input.memberId ?? MEMBER,
    memberIdSource: {
      ...profile.source,
      fieldPath: input.memberSourceFieldPath ?? 'data.data.memberId',
      rawRef: input.memberSourceRawRef ?? profile.source.rawRef,
    },
    canonicalShopUrl: input.canonicalShopUrl ?? SHOP,
    observedAt: NOW,
    profile,
  });
}

function collectProfileObservation() {
  return profileObservation();
}

function parsed(page: number, options: {
  memberId?: string;
  count?: number;
  offerCount?: number;
  totalPages?: number;
} = {}): StoreCatalogParseResult {
  const count = options.count ?? 30;
  return {
    kind: 'offer-list', offerCount: options.offerCount ?? 590,
    totalPages: options.totalPages ?? 20,
    offers: Array.from({ length: count }, (_, index) => ({
      offerId: `${page}${index.toString().padStart(3, '0')}`,
      memberId: options.memberId ?? MEMBER, title: `Offer ${page}-${index}`,
      url: `https://detail.1688.com/offer/${page}${index}.html`,
      imageUrl: null, categoryId: null, price: null, quantityBegin: null,
      unit: null, pagePosition: index + 1, absolutePosition: (page - 1) * 30 + index + 1,
      sales: {
        vagueSaleQuantity: null, thirtySaleQuantity: null, bookedCount: null,
        ninetySaleQuantity: null, saleQuantity: null, modelBookedCount: null,
        modelAgentBookedCount: null, modelQuantitySumMonth: null, modelSaleQuantity: null,
      },
    })),
    categories: page === 1
      ? [{ id: 'cat-1', name: 'Tools', fullName: 'Tools', count: 590, children: [] }]
      : [],
    userDefined: { raw: null, value: null, state: 'missing' },
    page: {
      memberId: options.memberId ?? MEMBER,
      pageNum: page, pageSize: 30, categoryId: null, keyword: null,
      sortType: 'wangpu_score',
    },
    warnings: [],
  };
}

async function baseline(overrides: Partial<Parameters<typeof collectBoundedStoreSampleV1>[0]> = {}) {
  const calls: number[] = [];
  const result = await collectBoundedStoreSampleV1({
    memberId: MEMBER, canonicalShopUrl: SHOP,
    mode: 'phase-1-bounded', firstPage: 1, lastPageInclusive: 3,
    generation: 'generation-1', baselineExpiresAt: LATER,
    now: () => new Date(NOW),
    collectProfileObservation,
    collectPage: async (page) => { calls.push(page); return parsed(page); },
    ...overrides,
  });
  return { result, calls };
}

describe('bounded Store Sample runtime', () => {
  it('collects one session pages 1-3, page-1 categories, 90 unique cache-only-safe offers, and dormant page 4', async () => {
    const { result, calls } = await baseline();
    expect(calls).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      mode: 'phase-1-bounded', remoteRequests: 3,
      taskCandidateEligible: false, evidenceUsage: 'baseline-evidence',
      cursor: {
        observedPages: [1, 2, 3], nextPage: 4,
        checkpointState: 'dormant', sourceOfferCount: 590,
      },
    });
    expect(result.uniqueOffers).toHaveLength(90);
    expect(result.categories).toHaveLength(1);
    const batches = createBoundedStoreSampleBatchesV1({
      result, unitId: 'unit-1', sourceRequestId: 'request-1',
      catalogBatchId: 'catalog-1', categoriesBatchId: 'categories-1',
      profileBatchId: 'profile-1', startedAt: NOW, completedAt: NOW,
      rawEvidenceRefs: ['artifact:store-pages-1-3'],
    });
    expect(batches.map((batch) => batch.kind)).toEqual([
      'store-catalog', 'store-catalog', 'store-catalog',
      'store-categories', 'store-profile',
    ]);
    expect(batches.slice(0, 3).map((batch) => batch.scope.requestedScope))
      .toEqual(['page', 'page', 'bounded-pages']);
    expect(batches.slice(0, 3).map((batch) => batch.completeness.observedPages))
      .toEqual([[1], [2], [1, 2, 3]]);
    expect(batches[0].metrics).toMatchObject({ candidatesPublished: 0, remoteRequests: 1 });
    expect(batches.slice(0, 3).flatMap((batch) => batch.observations).every((observation) =>
      observation.taskCandidateEligible === false
    )).toBe(true);
    expect(batches[3].metrics.remoteRequests).toBe(0);
  });

  it('rejects any phase-1 page 4 scope before invoking the remote port', async () => {
    let calls = 0;
    await expect(collectBoundedStoreSampleV1({
      memberId: MEMBER, canonicalShopUrl: SHOP,
      mode: 'phase-1-bounded', firstPage: 2, lastPageInclusive: 4,
      generation: 'generation-1', baselineExpiresAt: LATER,
      now: () => new Date(NOW),
      collectProfileObservation,
      collectPage: async (page) => { calls++; return parsed(page); },
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_BASELINE_SCOPE_INVALID' });
    expect(calls).toBe(0);
  });

  it('preserves a verified prefix as partial evidence on later member or total drift', async () => {
    const { result: memberDrift } = await baseline({
      collectPage: async (page) => parsed(page, page === 2 ? { memberId: 'b2b-other' } : {}),
    });
    expect(memberDrift).toMatchObject({
      status: 'partial', errorCode: 'STORE_SAMPLE_MEMBER_SCOPE_MISMATCH',
      failedPages: [2], remoteRequests: 2,
      cursor: { observedPages: [1], nextPage: 2, checkpointState: 'incomplete' },
    });
    const { result: totalDrift } = await baseline({
      collectPage: async (page) => parsed(page, { offerCount: page === 2 ? 591 : 590 }),
    });
    expect(totalDrift).toMatchObject({
      status: 'partial', errorCode: 'STORE_SAMPLE_TOTAL_DRIFT', failedPages: [2],
    });
    const batches = createBoundedStoreSampleBatchesV1({
      result: totalDrift, unitId: 'unit-partial', sourceRequestId: 'request-partial',
      catalogBatchId: 'catalog-partial', categoriesBatchId: 'categories-partial',
      profileBatchId: 'profile-partial', startedAt: NOW, completedAt: NOW,
      rawEvidenceRefs: ['artifact:store-page-1'],
    });
    expect(batches.every((batch) => batch.status === 'partial')).toBe(true);
    expect(batches[0]).toMatchObject({
      completeness: { state: 'truncated', observedPages: [1], failedPages: [2] },
      errors: [{ code: 'STORE_SAMPLE_TOTAL_DRIFT' }],
    });
  });

  it('preserves the just-committed page when pacing or cancellation fails afterwards', async () => {
    const { result } = await baseline({
      afterPageCommitted: async () => { throw new Error('cancelled during pacing'); },
    });
    expect(result).toMatchObject({
      status: 'partial', errorCode: 'STORE_SAMPLE_PAGE_FAILED',
      failedPages: [], remoteRequests: 1,
      cursor: { observedPages: [1], nextPage: 2, checkpointState: 'incomplete' },
    });
    expect(result.uniqueOffers).toHaveLength(30);
  });

  it('still fails closed when the first page has no verified evidence', async () => {
    await expect(baseline({
      collectPage: async (page) => parsed(page, { memberId: 'b2b-other' }),
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_MEMBER_SCOPE_MISMATCH' });
  });

  it('requires archived Wangpu header fields instead of synthesizing a profile', async () => {
    let catalogCalls = 0;
    await expect(baseline({
      collectProfileObservation: async () => {
        const profile = mapStoreProfilePayload({
          api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
          data: { success: true, data: { memberId: MEMBER, mainCate: 'Tools' } },
        }, NOW, {
          sourceRef: 'fixture:incomplete-wangpu-header',
          rawRef: 'artifact:incomplete-wangpu-header',
        });
        return {
          memberId: MEMBER,
          memberIdSource: { ...profile.source, fieldPath: 'data.data.memberId' },
          canonicalShopUrl: SHOP,
          observedAt: NOW,
          profile,
        };
      },
      collectPage: async (page) => {
        catalogCalls++;
        return parsed(page);
      },
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' });
    expect(catalogCalls).toBe(0);
  });

  it.each([
    {
      label: 'payload URL from another Store',
      collect: () => profileObservation({
        payloadShopUrl: 'https://different-member.1688.com/',
      }),
    },
    {
      label: 'input-derived observation URL from another Store',
      collect: () => profileObservation({
        canonicalShopUrl: 'https://different-member.1688.com/',
      }),
    },
    {
      label: 'member alias drift',
      collect: () => profileObservation({ memberId: 'different-member' }),
    },
    {
      label: 'member authority detached from the archived response',
      collect: () => profileObservation({
        memberSourceRawRef: 'artifact:different-header',
      }),
    },
    {
      label: 'member authority from a request-derived field',
      collect: () => profileObservation({
        memberSourceFieldPath: 'request.params.memberId',
      }),
    },
    {
      label: 'ambiguous payload URL',
      collect: () => profileObservation({
        payloadShopUrl: `${SHOP}?memberId=different-member`,
      }),
    },
    {
      label: 'blank parsed name',
      collect: () => profileObservation({ companyName: '   ' }),
    },
    {
      label: 'fragment-bearing Store URL',
      collect: () => profileObservation({ payloadShopUrl: `${SHOP}#other` }),
    },
    {
      label: 'apex 1688 host',
      collect: () => profileObservation({
        canonicalShopUrl: 'https://1688.com/',
        payloadShopUrl: 'https://1688.com/',
      }),
    },
  ])('rejects $label before Store catalog collection', async ({ collect }) => {
    let catalogCalls = 0;
    await expect(baseline({
      collectProfileObservation: collect,
      collectPage: async (page) => {
        catalogCalls++;
        return parsed(page);
      },
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' });
    expect(catalogCalls).toBe(0);
  });

  it.each(VALID_CANONICAL_STORE_URL_CASES)(
    'accepts a %s and preserves its canonical Store authority',
    async (_label, shopUrl, canonicalShopUrl) => {
      const { result, calls } = await baseline({
        canonicalShopUrl: shopUrl,
        collectProfileObservation: () => profileObservation({
          canonicalShopUrl: shopUrl,
          payloadShopUrl: shopUrl,
        }),
      });
      expect(calls).toEqual([1, 2, 3]);
      expect(result.cursor.canonicalShopUrl).toBe(canonicalShopUrl);
    },
  );

  it.each(INVALID_CANONICAL_STORE_URL_CASES)(
    'rejects a Store URL with %s before collection',
    async (_label, shopUrl) => {
      let catalogCalls = 0;
      await expect(baseline({
        canonicalShopUrl: shopUrl,
        collectProfileObservation: () => profileObservation({
          canonicalShopUrl: shopUrl,
          payloadShopUrl: shopUrl,
        }),
        collectPage: async (page) => {
          catalogCalls++;
          return parsed(page);
        },
      })).rejects.toMatchObject({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' });
      expect(catalogCalls).toBe(0);
    },
  );

  it('parses Store member authority only from the response header payload', () => {
    const profile = mapStoreProfilePayload({
      data: { data: { memberId: MEMBER, companyName: 'Fixture Store' } },
    }, NOW, {
      sourceRef: 'fixture:wangpu-header',
      rawRef: 'artifact:wangpu-header',
    });
    expect(parseStoreProfileMemberAuthorityV1(
      { data: { data: { memberId: MEMBER } } },
      profile.source,
    )).toMatchObject({
      memberId: MEMBER,
      memberIdSource: {
        rawRef: 'artifact:wangpu-header',
        fieldPath: 'data.data.memberId',
      },
    });
    expect(() => parseStoreProfileMemberAuthorityV1(
      { data: { data: { companyName: 'Missing member' } } },
      profile.source,
    )).toThrowError(expect.objectContaining({
      code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
    }));
  });

  it('accepts current Wangpu mobile shop identity when the header omits data.data.memberId', async () => {
    const mobileShopUrl =
      `https://winport.m.1688.com/page/index.html?newRender=true&memberId=${MEMBER}&upstreamSource=search`;
    const profile = mapStoreProfilePayload({
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      data: {
        success: true,
        data: {
          companyName: 'Fixture Store',
          commonUrl: { shopUrl: mobileShopUrl },
        },
      },
    }, NOW, {
      sourceRef: 'fixture:wangpu-header-mobile-shop-url',
      rawRef: 'artifact:wangpu-header-mobile-shop-url',
    });
    const memberAuthority = parseStoreProfileMemberAuthorityV1({
      data: {
        data: {
          companyName: 'Fixture Store',
          commonUrl: { shopUrl: mobileShopUrl },
        },
      },
    }, profile.source);

    expect(memberAuthority).toMatchObject({
      memberId: MEMBER,
      memberIdSource: {
        rawRef: 'artifact:wangpu-header-mobile-shop-url',
        fieldPath: 'data.data.commonUrl.shopUrl#memberId',
      },
    });
    const { result, calls } = await baseline({
      collectProfileObservation: async () => ({
        ...memberAuthority,
        canonicalShopUrl: SHOP,
        observedAt: NOW,
        profile,
      }),
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(result.status).toBe('completed');
    expect(result.profileObservation).toMatchObject({
      memberId: MEMBER,
      canonicalShopUrl: SHOP,
      profile: {
        shopUrl: { availability: 'available', value: mobileShopUrl },
      },
    });
  });

  it('rejects a Wangpu mobile shop URL for another member', async () => {
    const profile = mapStoreProfilePayload({
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      data: {
        success: true,
        data: {
          companyName: 'Fixture Store',
          commonUrl: {
            shopUrl:
              'https://winport.m.1688.com/page/index.html?memberId=b2b-other',
          },
        },
      },
    }, NOW, {
      sourceRef: 'fixture:wangpu-header-mobile-shop-url-drift',
      rawRef: 'artifact:wangpu-header-mobile-shop-url-drift',
    });
    const memberAuthority = parseStoreProfileMemberAuthorityV1({
      data: { data: {
        commonUrl: {
          shopUrl: 'https://winport.m.1688.com/page/index.html?memberId=b2b-other',
        },
      } },
    }, profile.source);
    await expect(baseline({
      collectProfileObservation: async () => ({
        ...memberAuthority,
        canonicalShopUrl: SHOP,
        observedAt: NOW,
        profile,
      }),
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' });
  });

  it('rejects ambiguous Wangpu mobile shop member authority', () => {
    expect(() => parseStoreProfileMemberAuthorityV1({
      data: { data: {
        commonUrl: {
          shopUrl:
            `https://winport.m.1688.com/page/index.html?memberId=${MEMBER}&memberId=b2b-other`,
        },
      } },
    }, {
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      componentKey: 'cbu-pc-wangpu-homepage-leftnav',
      parserVersion: 'store-profile-v1',
      sourceRef: 'fixture:wangpu-header-mobile-shop-url-ambiguous',
      rawRef: 'artifact:wangpu-header-mobile-shop-url-ambiguous',
    })).toThrowError(expect.objectContaining({
      code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE',
    }));
  });

  it.each([
    ['lookalike host', `https://winport.m.1688.com.evil.example/page/index.html?memberId=${MEMBER}`],
    ['alternate path', `https://winport.m.1688.com/other/index.html?memberId=${MEMBER}`],
    ['credentials', `https://user@winport.m.1688.com/page/index.html?memberId=${MEMBER}`],
    ['fragment', `https://winport.m.1688.com/page/index.html?memberId=${MEMBER}#other`],
  ])('rejects a Wangpu mobile member authority with %s', (_label, shopUrl) => {
    const payload = { data: { data: { commonUrl: { shopUrl } } } };
    const profile = mapStoreProfilePayload(payload, NOW, {
      sourceRef: 'fixture:wangpu-header',
      rawRef: 'artifact:wangpu-header',
    });
    expect(() => parseStoreProfileMemberAuthorityV1(payload, profile.source)).toThrowError(
      expect.objectContaining({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' }),
    );
  });

  it('rejects contradictory Store member authorities in the same header', () => {
    const payload = {
      data: {
        data: {
          memberId: MEMBER,
          commonUrl: {
            shopUrl: 'https://winport.m.1688.com/page/index.html?memberId=other-member',
          },
        },
      },
    };
    const profile = mapStoreProfilePayload(payload, NOW, {
      sourceRef: 'fixture:wangpu-header',
      rawRef: 'artifact:wangpu-header',
    });
    expect(() => parseStoreProfileMemberAuthorityV1(payload, profile.source)).toThrowError(
      expect.objectContaining({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' }),
    );
  });

  it('rejects a malformed direct member even when the Wangpu URL is otherwise valid', () => {
    const payload = {
      data: {
        data: {
          memberId: 'unsafe member id',
          commonUrl: {
            shopUrl: `https://winport.m.1688.com/page/index.html?memberId=${MEMBER}`,
          },
        },
      },
    };
    const profile = mapStoreProfilePayload(payload, NOW, {
      sourceRef: 'fixture:wangpu-header',
      rawRef: 'artifact:wangpu-header',
    });
    expect(() => parseStoreProfileMemberAuthorityV1(payload, profile.source)).toThrowError(
      expect.objectContaining({ code: 'STORE_SAMPLE_HEADER_PROFILE_INCOMPLETE' }),
    );
  });

  it.each(['offer-count', 'total-pages', 'categories'] as const)(
    'cannot complete when page-1 %s authority is missing',
    async (missing) => {
      await expect(baseline({
        collectPage: async (page) => {
          const value = parsed(page);
          if (page === 1 && missing === 'offer-count') value.offerCount = null;
          if (page === 1 && missing === 'total-pages') value.totalPages = null;
          if (page === 1 && missing === 'categories') value.categories = [];
          return value;
        },
      })).rejects.toMatchObject({ code: 'STORE_SAMPLE_PAGE1_SUMMARY_INCOMPLETE' });
    },
  );

  it('materializes fresh cache with zero remote requests and expires on TTL/parser drift', async () => {
    const { result } = await baseline();
    const hit = materializeFreshStoreSampleCacheV1({
      cursor: result.cursor, parserRevisionMatches: true,
      now: '2026-07-31T01:00:00.000Z', originBatchRefs: ['batch:1'],
      contentHash: `sha256:${'1'.repeat(64)}`,
    });
    expect(hit).toMatchObject({ hit: true, remoteRequests: 0, observedAt: NOW });
    expect(materializeFreshStoreSampleCacheV1({
      cursor: result.cursor, parserRevisionMatches: true,
      now: LATER, originBatchRefs: [], contentHash: `sha256:${'1'.repeat(64)}`,
    })).toEqual({ hit: false, remoteRequests: 0, reason: 'expired' });
    expect(materializeFreshStoreSampleCacheV1({
      cursor: result.cursor, parserRevisionMatches: false,
      now: NOW, originBatchRefs: [], contentHash: `sha256:${'1'.repeat(64)}`,
    })).toEqual({ hit: false, remoteRequests: 0, reason: 'parser-revision-changed' });
  });

  it('allows only 3-10 approved expansion pages from the dormant generation and never candidates/evidence', async () => {
    const { result: base } = await baseline();
    const expand = await collectBoundedStoreSampleV1({
      memberId: MEMBER, canonicalShopUrl: SHOP,
      mode: 'approved-expansion', firstPage: 4, lastPageInclusive: 6,
      generation: 'generation-1', previousCursor: base.cursor,
      baselineExpiresAt: LATER, now: () => new Date('2026-07-31T01:00:00.000Z'),
      collectProfileObservation,
      collectPage: async (page) => parsed(page),
    });
    expect(expand).toMatchObject({
      remoteRequests: 3, taskCandidateEligible: false,
      evidenceUsage: 'cache-seed-only', cursor: {
        observedPages: [1, 2, 3, 4, 5, 6],
        checkpointState: 'approved-expansion-active', nextPage: 7,
      },
    });
    for (const pageCount of [2, 11, 3.5]) {
      await expect(collectBoundedStoreSampleV1({
        memberId: MEMBER, canonicalShopUrl: SHOP,
        mode: 'approved-expansion', firstPage: 4,
        lastPageInclusive: 4 + pageCount - 1,
        generation: 'generation-1', previousCursor: base.cursor,
        baselineExpiresAt: LATER, now: () => new Date(NOW),
        collectProfileObservation,
        collectPage: async (page) => parsed(page),
      })).rejects.toBeTruthy();
    }

    const wrongIdentity: StoreSampleCursorV1 = { ...base.cursor, memberId: 'b2b-other' };
    await expect(collectBoundedStoreSampleV1({
      memberId: MEMBER, canonicalShopUrl: SHOP,
      mode: 'approved-expansion', firstPage: 4, lastPageInclusive: 6,
      generation: 'generation-1', previousCursor: wrongIdentity,
      baselineExpiresAt: LATER, now: () => new Date(NOW),
      collectProfileObservation,
      collectPage: async (page) => parsed(page),
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_EXPANSION_CURSOR_INVALID' });

    await expect(collectBoundedStoreSampleV1({
      memberId: MEMBER, canonicalShopUrl: SHOP,
      mode: 'approved-expansion', firstPage: 4, lastPageInclusive: 6,
      generation: 'generation-1', previousCursor: base.cursor,
      baselineExpiresAt: LATER, now: () => new Date(NOW),
      collectProfileObservation,
      collectPage: async (page) => parsed(page, { offerCount: 591 }),
    })).rejects.toMatchObject({ code: 'STORE_SAMPLE_BASELINE_TOTAL_DRIFT' });
  });
});
