// Long-lived shared BrowserContext for the daemon. Operations are serialized
// (one Playwright op at a time) so we look like a single, deliberate user
// rather than concurrent requests.

import fs from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { defaultProfileName, profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { CliError } from '../io/errors.js';
import { clearStaleSingleton } from './context.js';
import {
  enrichErrorWithArtifact,
  type RunMeta,
} from './artifacts.js';
import { detectPageState, type PageState } from './page-state.js';

const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

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

let sharedCtx: BrowserContext | null = null;
let lockRelease: (() => Promise<void>) | null = null;
let opChain: Promise<unknown> = Promise.resolve();
let sharedProfile: string | null = null;
let sharedHeadful: boolean | null = null;
let sharedReleaseFailure: string | null = null;

export interface SharedContextOptions {
  /** Legacy daemon defaults to headless; Supervisor-managed daemon sets true. */
  headful?: boolean;
}

export interface SharedContextStatus {
  profile: string | null;
  browserAlive: boolean;
  pageCount: number;
  currentUrl: string | null;
  pageState: PageState | null;
  loggedIn: boolean | null;
  headful: boolean | null;
  chromiumPid: number | null;
  fatalRecoveryState: string | null;
}

export async function getSharedContext(
  profile?: string,
  options: SharedContextOptions = {},
): Promise<BrowserContext> {
  const profileName = defaultProfileName(profile);
  const headful = options.headful ?? false;
  if (sharedReleaseFailure !== null) {
    throw new CliError(
      5,
      'CONTEXT_QUARANTINED',
      `Profile Context is quarantined after an unproven shutdown: ${sharedReleaseFailure}`,
    );
  }
  if (sharedCtx) {
    if (sharedProfile !== profileName) {
      throw new CliError(
        5,
        'DAEMON_PROFILE_MISMATCH',
        `Daemon shared context is bound to profile "${sharedProfile}", not "${profileName}".`,
      );
    }
    if (sharedHeadful !== headful) {
      throw new CliError(
        5,
        'DAEMON_CONTEXT_MODE_MISMATCH',
        `Daemon context is already ${sharedHeadful ? 'headful' : 'headless'} and cannot change mode in place.`,
      );
    }
    return sharedCtx;
  }
  lockRelease = await acquireLock(profileName);
  const dir = profilePath(profileName);
  await fs.mkdir(dir, { recursive: true });
  await clearStaleSingleton(dir);
  sharedCtx = await launchPreferringChrome(dir, !headful);
  sharedProfile = profileName;
  sharedHeadful = headful;
  sharedReleaseFailure = null;
  await sharedCtx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en'],
      });
    } catch {
      /* ignore */
    }
  });
  return sharedCtx;
}

export async function runOnSharedCtx<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  meta?: RunMeta,
  profile?: string,
  contextOptions: SharedContextOptions = {},
): Promise<T> {
  // Append to serial queue. Each op waits for the previous one to finish.
  const prev = opChain;
  let resolveOp!: (v: T) => void;
  let rejectOp!: (e: unknown) => void;
  const opPromise = new Promise<T>((res, rej) => {
    resolveOp = res;
    rejectOp = rej;
  });
  opChain = prev.then(async () => {
    try {
      const ctx = await getSharedContext(profile, contextOptions);
      resolveOp(await fn(ctx));
    } catch (e) {
      const ctx = sharedCtx;
      if (ctx && meta) {
        rejectOp(await enrichErrorWithArtifact(ctx, meta, e));
      } else {
        rejectOp(e);
      }
    }
  });
  return opPromise;
}

