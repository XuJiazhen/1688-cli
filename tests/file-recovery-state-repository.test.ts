import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProfileRecoveryStateRepository } from '../src/daemon/file-recovery-state-repository.js';
import {
  INTERVENTION_END_RECEIPT_SCHEMA,
  type InterventionEndReceiptV1,
} from '../src/daemon/supervisor-runtime.js';

const receipt: InterventionEndReceiptV1 = {
  schema: INTERVENTION_END_RECEIPT_SCHEMA,
  interventionSessionId: 'intervention-1',
  completionIntentSha256: 'a'.repeat(64),
  daemonInstanceId: 'daemon-1',
  contextGeneration: 1,
  pageSessionId: 'page-session-1',
  endedAt: '2026-08-04T08:00:00.000Z',
  cooldownUntil: '2026-08-04T08:10:00.000Z',
  runtimeState: 'warm',
};

describe('FileProfileRecoveryStateRepository', () => {
  it('persists verified intervention end receipts across repository restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-state-'));
    const filePath = path.join(directory, 'recovery.json');
    try {
      const first = new FileProfileRecoveryStateRepository(filePath);
      await first.save({
        cooldownUntil: receipt.cooldownUntil,
        verifiedInterventionEndReceipts: [receipt],
        updatedAt: receipt.endedAt,
      });

      await expect(new FileProfileRecoveryStateRepository(filePath).load()).resolves.toEqual({
        cooldownUntil: receipt.cooldownUntil,
        verifiedInterventionEndReceipts: [receipt],
      });
      if (process.platform !== 'win32') {
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a persisted verified end receipt is malformed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-state-invalid-'));
    const filePath = path.join(directory, 'recovery.json');
    try {
      await fs.writeFile(filePath, JSON.stringify({
        schema: 'profile-daemon.recovery-state.v1',
        cooldownUntil: receipt.cooldownUntil,
        verifiedInterventionEndReceipts: [{
          ...receipt,
          completionIntentSha256: 'not-a-sha256',
        }],
        updatedAt: receipt.endedAt,
      }));
      await expect(new FileProfileRecoveryStateRepository(filePath).load())
        .rejects.toMatchObject({ code: 'RECOVERY_STATE_INVALID' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps legacy cooldown-only state readable without inventing a terminal receipt', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-state-legacy-'));
    const filePath = path.join(directory, 'recovery.json');
    try {
      await fs.writeFile(filePath, JSON.stringify({
        schema: 'profile-daemon.recovery-state.v1',
        cooldownUntil: receipt.cooldownUntil,
        updatedAt: receipt.endedAt,
      }));
      await expect(new FileProfileRecoveryStateRepository(filePath).load()).resolves.toEqual({
        cooldownUntil: receipt.cooldownUntil,
        verifiedInterventionEndReceipts: [],
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
