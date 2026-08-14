import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  PageActionCancelV1,
  PageActionExecuteResponseV1,
  PageActionReceiptLookupV1,
  PageActionRequestV1,
  LeaseFenceV1,
} from '../collection/page-action-contracts.js';
import {
  computeCompletionReceiptHashV1,
  PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
  canonicalCollectorSha256V1,
  computeExecutionAttemptReceiptHashV1,
  normalizePageActionExecuteResponseV1,
} from '../collection/page-action-contracts.js';
import type { PageLifecycleReceiptV1 } from '../session/page-lifecycle.js';
import {
  PageRegistryError,
  ProfilePageRegistry,
  type ManagedPage,
  type ManagedPageSession,
} from './page-registry.js';
import {
  SUPERVISOR_RPC_RESPONSE_SCHEMA,
  SupervisorRpcError,
  canonicalRpcPayloadHash,
  parseTransportAuthorityV2,
  supervisorRpcOperation,
  validateRpcBinding,
  type BeginInterventionCommandV1,
  type DrainCommandV1,
  type EndInterventionCommandV1,
  type ParsedSupervisorRpcRequestV2,
  type RenewalCredentialTransportV2,
  type RestartCommandV1,
  type SupervisorRpcBindingV2,
  type SupervisorControlCredentialV2,
  type SupervisorRpcFailureV2,
  type SupervisorRpcOperation,
  type SupervisorRpcResponseV2,
  type SupervisorRpcSuccessV2,
  type VerifyInterventionCommandV1,
  type HealthProbeCommandV1,
  type RemoteAttemptAdmissionRequestV2,
  type RemoteAttemptAdmissionReceiptV2,
  type TransportAuthorityV2,
} from './supervisor-rpc.js';

export type SupervisorDaemonRuntimeState =
  | 'stopped'
  | 'starting'
  | 'warming'
  | 'warm'
  | 'draining'
  | 'intervention'
  | 'restarting'
  | 'failed';

export interface PersistentContextDescriptor {
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  contextGeneration: number;
  chromiumPid: number;
  headful: boolean;
}

export interface IdentityProbeReceipt {
  probeReceiptId: string;
  probeRevision: string;
  probedAt: string;
  expectedMemberId: string;
  observedMemberId: string | null;
  pageState: 'normal' | 'login_required' | 'risk_challenge' | 'rate_limited' | 'unreachable';
  passed: boolean;
  safeEvidenceHash: string;
}

export interface PersistentContextHost {
  ensureStarted(input: {
    profileId: string;
    profileName: string;
    daemonInstanceId: string;
    contextGeneration: number;
    headful: true;
  }): Promise<PersistentContextDescriptor>;
  createPage(): Promise<ManagedPage>;
  pages(): readonly ManagedPage[];
  pageId(page: ManagedPage): string;
  restart(input: { reason: string; nextContextGeneration: number }): Promise<PersistentContextDescriptor>;
  stop(input: { reason: string }): Promise<void>;
  probeIdentity(input: {
    expectedMemberId: string;
    probeRevision: string;
    page?: ManagedPage;
  }): Promise<IdentityProbeReceipt>;
}

export interface CredentialAuthorizationInput {
  credential: RenewalCredentialTransportV2 | SupervisorControlCredentialV2;
  operation: SupervisorRpcOperation;
  binding: SupervisorRpcBindingV2;
  canonicalPayloadHash: string;
  now: Date;
}

export interface RenewalCredentialVerifier {
  authorize(input: CredentialAuthorizationInput): Promise<void> | void;
}

export interface PageActionAcceptance {
  requestId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  pageActionPayloadHash: string;
  transportAuthority: TransportAuthorityV2;
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  acceptedAt: string;
  request: PageActionRequestV1;
  remoteAttemptStartedAt: string | null;
  remoteAttemptAdmissions: DurableRemoteAttemptAdmissionV2[];
}

export interface DurableRemoteAttemptAdmissionV2 {
  request: Omit<
    RemoteAttemptAdmissionRequestV2,
    'pageActionId' | 'pageActionExecutionAttemptId'
  >;
  receipt: RemoteAttemptAdmissionReceiptV2;
}

export type AcceptanceResult =
  | { kind: 'accepted'; acceptance: PageActionAcceptance }
  | { kind: 'in_flight'; acceptance: PageActionAcceptance }
  | { kind: 'terminal'; acceptance: PageActionAcceptance; response: PageActionExecuteResponseV1 }
  | { kind: 'conflict'; acceptance: PageActionAcceptance };

