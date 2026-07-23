import type { Page, Response as PWResponse } from 'playwright';
import { parseMtopJsonp } from './mtop.js';
import {
  redactTextForDiagnostics,
  redactUrlForDiagnostics,
} from './redaction.js';
import { waitWithDeadline } from './wait.js';

export const ALISITE_MODULE_API =
  'mtop.alibaba.alisite.cbu.server.moduleasyncservice';
export const STORE_CATALOG_COMPONENT_KEY = 'Wp_pc_common_offerlist';
export const STORE_CATEGORIES_COMPONENT_KEY = 'wp_pc_common_topnav';

export interface AlisiteModuleRequestMeta {
  api: string;
  componentKey?: string;
  memberId?: string;
  pageNum?: number;
  count?: number;
  catId?: string;
  keywords?: string;
  sortType?: string;
}

export interface AlisiteModuleRequestScope {
  memberId?: string | null;
  pageNum?: number | null;
  count?: number | null;
  catId?: string | null;
  keywords?: string | null;
  sortType?: string | null;
}

export interface AlisiteModuleCaptureTarget {
  id: string;
  componentKey: string;
  request?: AlisiteModuleRequestScope;
  required?: boolean;
}

export interface StartAlisiteModuleCaptureOptions {
  page: Page;
  targets: AlisiteModuleCaptureTarget[];
  maxDiagnosticsEntries?: number;
}

export type AlisiteModuleCaptureWaitStatus =
  | 'captured'
  | 'timeout'
  | 'aborted'
  | 'risk_control'
  | 'not_logged_in'
  | 'browser_closed'
  | 'stream_closed';

export interface AlisiteModuleCaptureWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  isBlocked?: () => boolean | Promise<boolean>;
  isNotLoggedIn?: () => boolean | Promise<boolean>;
  isClosed?: () => boolean;
}

export interface AlisiteModuleCaptureFailure {
  at: string;
  url: string;
  targetIds: string[];
  name?: string;
  message: string;
}

export interface AlisiteModuleCaptureDiagnostics {
  startedAt: string;
  endedAt?: string;
  disposed: boolean;
  finalStatus?: AlisiteModuleCaptureWaitStatus;
  timedOut: boolean;
  seenCount: number;
  matchedCount: number;
  parsedCount: number;
  failureCount: number;
  lastSeenUrl?: string;
  lastMatchedUrl?: string;
  lastParsedUrl?: string;
  failures: AlisiteModuleCaptureFailure[];
}

export interface CapturedAlisiteModule {
  targetId: string;
  request: AlisiteModuleRequestMeta;
  parsed: StoreCatalogParseResult;
  sourceRef: string;
  collectedAt: string;
}

export interface AlisiteModuleCaptureWaitResult {
  status: AlisiteModuleCaptureWaitStatus;
  captures: CapturedAlisiteModule[];
  diagnostics: AlisiteModuleCaptureDiagnostics;
}

export interface AlisiteModuleCaptureActionResult<TResult>
  extends AlisiteModuleCaptureWaitResult {
  actionResult: TResult;
}

export interface StoreCatalogRequestMeta {
  memberId?: string | null;
  pageNum?: number | null;
  pageSize?: number | null;
  categoryId?: string | null;
  keyword?: string | null;
  sortType?: string | null;
}

export interface StoreCatalogWarning {
  code: string;
  fieldPath: string;
  message: string;
}

export interface StoreCatalogCategory {
  id: string;
  name: string | null;
  fullName: string | null;
  count: number | null;
  children: StoreCatalogCategory[];
}

export type RawCatalogScalar = string | number;

export interface StoreCatalogOffer {
  offerId: string;
  memberId: string | null;
  title: string | null;
  url: string;
  imageUrl: string | null;
  categoryId: string | null;
  price: string | null;
  quantityBegin: string | null;
  unit: string | null;
  pagePosition: number;
  absolutePosition: number | null;
  sales: {
    vagueSaleQuantity: RawCatalogScalar | null;
    thirtySaleQuantity: RawCatalogScalar | null;
    bookedCount: RawCatalogScalar | null;
    ninetySaleQuantity: RawCatalogScalar | null;
    saleQuantity: RawCatalogScalar | null;
    modelBookedCount: RawCatalogScalar | null;
    modelAgentBookedCount: RawCatalogScalar | null;
    modelQuantitySumMonth: RawCatalogScalar | null;
    modelSaleQuantity: RawCatalogScalar | null;
  };
}

