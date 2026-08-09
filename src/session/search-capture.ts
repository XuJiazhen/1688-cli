import type { Page, Response as PWResponse } from 'playwright';
import { CliError } from '../io/errors.js';
import { waitWithDeadline } from './wait.js';
import {
  SEARCH_APP_ID,
  parseOfferItemsFromMtopText,
  parseSearchMtopPageV1,
  readCapturedSearchRequestBusinessV1,
  readSearchMtopRequestMeta,
  type Offer,
  type SearchMtopPageV1,
} from './search-mtop.js';
import {
  assertCapturedSearchRequestParityV1,
  type CompiledSearchPageRequestV1,
} from './search-compiler.js';
import { sanitizeCollectorPayloadV1 } from './collector-raw-archive.js';
import { parseMtopJsonp } from './mtop.js';
import {
  redactTextForDiagnostics,
  redactUrlForDiagnostics,
} from './redaction.js';

export interface SearchOfferCaptureOptions {
  page: Page;
  requireMethod?: string;
  requireSortType?: string;
  allowUnscopedWirelessRecommend?: boolean;
  targetPage?: () => number;
  keep?: 'first' | 'largest';
}

export interface SearchOfferCaptureFailure {
  at: string;
  url: string;
  name?: string;
  message: string;
}

export interface SearchOfferCaptureDiagnostics {
  startedAt: string;
  endedAt?: string;
  disposed: boolean;
  finalStatus?: SearchOfferCaptureWaitStatus;
  timedOut: boolean;
  seenCount: number;
  matchedCount: number;
  parsedCount: number;
  failureCount: number;
  lastSeenUrl?: string;
  lastMatchedUrl?: string;
  lastParsedUrl?: string;
  lastError?: { name?: string; message: string };
  failures: SearchOfferCaptureFailure[];
}

export type SearchOfferCaptureWaitStatus =
  | 'captured'
  | 'timeout'
  | 'blocked'
  | 'browser_closed'
  | 'stream_closed';

export interface SearchOfferCaptureWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  isBlocked?: () => boolean | Promise<boolean>;
  isClosed?: () => boolean;
}

export interface SearchOfferCaptureWaitResult {
  status: SearchOfferCaptureWaitStatus;
  offers: Offer[];
  remoteHasMore: boolean | null;
  diagnostics: SearchOfferCaptureDiagnostics;
}

export interface SearchOfferCaptureResult<TResult> {
  actionResult: TResult;
  status: SearchOfferCaptureWaitStatus;
  offers: Offer[];
  remoteHasMore: boolean | null;
  diagnostics: SearchOfferCaptureDiagnostics;
}

export async function captureSearchOffersForAction<TResult>(
  opts: SearchOfferCaptureOptions,
  action: () => Promise<TResult>,
  waitOptions: SearchOfferCaptureWaitOptions,
): Promise<SearchOfferCaptureResult<TResult>> {
  const capture = startSearchOfferCapture(opts);
  return capture.waitForAction(action, waitOptions);
}