export interface PageActionAcceptanceRepository {
  accept(input: PageActionAcceptance): Promise<AcceptanceResult>;
  inspect(input: PageActionReceiptLookupV1): Promise<{
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1 | null;
  } | null>;
  recordRemoteAttemptAdmission(input: {
    acceptance: PageActionAcceptance;
    admission: DurableRemoteAttemptAdmissionV2;
  }): Promise<void>;
  lookup(input: PageActionReceiptLookupV1): Promise<PageActionExecuteResponseV1 | null>;
  complete(input: {
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1;
  }): Promise<void>;
  markCancelled(input: {
    requestId: string;
    idempotencyKey: string;
    pageActionExecutionAttemptId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<void>;
}

export interface PageActionExecutionScope {
  page: ManagedPage;
  pageSessionId: string;
  signal: AbortSignal;
  assertAuthorized(operation?: 'checkpoint' | 'terminal'): Promise<void>;
  admitRemoteAttempt(
    input: Omit<RemoteAttemptAdmissionRequestV2, 'pageActionId' | 'pageActionExecutionAttemptId'>,
  ): Promise<RemoteAttemptAdmissionReceiptV2>;
  classifyUrl(urlClass: string): Promise<void>;
  /** Requests the reason; runtime closes and receipts the Page after executor return. */
  closeOwnedPage(reason: string): Promise<void>;
}

export interface RemoteAttemptAdmissionAuthorizerV2 {
  readonly transportAuthority: TransportAuthorityV2;
  readonly parentCanonicalRequestHash: string;
  authorize(input: RemoteAttemptAdmissionRequestV2): Promise<RemoteAttemptAdmissionReceiptV2>;
}

export interface SupervisorRpcExecutionHooksV2 {
  remoteAttemptAdmission?: RemoteAttemptAdmissionAuthorizerV2;
}

export interface PageActionExecutor {
  execute(
    request: PageActionRequestV1,
    scope: PageActionExecutionScope,
  ): Promise<PageActionExecuteResponseV1>;
}

export interface SupervisorRuntimeEvent {
  eventId: string;
  profileId: string;
  daemonInstanceId: string;
  contextGeneration: number;
  type: string;
  occurredAt: string;
  detail?: Record<string, unknown>;
}

export interface SupervisorRuntimeEventSink {
  append(event: SupervisorRuntimeEvent): Promise<void> | void;
}

export const INTERVENTION_END_RECEIPT_SCHEMA =
  'profile-supervisor.intervention-end-receipt.v1' as const;

/**
 * A terminal, replayable acknowledgement for a verified intervention end.
 * The completion intent is owned by the supervisor's database transaction;
 * the daemon binds that immutable token to the exact retained Page outcome.
 */
export interface InterventionEndReceiptV1 {
  schema: typeof INTERVENTION_END_RECEIPT_SCHEMA;
  interventionSessionId: string;
  completionIntentSha256: string;
  daemonInstanceId: string;
  contextGeneration: number;
  pageSessionId: string;
  endedAt: string;
  cooldownUntil: string;
  runtimeState: 'warm';
}

export interface ProfileRecoveryState {
  cooldownUntil: string | null;
  verifiedInterventionEndReceipts: readonly InterventionEndReceiptV1[];
}

export interface ProfileRecoveryStateRepository {
  load(): Promise<ProfileRecoveryState>;
  save(input: ProfileRecoveryState & { updatedAt: string }): Promise<void>;
}

/**
 * Normalizes the durable subset of daemon recovery state before it can affect
 * runtime authority. A corrupt terminal receipt must never become a success.
 */
export function normalizeProfileRecoveryState(value: unknown): ProfileRecoveryState {
  const record = recoveryRecord(value, 'ProfileRecoveryState', [
    'cooldownUntil',
    'verifiedInterventionEndReceipts',
  ]);
  const cooldownUntil = nullableRecoveryTimestamp(
    record['cooldownUntil'],
    'recovery cooldownUntil',
  );
  const rawReceipts = record['verifiedInterventionEndReceipts'];
  if (rawReceipts === undefined) {
    return { cooldownUntil, verifiedInterventionEndReceipts: [] };
  }
  if (!Array.isArray(rawReceipts)) {
    throw recoveryStateInvalid('recovery verifiedInterventionEndReceipts must be an array.');
  }
  return {
    cooldownUntil,
    verifiedInterventionEndReceipts: rawReceipts.map((receipt, index) =>
      normalizeInterventionEndReceiptV1(receipt, `recovery receipt ${index}`),
    ),
  };
}

export function normalizeInterventionEndReceiptV1(
  value: unknown,
  path = 'InterventionEndReceipt',
): InterventionEndReceiptV1 {
  const record = recoveryRecord(value, path, [
    'schema',
    'interventionSessionId',
    'completionIntentSha256',
    'daemonInstanceId',
    'contextGeneration',
    'pageSessionId',
    'endedAt',
    'cooldownUntil',
    'runtimeState',
  ]);
  if (record['schema'] !== INTERVENTION_END_RECEIPT_SCHEMA) {
    throw recoveryStateInvalid(`${path} has an unsupported schema.`);
  }
  if (record['runtimeState'] !== 'warm') {
    throw recoveryStateInvalid(`${path} must record a warm terminal runtime state.`);
  }
  return {
    schema: INTERVENTION_END_RECEIPT_SCHEMA,
    interventionSessionId: recoveryIdentifier(
      record['interventionSessionId'],
      `${path}.interventionSessionId`,
    ),
    completionIntentSha256: recoverySha256(
      record['completionIntentSha256'],
      `${path}.completionIntentSha256`,
    ),
    daemonInstanceId: recoveryIdentifier(
      record['daemonInstanceId'],
      `${path}.daemonInstanceId`,
    ),
    contextGeneration: recoveryPositiveInteger(
      record['contextGeneration'],
      `${path}.contextGeneration`,
    ),
    pageSessionId: recoveryIdentifier(record['pageSessionId'], `${path}.pageSessionId`),
    endedAt: recoveryTimestamp(record['endedAt'], `${path}.endedAt`),
    cooldownUntil: recoveryTimestamp(record['cooldownUntil'], `${path}.cooldownUntil`),
    runtimeState: 'warm',
  };
}

export interface ProfileDaemonRuntimeOptions {
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  contextGeneration: number;
  supervisorGeneration: number;
  transportAuthority: TransportAuthorityV2;
  host: PersistentContextHost;
  credentialVerifier: RenewalCredentialVerifier;
  acceptanceRepository: PageActionAcceptanceRepository;
  executor: PageActionExecutor;
  eventSink?: SupervisorRuntimeEventSink;
  recoveryStateRepository?: ProfileRecoveryStateRepository;
  now?: () => Date;
  postRecoveryCooldownMs?: number;
  cleanupGraceMs?: number;
  interventionTransferGraceMs?: number;
  idFactory?: () => string;
}

export interface DatabaseAnchoredMonotonicClockOptions {
  databaseNow: Date;
  monotonicNow?: () => number;
}

/**
 * Projects an authoritative database timestamp with a monotonic local source.
 * Wall-clock jumps therefore cannot extend a credential or lease lifetime.
 */
export class DatabaseAnchoredMonotonicClock {
  private readonly databaseAnchorMs: number;
  private readonly monotonicAnchorMs: number;
  private readonly monotonicNow: () => number;
  private lastReturnedMs: number;

  constructor(options: DatabaseAnchoredMonotonicClockOptions) {
    const databaseAnchorMs = options.databaseNow.getTime();
    if (!Number.isFinite(databaseAnchorMs)) {
      throw new TypeError('databaseNow must be a valid Date.');
    }
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.monotonicAnchorMs = this.monotonicNow();
    this.databaseAnchorMs = databaseAnchorMs;
    this.lastReturnedMs = databaseAnchorMs;
  }

  now = (): Date => {
    const elapsed = Math.max(0, this.monotonicNow() - this.monotonicAnchorMs);
    this.lastReturnedMs = Math.max(
      this.lastReturnedMs,
      this.databaseAnchorMs + elapsed,
    );
    return new Date(this.lastReturnedMs);
  };
}

interface ActiveExecution {
  request: PageActionRequestV1;
  rpcId: string;
  authorizedRequest: ParsedSupervisorRpcRequestV2;
  abort: AbortController;
  promise: Promise<PageActionExecuteResponseV1>;
  pageSessionId: string | null;
  interventionCustodyEstablished: boolean;
  awaitingIntervention: boolean;
  pendingInterventionSessionId: string | null;
  interventionTimer: ReturnType<typeof setTimeout> | null;
  remoteAttemptAdmission: RemoteAttemptAdmissionAuthorizerV2;
  lastRemoteAttemptOrdinal: number;
  lastRemoteAttemptPurpose: RemoteAttemptAdmissionRequestV2['purpose'] | null;
}

interface ActiveIntervention {
  interventionSessionId: string;
  pageSessionId: string;
  operatorId: string;
  expiresAt: string;
  probeReceipt: IdentityProbeReceipt | null;
}

/** Direct, fenced runtime for one daemon, one Profile and one Context. */
export class ProfileDaemonRuntime {
  private state: SupervisorDaemonRuntimeState = 'stopped';
  private contextGeneration: number;
  private descriptor: PersistentContextDescriptor | null = null;
  private registry: ProfilePageRegistry;
  private active: ActiveExecution | null = null;
  private intervention: ActiveIntervention | null = null;
  private healthProbeSession: { pageSessionId: string; ownerId: string } | null = null;
  private cooldownUntil: string | null = null;
  private readonly verifiedInterventionEndReceipts = new Map<
    string,
    InterventionEndReceiptV1
  >();
  private recoveryStateLoaded = false;
  private tail: Promise<void> = Promise.resolve();
  private acceptanceTail: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly postRecoveryCooldownMs: number;
  private readonly cleanupGraceMs: number;
  private readonly interventionTransferGraceMs: number;

  constructor(private readonly options: ProfileDaemonRuntimeOptions) {
    required(options.profileId, 'profileId');
    required(options.profileName, 'profileName');
    required(options.daemonInstanceId, 'daemonInstanceId');
    positiveInteger(options.contextGeneration, 'contextGeneration');
    positiveInteger(options.supervisorGeneration, 'supervisorGeneration');
    parseTransportAuthorityV2(options.transportAuthority);
    this.contextGeneration = options.contextGeneration;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.postRecoveryCooldownMs = positiveInteger(
      options.postRecoveryCooldownMs ?? 10 * 60_000,
      'postRecoveryCooldownMs',
    );
    this.cleanupGraceMs = positiveInteger(
      options.cleanupGraceMs ?? 5_000,
      'cleanupGraceMs',
    );
    this.interventionTransferGraceMs = positiveInteger(
      options.interventionTransferGraceMs ?? 30 * 60_000,
      'interventionTransferGraceMs',
    );
    this.registry = this.newRegistry();
  }

  async ensureWarm(): Promise<ProfileDaemonStatus> {
    return this.controlSerial(async () => {
      await this.ensureRecoveryStateLoaded();
      if (this.state === 'warm') return this.status();
      if (this.state === 'intervention' || this.state === 'draining') {
        throw new SupervisorRuntimeError(
          'DAEMON_NOT_WARMABLE',
          `Daemon cannot warm while ${this.state}.`,
          true,
        );
      }
      this.state = 'starting';
      await this.event('daemon_starting');
      try {
        this.state = 'warming';
        this.descriptor = await this.options.host.ensureStarted({
          profileId: this.options.profileId,
          profileName: this.options.profileName,
          daemonInstanceId: this.options.daemonInstanceId,
          contextGeneration: this.contextGeneration,
          headful: true,
        });
        this.assertDescriptor(this.descriptor);
        if (!this.descriptor.headful) {
          throw new SupervisorRuntimeError(
            'HEADFUL_CONTEXT_REQUIRED',
            'Managed daemon Context must start headful for same-Context intervention.',
            false,
          );
        }
        // Chromium exits when its last headed Page closes. Adopt the launch
        // Page as the first health-probe Page before orphan reconciliation so
        // the PersistentContext remains alive until the Supervisor performs
        // its mandatory identity probe. Restored non-blank Pages stay orphaned
        // and are closed below.
        const launchPages = this.options.host.pages().filter((page) => !page.isClosed());
        let healthPage = launchPages.find((page) => page.url() === 'about:blank') ?? null;
        if (healthPage === null && launchPages.length > 0) {
          healthPage = await this.options.host.createPage();
        }
        if (healthPage !== null) {
          const ownerId = `health-probe-${this.idFactory()}`;
          const pageSession = await this.registry.register(healthPage, {
            pageSessionId: `page-session-${ownerId}`,
            playwrightPageId: this.options.host.pageId(healthPage),
            ownerKind: 'health_probe',
            ownerId,
            lastUrlClass: 'health_probe',
          });
          this.healthProbeSession = {
            pageSessionId: pageSession.pageSessionId,
            ownerId,
          };
        }
        const reconciled = await this.registry.reconcileContextPages(
          this.options.host.pages(),
          (page) => this.options.host.pageId(page),
        );
        if (reconciled.closeFailures !== 0) {
          throw new SupervisorRuntimeError(
            'ORPHAN_PAGE_CLEANUP_FAILED',
            'Could not close all orphan Pages during warm reconcile.',
            true,
          );
        }
        this.state = 'warm';
        await this.event('daemon_warm', { chromiumPid: this.descriptor.chromiumPid });
        return this.status();
      } catch (error) {
        this.state = 'failed';
        await this.event('daemon_warm_failed', { error: safeError(error) });
        throw error;
      }
    });
  }

  status(): ProfileDaemonStatus {
    return {
      profileId: this.options.profileId,
      profileName: this.options.profileName,
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      supervisorGeneration: this.options.supervisorGeneration,
      transportAuthority: structuredClone(this.options.transportAuthority),
      runtimeState: this.state,
      chromiumPid: this.descriptor?.chromiumPid ?? null,
      headful: this.descriptor?.headful ?? null,
      activeWorkUnitId: this.active !== null
        && !this.active.interventionCustodyEstablished
        ? this.active.request.logicalLineage.workUnitId
        : null,
      activePageSessionId: this.active?.pageSessionId ?? null,
      interventionPendingWorkUnitId: this.active?.interventionCustodyEstablished
        ? this.active.request.logicalLineage.workUnitId
        : null,
      interventionSessionId: this.intervention?.interventionSessionId ?? null,
      cooldownUntil: this.cooldownUntil,
      pageSessions: this.registry.snapshot(),
    };
  }

  async handle(
    request: ParsedSupervisorRpcRequestV2,
    hooks: SupervisorRpcExecutionHooksV2 = {},
  ): Promise<SupervisorRpcResponseV2> {
    try {
      this.validateBinding(request);
      await this.authorize(request);
      let data: unknown;
      switch (request.method) {
        case 'collector.pageAction.execute':
          data = await this.execute(
            request.payload as PageActionRequestV1,
            request,
            hooks.remoteAttemptAdmission,
          );
          break;
        case 'collector.pageAction.cancel':
          data = await this.cancel(request.payload);
          break;
        case 'collector.pageAction.lookupReceipt':
          data = await this.lookupReceipt(request.payload);
          break;
        case 'supervisor.status':
          data = this.status();
          break;
        case 'supervisor.drain':
          data = await this.drain(request.payload);
          break;
        case 'supervisor.restart':
          data = await this.restart(request.payload);
          break;
        case 'supervisor.health.probe':
          data = await this.healthProbe(request.payload);
          break;
        case 'supervisor.intervention.begin':
          data = await this.beginIntervention(request.payload);
          break;
        case 'supervisor.intervention.verify':
          data = request.payload.phase === 'final_readiness'
            ? await this.finalReadinessProbe({
                expectedMemberId: request.payload.expectedMemberId,
                probeRevision: request.payload.probeRevision,
              })
            : await this.verifyIntervention(request.payload);
          break;
        case 'supervisor.intervention.end':
          data = await this.endIntervention(request.payload);
          break;
      }
      return success(request, data);
    } catch (error) {
      return failure(request, error);
    }
  }

  async execute(
    pageAction: PageActionRequestV1,
    rpcRequest: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
    remoteAttemptAdmission?: RemoteAttemptAdmissionAuthorizerV2,
  ): Promise<PageActionExecuteResponseV1> {
    assertRemoteAttemptAdmissionPreflight(rpcRequest, remoteAttemptAdmission);
    const acceptedExecution = await this.acceptanceSerial(async () => {
      if (this.state !== 'warm') {
      throw new SupervisorRuntimeError(
        this.state === 'intervention' ? 'INTERVENTION_EXCLUSIVE' : 'DAEMON_NOT_WARM',
        `Daemon is ${this.state}; it cannot start a WorkUnit.`,
        true,
      );
      }
      if (this.cooldownUntil && this.now().getTime() < Date.parse(this.cooldownUntil)) {
      throw new SupervisorRuntimeError(
        'POST_RECOVERY_COOLDOWN',
        `Profile remains in recovery cooldown until ${this.cooldownUntil}.`,
        true,
      );
      }
      if (this.active !== null) {
      if (
        this.active.request.requestId === pageAction.requestId
        && this.active.request.idempotencyKey === pageAction.idempotencyKey
      ) {
          return { kind: 'promise' as const, promise: this.active.promise };
      }
      throw new SupervisorRuntimeError(
        'PROFILE_WORK_UNIT_BUSY',
        'Profile daemon already has an in-flight WorkUnit.',
        true,
      );
      }
      const acceptance: PageActionAcceptance = {
      requestId: pageAction.requestId,
      idempotencyKey: pageAction.idempotencyKey,
      canonicalRequestHash: canonicalRpcPayloadHash(rpcRequest),
      pageActionPayloadHash: canonicalCollectorSha256V1(pageAction).replace(/^sha256:/u, ''),
      transportAuthority: structuredClone(rpcRequest.binding.transportAuthority),
      pageActionId: pageAction.pageActionId,
      pageActionExecutionAttemptId: pageAction.pageActionExecutionAttemptId,
      acceptedAt: this.now().toISOString(),
      request: pageAction,
      remoteAttemptStartedAt: null,
      remoteAttemptAdmissions: [],
      };
      const accepted = await this.options.acceptanceRepository.accept(acceptance);
      if (accepted.kind === 'conflict') {
      throw new SupervisorRuntimeError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key is already bound to a different canonical request.',
        false,
      );
      }
      if (accepted.kind === 'terminal') {
        return { kind: 'terminal' as const, response: accepted.response };
      }
      if (accepted.kind === 'in_flight') {
        const response = interruptedExecutionAfterRestart(
          accepted.acceptance,
          this.now(),
          this.idFactory(),
        );
        await this.options.acceptanceRepository.complete({
          acceptance: accepted.acceptance,
          response,
        });
        await this.event('work_unit_interrupted_reconciled', {
          requestId: pageAction.requestId,
          pageActionExecutionAttemptId: pageAction.pageActionExecutionAttemptId,
          remoteAttemptStarted:
            accepted.acceptance.remoteAttemptStartedAt !== null,
        });
        return { kind: 'terminal' as const, response };
      }

      const abort = new AbortController();
      const active: ActiveExecution = {
        request: pageAction,
        rpcId: rpcRequest.rpcId,
        authorizedRequest: rpcRequest,
        abort,
        promise: Promise.resolve(null as never),
        pageSessionId: null,
        interventionCustodyEstablished: false,
        awaitingIntervention: false,
        pendingInterventionSessionId: null,
        interventionTimer: null,
        remoteAttemptAdmission,
        lastRemoteAttemptOrdinal: 0,
        lastRemoteAttemptPurpose: null,
      };
      const promise = this.runAcceptedExecution(acceptance, pageAction, active);
      active.promise = promise;
      this.active = active;
      return { kind: 'promise' as const, promise };
    });
    return acceptedExecution.kind === 'terminal'
      ? acceptedExecution.response
      : acceptedExecution.promise;
  }

  async renewExecution(
    parentRpcId: string,
    renewal: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
  ): Promise<void> {
    this.validateBinding(renewal);
    await this.authorize(renewal);
    const active = this.active;
    if (
      active === null
      || active.rpcId !== parentRpcId
      || active.request.requestId !== renewal.payload.requestId
      || active.request.idempotencyKey !== renewal.payload.idempotencyKey
      || canonicalCollectorSha256V1(active.request)
        !== canonicalCollectorSha256V1(renewal.payload)
      || !sameFenceIdentity(
        active.authorizedRequest.binding.supervisor,
        renewal.binding.supervisor,
      )
      || !sameFenceIdentity(
        active.authorizedRequest.binding.reservation,
        renewal.binding.reservation,
      )
      || !sameFenceIdentity(
        active.authorizedRequest.binding.workUnit,
        renewal.binding.workUnit,
      )
      || !nonRegressingFence(
        active.authorizedRequest.binding.supervisor,
        renewal.binding.supervisor,
      )
      || !nonRegressingFence(
        active.authorizedRequest.binding.reservation,
        renewal.binding.reservation,
      )
      || !nonRegressingFence(
        active.authorizedRequest.binding.workUnit,
        renewal.binding.workUnit,
      )
      || Date.parse(renewal.deadlineAt)
        < Date.parse(active.authorizedRequest.deadlineAt)
    ) {
      throw new SupervisorRuntimeError(
        'EXECUTION_RENEWAL_BINDING_MISMATCH',
        'Credential renewal does not match the active immutable execution.',
        false,
      );
    }
    active.authorizedRequest = renewal;
    await this.event('work_unit_credential_renewed', {
      requestId: active.request.requestId,
      leaseNotAfter: renewal.binding.workUnit?.leaseNotAfter,
    });
  }

  async cancel(
    input: PageActionCancelV1,
  ): Promise<{ cancelled: boolean; state: 'not_found' | 'cancelling' | 'terminal' }> {
    const pageActionExecutionAttemptId =
      input.executionLineage.pageActionExecutionAttemptId;
    if (
      this.active
      && !this.active.interventionCustodyEstablished
      && this.active.request.requestId === input.requestId
      && this.active.request.idempotencyKey === input.idempotencyKey
      && this.active.request.pageActionExecutionAttemptId
        === pageActionExecutionAttemptId
    ) {
      this.active.abort.abort();
      await this.options.acceptanceRepository.markCancelled({
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        pageActionExecutionAttemptId,
        cancelledAt: this.now().toISOString(),
        reason: input.reason,
      });
      await this.event('work_unit_cancel_requested', {
        requestId: input.requestId,
        pageActionExecutionAttemptId,
      });
      return { cancelled: true, state: 'cancelling' };
    }
    const terminal = await this.options.acceptanceRepository.lookup({
      schema: 'collector.page-action.lookup-receipt.v1',
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      pageActionId: input.pageActionId,
      pageActionExecutionAttemptId,
      logicalLineageId: input.logicalLineage.logicalLineageId,
      logicalLineageHash: input.logicalLineageHash,
      targetExecutionLineageHash: input.executionLineageHash,
      readFences: input.executionLineage.fences,
    });
    return terminal === null
      ? { cancelled: false, state: 'not_found' }
      : { cancelled: false, state: 'terminal' };
  }

  private async lookupReceipt(
    input: PageActionReceiptLookupV1,
  ): Promise<PageActionExecuteResponseV1 | null> {
    return this.acceptanceSerial(async () => {
      if (
        this.active !== null
        && this.active.request.requestId === input.requestId
        && this.active.request.idempotencyKey === input.idempotencyKey
        && this.active.request.pageActionExecutionAttemptId
          === input.pageActionExecutionAttemptId
      ) {
        return null;
      }
      const inspected = await this.options.acceptanceRepository.inspect(input);
      if (inspected === null || inspected.response !== null) {
        return inspected?.response ?? null;
      }
      const response = interruptedExecutionAfterRestart(
        inspected.acceptance,
        this.now(),
        this.idFactory(),
      );
      await this.options.acceptanceRepository.complete({
        acceptance: inspected.acceptance,
        response,
      });
      await this.event('work_unit_interrupted_reconciled', {
        requestId: inspected.acceptance.requestId,
        pageActionExecutionAttemptId:
          inspected.acceptance.pageActionExecutionAttemptId,
        source: 'receipt_lookup',
        remoteAttemptStarted:
          inspected.acceptance.remoteAttemptStartedAt !== null,
      });
      return response;
    });
  }

  async drain(command: DrainCommandV1): Promise<DrainReceipt> {
    return this.controlSerial(async () => {
      if (this.state === 'stopped') {
        return this.drainReceipt(command.reason, true);
      }
      if (this.state === 'intervention' && command.cancelInFlight) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_DRAIN_FORBIDDEN',
          'An active intervention must be explicitly ended before forced drain.',
          false,
        );
      }
      this.state = 'draining';
      await this.event('daemon_draining', { reason: command.reason });
      if (command.cancelInFlight) {
        this.active?.abort.abort();
        if (this.active?.awaitingIntervention) {
          await this.expirePendingIntervention(this.active);
        }
      }
      const deadline = Date.parse(command.deadlineAt);
      while (this.active !== null && this.now().getTime() < deadline) {
        await delay(Math.min(25, this.cleanupGraceMs));
      }
      if (this.active !== null) {
        await this.event('daemon_drain_incomplete', { closedPageCount: 0 });
        return this.drainReceipt(command.reason, false);
      }
      const pages = await this.registry.closeAll('daemon_drain');
      const clean = this.active === null
        && this.registry.activeAutomationCount() === 0
        && this.registry.activeInterventionCount() === 0
        && !this.registry.hasCleanupFailures();
      await this.event(clean ? 'daemon_drained' : 'daemon_drain_incomplete', {
        closedPageCount: pages.length,
      });
      return this.drainReceipt(command.reason, clean);
    });
  }

  async restart(command: RestartCommandV1): Promise<RestartReceipt> {
    return this.controlSerial(() => this.restartUnsafe(command));
  }

  async beginIntervention(
    command: BeginInterventionCommandV1,
  ): Promise<InterventionHandle> {
    return this.controlSerial(async () => {
      await this.ensureRecoveryStateLoaded();
      if (this.verifiedInterventionEndReceipts.has(command.interventionSessionId)) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_SESSION_TERMINAL',
          'A verified InterventionSession cannot be reused after its durable end receipt.',
          false,
        );
      }
      if (this.intervention !== null) {
        if (this.intervention.interventionSessionId === command.interventionSessionId) {
          return this.interventionHandle(this.intervention);
        }
        throw new SupervisorRuntimeError(
          'INTERVENTION_ALREADY_ACTIVE',
          'Profile already has an active InterventionSession.',
          false,
        );
      }
      if (this.state !== 'warm' || this.active === null) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_PAGE_NOT_OWNED',
          'Intervention requires the existing challenge Page of an active WorkUnit.',
          false,
        );
      }
      if (this.now().getTime() >= Date.parse(command.expiresAt)) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_EXPIRED',
          'InterventionSession has already expired.',
          false,
        );
      }
      if (
        this.active.pageSessionId !== command.pageSessionId
        || this.active.request.logicalLineage.workUnitId !== command.expectedWorkUnitId
      ) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_PAGE_NOT_OWNED',
          'Intervention command does not match the active challenge Page and WorkUnit.',
          false,
        );
      }
      if (
        this.active.interventionCustodyEstablished
        && !this.active.awaitingIntervention
      ) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_TERMINAL_NOT_COMMITTED',
          'Challenge Page custody is finalizing; terminal acceptance must commit before operator access.',
          true,
        );
      }
      const transferred = this.active.awaitingIntervention
        ? await this.registry.adoptPendingIntervention(
            command.pageSessionId,
            required(
              this.active.pendingInterventionSessionId,
              'pendingInterventionSessionId',
            ),
            command.interventionSessionId,
          )
        : await this.registry.transferToIntervention(
            command.pageSessionId,
            command.expectedWorkUnitId,
            command.interventionSessionId,
          );
      this.active.abort.abort();
      if (this.active.interventionTimer !== null) {
        clearTimeout(this.active.interventionTimer);
      }
      this.active = null;
      this.intervention = {
        interventionSessionId: command.interventionSessionId,
        pageSessionId: transferred.pageSessionId,
        operatorId: command.operatorId,
        expiresAt: command.expiresAt,
        probeReceipt: null,
      };
      this.state = 'intervention';
      await this.event('intervention_started', {
        interventionSessionId: command.interventionSessionId,
        pageSessionId: command.pageSessionId,
        operatorId: command.operatorId,
        chromiumPid: this.descriptor?.chromiumPid,
      });
      return this.interventionHandle(this.intervention);
    });
  }

  async verifyIntervention(
    command: VerifyInterventionCommandV1,
  ): Promise<IdentityProbeReceipt> {
    return this.controlSerial(async () => {
      const intervention = this.requireIntervention(command.interventionSessionId);
      if (this.now().getTime() >= Date.parse(intervention.expiresAt)) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_EXPIRED',
          'InterventionSession expired before identity verification.',
          false,
        );
      }
      const entry = this.registry.get(intervention.pageSessionId);
      if (entry === null || entry.ownerKind !== 'intervention') {
        throw new SupervisorRuntimeError(
          'INTERVENTION_PAGE_LOST',
          'Intervention no longer owns its original Page.',
          false,
        );
      }
      const page = this.options.host.pages().find(
        (candidate) => this.options.host.pageId(candidate) === entry.playwrightPageId,
      );
      if (!page) {
        throw new SupervisorRuntimeError(
          'INTERVENTION_PAGE_LOST',
          'Original challenge Page is no longer present in the Context.',
          false,
        );
      }
      const probe = await this.options.host.probeIdentity({
        expectedMemberId: command.expectedMemberId,
        probeRevision: command.probeRevision,
        page,
      });
      if (
        probe.expectedMemberId !== command.expectedMemberId
        || probe.probeRevision !== command.probeRevision
      ) {
        throw new SupervisorRuntimeError(
          'PROBE_BINDING_MISMATCH',
          'Identity probe receipt is not bound to the requested identity/revision.',
          false,
        );
      }
      intervention.probeReceipt = probe;
      await this.event(probe.passed ? 'intervention_probe_passed' : 'intervention_probe_failed', {
        interventionSessionId: command.interventionSessionId,
        probeReceiptId: probe.probeReceiptId,
        pageState: probe.pageState,
        identityMatched: probe.observedMemberId === probe.expectedMemberId,
      });
      return probe;
    });
  }

  async endIntervention(
    command: EndInterventionCommandV1,
  ): Promise<InterventionEndReceiptV1 | {
    cooldownUntil: string | null;
    runtimeState: SupervisorDaemonRuntimeState;
  }> {
    return this.controlSerial(async () => {
      await this.ensureRecoveryStateLoaded();
      if (command.reason === 'verified') {
        const completionIntentSha256 = requiredSha256(
          command.completionIntentSha256,
          'completionIntentSha256',
          'COMPLETION_INTENT_REQUIRED',
        );
        const existingReceipt = this.verifiedInterventionEndReceipts.get(
          command.interventionSessionId,
        );
        if (existingReceipt !== undefined) {
          if (existingReceipt.completionIntentSha256 !== completionIntentSha256) {
            throw new SupervisorRuntimeError(
              'COMPLETION_INTENT_MISMATCH',
              'The verified InterventionSession already ended under a different completion intent.',
              false,
            );
          }
          return structuredClone(existingReceipt);
        }
        const intervention = this.requireIntervention(command.interventionSessionId);
        if (!intervention.probeReceipt?.passed) {
          throw new SupervisorRuntimeError(
            'IDENTITY_PROBE_REQUIRED',
            'Operator completion cannot bypass a passing identity probe.',
            false,
          );
        }
        await this.registry.close(
          intervention.pageSessionId,
          {
            ownerKind: 'intervention',
            ownerId: intervention.interventionSessionId,
          },
          'intervention_verified',
        );
        const cooldownUntil = new Date(
          this.now().getTime() + this.postRecoveryCooldownMs,
        ).toISOString();
        const receipt: InterventionEndReceiptV1 = {
          schema: INTERVENTION_END_RECEIPT_SCHEMA,
          interventionSessionId: intervention.interventionSessionId,
          completionIntentSha256,
          daemonInstanceId: this.options.daemonInstanceId,
          contextGeneration: this.contextGeneration,
          pageSessionId: intervention.pageSessionId,
          endedAt: this.now().toISOString(),
          cooldownUntil,
          runtimeState: 'warm',
        };
        const nextReceipts = [
          ...this.verifiedInterventionEndReceipts.values(),
          receipt,
        ];
        await this.persistRecoveryState(cooldownUntil, nextReceipts);
        this.cooldownUntil = cooldownUntil;
        this.verifiedInterventionEndReceipts.set(
          intervention.interventionSessionId,
          receipt,
        );
        this.state = 'warm';
        this.intervention = null;
        await this.event('intervention_ended', {
          interventionSessionId: command.interventionSessionId,
          reason: command.reason,
          cooldownUntil: this.cooldownUntil,
          completionIntentSha256,
        });
        return structuredClone(receipt);
      } else {
        if (command.completionIntentSha256 !== undefined) {
          throw new SupervisorRuntimeError(
            'COMPLETION_INTENT_FORBIDDEN',
            'Only a verified intervention end can carry a completion intent.',
            false,
          );
        }
        const intervention = this.requireIntervention(command.interventionSessionId);
        await this.registry.close(
          intervention.pageSessionId,
          {
            ownerKind: 'intervention',
            ownerId: intervention.interventionSessionId,
          },
          `intervention_${command.reason}`,
        );
        this.state = 'warm';
      }
      this.intervention = null;
      await this.event('intervention_ended', {
        interventionSessionId: command.interventionSessionId,
        reason: command.reason,
        cooldownUntil: this.cooldownUntil,
      });
      return { cooldownUntil: this.cooldownUntil, runtimeState: this.state };
    });
  }

  async finalReadinessProbe(input: {
    expectedMemberId: string;
    probeRevision: string;
  }): Promise<IdentityProbeReceipt> {
    return this.controlSerial(async () => {
      if (this.cooldownUntil === null) {
        throw new SupervisorRuntimeError(
          'RECOVERY_COOLDOWN_NOT_ACTIVE',
          'No post-recovery cooldown is active.',
          false,
        );
      }
      if (this.now().getTime() < Date.parse(this.cooldownUntil)) {
        throw new SupervisorRuntimeError(
          'POST_RECOVERY_COOLDOWN',
          `Recovery cooldown remains active until ${this.cooldownUntil}.`,
          true,
        );
      }
      const page = await this.options.host.createPage();
      const ownerId = `final-readiness-${this.idFactory()}`;
      const pageSession = await this.registry.register(page, {
        pageSessionId: `page-session-${ownerId}`,
        playwrightPageId: this.options.host.pageId(page),
        ownerKind: 'health_probe',
        ownerId,
        lastUrlClass: 'readiness_probe',
      });
      try {
        const probe = await this.options.host.probeIdentity({ ...input, page });
        if (probe.passed) {
          await this.persistCooldown(null);
          this.cooldownUntil = null;
        }
        await this.event(
          probe.passed ? 'final_readiness_probe_passed' : 'final_readiness_probe_failed',
          { probeReceiptId: probe.probeReceiptId },
        );
        return probe;
      } finally {
        try {
          await this.registry.close(
            pageSession.pageSessionId,
            { ownerKind: 'health_probe', ownerId },
            'final_readiness_probe',
          );
        } catch (error) {
          await this.handleCleanupFailure(error);
        }
      }
    });
  }

  async healthProbe(input: HealthProbeCommandV1): Promise<IdentityProbeReceipt> {
    return this.controlSerial(async () => {
      if (this.state !== 'warm') {
        throw new SupervisorRuntimeError(
          'DAEMON_NOT_WARM',
          `Daemon is ${this.state}; it cannot run a health probe.`,
          true,
        );
      }
      let page: ManagedPage;
      let pageSessionId: string;
      let ownerId: string;
      if (this.healthProbeSession === null) {
        page = await this.options.host.createPage();
        ownerId = `health-probe-${this.idFactory()}`;
        const pageSession = await this.registry.register(page, {
          pageSessionId: `page-session-${ownerId}`,
          playwrightPageId: this.options.host.pageId(page),
          ownerKind: 'health_probe',
          ownerId,
          lastUrlClass: 'health_probe',
        });
        pageSessionId = pageSession.pageSessionId;
        this.healthProbeSession = { pageSessionId, ownerId };
      } else {
        ({ pageSessionId, ownerId } = this.healthProbeSession);
        const entry = this.registry.get(pageSessionId);
        page = this.options.host.pages().find(
          (candidate) => entry !== null
            && this.options.host.pageId(candidate) === entry.playwrightPageId,
        )!;
        if (entry === null || page === undefined) {
          this.healthProbeSession = null;
          throw new SupervisorRuntimeError(
            'HEALTH_PROBE_PAGE_LOST',
            'The headed health intervention Page is no longer present.',
            true,
          );
        }
      }
      try {
        const probe = await this.options.host.probeIdentity({ ...input, page });
        await this.event(
          probe.passed ? 'health_probe_passed' : 'health_probe_failed',
          {
            probeReceiptId: probe.probeReceiptId,
            pageState: probe.pageState,
            identityMatched: probe.observedMemberId === probe.expectedMemberId,
          },
        );
        // Keep the daemon-owned health Page alive after a successful probe.
        // Headed Chromium exits when its last Page closes, while WorkItem
        // Pages still have their own strictly bounded registry lifecycle.
        return probe;
      } catch (error) {
        if (this.healthProbeSession === null) throw error;
        await this.event('health_probe_error', {
          pageSessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  private async runAcceptedExecution(
    acceptance: PageActionAcceptance,
    request: PageActionRequestV1,
    active: ActiveExecution,
  ): Promise<PageActionExecuteResponseV1> {
    let pageSession: ManagedPageSession | null = null;
    let rawPage: ManagedPage | null = null;
    const attemptedPageSessionId = `page-session-${request.pageActionExecutionAttemptId}`;
    let retainForIntervention = false;
    let requestedCloseReason: string | null = null;
    let lifecycleFinalizationAttempted = false;
    let baselinePages = 0;
    try {
      await this.assertStillAuthorized(active.authorizedRequest, 'execute');
      const startNotBefore = Date.parse(request.startNotBefore);
      if (this.now().getTime() < startNotBefore) {
        throw new SupervisorRuntimeError(
          'START_SLOT_NOT_REACHED',
          `PageAction cannot start before ${request.startNotBefore}.`,
          true,
        );
      }
      baselinePages = this.registry.snapshot().filter(
        (session) => session.state !== 'closed',
      ).length;
      rawPage = await this.options.host.createPage();
      pageSession = await this.registry.register(rawPage, {
        pageSessionId: attemptedPageSessionId,
        playwrightPageId: this.options.host.pageId(rawPage),
        ownerKind: 'work_unit',
        ownerId: request.logicalLineage.workUnitId,
        taskType: taskTypeForAction(request.actionKind),
      });
      const page = rawPage;
      rawPage = null;
      active.pageSessionId = pageSession.pageSessionId;
      await this.assertStillAuthorized(active.authorizedRequest, 'execute');
      await this.event('work_unit_page_created', {
        pageSessionId: pageSession.pageSessionId,
        workUnitId: request.logicalLineage.workUnitId,
      });
      const scope: PageActionExecutionScope = {
        page,
        pageSessionId: pageSession.pageSessionId,
        signal: active.abort.signal,
        assertAuthorized: async () => {
          await this.assertStillAuthorized(active.authorizedRequest, 'execute');
        },
        admitRemoteAttempt: async (input) => {
          await this.assertStillAuthorized(active.authorizedRequest, 'execute');
          assertRemoteAttemptAdmissionInput(
            request,
            input,
            active.lastRemoteAttemptOrdinal,
            active.lastRemoteAttemptPurpose,
          );
          const receipt = await active.remoteAttemptAdmission.authorize({
            ...input,
            pageActionId: request.pageActionId,
            pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
          });
          if (
            canonicalJson(receipt.transportAuthority)
              !== canonicalJson(active.authorizedRequest.binding.transportAuthority)
            || receipt.parentCanonicalRequestHash
              !== canonicalRpcPayloadHash(active.authorizedRequest)
          ) {
            throw new SupervisorRuntimeError(
              'REMOTE_ATTEMPT_ADMISSION_RESPONSE_MISMATCH',
              'Admission receipt authority or parent request hash differs.',
              false,
            );
          }
          try {
            await this.assertStillAuthorized(active.authorizedRequest, 'execute');
            await this.options.acceptanceRepository.recordRemoteAttemptAdmission({
              acceptance,
              admission: { request: input, receipt },
            });
            await this.assertStillAuthorized(active.authorizedRequest, 'execute');
          } catch (error) {
            throw new SupervisorRuntimeError(
              'REMOTE_ATTEMPT_NOT_DISPATCHED_AFTER_ADMISSION',
              'Database admission committed, but authority was lost before the network boundary.',
              false,
              {
                admissionRequest: input,
                admissionReceipt: receipt,
                causeCode: error instanceof SupervisorRuntimeError
                  || error instanceof SupervisorRpcError
                  ? error.code
                  : 'LOCAL_MARKER_FAILED',
              },
            );
          }
          active.lastRemoteAttemptOrdinal = input.ordinal;
          active.lastRemoteAttemptPurpose = input.purpose;
          return receipt;
        },
        classifyUrl: async (urlClass) => {
          await this.registry.updateUrlClass(
            pageSession!.pageSessionId,
            { ownerKind: 'work_unit', ownerId: request.logicalLineage.workUnitId },
            urlClass,
          );
        },
        closeOwnedPage: async (reason) => {
          requestedCloseReason = reason;
        },
      };
      const candidateResponse = await this.executeBeforeCleanupBoundary(
        request,
        active,
        () => this.options.executor.execute(request, scope),
      );
      const interventionPending = responseRequiresIntervention(candidateResponse);
      let pageLifecycle: PageLifecycleReceiptV1;
      if (interventionPending) {
        lifecycleFinalizationAttempted = true;
        active.pendingInterventionSessionId = pendingInterventionSessionId(request);
        pageLifecycle = await this.transferWorkUnitPageForIntervention({
          pageSession,
          request,
          pendingInterventionSessionId: active.pendingInterventionSessionId,
          baselinePages,
        });
        active.interventionCustodyEstablished = true;
      } else {
        lifecycleFinalizationAttempted = true;
        pageLifecycle = await this.closeWorkUnitPageForTerminal({
            pageSession,
            request,
            active,
            baselinePages,
            reason: active.abort.signal.aborted
              ? 'work_unit_cancelled'
              : (requestedCloseReason ?? 'work_unit_terminal'),
          });
      }
      const response = rebindPageLifecycleReceipt(
        candidateResponse,
        pageLifecycle,
        this.now().toISOString(),
      );
      await this.assertStillAuthorized(active.authorizedRequest, 'execute');
      await this.options.acceptanceRepository.complete({ acceptance, response });
      retainForIntervention = interventionPending;
      if (retainForIntervention) {
        active.awaitingIntervention = true;
        active.interventionTimer = setTimeout(() => {
          void this.expirePendingIntervention(active);
        }, this.interventionTransferGraceMs);
        active.interventionTimer.unref();
      }
      await this.event('work_unit_terminal_receipt_committed', {
        requestId: request.requestId,
        pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
      });
      if (retainForIntervention) {
        await this.event('intervention_transfer_pending', {
          requestId: request.requestId,
          pageSessionId: pageSession.pageSessionId,
          pendingInterventionSessionId: active.pendingInterventionSessionId,
        });
      }
      return response;
    } finally {
      if (pageSession === null && rawPage !== null) {
        const recoverable = this.registry.get(attemptedPageSessionId);
        if (recoverable !== null) {
          await this.closeUncommittedExecutionPage({
            pageSessionId: attemptedPageSessionId,
            workUnitId: request.logicalLineage.workUnitId,
            pendingInterventionSessionId: null,
            reason: 'page_registration_failed',
            active,
          });
        } else if (!rawPage.isClosed()) {
          try {
            await rawPage.close();
          } catch (error) {
            await this.handleCleanupFailure(error);
          }
        }
      }
      if (
        pageSession !== null
        && !retainForIntervention
      ) {
        await this.closeUncommittedExecutionPage({
          pageSessionId: pageSession.pageSessionId,
          workUnitId: request.logicalLineage.workUnitId,
          pendingInterventionSessionId: active.pendingInterventionSessionId,
          reason: lifecycleFinalizationAttempted
            ? 'page_lifecycle_finalization_failed'
            : active.abort.signal.aborted
              ? 'work_unit_cancelled'
              : (requestedCloseReason ?? 'work_unit_terminal'),
          active,
        });
      }
      if (!retainForIntervention && this.active === active) this.active = null;
    }
  }

  private async executeBeforeCleanupBoundary<T>(
    request: PageActionRequestV1,
    active: ActiveExecution,
    execute: () => Promise<T>,
  ): Promise<T> {
    const cleanupBoundary = Math.min(
      Date.parse(request.deadlineAt),
      Date.parse(active.authorizedRequest.deadlineAt),
    ) - this.cleanupGraceMs;
    const remainingMs = cleanupBoundary - this.now().getTime();
    if (remainingMs <= 0) {
      this.state = 'draining';
      active.abort.abort();
      throw pageActionExecutionDeadlineReached();
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.state = 'draining';
        reject(pageActionExecutionDeadlineReached());
        active.abort.abort();
      }, remainingMs);
      timer.unref();
    });
    try {
      return await Promise.race([execute(), deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async transferWorkUnitPageForIntervention(input: {
    pageSession: ManagedPageSession;
    request: PageActionRequestV1;
    pendingInterventionSessionId: string;
    baselinePages: number;
  }): Promise<PageLifecycleReceiptV1> {
    let transferred: ManagedPageSession;
    try {
      transferred = await this.registry.transferToIntervention(
        input.pageSession.pageSessionId,
        input.request.logicalLineage.workUnitId,
        input.pendingInterventionSessionId,
      );
    } catch (error) {
      throw new SupervisorRuntimeError(
        'PAGE_LIFECYCLE_FINALIZATION_FAILED',
        'The challenge Page could not transfer before terminal receipt commit.',
        false,
        {
          pageSessionId: input.pageSession.pageSessionId,
          causeCode: error instanceof PageRegistryError
            ? error.code
            : 'PAGE_TRANSFER_FAILED',
        },
      );
    }
    if (
      transferred.state !== 'open'
      || transferred.ownerKind !== 'intervention'
      || transferred.ownerId !== input.pendingInterventionSessionId
      || transferred.transferredAt === null
    ) {
      throw new SupervisorRuntimeError(
        'PAGE_LIFECYCLE_FINALIZATION_FAILED',
        'Registry transfer did not produce an authoritative Intervention-owned PageSession.',
        false,
      );
    }
    return {
      baselinePages: input.baselinePages,
      createdPages: 1,
      closedPages: 0,
      transferredPages: 1,
      remainingOwnedPages: 0,
    };
  }

  private async closeUncommittedExecutionPage(input: {
    pageSessionId: string;
    workUnitId: string;
    pendingInterventionSessionId: string | null;
    reason: string;
    active: ActiveExecution;
  }): Promise<void> {
    const current = this.registry.get(input.pageSessionId);
    if (current === null || current.state === 'closed') return;
    const expected = current.ownerKind === 'work_unit'
      && current.ownerId === input.workUnitId
      ? { ownerKind: 'work_unit' as const, ownerId: input.workUnitId }
      : current.ownerKind === 'intervention'
        && current.ownerId === input.pendingInterventionSessionId
        ? { ownerKind: 'intervention' as const, ownerId: current.ownerId }
        : null;
    if (expected === null) return;
    try {
      await this.registry.close(input.pageSessionId, expected, input.reason);
    } catch (error) {
      if (!(error instanceof PageRegistryError && error.code === 'STALE_PAGE_OWNER')) {
        if (this.active === input.active) this.active = null;
        await this.handleCleanupFailure(error);
      }
    }
  }

  private async closeWorkUnitPageForTerminal(input: {
    pageSession: ManagedPageSession;
    request: PageActionRequestV1;
    active: ActiveExecution;
    baselinePages: number;
    reason: string;
  }): Promise<PageLifecycleReceiptV1> {
    let closed: ManagedPageSession;
    try {
      closed = await this.registry.close(
        input.pageSession.pageSessionId,
        {
          ownerKind: 'work_unit',
          ownerId: input.request.logicalLineage.workUnitId,
        },
        input.reason,
      );
    } catch (error) {
      if (this.active === input.active) this.active = null;
      await this.handleCleanupFailure(error);
      throw new SupervisorRuntimeError(
        'PAGE_LIFECYCLE_FINALIZATION_FAILED',
        'The owned Page could not be closed before terminal receipt commit.',
        false,
        {
          pageSessionId: input.pageSession.pageSessionId,
          causeCode: error instanceof PageRegistryError ? error.code : 'PAGE_CLEANUP_FAILED',
        },
      );
    }
    if (closed.state !== 'closed' || closed.closedAt === null) {
      throw new SupervisorRuntimeError(
        'PAGE_LIFECYCLE_FINALIZATION_FAILED',
        'Registry close did not produce an authoritative closed PageSession.',
        false,
      );
    }
    return {
      baselinePages: input.baselinePages,
      createdPages: 1,
      closedPages: 1,
      transferredPages: 0,
      remainingOwnedPages: 0,
    };
  }

  private async handleCleanupFailure(error: unknown): Promise<void> {
    this.state = 'draining';
    await this.event('page_cleanup_failed', { error: safeError(error) });
    await delay(this.cleanupGraceMs);
    await this.registry.closeAll('cleanup_retry');
    if (this.registry.hasCleanupFailures()) {
      if (this.intervention !== null) {
        this.state = 'failed';
        return;
      }
      const generation = this.contextGeneration;
      await this.restartUnsafe({
        reason: 'page_cleanup_failed',
        expectedContextGeneration: generation,
      });
    } else {
      this.state = 'warm';
    }
  }

  private async restartUnsafe(command: RestartCommandV1): Promise<RestartReceipt> {
    if (command.expectedContextGeneration !== this.contextGeneration) {
      throw new SupervisorRuntimeError(
        'STALE_CONTEXT_GENERATION',
        'Restart expected a different Context generation.',
        false,
      );
    }
    if (this.active !== null || this.intervention !== null) {
      throw new SupervisorRuntimeError(
        'DAEMON_RESTART_BUSY',
        'Drain WorkUnit and intervention owners before Context restart.',
        true,
      );
    }
    this.state = 'restarting';
    const previousContextGeneration = this.contextGeneration;
    this.contextGeneration += 1;
    this.descriptor = await this.options.host.restart({
      reason: command.reason,
      nextContextGeneration: this.contextGeneration,
    });
    this.assertDescriptor(this.descriptor);
    this.registry = this.newRegistry();
    this.state = 'warm';
    await this.event('context_restarted', {
      previousContextGeneration,
      reason: command.reason,
    });
    return {
      daemonInstanceId: this.options.daemonInstanceId,
      previousContextGeneration,
      contextGeneration: this.contextGeneration,
      chromiumPid: this.descriptor.chromiumPid,
      restartedAt: this.now().toISOString(),
    };
  }

  private validateBinding(request: ParsedSupervisorRpcRequestV2): void {
    validateRpcBinding(request, {
      profileId: this.options.profileId,
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      supervisorGeneration: this.options.supervisorGeneration,
      transportAuthority: this.options.transportAuthority,
      now: this.now(),
    });
  }

  private async authorize(request: ParsedSupervisorRpcRequestV2): Promise<void> {
    await this.options.credentialVerifier.authorize({
      credential: request.binding.renewalCredential
        ?? request.binding.controlCredential!,
      operation: supervisorRpcOperation(request.method),
      binding: request.binding,
      canonicalPayloadHash: canonicalRpcPayloadHash(request),
      now: this.now(),
    });
  }

  private async assertStillAuthorized(
    request: ParsedSupervisorRpcRequestV2,
    operation: SupervisorRpcOperation,
  ): Promise<void> {
    this.validateBinding(request);
    await this.options.credentialVerifier.authorize({
      credential: request.binding.renewalCredential
        ?? request.binding.controlCredential!,
      operation,
      binding: request.binding,
      canonicalPayloadHash: canonicalRpcPayloadHash(request),
      now: this.now(),
    });
    if (this.state !== 'warm') {
      throw new SupervisorRuntimeError(
        'DAEMON_FENCED_DURING_EXECUTION',
        `Daemon became ${this.state} during execution.`,
        true,
      );
    }
  }

  private newRegistry(): ProfilePageRegistry {
    return new ProfilePageRegistry({
      profileId: this.options.profileId,
      contextGeneration: this.contextGeneration,
      now: this.now,
      idFactory: this.idFactory,
      onEvent: async (event) => {
        await this.event(`page_${event.type}`, {
          pageSessionId: event.pageSession?.pageSessionId,
          ownerKind: event.pageSession?.ownerKind,
          detail: event.detail,
        });
      },
    });
  }

  private assertDescriptor(descriptor: PersistentContextDescriptor): void {
    if (
      descriptor.profileId !== this.options.profileId
      || descriptor.profileName !== this.options.profileName
      || descriptor.daemonInstanceId !== this.options.daemonInstanceId
      || descriptor.contextGeneration !== this.contextGeneration
      || !Number.isSafeInteger(descriptor.chromiumPid)
      || descriptor.chromiumPid <= 0
    ) {
      throw new SupervisorRuntimeError(
        'CONTEXT_DESCRIPTOR_MISMATCH',
        'Persistent Context descriptor does not match daemon ownership.',
        false,
      );
    }
  }

  private requireIntervention(interventionSessionId: string): ActiveIntervention {
    if (
      this.intervention === null
      || this.intervention.interventionSessionId !== interventionSessionId
    ) {
      throw new SupervisorRuntimeError(
        'INTERVENTION_NOT_FOUND',
        'No matching InterventionSession is active.',
        false,
      );
    }
    return this.intervention;
  }

  private interventionHandle(intervention: ActiveIntervention): InterventionHandle {
    return {
      interventionSessionId: intervention.interventionSessionId,
      profileId: this.options.profileId,
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      chromiumPid: this.descriptor?.chromiumPid ?? null,
      pageSessionId: intervention.pageSessionId,
      expiresAt: intervention.expiresAt,
    };
  }

  private drainReceipt(reason: string, clean: boolean): DrainReceipt {
    return {
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      drainedAt: this.now().toISOString(),
      reason,
      clean,
      activePageCount: this.registry.snapshot().filter((page) => page.state !== 'closed').length,
    };
  }

  private async controlSerial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acceptanceSerial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.acceptanceTail;
    let release!: () => void;
    this.acceptanceTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async expirePendingIntervention(active: ActiveExecution): Promise<void> {
    if (this.active !== active || !active.awaitingIntervention || active.pageSessionId === null) {
      return;
    }
    try {
      await this.registry.close(
        active.pageSessionId,
        {
          ownerKind: 'intervention',
          ownerId: required(
            active.pendingInterventionSessionId,
            'pendingInterventionSessionId',
          ),
        },
        'intervention_transfer_timeout',
      );
    } catch (error) {
      await this.handleCleanupFailure(error);
    } finally {
      if (this.active === active) this.active = null;
      await this.event('intervention_transfer_expired', {
        requestId: active.request.requestId,
        pageSessionId: active.pageSessionId,
      });
    }
  }

  private async event(type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.options.eventSink?.append({
      eventId: this.idFactory(),
      profileId: this.options.profileId,
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      type,
      occurredAt: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private async ensureRecoveryStateLoaded(): Promise<void> {
    if (this.recoveryStateLoaded) return;
    const persisted = await this.options.recoveryStateRepository?.load();
    const normalized = normalizeProfileRecoveryState(
      persisted ?? {
        cooldownUntil: null,
        verifiedInterventionEndReceipts: [],
      },
    );
    this.cooldownUntil = normalized.cooldownUntil;
    this.verifiedInterventionEndReceipts.clear();
    normalized.verifiedInterventionEndReceipts.forEach((receipt) => {
      if (this.verifiedInterventionEndReceipts.has(receipt.interventionSessionId)) {
        throw new SupervisorRuntimeError(
          'RECOVERY_STATE_INVALID',
          'Recovery state contains duplicate verified InterventionSession receipts.',
          false,
        );
      }
      this.verifiedInterventionEndReceipts.set(
        receipt.interventionSessionId,
        structuredClone(receipt),
      );
    });
    this.recoveryStateLoaded = true;
  }

  private async persistCooldown(cooldownUntil: string | null): Promise<void> {
    await this.persistRecoveryState(
      cooldownUntil,
      [...this.verifiedInterventionEndReceipts.values()],
    );
  }

  private async persistRecoveryState(
    cooldownUntil: string | null,
    verifiedInterventionEndReceipts: readonly InterventionEndReceiptV1[],
  ): Promise<void> {
    await this.options.recoveryStateRepository?.save({
      cooldownUntil,
      verifiedInterventionEndReceipts: verifiedInterventionEndReceipts.map(
        (receipt) => structuredClone(receipt),
      ),
      updatedAt: this.now().toISOString(),
    });
  }
}

export interface ProfileDaemonStatus {
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  contextGeneration: number;
  supervisorGeneration: number;
  transportAuthority: TransportAuthorityV2;
  runtimeState: SupervisorDaemonRuntimeState;
  chromiumPid: number | null;
  headful: boolean | null;
  activeWorkUnitId: string | null;
  activePageSessionId: string | null;
  interventionPendingWorkUnitId: string | null;
  interventionSessionId: string | null;
  cooldownUntil: string | null;
  pageSessions: readonly ManagedPageSession[];
}

export interface DrainReceipt {
  daemonInstanceId: string;
  contextGeneration: number;
  drainedAt: string;
  reason: string;
  clean: boolean;
  activePageCount: number;
}

export interface RestartReceipt {
  daemonInstanceId: string;
  previousContextGeneration: number;
  contextGeneration: number;
  chromiumPid: number;
  restartedAt: string;
}

export interface InterventionHandle {
  interventionSessionId: string;
  profileId: string;
  daemonInstanceId: string;
  contextGeneration: number;
  chromiumPid: number | null;
  pageSessionId: string;
  expiresAt: string;
}

export class SupervisorRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SupervisorRuntimeError';
  }
}

export class HmacRenewalCredentialVerifier implements RenewalCredentialVerifier {
  constructor(
    private readonly keys: Readonly<Record<string, string | Buffer>>,
    private readonly options: { maxClockSkewMs?: number } = {},
  ) {}

  authorize(input: CredentialAuthorizationInput): void {
    const { credential } = input;
    const key = this.keys[credential.payload.keyId];
    if (key === undefined) {
      throw new SupervisorRuntimeError('CREDENTIAL_KEY_UNKNOWN', 'Credential key is unknown.', false);
    }
    const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');
    if (keyBytes.byteLength < 32) {
      throw new SupervisorRuntimeError(
        'CREDENTIAL_KEY_WEAK',
        'Credential HMAC key must contain at least 32 bytes.',
        false,
      );
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential.signature)) {
      throw new SupervisorRuntimeError(
        'CREDENTIAL_SIGNATURE_INVALID',
        'Credential signature is not canonical base64url SHA-256.',
        false,
      );
    }
    const readOnly = input.operation === 'lookup_receipt' || input.operation === 'status';
    assertCredentialTimeline(credential, readOnly);
    const expected = createHmac('sha256', key)
      .update(canonicalCredentialPayload(credential))
      .digest('base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    const actualBuffer = Buffer.from(credential.signature, 'base64url');
    if (
      actualBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new SupervisorRuntimeError('CREDENTIAL_SIGNATURE_INVALID', 'Credential signature is invalid.', false);
    }
    if (credential.payload.canonicalRequestHash !== input.canonicalPayloadHash) {
      throw new SupervisorRuntimeError('CREDENTIAL_REQUEST_MISMATCH', 'Credential request hash differs.', false);
    }
    assertFenceDigest(
      credential.payload.supervisorFenceDigest,
      input.binding.supervisor,
      'supervisor',
    );
    if ('workUnitLeaseId' in credential.payload) {
      assertNullableFenceDigest(
        credential.payload.reservationFenceDigest,
        input.binding.reservation,
        'reservation',
      );
      assertNullableFenceDigest(
        credential.payload.workUnitFenceDigest,
        input.binding.workUnit,
        'workUnit',
      );
    }
    const now = input.now.getTime();
    const skew = this.options.maxClockSkewMs ?? 1_000;
    if (now + skew < Date.parse(credential.payload.credentialNotBefore)) {
      throw new SupervisorRuntimeError('CREDENTIAL_NOT_YET_VALID', 'Credential is not yet valid.', true);
    }
    if (
      !readOnly
      && now >= Math.min(
        Date.parse(credential.payload.credentialExpiresAt),
        'leaseNotAfter' in credential.payload
          ? Date.parse(credential.payload.leaseNotAfter)
          : Date.parse(credential.payload.credentialExpiresAt),
      )
    ) {
      throw new SupervisorRuntimeError('CREDENTIAL_EXPIRED', 'Credential has expired.', true);
    }
  }
}

export class InMemoryPageActionAcceptanceRepository
implements PageActionAcceptanceRepository {
  private readonly rows = new Map<string, {
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1 | null;
    cancelledAt: string | null;
  }>();

  async accept(input: PageActionAcceptance): Promise<AcceptanceResult> {
    const key = acceptanceKey(input.requestId, input.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) {
      if (
        existing.acceptance.canonicalRequestHash !== input.canonicalRequestHash
        || existing.acceptance.pageActionPayloadHash !== input.pageActionPayloadHash
        || canonicalJson(existing.acceptance.transportAuthority)
          !== canonicalJson(input.transportAuthority)
        || existing.acceptance.pageActionId !== input.pageActionId
        || existing.acceptance.pageActionExecutionAttemptId
          !== input.pageActionExecutionAttemptId
      ) {
        return { kind: 'conflict', acceptance: structuredClone(existing.acceptance) };
      }
      return existing.response
        ? {
            kind: 'terminal',
            acceptance: structuredClone(existing.acceptance),
            response: structuredClone(existing.response),
          }
        : { kind: 'in_flight', acceptance: structuredClone(existing.acceptance) };
    }
    this.rows.set(key, {
      acceptance: structuredClone(input), response: null, cancelledAt: null,
    });
    return { kind: 'accepted', acceptance: structuredClone(input) };
  }

  async lookup(input: PageActionReceiptLookupV1): Promise<PageActionExecuteResponseV1 | null> {
    return (await this.inspect(input))?.response ?? null;
  }

  async inspect(input: PageActionReceiptLookupV1): Promise<{
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1 | null;
  } | null> {
    const row = this.rows.get(acceptanceKey(input.requestId, input.idempotencyKey));
    if (!row) return null;
    if (
      row.acceptance.pageActionExecutionAttemptId
        !== input.pageActionExecutionAttemptId
      || (input.pageActionId.length > 0 && row.acceptance.pageActionId !== input.pageActionId)
      || row.acceptance.request.logicalLineage.logicalLineageId
        !== input.logicalLineageId
      || row.acceptance.request.logicalLineageHash !== input.logicalLineageHash
      || row.acceptance.request.executionLineageHash
        !== input.targetExecutionLineageHash
    ) {
      return null;
    }
    return {
      acceptance: structuredClone(row.acceptance),
      response: row.response === null ? null : structuredClone(row.response),
    };
  }

  async recordRemoteAttemptAdmission(input: {
    acceptance: PageActionAcceptance;
    admission: DurableRemoteAttemptAdmissionV2;
  }): Promise<void> {
    const row = this.rows.get(acceptanceKey(
      input.acceptance.requestId,
      input.acceptance.idempotencyKey,
    ));
    if (!row || row.acceptance.canonicalRequestHash !== input.acceptance.canonicalRequestHash) {
      throw new SupervisorRuntimeError(
        'ACCEPTANCE_NOT_CURRENT',
        'Remote attempt cannot start without its current durable acceptance.',
        false,
      );
    }
    const admissions = row.acceptance.remoteAttemptAdmissions;
    const existing = admissions.find(
      (admission) => admission.request.ordinal === input.admission.request.ordinal,
    );
    if (existing !== undefined) {
      if (!sameDurableRemoteAdmission(existing, input.admission)) {
        throw new SupervisorRuntimeError(
          'REMOTE_ATTEMPT_ADMISSION_CONFLICT',
          'A durable remote-attempt ordinal is already bound to another admission.',
          false,
        );
      }
      return;
    }
    if (input.admission.request.ordinal !== admissions.length + 1) {
      throw new SupervisorRuntimeError(
        'REMOTE_ATTEMPT_ADMISSION_GAP',
        'Durable remote-attempt admissions must have contiguous ordinals.',
        false,
      );
    }
    admissions.push(structuredClone(input.admission));
    row.acceptance.remoteAttemptStartedAt ??= input.admission.receipt.admittedAt;
  }

  async complete(input: {
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1;
  }): Promise<void> {
    const key = acceptanceKey(
      input.acceptance.requestId,
      input.acceptance.idempotencyKey,
    );
    const row = this.rows.get(key);
    if (!row || row.acceptance.canonicalRequestHash !== input.acceptance.canonicalRequestHash) {
      throw new SupervisorRuntimeError(
        'ACCEPTANCE_NOT_CURRENT',
        'Terminal receipt cannot be committed without its current acceptance.',
        false,
      );
    }
    if (row.response !== null && row.response !== input.response) {
      throw new SupervisorRuntimeError(
        'TERMINAL_RECEIPT_IMMUTABLE',
        'A terminal execution receipt cannot be replaced.',
        false,
      );
    }
    row.response = input.response;
  }

  async markCancelled(input: {
    requestId: string;
    idempotencyKey: string;
    pageActionExecutionAttemptId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<void> {
    const row = this.rows.get(acceptanceKey(input.requestId, input.idempotencyKey));
    if (
      row
      && row.acceptance.pageActionExecutionAttemptId
        === input.pageActionExecutionAttemptId
    ) {
      row.cancelledAt = input.cancelledAt;
    }
  }
}

export function signRenewalCredentialTransport(
  credential: Omit<RenewalCredentialTransportV2, 'signature'>,
  key: string | Buffer,
): RenewalCredentialTransportV2 {
  return {
    ...credential,
    signature: createHmac('sha256', key)
      .update(canonicalCredentialPayload(credential))
      .digest('base64url'),
  };
}

export function signSupervisorControlCredential(
  credential: Omit<SupervisorControlCredentialV2, 'signature'>,
  key: string | Buffer,
): SupervisorControlCredentialV2 {
  return {
    ...credential,
    signature: createHmac('sha256', key)
      .update(canonicalCredentialPayload(credential))
      .digest('base64url'),
  };
}

export function fenceDigest(fence: SupervisorRpcBindingV2['supervisor']): string {
  return createHash('sha256').update(fence.fencingToken, 'utf8').digest('hex');
}

function success<T>(request: ParsedSupervisorRpcRequestV2, data: T): SupervisorRpcSuccessV2<T> {
  return {
    schema: SUPERVISOR_RPC_RESPONSE_SCHEMA,
    rpcId: request.rpcId,
    canonicalRequestHash: canonicalRpcPayloadHash(request),
    ok: true,
    data,
  };
}

function failure(
  request: ParsedSupervisorRpcRequestV2,
  error: unknown,
): SupervisorRpcFailureV2 {
  if (
    error instanceof SupervisorRuntimeError
    || error instanceof SupervisorRpcError
    || error instanceof PageRegistryError
  ) {
    return {
      schema: SUPERVISOR_RPC_RESPONSE_SCHEMA,
      rpcId: request.rpcId,
      canonicalRequestHash: canonicalRpcPayloadHash(request),
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: 'retryable' in error ? Boolean(error.retryable) : false,
        ...('details' in error && error.details !== undefined
          ? { details: error.details as Record<string, unknown> }
          : {}),
      },
    };
  }
  return {
    schema: SUPERVISOR_RPC_RESPONSE_SCHEMA,
    rpcId: request.rpcId,
    canonicalRequestHash: canonicalRpcPayloadHash(request),
    ok: false,
    error: {
      code: 'SUPERVISOR_INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown supervisor error.',
      retryable: true,
    },
  };
}

function taskTypeForAction(actionKind: PageActionRequestV1['actionKind']): string {
  switch (actionKind) {
    case 'search-list': return 'SEARCH_DISCOVERY';
    case 'offer-detail': return 'OFFER_DETAIL';
    case 'store-qualification': return 'STORE_QUALIFICATION';
    case 'store-sample': return 'STORE_CATALOG_SAMPLE';
  }
}

function pendingInterventionSessionId(request: PageActionRequestV1): string {
  return `pending-intervention-${request.pageActionExecutionAttemptId}`;
}

function responseRequiresIntervention(response: PageActionExecuteResponseV1): boolean {
  const error = response.executionAttemptReceipt.error;
  return error?.code === 'IDENTITY_MISMATCH'
    || error?.category === 'authentication'
    || error?.category === 'risk-control';
}

function rebindPageLifecycleReceipt(
  response: PageActionExecuteResponseV1,
  pageLifecycle: PageLifecycleReceiptV1,
  lifecycleFinalizedAt: string,
): PageActionExecuteResponseV1 {
  const execution = response.executionAttemptReceipt;
  const { receiptHash: previousReceiptHash, ...previousExecutionContent } = execution;
  const executionContent = {
    ...previousExecutionContent,
    pageLifecycle: structuredClone(pageLifecycle),
    metrics: {
      ...previousExecutionContent.metrics,
      pageLifecycleFinalizedAtMs: Date.parse(lifecycleFinalizedAt),
    },
  };
  const reboundExecution = {
    ...executionContent,
    receiptHash: computeExecutionAttemptReceiptHashV1(executionContent),
  };
  if (response.completionReceipt === undefined) {
    return normalizePageActionExecuteResponseV1({
      executionAttemptReceipt: reboundExecution,
    });
  }

  let reboundRefCount = 0;
  const reboundRefs = response.completionReceipt.executionAttemptReceiptRefs.map((ref) => {
    if (
      ref.receiptId !== execution.receiptId
      || ref.receiptHash !== previousReceiptHash
      || ref.pageActionExecutionAttemptId !== execution.pageActionExecutionAttemptId
    ) {
      return structuredClone(ref);
    }
    reboundRefCount += 1;
    return { ...structuredClone(ref), receiptHash: reboundExecution.receiptHash };
  });
  if (reboundRefCount !== 1) {
    throw new SupervisorRuntimeError(
      'PAGE_LIFECYCLE_RECEIPT_REBIND_FAILED',
      'Completion receipt does not contain exactly one current execution reference.',
      false,
    );
  }
  const finalizedByExecutionRef = response.completionReceipt.finalizedByExecutionRef;
  const reboundFinalizedRef = finalizedByExecutionRef === undefined
    ? undefined
    : finalizedByExecutionRef.receiptId === execution.receiptId
      && finalizedByExecutionRef.receiptHash === previousReceiptHash
      ? { ...structuredClone(finalizedByExecutionRef), receiptHash: reboundExecution.receiptHash }
      : structuredClone(finalizedByExecutionRef);
  const {
    completionReceiptHash: _previousCompletionHash,
    finalizedByExecutionRef: _previousFinalizedRef,
    ...previousCompletionContent
  } = response.completionReceipt;
  const completedAt = completionTimestampFromBatches(
    response.completionReceipt.batches,
  );
  if (Date.parse(lifecycleFinalizedAt) < Date.parse(completedAt)) {
    throw new SupervisorRuntimeError(
      'PAGE_LIFECYCLE_PRECEDES_BATCH_COMPLETION',
      'Managed Page lifecycle finalized before its immutable Batch completion evidence.',
      false,
    );
  }
  const completionContent = {
    ...previousCompletionContent,
    completedAt,
    executionAttemptReceiptRefs: reboundRefs as [
      typeof reboundRefs[number],
      ...Array<typeof reboundRefs[number]>
    ],
    ...(reboundFinalizedRef === undefined
      ? {}
      : { finalizedByExecutionRef: reboundFinalizedRef }),
  };
  const reboundCompletion = {
    ...completionContent,
    completionReceiptHash: computeCompletionReceiptHashV1(completionContent),
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: reboundExecution,
    completionReceipt: reboundCompletion,
  });
}

function completionTimestampFromBatches(
  batches: readonly { completedAt: string }[],
): string {
  let latest: number | null = null;
  for (const batch of batches) {
    const completedAt = Date.parse(batch.completedAt);
    if (!Number.isFinite(completedAt)) {
      throw new SupervisorRuntimeError(
        'PAGE_ACTION_BATCH_COMPLETION_INVALID',
        'Managed PageAction completion contains an invalid Batch completion timestamp.',
        false,
      );
    }
    latest = latest === null ? completedAt : Math.max(latest, completedAt);
  }
  if (latest === null) {
    throw new SupervisorRuntimeError(
      'PAGE_ACTION_BATCH_COMPLETION_MISSING',
      'Managed PageAction completion requires immutable Batch evidence.',
      false,
    );
  }
  return new Date(latest).toISOString();
}

function sameFenceIdentity(left: LeaseFenceV1 | null, right: LeaseFenceV1 | null): boolean {
  if (left === null || right === null) return left === right;
  return left.leaseId === right.leaseId
    && left.generation === right.generation
    && left.fencingToken === right.fencingToken;
}

function nonRegressingFence(previous: LeaseFenceV1 | null, current: LeaseFenceV1 | null): boolean {
  if (previous === null || current === null) return previous === current;
  return Date.parse(current.leaseNotAfter) >= Date.parse(previous.leaseNotAfter);
}

function assertFenceDigest(
  digest: string,
  fence: SupervisorRpcBindingV2['supervisor'],
  name: string,
): void {
  if (digest !== fenceDigest(fence)) {
    throw new SupervisorRuntimeError(
      'CREDENTIAL_FENCE_MISMATCH',
      `Credential ${name} fence digest differs.`,
      false,
    );
  }
}

function assertNullableFenceDigest(
  digest: string | null,
  fence: SupervisorRpcBindingV2['reservation'],
  name: string,
): void {
  if (fence === null) {
    if (digest !== null) {
      throw new SupervisorRuntimeError(
        'CREDENTIAL_FENCE_MISMATCH',
        `Credential ${name} fence must be null.`,
        false,
      );
    }
    return;
  }
  if (digest === null) {
    throw new SupervisorRuntimeError(
      'CREDENTIAL_FENCE_MISMATCH',
      `Credential ${name} fence digest is missing.`,
      false,
    );
  }
  assertFenceDigest(digest, fence, name);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function canonicalCredentialPayload(
  credential:
    | RenewalCredentialTransportV2
    | SupervisorControlCredentialV2
    | Omit<RenewalCredentialTransportV2, 'signature'>
    | Omit<SupervisorControlCredentialV2, 'signature'>,
): string {
  const payload = credential.payload;
  if ('workUnitLeaseId' in payload) {
    // This order is the frozen @vs1/domain canonicalRenewalCredentialPayload.
    return JSON.stringify({
      schemaVersion: payload.schemaVersion,
      profileId: payload.profileId,
      daemonInstanceId: payload.daemonInstanceId,
      contextGeneration: payload.contextGeneration,
      supervisorLeaseId: payload.supervisorLeaseId,
      supervisorGeneration: payload.supervisorGeneration,
      supervisorFenceDigest: payload.supervisorFenceDigest,
      reservationLeaseId: payload.reservationLeaseId,
      reservationGeneration: payload.reservationGeneration,
      reservationFenceDigest: payload.reservationFenceDigest,
      workUnitLeaseId: payload.workUnitLeaseId,
      workUnitGeneration: payload.workUnitGeneration,
      workUnitFenceDigest: payload.workUnitFenceDigest,
      requestId: payload.requestId,
      canonicalRequestHash: payload.canonicalRequestHash,
      requestDeadlineAt: payload.requestDeadlineAt,
      idempotencyKey: payload.idempotencyKey,
      issuedAt: payload.issuedAt,
      credentialNotBefore: payload.credentialNotBefore,
      credentialExpiresAt: payload.credentialExpiresAt,
      leaseNotAfter: payload.leaseNotAfter,
      keyId: payload.keyId,
    });
  }
  return canonicalJson(payload);
}

function assertCredentialTimeline(
  credential: RenewalCredentialTransportV2 | SupervisorControlCredentialV2,
  readOnly = false,
): void {
  const payload = credential.payload;
  const issuedAt = Date.parse(payload.issuedAt);
  const notBefore = Date.parse(payload.credentialNotBefore);
  const expiresAt = Date.parse(payload.credentialExpiresAt);
  const requestDeadline = Date.parse(payload.requestDeadlineAt);
  const leaseNotAfter = 'leaseNotAfter' in payload
    ? Date.parse(payload.leaseNotAfter)
    : Number.POSITIVE_INFINITY;
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(notBefore)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(requestDeadline)
    || issuedAt > notBefore
    || notBefore >= expiresAt
    || expiresAt > leaseNotAfter
    || (!readOnly && requestDeadline > leaseNotAfter)
  ) {
    throw new SupervisorRuntimeError(
      'CREDENTIAL_TIMELINE_INVALID',
      'Credential validity and request/lease boundaries are inconsistent.',
      false,
    );
  }
}

function assertRemoteAttemptAdmissionInput(
  request: PageActionRequestV1,
  input: Omit<RemoteAttemptAdmissionRequestV2, 'pageActionId' | 'pageActionExecutionAttemptId'>,
  lastOrdinal: number,
  lastPurpose: RemoteAttemptAdmissionRequestV2['purpose'] | null = null,
): void {
  const expectedOrdinal = lastOrdinal + 1;
  const expectedId = `remote-${request.pageActionExecutionAttemptId}-${input.ordinal}`;
  const logicalPageRequired = request.actionKind === 'search-list'
    || request.actionKind === 'store-sample';
  const allowedPurposes = request.actionKind === 'search-list'
    ? ['forward', 'replay']
    : request.actionKind === 'store-sample'
      ? ['discovery', 'forward']
      : request.actionKind === 'store-qualification'
        ? ['discovery', 'single-target']
      : ['single-target'];
  const requiresDiscoveryPhase = request.actionKind === 'store-qualification'
    || request.actionKind === 'store-sample';
  const terminalPurpose = request.actionKind === 'store-qualification'
    ? 'single-target'
    : request.actionKind === 'store-sample'
      ? 'forward'
      : null;
  const phaseValid = !requiresDiscoveryPhase
    || (
      input.purpose === 'discovery'
        ? lastPurpose === null || lastPurpose === 'discovery'
        : input.purpose === terminalPurpose
          && (lastPurpose === 'discovery' || lastPurpose === terminalPurpose)
    );
  if (
    input.ordinal !== expectedOrdinal
    || input.remoteRequestAttemptId !== expectedId
    || !/^sha256:[0-9a-f]{64}$/u.test(input.requestBusinessHash)
    || !allowedPurposes.includes(input.purpose)
    || (logicalPageRequired
      ? !Number.isSafeInteger(input.logicalPage) || Number(input.logicalPage) <= 0
      : input.logicalPage !== undefined)
    || !phaseValid
  ) {
    throw new SupervisorRuntimeError(
      'REMOTE_ATTEMPT_ADMISSION_INVALID',
      'Remote-attempt admission is not the next canonical request for this PageAction execution.',
      false,
    );
  }
}

function assertRemoteAttemptAdmissionPreflight(
  request: ParsedSupervisorRpcRequestV2 & { method: 'collector.pageAction.execute' },
  admission: RemoteAttemptAdmissionAuthorizerV2 | undefined,
): asserts admission is RemoteAttemptAdmissionAuthorizerV2 {
  if (admission === undefined || typeof admission.authorize !== 'function') {
    throw new SupervisorRuntimeError(
      'REMOTE_ATTEMPT_ADMISSION_CHANNEL_REQUIRED',
      'PageAction execution requires a bound remote-attempt admission channel.',
      false,
    );
  }
  if (
    canonicalJson(admission.transportAuthority)
      !== canonicalJson(request.binding.transportAuthority)
    || admission.parentCanonicalRequestHash !== canonicalRpcPayloadHash(request)
  ) {
    throw new SupervisorRuntimeError(
      'REMOTE_ATTEMPT_ADMISSION_BINDING_MISMATCH',
      'Remote-attempt admission channel authority differs from the execute request.',
      false,
    );
  }
}

function acceptanceKey(requestId: string, idempotencyKey: string): string {
  return `${requestId}\u0000${idempotencyKey}`;
}

function sameDurableRemoteAdmission(
  left: DurableRemoteAttemptAdmissionV2,
  right: DurableRemoteAttemptAdmissionV2,
): boolean {
  return left.request.remoteRequestAttemptId === right.request.remoteRequestAttemptId
    && left.request.ordinal === right.request.ordinal
    && left.request.logicalPage === right.request.logicalPage
    && left.request.purpose === right.request.purpose
    && left.request.requestBusinessHash === right.request.requestBusinessHash
    && left.receipt.remoteActionStartId === right.receipt.remoteActionStartId
    && left.receipt.admittedAt === right.receipt.admittedAt
    && left.receipt.parentCanonicalRequestHash
      === right.receipt.parentCanonicalRequestHash
    && canonicalJson(left.receipt.transportAuthority)
      === canonicalJson(right.receipt.transportAuthority);
}

function acceptedRequest(acceptance: PageActionAcceptance): PageActionRequestV1 {
  const request = acceptance.request;
  if (
    request === null
    || typeof request !== 'object'
  ) {
    throw new SupervisorRuntimeError(
      'ACCEPTANCE_JOURNAL_INVALID',
      'Durable acceptance does not contain its immutable PageAction request.',
      false,
    );
  }
  const canonicalHash = canonicalCollectorSha256V1(request).replace(/^sha256:/u, '');
  if (
    request.requestId !== acceptance.requestId
    || request.idempotencyKey !== acceptance.idempotencyKey
    || request.pageActionId !== acceptance.pageActionId
    || request.pageActionExecutionAttemptId
      !== acceptance.pageActionExecutionAttemptId
    || canonicalHash !== acceptance.pageActionPayloadHash
  ) {
    throw new SupervisorRuntimeError(
      'ACCEPTANCE_JOURNAL_INVALID',
      'Durable acceptance request does not match its immutable acceptance binding.',
      false,
    );
  }
  return request;
}

function interruptedExecutionAfterRestart(
  acceptance: PageActionAcceptance,
  reconciledAt: Date,
  receiptId: string,
): PageActionExecuteResponseV1 {
  const request = acceptedRequest(acceptance);
  const admissions = durableAdmissionsForRestart(acceptance, request);
  const remoteAttemptStarted = admissions.length > 0;
  const errorCode = remoteAttemptStarted
    ? 'EXECUTION_OUTCOME_UNKNOWN'
    : 'EXECUTION_NOT_DISPATCHED';
  const remoteRequestAttempts = admissions.map(({ request: admission, receipt }) => ({
    remoteRequestAttemptId: admission.remoteRequestAttemptId,
    ordinal: admission.ordinal,
    ...(admission.logicalPage === undefined ? {} : { logicalPage: admission.logicalPage }),
    purpose: admission.purpose,
    requestBusinessHash: admission.requestBusinessHash,
    startedAt: receipt.admittedAt,
    completedAt: new Date(Math.max(
      Date.parse(receipt.admittedAt),
      reconciledAt.getTime(),
    )).toISOString(),
    status: 'failed' as const,
    rawEvidenceRefs: [],
    error: {
      code: 'REMOTE_ATTEMPT_OUTCOME_UNKNOWN',
      category: 'protocol' as const,
      retryable: false,
      actionRequired: null,
      recoveryAction: 'manual-reconcile-before-any-replacement-attempt',
    },
  }));
  const subjectHash = canonicalCollectorSha256V1(
    request.logicalLineage.businessSubject,
  );
  const requestSnapshots = admissions.map(({ request: admission, receipt }) => ({
    api: 'profile-daemon-page-action',
    componentKey: request.actionKind,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    remoteRequestAttemptId: admission.remoteRequestAttemptId,
    purpose: admission.purpose,
    subjectHash,
    ...(admission.logicalPage === undefined ? {} : { page: admission.logicalPage }),
    requestBusinessHash: admission.requestBusinessHash,
    observedAt: receipt.admittedAt,
  }));
  const content = {
    schema: PAGE_ACTION_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `execution-receipt-recovery-${receiptId}`,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    pageActionId: request.pageActionId,
    pageActionExecutionAttemptId: request.pageActionExecutionAttemptId,
    executionAttemptOrdinal: request.executionAttemptOrdinal,
    ...(request.predecessorExecutionAttemptReceipt === undefined
      ? {}
      : { predecessorExecutionAttemptReceipt: request.predecessorExecutionAttemptReceipt }),
    pageActionBusinessHash: request.pageActionBusinessHash,
    logicalLineage: request.logicalLineage,
    logicalLineageHash: request.logicalLineageHash,
    executionLineage: request.executionLineage,
    executionLineageHash: request.executionLineageHash,
    outcome: 'failed' as const,
    terminal: true as const,
    actionKind: request.actionKind,
    remoteRequestAttempts,
    batches: [],
    requestSnapshots,
    pageLifecycle: {
      baselinePages: 0,
      createdPages: 0,
      closedPages: 0,
      transferredPages: 0,
      remainingOwnedPages: 0 as const,
    },
    metrics: {
      reconciledAfterDaemonRestart: 1,
      reconciledAtMs: reconciledAt.getTime(),
      remoteAttemptStarted: remoteAttemptStarted ? 1 : 0,
      remoteAttemptsOutcomeUnknown: admissions.length,
    },
    error: {
      code: errorCode,
      category: 'protocol' as const,
      retryable: !remoteAttemptStarted,
      actionRequired: null,
      recoveryAction: remoteAttemptStarted
        ? 'manual-reconcile-before-any-replacement-attempt'
        : 'retry-with-new-execution-attempt',
    },
  };
  return normalizePageActionExecuteResponseV1({
    executionAttemptReceipt: {
      ...content,
      receiptHash: computeExecutionAttemptReceiptHashV1(content),
    },
  });
}

function durableAdmissionsForRestart(
  acceptance: PageActionAcceptance,
  request: PageActionRequestV1,
): DurableRemoteAttemptAdmissionV2[] {
  const admissions = acceptance.remoteAttemptAdmissions ?? [];
  if (acceptance.remoteAttemptStartedAt !== null && admissions.length === 0) {
    throw new SupervisorRuntimeError(
      'REMOTE_ATTEMPT_ADMISSION_JOURNAL_UNRESOLVED',
      'A legacy remote-attempt marker lacks exact admission tuples; authoritative database reconciliation is required.',
      false,
    );
  }
  if (acceptance.remoteAttemptStartedAt === null && admissions.length > 0) {
    throw new SupervisorRuntimeError(
      'ACCEPTANCE_JOURNAL_INVALID',
      'Exact remote-attempt admissions exist without their durable first-start marker.',
      false,
    );
  }
  const remoteActionStartIds = new Set<string>();
  let priorPurpose: RemoteAttemptAdmissionRequestV2['purpose'] | null = null;
  admissions.forEach((admission, index) => {
    assertRemoteAttemptAdmissionInput(
      request,
      admission.request,
      index,
      priorPurpose,
    );
    priorPurpose = admission.request.purpose;
    if (
      admission.receipt.remoteActionStartId.trim().length === 0
      || !Number.isFinite(Date.parse(admission.receipt.admittedAt))
      || canonicalJson(admission.receipt.transportAuthority)
        !== canonicalJson(acceptance.transportAuthority)
      || admission.receipt.parentCanonicalRequestHash
        !== acceptance.canonicalRequestHash
      || remoteActionStartIds.has(admission.receipt.remoteActionStartId)
    ) {
      throw new SupervisorRuntimeError(
        'ACCEPTANCE_JOURNAL_INVALID',
        'Durable remote-attempt admission receipt is invalid or duplicated.',
        false,
      );
    }
    remoteActionStartIds.add(admission.receipt.remoteActionStartId);
  });
  if (
    admissions.length > 0
    && acceptance.remoteAttemptStartedAt !== admissions[0]!.receipt.admittedAt
  ) {
    throw new SupervisorRuntimeError(
      'ACCEPTANCE_JOURNAL_INVALID',
      'The first remote-attempt marker differs from its exact admission receipt.',
      false,
    );
  }
  return structuredClone(admissions);
}

function required(value: string | null | undefined, name: string): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
  return value;
}

function requiredSha256(
  value: unknown,
  name: string,
  missingCode: string,
): string {
  if (value === undefined || value === null || value === '') {
    throw new SupervisorRuntimeError(
      missingCode,
      `${name} is required for a verified intervention end.`,
      false,
    );
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new SupervisorRuntimeError(
      'COMPLETION_INTENT_INVALID',
      `${name} must be a SHA-256 hex digest.`,
      false,
    );
  }
  return value;
}

function recoveryRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryStateInvalid(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unknown.length !== 0) {
    throw recoveryStateInvalid(`${path} has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  return record;
}

function recoveryIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || !/^[A-Za-z0-9._:@/-]+$/u.test(value)
  ) {
    throw recoveryStateInvalid(`${path} must be a safe identifier.`);
  }
  return value;
}

function recoverySha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw recoveryStateInvalid(`${path} must be a SHA-256 hex digest.`);
  }
  return value;
}

function recoveryPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw recoveryStateInvalid(`${path} must be a positive integer.`);
  }
  return value as number;
}

function nullableRecoveryTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : recoveryTimestamp(value, path);
}

function recoveryTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw recoveryStateInvalid(`${path} must be an ISO timestamp.`);
  }
  return value;
}

function recoveryStateInvalid(message: string): SupervisorRuntimeError {
  return new SupervisorRuntimeError('RECOVERY_STATE_INVALID', message, false);
}

function pageActionExecutionDeadlineReached(): SupervisorRuntimeError {
  return new SupervisorRuntimeError(
    'RPC_DEADLINE_EXCEEDED',
    'PageAction execution reached its cleanup boundary before the RPC deadline.',
    false,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : 'unknown';
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
