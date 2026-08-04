import fs from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeProfileRecoveryState,
  type ProfileRecoveryState,
  type ProfileRecoveryStateRepository,
} from './supervisor-runtime.js';

interface RecoveryStateV1 extends ProfileRecoveryState {
  schema: 'profile-daemon.recovery-state.v1';
  updatedAt: string;
}

/** Durable daemon mirror of the database recovery gate for process restarts. */
export class FileProfileRecoveryStateRepository
implements ProfileRecoveryStateRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new TypeError('Recovery state path must be absolute.');
  }

  async load(): Promise<ProfileRecoveryState> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      if (
        value === null
        || typeof value !== 'object'
        || Array.isArray(value)
      ) {
        throw new Error('Recovery state is invalid.');
      }
      const record = value as Record<string, unknown>;
      const unknown = Object.keys(record).filter((key) => ![
        'schema', 'cooldownUntil', 'verifiedInterventionEndReceipts', 'updatedAt',
      ].includes(key));
      if (
        unknown.length !== 0
        || record['schema'] !== 'profile-daemon.recovery-state.v1'
        || !isIsoTimestamp(record['updatedAt'])
      ) {
        throw new Error('Recovery state is invalid.');
      }
      return normalizeProfileRecoveryState({
        cooldownUntil: record['cooldownUntil'],
        ...(record['verifiedInterventionEndReceipts'] === undefined
          ? {}
          : { verifiedInterventionEndReceipts: record['verifiedInterventionEndReceipts'] }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { cooldownUntil: null, verifiedInterventionEndReceipts: [] };
      }
      throw error;
    }
  }

  async save(input: ProfileRecoveryState & { updatedAt: string }): Promise<void> {
    await this.serial(async () => {
      const normalized = normalizeProfileRecoveryState({
        cooldownUntil: input.cooldownUntil,
        verifiedInterventionEndReceipts: input.verifiedInterventionEndReceipts,
      });
      if (!isIsoTimestamp(input.updatedAt)) {
        throw new TypeError('Recovery state timestamps are invalid.');
      }
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const value: RecoveryStateV1 = {
        schema: 'profile-daemon.recovery-state.v1',
        cooldownUntil: normalized.cooldownUntil,
        verifiedInterventionEndReceipts: normalized.verifiedInterventionEndReceipts,
        updatedAt: new Date(input.updatedAt).toISOString(),
      };
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`);
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
    });
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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
