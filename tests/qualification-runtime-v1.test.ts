import { EventEmitter } from 'node:events';
import type { Page, Response as PWResponse } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  assertSupplierQualificationScope,
  buildQualificationMediaManifestV1,
  buildSupplierQualificationPageUrl,
  captureSupplierQualificationForAction,
} from '../src/session/qualification-capture.js';
import {
  mapSupplierQualificationPayload,
  SUPPLIER_QUALIFICATION_COMPONENT_KEY,
} from '../src/session/supplier-qualification.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('Qualification direct scope and media contract', () => {
  it('delivers received bytes before a malformed Qualification payload times out', async () => {
    const page = new EventEmitter() as Page & EventEmitter;
    const rawResponses: string[] = [];
    const outer = encodeURIComponent(JSON.stringify({
      componentKey: SUPPLIER_QUALIFICATION_COMPONENT_KEY,
      params: JSON.stringify({ memberId: 'b2b-target' }),
    }));
    const capturePromise = captureSupplierQualificationForAction(
      page,
      {
        memberId: 'b2b-target', timeoutMs: 5,
        onRawResponse: async (rawResponseText) => { rawResponses.push(rawResponseText); },
      },
      async () => {
        page.emit('response', {
          url: () => `https://h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.ModuleAsyncService/1.0/?data=${outer}`,
          request: () => ({ postData: () => null }),
          text: async () => '{malformed-qualification-response',
        } as unknown as PWResponse);
      },
    );
    const result = await capturePromise;
    expect(rawResponses).toEqual(['{malformed-qualification-response']);
    expect(result.qualification).toBeNull();
    expect(result.diagnostics).toMatchObject({ matchedCount: 1, failureCount: 1 });
  });

  it('builds only the direct member-scoped business information URL', () => {
    expect(buildSupplierQualificationPageUrl('b2b-member_1')).toBe(
      'https://wp.m.1688.com/page/businessinfor.html?memberId=b2b-member_1',
    );
    expect(() => buildSupplierQualificationPageUrl('https://evil.test/')).toThrow(/safe memberId/i);
  });

  it('fails closed on response member mismatch', () => {
    const qualification = mapSupplierQualificationPayload({
      data: { memberId: 'b2b-other', businessInfo: { companyName: 'Fixture Co' } },
    });
    expect(() => assertSupplierQualificationScope('b2b-target', qualification)).toThrowError(
      expect.objectContaining({ code: 'QUALIFICATION_RESPONSE_SCOPE_MISMATCH' }),
    );
  });

  it('distinguishes complete, authoritative-empty, and failed media source coverage', () => {
    const qualification = mapSupplierQualificationPayload({
      data: {
        memberId: 'b2b-target', certList: [],
        propaganda: { companyImg: [{ type: 'workplace', url: '//cbu01.alicdn.com/q.jpg' }] },
      },
    });
    const common = {
      memberId: 'b2b-target', sourceQualificationGeneration: 'qgen-1',
      sourceObservationId: 'observation-1', sourcePayloadContentSha256: HASH,
      responseObserved: true, responseSucceeded: true, correlationMatched: true,
    };
    expect(buildQualificationMediaManifestV1({ ...common, qualification })).toMatchObject({
      sourceCoverage: 'complete', items: [{ role: 'qualification', ownerKind: 'store-qualification', memberId: 'b2b-target' }],
    });
    const certificateOnly = mapSupplierQualificationPayload({
      data: {
        memberId: 'b2b-target',
        certList: [{ certName: 'Factory audit', imageUrl: '//cbu01.alicdn.com/cert.jpg' }],
        propaganda: { companyImg: [] },
      },
    });
    expect(buildQualificationMediaManifestV1({
      ...common, qualification: certificateOnly,
    })).toMatchObject({
      sourceCoverage: 'complete',
      items: [{ sourceField: 'data.certList[0].imageUrl' }],
    });
    expect(buildQualificationMediaManifestV1({
      ...common,
      qualification: mapSupplierQualificationPayload({ data: { memberId: 'b2b-target', certList: [], propaganda: { companyImg: [] } } }),
    })).toMatchObject({
      sourceCoverage: 'authoritative-empty', reasonCode: 'QUALIFICATION_MEDIA_SOURCE_EMPTY', items: [],
    });
    expect(buildQualificationMediaManifestV1({
      ...common,
      qualification: mapSupplierQualificationPayload({
        data: {
          memberId: 'b2b-target',
          certList: { imageUrl: '//cbu01.alicdn.com/cert.jpg' },
          propaganda: { companyImg: [] },
        },
      }),
    })).toMatchObject({
      sourceCoverage: 'failed', reasonCode: 'QUALIFICATION_PARSE_FAILED', items: [],
    });
    expect(buildQualificationMediaManifestV1({
      ...common, qualification: null, responseObserved: false,
    })).toMatchObject({
      sourceCoverage: 'failed', reasonCode: 'QUALIFICATION_RESPONSE_NOT_OBSERVED', items: [],
    });
  });
});
