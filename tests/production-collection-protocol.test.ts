import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Request, Response } from 'playwright';
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
  it('accepts the frozen Search limits and rejects unknown compatibility fields', () => {
    const parsed = parseProductionCollectionRpcRequestV1(request());
    expect(parsed.workInput.maxSearchPages).toBe(0);
    expect(parsed.workInput.maxCandidates).toBe(5);
    expect(parsed.workInput.candidatesPerPage).toBe(5);
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
        maxCandidates: 5,
        candidatesPerPage: 5,
      },
    })).toThrow(/cannot exceed/);
  });

  it('rejects a Search candidate limit outside the production bound', () => {
    expect(() => parseProductionCollectionRpcRequestV1({
      ...request(),
      workInput: {
        kind: 'search_page',
        querySnapshotHash: '1'.repeat(64),
        page: 1,
        maxSearchPages: 1,
        maxCandidates: 501,
        candidatesPerPage: 5,
      },
    })).toThrow(/cannot exceed 500/);
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
  it('denies execution before opening a Context when runtime admission is absent', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const runWithContext = vi.fn(async (operation) => operation(
      new FakeContext() as unknown as BrowserContext,
    ));
    const owner = runtimeOwner();
    const runtime = new ProductionCollectionRuntime({
      ...owner,
      authorizeRuntime: undefined,
      artifactDirectory,
      runWithContext,
    });

    await expect(runtime.handle(parseProductionCollectionRpcRequestV1(request())))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_REQUIRED' },
      });
    expect(runWithContext).not.toHaveBeenCalled();
  });

  it('preserves external intervention categories across the daemon RPC boundary', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const runtime = new ProductionCollectionRuntime({
      ...runtimeOwner(),
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
    // Playwright's native epoch clock may lead the daemon's monotonic wall
    // anchor by a few milliseconds. The receipt must still preserve causality.
    const nativeTimingStart = Date.now() + 20;
    const execute = vi.fn(async (): Promise<CollectionBatch> => {
      const page = new FakePage();
      context.emit('page', page as unknown as Page);
      context.emit('response', new FakeResponse(
        page,
        'https://g.alicdn.com/collector/pixel.gif',
        nativeTimingStart - 100,
        1,
      ) as unknown as Response);
      context.emit('response', new FakeResponse(
        page,
        canonicalSearchUrl(),
        nativeTimingStart,
        10,
      ) as unknown as Response);
      await page.close();
      return batch();
    });
    const runtime = new ProductionCollectionRuntime({
      ...runtimeOwner(),
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
    expect(first.data.resource).toMatchObject({
      schemaVersion: 'production-collection-resource.v1',
      measurementScope: 'daemon-process-delta-and-owned-page-network',
      networkRequestCount: 0,
      networkResponseCount: 2,
    });
    expect(first.data.resource.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(first.data.resource.artifactBytes).toBeGreaterThan(0);
    expect(first.data.resource.rssSampleCount).toBeGreaterThan(0);
    expect(first.data.timing).toMatchObject({
      schemaVersion: 'production-collection-source-timing.v2',
      clock: 'playwright-request-and-daemon-monotonic-wall.v1',
      coverage: 'full',
      canonicalRequest: 'observed',
    });
    expect(first.data.timing.remoteActionStartedAt)
      .toBe(new Date(nativeTimingStart).toISOString());
    expect(first.data.timing.firstSourceByteAt)
      .toBe(new Date(nativeTimingStart + 10).toISOString());
    expect(Date.parse(first.data.timing.remoteActionStartedAt))
      .toBeLessThanOrEqual(Date.parse(first.data.timing.firstSourceByteAt!));
    expect(Date.parse(first.data.timing.firstSourceByteAt!))
      .toBeLessThanOrEqual(Date.parse(first.data.timing.sourcePayloadCompleteAt));
    expect(Date.parse(first.data.timing.sourcePayloadCompleteAt))
      .toBeLessThanOrEqual(Date.parse(first.data.timing.rawArchiveCommittedAt));

    const replay = await runtime.handle(executeRequest);
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.data === null) throw new Error('missing replay receipt');
    expect(replay.data.resource).toEqual(first.data.resource);
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

  it('returns a failed batch when the source rejects before canonical timing is observable', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
    directories.push(artifactDirectory);
    const failedBatch: CollectionBatch = {
      ...batch(),
      status: 'failed',
      errors: [{
        code: 'OFFER_DETAIL_REJECTED',
        message: 'The source rejected the offer detail request.',
        retryable: true,
      }],
      completeness: {
        requestedScope: 'page',
        state: 'unknown',
        observedPages: [],
        failedPages: [1],
        uniqueItems: 0,
      },
    };
    const runtime = new ProductionCollectionRuntime({
      ...runtimeOwner(),
      artifactDirectory,
      runCollection: async () => failedBatch,
      runWithContext: (operation) => operation(new FakeContext() as unknown as BrowserContext),
    });

    const response = await runtime.handle(parseProductionCollectionRpcRequestV1(request()));

    expect(response.ok).toBe(true);
    if (!response.ok || response.data === null) throw new Error('missing failed batch receipt');
    expect(response.data.timing).toMatchObject({
      schemaVersion: 'production-collection-source-timing.v2',
      coverage: 'missing',
      canonicalRequest: 'unobserved',
      remoteActionStartedAt: null,
      firstSourceByteAt: null,
    });
    expect(response.data.batch).toMatchObject({
      status: 'failed',
      errors: [{ code: 'OFFER_DETAIL_REJECTED', retryable: true }],
    });
  });

  it.each([
    ['failed', false], ['failed', true],
    ['partial', false], ['partial', true],
    ['blocked', false], ['blocked', true],
  ] as const)(
    'records %s timing without inventing canonical evidence (observed=%s)',
    async (status, observed) => {
      const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-runtime-'));
      directories.push(artifactDirectory);
      const context = new FakeContext();
      const execute = vi.fn(async (): Promise<CollectionBatch> => {
        if (observed) {
          const page = new FakePage();
          context.emit('page', page as unknown as Page);
          context.emit('request', new FakeRequest(
            page,canonicalSearchUrl(),Date.now()-10,0,
          ) as unknown as Request);
          await page.close();
        }
        return { ...batch(), status };
      });
      const runtime = new ProductionCollectionRuntime({
        ...runtimeOwner(),artifactDirectory,runCollection: execute,
        runWithContext: (operation) => operation(context as unknown as BrowserContext),
      });
      const executeRequest = parseProductionCollectionRpcRequestV1(request());

      const response = await runtime.handle(executeRequest);

      expect(response.ok).toBe(true);
      if (!response.ok || response.data === null) throw new Error('missing terminal receipt');
      expect(response.data.timing).toMatchObject(observed ? {
        schemaVersion: 'production-collection-source-timing.v2',
        coverage: 'partial',canonicalRequest: 'observed',firstSourceByteAt: null,
      } : {
        schemaVersion: 'production-collection-source-timing.v2',
        coverage: 'missing',canonicalRequest: 'unobserved',
        remoteActionStartedAt: null,firstSourceByteAt: null,
      });
      expect(response.data.batch).toMatchObject({ status });
      await expect(runtime.handle(executeRequest)).resolves.toMatchObject({
        ok: true,data: { timing: response.data.timing },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXECUTION_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORK_ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUPERVISOR_LEASE_ID = '11111111-1111-4111-8111-111111111111';
const DAEMON_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function runtimeOwner() {
  return {
    profileId: PROFILE_ID,
    profileName: 'fixture-profile',
    supervisorLeaseId: SUPERVISOR_LEASE_ID,
    supervisorGeneration: 2,
    supervisorFencingToken: '3',
    daemonInstanceId: DAEMON_INSTANCE_ID,
    contextGeneration: 4,
    runtimeHostId: 'fixture-host',
    authorizeRuntime: async (_request: ProductionCollectionRpcRequestV1, requestHash: string) => ({
      runtimeAdmissionReceiptId: '33333333-3333-4333-8333-333333333333',
      requestHash,
      admittedAt: new Date().toISOString(),
    }),
  } as const;
}

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
    supervisorLeaseId: SUPERVISOR_LEASE_ID,
    supervisorGeneration: 2,
    supervisorFencingToken: '3',
    daemonInstanceId: DAEMON_INSTANCE_ID,
    contextGeneration: 4,
    runtimeHostId: 'fixture-host',
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
          maxCandidates: 5,
          candidatesPerPage: 5,
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

class FakeRequest {
  public constructor(
    private readonly owner: FakePage,
    private readonly requestUrl: string,
    private readonly startTime: number,
    private readonly responseStart: number,
  ) {}
  public frame(): { page: () => Page } {
    return { page: () => this.owner as unknown as Page };
  }
  public url(): string { return this.requestUrl; }
  public postData(): string | null { return null; }
  public timing(): { startTime: number; responseStart: number } {
    return { startTime: this.startTime, responseStart: this.responseStart };
  }
}

class FakeResponse {
  private readonly ownerRequest: FakeRequest;
  public constructor(page: FakePage, url: string, startTime: number, responseStart: number) {
    this.ownerRequest = new FakeRequest(page, url, startTime, responseStart);
  }
  public request(): Request { return this.ownerRequest as unknown as Request; }
  public headers(): Record<string, string> { return { 'content-length': '42' }; }
}

class FakeContext extends EventEmitter {}

function canonicalSearchUrl(): string {
  const data = encodeURIComponent(JSON.stringify({
    appId: '32517',
    params: JSON.stringify({ method: 'getOfferList', beginPage: '1' }),
  }));
  return `https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/1.0/?data=${data}`;
}
