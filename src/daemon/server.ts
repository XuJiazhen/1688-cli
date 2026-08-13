import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  defaultProfileName,
  socketPath,
  pidFile,
  daemonVersionFile,
  ensureRoot,
  ensureProfileRuntimeDir,
} from '../session/paths.js';
import {
  releaseSharedContext,
} from '../session/shared.js';
import { CliError } from '../io/errors.js';
import {
  SUPERVISOR_RPC_MAX_FRAME_BYTES,
  SUPERVISOR_RPC_SCHEMA,
  SUPERVISOR_RPC_RESPONSE_SCHEMA,
  SUPERVISOR_EXECUTION_RENEWAL_SCHEMA,
  SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_SCHEMA,
  SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA,
  SupervisorRpcError,
  canonicalAuthorizedRequestHashV2,
  parseExecutionRenewalFrame,
  parseRemoteAttemptAdmissionResponseFrame,
  parseSupervisorRpcRequest,
  type ParsedSupervisorRpcRequestV2,
  type RemoteAttemptAdmissionReceiptV2,
  type RemoteAttemptAdmissionRequestV2,
  type SupervisorRpcResponseV2,
  type TransportAuthorityV2,
} from './supervisor-rpc.js';
import type { PageActionVerificationConfigV1 } from '../collection/page-action-contracts.js';
import type { ProfileDaemonRuntime } from './supervisor-runtime.js';
import {
  PRODUCTION_COLLECTION_RPC_SCHEMA,
  PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
  PRODUCTION_COLLECTION_RUNTIME_ADMISSION_RESPONSE_SCHEMA,
  PRODUCTION_COLLECTION_RUNTIME_ADMISSION_SCHEMA,
  ProductionCollectionProtocolError,
  parseProductionCollectionRpcRequestV1,
  productionCollectionRequestHashV1,
  productionCollectionRpcFailureV1,
} from './production-collection-protocol.js';
import type { ProductionCollectionRuntime } from './production-collection-runtime.js';
import pkg from '../../package.json' with { type: 'json' };

export interface ServerOpts {
  profile?: string;
  idleTimeoutMs?: number;
  prewarm?: boolean;
  headful?: boolean;
  supervisorRuntime: ProfileDaemonRuntime;
  productionCollectionRuntime: ProductionCollectionRuntime;
  pageActionVerification?: PageActionVerificationConfigV1;
}

interface DaemonHealth {
  lastPageState: string | null;
  lastFailureKind: string | null;
  lastRecoveryAction: string | null;
  consecutiveFailures: number;
  consecutiveRateLimits: number;
  lastSuccessfulActionAt: string | null;
  contextRecreatedAt: string | null;
  pausedUntil: string | null;
}

interface ServerStats {
  profile: string;
  version: string;
  startedAt: string;
  pid: number;
  commandCount: number;
  lastRequestAt: string | null;
  lastError: string | null;
  health: DaemonHealth;
}

const stats: ServerStats = {
  profile: 'default',
  version: pkg.version,
  startedAt: new Date().toISOString(),
  pid: process.pid,
  commandCount: 0,
  lastRequestAt: null,
  lastError: null,
  health: {
    lastPageState: null,
    lastFailureKind: null,
    lastRecoveryAction: null,
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    lastSuccessfulActionAt: null,
    contextRecreatedAt: null,
    pausedUntil: null,
  },
};

let activeClients = 0;
let lastActivityMs = Date.now();
let server: net.Server | null = null;
let shuttingDown = false;
let activeManagedRuntime: ProfileDaemonRuntime | null = null;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

