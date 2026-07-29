import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ALISITE_MODULE_API } from '../src/session/alisite-module.js';
import {
  assertStoreProfilePayloadState,
  buildStoreProfileRuntimeRequest,
  captureStoreProfileForAction,
  requestStoreProfileFromPage,
} from '../src/session/store-profile-capture.js';

class MockPage extends EventEmitter {
  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

function profileUrl(
  memberId: string,
  componentKey = 'wp_pc_common_header',
): string {
  const data = {
    componentKey,
    params: JSON.stringify({
      memberId,
      appdata: { version: '2025V2' },
    }),
  };
  return (
    `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/` +
    `?sign=secret&data=${encodeURIComponent(JSON.stringify(data))}`
  );
}

function response(requestUrl: string, payload: unknown): PWResponse {
  return {
    url: () => requestUrl,
    request: () => ({ postData: () => null }),
    text: async () => JSON.stringify(payload),
  } as unknown as PWResponse;
}

describe('store profile capture', () => {
  it('builds a lightweight common-header runtime request without credentials', () => {
    const request = buildStoreProfileRuntimeRequest('b2b-target');

    expect(request).toEqual({
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      v: '1.0',
      type: 'POST',
      dataType: 'json',
      data: {
        componentKey: 'wp_pc_common_header',
        params: JSON.stringify({
          memberId: 'b2b-target',
          appdata: { version: '2025V2' },
        }),
      },
    });
    expect(JSON.stringify(request)).not.toMatch(
      /cookie|token|sign|authorization|offerId/i,
    );
  });

  it.each([
    '',
    ' ',
    '-fixture-member',
    'fixture/member',
    'fixture?member=1',
    'fixture\nmember',
    '示例会员',
    `a${'b'.repeat(128)}`,
  ])('rejects an unsafe member key: %j', (memberId) => {
    expect(() => buildStoreProfileRuntimeRequest(memberId)).toThrow(
      TypeError,
    );
  });

  it('reuses a naturally emitted correlated common-header response', async () => {
    const page = new MockPage() as Page & MockPage;
    const payload = {
      ret: ['SUCCESS::调用成功'],
      data: {
        success: 'true',
        data: { companyName: '脱敏工具有限公司' },
      },
    };
    const result = await captureStoreProfileForAction(
      page,
      { memberId: 'b2b-target', timeoutMs: 50 },
      async () => {
        page.emit(
          'response',
          response(profileUrl('b2b-other'), payload),
        );
        page.emit(
          'response',
          response(profileUrl('b2b-target'), payload),
        );
        return 'navigated';
      },
    );

    expect(result).toMatchObject({
      actionResult: 'navigated',
      captured: {
        payload,
        sourceRef:
          `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/`,
      },
      diagnostics: {
        matchedCount: 1,
        parsedCount: 1,
      },
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret');
    expect(JSON.stringify(result.diagnostics)).not.toContain('b2b-target');
    expect(page.listenerCount('response')).toBe(0);
  });

  it('returns the same-page MTOP fulfillment for fallback parsing', async () => {
    const payload = {
      ret: ['SUCCESS::调用成功'],
      data: {
        success: 'true',
        data: { companyName: '脱敏工具有限公司' },
      },
    };
    const calls: unknown[][] = [];
    const page = {
      waitForFunction: async (...args: unknown[]) => {
        calls.push(args);
      },
      evaluate: async (
        _pageFunction: unknown,
        runtimeRequest: unknown,
      ) => {
        expect(runtimeRequest).toEqual(
          buildStoreProfileRuntimeRequest('b2b-target'),
        );
        return payload;
      },
    };

    await expect(
      requestStoreProfileFromPage(
        page as unknown as Page,
        'b2b-target',
        { runtimeReadyTimeoutMs: 7, requestTimeoutMs: 7 },
      ),
    ).resolves.toEqual(payload);
    expect(calls[0]?.[1]).toBeUndefined();
    expect(calls[0]?.[2]).toEqual({ timeout: 7 });
  });

  it('bounds an unresolved runtime request', async () => {
    const page = {
      waitForFunction: async () => undefined,
      evaluate: async () => new Promise<never>(() => {}),
    };

    await expect(
      requestStoreProfileFromPage(
        page as unknown as Page,
        'b2b-target',
        { runtimeReadyTimeoutMs: 5, requestTimeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      code: 'STORE_PROFILE_REQUEST_REJECTED',
      details: expect.objectContaining({
        retryable: true,
        timeoutMs: 5,
      }),
    });
  });

  it.each([
    ['FAIL_SYS_USER_VALIDATE::验证失败', 'RISK_CONTROL', 4],
    ['FAIL_SYS_TRAFFIC_LIMIT::请求过多', 'RATE_LIMITED', 9],
    ['FAIL_SYS_SESSION_EXPIRED::登录失效', 'NOT_LOGGED_IN', 3],
  ])(
    'preserves the existing MTOP risk classification for %s',
    (ret, code, exitCode) => {
      expect(() =>
        assertStoreProfilePayloadState({ ret: [ret] }),
      ).toThrowError(
        expect.objectContaining({ code, exitCode }),
      );
    },
  );
});
