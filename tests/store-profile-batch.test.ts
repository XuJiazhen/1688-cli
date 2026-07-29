import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createStoreProfileBatch } from '../src/collection/store-profile-batch.js';
import { mapStoreProfilePayload } from '../src/session/store-profile.js';

const unit = {
  schemaVersion: 1 as const,
  unitId: 'unit-store-profile-1',
  collectionTaskId: 'collection-task-1',
  kind: 'store-profile' as const,
  subject: {
    supplier: {
      memberId: 'b2b-sanitized-supplier',
      shopUrl: 'https://fixture-profile.1688.com/',
    },
  },
  scope: { requestedScope: 'page' as const },
};

describe('createStoreProfileBatch', () => {
  it('archives supported profile facts and treats source-declared absence as complete', async () => {
    const payload = JSON.parse(
      await readFile(
        new URL('./fixtures/store-profile/basic.json', import.meta.url),
        'utf8',
      ),
    );
    const batch = createStoreProfileBatch({
      unit,
      batchId: 'batch-store-profile-1',
      payload,
      collectedAt: '2026-07-28T00:00:01.000Z',
      startedAt: '2026-07-28T00:00:00.000Z',
      completedAt: '2026-07-28T00:00:02.000Z',
      sourceRef: 'capture:store-profile/sanitized-supplier',
      rawEvidenceRefs: ['artifact:store-profile/sanitized-supplier'],
    });

    expect(batch).toMatchObject({
      schemaVersion: 1,
      batchId: 'batch-store-profile-1',
      unitId: 'unit-store-profile-1',
      kind: 'store-profile',
      status: 'completed',
      completeness: {
        requestedScope: 'page',
        state: 'complete',
        observedPages: [1],
        failedPages: [],
        expectedItems: 1,
        uniqueItems: 1,
      },
      errors: [],
      metrics: {
        profileSnapshots: 1,
        notCollectedFacts: 0,
        failedFacts: 0,
      },
    });
    expect(batch.observations[0]).toMatchObject({
      requestMemberId: 'b2b-sanitized-supplier',
      name: { availability: 'available', value: '脱敏电动工具商行' },
      region: { availability: 'not-present', value: null },
      address: { availability: 'not-present', value: null },
    });
    expect(batch.checkpoint).toBeUndefined();
    expect(batch.rawEvidenceRefs).toEqual([
      'artifact:store-profile/sanitized-supplier',
    ]);
    expect(batch).not.toHaveProperty('qualified');
    expect(batch).not.toHaveProperty('ruleResult');
  });

  it('returns failed evidence and a resumable checkpoint for an unreadable payload', () => {
    const batch = createStoreProfileBatch({
      unit,
      batchId: 'batch-store-profile-failed',
      payload: { ret: ['FAIL_SYS::sanitized failure'] },
      collectedAt: '2026-07-28T01:00:01.000Z',
      startedAt: '2026-07-28T01:00:00.000Z',
      completedAt: '2026-07-28T01:00:02.000Z',
    });

    expect(batch).toMatchObject({
      kind: 'store-profile',
      status: 'failed',
      completeness: {
        state: 'unknown',
        observedPages: [],
        failedPages: [1],
        uniqueItems: 0,
      },
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'STORE_PROFILE_DATA_MISSING',
          retryable: true,
        }),
      ]),
      checkpoint: {
        kind: 'store-profile',
        nextPage: 1,
        attemptCounts: { 'store-profile': 1 },
      },
    });
    expect(batch.observations[0]).toMatchObject({
      name: { availability: 'failed', value: null },
      region: { availability: 'failed', value: null },
    });
  });

  it('resumes the same field checkpoint and increments its attempt count', () => {
    const first = createStoreProfileBatch({
      unit,
      batchId: 'batch-store-profile-attempt-1',
      payload: { ret: ['FAIL_SYS::sanitized failure'] },
      collectedAt: '2026-07-28T01:10:01.000Z',
      startedAt: '2026-07-28T01:10:00.000Z',
      completedAt: '2026-07-28T01:10:02.000Z',
    });
    const second = createStoreProfileBatch({
      unit,
      checkpoint: first.checkpoint,
      batchId: 'batch-store-profile-attempt-2',
      payload: { ret: ['FAIL_SYS::sanitized failure'] },
      collectedAt: '2026-07-28T01:11:01.000Z',
      startedAt: '2026-07-28T01:11:00.000Z',
      completedAt: '2026-07-28T01:11:02.000Z',
    });

    expect(second.checkpoint).toMatchObject({
      unitFingerprint: first.checkpoint?.unitFingerprint,
      pendingKeys: first.checkpoint?.pendingKeys,
      attemptCounts: { 'store-profile': 2 },
    });
  });

  it('rejects another collection kind at the batch boundary', () => {
    expect(() =>
      createStoreProfileBatch({
        unit: { ...unit, kind: 'store-catalog' },
        batchId: 'batch-store-profile-wrong-kind',
        payload: {},
        collectedAt: '2026-07-28T02:00:01.000Z',
        startedAt: '2026-07-28T02:00:00.000Z',
        completedAt: '2026-07-28T02:00:02.000Z',
      }),
    ).toThrow(/store-profile CollectionUnit/);
  });

  it('rejects a parsed fixture that invents a value for not-present evidence', () => {
    const profile = mapStoreProfilePayload({
      data: { model: { shopName: '脱敏工具商行' } },
    });

    expect(() =>
      createStoreProfileBatch({
        unit,
        batchId: 'batch-store-profile-invalid-evidence',
        profile: {
          ...profile,
          region: {
            ...profile.region,
            value: '伪造地区',
          } as never,
        },
        startedAt: '2026-07-28T03:00:00.000Z',
        completedAt: '2026-07-28T03:00:02.000Z',
      }),
    ).toThrow(/value must be null when availability is not-present/);
  });

  it('rejects not-collected profile evidence at the batch boundary', () => {
    const profile = mapStoreProfilePayload({
      data: { model: { shopName: '脱敏工具商行' } },
    });

    expect(() =>
      createStoreProfileBatch({
        unit,
        batchId: 'batch-store-profile-not-collected',
        profile: {
          ...profile,
          region: {
            availability: 'not-collected',
            value: null,
            source: profile.region.source,
          },
        },
        startedAt: '2026-07-28T04:00:00.000Z',
        completedAt: '2026-07-28T04:00:02.000Z',
      }),
    ).toThrow(/never not-collected/);
  });
});