export async function start(opts: ServerOpts): Promise<void> {
  const profile = defaultProfileName(opts.profile);
  await ensureRoot();
  await ensureProfileRuntimeDir(profile);
  stats.profile = profile;
  activeManagedRuntime = opts.supervisorRuntime;

  // Clean any stale socket. If pidfile points to a live process, refuse.
  await refuseIfAlive(profile);
  // Windows named pipes have no filesystem entry — skip the unlink.
  if (process.platform !== 'win32') {
    try {
      await fs.unlink(socketPath(profile));
    } catch {
      /* not present, fine */
    }
  }

  await fs.writeFile(pidFile(profile), String(process.pid), { mode: 0o600 });
  await fs.writeFile(daemonVersionFile(profile), pkg.version, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await Promise.all([
      fs.chmod(pidFile(profile), 0o600),
      fs.chmod(daemonVersionFile(profile), 0o600),
    ]);
  }

  log(`profile ${profile}, pid ${process.pid}, socket ${socketPath(profile)}`);

  log('warming Supervisor-managed headful Chromium...');
  const managedStatus = await opts.supervisorRuntime.ensureWarm();
  await fs.writeFile(
    managedOwnerFile(profile),
    JSON.stringify({
        profileId: managedStatus.profileId,
        profileName: managedStatus.profileName,
        daemonInstanceId: managedStatus.daemonInstanceId,
        supervisorGeneration: managedStatus.supervisorGeneration,
        contextGeneration: managedStatus.contextGeneration,
        transportAuthority: managedStatus.transportAuthority,
        daemonPid: process.pid,
        chromiumPid: managedStatus.chromiumPid,
        daemonProcessIdentity: await processStartIdentity(process.pid),
        chromiumProcessIdentity: managedStatus.chromiumPid === null
          ? null
          : await processStartIdentity(managedStatus.chromiumPid),
        headful: managedStatus.headful,
        writtenAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  log('Supervisor-managed Chromium ready');

  server = net.createServer((sock) => handleClient(sock, opts));
  const previousUmask = process.platform === 'win32' ? null : process.umask(0o177);
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (previousUmask !== null) process.umask(previousUmask);
      reject(error);
    };
    server!.once('error', fail);
    server!.listen(socketPath(profile), () => {
      server!.off('error', fail);
      if (previousUmask !== null) process.umask(previousUmask);
      resolve();
    });
  });
  log('listening');

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const handler = () => {
      log(`received ${sig}`);
      void shutdown(profile);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

function handleClient(sock: net.Socket, opts: ServerOpts): void {
  activeClients++;
  lastActivityMs = Date.now();
  sock.setEncoding('utf8');
  let buf = '';
  const pendingAdmissions = new Map<string, {
    rpcId: string;
    transportAuthority: TransportAuthorityV2;
    parentCanonicalRequestHash: string;
    resolve(receipt: RemoteAttemptAdmissionReceiptV2): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const pendingCollectionAdmissions = new Map<string, {
    rpcId: string;
    requestHash: string;
    resolve(receipt: {
      runtimeAdmissionReceiptId: string;
      requestHash: string;
      admittedAt: string;
    }): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (Buffer.byteLength(buf) > SUPERVISOR_RPC_MAX_FRAME_BYTES) {
      sock.write(JSON.stringify({
        id: '?',
        ok: false,
        exitCode: 2,
        code: 'RPC_FRAME_TOO_LARGE',
        message: `Request exceeds ${SUPERVISOR_RPC_MAX_FRAME_BYTES} bytes.`,
      }) + '\n');
      sock.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: ParsedSupervisorRpcRequestV2;
      let candidateRpcId = '?';
      let candidateCanonicalRequestHash = '0'.repeat(64);
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const parsedRecord = parsed as Record<string, unknown>;
          if (typeof parsedRecord['rpcId'] === 'string') {
            candidateRpcId = parsedRecord['rpcId'];
          }
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>)['schema']
            === PRODUCTION_COLLECTION_RUNTIME_ADMISSION_RESPONSE_SCHEMA
        ) {
          const frame = parsed as Record<string, unknown>;
          const admissionId = typeof frame['admissionId'] === 'string'
            ? frame['admissionId'] : '';
          const rpcId = typeof frame['rpcId'] === 'string' ? frame['rpcId'] : '';
          const pending = pendingCollectionAdmissions.get(admissionId);
          if (pending === undefined || pending.rpcId !== rpcId) {
            throw new ProductionCollectionProtocolError(
              'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_UNEXPECTED',
              'Runtime admission response does not match an active execution.',
              false,
              'fencing',
            );
          }
          clearTimeout(pending.timer);
          pendingCollectionAdmissions.delete(admissionId);
          if (frame['ok'] === true) {
            const receipt = frame['receipt'];
            if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
              throw new ProductionCollectionProtocolError(
                'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_INVALID',
                'Runtime admission response receipt is invalid.',
                false,
                'fencing',
              );
            }
            const record = receipt as Record<string, unknown>;
            if (
              typeof record['runtimeAdmissionReceiptId'] !== 'string'
              || record['requestHash'] !== pending.requestHash
              || typeof record['admittedAt'] !== 'string'
            ) {
              throw new ProductionCollectionProtocolError(
                'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_MISMATCH',
                'Runtime admission response authority differs from the execution.',
                false,
                'fencing',
              );
            }
            pending.resolve({
              runtimeAdmissionReceiptId: record['runtimeAdmissionReceiptId'],
              requestHash: record['requestHash'],
              admittedAt: record['admittedAt'],
            });
          } else {
            pending.reject(new ProductionCollectionProtocolError(
              'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_REJECTED',
              'Current database Runtime authority rejected execution.',
              false,
              'fencing',
            ));
          }
          continue;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>)['schema']
            === SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA
        ) {
          const response = parseRemoteAttemptAdmissionResponseFrame(parsed);
          const pending = pendingAdmissions.get(response.admissionId);
          if (pending === undefined || pending.rpcId !== response.rpcId) {
            throw new SupervisorRpcError(
              'REMOTE_ATTEMPT_ADMISSION_RESPONSE_UNEXPECTED',
              'Remote-attempt admission response does not match an active challenge.',
              false,
            );
          }
          clearTimeout(pending.timer);
          pendingAdmissions.delete(response.admissionId);
          if (response.ok) {
            if (
              canonicalAuthority(response.receipt.transportAuthority)
                !== canonicalAuthority(pending.transportAuthority)
              || response.receipt.parentCanonicalRequestHash
                !== pending.parentCanonicalRequestHash
            ) {
              const mismatch = new SupervisorRpcError(
                'REMOTE_ATTEMPT_ADMISSION_RESPONSE_MISMATCH',
                'Admission receipt authority or parent request hash differs.',
                false,
              );
              pending.reject(mismatch);
              throw mismatch;
            }
            pending.resolve(response.receipt);
          } else {
            pending.reject(new SupervisorRpcError(
              response.error.code,
              response.error.message,
              response.error.retryable,
            ));
          }
          continue;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>)['schema']
            === PRODUCTION_COLLECTION_RPC_SCHEMA
        ) {
          let collectionRequest;
          try {
            collectionRequest = parseProductionCollectionRpcRequestV1(parsed);
          } catch (error) {
            const rpcId = typeof (parsed as Record<string, unknown>)['rpcId'] === 'string'
              ? (parsed as Record<string, unknown>)['rpcId'] as string
              : '?';
            const requestHash = '0'.repeat(64);
            const failure = productionCollectionRpcFailureV1({
              rpcId,
              requestHash,
              error: error instanceof ProductionCollectionProtocolError
                ? error
                : new ProductionCollectionProtocolError(
                    'PRODUCTION_COLLECTION_CONTRACT_INVALID',
                    'Invalid production collection request frame.',
                  ),
            });
            sock.write(`${JSON.stringify(failure)}\n`);
            continue;
          }
          const response = opts.productionCollectionRuntime.handle(
            collectionRequest,
            collectionRequest.method === 'production.collection.execute'
              ? (request, requestHash) => requestProductionCollectionRuntimeAdmission({
                  sock,
                  pendingAdmissions: pendingCollectionAdmissions,
                  request,
                  requestHash,
                })
              : undefined,
          );
          void response.then((value) => {
            if (sock.writable) sock.write(`${JSON.stringify(value)}\n`);
          }).catch((error) => {
            if (!sock.writable) return;
            sock.write(`${JSON.stringify({
              schema: PRODUCTION_COLLECTION_RPC_RESPONSE_SCHEMA,
              rpcId: collectionRequest.rpcId,
              requestHash: productionCollectionRequestHashV1(collectionRequest),
              ok: false,
              error: {
                code: 'PRODUCTION_COLLECTION_RUNTIME_FAILED',
                message: error instanceof Error ? error.message : 'Runtime failed.',
                retryable: true,
                category: 'runtime',
              },
            })}\n`);
          });
          continue;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>)['schema']
            === SUPERVISOR_EXECUTION_RENEWAL_SCHEMA
        ) {
          if (
            opts.pageActionVerification === undefined
          ) {
            throw new SupervisorRpcError(
              'SUPERVISOR_RUNTIME_DISABLED',
              'This daemon was not started by a Profile Supervisor.',
              false,
            );
          }
          const renewal = parseExecutionRenewalFrame(parsed, {
            verification: opts.pageActionVerification,
          });
          void opts.supervisorRuntime.renewExecution(
            renewal.rpcId,
            renewal.request,
          ).catch((error) => {
            if (sock.writable) {
              sock.write(JSON.stringify(supervisorFailure(
                renewal.rpcId,
                canonicalAuthorizedRequestHashV2(renewal.request),
                error instanceof SupervisorRpcError
                  ? error
                  : new SupervisorRpcError(
                      'EXECUTION_RENEWAL_FAILED',
                      error instanceof Error ? error.message : 'Execution renewal failed.',
                      true,
                    ),
              )) + '\n');
            }
          });
          continue;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && typeof (parsed as Record<string, unknown>)['rpcId'] === 'string'
        ) {
          candidateRpcId = (parsed as Record<string, unknown>)['rpcId'] as string;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>)['schema']
            === SUPERVISOR_RPC_SCHEMA
        ) {
          if (
            opts.pageActionVerification === undefined
          ) {
            throw new SupervisorRpcError(
              'SUPERVISOR_RUNTIME_DISABLED',
              'This daemon was not started by a Profile Supervisor.',
              false,
            );
          }
          req = parseSupervisorRpcRequest(parsed, {
            verification: opts.pageActionVerification,
          });
          candidateCanonicalRequestHash = canonicalAuthorizedRequestHashV2(req);
        } else {
          throw new SupervisorRpcError(
            'SUPERVISOR_RPC_REQUIRED',
            'Managed daemons accept only fenced Supervisor protocol v2.',
            false,
          );
        }
      } catch (error) {
        if (error instanceof SupervisorRpcError) {
          sock.write(JSON.stringify(supervisorFailure(
            candidateRpcId,
            candidateCanonicalRequestHash,
            error,
          )) + '\n');
          continue;
        }
        sock.write(
          JSON.stringify({
            id: '?',
            ok: false,
            exitCode: 1,
            code: 'BAD_REQUEST',
            message: 'invalid request frame',
          }) + '\n',
        );
        continue;
      }
      const response = handleSupervisorRequest(
            opts.supervisorRuntime,
            req,
            opts.profile,
            req.method === 'collector.pageAction.execute'
              ? {
                  transportAuthority:
                    req.binding.transportAuthority,
                  parentCanonicalRequestHash: canonicalAuthorizedRequestHashV2(
                    req,
                  ),
                  authorize: (input) => requestRemoteAttemptAdmission({
                    sock,
                    pendingAdmissions,
                    rpcId: req.rpcId,
                    deadlineAt: req.deadlineAt,
                    transportAuthority:
                      req.binding.transportAuthority,
                    parentCanonicalRequestHash: canonicalAuthorizedRequestHashV2(
                      req,
                    ),
                    input,
                  }),
                }
              : undefined,
          );
      void response.then((resp) => {
        if (!sock.writable) return;
        sock.write(JSON.stringify(resp) + '\n');
      });
    }
  });
  sock.on('error', () => {
    /* swallow client errors */
  });
  sock.on('close', () => {
    for (const pending of pendingAdmissions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SupervisorRpcError(
        'REMOTE_ATTEMPT_ADMISSION_CHANNEL_CLOSED',
        'Supervisor admission channel closed before database authority was granted.',
        true,
      ));
    }
    pendingAdmissions.clear();
    for (const pending of pendingCollectionAdmissions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_CHANNEL_CLOSED',
        'Runtime admission channel closed before database authority was granted.',
        true,
        'network',
      ));
    }
    pendingCollectionAdmissions.clear();
    activeClients--;
    lastActivityMs = Date.now();
  });
}