export async function getSharedContextStatus(): Promise<SharedContextStatus> {
  if (!sharedCtx) {
    return {
      profile: sharedProfile,
      browserAlive: false,
      pageCount: 0,
      currentUrl: null,
      pageState: null,
      loggedIn: null,
      headful: sharedHeadful,
      chromiumPid: null,
      fatalRecoveryState: sharedReleaseFailure,
    };
  }

  const pages = sharedCtx.pages().filter((p) => !p.isClosed());
  const page = pages.at(-1) ?? null;
  const pageState = page ? await detectPageState(page).catch(() => null) : null;
  return {
    profile: sharedProfile,
    browserAlive: true,
    pageCount: pages.length,
    currentUrl: page?.url() ?? null,
    pageState,
    loggedIn: pageState
      ? pageState.kind === 'normal_1688_page'
        ? true
        : pageState.kind === 'not_logged_in'
          ? false
          : null
      : null,
    headful: sharedHeadful,
    chromiumPid: chromiumProcessId(sharedCtx),
    fatalRecoveryState: sharedReleaseFailure,
  };
}

function chromiumProcessId(context: BrowserContext): number | null {
  const browser = context.browser() as unknown as {
    process?: () => { pid?: number } | null;
  } | null;
  const pid = browser?.process?.()?.pid;
  return Number.isSafeInteger(pid) && (pid ?? 0) > 0 ? pid! : null;
}

/** Daemon-owned, non-starting accessor used by the Page registry reconcile. */
export function peekSharedContext(profile?: string): BrowserContext | null {
  const profileName = defaultProfileName(profile);
  return sharedProfile === profileName ? sharedCtx : null;
}

export interface SharedContextReleaseOptions {
  closeTimeoutMs?: number;
  processAlive?: (pid: number) => boolean;
}

export async function releaseSharedContext(
  options: SharedContextReleaseOptions = {},
): Promise<void> {
  const context = sharedCtx;
  if (context === null) return;
  const timeoutMs = positiveTimeout(options.closeTimeoutMs ?? 30_000);
  const pid = chromiumProcessId(context);
  let failure: unknown | null = null;
  try {
    await withTimeout(context.close(), timeoutMs);
  } catch (error) {
    failure = error;
  }
  if (failure !== null) {
    const processAlive = options.processAlive ?? defaultProcessAlive;
    const browser = context.browser();
    const exited = pid !== null
      ? !processAlive(pid)
      : browser !== null && !browser.isConnected();
    if (!exited) {
      sharedReleaseFailure = safeReleaseError(failure);
      throw new CliError(
        5,
        'CONTEXT_RELEASE_UNPROVEN',
        'Context close failed or timed out while Chromium may still be alive; retaining the Profile lock and owner state.',
      );
    }
  }
  if (lockRelease) {
    const release = lockRelease;
    try {
      await release();
    } catch (error) {
      sharedReleaseFailure = `Profile lock release failed after Context close: ${safeReleaseError(error)}`;
      throw new CliError(
        5,
        'CONTEXT_LOCK_RELEASE_UNPROVEN',
        'Context closed but the Profile lock release was not proven; retaining the in-memory owner and denying replacement.',
      );
    }
    lockRelease = null;
  }
  sharedCtx = null;
  sharedProfile = null;
  sharedHeadful = null;
  sharedReleaseFailure = null;
}

/** Test-only state injection for close rejection/timeout containment. */
export function installSharedContextForTesting(input: {
  context: BrowserContext;
  profile: string;
  headful: boolean;
  release: () => Promise<void>;
} | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only shared Context hook');
  sharedCtx = input?.context ?? null;
  sharedProfile = input?.profile ?? null;
  sharedHeadful = input?.headful ?? null;
  lockRelease = input?.release ?? null;
  sharedReleaseFailure = null;
}

async function launchPreferringChrome(
  dir: string,
  headless: boolean,
): Promise<BrowserContext> {
  const useChrome = process.env.BB1688_FORCE_CHROMIUM !== '1';
  if (useChrome) {
    try {
      return (await chromium.launchPersistentContext(dir, {
        ...LAUNCH_OPTS,
        headless,
        channel: 'chrome',
      })) as BrowserContext;
    } catch (e) {
      const msg = (e as Error).message ?? '';
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

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('closeTimeoutMs must be positive');
  return value;
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Context close timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeReleaseError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : 'unknown close failure';
}
