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
      data: { memberId: 'b2b-sanitized-supplier', businessInfo: {} },
    });
    expect(notPresent.registeredBusinessScope).toMatchObject({
      availability: 'not-present',
      value: null,
    });
  });
});
