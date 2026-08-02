import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultProfileName,
  pidFile,
  socketPath,
  daemonLogFile,
  daemonVersionFile,
  ensureRoot,
  ensureProfileRuntimeDir,
  lockFile,
} from '../session/paths.js';
import { daemonCall, isDaemonReachable } from './client.js';
import { CliError } from '../io/errors.js';
import { waitUntil } from '../session/wait.js';
import pkg from '../../package.json' with { type: 'json' };
import {
  parseTransportAuthorityV2,
  type TransportAuthorityV2,
} from './supervisor-rpc.js';

export interface DaemonStatus {
  profile: string;
  running: boolean;
  pid?: number;
  reachable?: boolean;
  version?: string | null;
  expectedVersion?: string;
  versionMatches?: boolean;
  stats?: unknown;
}

export interface ManagedDaemonIdentity {
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  supervisorGeneration: number;
  contextGeneration: number;
  transportAuthority: TransportAuthorityV2;
  daemonPid: number;
  chromiumPid: number;
  headful: true;
  writtenAt: string;
}

export async function status(profile?: string): Promise<DaemonStatus> {
  const profileName = defaultProfileName(profile);
  const pid = await readPid(profileName);
  const version = await readDaemonVersion(profileName);
  const expectedVersion = pkg.version;
  if (pid === null) {
    return {
      profile: profileName,
      running: false,
      version,
      expectedVersion,
      versionMatches: version === expectedVersion,
    };
  }
  const alive = isProcessAlive(pid);
  if (!alive) {
    return {
      profile: profileName,
      running: false,
      version,
      expectedVersion,
      versionMatches: version === expectedVersion,
    };
  }
  const reachable = await isDaemonReachable(profileName);
  let stats: unknown = undefined;
  if (reachable) {
    try {
      stats = await daemonCall('status', {}, undefined, profileName);
    } catch {
      /* ignore */
    }
  }
  const statsVersion =
    stats && typeof stats === 'object'
      ? (stats as { version?: unknown }).version
      : undefined;
  const resolvedVersion =
    typeof statsVersion === 'string' ? statsVersion : version;
  return {
    profile: profileName,
    running: true,
    pid,
    reachable,
    version: resolvedVersion,
    expectedVersion,
    versionMatches: resolvedVersion === expectedVersion,
    stats,
  };
}

export async function start(
  profile?: string,
): Promise<{ pid: number; profile: string }> {
  const profileName = defaultProfileName(profile);
  await ensureRoot();
  await ensureProfileRuntimeDir(profileName);
  const existing = await status(profileName);
  if (existing.running) {
    if (existing.versionMatches === false) {
      await stop(profileName);
    } else {
      throw new CliError(
        5,
        'DAEMON_RUNNING',
        `Daemon already running for profile "${profileName}" (pid ${existing.pid}).`,
      );
    }
  }

  // Locate the CLI entrypoint to re-exec as "1688 serve".
  // When installed via npm link, this module sits at dist/daemon/manager.js,
  // and the CLI is at dist/cli.js.
  const here = fileURLToPath(import.meta.url);
  const cliPath = path.join(path.dirname(here), '..', 'cli.js');

  // Detach from the parent; redirect output to a log file.
  const logFd = await fs.open(daemonLogFile(profileName), 'a');
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--profile', profileName, '--legacy-rollback'],
    {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: {
        ...process.env,
        BB1688_DAEMON_BG: '1',
        BB1688_LEGACY_ROLLBACK: '1',
      },
    },
  );
  child.unref();
  await logFd.close();

  const reachable = await waitUntil(() => isDaemonReachable(profileName), {
    timeoutMs: 15000,
    intervalMs: 250,
  });
  if (reachable) {
    const pid = (await readPid(profileName)) ?? child.pid ?? -1;
    return { pid, profile: profileName };
  }
  throw new CliError(
    9,
    'DAEMON_START_TIMEOUT',
    `Daemon for profile "${profileName}" did not start within 15s. Check ${daemonLogFile(profileName)}.`,
  );
}

