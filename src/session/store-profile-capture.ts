import type { Page, Response as PWResponse } from 'playwright';
import { CliError } from '../io/errors.js';
import {
  ALISITE_MODULE_API,
  classifyAlisitePayloadState,
  readAlisiteModuleRequestMeta,
} from './alisite-module.js';
import { parseMtopJsonp } from './mtop.js';
import { sanitizeEvidenceRef } from './redaction.js';
import {
  startResponseCapture,
  type ResponseCaptureDiagnostics,
} from './response-capture.js';
import {
  isSafeSupplierMemberKey,
} from './qualification-capture.js';
import { STORE_PROFILE_COMPONENT_KEY } from './store-profile.js';
import { withTimeout } from './wait.js';

export interface StoreProfileCaptureOptions {
  memberId?: string;
  timeoutMs?: number;
}

export interface StoreProfileRuntimeOptions {
  runtimeReadyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface StoreProfileRuntimeRequest {
  api: string;
  v: '1.0';
  type: 'POST';
  dataType: 'json';
  data: {
    componentKey: typeof STORE_PROFILE_COMPONENT_KEY;
    params: string;
  };
}

export interface CapturedStoreProfilePayload {
  payload: unknown;
  collectedAt: string;
  sourceRef: string;
}

export interface StoreProfileCaptureResult<TResult> {
  actionResult: TResult;
  captured: CapturedStoreProfilePayload | null;
  diagnostics: ResponseCaptureDiagnostics;
}

export function buildStoreProfileRuntimeRequest(
  memberId: string,
): StoreProfileRuntimeRequest {
  if (!isSafeSupplierMemberKey(memberId)) {
    throw new TypeError(
      'Store profile requires a safe, non-empty 1688 shop member key.',
    );
  }
  return {
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    v: '1.0',
    type: 'POST',
    dataType: 'json',
    data: {
      componentKey: STORE_PROFILE_COMPONENT_KEY,
      params: JSON.stringify({
        memberId,
        appdata: { version: '2025V2' },
      }),
    },
  };
}

/** Uses only the already-loaded shop page runtime for signing and cookies. */
export async function requestStoreProfileFromPage(
  page: Page,
  memberId: string,
  options: StoreProfileRuntimeOptions = {},
): Promise<unknown> {
  const request = buildStoreProfileRuntimeRequest(memberId);
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
      'STORE_PROFILE_MTOP_RUNTIME_UNAVAILABLE',
      'The loaded 1688 shop page did not expose its MTOP runtime.',
      {
        category: 'store-profile-runtime',
        failureKind: 'runtime-unavailable',
        recoveryAction: 'rebuild-page',
        retryable: true,
        timeoutMs: runtimeReadyTimeoutMs,
      },
    );
  }

  const requestTimeout = Symbol('store-profile-runtime-timeout');
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
        return requestFn.call(win.lib?.mtop, runtimeRequest);
      }, request),
      {
        timeoutMs: requestTimeoutMs,
        fallback: requestTimeout,
      },
    );
    if (outcome === requestTimeout) {
      throw new Error('Store profile runtime request timed out.');
    }
    return outcome;
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === 'STORE_PROFILE_REQUEST_REJECTED'
    ) {
      throw error;
    }
    throw new CliError(
      9,
      'STORE_PROFILE_REQUEST_REJECTED',
      'The 1688 page MTOP runtime rejected the store profile request.',
      {
        category: 'store-profile-runtime',
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

export async function captureStoreProfileForAction<TResult>(
  page: Page,
  options: StoreProfileCaptureOptions,
  action: () => Promise<TResult>,
): Promise<StoreProfileCaptureResult<TResult>> {
  const capture = startResponseCapture<CapturedStoreProfilePayload>({
    page,
    timeoutMs: options.timeoutMs ?? 15_000,
    matcher: (response) => {
      const meta = readAlisiteModuleRequestMeta(
        response.url(),
        responsePostData(response),
      );
      return !!(
        meta &&
        meta.componentKey?.toLowerCase() ===
          STORE_PROFILE_COMPONENT_KEY.toLowerCase() &&
        (options.memberId === undefined || meta.memberId === options.memberId)
      );
    },
    parse: async (response) => ({
      payload: parseMtopJsonp(await response.text()),
      collectedAt: new Date().toISOString(),
      sourceRef: sanitizeEvidenceRef(response.url()),
    }),
  });
  const result = await capture.waitForAction(action);
  return {
    actionResult: result.actionResult,
    captured: result.response,
    diagnostics: result.diagnostics,
  };
}

export function assertStoreProfilePayloadState(
  payload: unknown,
  diagnostics?: ResponseCaptureDiagnostics,
): void {
  const status = classifyAlisitePayloadState(payload);
  if (status === 'not_logged_in') {
    throw new CliError(
      3,
      'NOT_LOGGED_IN',
      'Session expired. Run `1688 login`.',
      {
        category: 'authentication',
        failureKind: 'not-logged-in',
        recoveryAction: 'login',
        retryable: true,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      },
    );
  }
  if (status === 'risk_control') {
    throw new CliError(
      4,
      'RISK_CONTROL',
      '1688 risk control appeared. Retry with `--headed` and complete verification.',
      {
        category: 'risk-control',
        failureKind: 'risk-control',
        recoveryAction: 'verify-headed',
        retryable: true,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      },
    );
  }
  if (status === 'rate_limited') {
    throw new CliError(
      9,
      'RATE_LIMITED',
      '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
      {
        category: 'rate_limited',
        failureKind: 'rate_limited',
        recoveryAction: 'backoff',
        retryable: true,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      },
    );
  }
}

export const STORE_PROFILE_RUNTIME_SOURCE_REF =
  `mtop:${ALISITE_MODULE_API}:${STORE_PROFILE_COMPONENT_KEY}`;

function responsePostData(response: PWResponse): string | null {
  try {
    return response.request().postData();
  } catch {
    return null;
  }
}
