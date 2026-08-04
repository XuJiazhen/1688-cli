import { createHash } from 'node:crypto';
import { CliError } from '../io/errors.js';
import { encodeGbkPercent } from '../util/encoding.js';
import {
  SEARCH_FILTER_REQUEST_KEYS,
  type CanonicalSearchSort,
  type ResolvedSearchIntentV1,
  type SearchFilterRequestKey,
} from './search-contract.js';

export const SEARCH_COMPILER_REVISION = 'search-compiler-v1@1' as const;
export const SEARCH_SERIALIZER_REVISION = 'search-mtop-serializer-v1@1' as const;
export const SEARCH_PAGE_SIZE = 60 as const;
export const SEARCH_PAGE_ID_PLACEHOLDER = '{pageSessionId}' as const;

export interface CanonicalSearchParameterSetV1 {
  schema: 'canonical-search-parameter-set-v1';
  compilerRevision: typeof SEARCH_COMPILER_REVISION;
  serializerRevision: typeof SEARCH_SERIALIZER_REVISION;
  keyword: string;
  encodedKeyword: string;
  sort: CanonicalSearchSort;
  sortType: 'normal' | 'va_sales360' | 'price';
  descendOrder: boolean;
  filterParams: Partial<Record<SearchFilterRequestKey, string>>;
  pageSize: typeof SEARCH_PAGE_SIZE;
  pageIdPlaceholder: typeof SEARCH_PAGE_ID_PLACEHOLDER;
  filterConfigSnapshotId: string;
  filterConfigSnapshotHash: string;
  serializerCapabilitySnapshotId: string;
  serializerCapabilitySnapshotHash: string;
  advertisementPolicy: ResolvedSearchIntentV1['advertisementPolicy'];
  maxPages: number;
  maxOffers: number;
  parameterSetHash: string;
}

export interface CompiledSearchPageRequestV1 {
  parameterSetHash: string;
  page: number;
  pageSessionId: string;
  pageSessionHash: string;
  params: Record<string, string | number | boolean>;
  innerParamsJson: string;
  outerDataJson: string;
  navigationUrl: string;
  requestBusinessHash: string;
}

export interface CapturedSearchRequestBusinessV1 {
  appId: string;
  method: string;
  keywords: string;
  beginPage: string;
  pageSize: number;
  pageId: string;
  sortType: string;
  descendOrder: boolean;
  filterParams: Record<string, string | boolean | number>;
}

const SORT_PROTOCOL: Readonly<Record<CanonicalSearchSort, {
  sortType: CanonicalSearchParameterSetV1['sortType'];
  descendOrder: boolean;
}>> = Object.freeze({
  relevance: { sortType: 'normal', descendOrder: true },
  sales: { sortType: 'va_sales360', descendOrder: true },
  'price-asc': { sortType: 'price', descendOrder: false },
  'price-desc': { sortType: 'price', descendOrder: true },
});

export function compileSearchParameterSetV1(
  intent: ResolvedSearchIntentV1,
): CanonicalSearchParameterSetV1 {
  const sort = SORT_PROTOCOL[intent.sort];
  const content = {
    schema: 'canonical-search-parameter-set-v1' as const,
    compilerRevision: SEARCH_COMPILER_REVISION,
    serializerRevision: SEARCH_SERIALIZER_REVISION,
    keyword: intent.keyword,
    encodedKeyword: encodeGbkPercent(intent.keyword),
    sort: intent.sort,
    sortType: sort.sortType,
    descendOrder: sort.descendOrder,
    filterParams: sortRecord(intent.filterParams),
    pageSize: SEARCH_PAGE_SIZE,
    pageIdPlaceholder: SEARCH_PAGE_ID_PLACEHOLDER,
    filterConfigSnapshotId: intent.filterConfigSnapshotId,
    filterConfigSnapshotHash: intent.filterConfigSnapshotHash,
    serializerCapabilitySnapshotId: intent.serializerCapabilitySnapshotId,
    serializerCapabilitySnapshotHash: intent.serializerCapabilitySnapshotHash,
    advertisementPolicy: intent.advertisementPolicy,
    maxPages: intent.maxPages,
    maxOffers: intent.maxOffers,
  };
  return Object.freeze({
    ...content,
    parameterSetHash: sha256(content),
  });
}

