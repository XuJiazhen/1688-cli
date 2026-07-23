import { describe, expect, it } from 'vitest';
import { createQualificationBatch } from '../src/collection/qualification-batch.js';
import { mapSupplierQualificationPayload } from '../src/session/supplier-qualification.js';

const unit = {
  schemaVersion: 1 as const,
  unitId: 'unit-qualification-1',
  taskId: 'task-1',
  kind: 'store-qualification' as const,
  subject: {
    supplier: { memberId: 'b2b-sanitized-supplier' },
  },
  scope: {
    requestedScope: 'page' as const,
    requestedFacts: [
      'registeredBusinessScope',
      'socialCreditCode',
      'certificates',
    ],
  },
};

describe('createQualificationBatch', () => {
  it('keeps registered business scope independent from an empty certificate list', () => {
    const batch = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-1',
      payload: {
        data: {
          memberId: 'b2b-sanitized-supplier',
          companyName: '脱敏工具有限公司',
          certList: [],
          businessInfo: {
            companyBusinessLine: '一般项目：户外用品销售。',
            socialCreditCode: 'SANITIZED-CREDIT-CODE',
          },
        },
      },
      collectedAt: '2026-07-22T00:00:01.000Z',
      startedAt: '2026-07-22T00:00:00.000Z',
      completedAt: '2026-07-22T00:00:02.000Z',
    });

    expect(batch).toMatchObject({
      schemaVersion: 1,
      batchId: 'batch-qualification-1',
      unitId: 'unit-qualification-1',
      kind: 'store-qualification',
      status: 'completed',
      completeness: {
        requestedScope: 'page',
        state: 'complete',
        observedPages: [1],
        failedPages: [],
        uniqueItems: 1,
      },
      errors: [],
      rawEvidenceRefs: [],
    });
    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0]).toMatchObject({
      memberId: 'b2b-sanitized-supplier',
      registeredBusinessScope: {
        availability: 'available',
        value: '一般项目：户外用品销售。',
        source: { collectedAt: '2026-07-22T00:00:01.000Z' },
      },
      socialCreditCode: {
        availability: 'available',
        value: 'SANITIZED-CREDIT-CODE',
      },
      certificates: [],
      certificateListAvailability: 'available',
    });
    expect(batch.observations[0]).not.toHaveProperty('allowedToSell');
    expect(batch).not.toHaveProperty('qualified');
  });

  it('accepts a parsed qualification and preserves distinct facts and source refs', () => {
    const qualification = mapSupplierQualificationPayload(
      {
        data: {
          memberId: 'b2b-sanitized-supplier',
          companyName: '脱敏工具有限公司',
          summary: '店铺自述内容',
          productionService: '帐篷加工；户外用品加工',
          businessLine: '户外用品',
          certList: [
            {
              certName: '质量管理体系认证',
              certType: 'management-system',
              imgUrl: '//img.example.test/certificate.jpg',
            },
          ],
          businessInfo: {
            companyBusinessLine: '一般项目：户外用品制造及销售。',
            companyYearStarted: '2024-05-27',
            socialCreditCode: 'SANITIZED-CREDIT-CODE',
          },
          propaganda: {
            companyImg: [
              { type: '营业执照', url: '//img.example.test/license.jpg' },
            ],
          },
        },
      },
      '2026-07-22T01:00:00.000Z',
    );
    const batch = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-parsed',
      qualification,
      startedAt: '2026-07-22T00:59:59.000Z',
      completedAt: '2026-07-22T01:00:01.000Z',
      sourceRef: 'capture:qualification/sanitized-supplier',
      rawEvidenceRefs: ['artifact:qualification/raw-sanitized-supplier'],
    });

    expect(batch.rawEvidenceRefs).toEqual([
      'artifact:qualification/raw-sanitized-supplier',
    ]);
    expect(batch.observations[0]).toMatchObject({
      companyName: { availability: 'available', value: '脱敏工具有限公司' },
      registeredBusinessScope: {
        availability: 'available',
        value: '一般项目：户外用品制造及销售。',
        source: {
          sourceRef: 'capture:qualification/sanitized-supplier',
          rawRef: 'artifact:qualification/raw-sanitized-supplier',
          collectedAt: '2026-07-22T01:00:00.000Z',
        },
      },
      socialCreditCode: {
        availability: 'available',
        value: 'SANITIZED-CREDIT-CODE',
      },
      establishedAt: { availability: 'available', value: '2024-05-27' },
      shopSummary: { availability: 'available', value: '店铺自述内容' },
      productionService: {
        availability: 'available',
        value: '帐篷加工；户外用品加工',
      },
      businessLine: { availability: 'available', value: '户外用品' },
      certificates: [
        {
          name: '质量管理体系认证',
          type: 'management-system',
          imageUrl: 'https://img.example.test/certificate.jpg',
        },
      ],
      certificationImages: [
        { type: '营业执照', url: 'https://img.example.test/license.jpg' },
      ],
      source: {
        sourceRef: 'capture:qualification/sanitized-supplier',
        collectedAt: '2026-07-22T01:00:00.000Z',
      },
    });
  });

  it('treats an absent business scope as collected-but-not-present', () => {
    const batch = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-not-present',
      payload: {
        data: {
          memberId: 'b2b-sanitized-supplier',
          companyName: '脱敏工具有限公司',
          businessInfo: {},
        },
      },
      collectedAt: '2026-07-22T02:00:00.000Z',
      startedAt: '2026-07-22T01:59:59.000Z',
      completedAt: '2026-07-22T02:00:01.000Z',
    });

    expect(batch.status).toBe('completed');
    expect(batch.completeness).toMatchObject({
      state: 'complete',
      observedPages: [1],
      failedPages: [],
      uniqueItems: 1,
    });
    expect(batch.errors).toEqual([]);
    expect(batch.observations[0]).toMatchObject({
      registeredBusinessScope: {
        availability: 'not-present',
        value: null,
      },
      certificates: [],
      certificateListAvailability: 'not-present',
    });
  });

  it('returns retry evidence and an unknown checkpoint when the payload fails', () => {
    const batch = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-failed',
      payload: { ret: ['FAIL_SYS::sanitized failure'] },
      collectedAt: '2026-07-22T03:00:00.000Z',
      startedAt: '2026-07-22T02:59:59.000Z',
      completedAt: '2026-07-22T03:00:01.000Z',
      sourceRef: 'capture:qualification/failed-sanitized-supplier',
      rawEvidenceRefs: ['artifact:qualification/failed-sanitized-supplier'],
    });

    expect(batch).toMatchObject({
      status: 'failed',
      completeness: {
        requestedScope: 'page',
        state: 'unknown',
        observedPages: [],
        failedPages: [1],
        uniqueItems: 0,
      },
      errors: [
        {
          code: 'QUALIFICATION_DATA_MISSING',
          retryable: true,
          details: {
            sourceRef: 'capture:qualification/failed-sanitized-supplier',
          },
        },
      ],
      checkpoint: {
        kind: 'store-qualification',
        nextPage: 1,
        completedPages: [],
        pendingKeys: ['qualification'],
        attemptCounts: { qualification: 1 },
      },
    });
    expect(batch.checkpoint?.unitFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(batch.observations[0]).toMatchObject({
      registeredBusinessScope: {
        availability: 'failed',
        value: null,
        error: { code: 'QUALIFICATION_DATA_MISSING' },
      },
      certificateListAvailability: 'failed',
    });
    expect(batch.observations[0]).not.toHaveProperty('rejected');
  });

  it('restores a compatible single-page checkpoint when retrying a failed payload', () => {
    const first = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-failed-1',
      payload: { ret: ['FAIL_SYS::sanitized failure'] },
      collectedAt: '2026-07-22T04:00:00.000Z',
      startedAt: '2026-07-22T03:59:59.000Z',
      completedAt: '2026-07-22T04:00:01.000Z',
    });
    const retried = createQualificationBatch({
      unit,
      checkpoint: first.checkpoint,
      batchId: 'batch-qualification-failed-2',
      payload: { ret: ['FAIL_SYS::sanitized failure again'] },
      collectedAt: '2026-07-22T04:01:00.000Z',
      startedAt: '2026-07-22T04:00:59.000Z',
      completedAt: '2026-07-22T04:01:01.000Z',
    });

    expect(retried.checkpoint).toMatchObject({
      unitFingerprint: first.checkpoint?.unitFingerprint,
      nextPage: 1,
      attemptCounts: { qualification: 2 },
    });
  });

  it('keeps other collected facts when one parsed qualification fact failed', () => {
    const parsed = mapSupplierQualificationPayload(
      {
        data: {
          memberId: 'b2b-sanitized-supplier',
          companyName: '脱敏工具有限公司',
          certList: [],
          businessInfo: {},
        },
      },
      '2026-07-22T05:00:00.000Z',
    );
    const qualification = {
      ...parsed,
      registeredBusinessScope: {
        availability: 'failed' as const,
        value: null,
        source: parsed.registeredBusinessScope.source,
        error: {
          code: 'QUALIFICATION_SCOPE_FAILED',
          message: 'The registered business scope field could not be parsed.',
        },
      },
    };
    const batch = createQualificationBatch({
      unit,
      batchId: 'batch-qualification-partial',
      qualification,
      startedAt: '2026-07-22T04:59:59.000Z',
      completedAt: '2026-07-22T05:00:01.000Z',
    });

    expect(batch).toMatchObject({
      status: 'partial',
      completeness: {
        state: 'unknown',
        observedPages: [1],
        failedPages: [1],
        uniqueItems: 1,
      },
      errors: [
        {
          code: 'QUALIFICATION_SCOPE_FAILED',
          message: 'The registered business scope field could not be parsed.',
          retryable: true,
        },
      ],
      checkpoint: {
        nextPage: 1,
        pendingKeys: ['qualification'],
      },
    });
    expect(batch.observations[0]).toMatchObject({
      companyName: { availability: 'available', value: '脱敏工具有限公司' },
      registeredBusinessScope: {
        availability: 'failed',
        value: null,
      },
    });
  });
});
