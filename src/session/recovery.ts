import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from 'playwright';
import { CliError, type CliErrorDetails } from '../io/errors.js';
import { info } from '../io/output.js';
import {
  captureFailureArtifact,
  type FailureTraceSnapshot,
  type RunMeta,
} from './artifacts.js';
import { readConfig } from './config.js';
import { detectPageState, type PageState } from './page-state.js';
import { sleep, waitWithDeadline } from './wait.js';

export type RecoveryFailureKind =
  | 'not_logged_in'
  | 'risk_challenge'
  | 'rate_limited'
  | 'element_missing'
  | 'element_blocked'
  | 'navigation_timeout'
  | 'page_unstable'
  | 'browser_context_broken'
  | 'network_error'
  | 'site_changed'
  | 'unknown';

export type RecoveryAction =
  | 'pause_for_manual_login'
  | 'pause_for_manual_challenge'
  | 'backoff'
  | 'retry_after_resnapshot'
  | 'dismiss_overlay_and_retry'
  | 'wait_for_business_signal'
  | 'stabilize_and_retry'
  | 'recreate_context'
  | 'retry_after_network_backoff'
  | 'fail_with_artifacts'
  | 'retry_once_then_fail';

export interface RecoveryDecision {
  failureKind: RecoveryFailureKind;
  action: RecoveryAction;
  retryable: boolean;
  maxRetries: number;
  cooldownMs: number;
  exitCode: number;
  code: string;
  message: string;
  recoverHint?: string;
}

export interface RecoveryOptions {
  maxRetries?: number;
  headed?: boolean;
  beforeRetry?: (ctx: RecoveryContext) => Promise<void>;
}

export interface RecoveryContext {
  ctx: BrowserContext;
  page: Page | null;
  attempt: number;
  meta: RunMeta;
  pageState: PageState | null;
  failureKind: RecoveryFailureKind;
  decision: RecoveryDecision;
}

export interface RecoveryFailureSignals {
  message: string;
  code?: string;
  pageState: PageState | null;
  trace: FailureTraceSnapshot;
}

interface TraceState {
  console: Array<Record<string, unknown>>;
  pageErrors: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
  httpErrors: Array<Record<string, unknown>>;
  detach: () => void;
}

const MAX_TRACE_ITEMS = 80;
const DEFAULT_HEADED_VERIFICATION_MS = 3 * 60_000;

function pickPage(ctx: BrowserContext): Page | null {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return pages.at(-1) ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof CliError) return error.code;
  const maybe = error as { code?: unknown };
  return typeof maybe?.code === 'string' ? maybe.code : undefined;
}

function pushBounded(arr: Array<Record<string, unknown>>, item: Record<string, unknown>): void {
  arr.push(item);
  if (arr.length > MAX_TRACE_ITEMS) arr.shift();
}

function requestResourceType(req: Request): string {
  try {
    return req.resourceType();
  } catch {
    return 'unknown';
  }
}

function requestMethod(req: Request): string {
  try {
    return req.method();
  } catch {
    return 'GET';
  }
}

function requestUrl(req: Request): string {
  try {
    return req.url();
  } catch {
    return '';
  }
}

function consoleLocation(msg: ConsoleMessage): Record<string, unknown> | undefined {
  try {
    return msg.location();
  } catch {
    return undefined;
  }
}

function attachTrace(ctx: BrowserContext): TraceState {
  const trace: TraceState = {
    console: [],
    pageErrors: [],
    recent: [],
    failed: [],
    httpErrors: [],
    detach: () => {},
  };
  const pages = new Set<Page>();
  const detachPage = new Map<Page, () => void>();

  const attachPage = (page: Page) => {
    if (pages.has(page)) return;
    pages.add(page);
    const onConsole = (msg: ConsoleMessage) => {
      if (!['error', 'warning'].includes(msg.type())) return;
      pushBounded(trace.console, {
        at: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
        location: consoleLocation(msg),
      });
    };
    const onPageError = (err: Error) => {
      pushBounded(trace.pageErrors, {
        at: new Date().toISOString(),
        message: err.message,
        stack: err.stack,
      });
    };
    const onRequest = (req: Request) => {
      pushBounded(trace.recent, {
        at: new Date().toISOString(),
        method: requestMethod(req),
        url: requestUrl(req),
        resourceType: requestResourceType(req),
      });
    };
    const onRequestFailed = (req: Request) => {
      pushBounded(trace.failed, {
        at: new Date().toISOString(),
        method: requestMethod(req),
        url: requestUrl(req),
        resourceType: requestResourceType(req),
        failure: req.failure()?.errorText,
      });
    };
    const onResponse = (resp: Response) => {
      const status = resp.status();
      if (status < 400) return;
      const req = resp.request();
      pushBounded(trace.httpErrors, {
        at: new Date().toISOString(),
        status,
        method: requestMethod(req),
        url: resp.url(),
        resourceType: requestResourceType(req),
      });
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('request', onRequest);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);
    detachPage.set(page, () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('request', onRequest);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    });
  };

  for (const page of ctx.pages()) attachPage(page);
  ctx.on('page', attachPage);
  trace.detach = () => {
    ctx.off('page', attachPage);
    for (const detach of detachPage.values()) detach();
    detachPage.clear();
  };
  return trace;
}

