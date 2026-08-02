import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  PAGE_ACTION_REQUEST_SCHEMA,
  canonicalCollectorSha256V1,
  computeCompletionReceiptHashV1,
  computeExecutionLineageHashV1,
  computeExecutionAttemptReceiptHashV1,
  computeLogicalLineageHashV1,
  normalizePageActionExecuteResponseV1,
  type PageActionExecuteResponseV1,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import type { ManagedPage } from '../src/daemon/page-registry.js';
import { FilePageActionAcceptanceRepository } from '../src/daemon/file-acceptance-repository.js';
import {
  DatabaseAnchoredMonotonicClock,
  HmacRenewalCredentialVerifier,
  InMemoryPageActionAcceptanceRepository,
  ProfileDaemonRuntime,
  SupervisorRuntimeError,
  fenceDigest,
  signRenewalCredentialTransport,
  type IdentityProbeReceipt,
  type PageActionAcceptanceRepository,
  type PageActionExecutor,
  type ProfileRecoveryStateRepository,
  type PersistentContextDescriptor,
  type PersistentContextHost,
  type SupervisorRuntimeEventSink,
} from '../src/daemon/supervisor-runtime.js';
import {
  canonicalRpcPayloadHash,
  SUPERVISOR_PROTOCOL_SHA256_V2,
  type ParsedSupervisorRpcRequestV2,
  type SupervisorRpcBindingV2,
} from '../src/daemon/supervisor-rpc.js';

const key = 'a-supervisor-test-key-with-at-least-32-bytes';
const now = new Date('2026-07-31T08:00:00.000Z');
const PROFILE_ID = '60000000-0000-4000-8000-000000000001';
const DAEMON_ID = '60000000-0000-4000-8000-000000000002';
const SUPERVISOR_LEASE_ID = '60000000-0000-4000-8000-000000000003';
const RESERVATION_LEASE_ID = '60000000-0000-4000-8000-000000000004';
const WORK_LEASE_ID = '60000000-0000-4000-8000-000000000005';
const transportAuthority = {
  mode: 'scripted_offline' as const,
  executionAuthorityDocumentId: '60000000-0000-4000-8000-000000000006',
  executionAuthorityDocumentSha256: 'a'.repeat(64),
  executionSubjectDocumentId: '60000000-0000-4000-8000-000000000007',
  executionSubjectDocumentSha256: 'b'.repeat(64),
  cohortId: '60000000-0000-4000-8000-000000000008',
  runId: '60000000-0000-4000-8000-000000000009',
  protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
};

class FakePage implements ManagedPage {
  closed = false;
  failClose = false;
  isClosed(): boolean { return this.closed; }
  async close(): Promise<void> {
    if (this.failClose) throw new Error('close failed');
    this.closed = true;
  }
  url(): string { return 'about:blank'; }
}

class FakeHost implements PersistentContextHost {
  ensureCount = 0;
  createCount = 0;
  restartCount = 0;
  contextGeneration = 1;
  readonly ownedPages: FakePage[] = [];
  readonly ids = new WeakMap<FakePage, string>();
  failPageClose = false;
  probedPages: ManagedPage[] = [];

  async ensureStarted(input: {
    profileId: string; profileName: string; daemonInstanceId: string;
    contextGeneration: number; headful: true;
  }): Promise<PersistentContextDescriptor> {
    this.ensureCount += 1;
    this.contextGeneration = input.contextGeneration;
    return { ...input, chromiumPid: 4242 };
  }
  async createPage(): Promise<ManagedPage> {
    this.createCount += 1;
    const page = new FakePage();
    page.failClose = this.failPageClose;
    this.ownedPages.push(page);
    this.ids.set(page, `pw-${this.createCount}`);
    return page;
  }
  pages(): readonly ManagedPage[] { return this.ownedPages; }
  pageId(page: ManagedPage): string { return this.ids.get(page as FakePage)!; }
  async restart(input: { nextContextGeneration: number }): Promise<PersistentContextDescriptor> {
    this.restartCount += 1;
    this.contextGeneration = input.nextContextGeneration;
    return {
      profileId: PROFILE_ID, profileName: 'profile-1', daemonInstanceId: DAEMON_ID,
      contextGeneration: input.nextContextGeneration, chromiumPid: 4243, headful: true,
    };
  }
  async stop(): Promise<void> {}
  async probeIdentity(input: {
    expectedMemberId: string; probeRevision: string; page?: ManagedPage;
  }): Promise<IdentityProbeReceipt> {
    if (input.page) this.probedPages.push(input.page);
    return {
      probeReceiptId: 'probe-1',
      probeRevision: input.probeRevision,
      probedAt: now.toISOString(),
      expectedMemberId: input.expectedMemberId,
      observedMemberId: input.expectedMemberId,
      pageState: 'normal',
      passed: true,
      safeEvidenceHash: 'f'.repeat(64),
    };
  }
}

class CloseObservingAcceptanceRepository
extends InMemoryPageActionAcceptanceRepository {
  completeObservedClosedPage = false;

  constructor(private readonly host: FakeHost) {
    super();
  }

  override async complete(
    input: Parameters<InMemoryPageActionAcceptanceRepository['complete']>[0],
  ): Promise<void> {
    this.completeObservedClosedPage = this.host.ownedPages.length === 1
      && this.host.ownedPages[0]!.closed;
    await super.complete(input);
  }
}

class CompletionObservingAcceptanceRepository
extends InMemoryPageActionAcceptanceRepository {
  completeCount = 0;

  constructor(
    private readonly observe: (
      input: Parameters<InMemoryPageActionAcceptanceRepository['complete']>[0],
    ) => void | Promise<void>,
  ) {
    super();
  }

  override async complete(
    input: Parameters<InMemoryPageActionAcceptanceRepository['complete']>[0],
  ): Promise<void> {
    this.completeCount += 1;
    await this.observe(input);
    await super.complete(input);
  }
}