async function handleSupervisorRequest(
  runtime: ProfileDaemonRuntime,
  request: ParsedSupervisorRpcRequestV2,
  profile?: string,
  remoteAttemptAdmission?: {
    transportAuthority: TransportAuthorityV2;
    parentCanonicalRequestHash: string;
    authorize(input: RemoteAttemptAdmissionRequestV2): Promise<RemoteAttemptAdmissionReceiptV2>;
  },
): Promise<SupervisorRpcResponseV2> {
  const response = await runtime.handle(request, { remoteAttemptAdmission });
  if (request.method === 'supervisor.restart' && response.ok) {
    await persistManagedOwner(defaultProfileName(profile), runtime.status());
  }
  return response;
}

function requestRemoteAttemptAdmission(input: {
  sock: net.Socket;
  pendingAdmissions: Map<string, {
    rpcId: string;
    transportAuthority: TransportAuthorityV2;
    parentCanonicalRequestHash: string;
    resolve(receipt: RemoteAttemptAdmissionReceiptV2): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  rpcId: string;
  deadlineAt: string;
  transportAuthority: TransportAuthorityV2;
  parentCanonicalRequestHash: string;
  input: RemoteAttemptAdmissionRequestV2;
}): Promise<RemoteAttemptAdmissionReceiptV2> {
  if (!input.sock.writable) {
    return Promise.reject(new SupervisorRpcError(
      'REMOTE_ATTEMPT_ADMISSION_CHANNEL_CLOSED',
      'Supervisor admission channel is unavailable.',
      true,
    ));
  }
  const remainingMs = Date.parse(input.deadlineAt) - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new SupervisorRpcError(
      'REMOTE_ATTEMPT_ADMISSION_DEADLINE_EXCEEDED',
      'Remote-attempt admission deadline has expired.',
      true,
    ));
  }
  const admissionId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.pendingAdmissions.delete(admissionId);
      reject(new SupervisorRpcError(
        'REMOTE_ATTEMPT_ADMISSION_TIMEOUT',
        'Database authority did not answer the remote-attempt admission challenge.',
        true,
      ));
    }, remainingMs);
    timer.unref();
    input.pendingAdmissions.set(admissionId, {
      rpcId: input.rpcId,
      transportAuthority: input.transportAuthority,
      parentCanonicalRequestHash: input.parentCanonicalRequestHash,
      resolve,
      reject,
      timer,
    });
    try {
      input.sock.write(`${JSON.stringify({
        schema: SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_SCHEMA,
        rpcId: input.rpcId,
        admissionId,
        deadlineAt: input.deadlineAt,
        transportAuthority: input.transportAuthority,
        parentCanonicalRequestHash: input.parentCanonicalRequestHash,
        request: input.input,
      })}\n`);
    } catch (error) {
      clearTimeout(timer);
      input.pendingAdmissions.delete(admissionId);
      reject(new SupervisorRpcError(
        'REMOTE_ATTEMPT_ADMISSION_CHANNEL_CLOSED',
        error instanceof Error ? error.message : 'Supervisor admission channel write failed.',
        true,
      ));
    }
  });
}

