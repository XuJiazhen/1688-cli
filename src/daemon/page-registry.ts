import { randomUUID } from 'node:crypto';

export type ManagedPageOwnerKind =
  | 'work_unit'
  | 'intervention'
  | 'health_probe';

export type ManagedPageState =
  | 'open'
  | 'closing'
  | 'cleanup_failed'
  | 'closed';

export interface ManagedPage {
  isClosed(): boolean;
  close(): Promise<void>;
  url(): string;
  bringToFront(): Promise<void>;
}

export interface ManagedPageSession {
  pageSessionId: string;
  profileId: string;
  contextGeneration: number;
  playwrightPageId: string;
  ownerKind: ManagedPageOwnerKind;
  ownerId: string;
  taskType: string | null;
  createdAt: string;
  lastUrlClass: string;
  state: ManagedPageState;
  transferredAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  cleanupAttempts: number;
}

export interface PageRegistryEvent {
  type:
    | 'registered'
    | 'owner_transferred'
    | 'close_started'
    | 'close_failed'
    | 'closed'
    | 'orphan_closed';
  pageSession: ManagedPageSession | null;
  occurredAt: string;
  detail?: string;
}

export interface RegisterPageInput {
  pageSessionId?: string;
  playwrightPageId?: string;
  ownerKind: ManagedPageOwnerKind;
  ownerId: string;
  taskType?: string | null;
  lastUrlClass?: string;
}

export interface ExpectedPageOwner {
  ownerKind: ManagedPageOwnerKind;
  ownerId: string;
}

export interface ProfilePageRegistryOptions {
  profileId: string;
  contextGeneration: number;
  now?: () => Date;
  idFactory?: () => string;
  onEvent?: (event: PageRegistryEvent) => void | Promise<void>;
  onCleanupFailure?: (session: ManagedPageSession, error: unknown) => void | Promise<void>;
}

interface RegistryEntry {
  page: ManagedPage;
  session: ManagedPageSession;
}

/**
 * Authoritative in-daemon Page ownership. Every mutation is serialized and
 * close operations require the caller's expected owner, so a stale WorkUnit
 * cannot close a Page after it has transferred to intervention.
 */
