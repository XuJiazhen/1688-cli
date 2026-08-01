import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import {
  defaultProfileName,
  ensureProfileRuntimeDir,
  lockFile,
} from './paths.js';
import { CliError } from '../io/errors.js';

export async function acquireLock(profile?: string): Promise<() => Promise<void>> {
  const profileName = defaultProfileName(profile);
  await ensureProfileRuntimeDir(profileName);
  const target = lockFile(profileName);
  // proper-lockfile requires the target file to exist
  await fs.writeFile(target, '', { flag: 'a' });

  const lockOpts = { retries: 0, stale: 5 * 60 * 1000 };

  try {
    return await lockfile.lock(target, lockOpts);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ELOCKED') throw e;
    // A direct CLI process has no managed owner artifact. Never infer that an
    // ELOCKED directory is stale and delete another live holder's lease.
    throw new CliError(
      5,
      'LOCK_BUSY',
      `Another 1688 command is running for profile "${profileName}". Close it and retry.`,
    );
  }
}
