import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { CliError, type CliErrorDetails } from '../io/errors.js';
import {
  detectPageState,
  recoverHintForPageState,
  type PageState,
} from './page-state.js';
import { runsDir } from './paths.js';
import {
  redactDiagnosticMetadata,
  redactTextForDiagnostics,
  redactUrlForDiagnostics,
} from './redaction.js';

export interface RunMeta {
  requestId?: string;
  cmd: string;
  args: unknown;
}

export interface FailureTraceSnapshot {
  console: Array<Record<string, unknown>>;
  pageErrors: Array<Record<string, unknown>>;
  network: {
    recent: Array<Record<string, unknown>>;
    failed: Array<Record<string, unknown>>;
    httpErrors: Array<Record<string, unknown>>;
  };
}

export interface FailureArtifactOptions {
  pageState?: PageState | null;
  recovery?: Record<string, unknown>;
  trace?: FailureTraceSnapshot;
}

interface ErrorShape {
  code?: string;
  message: string;
  stack?: string;
  details?: CliErrorDetails;
}

function errorShape(e: unknown): ErrorShape {
  if (e instanceof CliError) {
    return { code: e.code, message: e.message, stack: e.stack, details: e.details };
  }
  if (e instanceof Error) {
    return { message: e.message, stack: e.stack };
  }
  return { message: String(e) };
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'command';
}

function pickPage(ctx: BrowserContext): Page | null {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return pages.at(-1) ?? null;
}

function requestId(meta: RunMeta): string {
  return (
    meta.requestId ??
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName(meta.cmd)}`
  );
}

function categoryForPageState(kind: string): string | undefined {
  switch (kind) {
    case 'not_logged_in':
      return 'auth';
    case 'risk_challenge':
      return 'risk';
    case 'rate_limited':
      return 'rate_limit';
    case 'unknown':
      return 'unknown_page_state';
    default:
      return undefined;
  }
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' ? v : undefined;
}

function boolField(
  obj: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const v = obj?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function traceSummary(trace: FailureTraceSnapshot | undefined): Record<string, number> | undefined {
  if (!trace) return undefined;
  return {
    console: trace.console.length,
    pageErrors: trace.pageErrors.length,
    recentRequests: trace.network.recent.length,
    failedRequests: trace.network.failed.length,
    httpErrors: trace.network.httpErrors.length,
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(
    file,
    JSON.stringify(redactDiagnosticMetadata(value), null, 2),
  );
}

function errorText(shape: ErrorShape): string {
  const lines = [];
  if (shape.code) lines.push(`code: ${shape.code}`);
  lines.push(`message: ${redactTextForDiagnostics(shape.message)}`);
  if (shape.stack) lines.push(`stack:\n${redactTextForDiagnostics(shape.stack)}`);
  return lines.join('\n\n');
}

export async function captureFailureArtifact(
  ctx: BrowserContext,
  meta: RunMeta,
  error: unknown,
  options: FailureArtifactOptions = {},
): Promise<CliErrorDetails> {
  const id = requestId(meta);
  const dir = path.join(runsDir(), id);
  await fs.mkdir(dir, { recursive: true });

  const page = pickPage(ctx);
  const pageState =
    options.pageState !== undefined
      ? options.pageState
      : page
        ? await detectPageState(page).catch(() => null)
        : null;
  const recovery = options.recovery;
  const details: CliErrorDetails = {
    artifactDir: dir,
  };

  if (pageState) {
    details.currentUrl = redactUrlForDiagnostics(pageState.url);
    details.pageState = pageState.kind;
    details.category = categoryForPageState(pageState.kind);
    details.recoverHint = recoverHintForPageState(pageState.kind);
    details.retryable =
      pageState.kind === 'rate_limited' || pageState.kind === 'unknown';
    await writeJson(path.join(dir, 'page-state.json'), pageState).catch(() => {});
  }

  if (recovery) {
    const failureKind = stringField(recovery, 'failureKind');
    const action = stringField(recovery, 'action');
    const retryable = boolField(recovery, 'retryable');
    if (failureKind) details.failureKind = failureKind;
    if (action) details.recoveryAction = action;
    if (retryable !== undefined) details.retryable = retryable;
    await writeJson(path.join(dir, 'recovery.json'), recovery).catch(() => {});
  }

  if (options.trace) {
    if (options.trace.console.length > 0 || options.trace.pageErrors.length > 0) {
      await writeJson(path.join(dir, 'console.json'), {
        console: options.trace.console,
        pageErrors: options.trace.pageErrors,
      }).catch(() => {});
    }
    if (
      options.trace.network.recent.length > 0 ||
      options.trace.network.failed.length > 0 ||
      options.trace.network.httpErrors.length > 0
    ) {
      await writeJson(path.join(dir, 'network.json'), options.trace.network).catch(
        () => {},
      );
    }
  }

  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true })
      .catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) await fs.writeFile(path.join(dir, 'page.html'), html);
  }

  const shaped = errorShape(error);
  const responseCapture = shaped.details?.responseCapture;
  if (responseCapture) {
    await writeJson(path.join(dir, 'response-capture.json'), responseCapture).catch(
      () => {},
    );
  }
  await fs.writeFile(path.join(dir, 'error.txt'), errorText(shaped)).catch(() => {});
  await writeJson(path.join(dir, 'meta.json'), {
    requestId: id,
    at: new Date().toISOString(),
    command: meta.cmd,
    args: meta.args,
    error: shaped,
    pageState,
    recovery,
    traceSummary: traceSummary(options.trace),
  });

  return details;
}

export async function enrichErrorWithArtifact(
  ctx: BrowserContext,
  meta: RunMeta,
  error: unknown,
): Promise<Error> {
  if (error instanceof CliError && error.details.artifactDir) {
    return error;
  }
  const details = await captureFailureArtifact(ctx, meta, error).catch(
    () => ({}),
  );
  if (error instanceof CliError) {
    return error.withDetails(details);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(1, 'INTERNAL', message, details);
}
