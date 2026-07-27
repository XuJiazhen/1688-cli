import type { Page, Response as PWResponse } from 'playwright';
import { CliError } from '../io/errors.js';
import { parseMtopJsonp } from './mtop.js';
import {
  readAlisiteModuleRequestMeta,
} from './alisite-module.js';
import {
  mapSupplierQualificationPayload,
  SUPPLIER_QUALIFICATION_COMPONENT_KEY,
  type SupplierQualification,
} from './supplier-qualification.js';
import {
  startResponseCapture,
  type ResponseCaptureDiagnostics,
} from './response-capture.js';
import { withTimeout } from './wait.js';

export interface SupplierQualificationCaptureOptions {
  memberId?: string;
  timeoutMs?: number;
}

export interface SupplierQualificationRuntimeOptions {
  runtimeReadyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface SupplierQualificationCaptureResult<TResult> {
  actionResult: TResult;
  qualification: SupplierQualification | null;
  diagnostics: ResponseCaptureDiagnostics;
}

export interface SupplierQualificationRuntimeRequest {
  api: string;
  v: '1.0';
  type: 'POST';
  dataType: 'json';
  data: {
    componentKey: typeof SUPPLIER_QUALIFICATION_COMPONENT_KEY;
    params: string;
  };
}

export const SUPPLIER_MEMBER_KEY_MAX_LENGTH = 128;
const SUPPLIER_MEMBER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isSafeSupplierMemberKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SUPPLIER_MEMBER_KEY_MAX_LENGTH &&
    SUPPLIER_MEMBER_KEY_RE.test(value)
  );
}

export function buildSupplierQualificationRuntimeRequest(
  memberId: string,
): SupplierQualificationRuntimeRequest {
  if (!isSafeSupplierMemberKey(memberId)) {
    throw new TypeError(
      'Supplier qualification requires a safe, non-empty 1688 shop member key.',
    );
  }
  return {
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    v: '1.0',
    type: 'POST',
    dataType: 'json',
    data: {
      componentKey: SUPPLIER_QUALIFICATION_COMPONENT_KEY,
      params: JSON.stringify({ memberId }),
    },
  };
}

/** Uses the already-loaded page MTOP runtime so it owns signing and cookies. */
export async function requestSupplierQualificationFromPage(
  page: Page,
  memberId: string,
  options: SupplierQualificationRuntimeOptions = {},
): Promise<void> {
  const request = buildSupplierQualificationRuntimeRequest(memberId);
  const runtimeReadyTimeoutMs = options.runtimeReadyTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  try {
    await page.waitForFunction(
      () => {
        const win = window as unknown as {
          lib?: { mtop?: { request?: unknown } };
        };
        return typeof win.lib?.mtop?.request === 'function';
      },
      undefined,
      { timeout: runtimeReadyTimeoutMs },
    );
  } catch {
    throw new CliError(
      9,
      'QUALIFICATION_MTOP_RUNTIME_UNAVAILABLE',
      'The loaded 1688 shop page did not expose its MTOP runtime.',
      {
        category: 'qualification-runtime',
        failureKind: 'runtime-unavailable',
        recoveryAction: 'rebuild-page',
        retryable: true,
        timeoutMs: runtimeReadyTimeoutMs,
      },
    );
  }

  const requestTimeout = Symbol('qualification-runtime-timeout');
  try {
    const outcome = await withTimeout(
      page.evaluate(async (runtimeRequest) => {
        const win = window as unknown as {
          lib?: {
            mtop?: {
              request?: (input: typeof runtimeRequest) => Promise<unknown>;
            };
          };
        };
        const requestFn = win.lib?.mtop?.request;
        if (typeof requestFn !== 'function') {
          throw new Error('1688 page MTOP runtime is unavailable.');
        }
        await requestFn.call(win.lib?.mtop, runtimeRequest);
      }, request),
      {
        timeoutMs: requestTimeoutMs,
        fallback: requestTimeout,
      },
    );
    if (outcome === requestTimeout) {
      throw new Error('Qualification runtime request timed out.');
    }
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === 'QUALIFICATION_REQUEST_REJECTED'
    ) {
      throw error;
    }
    throw new CliError(
      9,
      'QUALIFICATION_REQUEST_REJECTED',
      'The 1688 page MTOP runtime rejected the qualification request.',
      {
        category: 'qualification-runtime',
        failureKind: 'request-rejected',
        recoveryAction: 'retry-later',
        retryable: true,
        timeoutMs: requestTimeoutMs,
        cause:
          error instanceof Error
            ? error.name
            : 'UnknownRuntimeRequestFailure',
      },
    );
  }
}

export async function captureSupplierQualificationForAction<TResult>(
  page: Page,
  options: SupplierQualificationCaptureOptions,
  action: () => Promise<TResult>,
): Promise<SupplierQualificationCaptureResult<TResult>> {
  const capture = startResponseCapture<SupplierQualification>({
    page,
    timeoutMs: options.timeoutMs ?? 15_000,
    matcher: (response) => {
      const meta = readAlisiteModuleRequestMeta(
        response.url(),
        responsePostData(response),
      );
      return !!(
        meta &&
        meta.componentKey === SUPPLIER_QUALIFICATION_COMPONENT_KEY &&
        (options.memberId === undefined || meta.memberId === options.memberId)
      );
    },
    parse: async (response) =>
      mapSupplierQualificationPayload(
        parseMtopJsonp(await response.text()),
        new Date().toISOString(),
      ),
  });
  const result = await capture.waitForAction(action);
  return {
    actionResult: result.actionResult,
    qualification: result.response,
    diagnostics: result.diagnostics,
  };
}

export function requireSupplierQualificationResponse(
  result: SupplierQualificationCaptureResult<unknown>,
): SupplierQualification {
  if (result.qualification) return result.qualification;
  throw new CliError(
    9,
    'QUALIFICATION_RESPONSE_TIMEOUT',
    'The qualification request did not produce a correlated response.',
    {
      category: 'timeout',
      failureKind: 'response-timeout',
      recoveryAction: 'retry-later',
      retryable: true,
      responseCapture: result.diagnostics,
    },
  );
}

function responsePostData(response: PWResponse): string | null {
  try {
    return response.request().postData();
  } catch {
    return null;
  }
}
