import fs from 'node:fs/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  PAGE_ACTION_REQUEST_SCHEMA,
  canonicalCollectorSha256V1,
  computeCollectorExecutionHandleSignatureV1,
  computeExecutionLineageHashV1,
  computeExecutionAttemptReceiptHashV1,
  computeLogicalLineageHashV1,
  computePageActionPayloadBusinessHashV1,
  normalizePageActionExecuteResponseV1,
  pageActionBusinessFieldPathsV1,
  type PageActionKind,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import { loadManagedServerOptions } from '../src/daemon/managed-bootstrap.js';
import { daemonCall, supervisorDaemonCall } from '../src/daemon/client.js';
import { start, stopServerForTesting } from '../src/daemon/server.js';
import { socketPath } from '../src/session/paths.js';
import type { ManagedPage } from '../src/daemon/page-registry.js';
import {
  InMemoryPageActionAcceptanceRepository,
  fenceDigest,
  signRenewalCredentialTransport,
  signSupervisorControlCredential,
  type PageActionExecutor,
  type PersistentContextHost,
} from '../src/daemon/supervisor-runtime.js';
import {
  canonicalRpcPayloadHash,
  SUPERVISOR_PROTOCOL_SHA256_V2,
  type ParsedSupervisorRpcRequestV2,
  type SupervisorRpcBindingV2,
} from '../src/daemon/supervisor-rpc.js';

const key = 'managed-bootstrap-key-with-at-least-32-bytes';
const PROFILE_ID = '40000000-0000-4000-8000-000000000001';
const DAEMON_ID = '40000000-0000-4000-8000-000000000002';
const transportAuthority = {
  mode: 'live_remote' as const,
  liveAuthorizationId: '40000000-0000-4000-8000-000000000003',
  liveAuthorizationSha256: 'a'.repeat(64),
  cohortId: '40000000-0000-4000-8000-000000000005',
  collectionTaskId: '40000000-0000-4000-8000-000000000006',
  protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
};

class FakePage implements ManagedPage {
  closed = false;
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
  url() { return 'about:blank'; }
}

class FakeHost implements PersistentContextHost {
  pagesOwned: FakePage[] = [];
  ids = new WeakMap<object, string>();
  async ensureStarted(input: Parameters<PersistentContextHost['ensureStarted']>[0]) {
    return { ...input, chromiumPid: 4242 };
  }
  async createPage() {
    const page = new FakePage();
    this.pagesOwned.push(page);
    this.ids.set(page, `page-${this.pagesOwned.length}`);
    return page;
  }
  pages() { return this.pagesOwned; }
  pageId(page: ManagedPage) { return this.ids.get(page as object)!; }
  async restart(input: { nextContextGeneration: number }) {
    return {
      profileId: PROFILE_ID, profileName: 'profile-1', daemonInstanceId: DAEMON_ID,
      contextGeneration: input.nextContextGeneration, chromiumPid: 4243, headful: true,
    };
  }
  async stop() {}
  async probeIdentity(input: { expectedMemberId: string; probeRevision: string }) {
    return {
      probeReceiptId: 'probe-1', probeRevision: input.probeRevision,
      probedAt: new Date().toISOString(), expectedMemberId: input.expectedMemberId,
      observedMemberId: input.expectedMemberId, pageState: 'normal' as const,
      passed: true, safeEvidenceHash: 'f'.repeat(64),
    };
  }
}