export function compileSearchPageRequestV1(input: {
  parameterSet: CanonicalSearchParameterSetV1;
  page: number;
  pageSessionId: string;
  endpoint?: string;
}): CompiledSearchPageRequestV1 {
  const { parameterSet, page } = input;
  verifyParameterSetHash(parameterSet);
  if (!Number.isInteger(page) || page < 1 || page > parameterSet.maxPages) {
    protocolError('SEARCH_PAGE_OUT_OF_SCOPE', `Search page ${page} is outside the compiled scope.`);
  }
  const pageSessionId = input.pageSessionId.trim();
  if (!pageSessionId || /[\u0000-\u001f\u007f]/.test(pageSessionId)) {
    protocolError('SEARCH_PAGE_SESSION_INVALID', 'Search page session ID is invalid.');
  }
  const params: Record<string, string | number | boolean> = {
    method: 'getOfferList',
    keywords: parameterSet.encodedKeyword,
    beginPage: String(page),
    pageSize: parameterSet.pageSize,
    pageId: pageSessionId,
    sortType: parameterSet.sortType,
    descendOrder: parameterSet.descendOrder,
    ...parameterSet.filterParams,
  };
  const innerParamsJson = JSON.stringify(params);
  const outerDataJson = JSON.stringify({
    appId: 32517,
    params: innerParamsJson,
  });
  const endpoint = input.endpoint ?? 'https://s.1688.com/selloffer/offer_search.htm';
  const navigation = new URL(endpoint);
  const navigationQuery = [
    ['keywords', parameterSet.encodedKeyword, true] as const,
    ['beginPage', String(page), false] as const,
    ['pageSize', String(parameterSet.pageSize), false] as const,
    ['pageId', pageSessionId, false] as const,
    ['sortType', parameterSet.sortType, false] as const,
    ['descendOrder', String(parameterSet.descendOrder), false] as const,
    ...Object.entries(parameterSet.filterParams).map(
      ([key, value]) => [key, value, false] as const,
    ),
  ].map(([key, value, alreadyEncoded]) =>
    `${encodeURIComponent(key)}=${alreadyEncoded ? value : encodeURIComponent(value)}`
  ).join('&');
  navigation.search = `?${navigationQuery}`;
  navigation.hash = '';
  const requestBusiness = {
    appId: '32517',
    ...params,
    filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
    serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
    parameterSetHash: parameterSet.parameterSetHash,
  };
  return Object.freeze({
    parameterSetHash: parameterSet.parameterSetHash,
    page,
    pageSessionId,
    pageSessionHash: sha256({ pageSessionId }),
    params: Object.freeze(params),
    innerParamsJson,
    outerDataJson,
    navigationUrl: navigation.toString(),
    requestBusinessHash: sha256(requestBusiness),
  });
}

export function assertCapturedSearchRequestParityV1(input: {
  compiled: CompiledSearchPageRequestV1;
  captured: CapturedSearchRequestBusinessV1;
}): void {
  const { compiled, captured } = input;
  const expected = compiled.params;
  const expectedFilterKeys = Object.keys(expected)
    .filter((key) => (SEARCH_FILTER_REQUEST_KEYS as readonly string[]).includes(key))
    .sort();
  const capturedFilterKeys = Object.keys(captured.filterParams).sort();
  const mismatch = (
    captured.appId !== '32517' ||
    captured.method !== expected.method ||
    captured.keywords !== expected.keywords ||
    captured.beginPage !== expected.beginPage ||
    captured.pageSize !== expected.pageSize ||
    captured.pageId !== compiled.pageSessionId ||
    captured.sortType !== expected.sortType ||
    captured.descendOrder !== expected.descendOrder ||
    JSON.stringify(capturedFilterKeys) !== JSON.stringify(expectedFilterKeys) ||
    expectedFilterKeys.some((key) => captured.filterParams[key] !== expected[key])
  );
  if (mismatch) {
    protocolError('SEARCH_REQUEST_PARITY_MISMATCH', 'Captured getOfferList request differs from its frozen canonical parameter set.');
  }
}

export function assertSearchPageDerivationV1(
  previous: CompiledSearchPageRequestV1,
  next: CompiledSearchPageRequestV1,
): void {
  if (previous.parameterSetHash !== next.parameterSetHash) {
    protocolError('SEARCH_PAGE_TEMPLATE_DRIFT', 'Search pages use different canonical templates.');
  }
  if (previous.pageSessionHash !== next.pageSessionHash) {
    protocolError('SEARCH_PAGE_SESSION_DRIFT', 'Search pagination changed page session.');
  }
  if (next.page !== previous.page + 1) {
    protocolError('SEARCH_PAGE_SEQUENCE_INVALID', 'Search pages are not contiguous.');
  }
  const previousParams = { ...previous.params, beginPage: '{page}' };
  const nextParams = { ...next.params, beginPage: '{page}' };
  if (JSON.stringify(previousParams) !== JSON.stringify(nextParams)) {
    protocolError('SEARCH_PAGE_TEMPLATE_DRIFT', 'Search pagination changed fields other than beginPage.');
  }
}

export function verifyParameterSetHash(
  parameterSet: CanonicalSearchParameterSetV1,
): void {
  assertCanonicalSearchParameterSetContractV1(parameterSet);
  const { parameterSetHash, ...content } = parameterSet;
  if (parameterSetHash !== sha256(content)) {
    protocolError('SEARCH_PARAMETER_SET_HASH_MISMATCH', 'Canonical parameter set failed hash verification.');
  }
}

/**
 * A content-addressed parameter artifact is still untrusted at the browser
 * boundary. Verify its frozen protocol shape before using it to navigate.
 */
