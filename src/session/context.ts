import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { CliError } from '../io/errors.js';
import {
  enrichErrorWithArtifact,
  type RunMeta,
} from './artifacts.js';

/**
 * Remove Chrome's stale SingletonLock / SingletonCookie / SingletonSocket files
 * from our profile dir. Safe because our `proper-lockfile` already guarantees
 * no other 1688 process is using this profile.
 */
export async function clearStaleSingleton(profileDir: string): Promise<void> {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await fs.unlink(path.join(profileDir, name)).catch(() => {});
  }
}

// Apply stealth evasions once at module load.
// Disable a couple of evasions that can cause issues with newer Chromium.
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export interface SessionOpts {
  headless: boolean;
  profile?: string;
}

const LAUNCH_OPTS = {
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  chromiumSandbox: chromiumSandboxEnabled(),
};

function chromiumSandboxEnabled(): boolean {
  const configured = process.env.BB1688_CHROMIUM_SANDBOX;
  if (configured === '1') return true;
  if (configured === '0' || configured === undefined) return false;
  throw new TypeError('BB1688_CHROMIUM_SANDBOX must be 0 or 1.');
}

export async function withSession<T>(
  opts: SessionOpts,
  fn: (ctx: BrowserContext) => Promise<T>,
  meta?: RunMeta,
): Promise<T> {
  if (process.env.BB1688_SUPERVISOR_MANAGED === '1') {
    throw new CliError(
      20,
      'SUPERVISOR_SECOND_CONTEXT_FORBIDDEN',
      'Supervisor-managed daemons must use their existing persistent Context.',
    );
  }
  const release = await acquireLock(opts.profile);
  const dir = profilePath(opts.profile);
  await fs.mkdir(dir, { recursive: true });
  await clearStaleSingleton(dir);

  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchContext(dir, opts.headless);
    // Stealth plugin defaults navigator.languages to en-US — override back to
    // Chinese so we look like a real CN user.
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en'],
        });
      } catch {
        /* ignore */
      }
    });
    return await fn(ctx);
  } catch (e) {
    if (ctx && meta) {
      throw await enrichErrorWithArtifact(ctx, meta, e);
    }
    throw e;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    await release().catch(() => {});
  }
}

async function launchContext(
  dir: string,
  headless: boolean,
): Promise<BrowserContext> {
  // Prefer real Chrome — best fingerprint match (real UA, real GPU, real
  // plugins). Falls back to bundled Chromium if Chrome isn't installed.
  const preferChrome = process.env.BB1688_FORCE_CHROMIUM !== '1';
  if (preferChrome) {
    try {
      return (await chromium.launchPersistentContext(dir, {
        ...LAUNCH_OPTS,
        headless,
        channel: 'chrome',
      })) as BrowserContext;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // Re-throw unknown errors; only fall through if Chrome is missing.
      if (
        !/Chromium\?|channel|Executable doesn't exist|chrome.*not found/i.test(
          msg,
        )
      ) {
        throw e;
      }
    }
  }

  try {
    return (await chromium.launchPersistentContext(dir, {
      ...LAUNCH_OPTS,
      headless,
    })) as BrowserContext;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/Executable doesn't exist/i.test(msg)) {
      throw new CliError(
        6,
        'CHROMIUM_MISSING',
        'Chromium not installed. Run: npx playwright install chromium',
      );
    }
    throw e;
  }
}
