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
  verifyRuntimeDerivedPageActionFixtureSet,
} from '../scripts/generate_runtime_page_action_fixtures.js';
import type { PageActionExecutionScope } from '../src/daemon/supervisor-runtime.js';

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
      schema: 'profile-supervisor.daemon-config.v1',
      profileId: 'offline-fixture-profile-id',
      profileName,
      daemonInstanceId: 'offline-fixture-daemon-id',
      supervisorGeneration: 1,
      contextGeneration: 1,
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
    const environment = {
      ...process.env,
      BB1688_HOME: home,
      BB1688_TEST_ONLY_OFFLINE_MANAGED_DAEMON: '1',
      BB1688_OFFLINE_PAGE_ACTION_SCENARIO: 'chain-coherent-available-v1',
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
