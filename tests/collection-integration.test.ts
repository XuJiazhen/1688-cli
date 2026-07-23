import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectionBatch, CollectionUnit } from '../src/collection/contracts.js';
import {
  createFixtureCollectionRuntime,
  executeCollectionUnit,
} from '../src/commands/collect.js';

class FakeFactStore {
  private readonly batches = new Map<string, CollectionBatch>();

  ingest(batch: CollectionBatch): void {
    this.batches.set(`${batch.unitId}:${batch.batchId}`, batch);
  }

  snapshots(kind: CollectionBatch['kind']): CollectionBatch[] {
    return [...this.batches.values()].filter((batch) => batch.kind === kind);
  }
}

describe('CollectionBatch ingestion contract', () => {
  it('supports idempotent ingestion and immutable fact snapshots outside the CLI', async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'tests/fixtures/store-catalog/page-1.json'),
        'utf8',
      ),
    );
    const unit: CollectionUnit = {
      schemaVersion: 1,
      unitId: 'integration-catalog-1',
      taskId: 'selection-task-1',
      kind: 'store-catalog',
      subject: { supplier: { memberId: 'b2b-fixture-supplier' } },
      scope: { requestedScope: 'page', pageSize: 2 },
    };
    const batch = await executeCollectionUnit({
      unit,
      runtime: createFixtureCollectionRuntime({ pages: [{ payload }] }),
    });
    const store = new FakeFactStore();

    store.ingest(batch);
    store.ingest(batch);

    const snapshots = store.snapshots('store-catalog');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      subject: { supplier: { memberId: 'b2b-fixture-supplier' } },
      completeness: { state: 'complete', uniqueItems: 2 },
    });
    expect(snapshots[0]?.observations.map((item) => item.offerId)).toEqual([
      '900000000201',
      '900000000202',
    ]);
    expect(snapshots[0]).not.toHaveProperty('qualified');
    expect(snapshots[0]).not.toHaveProperty('ruleResult');
  });
});
