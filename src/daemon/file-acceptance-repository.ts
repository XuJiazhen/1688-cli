import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PageActionExecuteResponseV1,
  PageActionReceiptLookupV1,
} from '../collection/page-action-contracts.js';
import type {
  AcceptanceResult,
  DurableRemoteAttemptAdmissionV2,
  PageActionAcceptance,
  PageActionAcceptanceRepository,
} from './supervisor-runtime.js';
import { parseTransportAuthorityV2 } from './supervisor-rpc.js';

interface AcceptanceRow {
  acceptance: PageActionAcceptance;
  response: PageActionExecuteResponseV1 | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

interface AcceptanceJournalV2 {
  schema: 'profile-daemon.acceptance-journal.v2';
  rows: AcceptanceRow[];
}

/** Small durable daemon-side journal used before any Page or remote attempt. */
export class FilePageActionAcceptanceRepository
implements PageActionAcceptanceRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError('Acceptance journal path must be absolute.');
    }
  }

  async accept(input: PageActionAcceptance): Promise<AcceptanceResult> {
    return this.serial(async () => {
      const journal = await this.read();
      const existing = journal.rows.find((row) => sameKey(row.acceptance, input));
      if (existing) {
        if (
          existing.acceptance.canonicalRequestHash !== input.canonicalRequestHash
          || existing.acceptance.pageActionPayloadHash !== input.pageActionPayloadHash
          || JSON.stringify(existing.acceptance.transportAuthority)
            !== JSON.stringify(input.transportAuthority)
          || existing.acceptance.pageActionId !== input.pageActionId
          || existing.acceptance.pageActionExecutionAttemptId
            !== input.pageActionExecutionAttemptId
        ) {
          return { kind: 'conflict', acceptance: structuredClone(existing.acceptance) };
        }
        return existing.response === null
          ? { kind: 'in_flight', acceptance: structuredClone(existing.acceptance) }
          : {
              kind: 'terminal',
              acceptance: structuredClone(existing.acceptance),
              response: structuredClone(existing.response),
            };
      }
      journal.rows.push({
        acceptance: structuredClone(input),
        response: null,
        cancelledAt: null,
        cancellationReason: null,
      });
      await this.write(journal);
      return { kind: 'accepted', acceptance: structuredClone(input) };
    });
  }

  async lookup(input: PageActionReceiptLookupV1): Promise<PageActionExecuteResponseV1 | null> {
    return (await this.inspect(input))?.response ?? null;
  }

  async inspect(input: PageActionReceiptLookupV1): Promise<{
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1 | null;
  } | null> {
    return this.serial(async () => {
      const row = (await this.read()).rows.find((candidate) =>
        candidate.acceptance.requestId === input.requestId
        && candidate.acceptance.idempotencyKey === input.idempotencyKey
        && candidate.acceptance.pageActionId === input.pageActionId
        && candidate.acceptance.pageActionExecutionAttemptId
          === input.pageActionExecutionAttemptId
        && candidate.acceptance.request.logicalLineage.logicalLineageId
          === input.logicalLineageId
        && candidate.acceptance.request.logicalLineageHash
          === input.logicalLineageHash
        && candidate.acceptance.request.executionLineageHash
          === input.targetExecutionLineageHash);
      return row === undefined
        ? null
        : {
            acceptance: structuredClone(row.acceptance),
            response: row.response === null ? null : structuredClone(row.response),
          };
    });
  }

  async recordRemoteAttemptAdmission(input: {
    acceptance: PageActionAcceptance;
    admission: DurableRemoteAttemptAdmissionV2;
  }): Promise<void> {
    await this.serial(async () => {
      const journal = await this.read();
      const row = journal.rows.find((candidate) =>
        sameKey(candidate.acceptance, input.acceptance));
      if (!row || row.acceptance.canonicalRequestHash !== input.acceptance.canonicalRequestHash) {
        throw new Error('Remote attempt cannot start without its current durable acceptance.');
      }
      if (
        input.admission.receipt.parentCanonicalRequestHash
          !== row.acceptance.canonicalRequestHash
        || JSON.stringify(input.admission.receipt.transportAuthority)
          !== JSON.stringify(row.acceptance.transportAuthority)
      ) {
        throw new Error('Remote-attempt admission authority differs from its acceptance.');
      }
      if (row.response !== null) {
        throw new Error('Remote attempt cannot start after terminal receipt commit.');
      }
      const admissions = row.acceptance.remoteAttemptAdmissions;
      const existing = admissions.find(
        (admission) => admission.request.ordinal === input.admission.request.ordinal,
      );
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(input.admission)) {
          throw new Error('Remote-attempt admission ordinal is already bound to another tuple.');
        }
        return;
      }
      if (input.admission.request.ordinal !== admissions.length + 1) {
        throw new Error('Remote-attempt admission ordinals must be contiguous.');
      }
      admissions.push(structuredClone(input.admission));
      row.acceptance.remoteAttemptStartedAt ??= input.admission.receipt.admittedAt;
      await this.write(journal);
    });
  }

  async complete(input: {
    acceptance: PageActionAcceptance;
    response: PageActionExecuteResponseV1;
  }): Promise<void> {
    await this.serial(async () => {
      const journal = await this.read();
      const row = journal.rows.find((candidate) => sameKey(candidate.acceptance, input.acceptance));
      if (!row || row.acceptance.canonicalRequestHash !== input.acceptance.canonicalRequestHash) {
        throw new Error('Acceptance journal ownership changed before terminal commit.');
      }
      const encoded = JSON.stringify(input.response);
      if (row.response !== null && JSON.stringify(row.response) !== encoded) {
        throw new Error('Acceptance journal terminal receipt is immutable.');
      }
      row.response = structuredClone(input.response);
      await this.write(journal);
    });
  }

  async markCancelled(input: {
    requestId: string;
    idempotencyKey: string;
    pageActionExecutionAttemptId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<void> {
    await this.serial(async () => {
      const journal = await this.read();
      const row = journal.rows.find((candidate) =>
        candidate.acceptance.requestId === input.requestId
        && candidate.acceptance.idempotencyKey === input.idempotencyKey
        && candidate.acceptance.pageActionExecutionAttemptId
          === input.pageActionExecutionAttemptId);
      if (!row || row.response !== null) return;
      row.cancelledAt = input.cancelledAt;
      row.cancellationReason = input.reason.slice(0, 256);
      await this.write(journal);
    });
  }

  private async read(): Promise<AcceptanceJournalV2> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schema: 'profile-daemon.acceptance-journal.v2', rows: [] };
      }
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || (value as Record<string, unknown>)['schema']
        !== 'profile-daemon.acceptance-journal.v2'
      || !Array.isArray((value as Record<string, unknown>)['rows'])
    ) {
      throw new Error('Acceptance journal is invalid.');
    }
    const journal = value as AcceptanceJournalV2;
    for (const row of journal.rows) {
      validateAcceptance(row.acceptance);
    }
    return journal;
  }

  private async write(journal: AcceptanceJournalV2): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.filePath);
      if (process.platform !== 'win32') {
        await fs.chmod(this.filePath, 0o600);
        const directoryHandle = await fs.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function sameKey(left: PageActionAcceptance, right: PageActionAcceptance): boolean {
  return left.requestId === right.requestId
    && left.idempotencyKey === right.idempotencyKey;
}

function validateAcceptance(acceptance: PageActionAcceptance): void {
  if (
    !/^[0-9a-f]{64}$/u.test(acceptance.canonicalRequestHash)
    || !/^[0-9a-f]{64}$/u.test(acceptance.pageActionPayloadHash)
    || !Array.isArray(acceptance.remoteAttemptAdmissions)
  ) {
    throw new Error('Acceptance journal v2 binding is invalid.');
  }
  parseTransportAuthorityV2(acceptance.transportAuthority);
  for (const admission of acceptance.remoteAttemptAdmissions) {
    if (
      admission.receipt.parentCanonicalRequestHash !== acceptance.canonicalRequestHash
      || JSON.stringify(admission.receipt.transportAuthority)
        !== JSON.stringify(acceptance.transportAuthority)
    ) {
      throw new Error('Acceptance journal v2 admission authority is invalid.');
    }
  }
}
