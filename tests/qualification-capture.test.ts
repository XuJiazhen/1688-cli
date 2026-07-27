import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  buildSupplierQualificationRuntimeRequest,
  captureSupplierQualificationForAction,
  requestSupplierQualificationFromPage,
  requireSupplierQualificationResponse,
} from '../src/session/qualification-capture.js';
import { ALISITE_MODULE_API } from '../src/session/alisite-module.js';

class MockPage extends EventEmitter {
  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

function url(memberId: string, componentKey = 'wp_pc_shop_basic_info'): string {
  const data = { componentKey, params: JSON.stringify({ memberId }) };
  return `https://h5api.m.1688.com/h5/${ALISITE_MODULE_API}/1.0/?sign=secret&data=${encodeURIComponent(JSON.stringify(data))}`;
}

function response(requestUrl: string): PWResponse {
  return {
    url: () => requestUrl,
    text: async () => JSON.stringify({
      data: {
        memberId: 'b2b-target',
        certList: [],
        businessInfo: { companyBusinessLine: '户外用品销售' },
      },
    }),
  } as unknown as PWResponse;
}

describe('captureSupplierQualificationForAction', () => {
  it('builds a page-runtime MTOP request without signatures or credentials', () => {
    expect(
      buildSupplierQualificationRuntimeRequest('b2b-target'),
    ).toEqual({
      api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
      v: '1.0',
      type: 'POST',
      dataType: 'json',
      data: {
        componentKey: 'wp_pc_shop_basic_info',
        params: JSON.stringify({ memberId: 'b2b-target' }),
      },
    });
    expect(
      JSON.stringify(buildSupplierQualificationRuntimeRequest('b2b-target')),
    ).not.toMatch(/cookie|token|sign|authorization/i);
  });

  it.each([
    ['login key', 'fixtureLogin_01'],
    ['b2b key', 'b2b-fixture-member'],
    ['numeric key', '1688000012345'],
    ['128-character boundary', `a${'b'.repeat(127)}`],
  ])('accepts a safe %s', (_label, memberId) => {
    const request = buildSupplierQualificationRuntimeRequest(memberId);

    expect(JSON.parse(request.data.params)).toEqual({ memberId });
  });

  it.each([
    ['empty key', ''],
    ['whitespace', ' '],
    ['leading punctuation', '-fixture-member'],
    ['path punctuation', 'fixture/member'],
    ['query punctuation', 'fixture?member=1'],
    ['control characters', 'fixture\nmember'],
    ['non-ASCII characters', '示例会员'],
    ['more than 128 characters', `a${'b'.repeat(128)}`],
  ])('rejects %s', (_label, memberId) => {
    expect(() =>
      buildSupplierQualificationRuntimeRequest(memberId),
    ).toThrow(TypeError);
  });

  it('correlates the basic-info response by memberId without exposing request data', async () => {
    const page = new MockPage() as Page & MockPage;
    const result = await captureSupplierQualificationForAction(
      page,
      { memberId: 'b2b-target', timeoutMs: 50 },
      async () => {
        page.emit('response', response(url('b2b-other')));
        page.emit('response', response(url('b2b-target')));
      },
    );

    expect(result.qualification?.registeredBusinessScope).toMatchObject({
      availability: 'available',
      value: '户外用品销售',
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret');
    expect(JSON.stringify(result.diagnostics)).not.toContain('b2b-target');
    expect(page.listenerCount('response')).toBe(0);
  });

  it('passes the runtime-ready timeout in the Playwright options position', async () => {
    const calls: unknown[][] = [];
    const page = {
      waitForFunction: async (...args: unknown[]) => {
        calls.push(args);
      },
      evaluate: async () => undefined,
    };

    await requestSupplierQualificationFromPage(
      page as unknown as Page,
      'b2b-target',
      { runtimeReadyTimeoutMs: 7, requestTimeoutMs: 7 },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBeUndefined();
    expect(calls[0]?.[2]).toEqual({ timeout: 7 });
  });

  it('bounds a Runtime Promise that never settles', async () => {
    const page = {
      waitForFunction: async () => undefined,
      evaluate: async () => new Promise<never>(() => {}),
    };

    await expect(
      requestSupplierQualificationFromPage(
        page as unknown as Page,
        'b2b-target',
        { runtimeReadyTimeoutMs: 5, requestTimeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      code: 'QUALIFICATION_REQUEST_REJECTED',
      details: expect.objectContaining({
        retryable: true,
        timeoutMs: 5,
      }),
    });
  });

  it('turns a missing correlated response into a bounded structured timeout', async () => {
    const page = new MockPage() as Page & MockPage;
    const result = await captureSupplierQualificationForAction(
      page,
      { memberId: 'b2b-target', timeoutMs: 5 },
      async () => undefined,
    );

    expect(() => requireSupplierQualificationResponse(result)).toThrowError(
      expect.objectContaining({
        code: 'QUALIFICATION_RESPONSE_TIMEOUT',
        details: expect.objectContaining({
          retryable: true,
          responseCapture: expect.objectContaining({
            timedOut: true,
            matchedCount: 0,
          }),
        }),
      }),
    );
    expect(page.listenerCount('response')).toBe(0);
  });
});