function assertCanonicalSearchParameterSetContractV1(
  parameterSet: CanonicalSearchParameterSetV1,
): void {
  const value = parameterSet as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    parameterSetContractDrift('Canonical Search parameter set must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'schema', 'compilerRevision', 'serializerRevision', 'keyword',
    'encodedKeyword', 'sort', 'sortType', 'descendOrder', 'filterParams',
    'pageSize', 'pageIdPlaceholder', 'filterConfigSnapshotId',
    'filterConfigSnapshotHash', 'serializerCapabilitySnapshotId',
    'serializerCapabilitySnapshotHash', 'advertisementPolicy', 'maxPages',
    'maxOffers', 'parameterSetHash',
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    parameterSetContractDrift('Canonical Search parameter set has an unexpected field shape.');
  }
  if (
    record['schema'] !== 'canonical-search-parameter-set-v1'
    || record['compilerRevision'] !== SEARCH_COMPILER_REVISION
    || record['serializerRevision'] !== SEARCH_SERIALIZER_REVISION
    || record['pageSize'] !== SEARCH_PAGE_SIZE
    || record['pageIdPlaceholder'] !== SEARCH_PAGE_ID_PLACEHOLDER
  ) {
    parameterSetContractDrift('Canonical Search parameter set has an unsupported schema or revision.');
  }
  const keyword = exactText(record['keyword']);
  const encodedKeyword = exactText(record['encodedKeyword']);
  if (encodedKeyword !== encodeGbkPercent(keyword)) {
    parameterSetContractDrift('Canonical Search parameter set keyword encoding drifted.');
  }
  const sort = record['sort'];
  if (
    sort !== 'relevance'
    && sort !== 'sales'
    && sort !== 'price-asc'
    && sort !== 'price-desc'
  ) {
    parameterSetContractDrift('Canonical Search parameter set has an unsupported business sort.');
  }
  const expectedSort = SORT_PROTOCOL[sort];
  if (
    record['sortType'] !== expectedSort.sortType
    || record['descendOrder'] !== expectedSort.descendOrder
  ) {
    parameterSetContractDrift('Canonical Search parameter set sort pair drifted.');
  }
  if (!isSha256(record['filterConfigSnapshotHash'])
    || !isSha256(record['serializerCapabilitySnapshotHash'])
    || !isSha256(record['parameterSetHash'])
    || !safeIdentifier(record['filterConfigSnapshotId'])
    || !safeIdentifier(record['serializerCapabilitySnapshotId'])) {
    parameterSetContractDrift('Canonical Search parameter set authority binding is invalid.');
  }
  const filterParams = record['filterParams'];
  if (filterParams === null || typeof filterParams !== 'object' || Array.isArray(filterParams)) {
    parameterSetContractDrift('Canonical Search parameter set filters must be an object.');
  }
  const filterRecord = filterParams as Record<string, unknown>;
  const filterKeys = Object.keys(filterRecord);
  const expectedFilterKeys = [...filterKeys].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(filterKeys) !== JSON.stringify(expectedFilterKeys)) {
    parameterSetContractDrift('Canonical Search parameter set filters are not deterministically ordered.');
  }
  for (const key of filterKeys) {
    if (!(SEARCH_FILTER_REQUEST_KEYS as readonly string[]).includes(key)) {
      parameterSetContractDrift(`Canonical Search parameter set contains unsupported filter ${key}.`);
    }
    const filterValue = filterRecord[key];
    if (typeof filterValue !== 'string' || filterValue.length === 0 || filterValue.trim() !== filterValue) {
      parameterSetContractDrift(`Canonical Search parameter set filter ${key} is invalid.`);
    }
    if (!canonicalNumericFilter(key, filterValue)) {
      parameterSetContractDrift(`Canonical Search parameter set numeric filter ${key} is not canonical.`);
    }
  }
  const maxPages = record['maxPages'];
  const maxOffers = record['maxOffers'];
  if (
    typeof maxPages !== 'number'
    || !Number.isSafeInteger(maxPages)
    || maxPages < 1
    || typeof maxOffers !== 'number'
    || !Number.isSafeInteger(maxOffers)
    || maxOffers < 1
  ) {
    parameterSetContractDrift('Canonical Search parameter set bounds are invalid.');
  }
  if (
    record['advertisementPolicy'] !== 'exclude-p4p'
    && record['advertisementPolicy'] !== 'archive-and-mark'
  ) {
    parameterSetContractDrift('Canonical Search parameter set advertisement policy is invalid.');
  }
}

function canonicalNumericFilter(key: string, value: string): boolean {
  switch (key) {
    case 'quantityBegin':
    case 'shopCountStart':
    case 'shopCountEnd':
      return /^(?:0|[1-9][0-9]*)$/u.test(value);
    case 'priceStart':
    case 'priceEnd':
      return /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u.test(value);
    default:
      return true;
  }
}

function exactText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    parameterSetContractDrift('Canonical Search parameter set text is invalid.');
  }
  return value;
}

function safeIdentifier(value: unknown): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function parameterSetContractDrift(message: string): never {
  protocolError('SEARCH_PARAMETER_SET_CONTRACT_DRIFT', message);
}

function protocolError(code: string, message: string): never {
  throw new CliError(9, code, message, {
    category: 'protocol',
    retryable: false,
    recoveryAction: 'refresh-search-contract',
  });
}

function sortRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) as T;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}
