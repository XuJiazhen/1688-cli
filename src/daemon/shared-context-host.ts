import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { parseIdentity } from '../auth/cookies.js';
import {
  getSharedContext,
  peekSharedContext,
  releaseSharedContext,
} from '../session/shared.js';
import { detectPageState } from '../session/page-state.js';
import { profilePath } from '../session/paths.js';
import type {
  IdentityProbeReceipt,
  PersistentContextDescriptor,
  PersistentContextHost,
} from './supervisor-runtime.js';
import type { ManagedPage } from './page-registry.js';

const IDENTITY_PROBE_URL = 'https://myalibaba.1688.com/';

export interface SharedPersistentContextHostOptions {
  profileId: string;
  profileName: string;
  daemonInstanceId: string;
  contextGeneration: number;
  now?: () => Date;
  idFactory?: () => string;
  chromiumPidResolver?: (profileDirectory: string) => Promise<number>;
}

/** Binds the existing singleton Playwright launch path to the managed runtime. */
export class SharedPersistentContextHost implements PersistentContextHost {
  private readonly pageIds = new WeakMap<object, string>();
  private contextGeneration: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly chromiumPidResolver: (profileDirectory: string) => Promise<number>;

  constructor(private readonly options: SharedPersistentContextHostOptions) {
    this.contextGeneration = options.contextGeneration;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.chromiumPidResolver = options.chromiumPidResolver ?? discoverChromiumPid;
  }

  async ensureStarted(input: {
    profileId: string;
    profileName: string;
    daemonInstanceId: string;
    contextGeneration: number;
    headful: true;
  }): Promise<PersistentContextDescriptor> {
    this.assertOwner(input);
    const context = await getSharedContext(input.profileName, { headful: true });
    const browser = context.browser() as unknown as {
      process?: () => { pid?: number } | null;
    } | null;
    const internalPid = browser?.process?.()?.pid;
    const chromiumPid = Number.isSafeInteger(internalPid) && (internalPid ?? 0) > 0
      ? internalPid!
      : await this.chromiumPidResolver(profilePath(input.profileName));
    return { ...input, chromiumPid };
  }

  async createPage(): Promise<ManagedPage> {
    const context = await getSharedContext(this.options.profileName, { headful: true });
    const page = await context.newPage();
    this.pageId(page);
    return page;
  }

  pages(): readonly ManagedPage[] {
    // Runtime invokes this only after ensureStarted/createPage.
    const context = peekSharedContext(this.options.profileName);
    return context?.pages() ?? [];
  }

  pageId(page: ManagedPage): string {
    const key = page as object;
    let id = this.pageIds.get(key);
    if (id === undefined) {
      id = `playwright-page-${this.idFactory()}`;
      this.pageIds.set(key, id);
    }
    return id;
  }

  async restart(input: {
    reason: string;
    nextContextGeneration: number;
  }): Promise<PersistentContextDescriptor> {
    if (input.nextContextGeneration !== this.contextGeneration + 1) {
      throw new Error('Context restart must increment generation exactly once.');
    }
    await releaseSharedContext();
    this.contextGeneration = input.nextContextGeneration;
    return this.ensureStarted({
      profileId: this.options.profileId,
      profileName: this.options.profileName,
      daemonInstanceId: this.options.daemonInstanceId,
      contextGeneration: this.contextGeneration,
      headful: true,
    });
  }

  async stop(): Promise<void> {
    await releaseSharedContext();
  }

  async probeIdentity(input: {
    expectedMemberId: string;
    probeRevision: string;
    page?: ManagedPage;
  }): Promise<IdentityProbeReceipt> {
    const context = await getSharedContext(this.options.profileName, { headful: true });
    const page = input.page as Page | undefined;
    let reachable = false;
    if (page) {
      try {
        const response = await page.goto(IDENTITY_PROBE_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
        reachable = response !== null && response.status() < 400;
      } catch {
        reachable = false;
      }
    }
    const state = page && reachable
      ? await detectPageState(page).catch(() => null)
      : null;
    const identity = parseIdentity(await context.cookies());
    const pageState = state?.kind === 'not_logged_in'
      ? 'login_required'
      : state?.kind === 'risk_challenge'
        ? 'risk_challenge'
        : state === null || state.kind === 'unknown' || state.kind === 'rate_limited'
          ? 'unreachable'
          : 'normal';
    const observedMemberId = identity?.memberId ?? null;
    const probedAt = this.now().toISOString();
    const passed = pageState === 'normal'
      && observedMemberId === input.expectedMemberId;
    return {
      probeReceiptId: `probe-${this.idFactory()}`,
      probeRevision: input.probeRevision,
      probedAt,
      expectedMemberId: input.expectedMemberId,
      observedMemberId,
      pageState,
      passed,
      safeEvidenceHash: createHash('sha256')
        .update(JSON.stringify({
          profileId: this.options.profileId,
          contextGeneration: this.contextGeneration,
          expectedMemberId: input.expectedMemberId,
          observedMemberId,
          pageState,
          probeRevision: input.probeRevision,
          probedAt,
        }))
        .digest('hex'),
    };
  }

  private assertOwner(input: {
    profileId: string;
    profileName: string;
    daemonInstanceId: string;
    contextGeneration: number;
  }): void {
    if (
      input.profileId !== this.options.profileId
      || input.profileName !== this.options.profileName
      || input.daemonInstanceId !== this.options.daemonInstanceId
      || input.contextGeneration !== this.contextGeneration
    ) {
      throw new Error('Persistent Context owner binding mismatch.');
    }
  }
}

const execFileAsync = promisify(execFile);

async function discoverChromiumPid(profileDirectory: string): Promise<number> {
  if (process.platform === 'win32') {
    throw new Error('Windows managed daemon requires an explicit Chromium PID resolver.');
  }
  const { stdout } = await execFileAsync('ps', [
    '-axo',
    'pid=,ppid=,command=',
  ], { maxBuffer: 4 * 1024 * 1024 });
  const escapedProfile = profileDirectory;
  const candidates = stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[3] ?? '';
    if (
      !Number.isSafeInteger(pid)
      || !/(?:Google Chrome|Chromium|chrome)/iu.test(command)
      || !command.includes(escapedProfile)
    ) return [];
    return [pid];
  });
  const pid = candidates.sort((left, right) => left - right)[0];
  if (pid === undefined) {
    throw new Error('Managed Chromium PID could not be discovered for the Profile directory.');
  }
  return pid;
}