function snapshotTrace(trace: TraceState): FailureTraceSnapshot {
  return {
    console: [...trace.console],
    pageErrors: [...trace.pageErrors],
    network: {
      recent: [...trace.recent],
      failed: [...trace.failed],
      httpErrors: [...trace.httpErrors],
    },
  };
}

export function classifyRecoveryFailure(
  signals: RecoveryFailureSignals,
): RecoveryFailureKind {
  const { message, code, pageState, trace } = signals;
  const msg = `${code ?? ''}\n${message}`;

  if (pageState?.kind === 'not_logged_in' || code === 'NOT_LOGGED_IN') {
    return 'not_logged_in';
  }
  if (pageState?.kind === 'risk_challenge' || code === 'RISK_CONTROL') {
    return 'risk_challenge';
  }
  if (pageState?.kind === 'rate_limited') return 'rate_limited';
  if (/Target page, context or browser has been closed|Browser closed|Target closed|Context closed|page crash/i.test(msg)) {
    return 'browser_context_broken';
  }
  if (/ECONNRESET|ENOTFOUND|ERR_(?:TIMED_OUT|CONNECTION|INTERNET|NETWORK|NAME)|net::|NETWORK_ERROR/i.test(msg)) {
    return 'network_error';
  }
  if (/429|403|访问频繁|请求频繁|操作频繁|稍后再试|系统繁忙/i.test(msg)) {
    return 'rate_limited';
  }
  if (/Timeout .*navigation|Navigation timeout|waiting for .*navigation|waitForLoadState/i.test(msg)) {
    return 'navigation_timeout';
  }
  if (/not visible|not enabled|does not receive pointer events|intercepts pointer events|element is outside|Element is not attached/i.test(msg)) {
    return 'element_blocked';
  }
  if (/locator|selector|waiting for .*visible|No .* found|not found|Could not (?:find|locate).*element|element.*missing/i.test(msg)) {
    return 'element_missing';
  }
  if (trace.network.httpErrors.some((r) => r.status === 429)) return 'rate_limited';
  if (trace.network.failed.length >= 3 || trace.network.httpErrors.length >= 5) {
    return 'network_error';
  }
  if (pageState?.kind === 'normal_1688_page' && /NO_RESULTS|UPLOAD_FAILED|parse|structure|expected/i.test(msg)) {
    return 'site_changed';
  }
  return 'unknown';
}

