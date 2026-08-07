import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageActionVerificationConfigV1 } from '../collection/page-action-contracts.js';
import { profileRuntimeDir } from '../session/paths.js';
import { FilePageActionAcceptanceRepository } from './file-acceptance-repository.js';
import { FileProfileRecoveryStateRepository } from './file-recovery-state-repository.js';
import { ProductionPageActionExecutor } from './production-page-action-executor.js';
import { SharedPersistentContextHost } from './shared-context-host.js';
import {
  DatabaseAnchoredMonotonicClock,
  HmacRenewalCredentialVerifier,
  ProfileDaemonRuntime,
  type PageActionAcceptanceRepository,
  type PageActionExecutor,
  type PersistentContextHost,
  type SupervisorRuntimeEvent,
} from './supervisor-runtime.js';
import type { ServerOpts } from './server.js';
import {
  parseTransportAuthorityV2,
  SUPERVISOR_PROTOCOL_SHA256_V2,
  type TransportAuthorityV2,
} from './supervisor-rpc.js';

export interface ManagedSupervisorDaemonConfigV2 {
  schema: 'profile-supervisor.daemon-config.v2';
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  supervisorGeneration: number;
  contextGeneration: number;
  transportAuthority: TransportAuthorityV2;
  databaseNow: string;
  databaseTimeSampledAt: string;
  credentialKeys: Readonly<Record<string, string>>;
  pageActionVerification: PageActionVerificationConfigV1;
  artifactDirectory: string;
  acceptanceJournalPath?: string;
  runtimeEventPath?: string;
  storeSampleFreshnessMs?: number;
}

export interface ManagedBootstrapDependencies {
  hostFactory?: (
    config: ManagedSupervisorDaemonConfigV2,
    now: () => Date,
  ) => PersistentContextHost;
  executorFactory?: (
    config: ManagedSupervisorDaemonConfigV2,
    now: () => Date,
  ) => PageActionExecutor;
  acceptanceRepositoryFactory?: (
    config: ManagedSupervisorDaemonConfigV2,
  ) => PageActionAcceptanceRepository;
}

/** Loads a 0600 Supervisor-issued config and constructs the production runtime. */
export async function loadManagedServerOptions(
  configPath: string,
  expectedProfile?: string,
  dependencies: ManagedBootstrapDependencies = {},
): Promise<ServerOpts> {
  const config = await loadManagedSupervisorConfig(configPath);
  if (expectedProfile !== undefined && expectedProfile !== config.profileName) {
    throw new Error('Managed daemon config does not match --profile.');
  }
  const sampledDatabase = Date.parse(config.databaseNow);
  const sampledWall = Date.parse(config.databaseTimeSampledAt);
  const elapsedBeforeBoot = Math.max(0, Date.now() - sampledWall);
  const clock = new DatabaseAnchoredMonotonicClock({
    databaseNow: new Date(sampledDatabase + elapsedBeforeBoot),
  });
  const now = clock.now;
  const runtimeDir = profileRuntimeDir(config.profileName);
  const host = dependencies.hostFactory?.(config, now)
    ?? new SharedPersistentContextHost({
      profileId: config.profileId,
      profileName: config.profileName,
      daemonInstanceId: config.daemonInstanceId,
      contextGeneration: config.contextGeneration,
      now,
    });
  const acceptanceRepository = dependencies.acceptanceRepositoryFactory?.(config)
    ?? new FilePageActionAcceptanceRepository(
      config.acceptanceJournalPath
        ?? path.join(runtimeDir, 'page-action-acceptance.json'),
    );
  const executor = dependencies.executorFactory?.(config, now)
    ?? new ProductionPageActionExecutor({
      artifactDirectory: config.artifactDirectory,
      now,
      ...(config.storeSampleFreshnessMs === undefined
        ? {}
        : { storeSampleFreshnessMs: config.storeSampleFreshnessMs }),
    });
  const eventPath = config.runtimeEventPath
    ?? path.join(runtimeDir, 'supervisor-runtime-events.jsonl');
  const runtime = new ProfileDaemonRuntime({
    profileId: config.profileId,
    profileName: config.profileName,
    daemonInstanceId: config.daemonInstanceId,
    supervisorGeneration: config.supervisorGeneration,
    contextGeneration: config.contextGeneration,
    transportAuthority: config.transportAuthority,
    host,
    credentialVerifier: new HmacRenewalCredentialVerifier(config.credentialKeys),
    acceptanceRepository,
    executor,
    recoveryStateRepository: new FileProfileRecoveryStateRepository(
      path.join(runtimeDir, 'profile-recovery-state.json'),
    ),
    now,
    eventSink: {
      append: (event) => appendRuntimeEvent(eventPath, event),
    },
  });
  return {
    profile: config.profileName,
    headful: true,
    prewarm: false,
    supervisorRuntime: runtime,
    pageActionVerification: config.pageActionVerification,
  };
}

export async function loadManagedSupervisorConfig(
  configPath: string,
): Promise<ManagedSupervisorDaemonConfigV2> {
  if (!path.isAbsolute(configPath)) {
    throw new TypeError('Managed daemon config path must be absolute.');
  }
  const stat = await fs.stat(configPath);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Managed daemon config must not be group/world accessible.');
  }
  if (stat.size > 1024 * 1024) throw new Error('Managed daemon config is too large.');
  const value: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return parseManagedConfig(value);
}

