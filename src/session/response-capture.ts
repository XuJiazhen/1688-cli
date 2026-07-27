import type { Page, Response as PWResponse } from 'playwright';
import {
  redactTextForDiagnostics,
  redactUrlForDiagnostics,
} from './redaction.js';

export type ResponseMatcher = RegExp | ((response: PWResponse) => boolean);
export type ResponseParser<T> = (
  response: PWResponse,
) => Promise<T | null | undefined | false>;

export interface ResponseCaptureFailure {
  at: string;
  phase: 'match' | 'parse';
  url: string;
  name?: string;
  message: string;
}

export interface ResponseCaptureEmptyResult {
  at: string;
  url: string;
}

export interface ResponseCaptureDiagnostics {
  timeoutMs: number;
  startedAt: string;
  endedAt?: string;
  disposed: boolean;
  settled: boolean;
  timedOut: boolean;
  seenCount: number;
  matchedCount: number;
  parsedCount: number;
  emptyResultCount: number;
  failureCount: number;
  lastSeenUrl?: string;
  lastMatchedUrl?: string;
  lastParsedUrl?: string;
  failures: ResponseCaptureFailure[];
  emptyResults: ResponseCaptureEmptyResult[];
}

export interface StartResponseCaptureOptions<T> {
  page: Page;
  timeoutMs: number;
  matcher: ResponseMatcher;
  parse: ResponseParser<T>;
  maxDiagnosticsEntries?: number;
}

export interface ResponseCaptureActionResult<T, TResult> {
  actionResult: TResult;
  response: T | null;
  diagnostics: ResponseCaptureDiagnostics;
}

export interface ResponseCapture<T> {
  wait(): Promise<T | null>;
  waitForAction<TResult>(
    action: () => Promise<TResult>,
  ): Promise<ResponseCaptureActionResult<T, TResult>>;
  dispose(): void;
  diagnostics(): ResponseCaptureDiagnostics;
}

export function startResponseCapture<T>(
  opts: StartResponseCaptureOptions<T>,
): ResponseCapture<T> {
  const maxDiagnosticsEntries = opts.maxDiagnosticsEntries ?? 5;
  const startedAt = new Date().toISOString();
  let endedAt: string | undefined;
  let disposed = false;
  let settled = false;
  let timedOut = false;
  let seenCount = 0;
  let matchedCount = 0;
  let parsedCount = 0;
  let emptyResultCount = 0;
  let lastSeenUrl: string | undefined;
  let lastMatchedUrl: string | undefined;
  let lastParsedUrl: string | undefined;
  const failures: ResponseCaptureFailure[] = [];
  const emptyResults: ResponseCaptureEmptyResult[] = [];
  let waitPromise: Promise<T | null> | null = null;
  let resolveCaptured!: (value: T) => void;
  const captured = new Promise<T>((resolve) => {
    resolveCaptured = resolve;
  });
  let resolveDisposed!: () => void;
  const disposedSignal = new Promise<null>((resolve) => {
    resolveDisposed = () => resolve(null);
  });

  const remember = <TEntry>(entries: TEntry[], entry: TEntry) => {
    entries.push(entry);
    if (entries.length > maxDiagnosticsEntries) entries.shift();
  };

  const errorInfo = (error: unknown): { name?: string; message: string } => {
    if (error instanceof Error) {
      return { name: error.name, message: redactTextForDiagnostics(error.message) };
    }
    return { message: redactTextForDiagnostics(String(error)) };
  };

  const recordFailure = (
    phase: ResponseCaptureFailure['phase'],
    url: string,
    error: unknown,
  ) => {
    const info = errorInfo(error);
    remember(failures, {
      at: new Date().toISOString(),
      phase,
      url,
      ...info,
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    endedAt ??= new Date().toISOString();
    opts.page.off('response', onResponse);
    resolveDisposed();
  };

  const matches = (response: PWResponse): boolean => {
    if (opts.matcher instanceof RegExp) return opts.matcher.test(response.url());
    return opts.matcher(response);
  };

  const onResponse = async (response: PWResponse) => {
    if (disposed || settled) return;
    const url = response.url();
    const diagnosticUrl = redactUrlForDiagnostics(url);
    seenCount++;
    lastSeenUrl = diagnosticUrl;
    let matched = false;
    try {
      matched = matches(response);
    } catch (e) {
      recordFailure('match', diagnosticUrl, e);
      return;
    }
    if (!matched) return;
    matchedCount++;
    lastMatchedUrl = diagnosticUrl;
    try {
      const value = await opts.parse(response);
      if (settled || disposed) return;
      if (!value) {
        emptyResultCount++;
        remember(emptyResults, {
          at: new Date().toISOString(),
          url: diagnosticUrl,
        });
        return;
      }
      parsedCount++;
      lastParsedUrl = diagnosticUrl;
      settled = true;
      endedAt = new Date().toISOString();
      resolveCaptured(value);
    } catch (e) {
      if (settled || disposed) return;
      recordFailure('parse', diagnosticUrl, e);
    }
  };

  const diagnostics = (): ResponseCaptureDiagnostics => ({
    timeoutMs: opts.timeoutMs,
    startedAt,
    endedAt,
    disposed,
    settled,
    timedOut,
    seenCount,
    matchedCount,
    parsedCount,
    emptyResultCount,
    failureCount: failures.length,
    lastSeenUrl,
    lastMatchedUrl,
    lastParsedUrl,
    failures: [...failures],
    emptyResults: [...emptyResults],
  });

  opts.page.on('response', onResponse);

  return {
    wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      waitPromise ??= Promise.race([
        captured,
        disposedSignal,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), opts.timeoutMs);
        }),
      ])
        .then((value) => {
          if (value === null && !settled && !disposed) {
            timedOut = true;
            endedAt = new Date().toISOString();
          }
          return value;
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
          dispose();
        });
      return waitPromise;
    },
    async waitForAction<TResult>(action: () => Promise<TResult>) {
      const responsePromise = this.wait();
      try {
        const actionResult = await action();
        const response = await responsePromise;
        return {
          actionResult,
          response,
          diagnostics: diagnostics(),
        };
      } finally {
        dispose();
      }
    },
    dispose,
    diagnostics,
  };
}
