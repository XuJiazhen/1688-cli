import { describe, expect, it } from 'vitest';
import {
  PAGE_ACTION_REQUEST_SCHEMA,
  canonicalCollectorSha256V1,
  computeCollectorExecutionHandleSignatureV1,
  computeExecutionLineageHashV1,
  computeLogicalLineageHashV1,
  computePageActionPayloadBusinessHashV1,
  pageActionBusinessFieldPathsV1,
  type LeaseFenceV1,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import {
  HmacRenewalCredentialVerifier,
  fenceDigest,
  signRenewalCredentialTransport,
} from '../src/daemon/supervisor-runtime.js';
import {
  canonicalRpcPayloadHash,
  SUPERVISOR_PROTOCOL_SHA256_V2,
  parseSupervisorRpcFrame,
  parseSupervisorRpcRequest,
  validateRpcBinding,
  type ParsedSupervisorRpcRequestV2,
} from '../src/daemon/supervisor-rpc.js';

const verification = {
  keysById: {},
  routesById: {},
  expansionPoliciesByDispatchRevisionId: {},
};
const schedulerKey = 'scheduler-parser-proof-key-with-32-bytes';
const PROFILE_ID = '30000000-0000-4000-8000-000000000001';
const DAEMON_ID = '30000000-0000-4000-8000-000000000002';
const SUPERVISOR_LEASE_ID = '30000000-0000-4000-8000-000000000003';
const RESERVATION_LEASE_ID = '30000000-0000-4000-8000-000000000004';
const WORK_LEASE_ID = '30000000-0000-4000-8000-000000000005';
const transportAuthority = {
  mode: 'scripted_offline' as const,
  executionAuthorityDocumentId: '30000000-0000-4000-8000-000000000006',
  executionAuthorityDocumentSha256: 'a'.repeat(64),
  executionSubjectDocumentId: '30000000-0000-4000-8000-000000000007',
  executionSubjectDocumentSha256: 'b'.repeat(64),
  cohortId: '30000000-0000-4000-8000-000000000008',
  runId: '30000000-0000-4000-8000-000000000009',
  protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
};
const parseOptions = {
  verification,
  now: new Date('2026-07-31T08:00:00.000Z'),
};

function controlRequest() {
  const fence = {
    leaseId: SUPERVISOR_LEASE_ID,
    generation: 1,
    fencingToken: 'supervisor-fence',
    leaseNotAfter: '2026-07-31T08:10:00.000Z',
  };
  return {
    schema: 'profile-supervisor.rpc.v2',
    rpcId: 'rpc-1',
    method: 'supervisor.status',
    deadlineAt: '2026-07-31T08:05:00.000Z',
    binding: {
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisor: fence,
      reservation: null,
      workUnit: null,
      transportAuthority,
      renewalCredential: null,
      controlCredential: {
        payload: {
          schemaVersion: 2,
          profileId: PROFILE_ID,
          daemonInstanceId: DAEMON_ID,
          contextGeneration: 1,
          supervisorLeaseId: SUPERVISOR_LEASE_ID,
          supervisorGeneration: 1,
          supervisorFenceDigest: 'a'.repeat(64),
          rpcId: 'rpc-1',
          canonicalRequestHash:
            '1a0f7ae9b61b3ff28128ba8d91b6ca2664ca938597e400093d06fa21fdc0fe29',
          requestDeadlineAt: '2026-07-31T08:05:00.000Z',
          issuedAt: '2026-07-31T07:59:00.000Z',
          credentialNotBefore: '2026-07-31T07:59:00.000Z',
          credentialExpiresAt: '2026-07-31T08:04:00.000Z',
          keyId: 'key-1',
        },
        algorithm: 'HMAC-SHA256',
        signature: 'x'.repeat(43),
      },
    },
    payload: {},
  };
}

describe('Profile Supervisor RPC protocol', () => {
  it('accepts only a strict allowlisted control frame', () => {
    const parsed = parseSupervisorRpcRequest(controlRequest(), parseOptions);
    expect(parsed).toMatchObject({
      method: 'supervisor.status',
      binding: { profileId: PROFILE_ID, renewalCredential: null },
    });
  });

  it('rejects arbitrary methods and unknown envelope fields', () => {
    expect(() => parseSupervisorRpcRequest({
      ...controlRequest(),
      method: 'checkout.confirm',
    }, parseOptions)).toThrow(/must be one of/);
    expect(() => parseSupervisorRpcRequest({
      ...controlRequest(),
      arbitraryJavaScript: 'document.cookie',
    }, parseOptions)).toThrow(/unknown fields/);
  });

  it('enforces the framed transport size before JSON parsing', () => {
    expect(() => parseSupervisorRpcFrame('x'.repeat(101), {
      verification,
      maxFrameBytes: 100,
      now: parseOptions.now,
    })).toThrow(/exceeds 100 bytes/);
  });

  it('binds control to exact daemon/context/Supervisor generation', () => {
    const request = parseSupervisorRpcRequest(controlRequest(), parseOptions);
    expect(() => validateRpcBinding(request, {
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 2,
      supervisorGeneration: 1,
      transportAuthority,
      now: new Date('2026-07-31T08:00:00.000Z'),
    })).toThrow(/contextGeneration/);
  });

  it('allows read-only receipt lookup after all presented leases expire', () => {
    const expiredFence = {
      leaseId: SUPERVISOR_LEASE_ID, generation: 1, fencingToken: 'supervisor-fence',
      leaseNotAfter: '2026-07-31T07:59:00.000Z',
    };
    const payload = {
      schema: 'collector.page-action.lookup-receipt.v1',
      requestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      pageActionId: 'page-action-1',
      pageActionExecutionAttemptId: 'attempt-1',
      logicalLineageId: 'lineage-1',
      logicalLineageHash: 'a'.repeat(64),
      targetExecutionLineageHash: 'b'.repeat(64),
      readFences: {
        supervisor: expiredFence,
        reservation: { ...expiredFence, leaseId: RESERVATION_LEASE_ID },
        workUnit: { ...expiredFence, leaseId: WORK_LEASE_ID },
      },
    };
    const request = {
      schema: 'profile-supervisor.rpc.v2' as const,
      rpcId: 'lookup-rpc-1',
      method: 'collector.pageAction.lookupReceipt' as const,
      deadlineAt: '2026-07-31T08:05:00.000Z',
      binding: {
        profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
        supervisor: expiredFence,
        reservation: { ...expiredFence, leaseId: RESERVATION_LEASE_ID },
        workUnit: { ...expiredFence, leaseId: WORK_LEASE_ID },
        transportAuthority,
        renewalCredential: null,
        controlCredential: null,
      },
      payload,
    } as unknown as ParsedSupervisorRpcRequestV2;
    request.binding.renewalCredential = {
      payload: {
        schemaVersion: 2,
        profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
        supervisorLeaseId: SUPERVISOR_LEASE_ID, supervisorGeneration: 1,
        supervisorFenceDigest: fenceDigest(expiredFence),
        reservationLeaseId: RESERVATION_LEASE_ID, reservationGeneration: 1,
        reservationFenceDigest: fenceDigest({ ...expiredFence, leaseId: RESERVATION_LEASE_ID }),
        workUnitLeaseId: WORK_LEASE_ID, workUnitGeneration: 1,
        workUnitFenceDigest: fenceDigest({ ...expiredFence, leaseId: WORK_LEASE_ID }),
        requestId: 'request-1',
        canonicalRequestHash: canonicalRpcPayloadHash(request),
        requestDeadlineAt: request.deadlineAt,
        idempotencyKey: 'idempotency-1',
        issuedAt: '2026-07-31T07:50:00.000Z',
        credentialNotBefore: '2026-07-31T07:50:00.000Z',
        credentialExpiresAt: '2026-07-31T07:58:00.000Z',
        leaseNotAfter: '2026-07-31T07:59:00.000Z',
        keyId: 'key-1',
      },
      algorithm: 'HMAC-SHA256',
      signature: 'x'.repeat(43),
    };
    expect(() => validateRpcBinding(request, {
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisorGeneration: 1, transportAuthority,
      now: new Date('2026-07-31T08:00:00.000Z'),
    })).not.toThrow();

    request.payload.readFences.workUnit = {
      ...request.payload.readFences.workUnit,
      fencingToken: 'different-work-fence',
    };
    expect(() => validateRpcBinding(request, {
      profileId: PROFILE_ID, daemonInstanceId: DAEMON_ID, contextGeneration: 1,
      supervisorGeneration: 1, transportAuthority,
      now: new Date('2026-07-31T08:00:00.000Z'),
    })).toThrow(/lookup workUnit fence does not match/u);
  });

  it('accepts scheduler-shaped frozen execute/cancel and a fresh lookup after execute expiry', async () => {
    const payload = schedulerPageAction();
    const execute = workRequest('collector.pageAction.execute', payload, {
      deadlineAt: payload.deadlineAt,
      fences: payload.executionLineage.fences,
      issuedAt: '2026-07-31T08:00:00.000Z',
      credentialExpiresAt: '2026-07-31T08:04:00.000Z',
    });
    const parsedExecute = parseSupervisorRpcRequest(execute, {
      verification: schedulerVerification(payload),
      now: new Date('2026-07-31T08:01:00.000Z'),
    });
    expect(() => validateRpcBinding(parsedExecute, expectedAt('2026-07-31T08:01:00.000Z')))
      .not.toThrow();
    await authorize(parsedExecute, 'execute', '2026-07-31T08:01:00.000Z');

    const renewed = workRequest('collector.pageAction.execute', payload, {
      deadlineAt: payload.deadlineAt,
      fences: payload.executionLineage.fences,
      issuedAt: '2026-07-31T08:02:00.000Z',
      credentialExpiresAt: '2026-07-31T08:06:00.000Z',
    });
    const parsedRenewal = parseSupervisorRpcRequest(renewed, {
      verification: schedulerVerification(payload),
      now: new Date('2026-07-31T08:02:00.000Z'),
    });
    expect(parsedRenewal.payload).toEqual(parsedExecute.payload);
    expect(() => validateRpcBinding(parsedRenewal, expectedAt('2026-07-31T08:02:00.000Z')))
      .not.toThrow();
    await authorize(parsedRenewal, 'execute', '2026-07-31T08:02:00.000Z');

    const cancelPayload = {
      schema: 'collector.page-action.cancel.v1',
      requestId: payload.requestId,
      idempotencyKey: payload.idempotencyKey,
      pageActionId: payload.pageActionId,
      logicalLineage: payload.logicalLineage,
      logicalLineageHash: payload.logicalLineageHash,
      executionLineage: payload.executionLineage,
      executionLineageHash: payload.executionLineageHash,
      reason: 'supervisor_fenced',
    };
    const cancel = parseSupervisorRpcRequest(
      workRequest('collector.pageAction.cancel', cancelPayload, {
        deadlineAt: payload.deadlineAt,
        fences: payload.executionLineage.fences,
        issuedAt: '2026-07-31T08:02:00.000Z',
        credentialExpiresAt: '2026-07-31T08:06:00.000Z',
      }),
      {
        verification: schedulerVerification(payload),
        now: new Date('2026-07-31T08:03:00.000Z'),
      },
    );
    expect(() => validateRpcBinding(cancel, expectedAt('2026-07-31T08:03:00.000Z')))
      .not.toThrow();
    await authorize(cancel, 'cancel', '2026-07-31T08:03:00.000Z');

    const readFences = {
      supervisor: { ...payload.executionLineage.fences.supervisor, leaseNotAfter: '2026-07-31T08:20:00.000Z' },
      reservation: { ...payload.executionLineage.fences.reservation, leaseNotAfter: '2026-07-31T08:20:00.000Z' },
      workUnit: { ...payload.executionLineage.fences.workUnit, leaseNotAfter: '2026-07-31T08:20:00.000Z' },
    };
    const lookupPayload = {
      schema: 'collector.page-action.lookup-receipt.v1',
      requestId: payload.requestId,
      idempotencyKey: payload.idempotencyKey,
      pageActionId: payload.pageActionId,
      pageActionExecutionAttemptId: payload.pageActionExecutionAttemptId,
      logicalLineageId: payload.logicalLineage.logicalLineageId,
      logicalLineageHash: payload.logicalLineageHash,
      targetExecutionLineageHash: payload.executionLineageHash,
      readFences,
    };
    const lookup = parseSupervisorRpcRequest(
      workRequest('collector.pageAction.lookupReceipt', lookupPayload, {
        deadlineAt: '2026-07-31T08:12:00.000Z',
        fences: readFences,
        issuedAt: '2026-07-31T08:10:00.000Z',
        credentialExpiresAt: '2026-07-31T08:12:00.000Z',
      }),
      {
        verification: schedulerVerification(payload),
        now: new Date('2026-07-31T08:11:00.000Z'),
      },
    );
    expect(() => validateRpcBinding(lookup, expectedAt('2026-07-31T08:11:00.000Z')))
      .not.toThrow();
    await authorize(lookup, 'lookup_receipt', '2026-07-31T08:11:00.000Z');
  });
});

function schedulerPageAction(): PageActionRequestV1 {
  const subject = {
    kind: 'store-qualification' as const,
    memberId: 'member-1',
    canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    canonicalShopUrl: 'https://member-1.1688.com/',
    canonicalStoreIdentityReceiptId: 'store-identity-receipt-1',
    canonicalStoreIdentityReceiptHash: canonicalCollectorSha256V1('identity'),
  };
  const actionWithoutHandle = { ...subject };
  const actionForHash = { ...actionWithoutHandle, executionHandle: {} } as never;
  const pageActionBusinessHash = computePageActionPayloadBusinessHashV1(actionForHash);
  const policyRevisionIds = ['policy-1'];
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: 'logical-1',
    collectionTaskId: 'collection-task-1',
    workUnitId: 'work-unit-1',
    pageActionId: 'page-action-1',
    pageActionBusinessHash,
    actionKind: 'store-qualification' as const,
    businessSubject: subject,
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const fences = {
    supervisor: rpcFence('supervisor', '2026-07-31T08:10:00.000Z'),
    reservation: rpcFence('reservation', '2026-07-31T08:09:00.000Z'),
    workUnit: rpcFence('work', '2026-07-31T08:08:00.000Z'),
  };
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: 'work-unit-attempt-1',
    pageActionExecutionAttemptId: 'page-action-attempt-1',
    executionAttemptOrdinal: 1,
    requestId: 'request-1',
    idempotencyKey: 'idempotency-1',
    profile: {
      profileId: PROFILE_ID,
      profileName: 'profile-1',
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      egressId: 'egress-1',
    },
    fences,
  };
  const handleContent = {
    schema: 'collector-execution-handle-v1' as const,
    handleId: 'handle-1',
    issuer: 'trusted-page-capability-service' as const,
    actionKind: 'store-qualification' as const,
    routeTemplateId: 'route-store-qualification',
    subjectHash: canonicalCollectorSha256V1(subject),
    actionPayloadBusinessHash: pageActionBusinessHash,
    allowedRequestKeysHash: canonicalCollectorSha256V1(pageActionBusinessFieldPathsV1(actionForHash)),
    policyRevisionIdsHash: canonicalCollectorSha256V1(policyRevisionIds),
    notBefore: '2026-07-31T07:59:00.000Z',
    expiresAt: '2026-07-31T08:30:00.000Z',
    signingKeyId: 'scheduler-key',
  };
  return {
    schema: PAGE_ACTION_REQUEST_SCHEMA,
    requestId: executionLineage.requestId,
    idempotencyKey: executionLineage.idempotencyKey,
    pageActionId: logicalLineage.pageActionId,
    pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
    executionAttemptOrdinal: 1,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind: 'store-qualification',
    startNotBefore: '2026-07-31T08:00:00.000Z',
    leaseNotAfter: fences.workUnit.leaseNotAfter,
    deadlineAt: '2026-07-31T08:07:00.000Z',
    policyRevisionIds,
    action: {
      ...actionWithoutHandle,
      executionHandle: {
        ...handleContent,
        signature: computeCollectorExecutionHandleSignatureV1(handleContent, schedulerKey),
      },
    },
  };
}

