import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionBatch } from '../src/collection/contracts.js';
import { CliError } from '../src/io/errors.js';
import {
  parseProductionCollectionRpcRequestV1,
  productionCollectionRequestHashV1,
  type ProductionCollectionRpcRequestV1,
} from '../src/daemon/production-collection-protocol.js';
import {
  persistProductionCollectionRawEvidence,
  ProductionCollectionRuntime,
} from '../src/daemon/production-collection-runtime.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('production collection protocol', () => {
  it('accepts maxSearchPages=0 and rejects unknown compatibility fields', () => {
    const parsed = parseProductionCollectionRpcRequestV1(request());
    expect(parsed.workInput.maxSearchPages).toBe(0);
    expect(productionCollectionRequestHashV1(parsed)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => parseProductionCollectionRpcRequestV1({
      ...request(),
      reservationFence: { legacy: true },
    })).toThrow(/not allowed/);
  });

  it('rejects a Search page beyond a positive frozen page limit', () => {
    expect(() => parseProductionCollectionRpcRequestV1({
      ...request(),
      workInput: {
        kind: 'search_page',
        querySnapshotHash: '1'.repeat(64),
        page: 3,
        maxSearchPages: 2,
      },
    })).toThrow(/cannot exceed/);
  });

  it('requires exactly pages 1-3 for store_pages', () => {
    expect(() => parseProductionCollectionRpcRequestV1({
      ...request('store_pages'),
      workInput: {
        kind: 'store_pages',
        memberId: 'b2b-member',
        normalizedStoreUrl: 'https://fixture.1688.com/',
        firstPage: 1,
        lastPageInclusive: 4,
      },
    })).toThrow(/exactly pages 1-3/);
  });
});

describe('ProductionCollectionRuntime', () => {
  it('preserves external intervention categories across the daemon RPC boundary', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const runtime = new ProductionCollectionRuntime({
      profileId: PROFILE_ID,
      profileName: 'fixture-profile',
      artifactDirectory,
      runCollection: async () => {
        throw new CliError(4, 'RISK_CONTROL', 'Verification is required.', {
          category: 'risk_challenge',
          retryable: false,
        });
      },
      runWithContext: (operation) => operation(new FakeContext() as unknown as BrowserContext),
    });

    await expect(runtime.handle(parseProductionCollectionRpcRequestV1(request())))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'RISK_CONTROL',
          category: 'risk-control',
          retryable: false,
        },
      });
  });

  it('archives production raw evidence with the canonical artifact authority', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const payload = { data: { data: { companyName: 'Fixture Store' } } };

    const reference = await persistProductionCollectionRawEvidence(
      artifactDirectory,
      payload,
    );

    const serialized = `${JSON.stringify(payload)}\n`;
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serialized),
    );
    const hex = Buffer.from(hash).toString('hex');
    expect(reference).toBe(`artifact:production-collection-raw-${hex}`);
    await expect(fs.readFile(path.join(
      artifactDirectory,
      'production-collection-raw',
      `${hex}.json`,
    ), 'utf8')).resolves.toBe(serialized);
  });

  it('persists one replayable receipt only after owned Page cleanup', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const context = new FakeContext();
    const execute = vi.fn(async (): Promise<CollectionBatch> => {
      const page = new FakePage();
      context.emit('page', page as unknown as Page);
      await page.close();
      return batch();
    });
    const runtime = new ProductionCollectionRuntime({
      profileId: PROFILE_ID,
      profileName: 'fixture-profile',
      artifactDirectory,
      runCollection: execute,
      runWithContext: (operation) => operation(context as unknown as BrowserContext),
    });
    const executeRequest = parseProductionCollectionRpcRequestV1(request());
    const first = await runtime.handle(executeRequest);
    expect(first.ok).toBe(true);
    if (!first.ok || first.data === null) throw new Error('missing receipt');
    expect(first.data.cleanup).toMatchObject({
      ownedPageCount: 1,
      closedPageCount: 1,
      allOwnedPagesClosed: true,
    });
    expect(first.data.rawArtifactHash).toMatch(/^[0-9a-f]{64}$/);

    const replay = await runtime.handle(executeRequest);
    expect(replay.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    const lookup = await runtime.handle(parseProductionCollectionRpcRequestV1({
      ...request(),
      rpcId: 'rpc-lookup',
      method: 'production.collection.lookupReceipt',
    }));
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error('lookup failed');
    expect(lookup.data?.attemptId).toBe(ATTEMPT_ID);
  });
});

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXECUTION_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORK_ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function request(
  kind: ProductionCollectionRpcRequestV1['workKind'] = 'search_page',
): ProductionCollectionRpcRequestV1 {
  const now = Date.now();
  return {
    schema: 'production-collection.rpc.v1',
    rpcId: 'rpc-execute',
    method: 'production.collection.execute',
    deadlineAt: new Date(now + 60_000).toISOString(),
    attemptId: ATTEMPT_ID,
    executionToken: EXECUTION_TOKEN,
    workItemId: WORK_ITEM_ID,
    profileId: PROFILE_ID,
    attemptOrdinal: 1,
    freshnessSeconds: 86_400,
    startNotBefore: new Date(now - 1_000).toISOString(),
    subjectKey: kind === 'search_page'
      ? `search:${'1'.repeat(64)}:page:1`
      : 'fixture-subject',
    workKind: kind,
    workInput: kind === 'search_page'
      ? {
          kind: 'search_page',
          querySnapshotHash: '1'.repeat(64),
          page: 1,
          maxSearchPages: 0,
        }
      : {
          kind: 'store_pages',
          memberId: 'b2b-member',
          normalizedStoreUrl: 'https://fixture.1688.com/',
          firstPage: 1,
          lastPageInclusive: 3,
        },
    query: kind === 'search_page'
      ? {
          keyword: '灭火器',
          sort: 'relevance',
          filters: {},
          advertisementPolicy: 'exclude-p4p',
          contractVersion: 'production-search-v1',
        }
      : null,
  };
}

function batch(): CollectionBatch {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    batchId: 'batch-1',
    unitId: WORK_ITEM_ID,
    kind: 'search-page',
    status: 'completed',
    startedAt: now,
    completedAt: now,
    subject: { keyword: '灭火器' },
    scope: { page: 1, remoteHasMore: false },
    observations: [],
    completeness: {
      requestedScope: 'page',
      state: 'complete',
      observedPages: [1],
      failedPages: [],
      uniqueItems: 0,
    },
    duplicateObservations: [],
    warnings: [],
    errors: [],
    rawEvidenceRefs: [],
    metrics: {},
  };
}

class FakePage {
  private closed = false;

  public isClosed(): boolean { return this.closed; }
  public async close(): Promise<void> { this.closed = true; }
}

class FakeContext extends EventEmitter {}