function requestProductionCollectionRuntimeAdmission(input: {
  sock: net.Socket;
  pendingAdmissions: Map<string, {
    rpcId: string;
    requestHash: string;
    resolve(receipt: {
      runtimeAdmissionReceiptId: string;
      requestHash: string;
      admittedAt: string;
    }): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  request: import('./production-collection-protocol.js').ProductionCollectionRpcRequestV1;
  requestHash: string;
}): Promise<{
  runtimeAdmissionReceiptId: string;
  requestHash: string;
  admittedAt: string;
}> {
  const remainingMs = Date.parse(input.request.deadlineAt) - Date.now();
  if (!input.sock.writable || remainingMs <= 0) {
    return Promise.reject(new ProductionCollectionProtocolError(
      'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_UNAVAILABLE',
      'Runtime admission channel or execution deadline is unavailable.',
      true,
      'fencing',
    ));
  }
  const admissionId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.pendingAdmissions.delete(admissionId);
      reject(new ProductionCollectionProtocolError(
        'PRODUCTION_COLLECTION_RUNTIME_ADMISSION_TIMEOUT',
        'Database Runtime authority did not answer before the execution deadline.',
        true,
        'timeout',
      ));
    }, remainingMs);
    timer.unref();
    input.pendingAdmissions.set(admissionId, {
      rpcId: input.request.rpcId,
      requestHash: input.requestHash,
      resolve,
      reject,
      timer,
    });
    input.sock.write(`${JSON.stringify({
      schema: PRODUCTION_COLLECTION_RUNTIME_ADMISSION_SCHEMA,
      rpcId: input.request.rpcId,
      admissionId,
      deadlineAt: input.request.deadlineAt,
      requestHash: input.requestHash,
      attemptId: input.request.attemptId,
      executionToken: input.request.executionToken,
      workItemId: input.request.workItemId,
      profileId: input.request.profileId,
      supervisorLeaseId: input.request.supervisorLeaseId,
      supervisorGeneration: input.request.supervisorGeneration,
      supervisorFencingToken: input.request.supervisorFencingToken,
      daemonInstanceId: input.request.daemonInstanceId,
      contextGeneration: input.request.contextGeneration,
      runtimeHostId: input.request.runtimeHostId,
    })}\n`);
  });
}