describe('managed daemon bootstrap', () => {
  it('constructs an enabled Supervisor runtime and routes all four PageActions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-daemon-'));
    const configPath = path.join(directory, 'config.json');
    const sampled = new Date();
    await fs.writeFile(configPath, JSON.stringify({
      schema: 'profile-supervisor.daemon-config.v2',
      profileId: PROFILE_ID,
      profileName: 'profile-1',
      daemonInstanceId: DAEMON_ID,
      supervisorLeaseId: '20000000-0000-4000-8000-000000000007',
      supervisorGeneration: 1,
      supervisorFencingToken: '1',
      contextGeneration: 1,
      runtimeHostId: 'host-1',
      artifactReadDirectories: [],
      transportAuthority,
      databaseNow: sampled.toISOString(),
      databaseTimeSampledAt: sampled.toISOString(),
      credentialKeys: { key1: key },
      pageActionVerification: {
        keysById: { capability1: key },
        routesById: {},
        expansionPoliciesByDispatchRevisionId: {},
      },
      artifactDirectory: directory,
    }), { mode: 0o600 });
    const reached: string[] = [];
    const executor: PageActionExecutor = {
      async execute(request, scope) {
        reached.push(request.actionKind);
        await scope.closeOwnedPage('fake_terminal');
        return strictTerminalResponse(request);
      },
    };
    const host = new FakeHost();
    const options = await loadManagedServerOptions(configPath, 'profile-1', {
      hostFactory: () => host,
      executorFactory: () => executor,
      acceptanceRepositoryFactory: () => new InMemoryPageActionAcceptanceRepository(),
    });
    expect(options.supervisorRuntime).toBeDefined();
    expect(options.pageActionVerification).toBeDefined();
    expect(options).toMatchObject({ profile: 'profile-1', headful: true, prewarm: false });
    await options.supervisorRuntime!.ensureWarm();
    for (const [index, kind] of [
      'search-list', 'offer-detail', 'store-qualification', 'store-sample',
    ].entries()) {
      const request = signedRequest(
        kind as PageActionRequestV1['actionKind'],
        index + 1,
        sampled,
      );
      await expect(options.supervisorRuntime!.handle(
        request,
        boundAdmissionHooks(request),
      )).resolves.toMatchObject({ ok: true });
    }
    expect(reached).toEqual([
      'search-list', 'offer-detail', 'store-qualification', 'store-sample',
    ]);
    expect(host.pagesOwned.every((page) => page.closed)).toBe(true);
    const pagesBeforeMismatch = host.pagesOwned.length;
    const mismatched = signedRequest('offer-detail', 99, sampled);
    mismatched.binding.transportAuthority = {
      ...mismatched.binding.transportAuthority,
      collectionTaskId: '40000000-0000-4000-8000-000000000099',
    };
    await expect(options.supervisorRuntime!.handle(mismatched)).resolves.toMatchObject({
      ok: false,
      error: { code: 'TRANSPORT_AUTHORITY_MISMATCH', retryable: false },
    });
    expect(host.pagesOwned).toHaveLength(pagesBeforeMismatch);
  });

  it('rejects a credential-bearing config that is group readable', async () => {
    if (process.platform === 'win32') return;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-daemon-mode-'));
    const configPath = path.join(directory, 'config.json');
    await fs.writeFile(configPath, '{}', { mode: 0o644 });
    await expect(loadManagedServerOptions(configPath)).rejects.toThrow(/group\/world/u);
  });

  it('serves the managed runtime through the framed daemon socket', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-daemon-rpc-'));
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = directory;
    const sampled = new Date();
    const configPath = path.join(directory, 'config.json');
    const pageActions = (['search-list', 'offer-detail', 'store-qualification', 'store-sample'] as const)
      .map((kind, index) => pageActionFixture(kind, index + 1, sampled));
    await fs.writeFile(configPath, JSON.stringify({
      schema: 'profile-supervisor.daemon-config.v2',
      profileId: PROFILE_ID, profileName: 'profile-1', daemonInstanceId: DAEMON_ID,
      supervisorLeaseId: '20000000-0000-4000-8000-000000000007',
      supervisorGeneration: 1, supervisorFencingToken: '1', contextGeneration: 1,
      runtimeHostId: 'host-1',
      artifactReadDirectories: [],
      transportAuthority,
      databaseNow: sampled.toISOString(), databaseTimeSampledAt: sampled.toISOString(),
      credentialKeys: { key1: key },
      pageActionVerification: {
        keysById: { key1: key },
        routesById: Object.fromEntries(pageActions.map((request) => [
          request.action.executionHandle.routeTemplateId,
          {
            actionKind: request.actionKind,
            allowedRequestKeys: pageActionBusinessFieldPathsV1(request.action),
          },
        ])),
        expansionPoliciesByDispatchRevisionId: {},
      },
      artifactDirectory: directory,
    }), { mode: 0o600 });
    const reached: string[] = [];
    const admitted: Array<Record<string, unknown>> = [];
    const options = await loadManagedServerOptions(configPath, 'profile-1', {
      hostFactory: () => new FakeHost(),
      executorFactory: () => ({
        execute: async (request, scope) => {
          reached.push(request.actionKind);
          const remoteAttempts = request.actionKind === 'search-list'
            ? [
                { logicalPage: 1, purpose: 'replay' as const },
                { logicalPage: 1, purpose: 'replay' as const },
                { logicalPage: 2, purpose: 'forward' as const },
              ]
            : request.actionKind === 'store-sample'
              ? [
                  { logicalPage: 1, purpose: 'discovery' as const },
                  { logicalPage: 2, purpose: 'forward' as const },
                  { logicalPage: 3, purpose: 'forward' as const },
                ]
              : request.actionKind === 'store-qualification'
                ? [
                    { purpose: 'discovery' as const },
                    { purpose: 'single-target' as const },
                  ]
              : [{ purpose: 'single-target' as const }];
          for (const [index, remote] of remoteAttempts.entries()) {
            const ordinal = index + 1;
            await scope.admitRemoteAttempt({
              remoteRequestAttemptId: `remote-${request.pageActionExecutionAttemptId}-${ordinal}`,
              ordinal,
              ...remote,
              requestBusinessHash: canonicalCollectorSha256V1({
                pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
                ordinal,
                ...remote,
              }),
            });
          }
          await scope.closeOwnedPage('fake_socket_terminal');
          return strictTerminalResponse(request);
        },
      }),
      acceptanceRepositoryFactory: () => new InMemoryPageActionAcceptanceRepository(),
    });
    try {
      await start(options);
      await expect(daemonCall('status', {}, 'legacy-status', 'profile-1'))
        .rejects.toBeDefined();
      await expect(rawSocketFrame('profile-1', {
        ...signedStatusRequest(sampled),
        schema: 'profile-supervisor.rpc.v1',
        payload: { mustNotNormalize: true },
      })).resolves.toMatchObject({
        schema: 'profile-supervisor.rpc-response.v2',
        ok: false,
        error: { code: 'SUPERVISOR_RPC_REQUIRED' },
      });
      const status = await supervisorDaemonCall<Record<string, unknown>>(
        signedStatusRequest(sampled),
        'profile-1',
      );
      expect(status).toMatchObject({
        profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID,
        runtimeState: 'warm', contextGeneration: 1, headful: true,
      });
      for (const pageAction of pageActions) {
        const response = await supervisorDaemonCallWithAdmissions(
          signedStrictPageActionRequest(pageAction, sampled),
          'profile-1',
          admitted,
        );
        expect(response).toMatchObject({
          executionAttemptReceipt: {
            requestId: pageAction.requestId,
            pageActionExecutionAttemptId: pageAction.pageActionExecutionAttemptId,
            outcome: 'completed',
          },
        });
      }
      expect(reached).toEqual([
        'search-list', 'offer-detail', 'store-qualification', 'store-sample',
      ]);
      expect(admitted).toHaveLength(9);
      const searchAdmissions = admitted.filter((entry) =>
        entry['pageActionExecutionAttemptId'] === pageActions[0]!.pageActionExecutionAttemptId);
      expect(searchAdmissions.map((entry) => ({
        ordinal: entry['ordinal'], logicalPage: entry['logicalPage'], purpose: entry['purpose'],
      }))).toEqual([
        { ordinal: 1, logicalPage: 1, purpose: 'replay' },
        { ordinal: 2, logicalPage: 1, purpose: 'replay' },
        { ordinal: 3, logicalPage: 2, purpose: 'forward' },
      ]);
      const storeAdmissions = admitted.filter((entry) =>
        entry['pageActionExecutionAttemptId'] === pageActions[3]!.pageActionExecutionAttemptId);
      expect(storeAdmissions.map((entry) => entry['logicalPage'])).toEqual([1, 2, 3]);
      const restart = await supervisorDaemonCall<Record<string, unknown>>(
        signedRestartRequest(sampled),
        'profile-1',
      );
      expect(restart).toMatchObject({
        previousContextGeneration: 1,
        contextGeneration: 2,
        chromiumPid: 4243,
      });
      const owner = JSON.parse(await fs.readFile(
        path.join(directory, 'profiles', 'profile-1', 'daemon.owner.json'),
        'utf8',
      )) as Record<string, unknown>;
      expect(owner).toMatchObject({
        daemonInstanceId: DAEMON_ID,
        contextGeneration: 2,
        chromiumPid: 4243,
      });
    } finally {
      await stopServerForTesting('profile-1');
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
    }
  });

});