describe('ProfileDaemonRuntime', () => {
  it('executes 100 actions through one headful Context and returns to zero Pages', async () => {
    const host = new FakeHost();
    const runtime = makeRuntime(host, {
      async execute(request) {
        return fakeResponse(request);
      },
    });
    await runtime.ensureWarm();
    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      const rpc = signedExecuteRequest(ordinal);
      await expect(handleExecute(runtime, rpc)).resolves.toMatchObject({
        ok: true,
        data: {
          executionAttemptReceipt: {
            pageLifecycle: {
              baselinePages: 0, createdPages: 1, closedPages: 1,
              transferredPages: 0, remainingOwnedPages: 0,
            },
          },
        },
      });
    }
    expect(host.ensureCount).toBe(1);
    expect(host.createCount).toBe(100);
    expect(host.ownedPages.every((page) => page.closed)).toBe(true);
    expect(runtime.status()).toMatchObject({
      runtimeState: 'warm',
      chromiumPid: 4242,
      contextGeneration: 1,
      activeWorkUnitId: null,
    });
    expect(runtime.status().pageSessions.filter((page) => page.state !== 'closed'))
      .toHaveLength(0);
  });

  it('rejects stale Supervisor generation before Page creation', async () => {
    const host = new FakeHost();
    const runtime = makeRuntime(host, { execute: async (request) => fakeResponse(request) });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    request.binding.supervisor.generation = 2;
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'RPC_BINDING_MISMATCH' },
    });
    expect(host.createCount).toBe(0);
  });

  it('closes through the registry before committing the terminal acceptance', async () => {
    const host = new FakeHost();
    const repository = new CloseObservingAcceptanceRepository(host);
    const runtime = makeRuntime(
      host,
      { execute: async (request) => fakeResponse(request) },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          pageLifecycle: {
            createdPages: 1, closedPages: 1,
            transferredPages: 0, remainingOwnedPages: 0,
          },
        },
      },
    });
    expect(repository.completeObservedClosedPage).toBe(true);
  });

  it('re-hashes the strict execution and completion receipts after actual close', async () => {
    const host = new FakeHost();
    const repository = new CloseObservingAcceptanceRepository(host);
    const request = signedExecuteRequest(1);
    const candidate = fullCompletedResponse(request.payload);
    const previousExecutionHash = candidate.executionAttemptReceipt.receiptHash;
    const previousCompletionHash = candidate.completionReceipt!.completionReceiptHash;
    const runtime = makeRuntime(
      host,
      { execute: async () => candidate },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();
    const terminal = await handleExecute(runtime, request);
    expect(terminal).toMatchObject({ ok: true });
    if (!terminal.ok) throw new TypeError('Expected terminal response.');
    const rebound = terminal.data as PageActionExecuteResponseV1;
    expect(() => normalizePageActionExecuteResponseV1(rebound)).not.toThrow();
    expect(rebound.executionAttemptReceipt).toMatchObject({
      pageLifecycle: {
        baselinePages: 0, createdPages: 1, closedPages: 1,
        transferredPages: 0, remainingOwnedPages: 0,
      },
      metrics: { pageLifecycleFinalizedAtMs: now.getTime() },
    });
    expect(rebound.executionAttemptReceipt.receiptHash).not.toBe(previousExecutionHash);
    expect(rebound.completionReceipt!.completionReceiptHash).not.toBe(previousCompletionHash);
    expect(rebound.completionReceipt!.executionAttemptReceiptRefs.at(-1)?.receiptHash)
      .toBe(rebound.executionAttemptReceipt.receiptHash);
    expect(rebound.completionReceipt!.finalizedByExecutionRef?.receiptHash)
      .toBe(rebound.executionAttemptReceipt.receiptHash);
    expect(repository.completeObservedClosedPage).toBe(true);
  });

  it('closes and commits a truthful lifecycle after cancellation', async () => {
    const host = new FakeHost();
    let entered!: () => void;
    const pageEntered = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = makeRuntime(host, {
      async execute(request, scope) {
        entered();
        await new Promise<void>((resolve) => {
          scope.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return strictTerminalResponse(request, 'cancelled', {
          code: 'COLLECTION_CANCELLED', category: 'cancelled', retryable: false,
          actionRequired: null, recoveryAction: 'lookup-terminal-receipt',
        });
      },
    });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    const execution = handleExecute(runtime, request);
    await pageEntered;
    await expect(runtime.cancel({
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      pageActionId: request.payload.pageActionId,
      executionLineage: request.payload.executionLineage,
      executionLineageHash: request.payload.executionLineageHash,
      reason: 'test cancellation',
    } as never)).resolves.toMatchObject({ cancelled: true, state: 'cancelling' });
    await expect(execution).resolves.toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          outcome: 'cancelled',
          pageLifecycle: {
            createdPages: 1, closedPages: 1,
            transferredPages: 0, remainingOwnedPages: 0,
          },
        },
      },
    });
    expect(runtime.status().pageSessions[0]).toMatchObject({
      state: 'closed', closeReason: 'work_unit_cancelled',
    });
  });

  it('fails closed on an expired renewal credential', async () => {
    const host = new FakeHost();
    const runtime = makeRuntime(host, { execute: async (request) => fakeResponse(request) });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1, {
      credentialExpiresAt: '2026-07-31T07:59:59.000Z',
    });
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_EXPIRED' },
    });
    expect(host.createCount).toBe(0);
  });

  it('closes a registered Page when authorization expires immediately after creation', async () => {
    let current = now.getTime();
    class ExpiringCreateHost extends FakeHost {
      override async createPage(): Promise<ManagedPage> {
        const page = await super.createPage();
        current += 10;
        return page;
      }
    }
    const host = new ExpiringCreateHost();
    let executions = 0;
    const runtime = makeRuntime(host, {
      async execute(request) {
        executions += 1;
        return fakeResponse(request);
      },
    }, { now: () => new Date(current) });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1, {
      credentialExpiresAt: '2026-07-31T08:00:00.005Z',
    });

    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_EXPIRED' },
    });
    expect(host.createCount).toBe(1);
    expect(host.ownedPages[0]?.closed).toBe(true);
    expect(runtime.status().pageSessions[0]).toMatchObject({ state: 'closed' });
    expect(executions).toBe(0);
  });

  it('rolls back Page ownership and closes the raw Page when registration event persistence fails', async () => {
    const host = new FakeHost();
    let executions = 0;
    const runtime = makeRuntime(host, {
      async execute(request) {
        executions += 1;
        return fakeResponse(request);
      },
    }, {
      eventSink: {
        append(event) {
          if (event.type === 'page_registered') {
            throw new Error('event journal unavailable');
          }
        },
      },
    });
    await runtime.ensureWarm();

    const request = signedExecuteRequest(1);
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_REGISTRATION_EVENT_FAILED' },
    });
    expect(executions).toBe(0);
    expect(host.ownedPages).toHaveLength(1);
    expect(host.ownedPages[0]?.closed).toBe(true);
    expect(runtime.status()).toMatchObject({
      activeWorkUnitId: null,
      activePageSessionId: null,
      pageSessions: [],
    });
  });

  it('transfers the same challenge Page/PID/Context to intervention and enforces cooldown', async () => {
    const host = new FakeHost();
    let persistedCooldown: string | null = null;
    const recoveryStateRepository: ProfileRecoveryStateRepository = {
      load: async () => ({ cooldownUntil: persistedCooldown }),
      save: async (input) => { persistedCooldown = input.cooldownUntil; },
    };
    let current = now.getTime();
    let entered!: () => void;
    const pageEntered = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = makeRuntime(host, {
      async execute(request, scope) {
        entered();
        await new Promise<void>((resolve, reject) => {
          scope.signal.addEventListener('abort', () => reject(new Error('intervention')), { once: true });
        });
        return fakeResponse(request);
      },
    }, { now: () => new Date(current), recoveryStateRepository });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    const execution = handleExecute(runtime, request);
    await pageEntered;
    const before = runtime.status();
    const handle = await runtime.beginIntervention({
      interventionSessionId: 'intervention-1',
      pageSessionId: before.activePageSessionId!,
      expectedWorkUnitId: 'work-1',
      operatorId: 'operator-1',
      expiresAt: '2026-07-31T08:10:00.000Z',
    });
    expect(handle).toMatchObject({
      chromiumPid: 4242,
      contextGeneration: 1,
      pageSessionId: before.activePageSessionId,
    });
    await expect(execution).resolves.toMatchObject({ ok: false });
    const probe = await runtime.verifyIntervention({
      interventionSessionId: 'intervention-1',
      expectedMemberId: 'member-1',
      probeRevision: 'probe-v1',
    });
    expect(probe.passed).toBe(true);
    await expect(runtime.endIntervention({
      interventionSessionId: 'intervention-1',
      reason: 'verified',
    })).resolves.toEqual({
      cooldownUntil: '2026-07-31T08:10:00.000Z',
      runtimeState: 'warm',
    });
    const restartedRuntime = makeRuntime(
      new FakeHost(),
      { execute: async (request) => fakeResponse(request) },
      { now: () => new Date(current), recoveryStateRepository },
    );
    await restartedRuntime.ensureWarm();
    expect(restartedRuntime.status().cooldownUntil).toBe('2026-07-31T08:10:00.000Z');
    const blockedRequest = signedExecuteRequest(2);
    await expect(handleExecute(runtime, blockedRequest)).resolves.toMatchObject({
      ok: false,
      error: { code: 'POST_RECOVERY_COOLDOWN' },
    });
    expect(host.ensureCount).toBe(1);
    expect(host.restartCount).toBe(0);
    current += 10 * 60_000;
    await expect(runtime.finalReadinessProbe({
      expectedMemberId: 'member-1',
      probeRevision: 'final-probe-v1',
    })).resolves.toMatchObject({ passed: true });
    expect(host.probedPages).toHaveLength(2);
    expect(host.probedPages[1]?.isClosed()).toBe(true);
    expect(runtime.status().cooldownUntil).toBeNull();
    expect(persistedCooldown).toBeNull();
  });

  it('retains a challenge response Page after the executor requests close', async () => {
    const host = new FakeHost();
    const runtime = makeRuntime(host, {
      async execute(request, scope) {
        await scope.closeOwnedPage('collector_terminal');
        return strictTerminalResponse(request, 'failed', {
          code: 'RISK_CHALLENGE', category: 'risk-control', retryable: false,
          actionRequired: 'operator-intervention',
          recoveryAction: 'begin-intervention',
        });
      },
    });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    const terminal = await handleExecute(runtime, request);
    expect(terminal).toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          pageLifecycle: {
            createdPages: 1, closedPages: 0,
            transferredPages: 1, remainingOwnedPages: 0,
          },
        },
      },
    });
    const pending = runtime.status();
    expect(pending.activeWorkUnitId).toBeNull();
    expect(pending.activePageSessionId).not.toBeNull();
    expect(pending.pageSessions[0]).toMatchObject({
      ownerKind: 'intervention',
      ownerId: 'pending-intervention-attempt-1',
      state: 'open',
      transferredAt: now.toISOString(),
    });
    expect(host.ownedPages[0]?.closed).toBe(false);
    await expect(runtime.beginIntervention({
      interventionSessionId: 'intervention-risk-1',
      pageSessionId: pending.activePageSessionId!,
      expectedWorkUnitId: 'work-1',
      operatorId: 'operator-1',
      expiresAt: '2026-07-31T08:10:00.000Z',
    })).resolves.toMatchObject({
      chromiumPid: 4242,
      contextGeneration: 1,
      pageSessionId: pending.activePageSessionId,
    });
    expect(runtime.status().pageSessions[0]).toMatchObject({
      ownerKind: 'intervention',
      ownerId: 'intervention-risk-1',
      state: 'open',
      transferredAt: now.toISOString(),
    });
    expect(host.ownedPages[0]?.closed).toBe(false);
  });

  it('commits only after the challenge Page transfer and exact receipt re-hash', async () => {
    const host = new FakeHost();
    const request = signedExecuteRequest(1);
    const candidate = strictTerminalResponse(request.payload, 'failed', {
      code: 'RISK_CHALLENGE', category: 'risk-control', retryable: false,
      actionRequired: 'operator-intervention', recoveryAction: 'begin-intervention',
    });
    const phases: string[] = [];
    let runtime!: ProfileDaemonRuntime;
    const repository = new CompletionObservingAcceptanceRepository(({ response }) => {
      phases.push('acceptance_complete');
      const status = runtime.status();
      expect(status.activeWorkUnitId).toBeNull();
      const page = status.pageSessions[0];
      expect(page).toMatchObject({
        ownerKind: 'intervention',
        ownerId: 'pending-intervention-attempt-1',
        state: 'open',
      });
      expect(response.executionAttemptReceipt.receiptHash)
        .not.toBe(candidate.executionAttemptReceipt.receiptHash);
      const { receiptHash, ...content } = response.executionAttemptReceipt;
      expect(receiptHash).toBe(computeExecutionAttemptReceiptHashV1(content));
      expect(() => normalizePageActionExecuteResponseV1(response)).not.toThrow();
    });
    runtime = makeRuntime(
      host,
      { execute: async () => candidate },
      {
        acceptanceRepository: repository,
        eventSink: { append: (event) => { phases.push(event.type); } },
      },
    );
    await runtime.ensureWarm();
    const terminal = await handleExecute(runtime, request);
    expect(terminal).toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          pageLifecycle: {
            createdPages: 1, closedPages: 0,
            transferredPages: 1, remainingOwnedPages: 0,
          },
        },
      },
    });
    expect(phases.indexOf('page_owner_transferred'))
      .toBeLessThan(phases.indexOf('acceptance_complete'));
    expect(phases.indexOf('acceptance_complete'))
      .toBeLessThan(phases.indexOf('work_unit_terminal_receipt_committed'));
    await expect(runtime.cancel({
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      pageActionId: request.payload.pageActionId,
      logicalLineage: request.payload.logicalLineage,
      logicalLineageHash: request.payload.logicalLineageHash,
      executionLineage: request.payload.executionLineage,
      executionLineageHash: request.payload.executionLineageHash,
      reason: 'too late to cancel terminal receipt',
    })).resolves.toEqual({ cancelled: false, state: 'terminal' });
    expect(repository.completeCount).toBe(1);
    expect(host.ownedPages[0]?.closed).toBe(false);
  });

  it('closes a transferred challenge Page when no operator begins intervention', async () => {
    const host = new FakeHost();
    const runtime = makeRuntime(host, {
      execute: async (request) => strictTerminalResponse(request, 'failed', {
        code: 'RISK_CHALLENGE', category: 'risk-control', retryable: false,
        actionRequired: 'operator-intervention', recoveryAction: 'begin-intervention',
      }),
    }, { interventionTransferGraceMs: 5 });
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runtime.status()).toMatchObject({
      activeWorkUnitId: null,
      activePageSessionId: null,
      pageSessions: [{
        ownerKind: 'intervention',
        ownerId: 'pending-intervention-attempt-1',
        state: 'closed',
        closeReason: 'intervention_transfer_timeout',
      }],
    });
    expect(host.ownedPages[0]?.closed).toBe(true);
  });

  it('fails closed without terminal commit when intervention transfer fails', async () => {
    const host = new FakeHost();
    const repository = new CompletionObservingAcceptanceRepository(() => {});
    const runtime = makeRuntime(host, {
      execute: async (request) => strictTerminalResponse(request, 'failed', {
        code: 'RISK_CHALLENGE', category: 'risk-control', retryable: false,
        actionRequired: 'operator-intervention', recoveryAction: 'begin-intervention',
      }),
    }, { acceptanceRepository: repository });
    await runtime.ensureWarm();
    const internals = runtime as unknown as {
      registry: {
        transferToIntervention: (...args: unknown[]) => Promise<never>;
      };
    };
    internals.registry.transferToIntervention = async () => {
      throw new Error('injected transfer failure');
    };
    const request = signedExecuteRequest(1);
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_LIFECYCLE_FINALIZATION_FAILED' },
    });
    expect(repository.completeCount).toBe(0);
    expect(runtime.status()).toMatchObject({
      activeWorkUnitId: null,
      activePageSessionId: null,
      pageSessions: [{
        ownerKind: 'work_unit',
        ownerId: 'work-1',
        state: 'closed',
        closeReason: 'page_lifecycle_finalization_failed',
      }],
    });
    expect(host.ownedPages[0]?.closed).toBe(true);
  });

  it('uses a transport renewal for authorization during an in-flight execution', async () => {
    const host = new FakeHost();
    let current = now.getTime();
    let entered!: () => void;
    let resume!: () => void;
    const pageEntered = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const runtime = makeRuntime(host, {
      async execute(request, scope) {
        entered();
        await resumed;
        await scope.assertAuthorized();
        return fakeResponse(request);
      },
    }, { now: () => new Date(current) });
    await runtime.ensureWarm();
    const initial = signedExecuteRequest(1, {
      credentialExpiresAt: '2026-07-31T08:01:00.000Z',
    });
    const execution = handleExecute(runtime, initial);
    await pageEntered;
    const renewal = signedExecuteRequest(1, {
      credentialExpiresAt: '2026-07-31T08:05:00.000Z',
    });
    await runtime.renewExecution(initial.rpcId, renewal);
    current += 2 * 60_000;
    resume();
    await expect(execution).resolves.toMatchObject({ ok: true });
  });

  it('rebuilds the Context generation after persistent Page cleanup failure', async () => {
    const host = new FakeHost();
    host.failPageClose = true;
    const repository = new InMemoryPageActionAcceptanceRepository();
    const runtime = makeRuntime(
      host,
      { execute: async (request) => fakeResponse(request) },
      { cleanupGraceMs: 1, acceptanceRepository: repository },
    );
    await runtime.ensureWarm();
    const request = signedExecuteRequest(1);
    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_LIFECYCLE_FINALIZATION_FAILED', retryable: false },
    });
    expect(host.restartCount).toBe(1);
    expect(runtime.status()).toMatchObject({ runtimeState: 'warm', contextGeneration: 2 });
    await expect(repository.inspect(signedLookupRequest(request).payload)).resolves.toMatchObject({
      response: null,
    });
  });

  it('reconciles a durable in-flight acceptance through read-only lookup after daemon restart', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    await repository.accept({
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      canonicalRequestHash: canonicalRpcPayloadHash(request),
      pageActionPayloadHash: canonicalCollectorSha256V1(request.payload).replace(/^sha256:/u, ''),
      transportAuthority,
      pageActionId: request.payload.pageActionId,
      pageActionExecutionAttemptId: request.payload.pageActionExecutionAttemptId,
      acceptedAt: now.toISOString(),
      request: request.payload,
      remoteAttemptStartedAt: null,
      remoteAttemptAdmissions: [],
    });
    let executions = 0;
    const runtime = makeRuntime(
      new FakeHost(),
      { execute: async (pageAction) => { executions += 1; return fakeResponse(pageAction); } },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();

    const first = await runtime.handle(signedLookupRequest(request));
    expect(first).toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          outcome: 'failed',
          error: { code: 'EXECUTION_NOT_DISPATCHED', retryable: true },
        },
      },
    });
    expect(executions).toBe(0);

    await expect(handleExecute(runtime, request)).resolves.toMatchObject({
      ok: true,
      data: first.ok ? first.data : undefined,
    });
    expect(executions).toBe(0);
  });

  it('blocks automatic replacement when a durable remote-attempt marker has unknown outcome', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    const acceptance = {
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      canonicalRequestHash: canonicalRpcPayloadHash(request),
      pageActionPayloadHash: canonicalCollectorSha256V1(request.payload).replace(/^sha256:/u, ''),
      transportAuthority,
      pageActionId: request.payload.pageActionId,
      pageActionExecutionAttemptId: request.payload.pageActionExecutionAttemptId,
      acceptedAt: now.toISOString(),
      request: request.payload,
      remoteAttemptStartedAt: null,
      remoteAttemptAdmissions: [],
    };
    await repository.accept(acceptance);
    await repository.recordRemoteAttemptAdmission({
      acceptance,
      admission: {
        request: {
          remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1,
          purpose: 'single-target',
          requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
        },
        receipt: {
          remoteActionStartId: 'remote-action-start-1',
          admittedAt: '2026-07-31T08:00:01.000Z',
          transportAuthority,
          parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        },
      },
    });
    let executions = 0;
    const runtime = makeRuntime(
      new FakeHost(),
      { execute: async (pageAction) => { executions += 1; return fakeResponse(pageAction); } },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();

    await expect(runtime.handle(signedLookupRequest(request))).resolves.toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          outcome: 'failed',
          remoteRequestAttempts: [{
            remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1,
            purpose: 'single-target', status: 'failed',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
            error: { code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN', retryable: false },
          }],
          requestSnapshots: [{
            remoteRequestAttemptId: 'remote-attempt-1-1', purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
          }],
          metrics: { remoteAttemptStarted: 1, remoteAttemptsOutcomeUnknown: 1 },
          error: { code: 'EXECUTION_OUTCOME_UNKNOWN', retryable: false },
        },
      },
    });
    expect(executions).toBe(0);
  });

  it('restarts from the file journal with exact DB admission identities', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-restart-journal-'));
    const filePath = path.join(directory, 'acceptance.json');
    const request = signedExecuteRequest(1);
    const acceptance = {
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      canonicalRequestHash: canonicalRpcPayloadHash(request),
      pageActionPayloadHash: canonicalCollectorSha256V1(request.payload).replace(/^sha256:/u, ''),
      transportAuthority,
      pageActionId: request.payload.pageActionId,
      pageActionExecutionAttemptId: request.payload.pageActionExecutionAttemptId,
      acceptedAt: now.toISOString(),
      request: request.payload,
      remoteAttemptStartedAt: null,
      remoteAttemptAdmissions: [],
    };
    const beforeCrash = new FilePageActionAcceptanceRepository(filePath);
    await beforeCrash.accept(acceptance);
    await beforeCrash.recordRemoteAttemptAdmission({
      acceptance,
      admission: {
        request: {
          remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1,
          purpose: 'single-target',
          requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
        },
        receipt: {
          remoteActionStartId: 'pg-remote-action-start-1',
          admittedAt: '2026-07-31T08:00:01.000Z',
          transportAuthority,
          parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        },
      },
    });

    const runtime = makeRuntime(
      new FakeHost(),
      { execute: async (pageAction) => fakeResponse(pageAction) },
      { acceptanceRepository: new FilePageActionAcceptanceRepository(filePath) },
    );
    await runtime.ensureWarm();
    await expect(runtime.handle(signedLookupRequest(request))).resolves.toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          remoteRequestAttempts: [{
            remoteRequestAttemptId: 'remote-attempt-1-1',
            ordinal: 1, purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
            startedAt: '2026-07-31T08:00:01.000Z',
            status: 'failed',
            error: { code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN', retryable: false },
          }],
          requestSnapshots: [{
            remoteRequestAttemptId: 'remote-attempt-1-1',
            purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
            observedAt: '2026-07-31T08:00:01.000Z',
          }],
          error: {
            code: 'EXECUTION_OUTCOME_UNKNOWN', retryable: false,
            recoveryAction: 'manual-reconcile-before-any-replacement-attempt',
          },
        },
      },
    });
  });

  it('leaves a lost exact-admission journal unresolved instead of committing zero attempts', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    await repository.accept({
      requestId: request.payload.requestId,
      idempotencyKey: request.payload.idempotencyKey,
      canonicalRequestHash: canonicalRpcPayloadHash(request),
      pageActionPayloadHash: canonicalCollectorSha256V1(request.payload).replace(/^sha256:/u, ''),
      transportAuthority,
      pageActionId: request.payload.pageActionId,
      pageActionExecutionAttemptId: request.payload.pageActionExecutionAttemptId,
      acceptedAt: now.toISOString(),
      request: request.payload,
      remoteAttemptStartedAt: '2026-07-31T08:00:01.000Z',
      remoteAttemptAdmissions: [],
    });
    const runtime = makeRuntime(
      new FakeHost(),
      { execute: async (pageAction) => fakeResponse(pageAction) },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();
    await expect(runtime.handle(signedLookupRequest(request))).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_JOURNAL_UNRESOLVED', retryable: false },
    });
    await expect(repository.inspect(signedLookupRequest(request).payload)).resolves.toMatchObject({
      response: null,
    });
  });

  it('persists the remote-attempt boundary before the executor may cross it', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    const runtime = makeRuntime(
      new FakeHost(),
      {
        async execute(_pageAction, scope) {
          await scope.admitRemoteAttempt({
            remoteRequestAttemptId: 'remote-attempt-1-1',
            ordinal: 1,
            purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
          });
          throw new Error('simulated crash after remote-attempt admission');
        },
      },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();
    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        ...boundAdmissionChannel(request),
        authorize: async () => ({
          remoteActionStartId: 'remote-action-start-1',
          admittedAt: now.toISOString(),
          transportAuthority,
          parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        }),
      },
    })).resolves.toMatchObject({ ok: false });
    await expect(repository.inspect(signedLookupRequest(request).payload))
      .resolves.toMatchObject({
      acceptance: {
        remoteAttemptStartedAt: now.toISOString(),
        remoteAttemptAdmissions: [{
          request: {
            remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1,
            purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
          },
          receipt: {
            remoteActionStartId: 'remote-action-start-1',
            admittedAt: now.toISOString(),
          },
        }],
      },
      response: null,
    });
    await expect(runtime.handle(signedLookupRequest(request))).resolves.toMatchObject({
      ok: true,
      data: {
        executionAttemptReceipt: {
          remoteRequestAttempts: [{
            remoteRequestAttemptId: 'remote-attempt-1-1', status: 'failed',
            error: { code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN', retryable: false },
          }],
          requestSnapshots: [{ remoteRequestAttemptId: 'remote-attempt-1-1' }],
          error: { code: 'EXECUTION_OUTCOME_UNKNOWN', retryable: false },
        },
      },
    });
  });

  it('does not cross the network boundary when durable admission journaling reaches expiry', async () => {
    let current = new Date('2026-07-31T08:06:59.999Z');
    let networkStarts = 0;
    const repository = new class extends InMemoryPageActionAcceptanceRepository {
      override async recordRemoteAttemptAdmission(
        input: Parameters<InMemoryPageActionAcceptanceRepository[
          'recordRemoteAttemptAdmission'
        ]>[0],
      ): Promise<void> {
        await super.recordRemoteAttemptAdmission(input);
        current = new Date('2026-07-31T08:07:00.000Z');
      }
    }();
    const request = signedExecuteRequest(1, {
      credentialExpiresAt: '2026-07-31T08:08:00.000Z',
    });
    const runtime = makeRuntime(
      new FakeHost(),
      {
        async execute(_pageAction, scope) {
          await scope.admitRemoteAttempt({
            remoteRequestAttemptId: 'remote-attempt-1-1',
            ordinal: 1,
            purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
          });
          networkStarts += 1;
          return fakeResponse(_pageAction);
        },
      },
      { acceptanceRepository: repository, now: () => new Date(current) },
    );
    await runtime.ensureWarm();

    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        ...boundAdmissionChannel(request),
        authorize: async () => ({
          remoteActionStartId: 'remote-action-start-1',
          admittedAt: current.toISOString(),
          transportAuthority,
          parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        }),
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'REMOTE_ATTEMPT_NOT_DISPATCHED_AFTER_ADMISSION',
        details: { causeCode: 'RPC_DEADLINE_EXCEEDED' },
      },
    });
    expect(networkStarts).toBe(0);
    await expect(repository.inspect(signedLookupRequest(request).payload))
      .resolves.toMatchObject({
        acceptance: {
          remoteAttemptAdmissions: [{
            request: { remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1 },
            receipt: { remoteActionStartId: 'remote-action-start-1' },
          }],
        },
        response: null,
      });
  });

  it('rejects an admission receipt authority mismatch before the executor network boundary', async () => {
    let networkStarts = 0;
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    const runtime = makeRuntime(new FakeHost(), {
      async execute(pageAction, scope) {
        await scope.admitRemoteAttempt({
          remoteRequestAttemptId: 'remote-attempt-1-1',
          ordinal: 1,
          purpose: 'single-target',
          requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
        });
        networkStarts += 1;
        return fakeResponse(pageAction);
      },
    }, { acceptanceRepository: repository });
    await runtime.ensureWarm();
    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        ...boundAdmissionChannel(request),
        authorize: async () => ({
          remoteActionStartId: 'remote-action-start-mismatch',
          admittedAt: now.toISOString(),
          transportAuthority: {
            ...transportAuthority,
            runId: '60000000-0000-4000-8000-000000000099',
          },
          parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        }),
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_RESPONSE_MISMATCH' },
    });
    expect(networkStarts).toBe(0);
    await expect(repository.inspect(signedLookupRequest(request).payload))
      .resolves.toMatchObject({
        acceptance: { remoteAttemptAdmissions: [], remoteAttemptStartedAt: null },
      });
  });

  it('rejects an absent admission channel before durable acceptance or Page creation', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const host = new FakeHost();
    const request = signedExecuteRequest(1);
    const runtime = makeRuntime(host, { execute: async (input) => fakeResponse(input) }, {
      acceptanceRepository: repository,
    });
    await runtime.ensureWarm();

    await expect(runtime.handle(request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_CHANNEL_REQUIRED', retryable: false },
    });
    expect(host.ownedPages).toHaveLength(0);
    await expect(repository.inspect(signedLookupRequest(request).payload)).resolves.toBeNull();
  });

  it.each([
    ['mode', { mode: 'live_remote' }],
    ['authority document id', {
      executionAuthorityDocumentId: '60000000-0000-4000-8000-000000000099',
    }],
    ['authority document hash', { executionAuthorityDocumentSha256: 'c'.repeat(64) }],
    ['subject document id', {
      executionSubjectDocumentId: '60000000-0000-4000-8000-000000000098',
    }],
    ['subject document hash', { executionSubjectDocumentSha256: 'd'.repeat(64) }],
    ['cohort', { cohortId: '60000000-0000-4000-8000-000000000097' }],
    ['Run', { runId: '60000000-0000-4000-8000-000000000096' }],
    ['protocol', { protocolSha256: 'e'.repeat(64) }],
  ])('rejects mismatched admission %s before durable acceptance or Page creation', async (
    _name,
    authorityOverride,
  ) => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const host = new FakeHost();
    const request = signedExecuteRequest(1);
    let admissionCalls = 0;
    const runtime = makeRuntime(host, { execute: async (input) => fakeResponse(input) }, {
      acceptanceRepository: repository,
    });
    await runtime.ensureWarm();

    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        transportAuthority: { ...transportAuthority, ...authorityOverride },
        parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
        authorize: async () => {
          admissionCalls += 1;
          throw new Error('must not authorize');
        },
      } as never,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_BINDING_MISMATCH', retryable: false },
    });
    expect(admissionCalls).toBe(0);
    expect(host.ownedPages).toHaveLength(0);
    await expect(repository.inspect(signedLookupRequest(request).payload)).resolves.toBeNull();
  });

  it('fails closed before the local uncertainty marker when DB admission is unavailable', async () => {
    const repository = new InMemoryPageActionAcceptanceRepository();
    const request = signedExecuteRequest(1);
    const runtime = makeRuntime(
      new FakeHost(),
      {
        async execute(_pageAction, scope) {
          await scope.admitRemoteAttempt({
            remoteRequestAttemptId: 'remote-attempt-1-1',
            ordinal: 1,
            purpose: 'single-target',
            requestBusinessHash: canonicalCollectorSha256V1('remote-request-1'),
          });
          throw new Error('unreachable network side effect');
        },
      },
      { acceptanceRepository: repository },
    );
    await runtime.ensureWarm();

    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        ...boundAdmissionChannel(request),
        authorize: async () => {
          throw new SupervisorRuntimeError(
            'REMOTE_ATTEMPT_ADMISSION_UNAVAILABLE',
            'Database admission is unavailable.',
            true,
          );
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_UNAVAILABLE' },
    });
    await expect(repository.inspect(signedLookupRequest(request).payload))
      .resolves.toMatchObject({
        acceptance: { remoteAttemptStartedAt: null, remoteAttemptAdmissions: [] },
        response: null,
      });
  });

  it('rejects non-canonical remote identity and bare hash before the DB callback', async () => {
    const request = signedExecuteRequest(1);
    let admissions = 0;
    const runtime = makeRuntime(new FakeHost(), {
      async execute(_pageAction, scope) {
        await scope.admitRemoteAttempt({
          remoteRequestAttemptId: 'forged-remote-id',
          ordinal: 2,
          purpose: 'single-target',
          requestBusinessHash: 'a'.repeat(64),
        });
        throw new Error('unreachable network side effect');
      },
    });
    await runtime.ensureWarm();

    await expect(runtime.handle(request, {
      remoteAttemptAdmission: {
        ...boundAdmissionChannel(request),
        authorize: async () => {
          admissions += 1;
          return { remoteActionStartId: 'remote-start-1', admittedAt: now.toISOString() };
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ATTEMPT_ADMISSION_INVALID' },
    });
    expect(admissions).toBe(0);
  });
});

describe('DatabaseAnchoredMonotonicClock', () => {
  it('does not move backward or extend time when the wall clock changes', () => {
    let monotonic = 100;
    const clock = new DatabaseAnchoredMonotonicClock({
      databaseNow: now,
      monotonicNow: () => monotonic,
    });
    expect(clock.now().toISOString()).toBe(now.toISOString());
    monotonic = 50;
    expect(clock.now().toISOString()).toBe(now.toISOString());
    monotonic = 1_100;
    expect(clock.now().toISOString()).toBe('2026-07-31T08:00:01.000Z');
  });
});

function makeRuntime(
  host: FakeHost,
  executor: PageActionExecutor,
  overrides: {
    now?: () => Date;
    cleanupGraceMs?: number;
    interventionTransferGraceMs?: number;
    recoveryStateRepository?: ProfileRecoveryStateRepository;
    acceptanceRepository?: PageActionAcceptanceRepository;
    eventSink?: SupervisorRuntimeEventSink;
  } = {},
) {
  return new ProfileDaemonRuntime({
    profileId: PROFILE_ID,
    profileName: 'profile-1',
    daemonInstanceId: DAEMON_ID,
    contextGeneration: 1,
    supervisorGeneration: 1,
    transportAuthority,
    host,
    credentialVerifier: new HmacRenewalCredentialVerifier({ key1: key }),
    acceptanceRepository:
      overrides.acceptanceRepository ?? new InMemoryPageActionAcceptanceRepository(),
    executor,
    ...(overrides.eventSink === undefined ? {} : { eventSink: overrides.eventSink }),
    ...(overrides.recoveryStateRepository === undefined
      ? {}
      : { recoveryStateRepository: overrides.recoveryStateRepository }),
    now: overrides.now ?? (() => now),
    ...(overrides.cleanupGraceMs === undefined
      ? {}
      : { cleanupGraceMs: overrides.cleanupGraceMs }),
    ...(overrides.interventionTransferGraceMs === undefined
      ? {}
      : { interventionTransferGraceMs: overrides.interventionTransferGraceMs }),
  });
}

function boundAdmissionChannel(
  request: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
) {
  return {
    transportAuthority: structuredClone(request.binding.transportAuthority),
    parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
  };
}

function handleExecute(
  runtime: ProfileDaemonRuntime,
  request: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
) {
  return runtime.handle(request, {
    remoteAttemptAdmission: {
      ...boundAdmissionChannel(request),
      authorize: async () => ({
        remoteActionStartId: '60000000-0000-4000-8000-000000000095',
        admittedAt: now.toISOString(),
        transportAuthority: structuredClone(request.binding.transportAuthority),
        parentCanonicalRequestHash: canonicalRpcPayloadHash(request),
      }),
    },
  });
}

function signedExecuteRequest(
  ordinal: number,
  credentialOverrides: { credentialExpiresAt?: string } = {},
): ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' } {
  const requestId = `request-${ordinal}`;
  const workUnitId = `work-${ordinal}`;
  const pageActionBusinessHash = canonicalCollectorSha256V1(`offer-${ordinal}`);
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: `logical-${ordinal}`,
    collectionTaskId: 'collection-task-1',
    workUnitId,
    pageActionId: `page-action-${ordinal}`,
    pageActionBusinessHash,
    actionKind: 'offer-detail' as const,
    businessSubject: {
      kind: 'offer-detail' as const,
      offerId: `${1000 + ordinal}`,
      memberId: 'member-1',
      searchOriginReceiptId: 'search-origin-receipt-1',
      searchOriginReceiptHash: canonicalCollectorSha256V1('search-origin-receipt-1'),
    },
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: `work-attempt-${ordinal}`,
    pageActionExecutionAttemptId: `attempt-${ordinal}`,
    executionAttemptOrdinal: ordinal,
    requestId,
    idempotencyKey: `idempotency-${ordinal}`,
    profile: {
      profileId: PROFILE_ID,
      profileName: 'profile-1',
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      egressId: 'egress-1',
    },
    fences: {
      supervisor: supervisorFence(),
      reservation: reservationFence(),
      workUnit: workUnitFence(),
    },
  };
  const pageAction = {
    schema: PAGE_ACTION_REQUEST_SCHEMA,
    requestId,
    idempotencyKey: `idempotency-${ordinal}`,
    pageActionId: logicalLineage.pageActionId,
    pageActionExecutionAttemptId: `attempt-${ordinal}`,
    executionAttemptOrdinal: ordinal,
    pageActionBusinessHash,
    actionKind: 'offer-detail',
    startNotBefore: now.toISOString(),
    deadlineAt: '2026-07-31T08:07:00.000Z',
    leaseNotAfter: '2026-07-31T08:08:00.000Z',
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
  } as unknown as PageActionRequestV1;
  const base = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: `rpc-${ordinal}`,
    method: 'collector.pageAction.execute' as const,
    deadlineAt: '2026-07-31T08:07:00.000Z',
    binding: {
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisor: supervisorFence(),
      reservation: reservationFence(),
      workUnit: workUnitFence(),
      transportAuthority,
      renewalCredential: null,
      controlCredential: null,
    } satisfies SupervisorRpcBindingV2,
    payload: pageAction,
  };
  const requestHash = canonicalRpcPayloadHash(base as ParsedSupervisorRpcRequestV2);
  base.binding.renewalCredential = signRenewalCredentialTransport({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisorLeaseId: SUPERVISOR_LEASE_ID,
      supervisorGeneration: 1,
      supervisorFenceDigest: fenceDigest(supervisorFence()),
      reservationLeaseId: RESERVATION_LEASE_ID,
      reservationGeneration: 1,
      reservationFenceDigest: fenceDigest(reservationFence()),
      workUnitLeaseId: WORK_LEASE_ID,
      workUnitGeneration: 1,
      workUnitFenceDigest: fenceDigest(workUnitFence()),
      requestId,
      canonicalRequestHash: requestHash,
      requestDeadlineAt: base.deadlineAt,
      idempotencyKey: `idempotency-${ordinal}`,
      issuedAt: '2026-07-31T07:59:00.000Z',
      credentialNotBefore: '2026-07-31T07:59:00.000Z',
      credentialExpiresAt:
        credentialOverrides.credentialExpiresAt ?? '2026-07-31T08:05:00.000Z',
      leaseNotAfter: '2026-07-31T08:08:00.000Z',
      keyId: 'key1',
    },
    algorithm: 'HMAC-SHA256',
  }, key);
  return base as ParsedSupervisorRpcRequestV2 & {
    method: 'collector.pageAction.execute';
  };
}