export function recoveryDecisionFor(
  kind: RecoveryFailureKind,
  headed: boolean,
): RecoveryDecision {
  switch (kind) {
    case 'not_logged_in':
      return {
        failureKind: kind,
        action: 'pause_for_manual_login',
        retryable: false,
        maxRetries: 0,
        cooldownMs: 0,
        exitCode: 3,
        code: 'NOT_LOGGED_IN',
        message: 'Session expired. Run `1688 login`.',
        recoverHint: 'Session expired. Run `1688 login` and retry.',
      };
    case 'risk_challenge':
      return {
        failureKind: kind,
        action: 'pause_for_manual_challenge',
        retryable: false,
        maxRetries: 0,
        cooldownMs: headed ? 0 : 5 * 60_000,
        exitCode: 4,
        code: 'RISK_CONTROL',
        message: headed
          ? 'Slider verification not solved in time. Try again with `--headed`.'
          : 'Aliyun risk control triggered. Run once with `--headed` to solve it manually.',
        recoverHint: '1688 is showing a verification challenge. Retry once with `--headed` and complete the manual check.',
      };
    case 'rate_limited':
      return {
        failureKind: kind,
        action: 'backoff',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 60_000 + Math.floor(Math.random() * 30_000),
        exitCode: 9,
        code: 'RATE_LIMITED',
        message: '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
        recoverHint: '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
      };
    case 'element_missing':
      return {
        failureKind: kind,
        action: 'retry_after_resnapshot',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 1000,
        exitCode: 1,
        code: 'ELEMENT_MISSING',
        message: 'Expected page element was not found.',
      };
    case 'element_blocked':
      return {
        failureKind: kind,
        action: 'dismiss_overlay_and_retry',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 1000,
        exitCode: 1,
        code: 'ELEMENT_BLOCKED',
        message: 'Expected page element was present but not clickable.',
      };
    case 'navigation_timeout':
      return {
        failureKind: kind,
        action: 'wait_for_business_signal',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 1500,
        exitCode: 9,
        code: 'NAVIGATION_TIMEOUT',
        message: 'Page navigation timed out before the expected business signal appeared.',
      };
    case 'page_unstable':
      return {
        failureKind: kind,
        action: 'stabilize_and_retry',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 1500,
        exitCode: 1,
        code: 'PAGE_UNSTABLE',
        message: 'The page did not become stable enough to operate safely.',
      };
    case 'browser_context_broken':
      return {
        failureKind: kind,
        action: 'recreate_context',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 0,
        exitCode: 130,
        code: 'BROWSER_CONTEXT_BROKEN',
        message: 'Browser context closed or crashed during the operation.',
      };
    case 'network_error':
      return {
        failureKind: kind,
        action: 'retry_after_network_backoff',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 3000,
        exitCode: 9,
        code: 'NETWORK_ERROR',
        message: 'Network error while operating 1688.',
      };
    case 'site_changed':
      return {
        failureKind: kind,
        action: 'fail_with_artifacts',
        retryable: false,
        maxRetries: 0,
        cooldownMs: 0,
        exitCode: 1,
        code: 'SITE_CHANGED',
        message: '1688 page structure may have changed. Inspect the saved artifacts and update the command.',
      };
    case 'unknown':
      return {
        failureKind: kind,
        action: 'retry_once_then_fail',
        retryable: true,
        maxRetries: 1,
        cooldownMs: 1000,
        exitCode: 1,
        code: 'UNKNOWN_RECOVERY_FAILURE',
        message: '1688 operation failed for an unknown reason.',
      };
  }
}

export function pageStateError(
  state: PageState,
  headed = false,
): CliError | null {
  if (
    state.kind !== 'not_logged_in' &&
    state.kind !== 'risk_challenge' &&
    state.kind !== 'rate_limited'
  ) {
    return null;
  }
  const decision = recoveryDecisionFor(state.kind, headed);
  return new CliError(decision.exitCode, decision.code, decision.message, {
    category: decision.failureKind,
    currentUrl: state.url,
    pageState: state.kind,
    failureKind: decision.failureKind,
    recoveryAction: decision.action,
    recoverHint: decision.recoverHint,
    retryable: decision.retryable,
  });
}

export interface CollectionPageAvailabilityOptions {
  headed: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface CollectionPageAvailability {
  recoveredRiskChallenge: boolean;
}

/**
 * Keeps a headed collection command alive while the user resolves a slider.
 * Login expiry and rate limiting remain separate states and never wait here.
 */
export async function waitForCollectionPageAvailability(
  page: Page,
  options: CollectionPageAvailabilityOptions,
): Promise<CollectionPageAvailability> {
  const initialState = await detectPageState(page);
  const initialError = pageStateError(initialState, options.headed);
  if (initialState.kind !== 'risk_challenge' || !options.headed) {
    if (initialError !== null) throw initialError;
    return { recoveredRiskChallenge: false };
  }

  const configuredTimeoutMs =
    options.timeoutMs ??
    (await readConfig()).timeouts?.headedVerificationMs ??
    DEFAULT_HEADED_VERIFICATION_MS;
  info('Verification page detected - complete the slider in the browser window.');

  const resolved = await waitWithDeadline<PageState>(
    async ({ remainingMs }) => {
      if (options.signal?.aborted === true) {
        throw new CliError(
          9,
          'COLLECTION_CANCELLED',
          'Collection was cancelled while waiting for manual verification.',
          { retryable: true },
        );
      }
      if (page.isClosed()) {
        throw new CliError(130, 'CANCELED', 'Browser closed.');
      }

      const state = await detectPageState(page);
      if (state.kind === 'not_logged_in' || state.kind === 'rate_limited') {
        throw pageStateError(state, true);
      }
      if (state.kind === 'normal_1688_page') return state;
      if (remainingMs > 0) return null;
      return state;
    },
    {
      timeoutMs: configuredTimeoutMs,
      intervalMs: options.intervalMs ?? 500,
      onTimeout: () => initialState,
    },
  );

  if (resolved.kind !== 'normal_1688_page') {
    throw initialError;
  }
  return { recoveredRiskChallenge: true };
}

async function runRecoveryAction(decision: RecoveryDecision, page: Page | null): Promise<void> {
  switch (decision.action) {
    case 'dismiss_overlay_and_retry':
      if (page && !page.isClosed()) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(decision.cooldownMs);
      }
      return;
    case 'backoff':
      info(`1688 rate limit detected; backing off for ${Math.round(decision.cooldownMs / 1000)}s before one retry...`);
      await sleep(decision.cooldownMs);
      return;
    case 'retry_after_network_backoff':
    case 'retry_after_resnapshot':
    case 'wait_for_business_signal':
    case 'stabilize_and_retry':
    case 'retry_once_then_fail':
      await sleep(decision.cooldownMs);
      return;
    default:
      return;
  }
}

