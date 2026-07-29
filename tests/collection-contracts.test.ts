import { describe, expect, it } from 'vitest';
import { CliError } from '../src/io/errors.js';
import {
  assertCheckpointCompatible,
  COLLECTION_SCHEMA_VERSION,
  fingerprintCollectionUnit,
  normalizeEvidence,
  normalizeCollectionBatch,
  normalizeCollectionCheckpoint,
  normalizeCollectionUnit,
} from '../src/collection/contracts.js';

describe('collection contracts', () => {
  it('normalizes a bounded collection unit at the public boundary', () => {
    expect(
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: ' unit-1 ',
        taskId: ' task-1 ',
        kind: 'store-catalog',
        subject: {
          supplier: {
            memberId: ' member-1 ',
            shopUrl: 'https://example.1688.com/?b=2&a=1#catalog',
          },
        },
        scope: {
          requestedScope: 'bounded-pages',
          requestedFacts: ['offer.title', ' offer.price ', 'offer.title'],
          pageSize: 30,
          maxPagesPerBatch: 2,
        },
        limits: { maxItems: 60, deadlineMs: 30_000 },
      }),
    ).toEqual({
      schemaVersion: COLLECTION_SCHEMA_VERSION,
      unitId: 'unit-1',
      taskId: 'task-1',
      kind: 'store-catalog',
      subject: {
        supplier: {
          memberId: 'member-1',
          shopUrl: 'https://example.1688.com/?a=1&b=2',
        },
      },
      scope: {
        requestedScope: 'bounded-pages',
        requestedFacts: ['offer.price', 'offer.title'],
        pageSize: 30,
        maxPagesPerBatch: 2,
      },
      limits: { maxItems: 60, deadlineMs: 30_000 },
    });
  });

  it('rejects unsupported versions and subjects that cannot identify the target', () => {
    expect(() =>
      normalizeCollectionUnit({
        schemaVersion: 2,
        unitId: 'unit-1',
        kind: 'search-page',
        subject: { keyword: '帐篷' },
      }),
    ).toThrow(/schemaVersion must be 1/);
    expect(() =>
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'unit-1',
        kind: 'store-profile',
        subject: {},
      }),
    ).toThrow(/supplier is required/);
    expect(() =>
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'unit-1',
        kind: 'store-catalog',
        subject: {},
      }),
    ).toThrow(/supplier is required/);
    expect(() =>
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'unit-1',
        kind: 'offer-detail',
        subject: { offerId: 'not-an-offer-id' },
      }),
    ).toThrow(/offerId must contain only digits/);
  });

  it('accepts store-profile as a first-class supplier collection unit', () => {
    expect(
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'profile-unit-1',
        collectionTaskId: 'collection-task-1',
        kind: 'store-profile',
        subject: {
          supplier: {
            memberId: 'b2b-sanitized-supplier',
            shopUrl: 'https://fixture-profile.1688.com/#about',
          },
        },
        scope: { requestedScope: 'page' },
      }),
    ).toEqual({
      schemaVersion: 1,
      unitId: 'profile-unit-1',
      collectionTaskId: 'collection-task-1',
      kind: 'store-profile',
      subject: {
        supplier: {
          memberId: 'b2b-sanitized-supplier',
          shopUrl: 'https://fixture-profile.1688.com/',
        },
      },
      scope: { requestedScope: 'page' },
    });
  });

  it('fingerprints collection semantics without binding a checkpoint to batch limits', () => {
    const first = {
      schemaVersion: 1,
      unitId: 'unit-1',
      taskId: 'task-a',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: {
        requestedScope: 'bounded-pages',
        sort: 'sales',
        pageSize: 30,
        maxPagesPerBatch: 2,
      },
      limits: { maxItems: 60, deadlineMs: 30_000 },
    };
    const resumed = {
      ...first,
      unitId: 'unit-retry',
      taskId: undefined,
      collectionTaskId: 'collection-task-b',
      scope: { ...first.scope, maxPagesPerBatch: 5 },
      limits: { maxItems: 150, deadlineMs: 60_000 },
    };

    expect(fingerprintCollectionUnit(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprintCollectionUnit(resumed)).toBe(fingerprintCollectionUnit(first));
    expect(
      fingerprintCollectionUnit({
        ...resumed,
        scope: { ...resumed.scope, sort: 'price-asc' },
      }),
    ).not.toBe(fingerprintCollectionUnit(first));
  });

  it('keeps collection ownership explicit and rejects ambiguous legacy ownership', () => {
    expect(
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'unit-owned-1',
        collectionTaskId: 'collection-task-1',
        kind: 'store-profile',
        subject: {
          supplier: { memberId: 'b2b-sanitized-supplier' },
        },
      }),
    ).toMatchObject({
      collectionTaskId: 'collection-task-1',
      kind: 'store-profile',
    });
    expect(() =>
      normalizeCollectionUnit({
        schemaVersion: 1,
        unitId: 'unit-ambiguous-1',
        collectionTaskId: 'collection-task-1',
        taskId: 'legacy-selection-task-1',
        kind: 'store-profile',
        subject: {
          supplier: { memberId: 'b2b-sanitized-supplier' },
        },
      }),
    ).toThrow(/must not both be set/);
  });

  it('normalizes available evidence while preserving the observed value', () => {
    expect(
      normalizeEvidence<{ businessLine: string }>({
        availability: 'available',
        value: { businessLine: '户外用品销售' },
        source: {
          sourceType: 'supplier-payload',
          api: ' company.info ',
          fieldPath: ' businessInfo.companyBusinessLine ',
          sourceRef: ' artifact:supplier/member-1 ',
          collectedAt: '2026-07-22T08:00:00+08:00',
          collectorVersion: ' 0.1.47 ',
          parserVersion: ' supplier-v1 ',
        },
      }),
    ).toEqual({
      availability: 'available',
      value: { businessLine: '户外用品销售' },
      source: {
        sourceType: 'supplier-payload',
        api: 'company.info',
        fieldPath: 'businessInfo.companyBusinessLine',
        sourceRef: 'artifact:supplier/member-1',
        collectedAt: '2026-07-22T00:00:00.000Z',
        collectorVersion: '0.1.47',
        parserVersion: 'supplier-v1',
      },
    });
  });

  it('keeps missing evidence distinct from a numeric zero', () => {
    const source = {
      sourceType: 'offer-payload',
      sourceRef: 'payload:offer/123',
      collectedAt: '2026-07-22T00:00:00Z',
      collectorVersion: '0.1.47',
      parserVersion: 'offer-v2',
    };

    expect(
      normalizeEvidence({
        availability: 'not-present',
        value: null,
        source,
      }),
    ).toMatchObject({ availability: 'not-present', value: null });
    expect(() =>
      normalizeEvidence({
        availability: 'not-present',
        value: 0,
        source,
      }),
    ).toThrow(/value must be null/);
  });

  it('rejects public evidence references containing replayable credentials', () => {
    expect(() =>
      normalizeEvidence({
        availability: 'failed',
        value: null,
        source: {
          sourceType: 'store-catalog',
          sourceRef: 'https://h5api.m.1688.com/h5/api/1.0/?api=x&sign=secret',
          collectedAt: '2026-07-22T00:00:00Z',
          collectorVersion: '0.1.47',
          parserVersion: 'catalog-v1',
        },
      }),
    ).toThrow(/sourceRef.*sensitive query parameter/i);
  });

  it('rejects evidence values that cannot cross the JSON contract boundary', () => {
    expect(() =>
      normalizeEvidence({
        availability: 'available',
        value: { bookedCount: Number.NaN },
        source: {
          sourceType: 'offer-payload',
          sourceRef: 'payload:offer/123',
          collectedAt: '2026-07-22T00:00:00Z',
          collectorVersion: '0.1.47',
          parserVersion: 'offer-v2',
        },
      }),
    ).toThrow(/only finite numbers/);
  });

  it('normalizes a resumable checkpoint without losing pending work', () => {
    const unit = normalizeCollectionUnit({
      schemaVersion: 1,
      unitId: 'unit-2',
      kind: 'store-catalog',
      subject: { supplier: { memberId: 'member-2' } },
      scope: { requestedScope: 'full-scan', pageSize: 30 },
    });

    expect(
      normalizeCollectionCheckpoint({
        schemaVersion: 1,
        unitFingerprint: fingerprintCollectionUnit(unit),
        kind: 'store-catalog',
        subject: unit.subject,
        scope: unit.scope,
        nextPage: 2,
        completedPages: [1, 1],
        seenKeys: ['offer-2', 'offer-1', 'offer-1'],
        pendingKeys: ['offer-3', 'offer-3'],
        pendingItems: [{ key: 'offer-3', value: { rank: 3 } }],
        attemptCounts: { 'page:2': 1 },
        updatedAt: '2026-07-22T08:30:00+08:00',
      }),
    ).toEqual({
      schemaVersion: 1,
      unitFingerprint: fingerprintCollectionUnit(unit),
      kind: 'store-catalog',
      subject: unit.subject,
      scope: unit.scope,
      nextPage: 2,
      completedPages: [1],
      seenKeys: ['offer-1', 'offer-2'],
      pendingKeys: ['offer-3'],
      pendingItems: [{ key: 'offer-3', value: { rank: 3 } }],
      attemptCounts: { 'page:2': 1 },
      updatedAt: '2026-07-22T00:30:00.000Z',
    });
  });

  it('rejects checkpoint page ceilings that cannot cover known catalog progress', () => {
    const checkpoint = {
      schemaVersion: 1,
      unitFingerprint: `sha256:${'a'.repeat(64)}`,
      kind: 'store-catalog',
      subject: { supplier: { memberId: 'member-2' } },
      scope: { requestedScope: 'full-scan' },
      nextPage: 4,
      expectedPages: 7,
      completedPages: [1, 2, 3],
      seenKeys: [],
      pendingKeys: [],
      attemptCounts: {},
      updatedAt: '2026-07-22T00:30:00.000Z',
    };

    expect(() =>
      normalizeCollectionCheckpoint({
        ...checkpoint,
        pageCeiling: 1,
      }),
    ).toThrow(/pageCeiling must cover/);
    expect(() =>
      normalizeCollectionCheckpoint({
        ...checkpoint,
        expectedPages: undefined,
        pageCeiling: 4,
      }),
    ).toThrow(/pageCeiling requires expectedPages/);
  });

  it('rejects a checkpoint when its collection semantics do not match the unit', () => {
    const unit = normalizeCollectionUnit({
      schemaVersion: 1,
      unitId: 'unit-3',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: { requestedScope: 'page', sort: 'sales' },
    });
    const checkpoint = {
      schemaVersion: 1,
      unitFingerprint: fingerprintCollectionUnit({
        ...unit,
        subject: { keyword: '睡袋' },
      }),
      kind: 'search-page',
      subject: { keyword: '睡袋' },
      scope: unit.scope,
      completedPages: [1],
      seenKeys: ['offer-1'],
      pendingKeys: [],
      attemptCounts: {},
      updatedAt: '2026-07-22T00:00:00Z',
    };

    try {
      assertCheckpointCompatible(unit, checkpoint);
      throw new Error('Expected checkpoint compatibility validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({
        exitCode: 2,
        code: 'CHECKPOINT_INCOMPATIBLE',
        details: { category: 'collection-contract' },
      });
    }
  });

  it('accepts a compatible checkpoint when only retry identity and limits change', () => {
    const unit = normalizeCollectionUnit({
      schemaVersion: 1,
      unitId: 'unit-original',
      kind: 'search-page',
      subject: { keyword: '帐篷' },
      scope: {
        requestedScope: 'bounded-pages',
        pageSize: 30,
        maxPagesPerBatch: 1,
      },
      limits: { maxItems: 30 },
    });
    const checkpoint = {
      schemaVersion: 1,
      unitFingerprint: fingerprintCollectionUnit(unit),
      kind: unit.kind,
      subject: unit.subject,
      scope: unit.scope,
      nextPage: 2,
      completedPages: [1],
      seenKeys: ['offer-1'],
      pendingKeys: [],
      attemptCounts: {},
      updatedAt: '2026-07-22T00:00:00Z',
    };

    expect(
      assertCheckpointCompatible(
        {
          ...unit,
          unitId: 'unit-retry',
          scope: { ...unit.scope, maxPagesPerBatch: 3 },
          limits: { maxItems: 90 },
        },
        checkpoint,
      ),
    ).toMatchObject({ nextPage: 2, completedPages: [1] });
  });

  it('normalizes a partial batch with observations, failures, and a checkpoint', () => {
    const unit = normalizeCollectionUnit({
      schemaVersion: 1,
      unitId: 'unit-4',
      kind: 'store-catalog',
      subject: { supplier: { memberId: 'member-4' } },
      scope: { requestedScope: 'full-scan', pageSize: 30 },
    });
    const checkpoint = {
      schemaVersion: 1,
      unitFingerprint: fingerprintCollectionUnit(unit),
      kind: unit.kind,
      subject: unit.subject,
      scope: unit.scope,
      nextPage: 2,
      completedPages: [1],
      seenKeys: ['offer-1'],
      pendingKeys: [],
      attemptCounts: { 'page:2': 1 },
      updatedAt: '2026-07-22T00:01:00Z',
    };

    expect(
      normalizeCollectionBatch({
        schemaVersion: 1,
        batchId: ' batch-1 ',
        unitId: unit.unitId,
        kind: unit.kind,
        status: 'partial',
        startedAt: '2026-07-22T08:00:00+08:00',
        completedAt: '2026-07-22T08:01:00+08:00',
        subject: unit.subject,
        scope: unit.scope,
        observations: [{ offerId: 'offer-1', page: 1 }],
        completeness: {
          requestedScope: 'full-scan',
          state: 'truncated',
          observedPages: [1, 1],
          failedPages: [2, 2],
          expectedItems: 33,
          uniqueItems: 1,
        },
        duplicateObservations: [
          {
            key: ' offer-1 ',
            firstSource: ' page:1 ',
            duplicateSource: ' page:2 ',
          },
        ],
        warnings: [{ code: 'COUNT_DRIFT', message: ' offer count changed ' }],
        errors: [
          { code: 'PAGE_FAILED', message: ' page 2 failed ', retryable: true },
        ],
        checkpoint,
        rawEvidenceRefs: ['artifact:catalog/page-1', 'artifact:catalog/page-1'],
        metrics: { durationMs: 60_000, requests: 2 },
      }),
    ).toMatchObject({
      schemaVersion: 1,
      batchId: 'batch-1',
      status: 'partial',
      startedAt: '2026-07-22T00:00:00.000Z',
      completedAt: '2026-07-22T00:01:00.000Z',
      completeness: {
        requestedScope: 'full-scan',
        state: 'truncated',
        observedPages: [1],
        failedPages: [2],
        expectedItems: 33,
        uniqueItems: 1,
      },
      duplicateObservations: [
        { key: 'offer-1', firstSource: 'page:1', duplicateSource: 'page:2' },
      ],
      warnings: [{ code: 'COUNT_DRIFT', message: 'offer count changed' }],
      errors: [{ code: 'PAGE_FAILED', message: 'page 2 failed', retryable: true }],
      rawEvidenceRefs: ['artifact:catalog/page-1'],
      checkpoint: { ...checkpoint, updatedAt: '2026-07-22T00:01:00.000Z' },
    });
  });
});
