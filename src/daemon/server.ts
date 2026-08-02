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
  getSharedContext,
  getSharedContextStatus,
  releaseSharedContext,
  runOnSharedCtx,
} from '../session/shared.js';
import { loadExecutor } from '../session/dispatch.js';
import { CliError } from '../io/errors.js';
import { throttle } from './throttle.js';
import type { Request, Response } from './protocol.js';
import {
  SUPERVISOR_RPC_MAX_FRAME_BYTES,
  SUPERVISOR_RPC_SCHEMA,
  SUPERVISOR_RPC_RESPONSE_SCHEMA,
  SUPERVISOR_EXECUTION_RENEWAL_SCHEMA,
  SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_SCHEMA,
  SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA,
  LEGACY_SUPERVISOR_RPC_SCHEMA,
  LEGACY_SUPERVISOR_EXECUTION_RENEWAL_SCHEMA,
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
import pkg from '../../package.json' with { type: 'json' };

export interface ServerOpts {
  profile?: string;
  idleTimeoutMs?: number;
  prewarm?: boolean;
  headful?: boolean;
  supervisorRuntime?: ProfileDaemonRuntime;
  pageActionVerification?: PageActionVerificationConfigV1;
  legacyRollback?: true;
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

const DAEMON_BLOCKED_COMMANDS = new Set(['checkout-confirm']);

let activeClients = 0;
let lastActivityMs = Date.now();
let server: net.Server | null = null;
let shuttingDown = false;
let activeManagedRuntime: ProfileDaemonRuntime | null = null;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

export async function start(opts: ServerOpts = {}): Promise<void> {
  if ((opts.supervisorRuntime === undefined) === (opts.legacyRollback !== true)) {
    throw new Error(
      'Daemon startup requires exactly one managed Supervisor runtime or legacyRollback=true.',
    );
  }
  const profile = defaultProfileName(opts.profile);
  const idleMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
  await ensureRoot();
  await ensureProfileRuntimeDir(profile);
  stats.profile = profile;
  activeManagedRuntime = opts.supervisorRuntime ?? null;

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

  if (opts.supervisorRuntime !== undefined) {
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
  } else if (opts.prewarm) {
    log('prewarming Chromium...');
    await getSharedContext(profile, { headful: opts.headful === true });
    log('Chromium ready');
  }

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

  const idleTimer = setInterval(() => {
    if (
      opts.supervisorRuntime === undefined &&
      !shuttingDown &&
      activeClients === 0 &&
      Date.now() - lastActivityMs > idleMs
    ) {
      log(`idle for ${Math.round(idleMs / 60000)}min — shutting down`);
      void shutdown(profile);
    }
  }, 10_000);
  idleTimer.unref();

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
      let req: Request | ParsedSupervisorRpcRequestV2;
      let supervisorRequest = false;
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
            === SUPERVISOR_REMOTE_ATTEMPT_ADMISSION_RESPONSE_SCHEMA
        ) {
          if (opts.supervisorRuntime === undefined) {
            throw new SupervisorRpcError(
              'SUPERVISOR_RUNTIME_DISABLED',
              'Legacy rollback daemons accept no Supervisor protocol frames.',
              false,
            );
          }
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
            === SUPERVISOR_EXECUTION_RENEWAL_SCHEMA
        ) {
          if (
            opts.supervisorRuntime === undefined
            || opts.pageActionVerification === undefined
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
          && ((parsed as Record<string, unknown>)['schema'] === LEGACY_SUPERVISOR_RPC_SCHEMA
            || (parsed as Record<string, unknown>)['schema']
              === LEGACY_SUPERVISOR_EXECUTION_RENEWAL_SCHEMA)
        ) {
          throw new SupervisorRpcError(
            'RPC_VERSION_UNSUPPORTED',
            opts.supervisorRuntime === undefined
              ? 'Legacy rollback daemons accept no Supervisor protocol frames.'
              : 'Supervisor-managed daemons accept only Supervisor protocol v2.',
            false,
          );
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
            opts.supervisorRuntime === undefined
            || opts.pageActionVerification === undefined
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
          supervisorRequest = true;
        } else {
          if (opts.supervisorRuntime !== undefined) {
            throw new SupervisorRpcError(
              'SUPERVISOR_RPC_REQUIRED',
              'Supervisor-managed daemons accept only Supervisor protocol v2.',
              false,
            );
          }
          const schema = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)['schema']
            : undefined;
          if (typeof schema === 'string' && schema.startsWith('profile-supervisor.')) {
            throw new SupervisorRpcError(
              'SUPERVISOR_RUNTIME_DISABLED',
              'Legacy rollback daemons accept no Supervisor protocol frames.',
              false,
            );
          }
          req = parseLegacyRequest(parsed);
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
      const response = supervisorRequest
        ? handleSupervisorRequest(
            opts.supervisorRuntime!,
            req as ParsedSupervisorRpcRequestV2,
            opts.profile,
            (req as ParsedSupervisorRpcRequestV2).method === 'collector.pageAction.execute'
              ? {
                  authorize: (input) => requestRemoteAttemptAdmission({
                    sock,
                    pendingAdmissions,
                    rpcId: (req as ParsedSupervisorRpcRequestV2).rpcId,
                    deadlineAt: (req as ParsedSupervisorRpcRequestV2).deadlineAt,
                    transportAuthority:
                      (req as ParsedSupervisorRpcRequestV2).binding.transportAuthority,
                    parentCanonicalRequestHash: canonicalAuthorizedRequestHashV2(
                      req as ParsedSupervisorRpcRequestV2,
                    ),
                    input,
                  }),
                }
              : undefined,
          )
        : handleRequest(req as Request, opts.supervisorRuntime !== undefined);
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
    activeClients--;
    lastActivityMs = Date.now();
  });
}

