import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  mapSupplierQualificationPayload,
} from '../src/session/supplier-qualification.js';

describe('mapSupplierQualificationPayload', () => {
  it('keeps registered business scope available when the certificate list is empty', async () => {
    const payload = JSON.parse(await readFile(new URL(
      './fixtures/store-qualification/basic-info.json',
      import.meta.url,
    ), 'utf8'));
    const result = mapSupplierQualificationPayload(
      payload,
      '2026-07-22T00:00:00.000Z',
    );

    expect(result.registeredBusinessScope).toMatchObject({
      availability: 'available',
      value: '一般项目：风动和电动工具制造；户外用品销售。',
    });
    expect(result.registeredAddress).toMatchObject({
      availability: 'available',
      value: '浙江省某市某工业园区',
    });
    expect(result.sellerType).toMatchObject({ availability: 'available', value: '生产厂家' });
    expect(result.strengthSignals).toEqual([
      { key: 'factoryInspection', label: '深度验厂', value: true },
      { key: 'superFactory', label: '超级工厂', value: false },
    ]);
    expect(result.strengthSignalsAvailability).toBe('available');
    expect(result.guaranteeItems).toEqual([
      { key: 'returnFreight', label: '退货包运费', value: 'enabled' },
    ]);
    expect(result.guaranteeItemsAvailability).toBe('available');
    expect(result.certificates).toEqual([]);
    expect(result.certificateListAvailability).toBe('available');
    expect(result.certificationImages).toEqual([
      {
        type: '营业执照',
        url: 'https://img.example.test/license.jpg',
      },
    ]);
    expect(result.source.fieldPath).toBe('data.businessInfo.companyBusinessLine');
  });

  it('distinguishes a failed payload from a genuine missing field', () => {
    const failed = mapSupplierQualificationPayload({ ret: ['FAIL_SYS'] });
    expect(failed.registeredBusinessScope).toMatchObject({
      availability: 'failed',
      value: null,
      error: { code: 'QUALIFICATION_DATA_MISSING' },
    });

    const notPresent = mapSupplierQualificationPayload({
      data: {
        memberId: 'b2b-sanitized-supplier', businessInfo: {},
        contactName: 'DO_NOT_ARCHIVE', phone: '13800000000', cookie: 'secret-cookie',
      },
    });
    expect(notPresent.registeredBusinessScope).toMatchObject({
      availability: 'not-present',
      value: null,
    });
    expect(JSON.stringify(notPresent)).not.toMatch(/DO_NOT_ARCHIVE|13800000000|secret-cookie/);
  });

  it('treats a present non-array certList as schema failure', () => {
    const malformed = mapSupplierQualificationPayload({
      data: {
        memberId: 'b2b-sanitized-supplier',
        certList: { imageUrl: '//cbu01.alicdn.com/cert.jpg' },
      },
    });
    expect(malformed).toMatchObject({
      certificates: [],
      certificateListAvailability: 'failed',
      warnings: [{
        code: 'QUALIFICATION_CERT_LIST_SCHEMA_INVALID',
        fieldPath: 'data.certList',
      }],
    });
  });
});
