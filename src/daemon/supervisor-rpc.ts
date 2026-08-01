import {
  canonicalCollectorSha256V1,
  normalizePageActionCancelV1,
  normalizePageActionReceiptLookupV1,
  normalizePageActionRequestV1,
  type LeaseFenceV1,
  type PageActionCancelV1,
  type PageActionReceiptLookupV1,
  type PageActionRequestV1,
  type PageActionVerificationConfigV1,
} from '../collection/page-action-contracts.js';

export const SUPERVISOR_RPC_SCHEMA = 'profile-supervisor.rpc.v1' as const;
export const SUPERVISOR_RPC_RESPONSE_SCHEMA =
  'profile-supervisor.rpc-response.v1' as const;
export const SUPERVISOR_RPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const SUPERVISOR_EXECUTION_RENEWAL_SCHEMA =
  'profile-supervisor.execution-renewal.v1' as const;
export const SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_SCHEMA =
  'profile-supervisor.remote-attempt-admission.v1' as const;
export const SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA =
  'profile-supervisor.remote-attempt-admission-response.v1' as const;

export const SUPERVISOR_RPC_METHODS = Object.freeze([
  'collector.pageAction.execute',
  'collector.pageAction.cancel',
  'collector.pageAction.lookupReceipt',
  'supervisor.status',
  'supervisor.drain',
  'supervisor.restart',
  'supervisor.intervention.begin',
  'supervisor.intervention.verify',
  'supervisor.intervention.end',
] as const);

export type SupervisorRpcMethod = (typeof SUPERVISOR_RPC_METHODS)[number];
export type SupervisorRpcOperation =
  | 'execute'
  | 'cancel'
  | 'lookup_receipt'
  | 'status'
  | 'drain'
  | 'restart'
  | 'begin_intervention'
  | 'verify_intervention'
  | 'end_intervention';

export interface RenewalCredentialTransportV1 {
  payload: {
    schemaVersion: 1;
    profileId: string;
    daemonInstanceId: string;
    contextGeneration: number;
    supervisorLeaseId: string;
    supervisorGeneration: number;
    supervisorFenceDigest: string;
    reservationLeaseId: string;
    reservationGeneration: number;
    reservationFenceDigest: string;
    workUnitLeaseId: string;
    workUnitGeneration: number;
    workUnitFenceDigest: string;
    requestId: string;
    canonicalRequestHash: string;
    requestDeadlineAt: string;
    idempotencyKey: string;
    issuedAt: string;
    credentialNotBefore: string;
    credentialExpiresAt: string;
    leaseNotAfter: string;
    keyId: string;
  };
  algorithm: 'HMAC-SHA256';
  signature: string;
}

export interface SupervisorControlCredentialV1 {
  payload: {
    schemaVersion: 1;
    profileId: string;
    daemonInstanceId: string;
    contextGeneration: number;
    supervisorLeaseId: string;
    supervisorGeneration: number;
    supervisorFenceDigest: string;
    rpcId: string;
    canonicalRequestHash: string;
    requestDeadlineAt: string;
    issuedAt: string;
    credentialNotBefore: string;
    credentialExpiresAt: string;
    keyId: string;
  };
  algorithm: 'HMAC-SHA256';
  signature: string;
}

export interface SupervisorRpcBindingV1 {
  profileId: string;
  daemonInstanceId: string;
  contextGeneration: number;
  supervisor: LeaseFenceV1;
  reservation: LeaseFenceV1 | null;
  workUnit: LeaseFenceV1 | null;
  renewalCredential: RenewalCredentialTransportV1 | null;
  controlCredential: SupervisorControlCredentialV1 | null;
}

export interface SupervisorRpcRequestV1<TPayload = unknown> {
  schema: typeof SUPERVISOR_RPC_SCHEMA;
  rpcId: string;
  method: SupervisorRpcMethod;
  deadlineAt: string;
  binding: SupervisorRpcBindingV1;
  payload: TPayload;
}

export interface SupervisorRpcSuccessV1<T = unknown> {
  schema: typeof SUPERVISOR_RPC_RESPONSE_SCHEMA;
  rpcId: string;
  ok: true;
  data: T;
}