function recoveryDetails(
  decision: RecoveryDecision,
  artifactDetails: CliErrorDetails,
  baseDetails: CliErrorDetails = {},
): CliErrorDetails {
  const baseFailureKind =
    typeof baseDetails.failureKind === 'string'
      ? baseDetails.failureKind
      : undefined;
  const baseRecoveryAction =
    typeof baseDetails.recoveryAction === 'string'
      ? baseDetails.recoveryAction
      : undefined;
  return {
    ...artifactDetails,
    category: baseDetails.category ?? artifactDetails.category ?? decision.failureKind,
    failureKind: baseFailureKind ?? decision.failureKind,
    recoveryAction: baseRecoveryAction ?? decision.action,
    recoverHint:
      baseDetails.recoverHint ?? artifactDetails.recoverHint ?? decision.recoverHint,
    retryable: baseDetails.retryable ?? decision.retryable,
  };
}

function shouldPreserveCliError(error: CliError): boolean {
  return error.exitCode !== 1 || error.code === 'SIMILAR_UNAVAILABLE';
}

export async function withRecovery<T>(
  ctx: BrowserContext,
  meta: RunMeta,
  operation: (attempt: number) => Promise<T>,
  options: RecoveryOptions = {},
): Promise<T> {
  let lastError: unknown = null;
  const configuredRetries = options.maxRetries ?? 1;

  for (let attempt = 0; attempt <= configuredRetries; attempt++) {
    const trace = attachTrace(ctx);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      trace.detach();
      const currentPage = pickPage(ctx);
      const pageState = currentPage
        ? await detectPageState(currentPage).catch(() => null)
        : null;
      const signals: RecoveryFailureSignals = {
        message: errorMessage(error),
        code: errorCode(error),
        pageState,
        trace: snapshotTrace(trace),
      };
      const failureKind = classifyRecoveryFailure(signals);
      const decision = recoveryDecisionFor(failureKind, options.headed === true);
      const allowedRetries = Math.min(configuredRetries, decision.maxRetries);
      const willRetry = decision.retryable && attempt < allowedRetries;
      const artifactDetails = await captureFailureArtifact(ctx, meta, error, {
        pageState,
        trace: signals.trace,
        recovery: {
          attempt,
          willRetry,
          failureKind: decision.failureKind,
          action: decision.action,
          retryable: decision.retryable,
          maxRetries: allowedRetries,
          cooldownMs: decision.cooldownMs,
        },
      }).catch(() => ({}));

      if (!willRetry) {
        if (error instanceof CliError && shouldPreserveCliError(error)) {
          throw error.withDetails(
            recoveryDetails(decision, artifactDetails, error.details),
          );
        }
        throw new CliError(
          decision.exitCode,
          decision.code,
          decision.message,
          recoveryDetails(decision, artifactDetails),
        );
      }

      await runRecoveryAction(decision, currentPage);
      await options.beforeRetry?.({
        ctx,
        page: currentPage,
        attempt,
        meta,
        pageState,
        failureKind,
        decision,
      });
    } finally {
      trace.detach();
    }
  }

  const message = errorMessage(lastError);
  throw new CliError(1, 'RECOVERY_EXHAUSTED', message);
}