async function persistManagedOwner(
  profile: string,
  status: ReturnType<ProfileDaemonRuntime['status']>,
): Promise<void> {
  await fs.writeFile(
    managedOwnerFile(profile),
    JSON.stringify({
      profileId: status.profileId,
      profileName: status.profileName,
      daemonInstanceId: status.daemonInstanceId,
      supervisorGeneration: status.supervisorGeneration,
      contextGeneration: status.contextGeneration,
      transportAuthority: status.transportAuthority,
      daemonPid: process.pid,
      chromiumPid: status.chromiumPid,
      daemonProcessIdentity: await processStartIdentity(process.pid),
      chromiumProcessIdentity: status.chromiumPid === null
        ? null
        : await processStartIdentity(status.chromiumPid),
      headful: status.headful,
      writtenAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}

function supervisorFailure(
  rpcId: string,
  canonicalRequestHash: string,
  error: SupervisorRpcError,
): SupervisorRpcResponseV2 {
  return {
    schema: SUPERVISOR_RPC_RESPONSE_SCHEMA,
    rpcId,
    canonicalRequestHash,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function canonicalAuthority(authority: TransportAuthorityV2): string {
  return JSON.stringify(authority);
}

async function refuseIfAlive(profile: string): Promise<void> {
  let pidStr: string;
  try {
    pidStr = await fs.readFile(pidFile(profile), 'utf8');
  } catch {
    return;
  }
  const pid = parseInt(pidStr.trim(), 10);
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, 0); // probe — throws if not alive
    throw new CliError(
      5,
      'DAEMON_RUNNING',
      `Daemon already running for profile "${profile}" (pid ${pid}). Use \`1688 daemon stop --profile ${profile}\` first.`,
    );
  } catch (e) {
    if ((e as CliError).code === 'DAEMON_RUNNING') throw e;
    // ESRCH — stale pidfile, ignore.
  }
}

async function shutdown(profile = stats.profile): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const clean = await drainManagedRuntime('process_shutdown', false, 120_000);
  if (!clean) {
    shuttingDown = false;
    setTimeout(() => void shutdown(profile), 1_000).unref();
    return;
  }
  await closeServer(profile);
  log('bye');
  process.exit(0);
}

async function closeServer(profile: string): Promise<void> {
  log(`shutting down profile ${profile}`);
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
  }
  await releaseSharedContext();
  if (process.platform !== 'win32') {
    try {
      await fs.unlink(socketPath(profile));
    } catch {
      /* ignore */
    }
  }
  try {
    await fs.unlink(pidFile(profile));
  } catch {
    /* ignore */
  }
  try {
    await fs.unlink(daemonVersionFile(profile));
  } catch {
    /* ignore */
  }
  try {
    await fs.unlink(managedOwnerFile(profile));
  } catch {
    /* ignore */
  }
}

/** Test-only close path for framed socket integration without terminating Vitest. */
export async function stopServerForTesting(profile = stats.profile): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('stopServerForTesting is available only under NODE_ENV=test.');
  }
  if (!shuttingDown) shuttingDown = true;
  await drainManagedRuntime('test_shutdown', true, 5_000);
  await closeServer(profile);
  removeSignalHandlers();
  server = null;
  shuttingDown = false;
  activeClients = 0;
  activeManagedRuntime = null;
}

async function drainManagedRuntime(
  reason: string,
  cancelInFlight: boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (activeManagedRuntime === null) return true;
  const receipt = await activeManagedRuntime.drain({
    reason,
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    cancelInFlight,
  }).catch(() => null);
  return receipt?.clean === true && receipt.activePageCount === 0;
}

function removeSignalHandlers(): void {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

const execFileAsync = promisify(execFile);

async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const started = stdout.trim();
    return started.length === 0
      ? null
      : createHash('sha256').update(`${pid}\0${started}`).digest('hex');
  } catch {
    return null;
  }
}

function log(msg: string): void {
  process.stderr.write(`[daemon ${new Date().toISOString()}] ${msg}\n`);
}

function managedOwnerFile(profile: string): string {
  return path.join(path.dirname(pidFile(profile)), 'daemon.owner.json');
}