async function rawSocketFrame(
  profile: string,
  frame: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(profile));
    let buffer = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.once('error', reject);
  });
}

async function supervisorDaemonCallWithAdmissions(
  request: ParsedSupervisorRpcRequestV2,
  profile: string,
  admitted: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(profile));
    let buffer = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame['schema'] === 'profile-supervisor.remote-attempt-admission.v2') {
          const admissionRequest = frame['request'] as Record<string, unknown>;
          admitted.push(admissionRequest);
          socket.write(`${JSON.stringify({
            schema: 'profile-supervisor.remote-attempt-admission-response.v2',
            rpcId: frame['rpcId'],
            admissionId: frame['admissionId'],
            ok: true,
            receipt: {
              remoteActionStartId: canonicalUuid(`remote-start-${admitted.length}`),
              admittedAt: new Date().toISOString(),
              transportAuthority: frame['transportAuthority'],
              parentCanonicalRequestHash: frame['parentCanonicalRequestHash'],
            },
          })}\n`);
          continue;
        }
        socket.destroy();
        if (frame['ok'] === true) resolve(frame['data'] as Record<string, unknown>);
        else reject(new Error(JSON.stringify(frame['error'])));
      }
    });
    socket.once('error', reject);
  });
}

function signedRequest(
  actionKind: PageActionRequestV1['actionKind'],
  ordinal: number,
  now: Date,
): ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' } {
  return signedStrictPageActionRequest(pageActionFixture(actionKind, ordinal, now), now);
}