function signedLookupRequest(
  execute: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
): ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.lookupReceipt' } {
  const payload = {
    schema: 'collector.page-action.lookup-receipt.v1' as const,
    requestId: execute.payload.requestId,
    idempotencyKey: execute.payload.idempotencyKey,
    pageActionId: execute.payload.pageActionId,
    pageActionExecutionAttemptId: execute.payload.pageActionExecutionAttemptId,
    logicalLineageId: execute.payload.logicalLineage.logicalLineageId,
    logicalLineageHash: execute.payload.logicalLineageHash,
    targetExecutionLineageHash: execute.payload.executionLineageHash,
    readFences: execute.payload.executionLineage.fences,
  };
  const request = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: `lookup-${execute.rpcId}`,
    method: 'collector.pageAction.lookupReceipt' as const,
    deadlineAt: execute.deadlineAt,
    binding: {
      ...execute.binding,
      renewalCredential: null,
      controlCredential: null,
    },
    payload,
  };
  request.binding.renewalCredential = signRenewalCredentialTransport({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisorLeaseId: SUPERVISOR_LEASE_ID,
      supervisorGeneration: 1,
      supervisorFenceDigest: fenceDigest(supervisorFence()),
      reservationLeaseId: RESERVATION_LEASE_ID,
      reservationGeneration: 1,
      reservationFenceDigest: fenceDigest(reservationFence()),
      workUnitLeaseId: WORK_LEASE_ID,
      workUnitGeneration: 1,
      workUnitFenceDigest: fenceDigest(workUnitFence()),
      requestId: payload.requestId,
      canonicalRequestHash: canonicalRpcPayloadHash(request as never),
      requestDeadlineAt: request.deadlineAt,
      idempotencyKey: payload.idempotencyKey,
      issuedAt: '2026-07-31T07:59:00.000Z',
      credentialNotBefore: '2026-07-31T07:59:00.000Z',
      credentialExpiresAt: '2026-07-31T08:05:00.000Z',
      leaseNotAfter: '2026-07-31T08:08:00.000Z',
      keyId: 'key1',
    },
    algorithm: 'HMAC-SHA256',
  }, key);
  return request as ParsedSupervisorRpcRequestV2 & {
    method: 'collector.pageAction.lookupReceipt';
  };
}

