import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePageActionAcceptanceRepository } from '../src/daemon/file-acceptance-repository.js';
import type { PageActionAcceptance } from '../src/daemon/supervisor-runtime.js';
import type { PageActionRequestV1 } from '../src/collection/page-action-contracts.js';

describe('FilePageActionAcceptanceRepository', () => {
  it('persists acceptance before execution and returns in-flight after restart', async () => {
    const filePath = await journalPath();
    const accepted = acceptance();
    const first = new FilePageActionAcceptanceRepository(filePath);
    await expect(first.accept(accepted)).resolves.toMatchObject({ kind: 'accepted' });

    const restarted = new FilePageActionAcceptanceRepository(filePath);
    await expect(restarted.accept(accepted)).resolves.toMatchObject({
      kind: 'in_flight',
      acceptance: accepted,
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects an idempotency collision with a different canonical request', async () => {
    const repository = new FilePageActionAcceptanceRepository(await journalPath());
    await repository.accept(acceptance());
    await expect(repository.accept({
      ...acceptance(),
      canonicalRequestHash: 'b'.repeat(64),
      pageActionExecutionAttemptId: 'attempt-forged',
    })).resolves.toMatchObject({
      kind: 'conflict',
      acceptance: { canonicalRequestHash: 'a'.repeat(64) },
    });
  });

  it('persists the pre-dispatch remote-attempt boundary before side effects', async () => {
    const filePath = await journalPath();
    const repository = new FilePageActionAcceptanceRepository(filePath);
    const accepted = acceptance();
    await repository.accept(accepted);
    await repository.recordRemoteAttemptAdmission({
      acceptance: accepted,
      admission: {
        request: {
          remoteRequestAttemptId: 'remote-attempt-1-1',
          ordinal: 1,
          purpose: 'single-target',
          requestBusinessHash: `sha256:${'1'.repeat(64)}`,
        },
        receipt: {
          remoteActionStartId: 'remote-action-start-1',
          admittedAt: '2026-07-31T08:00:01.000Z',
        },
      },
    });
    const restarted = new FilePageActionAcceptanceRepository(filePath);
    await expect(restarted.inspect(lookup(accepted))).resolves.toMatchObject({
      acceptance: {
        remoteAttemptStartedAt: '2026-07-31T08:00:01.000Z',
        remoteAttemptAdmissions: [{
          request: {
            remoteRequestAttemptId: 'remote-attempt-1-1', ordinal: 1,
            purpose: 'single-target', requestBusinessHash: `sha256:${'1'.repeat(64)}`,
          },
          receipt: {
            remoteActionStartId: 'remote-action-start-1',
            admittedAt: '2026-07-31T08:00:01.000Z',
          },
        }],
      },
      response: null,
    });
  });

  it('keeps a terminal receipt immutable and readable after restart', async () => {
    const filePath = await journalPath();
    const repository = new FilePageActionAcceptanceRepository(filePath);
    const accepted = acceptance();
    const response = {
      executionAttemptReceipt: {
        requestId: accepted.requestId,
        pageActionExecutionAttemptId: accepted.pageActionExecutionAttemptId,
        outcome: 'completed',
      },
    } as never;
    await repository.accept(accepted);
    await repository.complete({ acceptance: accepted, response });
    await repository.complete({ acceptance: accepted, response });
    await expect(repository.complete({
      acceptance: accepted,
      response: {
        executionAttemptReceipt: {
          requestId: accepted.requestId,
          pageActionExecutionAttemptId: accepted.pageActionExecutionAttemptId,
          outcome: 'failed',
        },
      } as never,
    })).rejects.toThrow(/immutable/u);

    const restarted = new FilePageActionAcceptanceRepository(filePath);
    await expect(restarted.accept(accepted)).resolves.toMatchObject({
      kind: 'terminal',
      response,
    });
    await expect(restarted.lookup(lookup(accepted))).resolves.toEqual(response);
    await expect(restarted.lookup({
      ...lookup(accepted),
      targetExecutionLineageHash: 'e'.repeat(64),
    })).resolves.toBeNull();
  });
});

function acceptance(): PageActionAcceptance {
  return {
    requestId: 'request-1',
    idempotencyKey: 'idem-1',
    canonicalRequestHash: 'a'.repeat(64),
    pageActionId: 'page-action-1',
    pageActionExecutionAttemptId: 'attempt-1',
    acceptedAt: '2026-07-31T08:00:00.000Z',
    request: {
      requestId: 'request-1',
      idempotencyKey: 'idem-1',
      pageActionId: 'page-action-1',
      pageActionExecutionAttemptId: 'attempt-1',
      logicalLineage: { logicalLineageId: 'logical-1' },
      logicalLineageHash: 'c'.repeat(64),
      executionLineageHash: 'd'.repeat(64),
    } as unknown as PageActionRequestV1,
    remoteAttemptStartedAt: null,
    remoteAttemptAdmissions: [],
  };
}

function lookup(accepted: PageActionAcceptance) {
  return {
    requestId: accepted.requestId,
    idempotencyKey: accepted.idempotencyKey,
    pageActionId: accepted.pageActionId,
    pageActionExecutionAttemptId: accepted.pageActionExecutionAttemptId,
    logicalLineageId: accepted.request.logicalLineage.logicalLineageId,
    logicalLineageHash: accepted.request.logicalLineageHash,
    targetExecutionLineageHash: accepted.request.executionLineageHash,
  } as never;
}

async function journalPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-journal-'));
  return path.join(directory, 'journal.json');
}
