import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  buildSupplierQualificationRuntimeRequest,
  captureSupplierQualificationForAction,
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
});
