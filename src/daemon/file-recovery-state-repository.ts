import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProfileRecoveryStateRepository } from './supervisor-runtime.js';

interface RecoveryStateV1 {
  schema: 'profile-daemon.recovery-state.v1';
  cooldownUntil: string | null;
  updatedAt: string;
}

/** Durable daemon mirror of the database recovery gate for process restarts. */
export class FileProfileRecoveryStateRepository
implements ProfileRecoveryStateRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new TypeError('Recovery state path must be absolute.');
  }

  async load(): Promise<{ cooldownUntil: string | null }> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as RecoveryStateV1;
      if (
        value.schema !== 'profile-daemon.recovery-state.v1'
        || (value.cooldownUntil !== null && !Number.isFinite(Date.parse(value.cooldownUntil)))
        || !Number.isFinite(Date.parse(value.updatedAt))
      ) {
        throw new Error('Recovery state is invalid.');
      }
      return { cooldownUntil: value.cooldownUntil };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cooldownUntil: null };
      throw error;
    }
  }

  async save(input: { cooldownUntil: string | null; updatedAt: string }): Promise<void> {
    await this.serial(async () => {
      if (
        (input.cooldownUntil !== null && !Number.isFinite(Date.parse(input.cooldownUntil)))
        || !Number.isFinite(Date.parse(input.updatedAt))
      ) throw new TypeError('Recovery state timestamps are invalid.');
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const value: RecoveryStateV1 = {
        schema: 'profile-daemon.recovery-state.v1',
        cooldownUntil: input.cooldownUntil,
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