export class ProfilePageRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private tail: Promise<void> = Promise.resolve();
  private readonly profileId: string;
  private readonly contextGeneration: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onEvent?: ProfilePageRegistryOptions['onEvent'];
  private readonly onCleanupFailure?: ProfilePageRegistryOptions['onCleanupFailure'];

  constructor(options: ProfilePageRegistryOptions) {
    this.profileId = required(options.profileId, 'profileId');
    this.contextGeneration = positiveInteger(
      options.contextGeneration,
      'contextGeneration',
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.onEvent = options.onEvent;
    this.onCleanupFailure = options.onCleanupFailure;
  }

  async register(
    page: ManagedPage,
    input: RegisterPageInput,
  ): Promise<ManagedPageSession> {
    return this.serial(async () => {
      if (page.isClosed()) {
        throw new PageRegistryError('PAGE_ALREADY_CLOSED', 'Cannot register a closed Page.');
      }
      if (input.ownerKind === 'work_unit' && !input.taskType) {
        throw new PageRegistryError(
          'TASK_TYPE_REQUIRED',
          'WorkUnit-owned Pages require a TaskType.',
        );
      }
      if (input.ownerKind === 'intervention' && input.taskType) {
        throw new PageRegistryError(
          'INTERVENTION_TASK_TYPE_FORBIDDEN',
          'Intervention-owned Pages cannot retain a TaskType.',
        );
      }
      const pageSessionId = required(
        input.pageSessionId ?? this.idFactory(),
        'pageSessionId',
      );
      const playwrightPageId = required(
        input.playwrightPageId ?? this.idFactory(),
        'playwrightPageId',
      );
      if (this.entries.has(pageSessionId)) {
        throw new PageRegistryError(
          'PAGE_SESSION_CONFLICT',
          `PageSession ${pageSessionId} already exists.`,
        );
      }
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.session.playwrightPageId === playwrightPageId
            && entry.session.state !== 'closed',
        )
      ) {
        throw new PageRegistryError(
          'PLAYWRIGHT_PAGE_CONFLICT',
          `Playwright Page ${playwrightPageId} already has an owner.`,
        );
      }
      if (
        input.ownerKind === 'work_unit'
        && this.activeAutomationCountUnsafe() !== 0
      ) {
        throw new PageRegistryError(
          'PROFILE_WORK_UNIT_BUSY',
          'A Profile daemon can own only one active WorkUnit Page.',
        );
      }
      const session: ManagedPageSession = {
        pageSessionId,
        profileId: this.profileId,
        contextGeneration: this.contextGeneration,
        playwrightPageId,
        ownerKind: input.ownerKind,
        ownerId: required(input.ownerId, 'ownerId'),
        taskType: input.taskType ?? null,
        createdAt: this.now().toISOString(),
        lastUrlClass: input.lastUrlClass ?? 'blank',
        state: 'open',
        transferredAt: null,
        closedAt: null,
        closeReason: null,
        cleanupAttempts: 0,
      };
      this.entries.set(pageSessionId, { page, session });
      try {
        await this.emit('registered', session);
      } catch (error) {
        this.entries.delete(pageSessionId);
        try {
          if (!page.isClosed()) await page.close();
        } catch (closeError) {
          session.state = 'cleanup_failed';
          session.cleanupAttempts = 1;
          this.entries.set(pageSessionId, { page, session });
          await this.onCleanupFailure?.(copySession(session), closeError);
        }
        throw new PageRegistryError(
          'PAGE_REGISTRATION_EVENT_FAILED',
          `PageSession ${pageSessionId} could not durably register.`,
          error,
        );
      }
      return copySession(session);
    });
  }

  async updateUrlClass(
    pageSessionId: string,
    expected: ExpectedPageOwner,
    urlClass: string,
  ): Promise<ManagedPageSession> {
    return this.serial(async () => {
      const entry = this.openEntry(pageSessionId);
      assertOwner(entry.session, expected);
      entry.session.lastUrlClass = safeUrlClass(urlClass);
      return copySession(entry.session);
    });
  }

  async transferToIntervention(
    pageSessionId: string,
    expectedWorkUnitId: string,
    interventionSessionId: string,
  ): Promise<ManagedPageSession> {
    return this.serial(async () => {
      const entry = this.openEntry(pageSessionId);
      assertOwner(entry.session, {
        ownerKind: 'work_unit',
        ownerId: expectedWorkUnitId,
      });
      const previous = copySession(entry.session);
      entry.session.ownerKind = 'intervention';
      entry.session.ownerId = required(
        interventionSessionId,
        'interventionSessionId',
      );
      entry.session.taskType = null;
      entry.session.transferredAt = this.now().toISOString();
      try {
        await this.emit('owner_transferred', entry.session);
      } catch (error) {
        Object.assign(entry.session, previous);
        throw error;
      }
      return copySession(entry.session);
    });
  }

  async adoptPendingIntervention(
    pageSessionId: string,
    expectedPendingInterventionSessionId: string,
    interventionSessionId: string,
  ): Promise<ManagedPageSession> {
    return this.serial(async () => {
      const entry = this.openEntry(pageSessionId);
      assertOwner(entry.session, {
        ownerKind: 'intervention',
        ownerId: expectedPendingInterventionSessionId,
      });
      const previousOwnerId = entry.session.ownerId;
      entry.session.ownerId = required(
        interventionSessionId,
        'interventionSessionId',
      );
      try {
        await this.emit('owner_transferred', entry.session);
      } catch (error) {
        entry.session.ownerId = previousOwnerId;
        throw error;
      }
      return copySession(entry.session);
    });
  }

  async close(
    pageSessionId: string,
    expected: ExpectedPageOwner,
    reason: string,
  ): Promise<ManagedPageSession> {
    return this.serial(async () => {
      const entry = this.entry(pageSessionId);
      assertOwner(entry.session, expected);
      if (entry.session.state === 'closed') return copySession(entry.session);
      if (
        entry.session.state !== 'open'
        && entry.session.state !== 'cleanup_failed'
      ) {
        throw new PageRegistryError(
          'PAGE_CLOSE_IN_PROGRESS',
          `PageSession ${pageSessionId} is already closing.`,
        );
      }
      entry.session.state = 'closing';
      entry.session.cleanupAttempts += 1;
      await this.emit('close_started', entry.session);
      try {
        if (!entry.page.isClosed()) await entry.page.close();
        entry.session.state = 'closed';
        entry.session.closedAt = this.now().toISOString();
        entry.session.closeReason = required(reason, 'reason');
        await this.emit('closed', entry.session);
      } catch (error) {
        entry.session.state = 'cleanup_failed';
        await this.emit('close_failed', entry.session, safeError(error));
        await this.onCleanupFailure?.(copySession(entry.session), error);
        throw new PageRegistryError(
          'PAGE_CLEANUP_FAILED',
          `PageSession ${pageSessionId} could not be closed.`,
          error,
        );
      }
      return copySession(entry.session);
    });
  }

  async closeAll(reason: string): Promise<readonly ManagedPageSession[]> {
    const active = this.snapshot().filter((session) => session.state !== 'closed');
    const closed: ManagedPageSession[] = [];
    for (const session of active) {
      try {
        closed.push(
          await this.close(
            session.pageSessionId,
            { ownerKind: session.ownerKind, ownerId: session.ownerId },
            reason,
          ),
        );
      } catch {
        // The caller decides whether a cleanup failure forces Context rebuild.
      }
    }
    return closed;
  }

  async reconcileContextPages(
    contextPages: readonly ManagedPage[],
    pageId: (page: ManagedPage) => string,
  ): Promise<{ orphanCount: number; closeFailures: number }> {
    return this.serial(async () => {
      const known = new Set(
        [...this.entries.values()]
          .filter((entry) => entry.session.state !== 'closed')
          .map((entry) => entry.session.playwrightPageId),
      );
      let orphanCount = 0;
      let closeFailures = 0;
      for (const page of contextPages) {
        if (page.isClosed() || known.has(pageId(page))) continue;
        orphanCount += 1;
        try {
          await page.close();
          await this.emit('orphan_closed', null, 'unowned_context_page');
        } catch {
          closeFailures += 1;
        }
      }
      return { orphanCount, closeFailures };
    });
  }

  get(pageSessionId: string): ManagedPageSession | null {
    const entry = this.entries.get(pageSessionId);
    return entry ? copySession(entry.session) : null;
  }

  snapshot(): readonly ManagedPageSession[] {
    return [...this.entries.values()]
      .map((entry) => copySession(entry.session))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  activeAutomationCount(): number {
    return this.activeAutomationCountUnsafe();
  }

  activeInterventionCount(): number {
    return [...this.entries.values()].filter(
      ({ session }) =>
        session.ownerKind === 'intervention' && session.state !== 'closed',
    ).length;
  }

  hasCleanupFailures(): boolean {
    return [...this.entries.values()].some(
      ({ session }) => session.state === 'cleanup_failed',
    );
  }

  private activeAutomationCountUnsafe(): number {
    return [...this.entries.values()].filter(
      ({ session }) =>
        session.ownerKind === 'work_unit' && session.state !== 'closed',
    ).length;
  }

  private entry(pageSessionId: string): RegistryEntry {
    const entry = this.entries.get(required(pageSessionId, 'pageSessionId'));
    if (!entry) {
      throw new PageRegistryError(
        'PAGE_SESSION_NOT_FOUND',
        `Unknown PageSession ${pageSessionId}.`,
      );
    }
    return entry;
  }

  private openEntry(pageSessionId: string): RegistryEntry {
    const entry = this.entry(pageSessionId);
    if (entry.session.state !== 'open') {
      throw new PageRegistryError(
        'PAGE_SESSION_NOT_OPEN',
        `PageSession ${pageSessionId} is ${entry.session.state}.`,
      );
    }
    return entry;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async emit(
    type: PageRegistryEvent['type'],
    session: ManagedPageSession | null,
    detail?: string,
  ): Promise<void> {
    await this.onEvent?.({
      type,
      pageSession: session === null ? null : copySession(session),
      occurredAt: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

export class PageRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PageRegistryError';
  }
}

function assertOwner(
  session: ManagedPageSession,
  expected: ExpectedPageOwner,
): void {
  if (
    session.ownerKind !== expected.ownerKind
    || session.ownerId !== expected.ownerId
  ) {
    throw new PageRegistryError(
      'STALE_PAGE_OWNER',
      `Expected ${expected.ownerKind}:${expected.ownerId}, current owner is ${session.ownerKind}:${session.ownerId}.`,
    );
  }
}

function copySession(session: ManagedPageSession): ManagedPageSession {
  return { ...session };
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty.`);
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function safeUrlClass(value: string): string {
  const normalized = required(value, 'urlClass');
  if (/[:/?#=&]/u.test(normalized)) {
    throw new TypeError('urlClass must be a safe classification, not a URL.');
  }
  return normalized;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : 'unknown';
}
