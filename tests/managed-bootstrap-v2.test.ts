import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManagedSupervisorConfig } from '../src/daemon/managed-bootstrap.js';
import { SUPERVISOR_PROTOCOL_SHA256_V2 } from '../src/daemon/supervisor-rpc.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function authority() {
  return {
    mode: 'scripted_offline' as const,
    executionAuthorityDocumentId: '20000000-0000-4000-8000-000000000001',
    executionAuthorityDocumentSha256: 'a'.repeat(64),
    executionSubjectDocumentId: '20000000-0000-4000-8000-000000000002',
    executionSubjectDocumentSha256: 'b'.repeat(64),
    cohortId: '20000000-0000-4000-8000-000000000003',
    runId: '20000000-0000-4000-8000-000000000004',
    protocolSha256: SUPERVISOR_PROTOCOL_SHA256_V2,
  };
}

async function writeConfig(override: Record<string, unknown> = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-v2-config-'));
  directories.push(directory);
  const configPath = path.join(directory, 'daemon.json');
  const value = {
    schema: 'profile-supervisor.daemon-config.v2',
    profileId: '20000000-0000-4000-8000-000000000005',
    profileName: 'profile-v2',
    daemonInstanceId: '20000000-0000-4000-8000-000000000006',
    supervisorGeneration: 1,
    contextGeneration: 1,
    databaseNow: '2026-08-03T00:00:00.000Z',
    databaseTimeSampledAt: new Date().toISOString(),
    credentialKeys: { 'key-v2': 'managed-v2-key-material-at-least-32-bytes' },
    pageActionVerification: {
      keysById: {}, routesById: {}, expansionPoliciesByDispatchRevisionId: {},
    },
    artifactDirectory: directory,
    transportAuthority: authority(),
    ...override,
  };
  await fs.writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
  return configPath;
}

describe('managed daemon v2 config authority', () => {
  it('loads the exact immutable transport authority', async () => {
    const config = await loadManagedSupervisorConfig(await writeConfig());
    expect(config.schema).toBe('profile-supervisor.daemon-config.v2');
    expect(config.transportAuthority).toEqual(authority());
  });

  it('rejects missing or lossy authority before runtime construction', async () => {
    await expect(loadManagedSupervisorConfig(await writeConfig({
      transportAuthority: { ...authority(), protocolSha256: undefined },
    }))).rejects.toThrow(/protocolSha256/u);
    await expect(loadManagedSupervisorConfig(await writeConfig({
      transportAuthority: { ...authority(), networkAllowed: false },
    }))).rejects.toThrow(/unknown fields/u);
  });
});