function boundAdmissionHooks(
  request: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
) {
  return {
    remoteAttemptAdmission: {
      transportAuthority: structuredClone(request.binding.transportAuthority),
      parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
      authorize: async () => ({
        remoteActionStartId: '40000000-0000-4000-8000-000000000099',
        admittedAt: new Date().toISOString(),
        transportAuthority: structuredClone(request.binding.transportAuthority),
        parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
      }),
    },
  };
}

function pageActionFixture(
  kind: PageActionKind,
  ordinal: number,
  now: Date,
): PageActionRequestV1 {
  const hash = (value: unknown) => canonicalCollectorSha256V1(value);
  const pageScope = { firstPage: 1, lastPageInclusive: 3 };
  const subject = kind === 'search-list'
    ? { kind, searchQueryKeyHash: hash('search-query'), querySnapshotHash: hash('query-snapshot') }
    : kind === 'offer-detail'
      ? {
          kind, offerId: '123', memberId: 'member-1',
          searchOriginReceiptId: 'search-receipt-1',
          searchOriginReceiptHash: hash('search-receipt'),
        }
      : kind === 'store-qualification'
        ? {
            kind, memberId: 'member-1',
            canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            canonicalShopUrl: 'https://member-1.1688.com/',
            canonicalStoreIdentityReceiptId: 'store-identity-receipt-1',
            canonicalStoreIdentityReceiptHash: hash('store-identity-receipt'),
          }
        : {
            kind, memberId: 'member-1',
            canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            canonicalShopUrl: 'https://member-1.1688.com/',
            canonicalShopIdentityReceiptId: 'shop-identity-receipt-1',
            canonicalShopIdentityReceiptHash: hash('shop-identity-receipt'),
            pageScopeBusinessHash: hash(pageScope),
          };
  const actionWithoutHandle = kind === 'search-list'
    ? {
        kind,
        request: {
          schema: 'canonical-search-request-v1' as const,
          searchQueryKeyHash: subject.searchQueryKeyHash!,
          searchSegmentId: 'segment-1',
          querySnapshotHash: subject.querySnapshotHash!,
          searchQueryIdentity: 'query-1',
          page: 1,
          keyword: 'fixture',
          filterConfigSnapshotId: 'filter-1',
          filterConfigSnapshotHash: hash('filter'),
          compilerRevision: 'search-compiler-v1@1',
          serializerCapabilitySnapshotId: 'serializer-1',
          serializerCapabilitySnapshotHash: hash('serializer'),
          sort: 'relevance' as const,
          canonicalParameterSetArtifactRef: 'artifact:parameter-set',
          canonicalParameterSetHash: hash('parameter-set'),
          requestedStartPage: 1,
          requestedEndPage: 3,
          maxOffers: 90,
          advertisementPolicy: 'exclude-p4p' as const,
          forwardPageBudget: 3,
          replayPageBudget: 0,
          maxSafeReplayPages: 0,
        },
      }
    : kind === 'store-sample'
      ? {
          kind,
          memberId: subject.memberId!,
          canonicalStoreId: subject.canonicalStoreId!,
          canonicalShopUrl: subject.canonicalShopUrl!,
          canonicalShopIdentityReceiptId: subject.canonicalShopIdentityReceiptId!,
          canonicalShopIdentityReceiptHash: subject.canonicalShopIdentityReceiptHash!,
          mode: 'phase-1-bounded' as const,
          pageScope,
        }
      : { ...subject };
  const actionForHash = { ...actionWithoutHandle, executionHandle: {} } as never;
  const pageActionBusinessHash = computePageActionPayloadBusinessHashV1(actionForHash);
  const policyRevisionIds = ['policy-1'];
  const pageActionId = `page-action-${ordinal}`;
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: `logical-${ordinal}`,
    collectionTaskId: 'collection-task-1',
    workUnitId: `work-${ordinal}`,
    pageActionId,
    pageActionBusinessHash,
    actionKind: kind,
    businessSubject: subject,
  } as PageActionRequestV1['logicalLineage'];
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const leaseNotAfter = new Date(now.getTime() + 8 * 60_000).toISOString();
  const requestId = `request-socket-${ordinal}`;
  const idempotencyKey = `idem-socket-${ordinal}`;
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: `work-attempt-${ordinal}`,
    pageActionExecutionAttemptId: `attempt-socket-${ordinal}`,
    executionAttemptOrdinal: 1,
    requestId,
    idempotencyKey,
    profile: {
      profileId: PROFILE_ID, profileName: 'profile-1',
      daemonInstanceId: DAEMON_ID, contextGeneration: 1, egressId: 'egress-1',
    },
    fences: {
      supervisor: fence('supervisor', leaseNotAfter),
      reservation: fence(`reservation-${ordinal}`, leaseNotAfter),
      workUnit: fence(`work-${ordinal}`, leaseNotAfter),
    },
  };
  const routeTemplateId = `route-${kind}`;
  const allowedRequestKeys = pageActionBusinessFieldPathsV1(actionForHash);
  const handleContent = {
    schema: 'collector-execution-handle-v1' as const,
    handleId: `handle-${ordinal}`,
    issuer: 'trusted-page-capability-service' as const,
    actionKind: kind,
    routeTemplateId,
    subjectHash: hash(subject),
    actionPayloadBusinessHash: pageActionBusinessHash,
    allowedRequestKeysHash: hash(allowedRequestKeys),
    policyRevisionIdsHash: hash(policyRevisionIds),
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    signingKeyId: 'key1',
  };
  return {
    schema: PAGE_ACTION_REQUEST_SCHEMA,
    requestId,
    idempotencyKey,
    pageActionId,
    pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
    executionAttemptOrdinal: 1,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: kind,
    startNotBefore: now.toISOString(),
    leaseNotAfter,
    deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    policyRevisionIds,
    action: {
      ...actionWithoutHandle,
      executionHandle: {
        ...handleContent,
        signature: computeCollectorExecutionHandleSignatureV1(handleContent, key),
      },
    } as PageActionRequestV1['action'],
  };
}

