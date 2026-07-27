import { describe, expect, it } from 'vitest';
import {
  buildStoreCatalogRuntimeRequest,
  requestStoreCatalogFromPage,
} from '../src/session/catalog-runtime.js';

describe('store catalog page runtime', () => {
  it('builds one credential-free MTOP request for the requested page', () => {
    const request = buildStoreCatalogRuntimeRequest({
      memberId: 'b2b-fixture-member',
      pageNum: 4,
      count: 30,
      catId: 'category-1',
      keywords: '帐篷',
      sortType: 'tradenumdown',
    });

    expect(request).toEqual({
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      v: '1.0',
      type: 'POST',
      dataType: 'json',
      data: {
        componentKey: 'Wp_pc_common_offerlist',
        params: JSON.stringify({
          memberId: 'b2b-fixture-member',
          appdata: {
            pageNum: 4,
            count: 30,
            catId: 'category-1',
            keywords: '帐篷',
            sortType: 'tradenumdown',
          },
        }),
      },
    });
    expect(JSON.stringify(request)).not.toMatch(
      /cookie|token|sign|authorization/i,
    );
  });

  it('requests a resumed page once through the loaded runtime without DOM navigation', async () => {
    const evaluated: unknown[] = [];
    const page = {
      evaluate: async (
        _callback: unknown,
        request: unknown,
      ) => {
        evaluated.push(request);
        return { ret: ['SUCCESS::调用成功'] };
      },
    };

    await requestStoreCatalogFromPage(
      page as never,
      {
        memberId: 'b2b-fixture-member',
        pageNum: 7,
        count: 30,
        sortType: 'wangpu_score',
      },
      { timeoutMs: 50 },
    );

    expect(evaluated).toHaveLength(1);
    expect(
      JSON.parse(
        (evaluated[0] as { data: { params: string } }).data.params,
      ),
    ).toMatchObject({
      memberId: 'b2b-fixture-member',
      appdata: { pageNum: 7 },
    });
  });

  it.each([
    [
      'rejected',
      () => Promise.reject(new Error('fixture rejection')),
      'request-rejected',
      false,
    ],
    [
      'never-settling',
      () => new Promise<never>(() => {}),
      'request-timeout',
      true,
    ],
  ])('bounds a %s Runtime request with a structured failure', async (
    _label,
    makeResult,
    failureKind,
    retryable,
  ) => {
    const page = {
      evaluate: async () => makeResult(),
    };

    await expect(
      requestStoreCatalogFromPage(
        page as never,
        {
          memberId: 'b2b-fixture-member',
          pageNum: 2,
          count: 30,
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_REQUEST_REJECTED',
      details: {
        failureKind,
        retryable,
      },
    });
  });

  it('wraps invalid Runtime scope as a non-retryable collection contract error', async () => {
    const page = { evaluate: async () => undefined };

    await expect(
      requestStoreCatalogFromPage(
        page as never,
        {
          memberId: 'b2b-fixture-member',
          pageNum: 1,
          count: 101,
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      code: 'CATALOG_REQUEST_INVALID',
      details: {
        failureKind: 'request-invalid',
        retryable: false,
      },
    });
  });

  it.each([
    ['missing member', { memberId: '', pageNum: 1, count: 30 }],
    [
      'unsafe member',
      { memberId: 'b2b/member', pageNum: 1, count: 30 },
    ],
    [
      'invalid page',
      { memberId: 'b2b-member', pageNum: 0, count: 30 },
    ],
    [
      'oversized page size',
      { memberId: 'b2b-member', pageNum: 1, count: 101 },
    ],
    [
      'control character',
      {
        memberId: 'b2b-member',
        pageNum: 1,
        count: 30,
        keywords: 'tent\nsecret',
      },
    ],
  ])('rejects %s before invoking the page', (_label, input) => {
    expect(() => buildStoreCatalogRuntimeRequest(input)).toThrow(TypeError);
  });
});