export function startSearchOfferCapture(opts: SearchOfferCaptureOptions) {
  const maxDiagnosticsEntries = 5;
  const startedAt = new Date().toISOString();
  let endedAt: string | undefined;
  let disposed = false;
  let pageClosed = false;
  let finalStatus: SearchOfferCaptureWaitStatus | undefined;
  let timedOut = false;
  let offers: Offer[] = [];
  let remoteHasMore: boolean | null = null;
  let seenCount = 0;
  let matchedCount = 0;
  let parsedCount = 0;
  let lastSeenUrl: string | undefined;
  let lastMatchedUrl: string | undefined;
  let lastParsedUrl: string | undefined;
  let lastError: { name?: string; message: string } | undefined;
  const failures: SearchOfferCaptureFailure[] = [];

  const errorInfo = (error: unknown): { name?: string; message: string } => {
    if (error instanceof Error) {
      return { name: error.name, message: redactTextForDiagnostics(error.message) };
    }
    return { message: redactTextForDiagnostics(String(error)) };
  };

  const recordFailure = (url: string, error: unknown) => {
    const info = errorInfo(error);
    lastError = info;
    failures.push({
      at: new Date().toISOString(),
      url,
      ...info,
    });
    if (failures.length > maxDiagnosticsEntries) failures.shift();
  };

  const diagnostics = (): SearchOfferCaptureDiagnostics => ({
    startedAt,
    endedAt,
    disposed,
    finalStatus,
    timedOut,
    seenCount,
    matchedCount,
    parsedCount,
    failureCount: failures.length,
    lastSeenUrl,
    lastMatchedUrl,
    lastParsedUrl,
    lastError,
    failures: [...failures],
  });

  const reset = () => {
    endedAt = undefined;
    finalStatus = undefined;
    timedOut = false;
    offers = [];
    remoteHasMore = null;
    seenCount = 0;
    matchedCount = 0;
    parsedCount = 0;
    lastSeenUrl = undefined;
    lastMatchedUrl = undefined;
    lastParsedUrl = undefined;
    lastError = undefined;
    failures.length = 0;
  };

  const onResponse = async (resp: PWResponse) => {
    if (disposed) return;
    const url = resp.url();
    const diagnosticUrl = redactUrlForDiagnostics(url);
    seenCount++;
    lastSeenUrl = diagnosticUrl;
    try {
      const meta = readSearchMtopRequestMeta(url);
      if (meta) {
        if (meta.appId !== SEARCH_APP_ID) return;
        if (opts.requireMethod && meta.method !== opts.requireMethod) return;
        if (opts.requireSortType && meta.sortType !== opts.requireSortType) return;
        const targetPage = opts.targetPage?.();
        if (targetPage !== undefined && (meta.beginPage ?? 1) !== targetPage) return;
      } else if (
        !opts.allowUnscopedWirelessRecommend ||
        !/mtop\.relationrecommend\.wirelessrecommend\.recommend/i.test(url)
      ) {
        return;
      }
      matchedCount++;
      lastMatchedUrl = diagnosticUrl;
      const responseText = await resp.text();
      const parsed = parseOfferItemsFromMtopText(responseText);
      const observedHasMore = readRemoteHasMore(responseText);
      remoteHasMore = observedHasMore;
      if (parsed.length === 0) return;
      if (opts.keep === 'largest') {
        if (parsed.length > offers.length) offers = parsed;
      } else {
        offers = parsed;
      }
      parsedCount++;
      lastParsedUrl = diagnosticUrl;
    } catch (error) {
      recordFailure(diagnosticUrl, error);
    }
  };

  const onClose = () => {
    pageClosed = true;
    finalStatus ??= 'browser_closed';
    endedAt ??= new Date().toISOString();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    endedAt ??= new Date().toISOString();
    opts.page.off('response', onResponse);
    opts.page.off('close', onClose);
  };

  const wait = async (
    optsWait: SearchOfferCaptureWaitOptions,
  ): Promise<SearchOfferCaptureWaitResult> => {
    const result = await waitWithDeadline<SearchOfferCaptureWaitStatus>(async () => {
      if (pageClosed || optsWait.isClosed?.()) return 'browser_closed';
      if (offers.length > 0) return 'captured';
      if (await optsWait.isBlocked?.()) return 'blocked';
      if (disposed) return 'stream_closed';
      return null;
    }, {
      timeoutMs: optsWait.timeoutMs,
      intervalMs: optsWait.intervalMs ?? 300,
      onTimeout: () => (offers.length > 0 ? 'captured' : 'timeout'),
    });
    finalStatus = result;
    timedOut = result === 'timeout';
    endedAt ??= new Date().toISOString();
    return { status: result, offers, remoteHasMore, diagnostics: diagnostics() };
  };

  const waitForAction = async <TResult>(
    action: () => Promise<TResult>,
    optsWait: SearchOfferCaptureWaitOptions,
  ): Promise<SearchOfferCaptureResult<TResult>> => {
    try {
      const actionResult = await action();
      const result = await wait(optsWait);
      return {
        actionResult,
        status: result.status,
        offers: result.offers,
        remoteHasMore: result.remoteHasMore,
        diagnostics: result.diagnostics,
      };
    } finally {
      dispose();
    }
  };

  opts.page.on('response', onResponse);
  opts.page.on('close', onClose);

  return {
    reset,
    wait,
    waitForAction,
    dispose,
    diagnostics,
    offers: () => offers,
  };
}

function readRemoteHasMore(text: string): boolean | null {
  try {
    const parsed = JSON.parse(
      text.trim().replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, ''),
    ) as { data?: { data?: { OFFER?: { hasMore?: unknown } } } };
    const value = parsed.data?.data?.OFFER?.hasMore;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

export interface SearchPageCaptureV1 {
  page: SearchMtopPageV1;
  /** Sanitized but otherwise structurally exact response envelope for immutable archiving. */
  sanitizedRawPayload?: unknown;
  compiledRequest: CompiledSearchPageRequestV1;
  observedAt: string;
  sanitizedRequest: {
    appId: string;
    method: string;
    page: number;
    pageSize: number;
    sort: string;
    descendOrder: boolean;
    pageSessionHash: string;
    filterParams: Record<string, string | boolean | number>;
    requestBusinessHash: string;
  };
}

/** Captures the server-published dynamic catalog without treating it as UI authority. */
export function startSearchFilterConfigCaptureV1(input: {
  page: Page;
  timeoutMs: number;
  onRawResponse(rawResponseText: string): Promise<void>;
}) {
  const inFlight = new Set<Promise<void>>();
  const deadlineAt = Date.now() + input.timeoutMs;
  let captured = false;
  let disposed = false;
  let captureError: unknown;
  const handleResponse = async (response: PWResponse): Promise<void> => {
    if (captured || disposed || !isPotentialSearchConfigResponse(response.url())) return;
    try {
      const rawResponseText = await response.text();
      if (!containsSearchFilterConfigV1(rawResponseText)) return;
      captured = true;
      await input.onRawResponse(rawResponseText);
    } catch (error) {
      if (captured) captureError = error;
    }
  };
  const onResponse = (response: PWResponse) => {
    const task = handleResponse(response);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.page.off('response', onResponse);
  };
  const disposeAndDrain = async (): Promise<void> => {
    dispose();
    while (inFlight.size > 0) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw strictSearchDrainTimeoutError();
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(strictSearchDrainTimeoutError()),
            remainingMs,
          );
          timer.unref?.();
        }),
      ]);
    }
    if (captureError !== undefined) throw captureError;
  };
  input.page.on('response', onResponse);
  return { captured: () => captured, dispose, disposeAndDrain };
}