export async function startManaged(
  configPath: string,
): Promise<{ pid: number; profile: string }> {
  const { loadManagedSupervisorConfig } = await import('./managed-bootstrap.js');
  const config = await loadManagedSupervisorConfig(configPath);
  const profileName = config.profileName;
  await ensureRoot();
  await ensureProfileRuntimeDir(profileName);
  const existingPid = await readPid(profileName);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new CliError(
      5,
      'DAEMON_RUNNING',
      `Daemon already running for profile "${profileName}" (pid ${existingPid}).`,
    );
  }
  const here = fileURLToPath(import.meta.url);
  const cliPath = path.join(path.dirname(here), '..', 'cli.js');
  const logFd = await fs.open(daemonLogFile(profileName), 'a');
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--profile', profileName, '--supervisor-config', configPath],
    {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: {
        ...process.env,
        BB1688_DAEMON_BG: '1',
        BB1688_SUPERVISOR_MANAGED: '1',
        BB1688_SUPERVISOR_CONFIG: configPath,
      },
    },
  );
  child.unref();
  await logFd.close();
  const reachable = await waitUntil(() => isDaemonReachable(profileName), {
    timeoutMs: 15_000,
    intervalMs: 250,
  });
  if (!reachable) {
    throw new CliError(
      9,
      'DAEMON_START_TIMEOUT',
      `Managed daemon for profile "${profileName}" did not start within 15s.`,
    );
  }
  const identity = await readManagedDaemonIdentity(profileName);
  if (
    identity === null
    || identity.profileId !== config.profileId
    || identity.daemonInstanceId !== config.daemonInstanceId
    || identity.supervisorGeneration !== config.supervisorGeneration
    || identity.contextGeneration !== config.contextGeneration
    || JSON.stringify(identity.transportAuthority)
      !== JSON.stringify(config.transportAuthority)
  ) {
    await isolateManagedDaemon({
      profileName,
      expectedDaemonInstanceId: config.daemonInstanceId,
      expectedDaemonPid: (await readPid(profileName)) ?? child.pid ?? -1,
    }).catch(() => {});
    throw new CliError(
      9,
      'DAEMON_OWNER_ARTIFACT_MISMATCH',
      'Managed daemon started with an unexpected owner identity.',
    );
  }
  return { pid: identity.daemonPid, profile: profileName };
}

export async function ensureFreshDaemon(profile?: string): Promise<{
  pid: number;
  profile: string;
  restarted: boolean;
}> {
  const profileName = defaultProfileName(profile);
  const existing = await status(profileName);
  if (!existing.running) {
    const started = await start(profileName);
    return { ...started, restarted: false };
  }

  if (existing.versionMatches === false) {
    await stop(profileName);
    const started = await start(profileName);
    return { ...started, restarted: true };
  }

  return { pid: existing.pid ?? -1, profile: profileName, restarted: false };
}

