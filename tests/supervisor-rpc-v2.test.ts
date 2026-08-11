import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_RPC_SCHEMA,
  SUPERVISOR_PROTOCOL_SHA256_V2,
  canonicalAuthorizedRequestHashV2,
  parseRemoteAttemptAdmissionResponseFrame,
  parseSupervisorRpcResponseV2,
  parseSupervisorRpcRequest,
  type SupervisorRpcRequestV2,
  type TransportAuthorityV2,
  validateRpcBinding,
} from '../src/daemon/supervisor-rpc.js';

const verification = {
  keysById: {},
  routesById: {},
  expansionPoliciesByDispatchRevisionId: {},
};
const key = 'v10-supervisor-credential-key-at-least-32-bytes';

const authority: TransportAuthorityV2 = {
  mode: 'live_remote',
  liveAuthorizationId: '10000000-0000-4000-8000-000000000001',
  liveAuthorizationSha256: 'a'.repeat(64),
  cohortId: '10000000-0000-4000-8000-000000000003',
  collectionTaskId: '10000000-0000-4000-8000-000000000004',
  protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
};

function signedStatusRequest(): SupervisorRpcRequestV2<Record<string, never>> {
  const request: SupervisorRpcRequestV2<Record<string, never>> = {
    schema: SUPERVISOR_RPC_SCHEMA,
    rpcId: 'rpc-status-v2',
    method: 'supervisor.status',
    deadlineAt: '2099-08-03T12:05:00.000Z',
    binding: {
      profileId: '10000000-0000-4000-8000-000000000005',
      daemonInstanceId: '10000000-0000-4000-8000-000000000006',
      contextGeneration: 1,
      supervisor: {
        leaseId: '10000000-0000-4000-8000-000000000007',
        generation: 1,
        fencingToken: 'supervisor-fence-v2',
        leaseNotAfter: '2099-08-03T12:10:00.000Z',
      },
      reservation: null,
      workUnit: null,
      transportAuthority: authority,
      renewalCredential: null,
      controlCredential: null,
    },
    payload: {},
  };
  const payload = {
    schemaVersion: 2 as const,
    profileId: request.binding.profileId,
    daemonInstanceId: request.binding.daemonInstanceId,
    contextGeneration: request.binding.contextGeneration,
    supervisorLeaseId: request.binding.supervisor.leaseId,
    supervisorGeneration: request.binding.supervisor.generation,
    supervisorFenceDigest: createHash('sha256')
      .update(request.binding.supervisor.fencingToken)
      .digest('hex'),
    rpcId: request.rpcId,
    canonicalRequestHash: canonicalAuthorizedRequestHashV2(request),
    requestDeadlineAt: request.deadlineAt,
    issuedAt: '2099-08-03T11:59:00.000Z',
    credentialNotBefore: '2099-08-03T11:59:00.000Z',
    credentialExpiresAt: '2099-08-03T12:04:00.000Z',
    keyId: 'key-v2',
  };
  request.binding.controlCredential = {
    payload,
    algorithm: 'HMAC-SHA256',
    signature: createHmac('sha256', key).update(JSON.stringify(payload)).digest('base64url'),
  };
  return request;
}

describe('Profile Supervisor v2 wire contract', () => {
  it('preserves exact transport authority and binds credentials to the nonrecursive request hash', () => {
    const request = signedStatusRequest();
    const parsed = parseSupervisorRpcRequest(request, { verification });
    expect(parsed.schema).toBe('profile-supervisor.rpc.v2');
    expect(parsed.binding.transportAuthority).toEqual(authority);
    expect(parsed.binding.controlCredential?.payload.canonicalRequestHash)
      .toBe(canonicalAuthorizedRequestHashV2(parsed));
  });

  it('rejects every v1 frame and unknown authority field before payload normalization', () => {
    expect(() => parseSupervisorRpcRequest({
      ...signedStatusRequest(),
      schema: 'profile-supervisor.rpc.v1',
      payload: { neverNormalize: true },
    }, { verification })).toThrow(/profile-supervisor\.rpc\.v2/u);
    expect(() => parseSupervisorRpcRequest({
      ...signedStatusRequest(),
      binding: {
        ...signedStatusRequest().binding,
        transportAuthority: { ...authority, networkAllowed: false },
      },
    }, { verification })).toThrow(/unknown fields/u);
  });

  it('requires control-only binding for supervisor methods', () => {
    const request = signedStatusRequest();
    request.binding.reservation = { ...request.binding.supervisor };
    expect(() => parseSupervisorRpcRequest(request, { verification }))
      .toThrow(/null reservation and WorkUnit/u);
  });

  it('rejects any payload or authority change not covered by the signed request hash', () => {
    const request = parseSupervisorRpcRequest(signedStatusRequest(), { verification });
    expect(() => validateRpcBinding(request, {
      profileId: request.binding.profileId,
      daemonInstanceId: request.binding.daemonInstanceId,
      contextGeneration: 1,
      supervisorGeneration: 1,
      transportAuthority: authority,
      now: new Date('2099-08-03T12:00:00.000Z'),
    })).not.toThrow();
    request.binding.transportAuthority = {
      ...request.binding.transportAuthority,
      collectionTaskId: '10000000-0000-4000-8000-000000000099',
    };
    expect(() => validateRpcBinding(request, {
      profileId: request.binding.profileId,
      daemonInstanceId: request.binding.daemonInstanceId,
      contextGeneration: 1,
      supervisorGeneration: 1,
      transportAuthority: request.binding.transportAuthority,
      now: new Date('2099-08-03T12:00:00.000Z'),
    })).toThrow(/request hash/u);
  });

  it('strictly binds successful admission receipts to authority and parent request hash', () => {
    const parentCanonicalRequestHash = canonicalAuthorizedRequestHashV2(signedStatusRequest());
    const parsed = parseRemoteAttemptAdmissionResponseFrame({
      schema: 'profile-supervisor.remote-attempt-admission-response.v2',
      rpcId: 'rpc-execute-v2',
      admissionId: 'admission-v2',
      ok: true,
      receipt: {
        remoteActionStartId: '10000000-0000-4000-8000-000000000008',
        admittedAt: '2099-08-03T12:00:00.000Z',
        transportAuthority: authority,
        parentCanonicalRequestHash,
      },
    });
    expect(parsed.ok && parsed.receipt.transportAuthority).toEqual(authority);
    expect(parsed.ok && parsed.receipt.parentCanonicalRequestHash)
      .toBe(parentCanonicalRequestHash);
  });

  it('accepts only an exact response bound to the request id and hash', () => {
    const request = signedStatusRequest();
    const canonicalRequestHash = canonicalAuthorizedRequestHashV2(request);
    expect(parseSupervisorRpcResponseV2({
      schema: 'profile-supervisor.rpc-response.v2',
      rpcId: request.rpcId,
      canonicalRequestHash,
      ok: true,
      data: { state: 'warm' },
    }, { rpcId: request.rpcId, canonicalRequestHash })).toMatchObject({ ok: true });
    expect(() => parseSupervisorRpcResponseV2({
      schema: 'profile-supervisor.rpc-response.v2',
      rpcId: request.rpcId,
      canonicalRequestHash,
      ok: true,
      data: {},
      ignored: true,
    }, { rpcId: request.rpcId, canonicalRequestHash })).toThrow(/unknown fields/u);
  });
});
