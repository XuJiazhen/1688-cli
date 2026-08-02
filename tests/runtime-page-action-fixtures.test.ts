import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeOfflinePageActionExecutor,
  createRuntimeOfflineScenarioDescriptor,
  createRuntimeOfflineScenarioRequestForTest,
  DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
  generateRuntimeDerivedPageActionFixtures,
  type RuntimeOfflineSearchParameterSetArtifact,
  verifyRuntimeDerivedPageActionFixtureSet,
} from '../scripts/generate_runtime_page_action_fixtures.js';
import type { PageActionRequestV1 } from '../src/collection/page-action-contracts.js';
import type { PageActionExecutionScope } from '../src/daemon/supervisor-runtime.js';
import { SUPERVISOR_PROTOCOL_SHA256_V2 } from '../src/daemon/supervisor-rpc.js';
import { compileSearchParameterSetV1 } from '../src/session/search-compiler.js';

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('runtime-derived PageAction fixtures', () => {
  it('publishes canonical Search authority and boots as a managed-daemon-compatible binary', async () => {
    const descriptor = createRuntimeOfflineScenarioDescriptor();
    expect(descriptor).toMatchObject({
      scenario: 'chain-coherent-available-v1',
      canonicalSearchRequest: {
        schema: 'canonical-search-request-v1',
        keyword: 'runtime fixture drill',
        page: 1,
        requestedStartPage: 1,
        requestedEndPage: 1,
        sort: 'relevance',
        advertisementPolicy: 'exclude-p4p',
      },
      searchTransportAuthority: {
        keyword: 'runtime fixture drill',
        pageSize: 60,
        sort: 'relevance',
        advertisementPolicy: 'exclude-p4p',
      },
      chainSubject: {
        offerId: '700000000101',
        memberId: 'fixture-chain-member-1',
      },
    });
    for (const hash of [
      descriptor.canonicalSearchRequest.searchQueryKeyHash,
      descriptor.canonicalSearchRequest.querySnapshotHash,
      descriptor.searchTransportAuthority.filterConfigSnapshotHash,
      descriptor.searchTransportAuthority.serializerCapabilitySnapshotHash,
      descriptor.searchTransportAuthority.canonicalParameterSetHash,
    ]) expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const root = await tempRoot('offline-managed-daemon-binary-');
    const home = `/tmp/1688-offline-${process.pid}-${Date.now()}`;
    temporaryRoots.push(home);
    const artifacts = path.join(root, 'artifacts');
    await fs.mkdir(artifacts, { recursive: true });
    const profileName = 'offline-fixture-profile';
    const configPath = path.join(root, 'managed-config.json');
    const sampled = new Date();
    await fs.writeFile(configPath, JSON.stringify({
      schema: 'profile-supervisor.daemon-config.v2',
      profileId: '70000000-0000-4000-8000-000000000001',
      profileName,
      daemonInstanceId: '70000000-0000-4000-8000-000000000002',
      supervisorGeneration: 1,
      contextGeneration: 1,
      transportAuthority: {
        mode: 'scripted_offline',
        executionAuthorityDocumentId: '70000000-0000-4000-8000-000000000003',
        executionAuthorityDocumentSha256: 'a'.repeat(64),
        executionSubjectDocumentId: '70000000-0000-4000-8000-000000000004',
        executionSubjectDocumentSha256: 'b'.repeat(64),
        cohortId: '70000000-0000-4000-8000-000000000005',
        runId: '70000000-0000-4000-8000-000000000006',
        protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
      },
      databaseNow: sampled.toISOString(),
      databaseTimeSampledAt: sampled.toISOString(),
      credentialKeys: { key1: 'offline-fixture-key-with-at-least-32-bytes' },
      pageActionVerification: {
        keysById: { key1: 'offline-fixture-key-with-at-least-32-bytes' },
        routesById: {},
        expansionPoliciesByDispatchRevisionId: {},
      },
      artifactDirectory: artifacts,
    }), { mode: 0o600 });
    const binary = path.resolve('scripts/offline_managed_daemon_harness.ts');
    const scenario = 'chain-coherent-available-v1';
    const environment = {
      ...process.env,
      BB1688_HOME: home,
      BB1688_TEST_ONLY_OFFLINE_MANAGED_DAEMON: '1',
      BB1688_OFFLINE_PAGE_ACTION_SCENARIO: scenario,
      BB1688_SUPERVISOR_PROTOCOL_SHA256: SUPERVISOR_PROTOCOL_SHA256_V2,
      BB1688_OFFLINE_PAGE_ACTION_SCENARIO_SHA256: createHash('sha256')
        .update(JSON.stringify({ scenario, descriptor }))
        .digest('hex'),
      BB1688_OFFLINE_MANAGED_DAEMON_HARNESS_SHA256: createHash('sha256')
        .update(await fs.readFile(binary))
        .digest('hex'),
    };
    const previousHome = process.env['BB1688_HOME'];
    process.env['BB1688_HOME'] = home;
    let daemonPid: number | undefined;
    try {
      const described = await execFileAsync(binary, ['scenario', 'describe'], {
        env: environment,
        timeout: 20_000,
      });
      expect(JSON.parse(described.stdout)).toEqual(descriptor);

      const { stdout } = await execFileAsync(binary, [
        'daemon', 'managed-start', '--supervisor-config', configPath,
      ], { env: environment, timeout: 20_000 });
      const started = JSON.parse(stdout) as Record<string, unknown>;
      expect(started).toMatchObject({
        ok: true,
        profile: profileName,
        managed: true,
        offlineScenario: 'chain-coherent-available-v1',
      });
      daemonPid = Number(started['pid']);
      expect(Number.isSafeInteger(daemonPid) && daemonPid > 0).toBe(true);
      expect(() => process.kill(daemonPid!, 0)).not.toThrow();
      await expect(fs.stat(path.join(
        home,
        'profiles',
        profileName,
        'daemon.owner.json',
      ))).resolves.toBeDefined();
    } finally {
      if (daemonPid !== undefined) {
        try { process.kill(daemonPid, 'SIGTERM'); } catch { /* already stopped */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (previousHome === undefined) delete process.env['BB1688_HOME'];
      else process.env['BB1688_HOME'] = previousHome;
    }
  }, 20_000);
  it('executes the chain-coherent available and technical-failure scenarios via the real executor', async () => {
    for (const actionKind of [
      'search-list', 'offer-detail', 'store-qualification', 'store-sample',
    ] as const) {
      const artifactDirectory = await tempRoot(`offline-harness-${actionKind}-`);
      const request = createRuntimeOfflineScenarioRequestForTest(actionKind);
      const response = await createRuntimeOfflinePageActionExecutor({
        artifactDirectory,
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        scenario: 'chain-coherent-available-v1',
      }).execute(request, harnessScope(actionKind));
      expect(response).toMatchObject({
        executionAttemptReceipt: {
          requestId: request.requestId,
          pageActionId: request.pageActionId,
          pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
          outcome: 'completed',
          actionKind,
        },
        completionReceipt: { status: 'completed', actionKind },
      });
    }

    const failureRoot = await tempRoot('offline-harness-technical-failure-');
    const failureRequest = createRuntimeOfflineScenarioRequestForTest('offer-detail');
    const failure = await createRuntimeOfflinePageActionExecutor({
      artifactDirectory: failureRoot,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
      scenario: 'chain-coherent-technical-failure-v1',
    }).execute(failureRequest, harnessScope('offer-detail'));
    expect(failure.executionAttemptReceipt).toMatchObject({
      actionKind: 'offer-detail',
      outcome: 'failed',
      error: { code: 'NETWORK_ERROR' },
    });
    expect(failure.completionReceipt).toBeUndefined();
  });

  it('resolves non-static Search authority without replacing its producer artifact', async () => {
    const root = await tempRoot('offline-harness-resolved-search-');
    const fixture = resolvedSearchFixture();
    const beforeRequest = JSON.stringify(fixture.request);
    const beforeArtifact = Buffer.from(fixture.artifact.bytes);
    const resolvedRefs: string[] = [];
    const response = await createRuntimeOfflinePageActionExecutor({
      artifactDirectory: root,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
      scenario: 'chain-coherent-available-v1',
      resolveSearchParameterSetArtifact: async (artifactRef) => {
        resolvedRefs.push(artifactRef);
        return fixture.artifact;
      },
    }).execute(fixture.request, harnessScope('search-list'));
    expect(response).toMatchObject({
      executionAttemptReceipt: { actionKind: 'search-list', outcome: 'completed' },
      completionReceipt: { actionKind: 'search-list', status: 'completed' },
    });
    expect(resolvedRefs).toEqual([fixture.artifact.artifactRef]);
    expect(JSON.stringify(fixture.request)).toBe(beforeRequest);
    expect(Buffer.from(fixture.artifact.bytes)).toEqual(beforeArtifact);
    await expect(fs.readdir(root)).resolves.not.toContain(
      `${fixture.artifact.contentSha256}.json`,
    );
  });

  it('fails closed when non-static Search authority cannot be resolved exactly', async () => {
    const absent = resolvedSearchFixture();
    await expect(executeResolvedSearch('offline-harness-resolver-absent-', absent.request))
      .rejects.toThrow(/explicit test-only resolver/u);

    const missing = resolvedSearchFixture();
    await expect(executeResolvedSearch(
      'offline-harness-resolver-missing-',
      missing.request,
      async () => { throw new Error('parameter-set artifact is missing'); },
    )).rejects.toThrow(/artifact is missing/u);

    const invalidCases: Array<{
      name: string;
      mutate(
        request: PageActionRequestV1,
        artifact: RuntimeOfflineSearchParameterSetArtifact,
      ): RuntimeOfflineSearchParameterSetArtifact;
      error: RegExp;
    }> = [
      {
        name: 'stale-ref',
        mutate: (_request, artifact) => ({
          ...artifact,
          artifactRef: `sha256:${'0'.repeat(64)}`,
        }),
        error: /stale|mismatched/u,
      },
      {
        name: 'content-hash',
        mutate: (_request, artifact) => ({
          ...artifact,
          contentSha256: '0'.repeat(64),
        }),
        error: /corrupted|mismatched/u,
      },
      {
        name: 'corrupt-bytes',
        mutate: (_request, artifact) => ({
          ...artifact,
          bytes: Buffer.concat([Buffer.from(artifact.bytes), Buffer.from(' ')]),
        }),
        error: /corrupted|mismatched/u,
      },
      {
        name: 'parameter-hash',
        mutate: (request, artifact) => {
          const parameterSet = JSON.parse(Buffer.from(artifact.bytes).toString('utf8')) as
            Record<string, unknown>;
          parameterSet['parameterSetHash'] = `sha256:${'0'.repeat(64)}`;
          const bytes = Buffer.from(JSON.stringify(parameterSet));
          const contentSha256 = digest(bytes);
          if (request.action.kind !== 'search-list') throw new Error('Search request drifted.');
          request.action.request.canonicalParameterSetArtifactRef = `sha256:${contentSha256}`;
          return { artifactRef: `sha256:${contentSha256}`, contentSha256, bytes };
        },
        error: /SEARCH_PARAMETER_SET_HASH_MISMATCH|hash verification/u,
      },
    ];
    for (const testCase of invalidCases) {
      const fixture = resolvedSearchFixture();
      const artifact = testCase.mutate(fixture.request, fixture.artifact);
      await expect(executeResolvedSearch(
        `offline-harness-resolver-${testCase.name}-`,
        fixture.request,
        async () => artifact,
      )).rejects.toThrow(testCase.error);
    }
  });

  it('rejects every resolved Search request-to-artifact authority mismatch', async () => {
    const invalidCases: Array<{
      name: string;
      mutate(authority: Record<string, unknown>): void;
    }> = [
      { name: 'parameter-set-hash', mutate: (value) => { value['canonicalParameterSetHash'] = `sha256:${'0'.repeat(64)}`; } },
      { name: 'filter-id', mutate: (value) => { value['filterConfigSnapshotId'] = 'stale-filter'; } },
      { name: 'filter-hash', mutate: (value) => { value['filterConfigSnapshotHash'] = `sha256:${'0'.repeat(64)}`; } },
      { name: 'serializer-id', mutate: (value) => { value['serializerCapabilitySnapshotId'] = 'stale-serializer'; } },
      { name: 'serializer-hash', mutate: (value) => { value['serializerCapabilitySnapshotHash'] = `sha256:${'0'.repeat(64)}`; } },
      { name: 'keyword', mutate: (value) => { value['keyword'] = 'other keyword'; } },
      { name: 'compiler', mutate: (value) => { value['compilerRevision'] = 'other-compiler'; } },
      { name: 'sort', mutate: (value) => { value['sort'] = 'sales'; } },
      { name: 'start-page', mutate: (value) => { value['requestedStartPage'] = 2; } },
      { name: 'end-page', mutate: (value) => { value['requestedEndPage'] = 2; } },
      { name: 'max-offers', mutate: (value) => { value['maxOffers'] = 59; } },
      { name: 'ad-policy', mutate: (value) => { value['advertisementPolicy'] = 'archive-and-mark'; } },
    ];
    for (const testCase of invalidCases) {
      const fixture = resolvedSearchFixture();
      if (fixture.request.action.kind !== 'search-list') throw new Error('Search request drifted.');
      testCase.mutate(fixture.request.action.request as unknown as Record<string, unknown>);
      await expect(executeResolvedSearch(
        `offline-harness-authority-${testCase.name}-`,
        fixture.request,
        async () => fixture.artifact,
      )).rejects.toThrow(/parameter-set authority mismatch/u);
    }
  });

  it('keeps offline harness output deterministic and rejects subject, URL, and credential injection', async () => {
    const execute = async (prefix: string) => {
      const root = await tempRoot(prefix);
      const request = createRuntimeOfflineScenarioRequestForTest('offer-detail');
      return createRuntimeOfflinePageActionExecutor({
        artifactDirectory: root,
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        scenario: 'chain-coherent-available-v1',
      }).execute(request, harnessScope('offer-detail'));
    };
    expect(await execute('offline-harness-deterministic-a-'))
      .toEqual(await execute('offline-harness-deterministic-b-'));

    const invalidCases = [
      (request: ReturnType<typeof createRuntimeOfflineScenarioRequestForTest>) => {
        if (request.action.kind === 'offer-detail') request.action.memberId = 'other-member';
      },
      (request: ReturnType<typeof createRuntimeOfflineScenarioRequestForTest>) => {
        request.action.executionHandle = { url: 'https://external.invalid/collect' } as never;
      },
      (request: ReturnType<typeof createRuntimeOfflineScenarioRequestForTest>) => {
        request.action.executionHandle = { authorization: 'Bearer forbidden' } as never;
      },
    ];
    for (const [index, mutate] of invalidCases.entries()) {
      const root = await tempRoot(`offline-harness-reject-${index}-`);
      const request = createRuntimeOfflineScenarioRequestForTest('offer-detail');
      mutate(request);
      await expect(createRuntimeOfflinePageActionExecutor({
        artifactDirectory: root,
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        scenario: 'chain-coherent-available-v1',
      }).execute(request, harnessScope('offer-detail'))).rejects.toThrow(
        /inconsistent|external URL|credential-bearing/u,
      );
    }
  });
  it('verifies the committed four-action executor output and exact Offer shape', async () => {
    await expect(verifyRuntimeDerivedPageActionFixtureSet()).resolves.toMatchObject({
      actions: 4,
    });
    const response = await readJson(
      path.join(
        DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
        'responses/offer-detail.wire-response.json',
      ),
    ) as {
      completionReceipt: {
        batches: Array<{ kind: string; observations: Array<Record<string, unknown>> }>;
      };
    };
    const batch = response.completionReceipt.batches.find(
      (candidate) => candidate.kind === 'offer-detail',
    );
    const observation = batch?.observations[0];
    expect(observation).toMatchObject({
      offerId: '700000000101',
      collectedAt: '2026-08-02T00:00:00.001Z',
      offer: {
        offerId: '700000000101',
        supplier: { memberId: 'fixture-chain-member-1' },
      },
    });
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'collectedAt',
      'collectorPageActionEvidence',
      'offer',
      'offerId',
    ]);

    const store = await readJson(path.join(
      DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
      'responses/store-sample.wire-response.json',
    )) as {
      executionAttemptReceipt: {
        remoteRequestAttempts: Array<{
          ordinal: number;
          logicalPage: number | null;
          purpose: string;
          status: string;
        }>;
      };
    };
    expect(store.executionAttemptReceipt.remoteRequestAttempts.map((attempt) => ({
      ordinal: attempt.ordinal,
      logicalPage: attempt.logicalPage,
      purpose: attempt.purpose,
      status: attempt.status,
    }))).toEqual([
      { ordinal: 1, logicalPage: 1, purpose: 'discovery', status: 'succeeded' },
      { ordinal: 2, logicalPage: 1, purpose: 'forward', status: 'succeeded' },
      { ordinal: 3, logicalPage: 2, purpose: 'forward', status: 'succeeded' },
      { ordinal: 4, logicalPage: 3, purpose: 'forward', status: 'succeeded' },
    ]);
  });

  it('generates byte-for-byte identical bytes on independent executions', async () => {
    const first = await tempRoot('runtime-page-actions-first-');
    const second = await tempRoot('runtime-page-actions-second-');
    await generateRuntimeDerivedPageActionFixtures(first);
    await generateRuntimeDerivedPageActionFixtures(second);
    expect(await directoryDigests(first)).toEqual(await directoryDigests(second));
  });

  it('fails closed for a missing file and a one-byte mutation', async () => {
    const missing = await fixtureCopy('runtime-page-actions-missing-');
    await fs.rm(path.join(missing, 'batches/search-list/00-search-page.json'));
    await expect(verifyRuntimeDerivedPageActionFixtureSet(missing)).rejects.toThrow(
      /inventory|ENOENT/u,
    );

    const changed = await fixtureCopy('runtime-page-actions-byte-');
    await fs.appendFile(
      path.join(changed, 'responses/search-list.wire-response.json'),
      ' ',
    );
    await expect(verifyRuntimeDerivedPageActionFixtureSet(changed)).rejects.toThrow(
      /receipt mismatch/u,
    );

    const unlisted = await fixtureCopy('runtime-page-actions-unlisted-');
    await fs.writeFile(path.join(unlisted, 'unlisted.json'), jsonBytes({ fixture: true }));
    await expect(verifyRuntimeDerivedPageActionFixtureSet(unlisted)).rejects.toThrow(
      /inventory/u,
    );
  });

  it('rejects a raw archive rehash when the manifest archive binding remains stale', async () => {
    const root = await fixtureCopy('runtime-page-actions-archive-rehash-');
    const relativePath = await manifestArchivePath(
      root,
      'store-sample',
      'collector-raw-store-response-',
    );
    const archive = await readJson(path.join(root, relativePath)) as Record<string, unknown>;
    archive['auditMutation'] = 'semantically-valid-byte-drift';
    await rewriteGlobalReceiptOnly(root, relativePath, archive);
    await expect(verifyRuntimeDerivedPageActionFixtureSet(root)).rejects.toThrow(
      /global file receipt|archive/u,
    );
  });

  it('rejects rehashed manifest metadata and rewritten receipt metadata', async () => {
    const manifestRoot = await fixtureCopy('runtime-page-actions-manifest-metadata-');
    const manifestPath = path.join(manifestRoot, 'manifest.json');
    const manifest = await readJson(manifestPath) as {
      security: { containsLiveCredentials: boolean };
    };
    manifest.security.containsLiveCredentials = true;
    await rewriteGlobalReceiptOnly(manifestRoot, 'manifest.json', manifest);
    await expect(verifyRuntimeDerivedPageActionFixtureSet(manifestRoot)).rejects.toThrow(
      /security declaration/u,
    );

    const receiptRoot = await fixtureCopy('runtime-page-actions-receipt-metadata-');
    const receiptPath = path.join(receiptRoot, 'sha256-receipt.json');
    const receipt = await readJson(receiptPath) as Record<string, unknown>;
    receipt['generatorRevision'] = 'rewritten-generator-revision';
    await fs.writeFile(receiptPath, jsonBytes(receipt));
    await expect(verifyRuntimeDerivedPageActionFixtureSet(receiptRoot)).rejects.toThrow(
      /file receipt schema/u,
    );
  });

  it('fails closed for manifest/hash drift, wrong schema, and synthetic substitution', async () => {
    const manifestDrift = await fixtureCopy('runtime-page-actions-manifest-');
    const manifestPath = path.join(manifestDrift, 'manifest.json');
    const manifest = await readJson(manifestPath) as Record<string, unknown>;
    manifest['provenance'] = 'synthetic-manual-fixture';
    await fs.writeFile(manifestPath, jsonBytes(manifest));
    await expect(
      verifyRuntimeDerivedPageActionFixtureSet(manifestDrift),
    ).rejects.toThrow(/provenance|receipt/u);

    const wrongSchema = await fixtureCopy('runtime-page-actions-schema-');
    await rewriteReceiptedJson(
      wrongSchema,
      'responses/store-qualification.wire-response.json',
      { schema: 'synthetic-page-action-response-v0' },
      'store-qualification',
      'responseSha256',
    );
    await expect(verifyRuntimeDerivedPageActionFixtureSet(wrongSchema)).rejects.toThrow(
      /executionAttemptReceipt|unknown field/u,
    );

    const synthetic = await fixtureCopy('runtime-page-actions-synthetic-');
    const legacy = await readJson(path.join(
      path.dirname(DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT),
      'page-actions/offer-detail.json',
    ));
    await rewriteReceiptedJson(
      synthetic,
      'responses/offer-detail.wire-response.json',
      legacy,
      'offer-detail',
      'responseSha256',
    );
    await expect(verifyRuntimeDerivedPageActionFixtureSet(synthetic)).rejects.toThrow(
      /executionAttemptReceipt|unknown field/u,
    );
  });

  it('applies the recursive credential and personal-data gate after valid rehashing', async () => {
    const root = await fixtureCopy('runtime-page-actions-security-');
    const relativePath = 'inputs/search-list.transport.json';
    const input = await readJson(path.join(root, relativePath)) as Record<string, unknown>;
    input['nested'] = { transport: { cookie: 'session=not-allowed' } };
    await rewriteReceiptedJson(
      root,
      relativePath,
      input,
      'search-list',
      'transportInputSha256',
    );
    await expect(verifyRuntimeDerivedPageActionFixtureSet(root)).rejects.toThrow(
      /credential-bearing key/u,
    );

    const piiValues = [
      'fixture.person@example.test',
      '13800138000',
      '11010519491231002X',
    ];
    for (const [index, pii] of piiValues.entries()) {
      const piiRoot = await fixtureCopy(`runtime-page-actions-pii-${index}-`);
      const piiInput = await readJson(path.join(piiRoot, relativePath)) as Record<string, unknown>;
      piiInput['nested'] = { personalData: pii };
      await rewriteReceiptedJson(
        piiRoot,
        relativePath,
        piiInput,
        'search-list',
        'transportInputSha256',
      );
      await expect(verifyRuntimeDerivedPageActionFixtureSet(piiRoot)).rejects.toThrow(
        /personal-data pattern/u,
      );
    }
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function resolvedSearchFixture(): {
  request: PageActionRequestV1;
  artifact: RuntimeOfflineSearchParameterSetArtifact;
} {
  const parameterSet = compileSearchParameterSetV1({
    keyword: 'runtime fixture drill',
    sort: 'relevance',
    compatibilitySortInput: null,
    filterConfigSnapshotId: 'dynamic-filter-snapshot-1',
    filterConfigSnapshotHash: `sha256:${digest(Buffer.from('dynamic-filter-snapshot-1'))}`,
    serializerCapabilitySnapshotId: 'dynamic-serializer-snapshot-1',
    serializerCapabilitySnapshotHash:
      `sha256:${digest(Buffer.from('dynamic-serializer-snapshot-1'))}`,
    filterParams: { freeShipping: 'true' },
    selectedOptions: [],
    maxPages: 1,
    maxOffers: 60,
    advertisementPolicy: 'exclude-p4p',
  });
  const bytes = Buffer.from(JSON.stringify(parameterSet));
  const contentSha256 = digest(bytes);
  const artifactRef = `sha256:${contentSha256}`;
  const request = createRuntimeOfflineScenarioRequestForTest('search-list');
  if (request.action.kind !== 'search-list') throw new Error('Search request drifted.');
  request.action.request = {
    ...request.action.request,
    keyword: parameterSet.keyword,
    filterConfigSnapshotId: parameterSet.filterConfigSnapshotId,
    filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
    compilerRevision: parameterSet.compilerRevision,
    serializerCapabilitySnapshotId: parameterSet.serializerCapabilitySnapshotId,
    serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
    sort: parameterSet.sort,
    canonicalParameterSetArtifactRef: artifactRef,
    canonicalParameterSetHash: parameterSet.parameterSetHash,
    requestedStartPage: 1,
    requestedEndPage: parameterSet.maxPages,
    maxOffers: parameterSet.maxOffers,
    advertisementPolicy: parameterSet.advertisementPolicy,
  };
  return {
    request,
    artifact: { artifactRef, contentSha256, bytes },
  };
}

async function executeResolvedSearch(
  prefix: string,
  request: PageActionRequestV1,
  resolveSearchParameterSetArtifact?: (
    artifactRef: string,
  ) => Promise<RuntimeOfflineSearchParameterSetArtifact>,
) {
  const root = await tempRoot(prefix);
  return createRuntimeOfflinePageActionExecutor({
    artifactDirectory: root,
    now: () => new Date('2026-08-02T00:00:00.000Z'),
    scenario: 'chain-coherent-available-v1',
    ...(resolveSearchParameterSetArtifact === undefined
      ? {}
      : { resolveSearchParameterSetArtifact }),
  }).execute(request, harnessScope('search-list'));
}

async function fixtureCopy(prefix: string): Promise<string> {
  const root = await tempRoot(prefix);
  await fs.cp(DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT, root, { recursive: true });
  return root;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

async function manifestArchivePath(
  root: string,
  actionKind: string,
  basenamePrefix: string,
): Promise<string> {
  const manifest = await readJson(path.join(root, 'manifest.json')) as {
    actions: Array<{ actionKind: string; archiveFiles: Array<{ path: string }> }>;
  };
  const result = manifest.actions.find((action) => action.actionKind === actionKind)
    ?.archiveFiles.find((file) => path.basename(file.path).startsWith(basenamePrefix))?.path;
  if (!result) throw new Error(`Missing ${actionKind} archive ${basenamePrefix}.`);
  return result;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function harnessScope(actionKind: string): PageActionExecutionScope {
  return {
    page: {} as never,
    pageSessionId: `${actionKind}-offline-page-session`,
    signal: new AbortController().signal,
    assertAuthorized: async () => {},
    admitRemoteAttempt: async (input) => ({
      remoteActionStartId: `${actionKind}-offline-remote-${input.ordinal}`,
      admittedAt: new Date(Date.parse('2026-08-02T00:00:00.000Z') + input.ordinal)
        .toISOString(),
    }),
    classifyUrl: async () => {},
    closeOwnedPage: async () => {},
  };
}

async function rewriteReceiptedJson(
  root: string,
  relativePath: string,
  value: unknown,
  actionKind: string,
  actionHashField: string,
): Promise<void> {
  const targetBytes = jsonBytes(value);
  await fs.writeFile(path.join(root, relativePath), targetBytes);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = await readJson(manifestPath) as {
    actions: Array<Record<string, unknown>>;
  };
  const action = manifest.actions.find((entry) => entry['actionKind'] === actionKind);
  if (!action) throw new Error(`Missing action ${actionKind}`);
  action[actionHashField] = digest(targetBytes);
  const manifestBytes = jsonBytes(manifest);
  await fs.writeFile(manifestPath, manifestBytes);

  const receiptPath = path.join(root, 'sha256-receipt.json');
  const receipts = await readJson(receiptPath) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  updateReceipt(receipts.files, relativePath, targetBytes);
  updateReceipt(receipts.files, 'manifest.json', manifestBytes);
  await fs.writeFile(receiptPath, jsonBytes(receipts));
}

async function rewriteGlobalReceiptOnly(
  root: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const targetBytes = jsonBytes(value);
  await fs.writeFile(path.join(root, relativePath), targetBytes);
  const receiptPath = path.join(root, 'sha256-receipt.json');
  const receipts = await readJson(receiptPath) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  updateReceipt(receipts.files, relativePath, targetBytes);
  await fs.writeFile(receiptPath, jsonBytes(receipts));
}

function updateReceipt(
  receipts: Array<{ path: string; bytes: number; sha256: string }>,
  relativePath: string,
  bytes: Buffer,
): void {
  const receipt = receipts.find((entry) => entry.path === relativePath);
  if (!receipt) throw new Error(`Missing receipt for ${relativePath}`);
  receipt.bytes = bytes.byteLength;
  receipt.sha256 = digest(bytes);
}

async function directoryDigests(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        output[path.relative(root, absolute)] = digest(await fs.readFile(absolute));
      }
    }
  };
  await visit(root);
  return output;
}
