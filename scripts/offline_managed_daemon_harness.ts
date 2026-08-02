#!/usr/bin/env -S node --import tsx

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeOfflinePageActionExecutor,
  createRuntimeOfflineScenarioDescriptor,
  RUNTIME_OFFLINE_PAGE_ACTION_SCENARIOS,
  type RuntimeOfflinePageActionScenario,
} from './generate_runtime_page_action_fixtures.js';
import {
  loadManagedServerOptions,
  loadManagedSupervisorConfig,
  type ManagedSupervisorDaemonConfigV2,
} from '../src/daemon/managed-bootstrap.js';
import { isDaemonReachable } from '../src/daemon/client.js';
import type { ManagedPage } from '../src/daemon/page-registry.js';
import { start as startServer } from '../src/daemon/server.js';
import type {
  IdentityProbeReceipt,
  PersistentContextDescriptor,
  PersistentContextHost,
} from '../src/daemon/supervisor-runtime.js';
import {
  daemonLogFile,
  ensureProfileRuntimeDir,
  ensureRoot,
  pidFile,
} from '../src/session/paths.js';
import { waitUntil } from '../src/session/wait.js';

const HARNESS_MARKER = 'BB1688_TEST_ONLY_OFFLINE_MANAGED_DAEMON';

async function main(): Promise<void> {
  if (process.env[HARNESS_MARKER] !== '1') {
    throw new Error(`${HARNESS_MARKER}=1 is required; the offline daemon is test-only.`);
  }
  const scenario = scenarioFromEnvironment(process.env);
  const [command, subcommand] = process.argv.slice(2);
  if (command === 'scenario' && subcommand === 'describe') {
    process.stdout.write(`${JSON.stringify(createRuntimeOfflineScenarioDescriptor())}\n`);
    return;
  }
  if (command === 'daemon' && subcommand === 'managed-start') {
    const configPath = requiredOption('--supervisor-config');
    const config = await loadManagedSupervisorConfig(configPath);
    await assertOfflineAuthority(config, scenario);
    await managedStart(configPath, scenario);
    return;
  }
  if (command === 'serve') {
    const configPath = requiredOption('--supervisor-config');
    const profile = requiredOption('--profile', false);
    const config = await loadManagedSupervisorConfig(configPath);
    await assertOfflineAuthority(config, scenario);
    const options = await loadManagedServerOptions(configPath, profile, {
      hostFactory: (config, now) => new OfflinePersistentContextHost(config, now),
      executorFactory: (config, now) => createRuntimeOfflinePageActionExecutor({
        artifactDirectory: config.artifactDirectory,
        now,
        scenario,
      }),
    });
    await startServer(options);
    return;
  }
  throw new Error('Offline managed daemon supports only managed-start and its private serve child.');
}

async function assertOfflineAuthority(
  config: ManagedSupervisorDaemonConfigV2,
  scenario: RuntimeOfflinePageActionScenario,
): Promise<void> {
  if (config.transportAuthority.mode !== 'scripted_offline') {
    throw new Error('Offline managed daemon rejects live_remote authority.');
  }
  const expectedProtocol = requiredHashEnvironment('BB1688_SUPERVISOR_PROTOCOL_SHA256');
  if (expectedProtocol !== config.transportAuthority.protocolSha256) {
    throw new Error('Offline managed daemon protocol hash differs from its config authority.');
  }
  const expectedScenario = requiredHashEnvironment(
    'BB1688_OFFLINE_PAGE_ACTION_SCENARIO_SHA256',
  );
  const actualScenario = createHash('sha256')
    .update(JSON.stringify({ scenario, descriptor: createRuntimeOfflineScenarioDescriptor() }))
    .digest('hex');
  if (actualScenario !== expectedScenario) {
    throw new Error('Offline PageAction scenario descriptor hash differs from authority.');
  }
  const expectedHarness = requiredHashEnvironment(
    'BB1688_OFFLINE_MANAGED_DAEMON_HARNESS_SHA256',
  );
  const actualHarness = createHash('sha256')
    .update(await fs.readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  if (actualHarness !== expectedHarness) {
    throw new Error('Offline managed daemon harness content hash differs from authority.');
  }
}

function requiredHashEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be an exact lowercase SHA-256.`);
  }
  return value;
}

async function managedStart(
  configPath: string,
  scenario: RuntimeOfflinePageActionScenario,
): Promise<void> {
  const config = await loadManagedSupervisorConfig(configPath);
  await ensureRoot();
  await ensureProfileRuntimeDir(config.profileName);
  const existingPid = await readPid(config.profileName);
  if (existingPid !== null && processAlive(existingPid)) {
    throw new Error(`Offline managed daemon already runs for ${config.profileName}.`);
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const log = await fs.open(daemonLogFile(config.profileName), 'a');
  const child = spawn(process.execPath, [
    '--import', 'tsx', scriptPath, 'serve', '--profile', config.profileName,
    '--supervisor-config', configPath,
  ], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      [HARNESS_MARKER]: '1',
      BB1688_OFFLINE_PAGE_ACTION_SCENARIO: scenario,
      BB1688_DAEMON_BG: '1',
      BB1688_SUPERVISOR_MANAGED: '1',
      BB1688_SUPERVISOR_CONFIG: configPath,
      BB1688_SUPERVISOR_PROTOCOL_SHA256:
        config.transportAuthority.protocolSha256,
    },
  });
  child.unref();
  await log.close();
  const reachable = await waitUntil(() => isDaemonReachable(config.profileName), {
    timeoutMs: 15_000,
    intervalMs: 100,
  });
  if (!reachable) {
    const detail = await fs.readFile(daemonLogFile(config.profileName), 'utf8')
      .catch(() => 'daemon log unavailable');
    throw new Error(`Offline managed daemon did not become reachable: ${detail.slice(-2_000)}`);
  }
  const owner = JSON.parse(
    await fs.readFile(path.join(path.dirname(pidFile(config.profileName)), 'daemon.owner.json'), 'utf8'),
  ) as Record<string, unknown>;
  if (
    owner['profileId'] !== config.profileId
    || owner['daemonInstanceId'] !== config.daemonInstanceId
    || owner['supervisorGeneration'] !== config.supervisorGeneration
    || owner['contextGeneration'] !== config.contextGeneration
    || JSON.stringify(owner['transportAuthority'])
      !== JSON.stringify(config.transportAuthority)
  ) {
    throw new Error('Offline managed daemon owner artifact differs from Supervisor config.');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    profile: config.profileName,
    pid: owner['daemonPid'],
    managed: true,
    offlineScenario: scenario,
    supervisorProtocolSha256: config.transportAuthority.protocolSha256,
    offlineScenarioSha256:
      process.env['BB1688_OFFLINE_PAGE_ACTION_SCENARIO_SHA256'],
    offlineHarnessSha256:
      process.env['BB1688_OFFLINE_MANAGED_DAEMON_HARNESS_SHA256'],
  })}\n`);
}