function schedulerVerification(request: PageActionRequestV1) {
  return {
    keysById: { 'scheduler-key': schedulerKey },
    routesById: {
      'route-store-qualification': {
        actionKind: 'store-qualification' as const,
        allowedRequestKeys: pageActionBusinessFieldPathsV1(request.action),
      },
    },
    expansionPoliciesByDispatchRevisionId: {},
  };
}

function workRequest(
  method: 'collector.pageAction.execute' | 'collector.pageAction.cancel' | 'collector.pageAction.lookupReceipt',
  payload: unknown,
  input: {
    deadlineAt: string;
    fences: { supervisor: LeaseFenceV1; reservation: LeaseFenceV1; workUnit: LeaseFenceV1 };
    issuedAt: string;
    credentialExpiresAt: string;
  },
) {
  const request = {
    schema: 'profile-supervisor.rpc.v2' as const,
    rpcId: `rpc-${method}-${input.issuedAt}`,
    method,
    deadlineAt: input.deadlineAt,
    binding: {
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisor: input.fences.supervisor,
      reservation: input.fences.reservation,
      workUnit: input.fences.workUnit,
      transportAuthority,
      renewalCredential: null,
      controlCredential: null,
    },
    payload,
  };
  const requestId = (payload as { requestId: string }).requestId;
  const idempotencyKey = (payload as { idempotencyKey: string }).idempotencyKey;
  const leaseNotAfter = new Date(Math.min(
    ...Object.values(input.fences).map((fence) => Date.parse(fence.leaseNotAfter)),
  )).toISOString();
  const parsedForHash = request as unknown as ParsedSupervisorRpcRequestV2;
  request.binding.renewalCredential = signRenewalCredentialTransport({
    payload: {
      schemaVersion: 2,
      profileId: PROFILE_ID,
      daemonInstanceId: DAEMON_ID,
      contextGeneration: 1,
      supervisorLeaseId: input.fences.supervisor.leaseId,
      supervisorGeneration: input.fences.supervisor.generation,
      supervisorFenceDigest: fenceDigest(input.fences.supervisor),
      reservationLeaseId: input.fences.reservation.leaseId,
      reservationGeneration: input.fences.reservation.generation,
      reservationFenceDigest: fenceDigest(input.fences.reservation),
      workUnitLeaseId: input.fences.workUnit.leaseId,
      workUnitGeneration: input.fences.workUnit.generation,
      workUnitFenceDigest: fenceDigest(input.fences.workUnit),
      requestId,
      canonicalRequestHash: canonicalRpcPayloadHash(parsedForHash),
      requestDeadlineAt: input.deadlineAt,
      idempotencyKey,
      issuedAt: input.issuedAt,
      credentialNotBefore: input.issuedAt,
      credentialExpiresAt: input.credentialExpiresAt,
      leaseNotAfter,
      keyId: 'scheduler-key',
    },
    algorithm: 'HMAC-SHA256',
  }, schedulerKey);
  return request;
}

async function authorize(
  request: ParsedSupervisorRpcRequestV2,
  operation: 'execute' | 'cancel' | 'lookup_receipt',
  at: string,
): Promise<void> {
  await new HmacRenewalCredentialVerifier({ 'scheduler-key': schedulerKey }).authorize({
    credential: request.binding.renewalCredential!,
    operation,
    binding: request.binding,
    canonicalPayloadHash: canonicalRpcPayloadHash(request),
    now: new Date(at),
  });
}

function expectedAt(at: string) {
  return {
    profileId: PROFILE_ID,
    daemonInstanceId: DAEMON_ID,
    contextGeneration: 1,
    supervisorGeneration: 1,
    transportAuthority,
    now: new Date(at),
  };
}

function rpcFence(prefix: string, leaseNotAfter: string): LeaseFenceV1 {
  return {
    leaseId: prefix === 'supervisor'
      ? SUPERVISOR_LEASE_ID
      : prefix === 'reservation'
        ? RESERVATION_LEASE_ID
        : WORK_LEASE_ID,
    generation: 1,
    fencingToken: `${prefix}-fence`,
    leaseNotAfter,
  };
}