export interface ParsedUserDefined {
  raw: unknown;
  value: boolean | null;
  state: 'parsed' | 'empty' | 'invalid' | 'missing';
}

export interface StoreCatalogParseResult {
  kind: 'offer-list' | 'categories';
  offerCount: number | null;
  totalPages: number | null;
  offers: StoreCatalogOffer[];
  categories: StoreCatalogCategory[];
  userDefined: ParsedUserDefined;
  page: StoreCatalogRequestMeta;
  warnings: StoreCatalogWarning[];
}

export class AlisiteSchemaError extends Error {
  readonly code = 'ALISITE_SCHEMA_UNRECOGNIZED';

  constructor(message: string) {
    super(message);
    this.name = 'AlisiteSchemaError';
  }
}

/**
 * Reads only the stable routing and scope fields from an Alisite MTOP URL.
 * The returned value deliberately excludes signatures, tokens, and raw data.
 */
export function readAlisiteModuleRequestMeta(
  rawUrl: string,
  postData?: string | null,
): AlisiteModuleRequestMeta | null {
  try {
    const url = new URL(rawUrl);
    const pathApi = url.pathname.match(/\/h5\/([^/]+)\//i)?.[1];
    const api = decodeURIComponent(pathApi ?? url.searchParams.get('api') ?? '');
    if (api.toLowerCase() !== ALISITE_MODULE_API.toLowerCase()) return null;

    const outer = jsonRecord(
      url.searchParams.get('data') ?? readPostDataField(postData, 'data'),
    );
    if (!outer) return null;
    const params = jsonRecord(outer.params) ?? recordOrNull(outer.params) ?? {};
    const appdata = jsonRecord(params.appdata) ?? recordOrNull(params.appdata) ?? {};
    const scope = { ...params, ...appdata };
    const componentKey = stringOrUndefined(
      outer.componentKey ?? params.componentKey,
    );
    const memberId = stringOrUndefined(params.memberId);
    const pageNum = positiveIntegerOrUndefined(scope.pageNum);
    const count = positiveIntegerOrUndefined(scope.count);
    const catId = stringOrUndefined(scope.catId);
    const keywords = stringOrUndefined(scope.keywords);
    const sortType = stringOrUndefined(scope.sortType);

    return {
      api: ALISITE_MODULE_API,
      ...(componentKey !== undefined ? { componentKey } : {}),
      ...(memberId !== undefined ? { memberId } : {}),
      ...(pageNum !== undefined ? { pageNum } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(catId !== undefined ? { catId } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(sortType !== undefined ? { sortType } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Correlates Alisite responses to explicit collection targets. It observes the
 * browser's own signed requests and never constructs or replays MTOP requests.
 */
export function startAlisiteModuleCapture(
  opts: StartAlisiteModuleCaptureOptions,
) {
  if (opts.targets.length === 0) {
    throw new TypeError('Alisite module capture requires at least one target');
  }
  const targetIds = new Set<string>();
  for (const target of opts.targets) {
    if (!target.id || targetIds.has(target.id)) {
      throw new TypeError('Alisite module capture target ids must be unique');
    }
    targetIds.add(target.id);
  }

  const maxDiagnosticsEntries = opts.maxDiagnosticsEntries ?? 5;
  const startedAt = new Date().toISOString();
  let endedAt: string | undefined;
  let disposed = false;
  let pageClosed = false;
  let finalStatus: AlisiteModuleCaptureWaitStatus | undefined;
  let timedOut = false;
  let seenCount = 0;
  let matchedCount = 0;
  let parsedCount = 0;
  let failureCount = 0;
  let lastSeenUrl: string | undefined;
  let lastMatchedUrl: string | undefined;
  let lastParsedUrl: string | undefined;
  const captures: CapturedAlisiteModule[] = [];
  const failures: AlisiteModuleCaptureFailure[] = [];

  const diagnostics = (): AlisiteModuleCaptureDiagnostics => ({
    startedAt,
    endedAt,
    disposed,
    finalStatus,
    timedOut,
    seenCount,
    matchedCount,
    parsedCount,
    failureCount,
    lastSeenUrl,
    lastMatchedUrl,
    lastParsedUrl,
    failures: [...failures],
  });

  const targetSatisfied = (target: AlisiteModuleCaptureTarget): boolean =>
    captures.some((captured) => captured.targetId === target.id);

  const allRequiredTargetsSatisfied = (): boolean =>
    opts.targets
      .filter((target) => target.required !== false)
      .every(targetSatisfied);

  const recordFailure = (
    url: string,
    targets: AlisiteModuleCaptureTarget[],
    error: unknown,
  ) => {
    failureCount++;
    const info =
      error instanceof Error
        ? {
            name: error.name,
            message: redactTextForDiagnostics(error.message),
          }
        : { message: redactTextForDiagnostics(String(error)) };
    failures.push({
      at: new Date().toISOString(),
      url,
      targetIds: targets.map((target) => target.id),
      ...info,
    });
    if (failures.length > maxDiagnosticsEntries) failures.shift();
  };

  const onResponse = async (response: PWResponse) => {
    if (disposed) return;
    const rawUrl = response.url();
    const sourceRef = redactUrlForDiagnostics(rawUrl);
    seenCount++;
    lastSeenUrl = sourceRef;
    const request = readAlisiteModuleRequestMeta(
      rawUrl,
      responseRequestPostData(response),
    );
    if (!request) return;
    const targets = opts.targets.filter((target) =>
      matchesAlisiteTarget(request, target),
    );
    if (targets.length === 0) return;
    matchedCount++;
    lastMatchedUrl = sourceRef;
    try {
      const payload = parseMtopJsonp(await response.text());
      const parsed = parseStoreCatalogModule(
        payload,
        storeCatalogRequestMeta(request),
      );
      if (disposed || pageClosed) return;
      const collectedAt = new Date().toISOString();
      for (const target of targets) {
        captures.push({
          targetId: target.id,
          request,
          parsed,
          sourceRef,
          collectedAt,
        });
      }
      parsedCount++;
      lastParsedUrl = sourceRef;
    } catch (error) {
      if (disposed || pageClosed) return;
      recordFailure(sourceRef, targets, error);
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
    waitOptions: AlisiteModuleCaptureWaitOptions,
  ): Promise<AlisiteModuleCaptureWaitResult> => {
    const status = await waitWithDeadline<AlisiteModuleCaptureWaitStatus>(
      async () => {
        if (pageClosed || waitOptions.isClosed?.()) return 'browser_closed';
        if (waitOptions.signal?.aborted) return 'aborted';
        if (allRequiredTargetsSatisfied()) return 'captured';
        if (await waitOptions.isNotLoggedIn?.()) return 'not_logged_in';
        if (await waitOptions.isBlocked?.()) return 'risk_control';
        if (disposed) return 'stream_closed';
        return null;
      },
      {
        timeoutMs: waitOptions.timeoutMs,
        intervalMs: waitOptions.intervalMs ?? 100,
        onTimeout: async () => {
          if (pageClosed || waitOptions.isClosed?.()) return 'browser_closed';
          if (waitOptions.signal?.aborted) return 'aborted';
          if (allRequiredTargetsSatisfied()) return 'captured';
          if (await waitOptions.isNotLoggedIn?.()) return 'not_logged_in';
          if (await waitOptions.isBlocked?.()) return 'risk_control';
          if (disposed) return 'stream_closed';
          return 'timeout';
        },
      },
    );
    finalStatus = status;
    timedOut = status === 'timeout';
    endedAt ??= new Date().toISOString();
    dispose();
    return { status, captures: [...captures], diagnostics: diagnostics() };
  };

  const waitForAction = async <TResult>(
    action: () => Promise<TResult>,
    waitOptions: AlisiteModuleCaptureWaitOptions,
  ): Promise<AlisiteModuleCaptureActionResult<TResult>> => {
    try {
      const actionResult = await action();
      const result = await wait(waitOptions);
      return { actionResult, ...result };
    } finally {
      dispose();
    }
  };

  opts.page.on('response', onResponse);
  opts.page.on('close', onClose);

  return {
    wait,
    waitForAction,
    dispose,
    diagnostics,
    captures: () => [...captures],
  };
}

function matchesAlisiteTarget(
  request: AlisiteModuleRequestMeta,
  target: AlisiteModuleCaptureTarget,
): boolean {
  if (request.api !== ALISITE_MODULE_API) return false;
  if (request.componentKey !== target.componentKey) return false;
  const expected = target.request ?? {};
  return (Object.keys(expected) as Array<keyof AlisiteModuleRequestScope>).every(
    (key) => (request[key] ?? null) === (expected[key] ?? null),
  );
}

function responseRequestPostData(response: PWResponse): string | null {
  try {
    return response.request().postData();
  } catch {
    return null;
  }
}

function readPostDataField(
  postData: string | null | undefined,
  field: string,
): string | null {
  if (!postData) return null;
  try {
    const formValue = new URLSearchParams(postData).get(field);
    if (formValue !== null) return formValue;
  } catch {
    // Fall through to a JSON body probe.
  }
  try {
    const body = JSON.parse(postData) as Record<string, unknown>;
    const value = body[field];
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return null;
  }
}

function storeCatalogRequestMeta(
  request: AlisiteModuleRequestMeta,
): StoreCatalogRequestMeta {
  return {
    memberId: request.memberId ?? null,
    pageNum: request.pageNum ?? null,
    pageSize: request.count ?? null,
    categoryId: request.catId ?? null,
    keyword: request.keywords ?? null,
    sortType: request.sortType ?? null,
  };
}

export function parseStoreCatalogModule(
  payload: unknown,
  requestMeta: StoreCatalogRequestMeta = {},
): StoreCatalogParseResult {
  const root = recordOrNull(payload);
  const data = recordOrNull(root?.data);
  const content = recordOrNull(data?.content);
  const categoryModel = recordOrNull(data?.category);
  if (categoryModel && Array.isArray(categoryModel.offerCategoryList)) {
    const userDefined = parseUserDefined(categoryModel.userDefined);
    const warnings = userDefinedWarnings(
      userDefined,
      'data.category.userDefined',
    );
    return {
      kind: 'categories',
      offerCount: null,
      totalPages: null,
      offers: [],
      categories: mapCategories(
        categoryModel.offerCategoryList,
        'data.category.offerCategoryList',
        warnings,
      ),
      userDefined,
      page: {
        ...requestMeta,
        memberId: requestMeta.memberId ?? stringOrNull(data?.memberId),
      },
      warnings,
    };
  }
  if (!content || !Array.isArray(content.offerList)) {
    throw new AlisiteSchemaError(
      'Expected an Alisite store catalog response at data.content.offerList',
    );
  }

  const warnings: StoreCatalogWarning[] = [];
  const offerCount = nonNegativeIntegerOrNull(content.offerCount);
  if (offerCount === null) {
    warnings.push({
      code: 'INVALID_OFFER_COUNT',
      fieldPath: 'data.content.offerCount',
      message: 'Expected offerCount to be a non-negative integer',
    });
  }
  const pageSize = positiveIntegerOrNull(requestMeta.pageSize);
  const categoriesModel = recordOrNull(content.offerCategoryDataModel);
  const userDefined = parseUserDefined(categoriesModel?.userDefined);
  warnings.push(
    ...userDefinedWarnings(
      userDefined,
      'data.content.offerCategoryDataModel.userDefined',
    ),
  );
  const offers = content.offerList
    .map((raw, index) => {
      const offer = mapOffer(raw, index, requestMeta);
      if (!offer) {
        warnings.push({
          code: 'INVALID_OFFER_ITEM',
          fieldPath: `data.content.offerList[${index}].id`,
          message: 'Skipped offer item without an id',
        });
      }
      return offer;
    })
    .filter((offer): offer is StoreCatalogOffer => offer !== null);
  return {
    kind: 'offer-list',
    offerCount,
    totalPages:
      offerCount !== null && pageSize !== null
        ? Math.ceil(offerCount / pageSize)
        : null,
    offers,
    categories: mapCategories(
      categoriesModel?.offerCategoryList,
      'data.content.offerCategoryDataModel.offerCategoryList',
      warnings,
    ),
    userDefined,
    page: { ...requestMeta },
    warnings,
  };
}

function userDefinedWarnings(
  parsed: ParsedUserDefined,
  fieldPath: string,
): StoreCatalogWarning[] {
  return parsed.state === 'invalid'
    ? [
        {
          code: 'INVALID_USER_DEFINED',
          fieldPath,
          message: 'Expected userDefined to be true, false, or an empty string',
        },
      ]
    : [];
}

function mapOffer(
  raw: unknown,
  index: number,
  requestMeta: StoreCatalogRequestMeta,
): StoreCatalogOffer | null {
  const item = recordOrNull(raw);
  const offerId = stringOrNull(item?.id);
  if (!offerId) return null;
  const images = Array.isArray(item?.offerImages) ? item.offerImages : [];
  const firstImage = recordOrNull(images[0]);
  const offerModel = recordOrNull(item?.offerModel);
  return {
    offerId,
    memberId: stringOrNull(item?.memberId),
    title: stringOrNull(item?.subject),
    url: `https://detail.1688.com/offer/${offerId}.html`,
    imageUrl: stringOrNull(firstImage?.imageURI),
    categoryId: stringOrNull(offerModel?.categoryId1),
    price: stringOrNull(item?.offerPrice),
    quantityBegin: stringOrNull(item?.quantityBegin),
    unit: stringOrNull(item?.unit),
    pagePosition: index + 1,
    absolutePosition: absolutePosition(index, requestMeta),
    sales: {
      vagueSaleQuantity: rawScalarOrNull(item?.vagueSaleQuantity),
      thirtySaleQuantity: rawScalarOrNull(item?.thirtySaleQuantity),
      bookedCount: rawScalarOrNull(item?.bookedCount),
      ninetySaleQuantity: rawScalarOrNull(item?.ninetySaleQuantity),
      saleQuantity: rawScalarOrNull(item?.saleQuantity),
      modelBookedCount: rawScalarOrNull(offerModel?.bookedCount),
      modelAgentBookedCount: rawScalarOrNull(offerModel?.agentBookedCount),
      modelQuantitySumMonth: rawScalarOrNull(offerModel?.quantitySumMonth),
      modelSaleQuantity: rawScalarOrNull(offerModel?.saleQuantity),
    },
  };
}

function absolutePosition(
  index: number,
  requestMeta: StoreCatalogRequestMeta,
): number | null {
  const pageNum = positiveIntegerOrNull(requestMeta.pageNum);
  const pageSize = positiveIntegerOrNull(requestMeta.pageSize);
  return pageNum !== null && pageSize !== null
    ? (pageNum - 1) * pageSize + index + 1
    : null;
}

function mapCategories(
  raw: unknown,
  fieldPath: string,
  warnings: StoreCatalogWarning[],
): StoreCatalogCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value, index) => {
      const item = recordOrNull(value);
      const id = stringOrNull(item?.id);
      const itemPath = `${fieldPath}[${index}]`;
      if (!id) {
        warnings.push({
          code: 'INVALID_CATEGORY_ITEM',
          fieldPath: `${itemPath}.id`,
          message: 'Skipped category item without an id',
        });
        return null;
      }
      const count = nonNegativeIntegerOrNull(item?.count);
      if (count === null) {
        warnings.push({
          code: 'INVALID_CATEGORY_COUNT',
          fieldPath: `${itemPath}.count`,
          message: 'Expected category count to be a non-negative integer',
        });
      }
      return {
        id,
        name: stringOrNull(item?.name),
        fullName: stringOrNull(item?.fullName),
        count,
        children: mapCategories(
          item?.children,
          `${itemPath}.children`,
          warnings,
        ),
      } satisfies StoreCatalogCategory;
    })
    .filter((category): category is StoreCatalogCategory => category !== null);
}

function parseUserDefined(raw: unknown): ParsedUserDefined {
  if (raw === undefined || raw === null) {
    return { raw: raw ?? null, value: null, state: 'missing' };
  }
  if (raw === true || raw === false) {
    return { raw, value: raw, state: 'parsed' };
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return { raw, value: null, state: 'empty' };
    if (normalized === 'true' || normalized === 'false') {
      return { raw, value: normalized === 'true', state: 'parsed' };
    }
  }
  return { raw, value: null, state: 'invalid' };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return recordOrNull(JSON.parse(value));
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return stringOrNull(value) ?? undefined;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function rawScalarOrNull(value: unknown): RawCatalogScalar | null {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return positiveIntegerOrNull(value) ?? undefined;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}