function fakeResponse(request: PageActionRequestV1) {
  return strictTerminalResponse(request, 'completed');
}

function strictTerminalResponse(
  request: PageActionRequestV1,
  outcome: 'completed' | 'failed' | 'cancelled',
  error?: {
    code: string;
    category: 'cancelled' | 'risk-control';
    retryable: boolean;
    actionRequired: string | null;
    recoveryAction: string;
  },
): PageActionExecuteResponseV1 {
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
    outcome,
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
    ...(error === undefined ? {} : { error }),
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: {
      ...content,
      receiptHash: computeExecutionAttemptReceiptHashV1(content),
    },
  });
}

function fullCompletedResponse(request: PageActionRequestV1): PageActionExecuteResponseV1 {
  const subject = request.logicalLineage.businessSubject;
  if (subject.kind !== 'offer-detail') throw new TypeError('Offer subject expected.');
  const batch = {
    schemaVersion: 1 as const,
    batchId: 'batch-strict-lifecycle-1',
    unitId: request.logicalLineage.workUnitId,
    sourceRequestId: request.requestId,
    kind: 'offer-detail' as const,
    status: 'completed' as const,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    subject: { offerId: subject.offerId },
    scope: { requestedScope: 'page' },
    observations: [{ offerId: subject.offerId }],
    completeness: {
      requestedScope: 'page' as const,
      state: 'complete' as const,
      observedPages: [1], failedPages: [], uniqueItems: 1,
    },
    duplicateObservations: [], warnings: [], errors: [],
    rawEvidenceRefs: ['artifact:strict-lifecycle'],
    metrics: { remoteRequests: 0 },
  };
  const executionContent = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: 'execution-receipt-strict-lifecycle-1',
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
    outcome: 'completed' as const,
    terminal: true as const,
    actionKind: request.actionKind,
    remoteRequestAttempts: [],
    batches: [batch],
    requestSnapshots: [],
    pageLifecycle: {
      baselinePages: 0, createdPages: 1, closedPages: 0,
      transferredPages: 1, remainingOwnedPages: 0 as const,
    },
    metrics: { remoteRequests: 0 },
  };
  const execution = {
    ...executionContent,
    receiptHash: computeExecutionAttemptReceiptHashV1(executionContent),
  };
  const attemptRef = {
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    receiptId: execution.receiptId,
    receiptHash: execution.receiptHash,
    executionLineageHash: request.executionLineageHash,
  };
  const completionContent = {
    schema: PAGE_ACTION_COMPLETION_RECEIPT_SCHEMA,
    completionReceiptId: 'completion-receipt-strict-lifecycle-1',
    pageActionId: request.pageActionId,
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    actionKind: request.actionKind,
    status: 'completed' as const,
    terminal: true as const,
    executionAttemptReceiptRefs: [attemptRef] as [typeof attemptRef],
    finalizedByExecutionRef: attemptRef,
    batches: [batch] as [typeof batch],
    completedAt: now.toISOString(),
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: execution,
    completionReceipt: {
      ...completionContent,
      completionReceiptHash: computeCompletionReceiptHashV1(completionContent),
    },
  });
}

function supervisorFence() {
  return {
    leaseId: SUPERVISOR_LEASE_ID, generation: 1, fencingToken: 'supervisor-fence',
    leaseNotAfter: '2026-07-31T08:10:00.000Z',
  };
}
function reservationFence() {
  return {
    leaseId: RESERVATION_LEASE_ID, generation: 1, fencingToken: 'reservation-fence',
    leaseNotAfter: '2026-07-31T08:09:00.000Z',
  };
}
function workUnitFence() {
  return {
    leaseId: WORK_LEASE_ID, generation: 1, fencingToken: 'work-fence',
    leaseNotAfter: '2026-07-31T08:08:00.000Z',
  };
}
