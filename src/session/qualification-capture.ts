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
import {
  createSourceMediaReferenceV2,
  type SourceMediaReferenceV2,
} from './offer-media.js';
import { createHash } from 'node:crypto';
import { sanitizeCollectorPayloadV1 } from './collector-raw-archive.js';

export interface SupplierQualificationCaptureOptions {
  memberId?: string;
  timeoutMs?: number;
  onRawResponse?: (rawResponseText: string) => Promise<void>;
}

export interface SupplierQualificationRuntimeOptions {
  runtimeReadyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface SupplierQualificationCaptureResult<TResult> {
  actionResult: TResult;
  qualification: SupplierQualification | null;
  sanitizedRawPayload?: unknown;
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

export function buildSupplierQualificationPageUrl(memberId: string): string {
  if (!isSafeSupplierMemberKey(memberId)) {
    throw new TypeError('Supplier qualification page requires a safe memberId.');
  }
  const url = new URL('https://wp.m.1688.com/page/businessinfor.html');
  url.searchParams.set('memberId', memberId);
  return url.toString();
}

export function assertSupplierQualificationScope(
  requestMemberId: string,
  qualification: SupplierQualification,
): SupplierQualification {
  if (!isSafeSupplierMemberKey(requestMemberId)) {
    throw new CliError(2, 'QUALIFICATION_REQUEST_SCOPE_INVALID', 'Qualification request memberId is invalid.', {
      category: 'contract',
      retryable: false,
      recoveryAction: 'repair-store-identity',
    });
  }
  if (qualification.memberId !== requestMemberId) {
    throw new CliError(9, 'QUALIFICATION_RESPONSE_SCOPE_MISMATCH', 'Qualification response belongs to another member scope.', {
      category: 'protocol',
      retryable: false,
      recoveryAction: 'inspect-qualification-correlation',
    });
  }
  return qualification;
}

export interface QualificationMediaManifestV1 {
  memberId: string;
  sourceQualificationGeneration: string;
  role: 'qualification';
  sourceCoverage: 'complete' | 'authoritative-empty' | 'failed';
  items: SourceMediaReferenceV2[];
  itemSetHash: string;
  reasonCode: string | null;
}

export function buildQualificationMediaManifestV1(input: {
  memberId: string;
  sourceQualificationGeneration: string;
  sourceObservationId: string;
  sourcePayloadContentSha256: string;
  qualification: SupplierQualification | null;
  responseObserved: boolean;
  responseSucceeded: boolean;
  correlationMatched: boolean;
}): QualificationMediaManifestV1 {
  if (!isSafeSupplierMemberKey(input.memberId)) throw new TypeError('Qualification media memberId is invalid.');
  const completeSource = input.responseObserved &&
    input.responseSucceeded &&
    input.correlationMatched &&
    input.qualification !== null &&
    input.qualification.certificateListAvailability !== 'failed';
  const rawImages = [
    ...(input.qualification?.certificates ?? []).flatMap((certificate, index) =>
      certificate.imageUrl
        ? [{
            url: certificate.imageUrl,
            sourceField: `data.certList[${index}].imageUrl`,
          }]
        : []
    ),
    ...(input.qualification?.certificationImages ?? []).map((image, index) => ({
      url: image.url,
      sourceField: `data.propaganda.companyImg[${index}].url`,
    })),
  ];
  const items: SourceMediaReferenceV2[] = [];
  let invalidUrls = 0;
  rawImages.forEach((image, sourceOrdinal) => {
    const created = createSourceMediaReferenceV2({
      role: 'qualification',
      owner: { ownerKind: 'store-qualification', memberId: input.memberId },
      order: sourceOrdinal,
      sourceOrdinal,
      originalUrl: image.url,
      sourceField: image.sourceField,
      sourceObservationId: input.sourceObservationId,
      sourcePayloadContentSha256: input.sourcePayloadContentSha256,
    });
    if (created.reference) items.push(created.reference);
    else invalidUrls++;
  });
  const sourceCoverage: QualificationMediaManifestV1['sourceCoverage'] =
    !completeSource || invalidUrls > 0
      ? 'failed'
      : items.length === 0
        ? 'authoritative-empty'
        : 'complete';
  return Object.freeze({
    memberId: input.memberId,
    sourceQualificationGeneration: input.sourceQualificationGeneration,
    role: 'qualification',
    sourceCoverage,
    items: Object.freeze(items) as SourceMediaReferenceV2[],
    itemSetHash: qualificationMediaHash(items),
    reasonCode:
      sourceCoverage === 'failed'
        ? !input.responseObserved
          ? 'QUALIFICATION_RESPONSE_NOT_OBSERVED'
          : !input.responseSucceeded
            ? 'QUALIFICATION_RESPONSE_NOT_SUCCESS'
            : !input.correlationMatched
              ? 'QUALIFICATION_RESPONSE_SCOPE_MISMATCH'
              : invalidUrls > 0
                ? 'QUALIFICATION_MEDIA_URL_INVALID'
                : 'QUALIFICATION_PARSE_FAILED'
        : sourceCoverage === 'authoritative-empty'
          ? 'QUALIFICATION_MEDIA_SOURCE_EMPTY'
          : null,
  });
}

export function assertQualificationMediaManifestV1(
  manifest: QualificationMediaManifestV1,
): void {
  const coverageMatchesItems = manifest.sourceCoverage === 'complete'
    ? manifest.items.length > 0 && manifest.reasonCode === null
    : manifest.sourceCoverage === 'authoritative-empty'
      ? manifest.items.length === 0 && manifest.reasonCode === 'QUALIFICATION_MEDIA_SOURCE_EMPTY'
      : manifest.reasonCode !== null;
  if (
    !isSafeSupplierMemberKey(manifest.memberId) ||
    !manifest.sourceQualificationGeneration.trim() ||
    manifest.role !== 'qualification' ||
    manifest.itemSetHash !== qualificationMediaHash(manifest.items) ||
    !coverageMatchesItems ||
    manifest.items.some(
      (item) =>
        item.role !== 'qualification' ||
        item.ownerKind !== 'store-qualification' ||
        item.memberId !== manifest.memberId,
    )
  ) {
    throw new TypeError('Qualification media manifest is incomplete, corrupted, or belongs to another scope.');
  }
}

function qualificationMediaHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
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
  let riskControlDetected = false;
  const capture = startResponseCapture<{
    qualification: SupplierQualification;
    sanitizedRawPayload: unknown;
  }>({
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
    parse: async (response) => {
      const rawResponseText = await response.text();
      const rawPayload = parseMtopJsonp(rawResponseText);
      riskControlDetected ||= qualificationResponseSignalsRiskControl(rawPayload);
      await options.onRawResponse?.(rawResponseText);
      return {
        qualification: mapSupplierQualificationPayload(
          rawPayload,
          new Date().toISOString(),
        ),
        sanitizedRawPayload: sanitizeCollectorPayloadV1(rawPayload),
      };
    },
  });
  let result;
  try {
    result = await capture.waitForAction(action);
  } catch (error) {
    if (riskControlDetected) throw qualificationRiskControlError();
    throw error;
  }
  if (riskControlDetected) throw qualificationRiskControlError();
  return {
    actionResult: result.actionResult,
    qualification: result.response?.qualification ?? null,
    ...(result.response === null
      ? {}
      : { sanitizedRawPayload: result.response.sanitizedRawPayload }),
    diagnostics: result.diagnostics,
  };
}

function qualificationResponseSignalsRiskControl(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const ret = Array.isArray(record.ret)
    ? record.ret.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (ret.some((entry) => /^(?:FAIL_SYS_USER_VALIDATE|RISK_CONTROL)(?:::|$)/iu.test(entry))) {
    return true;
  }
  const data = record.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const challengeUrl = (data as Record<string, unknown>).url;
  return typeof challengeUrl === 'string'
    && /(?:punish|x5secdata|captcha|nocaptcha)/iu.test(challengeUrl);
}

function qualificationRiskControlError(): CliError {
  return new CliError(
    4,
    'RISK_CONTROL',
    'The qualification response requires a headed risk challenge.',
    {
      category: 'risk_challenge',
      retryable: false,
      actionRequired: 'risk-control',
      recoveryAction: 'pause_for_manual_challenge',
    },
  );
}

export function requireSupplierQualificationResponse(
  result: SupplierQualificationCaptureResult<unknown>,
  requestMemberId?: string,
): SupplierQualification {
  if (result.qualification) {
    return requestMemberId === undefined
      ? result.qualification
      : assertSupplierQualificationScope(requestMemberId, result.qualification);
  }
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