export interface SupervisorRpcFailureV1 {
  schema: typeof SUPERVISOR_RPC_RESPONSE_SCHEMA;
  rpcId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export type SupervisorRpcResponseV1<T = unknown> =
  | SupervisorRpcSuccessV1<T>
  | SupervisorRpcFailureV1;

export interface DrainCommandV1 {
  reason: string;
  deadlineAt: string;
  cancelInFlight: boolean;
}

export interface RestartCommandV1 {
  reason: string;
  expectedContextGeneration: number;
}

export interface BeginInterventionCommandV1 {
  interventionSessionId: string;
  pageSessionId: string;
  expectedWorkUnitId: string;
  operatorId: string;
  expiresAt: string;
}

export interface VerifyInterventionCommandV1 {
  interventionSessionId: string;
  expectedMemberId: string;
  probeRevision: string;
  phase?: 'intervention' | 'final_readiness';
}

export interface EndInterventionCommandV1 {
  interventionSessionId: string;
  reason: 'verified' | 'cancelled' | 'timed_out';
}

export type ParsedSupervisorRpcRequestV1 =
  | (SupervisorRpcRequestV1<PageActionRequestV1> & {
      method: 'collector.pageAction.execute';
    })
  | (SupervisorRpcRequestV1<PageActionCancelV1> & {
      method: 'collector.pageAction.cancel';
    })
  | (SupervisorRpcRequestV1<PageActionReceiptLookupV1> & {
      method: 'collector.pageAction.lookupReceipt';
    })
  | (SupervisorRpcRequestV1<Record<string, never>> & {
      method: 'supervisor.status';
    })
  | (SupervisorRpcRequestV1<DrainCommandV1> & { method: 'supervisor.drain' })
  | (SupervisorRpcRequestV1<RestartCommandV1> & { method: 'supervisor.restart' })
  | (SupervisorRpcRequestV1<BeginInterventionCommandV1> & {
      method: 'supervisor.intervention.begin';
    })
  | (SupervisorRpcRequestV1<VerifyInterventionCommandV1> & {
      method: 'supervisor.intervention.verify';
    })
  | (SupervisorRpcRequestV1<EndInterventionCommandV1> & {
      method: 'supervisor.intervention.end';
    });

export interface ParseSupervisorRpcOptions {
  verification: PageActionVerificationConfigV1;
  maxFrameBytes?: number;
}

export interface ExecutionRenewalFrameV1 {
  schema: typeof SUPERVISOR_EXECUTION_RENEWAL_SCHEMA;
  rpcId: string;
  request: ParsedSupervisorRpcRequestV1 & { method: 'collector.pageAction.execute' };
}

export interface RemoteAttemptAdmissionRequestV1 {
  pageActionId: string;
  pageActionExecutionAttemptId: string;
  remoteRequestAttemptId: string;
  ordinal: number;
  logicalPage?: number;
  purpose: 'forward' | 'replay' | 'discovery' | 'single-target';
  requestBusinessHash: string;
}

export interface RemoteAttemptAdmissionReceiptV1 {
  remoteActionStartId: string;
  admittedAt: string;
}

export interface RemoteAttemptAdmissionFrameV1 {
  schema: typeof SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_SCHEMA;
  rpcId: string;
  admissionId: string;
  deadlineAt: string;
  request: RemoteAttemptAdmissionRequestV1;
}

export type RemoteAttemptAdmissionResponseFrameV1 = {
  schema: typeof SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA;
  rpcId: string;
  admissionId: string;
  ok: true;
  receipt: RemoteAttemptAdmissionReceiptV1;
} | {
  schema: typeof SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA;
  rpcId: string;
  admissionId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export function parseRemoteAttemptAdmissionResponseFrame(
  value: unknown,
): RemoteAttemptAdmissionResponseFrameV1 {
  const record = strictRecord(value, 'RemoteAttemptAdmissionResponseFrame', [
    'schema', 'rpcId', 'admissionId', 'ok', 'receipt', 'error',
  ]);
  literal(
    record['schema'],
    SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA,
    'schema',
  );
  const rpcId = identifier(record['rpcId'], 'rpcId');
  const admissionId = identifier(record['admissionId'], 'admissionId');
  if (record['ok'] === true) {
    const receipt = strictRecord(record['receipt'], 'receipt', [
      'remoteActionStartId', 'admittedAt',
    ]);
    return {
      schema: SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA,
      rpcId,
      admissionId,
      ok: true,
      receipt: {
        remoteActionStartId: identifier(receipt['remoteActionStartId'], 'remoteActionStartId'),
        admittedAt: timestamp(receipt['admittedAt'], 'admittedAt'),
      },
    };
  }
  if (record['ok'] !== false) {
    throw new SupervisorRpcError(
      'REMOTE_ATTEMPT_ADMISSION_RESPONSE_INVALID',
      'Remote-attempt admission response ok must be boolean.',
      false,
    );
  }
  const error = strictRecord(record['error'], 'error', [
    'code', 'message', 'retryable',
  ]);
  if (typeof error['retryable'] !== 'boolean') {
    throw new SupervisorRpcError(
      'REMOTE_ATTEMPT_ADMISSION_RESPONSE_INVALID',
      'Remote-attempt admission error retryable must be boolean.',
      false,
    );
  }
  return {
    schema: SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA,
    rpcId,
    admissionId,
    ok: false,
    error: {
      code: identifier(error['code'], 'error.code'),
      message: boundedString(error['message'], 'error.message', 2_048),
      retryable: error['retryable'],
    },
  };
}

export function parseExecutionRenewalFrame(
  value: unknown,
  options: ParseSupervisorRpcOptions,
): ExecutionRenewalFrameV1 {
  const record = strictRecord(value, 'ExecutionRenewalFrame', [
    'schema', 'rpcId', 'request',
  ]);
  literal(record['schema'], SUPERVISOR_EXECUTION_RENEWAL_SCHEMA, 'schema');
  const request = parseSupervisorRpcRequest(record['request'], options);
  if (request.method !== 'collector.pageAction.execute') {
    throw new SupervisorRpcError(
      'RPC_RENEWAL_METHOD_INVALID',
      'Execution renewal must carry an execute request binding.',
      false,
    );
  }
  return {
    schema: SUPERVISOR_EXECUTION_RENEWAL_SCHEMA,
    rpcId: identifier(record['rpcId'], 'rpcId'),
    request,
  };
}

export function parseSupervisorRpcFrame(
  frame: string | Buffer,
  options: ParseSupervisorRpcOptions,
): ParsedSupervisorRpcRequestV1 {
  const maxFrameBytes = options.maxFrameBytes ?? SUPERVISOR_RPC_MAX_FRAME_BYTES;
  if (Buffer.byteLength(frame) > maxFrameBytes) {
    throw new SupervisorRpcError(
      'RPC_FRAME_TOO_LARGE',
      `RPC frame exceeds ${maxFrameBytes} bytes.`,
      false,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(frame.toString());
  } catch {
    throw new SupervisorRpcError('RPC_MALFORMED_JSON', 'RPC frame is not valid JSON.', false);
  }
  return parseSupervisorRpcRequest(value, options);
}

export function parseSupervisorRpcRequest(
  value: unknown,
  options: ParseSupervisorRpcOptions,
): ParsedSupervisorRpcRequestV1 {
  const record = strictRecord(value, 'SupervisorRpcRequest', [
    'schema',
    'rpcId',
    'method',
    'deadlineAt',
    'binding',
    'payload',
  ]);
  literal(record['schema'], SUPERVISOR_RPC_SCHEMA, 'schema');
  const rpcId = identifier(record['rpcId'], 'rpcId');
  const method = enumValue(record['method'], SUPERVISOR_RPC_METHODS, 'method');
  const deadlineAt = timestamp(record['deadlineAt'], 'deadlineAt');
  const binding = parseBinding(record['binding']);
  const base = {
    schema: SUPERVISOR_RPC_SCHEMA,
    rpcId,
    method,
    deadlineAt,
    binding,
  };
  switch (method) {
    case 'collector.pageAction.execute':
      return {
        ...base,
        method,
        payload: normalizePageActionRequestV1(record['payload'], options.verification),
      };
    case 'collector.pageAction.cancel':
      return {
        ...base,
        method,
        payload: normalizePageActionCancelV1(record['payload']),
      };
    case 'collector.pageAction.lookupReceipt':
      return {
        ...base,
        method,
        payload: normalizePageActionReceiptLookupV1(record['payload']),
      };
    case 'supervisor.status':
      emptyObject(record['payload'], 'payload');
      return { ...base, method, payload: {} };
    case 'supervisor.drain':
      return { ...base, method, payload: parseDrain(record['payload']) };
    case 'supervisor.restart':
      return { ...base, method, payload: parseRestart(record['payload']) };
    case 'supervisor.intervention.begin':
      return { ...base, method, payload: parseBeginIntervention(record['payload']) };
    case 'supervisor.intervention.verify':
      return { ...base, method, payload: parseVerifyIntervention(record['payload']) };
    case 'supervisor.intervention.end':
      return { ...base, method, payload: parseEndIntervention(record['payload']) };
  }
}

export function supervisorRpcOperation(method: SupervisorRpcMethod): SupervisorRpcOperation {
  switch (method) {
    case 'collector.pageAction.execute': return 'execute';
    case 'collector.pageAction.cancel': return 'cancel';
    case 'collector.pageAction.lookupReceipt': return 'lookup_receipt';
    case 'supervisor.status': return 'status';
    case 'supervisor.drain': return 'drain';
    case 'supervisor.restart': return 'restart';
    case 'supervisor.intervention.begin': return 'begin_intervention';
    case 'supervisor.intervention.verify': return 'verify_intervention';
    case 'supervisor.intervention.end': return 'end_intervention';
  }
}

export function canonicalRpcPayloadHash(request: ParsedSupervisorRpcRequestV1): string {
  return canonicalCollectorSha256V1(request.payload).replace(/^sha256:/u, '');
}

export function validateRpcBinding(
  request: ParsedSupervisorRpcRequestV1,
  expected: {
    profileId: string;
    daemonInstanceId: string;
    contextGeneration: number;
    supervisorGeneration: number;
    now: Date;
  },
): void {
  const { binding } = request;
  equal(binding.profileId, expected.profileId, 'profileId');
  equal(binding.daemonInstanceId, expected.daemonInstanceId, 'daemonInstanceId');
  equal(binding.contextGeneration, expected.contextGeneration, 'contextGeneration');
  equal(
    binding.supervisor.generation,
    expected.supervisorGeneration,
    'supervisor generation',
  );
  const now = expected.now.getTime();
  const rpcDeadline = Date.parse(request.deadlineAt);
  if (now >= rpcDeadline) {
    throw new SupervisorRpcError('RPC_DEADLINE_EXCEEDED', 'RPC deadline has expired.', true);
  }
  const isReceiptLookup = request.method === 'collector.pageAction.lookupReceipt';
  if (!isReceiptLookup && now >= Date.parse(binding.supervisor.leaseNotAfter)) {
    throw new SupervisorRpcError(
      'SUPERVISOR_LEASE_EXPIRED',
      'SupervisorLease has expired.',
      true,
    );
  }
  const isWorkMethod = request.method.startsWith('collector.pageAction.');
  if (isWorkMethod && (binding.reservation === null || binding.workUnit === null)) {
    throw new SupervisorRpcError(
      'THREE_LEVEL_FENCE_REQUIRED',
      'Collector RPC requires Supervisor, Reservation, and WorkUnit fences.',
      false,
    );
  }
  const earliestBindingLease = isWorkMethod
    ? Math.min(
      Date.parse(binding.supervisor.leaseNotAfter),
      Date.parse(binding.reservation!.leaseNotAfter),
      Date.parse(binding.workUnit!.leaseNotAfter),
    )
    : Date.parse(binding.supervisor.leaseNotAfter);
  if (!isReceiptLookup && rpcDeadline > earliestBindingLease) {
    throw new SupervisorRpcError(
      'RPC_DEADLINE_OUTSIDE_LEASE',
      'RPC deadline exceeds the presented lease hierarchy.',
      false,
    );
  }
  if (isWorkMethod && !isReceiptLookup && now >= earliestBindingLease) {
    throw new SupervisorRpcError(
      'WORK_LEASE_EXPIRED',
      'Reservation or WorkUnitLease has expired.',
      true,
    );
  }
  if (request.method === 'collector.pageAction.execute') {
    const payload = request.payload as PageActionRequestV1;
    const fences = payload.executionLineage.fences;
    assertFenceEqual(binding.supervisor, fences.supervisor, 'supervisor');
    assertFenceEqual(binding.reservation!, fences.reservation, 'reservation');
    assertFenceEqual(binding.workUnit!, fences.workUnit, 'workUnit');
    equal(payload.executionLineage.profile.profileId, expected.profileId, 'execution profileId');
    equal(
      payload.executionLineage.profile.daemonInstanceId,
      expected.daemonInstanceId,
      'execution daemonInstanceId',
    );
    equal(
      payload.executionLineage.profile.contextGeneration,
      expected.contextGeneration,
      'execution contextGeneration',
    );
    const topLease = earliestBindingLease;
    if (Date.parse(payload.leaseNotAfter) !== topLease) {
      throw new SupervisorRpcError(
        'LEASE_NOT_AFTER_MISMATCH',
        'PageAction leaseNotAfter must equal the earliest presented lease boundary.',
        false,
      );
    }
    if (rpcDeadline > Date.parse(payload.deadlineAt)) {
      throw new SupervisorRpcError(
        'RPC_DEADLINE_OUTSIDE_LEASE',
        'RPC deadline exceeds the PageAction or lease boundary.',
        false,
      );
    }
  } else if (request.method === 'collector.pageAction.cancel') {
    const payload = request.payload as PageActionCancelV1;
    const fences = payload.executionLineage.fences;
    assertFenceEqual(binding.supervisor, fences.supervisor, 'cancel supervisor');
    assertFenceEqual(binding.reservation!, fences.reservation, 'cancel reservation');
    assertFenceEqual(binding.workUnit!, fences.workUnit, 'cancel workUnit');
    equal(payload.executionLineage.profile.profileId, expected.profileId, 'cancel profileId');
    equal(
      payload.executionLineage.profile.daemonInstanceId,
      expected.daemonInstanceId,
      'cancel daemonInstanceId',
    );
    equal(
      payload.executionLineage.profile.contextGeneration,
      expected.contextGeneration,
      'cancel contextGeneration',
    );
  } else if (request.method === 'collector.pageAction.lookupReceipt') {
    const payload = request.payload as PageActionReceiptLookupV1;
    assertFenceEqual(binding.supervisor, payload.readFences.supervisor, 'lookup supervisor');
    assertFenceEqual(binding.reservation!, payload.readFences.reservation, 'lookup reservation');
    assertFenceEqual(binding.workUnit!, payload.readFences.workUnit, 'lookup workUnit');
  }
  validateCredentialBinding(request);
}

function validateCredentialBinding(request: ParsedSupervisorRpcRequestV1): void {
  const { binding } = request;
  const isWorkMethod = request.method.startsWith('collector.pageAction.');
  if (!isWorkMethod) {
    if (binding.renewalCredential !== null || binding.controlCredential === null) {
      throw new SupervisorRpcError(
        'SUPERVISOR_CONTROL_CREDENTIAL_REQUIRED',
        'Supervisor control RPC requires exactly one control credential.',
        false,
      );
    }
    const control = binding.controlCredential.payload;
    equal(control.profileId, binding.profileId, 'control credential profileId');
    equal(control.daemonInstanceId, binding.daemonInstanceId, 'control credential daemonInstanceId');
    equal(control.contextGeneration, binding.contextGeneration, 'control credential contextGeneration');
    equal(control.supervisorLeaseId, binding.supervisor.leaseId, 'control credential supervisorLeaseId');
    equal(control.supervisorGeneration, binding.supervisor.generation, 'control credential supervisorGeneration');
    equal(control.rpcId, request.rpcId, 'control credential rpcId');
    equal(control.canonicalRequestHash, canonicalRpcPayloadHash(request), 'control credential request hash');
    equal(control.requestDeadlineAt, request.deadlineAt, 'control credential request deadline');
    return;
  }
  if (binding.renewalCredential === null || binding.controlCredential !== null) {
    throw new SupervisorRpcError(
      'WORK_UNIT_RENEWAL_CREDENTIAL_REQUIRED',
      'Collector RPC requires exactly one WorkUnit renewal credential.',
      false,
    );
  }
  const credential = binding.renewalCredential.payload;
  equal(credential.profileId, binding.profileId, 'credential profileId');
  equal(credential.daemonInstanceId, binding.daemonInstanceId, 'credential daemonInstanceId');
  equal(credential.contextGeneration, binding.contextGeneration, 'credential contextGeneration');
  equal(credential.supervisorLeaseId, binding.supervisor.leaseId, 'credential supervisorLeaseId');
  equal(credential.supervisorGeneration, binding.supervisor.generation, 'credential supervisorGeneration');
  equal(
    credential.reservationLeaseId,
    binding.reservation?.leaseId,
    'credential reservationLeaseId',
  );
  equal(
    credential.reservationGeneration,
    binding.reservation?.generation,
    'credential reservationGeneration',
  );
  equal(credential.workUnitLeaseId, binding.workUnit?.leaseId, 'credential workUnitLeaseId');
  equal(
    credential.workUnitGeneration,
    binding.workUnit?.generation,
    'credential workUnitGeneration',
  );
  const payload = request.payload as Record<string, unknown>;
  const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : request.rpcId;
  const idempotencyKey = typeof payload['idempotencyKey'] === 'string'
    ? payload['idempotencyKey']
    : request.rpcId;
  equal(credential.requestId, requestId, 'credential requestId');
  equal(credential.idempotencyKey, idempotencyKey, 'credential idempotencyKey');
  equal(credential.canonicalRequestHash, canonicalRpcPayloadHash(request), 'credential request hash');
  equal(credential.requestDeadlineAt, request.deadlineAt, 'credential request deadline');
}

function parseBinding(value: unknown): SupervisorRpcBindingV1 {
  const record = strictRecord(value, 'binding', [
    'profileId',
    'daemonInstanceId',
    'contextGeneration',
    'supervisor',
    'reservation',
    'workUnit',
    'renewalCredential',
    'controlCredential',
  ]);
  return {
    profileId: identifier(record['profileId'], 'binding.profileId'),
    daemonInstanceId: identifier(record['daemonInstanceId'], 'binding.daemonInstanceId'),
    contextGeneration: positiveInteger(record['contextGeneration'], 'binding.contextGeneration'),
    supervisor: parseFence(record['supervisor'], 'binding.supervisor'),
    reservation: record['reservation'] === null
      ? null
      : parseFence(record['reservation'], 'binding.reservation'),
    workUnit: record['workUnit'] === null
      ? null
      : parseFence(record['workUnit'], 'binding.workUnit'),
    renewalCredential: record['renewalCredential'] === null
      ? null
      : parseCredential(record['renewalCredential']),
    controlCredential: record['controlCredential'] === null
      ? null
      : parseControlCredential(record['controlCredential']),
  };
}

function parseCredential(value: unknown): RenewalCredentialTransportV1 {
  const record = strictRecord(value, 'renewalCredential', [
    'payload', 'algorithm', 'signature',
  ]);
  const payload = strictRecord(record['payload'], 'renewalCredential.payload', [
    'schemaVersion', 'profileId', 'daemonInstanceId', 'contextGeneration', 'supervisorLeaseId',
    'supervisorGeneration', 'supervisorFenceDigest', 'reservationLeaseId',
    'reservationGeneration', 'reservationFenceDigest', 'workUnitLeaseId',
    'workUnitGeneration', 'workUnitFenceDigest', 'requestId', 'idempotencyKey',
    'canonicalRequestHash', 'requestDeadlineAt', 'issuedAt', 'credentialNotBefore',
    'credentialExpiresAt', 'leaseNotAfter', 'keyId',
  ]);
  equal(payload['schemaVersion'], 1, 'credential schemaVersion');
  literal(record['algorithm'], 'HMAC-SHA256', 'renewalCredential.algorithm');
  return {
    payload: {
      schemaVersion: 1,
      profileId: identifier(payload['profileId'], 'credential.profileId'),
      daemonInstanceId: identifier(payload['daemonInstanceId'], 'credential.daemonInstanceId'),
      contextGeneration: positiveInteger(payload['contextGeneration'], 'credential.contextGeneration'),
      supervisorLeaseId: identifier(payload['supervisorLeaseId'], 'credential.supervisorLeaseId'),
      supervisorGeneration: nonNegativeInteger(payload['supervisorGeneration'], 'credential.supervisorGeneration'),
      supervisorFenceDigest: hash(payload['supervisorFenceDigest'], 'credential.supervisorFenceDigest'),
      reservationLeaseId: identifier(payload['reservationLeaseId'], 'credential.reservationLeaseId'),
      reservationGeneration: positiveInteger(payload['reservationGeneration'], 'credential.reservationGeneration'),
      reservationFenceDigest: hash(payload['reservationFenceDigest'], 'credential.reservationFenceDigest'),
      workUnitLeaseId: identifier(payload['workUnitLeaseId'], 'credential.workUnitLeaseId'),
      workUnitGeneration: positiveInteger(payload['workUnitGeneration'], 'credential.workUnitGeneration'),
      workUnitFenceDigest: hash(payload['workUnitFenceDigest'], 'credential.workUnitFenceDigest'),
      requestId: identifier(payload['requestId'], 'credential.requestId'),
      idempotencyKey: identifier(payload['idempotencyKey'], 'credential.idempotencyKey'),
      canonicalRequestHash: hash(payload['canonicalRequestHash'], 'credential.canonicalRequestHash'),
      requestDeadlineAt: timestamp(payload['requestDeadlineAt'], 'credential.requestDeadlineAt'),
      issuedAt: timestamp(payload['issuedAt'], 'credential.issuedAt'),
      credentialNotBefore: timestamp(payload['credentialNotBefore'], 'credential.credentialNotBefore'),
      credentialExpiresAt: timestamp(payload['credentialExpiresAt'], 'credential.credentialExpiresAt'),
      leaseNotAfter: timestamp(payload['leaseNotAfter'], 'credential.leaseNotAfter'),
      keyId: identifier(payload['keyId'], 'credential.keyId'),
    },
    algorithm: 'HMAC-SHA256',
    signature: boundedString(record['signature'], 'renewalCredential.signature', 4096),
  };
}

function parseControlCredential(value: unknown): SupervisorControlCredentialV1 {
  const record = strictRecord(value, 'controlCredential', ['payload', 'algorithm', 'signature']);
  literal(record['algorithm'], 'HMAC-SHA256', 'controlCredential.algorithm');
  const payload = strictRecord(record['payload'], 'controlCredential.payload', [
    'schemaVersion', 'profileId', 'daemonInstanceId', 'contextGeneration',
    'supervisorLeaseId', 'supervisorGeneration', 'supervisorFenceDigest',
    'rpcId', 'canonicalRequestHash', 'requestDeadlineAt', 'issuedAt',
    'credentialNotBefore', 'credentialExpiresAt', 'keyId',
  ]);
  equal(payload['schemaVersion'], 1, 'control credential schemaVersion');
  return {
    payload: {
      schemaVersion: 1,
      profileId: identifier(payload['profileId'], 'control.profileId'),
      daemonInstanceId: identifier(payload['daemonInstanceId'], 'control.daemonInstanceId'),
      contextGeneration: positiveInteger(payload['contextGeneration'], 'control.contextGeneration'),
      supervisorLeaseId: identifier(payload['supervisorLeaseId'], 'control.supervisorLeaseId'),
      supervisorGeneration: nonNegativeInteger(payload['supervisorGeneration'], 'control.supervisorGeneration'),
      supervisorFenceDigest: hash(payload['supervisorFenceDigest'], 'control.supervisorFenceDigest'),
      rpcId: identifier(payload['rpcId'], 'control.rpcId'),
      canonicalRequestHash: hash(payload['canonicalRequestHash'], 'control.canonicalRequestHash'),
      requestDeadlineAt: timestamp(payload['requestDeadlineAt'], 'control.requestDeadlineAt'),
      issuedAt: timestamp(payload['issuedAt'], 'control.issuedAt'),
      credentialNotBefore: timestamp(payload['credentialNotBefore'], 'control.credentialNotBefore'),
      credentialExpiresAt: timestamp(payload['credentialExpiresAt'], 'control.credentialExpiresAt'),
      keyId: identifier(payload['keyId'], 'control.keyId'),
    },
    algorithm: 'HMAC-SHA256',
    signature: boundedString(record['signature'], 'controlCredential.signature', 4096),
  };
}

function parseFence(value: unknown, path: string): LeaseFenceV1 {
  const record = strictRecord(value, path, [
    'leaseId', 'generation', 'fencingToken', 'leaseNotAfter',
  ]);
  return {
    leaseId: identifier(record['leaseId'], `${path}.leaseId`),
    generation: nonNegativeInteger(record['generation'], `${path}.generation`),
    fencingToken: identifier(record['fencingToken'], `${path}.fencingToken`),
    leaseNotAfter: timestamp(record['leaseNotAfter'], `${path}.leaseNotAfter`),
  };
}

function parseDrain(value: unknown): DrainCommandV1 {
  const record = strictRecord(value, 'DrainCommand', ['reason', 'deadlineAt', 'cancelInFlight']);
  return {
    reason: boundedString(record['reason'], 'reason', 256),
    deadlineAt: timestamp(record['deadlineAt'], 'deadlineAt'),
    cancelInFlight: booleanValue(record['cancelInFlight'], 'cancelInFlight'),
  };
}

function parseRestart(value: unknown): RestartCommandV1 {
  const record = strictRecord(value, 'RestartCommand', ['reason', 'expectedContextGeneration']);
  return {
    reason: boundedString(record['reason'], 'reason', 256),
    expectedContextGeneration: positiveInteger(
      record['expectedContextGeneration'],
      'expectedContextGeneration',
    ),
  };
}

function parseBeginIntervention(value: unknown): BeginInterventionCommandV1 {
  const record = strictRecord(value, 'BeginInterventionCommand', [
    'interventionSessionId', 'pageSessionId', 'expectedWorkUnitId',
    'operatorId', 'expiresAt',
  ]);
  return {
    interventionSessionId: identifier(record['interventionSessionId'], 'interventionSessionId'),
    pageSessionId: identifier(record['pageSessionId'], 'pageSessionId'),
    expectedWorkUnitId: identifier(record['expectedWorkUnitId'], 'expectedWorkUnitId'),
    operatorId: identifier(record['operatorId'], 'operatorId'),
    expiresAt: timestamp(record['expiresAt'], 'expiresAt'),
  };
}

function parseVerifyIntervention(value: unknown): VerifyInterventionCommandV1 {
  const record = strictRecord(value, 'VerifyInterventionCommand', [
    'interventionSessionId', 'expectedMemberId', 'probeRevision', 'phase',
  ]);
  return {
    interventionSessionId: identifier(record['interventionSessionId'], 'interventionSessionId'),
    expectedMemberId: identifier(record['expectedMemberId'], 'expectedMemberId'),
    probeRevision: identifier(record['probeRevision'], 'probeRevision'),
    ...(record['phase'] === undefined
      ? {}
      : {
          phase: enumValue(
            record['phase'],
            ['intervention', 'final_readiness'] as const,
            'phase',
          ),
        }),
  };
}

function parseEndIntervention(value: unknown): EndInterventionCommandV1 {
  const record = strictRecord(value, 'EndInterventionCommand', [
    'interventionSessionId', 'reason',
  ]);
  return {
    interventionSessionId: identifier(record['interventionSessionId'], 'interventionSessionId'),
    reason: enumValue(record['reason'], ['verified', 'cancelled', 'timed_out'] as const, 'reason'),
  };
}

export class SupervisorRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SupervisorRpcError';
  }
}

function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be an object.`, false);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length !== 0) {
    throw new SupervisorRpcError(
      'RPC_UNKNOWN_FIELD',
      `${path} contains unknown fields: ${unknown.sort().join(', ')}.`,
      false,
    );
  }
  return record;
}

function emptyObject(value: unknown, path: string): void {
  strictRecord(value, path, []);
}

function identifier(value: unknown, path: string): string {
  const normalized = boundedString(value, path, 256);
  if (normalized === '.' || normalized === '..' || !/^[A-Za-z0-9._:@/-]+$/u.test(normalized)) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} is not a safe identifier.`, false);
  }
  return normalized;
}