function signedStrictPageActionRequest(
  payload: PageActionRequestV1,
  now: Date,
): ParsedSupervisorRpcRequestV2 {
  const request = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: `rpc-${payload.requestId}`,
    method: 'collector.pageAction.execute' as const,
    deadlineAt: payload.deadlineAt,
    binding: {
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisor: payload.executionLineage.fences.supervisor,
      reservation: payload.executionLineage.fences.reservation,
      workUnit: payload.executionLineage.fences.workUnit,
      transportAuthority,
      renewalCredential: null, controlCredential: null,
    } satisfies SupervisorRpcBindingV2,
    payload,
  };
  const fences = payload.executionLineage.fences;
  request.binding.renewalCredential = signRenewalCredentialTransport({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisorLeaseId: fences.supervisor.leaseId, supervisorGeneration: 1,
      supervisorFenceDigest: fenceDigest(fences.supervisor),
      reservationLeaseId: fences.reservation.leaseId,
      reservationGeneration: fences.reservation.generation,
      reservationFenceDigest: fenceDigest(fences.reservation),
      workUnitLeaseId: fences.workUnit.leaseId,
      workUnitGeneration: fences.workUnit.generation,
      workUnitFenceDigest: fenceDigest(fences.workUnit),
      requestId: payload.requestId,
      canonicalRequestHash: canonicalRpcPayloadHash(request as never),
      requestDeadlineAt: request.deadlineAt,
      idempotencyKey: payload.idempotencyKey,
      issuedAt: now.toISOString(),
      credentialNotBefore: now.toISOString(),
      credentialExpiresAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
      leaseNotAfter: payload.leaseNotAfter,
      keyId: 'key1',
    },
    algorithm: 'HMAC-SHA256',
  }, key);
  return request as ParsedSupervisorRpcRequestV2;
}