export function containsSearchFilterConfigV1(rawResponseText: string): boolean {
  try {
    const root = asRecord(parseMtopJsonp(rawResponseText));
    const data = asRecord(root?.['data']);
    const inner = asRecord(data?.['data']);
    return asRecord(inner?.['filterData']) !== null;
  } catch {
    return false;
  }
}

/** Strict production capture: request parity and response completeness settle atomically. */
export function startSearchPageCaptureV1(input: {
  page: Page;
  compiledRequest: CompiledSearchPageRequestV1;
  timeoutMs: number;
  onRawResponse?: (rawResponseText: string) => Promise<void>;
}) {
  let settled = false;
  let disposed = false;
  const drainDeadlineAt = Date.now() + input.timeoutMs;
  const inFlight = new Set<Promise<void>>();
  let resolveResult!: (value: SearchPageCaptureV1) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<SearchPageCaptureV1>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const handleResponse = async (response: PWResponse) => {
    if (settled || disposed) return;
    const captured = readCapturedSearchRequestBusinessV1(response.url());
    if (!captured || captured.method !== 'getOfferList') return;
    if (captured.beginPage !== String(input.compiledRequest.page)) return;
    try {
      const responseText = await response.text();
      await input.onRawResponse?.(responseText);
      assertCapturedSearchRequestParityV1({
        compiled: input.compiledRequest,
        captured,
      });
      const parsed = parseSearchMtopPageV1(responseText);
      settled = true;
      resolveResult({
        page: parsed,
        sanitizedRawPayload: sanitizeCollectorPayloadV1(
          parseMtopJsonp(responseText),
        ),
        compiledRequest: input.compiledRequest,
        observedAt: new Date().toISOString(),
        sanitizedRequest: {
          appId: captured.appId,
          method: captured.method,
          page: input.compiledRequest.page,
          pageSize: captured.pageSize,
          sort: captured.sortType,
          descendOrder: captured.descendOrder,
          pageSessionHash: input.compiledRequest.pageSessionHash,
          filterParams: captured.filterParams,
          requestBusinessHash: input.compiledRequest.requestBusinessHash,
        },
      });
    } catch (error) {
      settled = true;
      rejectResult(error);
    }
  };
  const onResponse = (response: PWResponse) => {
    const task = handleResponse(response).catch((error) => {
      if (settled) return;
      settled = true;
      rejectResult(error);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };
  input.page.on('response', onResponse);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.page.off('response', onResponse);
  };
  const disposeAndDrain = async (): Promise<void> => {
    dispose();
    while (inFlight.size > 0) {
      const remainingMs = drainDeadlineAt - Date.now();
      if (remainingMs <= 0) throw strictSearchDrainTimeoutError();
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(strictSearchDrainTimeoutError()),
            remainingMs,
          );
          timer.unref?.();
        }),
      ]);
    }
  };
  return {
    async waitForAction<T>(action: () => Promise<T>): Promise<{
      actionResult: T;
      capture: SearchPageCaptureV1;
    }> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const capturePromise = Promise.race([
          result,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new CliError(
                9,
                'SEARCH_RESPONSE_TIMEOUT',
                'Strict Search capture timed out before a correlated response arrived.',
                {
                  category: 'timeout',
                  retryable: true,
                  recoveryAction: 'retry-search-page',
                },
              )),
              input.timeoutMs,
            );
          }),
        ]);
        void capturePromise.catch(() => {});
        const actionResult = await action();
        return { actionResult, capture: await capturePromise };
      } finally {
        if (timer) clearTimeout(timer);
        await disposeAndDrain();
      }
    },
    dispose,
  };
}

function strictSearchDrainTimeoutError(): CliError {
  return new CliError(
    9,
    'COLLECTOR_CAPTURE_DRAIN_TIMEOUT',
    'Search capture cleanup exceeded its bounded response deadline.',
    {
      category: 'protocol',
      retryable: false,
      recoveryAction: 'quarantine-capture-and-inspect-archive-writer',
    },
  );
}

function isPotentialSearchConfigResponse(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && /(?:^|\.)1688\.com$/iu.test(url.hostname)
      && /(?:h5api|mtop|offer_search|selloffer|search)/iu.test(
        `${url.hostname}${url.pathname}`,
      );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