function nullableIdentifier(value: unknown, path: string): string | null {
  return value === null ? null : identifier(value, path);
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be a non-empty bounded string.`, false);
  }
  return value.trim();
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be a SHA-256 hex digest.`, false);
  }
  return value;
}

function nullableHash(value: unknown, path: string): string | null {
  return value === null ? null : hash(value, path);
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be an ISO timestamp.`, false);
  }
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be a positive integer.`, false);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be a non-negative integer.`, false);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : nonNegativeInteger(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SupervisorRpcError('RPC_CONTRACT_INVALID', `${path} must be boolean.`, false);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new SupervisorRpcError(
      'RPC_METHOD_NOT_ALLOWED',
      `${path} must be one of ${values.join(', ')}.`,
      false,
    );
  }
  return value as T[number];
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) {
    throw new SupervisorRpcError('RPC_VERSION_UNSUPPORTED', `${path} must equal ${expected}.`, false);
  }
}

function equal(left: unknown, right: unknown, field: string): void {
  if (left !== right) {
    throw new SupervisorRpcError('RPC_BINDING_MISMATCH', `${field} does not match.`, false);
  }
}

function assertFenceEqual(left: LeaseFenceV1, right: LeaseFenceV1, name: string): void {
  if (
    left.leaseId !== right.leaseId
    || left.generation !== right.generation
    || left.fencingToken !== right.fencingToken
    || left.leaseNotAfter !== right.leaseNotAfter
  ) {
    throw new SupervisorRpcError('STALE_FENCE', `${name} fence does not match.`, false);
  }
}