class OfflinePersistentContextHost implements PersistentContextHost {
  private readonly pagesById = new Map<string, OfflineManagedPage>();
  private sequence = 0;
  private contextGeneration: number;

  constructor(
    private readonly config: ManagedSupervisorDaemonConfigV2,
    private readonly now: () => Date,
  ) {
    this.contextGeneration = config.contextGeneration;
  }

  async ensureStarted(input: {
    profileId: string;
    profileName: string;
    daemonInstanceId: string;
    contextGeneration: number;
    headful: true;
  }): Promise<PersistentContextDescriptor> {
    if (
      input.profileId !== this.config.profileId
      || input.profileName !== this.config.profileName
      || input.daemonInstanceId !== this.config.daemonInstanceId
      || input.contextGeneration !== this.contextGeneration
      || input.headful !== true
    ) throw new Error('Offline Context owner binding mismatch.');
    return { ...input, chromiumPid: process.pid };
  }

  async createPage(): Promise<ManagedPage> {
    const page = new OfflineManagedPage(`offline-page-${++this.sequence}`, () => {
      this.pagesById.delete(page.id);
    });
    this.pagesById.set(page.id, page);
    return page;
  }

  pages(): readonly ManagedPage[] {
    return [...this.pagesById.values()];
  }

  pageId(page: ManagedPage): string {
    if (!(page instanceof OfflineManagedPage)) throw new TypeError('Unknown offline Page.');
    return page.id;
  }

  async restart(input: {
    reason: string;
    nextContextGeneration: number;
  }): Promise<PersistentContextDescriptor> {
    if (input.nextContextGeneration !== this.contextGeneration + 1) {
      throw new Error('Offline Context restart must increment generation once.');
    }
    await this.stop();
    this.contextGeneration = input.nextContextGeneration;
    return this.ensureStarted({
      profileId: this.config.profileId,
      profileName: this.config.profileName,
      daemonInstanceId: this.config.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      headful: true,
    });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.pagesById.values()].map((page) => page.close()));
  }

  async probeIdentity(input: {
    expectedMemberId: string;
    probeRevision: string;
    page?: ManagedPage;
  }): Promise<IdentityProbeReceipt> {
    const probedAt = this.now().toISOString();
    return {
      probeReceiptId: `offline-probe-${++this.sequence}`,
      probeRevision: input.probeRevision,
      probedAt,
      expectedMemberId: input.expectedMemberId,
      observedMemberId: input.expectedMemberId,
      pageState: 'normal',
      passed: true,
      safeEvidenceHash: createSafeProbeHash({
        expectedMemberId: input.expectedMemberId,
        probeRevision: input.probeRevision,
        probedAt,
      }),
    };
  }
}

class OfflineManagedPage implements ManagedPage {
  private closed = false;
  constructor(readonly id: string, private readonly onClose: () => void) {}
  isClosed(): boolean { return this.closed; }
  url(): string { return 'about:blank'; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

function createSafeProbeHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scenarioFromEnvironment(environment: NodeJS.ProcessEnv): RuntimeOfflinePageActionScenario {
  const value = environment['BB1688_OFFLINE_PAGE_ACTION_SCENARIO'];
  if (!RUNTIME_OFFLINE_PAGE_ACTION_SCENARIOS.includes(value as RuntimeOfflinePageActionScenario)) {
    throw new Error('BB1688_OFFLINE_PAGE_ACTION_SCENARIO must name an offline fixture scenario.');
  }
  return value as RuntimeOfflinePageActionScenario;
}

function requiredOption(name: string, absolute = true): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value?.trim() || (absolute && !path.isAbsolute(value))) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return value;
}

async function readPid(profileName: string): Promise<number | null> {
  try {
    const value = Number(await fs.readFile(pidFile(profileName), 'utf8'));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

await main();