function fence(prefix: string, leaseNotAfter: string) {
  return {
    leaseId: canonicalUuid(`${prefix}-lease`), generation: 1,
    fencingToken: `${prefix}-fence`, leaseNotAfter,
  };
}

function signedStatusRequest(now: Date): ParsedSupervisorRpcRequestV2 {
  const deadlineAt = new Date(now.getTime() + 60_000).toISOString();
  const supervisor = fence('supervisor', new Date(now.getTime() + 120_000).toISOString());
  const request = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: 'rpc-status-1',
    method: 'supervisor.status' as const,
    deadlineAt,
    binding: {
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisor, reservation: null, workUnit: null,
      transportAuthority,
      renewalCredential: null, controlCredential: null,
    } satisfies SupervisorRpcBindingV2,
    payload: {},
  };
  request.binding.controlCredential = signSupervisorControlCredential({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisorLeaseId: supervisor.leaseId, supervisorGeneration: 1,
      supervisorFenceDigest: fenceDigest(supervisor), rpcId: request.rpcId,
      canonicalRequestHash: canonicalRpcPayloadHash(request as never),
      requestDeadlineAt: deadlineAt, issuedAt: now.toISOString(),
      credentialNotBefore: now.toISOString(),
      credentialExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      keyId: 'key1',
    },
    algorithm: 'HMAC-SHA256',
  }, key);
  return request as ParsedSupervisorRpcRequestV2;
}

function signedRestartRequest(now: Date): ParsedSupervisorRpcRequestV2 {
  const deadlineAt = new Date(now.getTime() + 60_000).toISOString();
  const supervisor = fence('supervisor', new Date(now.getTime() + 120_000).toISOString());
  const request = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: 'rpc-restart-1',
    method: 'supervisor.restart' as const,
    deadlineAt,
    binding: {
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisor, reservation: null, workUnit: null,
      transportAuthority,
      renewalCredential: null, controlCredential: null,
    } satisfies SupervisorRpcBindingV2,
    payload: { reason: 'managed-test', expectedContextGeneration: 1 },
  };
  request.binding.controlCredential = signSupervisorControlCredential({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisorLeaseId: supervisor.leaseId, supervisorGeneration: 1,
      supervisorFenceDigest: fenceDigest(supervisor), rpcId: request.rpcId,
      canonicalRequestHash: canonicalRpcPayloadHash(request as never),
      requestDeadlineAt: deadlineAt, issuedAt: now.toISOString(),
      credentialNotBefore: now.toISOString(),
      credentialExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      keyId: 'key1',
    },
    algorithm: 'HMAC-SHA256',
  }, key);
  return request as ParsedSupervisorRpcRequestV2;
}

function strictTerminalResponse(request: PageActionRequestV1) {
  const content = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `execution-receipt-${request.pageActionExecutionAttemptId}`,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: request.executionLineage,
    executionLineageHash: request.executionLineageHash,
    ...(request.executionAttemptOrdinal === 1 ? {} : {
      predecessorExecutionAttemptReceipt: {
        receiptId: `predecessor-${request.pageActionExecutionAttemptId}`,
        receiptHash: canonicalCollectorSha256V1(
          `predecessor-${request.pageActionExecutionAttemptId}`,
        ),
      },
    }),
    outcome: 'completed' as const,
    terminal: true as const,
    actionKind: request.actionKind,
    remoteRequestAttempts: [],
    batches: [],
    requestSnapshots: [],
    pageLifecycle: {
      baselinePages: 0, createdPages: 1, closedPages: 1,
      transferredPages: 0, remainingOwnedPages: 0 as const,
    },
    metrics: { remoteRequests: 0 },
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: {
      ...content,
      receiptHash: computeExecutionAttemptReceiptHashV1(content),
    },
  });
}

function canonicalUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