function parseManagedConfig(value: unknown): ManagedSupervisorDaemonConfigV2 {
  const record = strictRecord(value, [
    'schema', 'profileId', 'profileName', 'daemonInstanceId',
    'supervisorGeneration', 'contextGeneration', 'databaseNow',
    'databaseTimeSampledAt', 'credentialKeys', 'pageActionVerification',
    'artifactDirectory', 'acceptanceJournalPath', 'runtimeEventPath',
    'storeSampleFreshnessMs', 'transportAuthority',
  ]);
  if (record['schema'] !== 'profile-supervisor.daemon-config.v2') {
    throw new Error('Managed daemon config schema is unsupported.');
  }
  const credentialKeys = stringMap(record['credentialKeys'], 'credentialKeys');
  for (const [keyId, key] of Object.entries(credentialKeys)) {
    if (Buffer.byteLength(key, 'utf8') < 32) {
      throw new Error(`credentialKeys.${keyId} must contain at least 32 bytes.`);
    }
  }
  const verification = parseVerification(record['pageActionVerification']);
  const config: ManagedSupervisorDaemonConfigV2 = {
    schema: 'profile-supervisor.daemon-config.v2',
    profileId: uuid(record['profileId'], 'profileId'),
    profileName: identifier(record['profileName'], 'profileName'),
    daemonInstanceId: uuid(record['daemonInstanceId'], 'daemonInstanceId'),
    supervisorGeneration: positiveInteger(record['supervisorGeneration'], 'supervisorGeneration'),
    contextGeneration: positiveInteger(record['contextGeneration'], 'contextGeneration'),
    transportAuthority: parseTransportAuthorityV2(record['transportAuthority']),
    databaseNow: timestamp(record['databaseNow'], 'databaseNow'),
    databaseTimeSampledAt: timestamp(record['databaseTimeSampledAt'], 'databaseTimeSampledAt'),
    credentialKeys,
    pageActionVerification: verification,
    artifactDirectory: absolutePath(record['artifactDirectory'], 'artifactDirectory'),
    ...(record['acceptanceJournalPath'] === undefined
      ? {}
      : { acceptanceJournalPath: absolutePath(record['acceptanceJournalPath'], 'acceptanceJournalPath') }),
    ...(record['runtimeEventPath'] === undefined
      ? {}
      : { runtimeEventPath: absolutePath(record['runtimeEventPath'], 'runtimeEventPath') }),
    ...(record['storeSampleFreshnessMs'] === undefined
      ? {}
      : { storeSampleFreshnessMs: positiveInteger(record['storeSampleFreshnessMs'], 'storeSampleFreshnessMs') }),
  };
  if (Date.parse(config.databaseTimeSampledAt) > Date.now() + 5_000) {
    throw new Error('Managed daemon database time sample is from the future.');
  }
  if (config.transportAuthority.protocolSha256 !== SUPERVISOR_PROTOCOL_SHA256_V2) {
    throw new Error('Managed daemon protocolSha256 does not match this nested CLI build.');
  }
  return config;
}

function parseVerification(value: unknown): PageActionVerificationConfigV1 {
  const record = strictRecord(value, [
    'keysById', 'routesById', 'expansionPoliciesByDispatchRevisionId',
  ]);
  const keysById = stringMap(record['keysById'], 'pageActionVerification.keysById');
  for (const [keyId, key] of Object.entries(keysById)) {
    if (Buffer.byteLength(key, 'utf8') < 32) {
      throw new Error(`pageActionVerification.keysById.${keyId} is too short.`);
    }
  }
  const rawRoutes = objectMap(record['routesById'], 'pageActionVerification.routesById');
  const routesById = Object.fromEntries(Object.entries(rawRoutes).map(([routeId, route]) => {
    const row = strictRecord(route, ['actionKind', 'allowedRequestKeys']);
    const actionKind = row['actionKind'];
    if (!['search-list', 'offer-detail', 'store-qualification', 'store-sample'].includes(String(actionKind))) {
      throw new Error(`Route ${routeId} has an invalid actionKind.`);
    }
    if (!Array.isArray(row['allowedRequestKeys']) || row['allowedRequestKeys'].some((item) => typeof item !== 'string')) {
      throw new Error(`Route ${routeId} allowedRequestKeys is invalid.`);
    }
    return [routeId, {
      actionKind,
      allowedRequestKeys: [...new Set(row['allowedRequestKeys'] as string[])].sort(),
    }];
  })) as PageActionVerificationConfigV1['routesById'];
  const rawPolicies = objectMap(
    record['expansionPoliciesByDispatchRevisionId'],
    'pageActionVerification.expansionPoliciesByDispatchRevisionId',
  );
  const expansionPoliciesByDispatchRevisionId = Object.fromEntries(
    Object.entries(rawPolicies).map(([revisionId, policy]) => {
      const row = strictRecord(policy, ['eligibilityPolicyHash', 'dispatchPolicyHash']);
      return [revisionId, {
        eligibilityPolicyHash: hash(row['eligibilityPolicyHash'], 'eligibilityPolicyHash'),
        dispatchPolicyHash: hash(row['dispatchPolicyHash'], 'dispatchPolicyHash'),
      }];
    }),
  );
  return { keysById, routesById, expansionPoliciesByDispatchRevisionId };
}

async function appendRuntimeEvent(
  filePath: string,
  event: SupervisorRuntimeEvent,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed daemon config object is invalid.');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length !== 0) throw new Error(`Managed daemon config has unknown fields: ${unknown.join(', ')}.`);
  return record;
}

function objectMap(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  const record = objectMap(value, name);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (key.trim().length === 0 || typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${name} must contain non-empty string entries.`);
    }
    return [key, entry];
  }));
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:@/-]+$/u.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new Error(`${name} must be a lowercase canonical UUID.`);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute.`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be a sha256 digest.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value as number;
}