async function handleSupervisorRequest(
  runtime: ProfileDaemonRuntime,
  request: ParsedSupervisorRpcRequestV2,
  profile?: string,
  remoteAttemptAdmission?: {
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

function parseLegacyRequest(value: unknown): Request {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Legacy daemon request must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string'
    || record['id'].length === 0
    || typeof record['cmd'] !== 'string'
    || record['cmd'].length === 0
    || !Object.hasOwn(record, 'args')
  ) {
    throw new TypeError('Legacy daemon request requires id, cmd, and args.');
  }
  return { id: record['id'], cmd: record['cmd'], args: record['args'] };
}

async function handleRequest(req: Request, supervisorManaged: boolean): Promise<Response> {
  lastActivityMs = Date.now();
  stats.lastRequestAt = new Date().toISOString();
  stats.commandCount++;
  try {
    if (supervisorManaged) {
      throw new CliError(
        20,
        'SUPERVISOR_RPC_REQUIRED',
        'Supervisor-managed daemons reject legacy command dispatch.',
      );
    }
    if (req.cmd === 'status') {
      const browser = await getSharedContextStatus();
      return {
        id: req.id,
        ok: true,
        data: {
          ...stats,
          uptimeMs: Date.now() - new Date(stats.startedAt).getTime(),
          activeClients,
          browser,
        },
      };
    }
    if (req.cmd === 'shutdown') {
      setTimeout(() => void shutdown(stats.profile), 50);
      return { id: req.id, ok: true, data: { stopping: true } };
    }
    if (DAEMON_BLOCKED_COMMANDS.has(req.cmd)) {
      throw new CliError(
        20,
        'DAEMON_COMMAND_DISABLED',
        `${req.cmd} must run through the CLI confirmation path, not the daemon socket.`,
      );
    }
    await enforceHealthPause();
    await throttle(req.cmd);
    const fn = await loadExecutor<unknown, unknown>(req.cmd);
    const data = await runOnSharedCtx((ctx) => fn(ctx, req.args), {
      requestId: req.id,
      cmd: req.cmd,
      args: req.args,
    }, stats.profile);
    recordSuccess();
    return { id: req.id, ok: true, data };
  } catch (e) {
    stats.lastError = (e as Error).message ?? String(e);
    recordFailure(e);
    if (e instanceof CliError) {
      return {
        id: req.id,
        ok: false,
        exitCode: e.exitCode,
        code: e.code,
        message: e.message,
        details: e.details,
      };
    }
    return {
      id: req.id,
      ok: false,
      exitCode: 1,
      code: 'INTERNAL',
      message: (e as Error).message ?? String(e),
    };
  }
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

async function enforceHealthPause(): Promise<void> {
  const pausedUntil = stats.health.pausedUntil;
  if (!pausedUntil) return;
  const until = new Date(pausedUntil).getTime();
  if (!Number.isFinite(until) || Date.now() >= until) {
    stats.health.pausedUntil = null;
    return;
  }
  throw new CliError(
    9,
    'DAEMON_PAUSED',
    `Daemon for profile "${stats.profile}" is paused until ${pausedUntil} after repeated 1688 failures.`,
    {
      category: 'daemon_health',
      recoverHint: `Wait for the pause to expire, or run \`1688 daemon reload --profile ${stats.profile}\` after manually resolving login/risk-control issues.`,
      retryable: true,
      pausedUntil,
      failureKind: stats.health.lastFailureKind,
      recoveryAction: stats.health.lastRecoveryAction,
    },
  );
}

function recordSuccess(): void {
  stats.health.consecutiveFailures = 0;
  stats.health.consecutiveRateLimits = 0;
  stats.health.lastSuccessfulActionAt = new Date().toISOString();
  stats.health.pausedUntil = null;
}

function detailString(e: unknown, key: string): string | null {
  if (!(e instanceof CliError)) return null;
  const v = e.details[key];
  return typeof v === 'string' ? v : null;
}

function recordFailure(e: unknown): void {
  if (e instanceof CliError && e.code === 'DAEMON_PAUSED') return;

  stats.health.consecutiveFailures++;
  const pageState = detailString(e, 'pageState');
  const failureKind = detailString(e, 'failureKind');
  const recoveryAction = detailString(e, 'recoveryAction');
  if (pageState) stats.health.lastPageState = pageState;
  if (failureKind) stats.health.lastFailureKind = failureKind;
  if (recoveryAction) stats.health.lastRecoveryAction = recoveryAction;

  if (failureKind === 'rate_limited' || (e instanceof CliError && e.code === 'RATE_LIMITED')) {
    stats.health.consecutiveRateLimits++;
  } else if (failureKind && failureKind !== 'rate_limited') {
    stats.health.consecutiveRateLimits = 0;
  }

  const now = Date.now();
  if (failureKind === 'rate_limited' && stats.health.consecutiveRateLimits >= 2) {
    stats.health.pausedUntil = new Date(now + 5 * 60_000).toISOString();
  } else if (failureKind === 'risk_challenge' || failureKind === 'not_logged_in') {
    stats.health.pausedUntil = new Date(now + 10 * 60_000).toISOString();
  } else if (stats.health.consecutiveFailures >= 5) {
    stats.health.pausedUntil = new Date(now + 2 * 60_000).toISOString();
  }
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