export async function stop(
  profile?: string,
): Promise<{ stopped: boolean; profile: string }> {
  const profileName = defaultProfileName(profile);
  const pid = await readPid(profileName);
  if (pid === null || !isProcessAlive(pid)) {
    await cleanupArtifacts(profileName);
    return { stopped: false, profile: profileName };
  }
  // Prefer asking via socket; fall back to SIGTERM.
  if (await isDaemonReachable(profileName)) {
    try {
      await daemonCall('shutdown', {}, undefined, profileName);
    } catch {
      /* will fall through to SIGTERM */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
  }
  await waitUntil(() => !isProcessAlive(pid), {
    timeoutMs: 10000,
    intervalMs: 200,
  });
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  await cleanupArtifacts(profileName);
  return { stopped: true, profile: profileName };
}

export async function cleanupLock(profile?: string): Promise<void> {
  if (await pathExists(lockFile(profile) + '.lock')) {
    throw new CliError(
      5,
      'LOCK_OWNERSHIP_UNPROVEN',
      'Refusing to delete a Profile lock without an exact exited owner proof.',
    );
  }
}

export async function readManagedDaemonIdentity(
  profile?: string,
): Promise<ManagedDaemonIdentity | null> {
  const profileName = defaultProfileName(profile);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(managedOwnerFile(profileName), 'utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(9, 'DAEMON_OWNER_ARTIFACT_INVALID', 'Managed daemon owner artifact is invalid.');
  }
  const record = value as Record<string, unknown>;
  const identity = {
    profileId: managedString(record['profileId'], 'profileId'),
    profileName: managedString(record['profileName'], 'profileName'),
    daemonInstanceId: managedString(record['daemonInstanceId'], 'daemonInstanceId'),
    supervisorGeneration: managedInteger(record['supervisorGeneration'], 'supervisorGeneration'),
    contextGeneration: managedInteger(record['contextGeneration'], 'contextGeneration'),
    transportAuthority: parseTransportAuthorityV2(record['transportAuthority']),
    daemonPid: managedInteger(record['daemonPid'], 'daemonPid'),
    chromiumPid: managedInteger(record['chromiumPid'], 'chromiumPid'),
    headful: record['headful'],
    writtenAt: managedString(record['writtenAt'], 'writtenAt'),
  };
  if (identity.profileName !== profileName || identity.headful !== true) {
    throw new CliError(
      9,
      'DAEMON_OWNER_ARTIFACT_MISMATCH',
      'Managed daemon owner artifact does not match the requested Profile/headful contract.',
    );
  }
  return identity as ManagedDaemonIdentity;
}

export async function isolateManagedDaemon(input: {
  profileName: string;
  expectedDaemonInstanceId: string;
  expectedDaemonPid: number;
  timeoutMs?: number;
}): Promise<{
  isolated: boolean;
  daemonInstanceId: string;
  daemonPid: number;
  isolatedAt: string;
}> {
  const identity = await readManagedDaemonIdentity(input.profileName);
  if (
    identity === null
    || identity.daemonInstanceId !== input.expectedDaemonInstanceId
    || identity.daemonPid !== input.expectedDaemonPid
  ) {
    throw new CliError(
      9,
      'DAEMON_ISOLATION_TARGET_MISMATCH',
      'Refusing to stop a daemon whose persisted identity differs from the observed orphan.',
    );
  }
  if (isProcessAlive(identity.daemonPid)) {
    process.kill(identity.daemonPid, 'SIGTERM');
    await waitUntil(() => !isProcessAlive(identity.daemonPid), {
      timeoutMs: input.timeoutMs ?? 10_000,
      intervalMs: 100,
    });
  }
  if (isProcessAlive(identity.daemonPid)) {
    throw new CliError(9, 'DAEMON_ISOLATION_FAILED', 'Orphan daemon did not exit before timeout.');
  }
  const lockReleased = await waitUntil(
    async () => !await pathExists(lockFile(input.profileName) + '.lock'),
    { timeoutMs: input.timeoutMs ?? 10_000, intervalMs: 100 },
  );
  if (!lockReleased) {
    throw new CliError(
      9,
      'DAEMON_LOCK_NOT_RELEASED',
      'Managed daemon exited without releasing its exact Profile lock; retaining quarantine.',
    );
  }
  await cleanupArtifacts(input.profileName);
  return {
    isolated: true,
    daemonInstanceId: identity.daemonInstanceId,
    daemonPid: identity.daemonPid,
    isolatedAt: new Date().toISOString(),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupArtifacts(profile?: string): Promise<void> {
  const profileName = defaultProfileName(profile);
  // Windows named pipes have no filesystem entry — skip the socket path.
  const targets =
    process.platform === 'win32'
      ? [pidFile(profileName), daemonVersionFile(profileName), managedOwnerFile(profileName)]
      : [
          socketPath(profileName),
          pidFile(profileName),
          daemonVersionFile(profileName),
          managedOwnerFile(profileName),
        ];
  for (const p of targets) {
    try {
      await fs.unlink(p);
    } catch {
      /* ignore */
    }
  }
}

function managedOwnerFile(profile: string): string {
  return path.join(path.dirname(pidFile(profile)), 'daemon.owner.json');
}

function managedString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliError(9, 'DAEMON_OWNER_ARTIFACT_INVALID', `${name} is missing.`);
  }
  return value;
}

function managedInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CliError(9, 'DAEMON_OWNER_ARTIFACT_INVALID', `${name} is invalid.`);
  }
  return value as number;
}

async function readPid(profile?: string): Promise<number | null> {
  try {
    const s = await fs.readFile(pidFile(profile), 'utf8');
    const n = parseInt(s.trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

async function readDaemonVersion(profile?: string): Promise<string | null> {
  try {
    const s = await fs.readFile(daemonVersionFile(profile), 'utf8');
    return s.trim() || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
