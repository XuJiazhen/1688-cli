import { createHash } from 'node:crypto';
import { CliError } from '../io/errors.js';

export const SEARCH_CONTRACT_REVISION = 'search-contract-v1@1' as const;
export const SEARCH_FILTER_SNAPSHOT_SCHEMA =
  'search-filter-config-snapshot-v1' as const;
export const SEARCH_SERIALIZER_CAPABILITY_SCHEMA =
  'search-serializer-capability-snapshot-v1' as const;

export const SEARCH_FILTER_REQUEST_KEYS = [
  'bizType',
  'city',
  'complexTags',
  'featurePair',
  'filtMemberTags',
  'filtOfferTags',
  'freeShipping',
  'priceEnd',
  'priceStart',
  'province',
  'quantityBegin',
  'shopCountEnd',
  'shopCountStart',
  'tags',
  'uniqfield',
] as const;

export type SearchFilterRequestKey =
  (typeof SEARCH_FILTER_REQUEST_KEYS)[number];

export type CanonicalSearchSort =
  | 'relevance'
  | 'sales'
  | 'price-asc'
  | 'price-desc';

export type SearchSortInput = CanonicalSearchSort;

export interface SearchFilterOptionV1 {
  groupPath: string[];
  label: string;
  type: string;
  urlKey?: SearchFilterRequestKey;
  value?: string;
  filterId?: string;
  isMultiple?: boolean;
  multiDivider?: string;
  parentRequestContext?: Record<string, string>;
}

export interface SearchFilterInputCapabilityV1 {
  requestKey: SearchFilterRequestKey;
  inputType: 'decimal' | 'integer' | 'string';
  minimum?: number;
  maximum?: number;
}

export interface SearchFilterConfigSnapshotV1 {
  schema: typeof SEARCH_FILTER_SNAPSHOT_SCHEMA;
  snapshotId: string;
  snapshotHash: string;
  keyword: string;
  categoryContext: string | null;
  responseSchemaHash: string;
  parserRevision: typeof SEARCH_CONTRACT_REVISION;
  observedAt: string;
  expiresAt: string;
  options: SearchFilterOptionV1[];
  inputCapabilities: SearchFilterInputCapabilityV1[];
  sortNodes: Array<{
    label: string;
    sortType: string;
    descendOrder: boolean;
  }>;
}

export interface SearchSerializerCapabilityV1 {
  capability: string;
  serializerRevision: string;
  discovered: boolean;
  fixtureVerified: boolean;
  liveCaptureVerified: boolean;
  captureReceiptId: string | null;
  enabledForCompile: boolean;
}

export interface SearchSerializerCapabilitySnapshotV1 {
  schema: typeof SEARCH_SERIALIZER_CAPABILITY_SCHEMA;
  snapshotId: string;
  snapshotHash: string;
  observedAt: string;
  expiresAt: string;
  capabilities: SearchSerializerCapabilityV1[];
}

export interface SearchIntentSelectionV1 {
  groupPath: string[];
  label: string;
  filterId?: string;
}

export interface SearchIntentV1 {
  keyword: string;
  filterConfigSnapshotHash: string;
  sort: SearchSortInput;
  selections: SearchIntentSelectionV1[];
  numeric: {
    priceStart?: string;
    priceEnd?: string;
    quantityBegin?: string;
    shopCountStart?: string;
    shopCountEnd?: string;
  };
  maxPages: number;
  maxOffers: number;
  advertisementPolicy: 'exclude-p4p' | 'archive-and-mark';
}

export interface ResolvedSearchIntentV1 {
  keyword: string;
  sort: CanonicalSearchSort;
  filterConfigSnapshotId: string;
  filterConfigSnapshotHash: string;
  serializerCapabilitySnapshotId: string;
  serializerCapabilitySnapshotHash: string;
  filterParams: Partial<Record<SearchFilterRequestKey, string>>;
  selectedOptions: SearchFilterOptionV1[];
  maxPages: number;
  maxOffers: number;
  advertisementPolicy: SearchIntentV1['advertisementPolicy'];
}

const KNOWN_INPUTS: Readonly<Record<string, SearchFilterInputCapabilityV1>> = {
  priceStart: { requestKey: 'priceStart', inputType: 'decimal', minimum: 0 },
  priceEnd: { requestKey: 'priceEnd', inputType: 'decimal', minimum: 0 },
  quantityBegin: {
    requestKey: 'quantityBegin',
    inputType: 'integer',
    minimum: 0,
  },
  shopCountStart: {
    requestKey: 'shopCountStart',
    inputType: 'integer',
    minimum: 0,
  },
  shopCountEnd: {
    requestKey: 'shopCountEnd',
    inputType: 'integer',
    minimum: 0,
  },
};

const MULTI_COMPOSERS: Readonly<Record<SearchFilterRequestKey, string>> = {
  filtMemberTags: 'semicolon-atoms-v1',
  filtOfferTags: 'opaque-atoms-semicolon-v1',
  tags: 'opaque-atoms-semicolon-v1',
  complexTags: 'semicolon-atoms-v1',
  featurePair: 'feature-pair-grouped-v1',
  bizType: 'semicolon-atoms-v1',
  city: 'single-v1',
  freeShipping: 'single-v1',
  priceEnd: 'single-v1',
  priceStart: 'single-v1',
  province: 'single-v1',
  quantityBegin: 'single-v1',
  shopCountEnd: 'single-v1',
  shopCountStart: 'single-v1',
  uniqfield: 'single-v1',
};

export function normalizeSearchSortInput(input: SearchSortInput): CanonicalSearchSort {
  if (!['relevance', 'sales', 'price-asc', 'price-desc'].includes(input)) {
    searchContractError('SEARCH_SORT_UNSUPPORTED', `Unsupported search sort: ${input}`);
  }
  return input;
}

export function parseSearchFilterConfigSnapshotV1(input: {
  payload: unknown;
  snapshotId: string;
  keyword: string;
  categoryContext?: string | null;
  observedAt: string;
  expiresAt: string;
}): SearchFilterConfigSnapshotV1 {
  const keyword = requiredText(input.keyword, 'keyword');
  const observedAt = timestamp(input.observedAt, 'observedAt');
  const expiresAt = timestamp(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    searchContractError('SEARCH_FILTER_SNAPSHOT_INVALID', 'Filter snapshot must expire after it was observed.');
  }
  const root = asRecord(input.payload);
  const data = asRecord(asRecord(root?.data)?.data) ?? asRecord(root?.data) ?? root;
  const filterData = asRecord(data?.filterData);
  if (!filterData) {
    searchContractError('SEARCH_FILTER_SCHEMA_DRIFT', 'Search filter response does not contain data.data.filterData.');
  }

  const options: SearchFilterOptionV1[] = [];
  const inputCapabilities = new Map<
    SearchFilterRequestKey,
    SearchFilterInputCapabilityV1
  >();
  for (const section of ['filtbarBottom', 'filtbarLeft', 'filtbarRight', 'filters']) {
    collectOptions(
      filterData[section],
      [section],
      options,
      inputCapabilities,
    );
  }
  const unique = uniqueOptions(options);
  if (unique.length === 0 && inputCapabilities.size === 0) {
    searchContractError(
      'SEARCH_FILTER_SCHEMA_DRIFT',
      'Search filter response contains no recognized filters.',
    );
  }

  const responseSchemaHash = sha256(schemaShape(input.payload));
  const base = {
    schema: SEARCH_FILTER_SNAPSHOT_SCHEMA,
    snapshotId: requiredText(input.snapshotId, 'snapshotId'),
    keyword,
    categoryContext: input.categoryContext?.trim() || null,
    responseSchemaHash,
    parserRevision: SEARCH_CONTRACT_REVISION,
    observedAt,
    expiresAt,
    options: unique,
    inputCapabilities: [...inputCapabilities.values()]
      .sort((left, right) => left.requestKey.localeCompare(right.requestKey)),
    sortNodes: discoverSortNodes(filterData),
  };
  return Object.freeze({
    ...base,
    snapshotHash: sha256(base),
  });
}

export function normalizeSearchSerializerCapabilitySnapshotV1(
  value: SearchSerializerCapabilitySnapshotV1,
): SearchSerializerCapabilitySnapshotV1 {
  if (value.schema !== SEARCH_SERIALIZER_CAPABILITY_SCHEMA) {
    searchContractError('SEARCH_SERIALIZER_CAPABILITY_INVALID', 'Serializer capability schema is unsupported.');
  }
  timestamp(value.observedAt, 'capability.observedAt');
  timestamp(value.expiresAt, 'capability.expiresAt');
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    searchContractError('SEARCH_SERIALIZER_CAPABILITY_INVALID', 'Serializer capability snapshot is already invalid.');
  }
  const ids = new Set<string>();
  for (const capability of value.capabilities) {
    requiredText(capability.capability, 'capability');
    requiredText(capability.serializerRevision, 'serializerRevision');
    if (ids.has(capability.capability)) {
      searchContractError('SEARCH_SERIALIZER_CAPABILITY_INVALID', `Duplicate capability ${capability.capability}.`);
    }
    ids.add(capability.capability);
    if (
      capability.enabledForCompile &&
      !(capability.discovered && capability.fixtureVerified && capability.liveCaptureVerified && capability.captureReceiptId)
    ) {
      searchContractError(
        'SEARCH_SERIALIZER_CAPABILITY_INVALID',
        `${capability.capability} cannot be enabled without discovery, fixture, and live capture evidence.`,
      );
    }
  }
  const { snapshotHash: _ignored, ...content } = value;
  if (value.snapshotHash !== sha256(content)) {
    searchContractError('SEARCH_SERIALIZER_CAPABILITY_HASH_MISMATCH', 'Serializer capability snapshot hash does not match its content.');
  }
  return Object.freeze(structuredClone(value));
}

export function createSearchSerializerCapabilitySnapshotV1(input: Omit<
  SearchSerializerCapabilitySnapshotV1,
  'schema' | 'snapshotHash'
>): SearchSerializerCapabilitySnapshotV1 {
  const content = {
    schema: SEARCH_SERIALIZER_CAPABILITY_SCHEMA,
    snapshotId: input.snapshotId,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    capabilities: input.capabilities,
  };
  return normalizeSearchSerializerCapabilitySnapshotV1({
    ...content,
    snapshotHash: sha256(content),
  });
}

export function resolveSearchIntentV1(input: {
  intent: SearchIntentV1;
  filterSnapshot: SearchFilterConfigSnapshotV1;
  capabilitySnapshot: SearchSerializerCapabilitySnapshotV1;
  now?: string;
}): ResolvedSearchIntentV1 {
  const now = Date.parse(input.now ?? new Date().toISOString());
  const snapshot = input.filterSnapshot;
  const { snapshotHash: filterSnapshotHash, ...filterSnapshotContent } = snapshot;
  if (filterSnapshotHash !== sha256(filterSnapshotContent)) {
    searchContractError('SEARCH_FILTER_SNAPSHOT_HASH_MISMATCH', 'Filter snapshot hash does not match its content.');
  }
  const capabilitySnapshot = normalizeSearchSerializerCapabilitySnapshotV1(
    input.capabilitySnapshot,
  );
  if (snapshot.snapshotHash !== input.intent.filterConfigSnapshotHash) {
    searchContractError('SEARCH_FILTER_SNAPSHOT_HASH_MISMATCH', 'Search intent references a different filter snapshot.');
  }
  if (snapshot.keyword !== input.intent.keyword.trim()) {
    searchContractError('SEARCH_FILTER_SNAPSHOT_SCOPE_MISMATCH', 'Filter snapshot belongs to another keyword.');
  }
  if (now > Date.parse(snapshot.expiresAt) || now > Date.parse(capabilitySnapshot.expiresAt)) {
    searchContractError('SEARCH_FILTER_SNAPSHOT_EXPIRED', 'Search filter or serializer capability snapshot is stale.');
  }
  assertPositiveBound(input.intent.maxPages, 20, 'maxPages');
  assertPositiveBound(input.intent.maxOffers, 1200, 'maxOffers');
  const sort = normalizeSearchSortInput(input.intent.sort);
  const selected = input.intent.selections.map((selection, index) => {
    const matches = snapshot.options.filter((option) =>
      sameStrings(option.groupPath, selection.groupPath) &&
      option.label === selection.label &&
      (selection.filterId === undefined || option.filterId === selection.filterId)
    );
    if (matches.length !== 1) {
      searchContractError(
        'SEARCH_FILTER_OPTION_NOT_FOUND',
        `Selection ${index} does not resolve uniquely in its frozen filter snapshot.`,
      );
    }
    const option = matches[0]!;
    if (!option.urlKey || option.value === undefined) {
      searchContractError('SEARCH_FILTER_OPTION_NOT_COMPILABLE', `${option.label} has no verified request key/value.`);
    }
    return option;
  });

  const filterParams: Partial<Record<SearchFilterRequestKey, string>> = {};
  const byKey = groupBy(selected, (option) => option.urlKey!);
  for (const [key, options] of byKey) {
    filterParams[key] = composeOptions(key, options, capabilitySnapshot);
    for (const option of options) {
      for (const [parentKey, parentValue] of Object.entries(option.parentRequestContext ?? {})) {
        if (!isSearchFilterRequestKey(parentKey)) {
          searchContractError('SEARCH_FILTER_PARENT_CONTEXT_INVALID', `Unknown parent request key ${parentKey}.`);
        }
        const existing = filterParams[parentKey];
        if (existing !== undefined && existing !== parentValue) {
          searchContractError('SEARCH_FILTER_PARENT_CONTEXT_CONFLICT', `Conflicting ${parentKey} parent context.`);
        }
        filterParams[parentKey] = parentValue;
      }
    }
  }
  for (const [key, value] of Object.entries(input.intent.numeric)) {
    if (value === undefined) continue;
    const capability = KNOWN_INPUTS[key];
    if (!capability) searchContractError('SEARCH_NUMERIC_FILTER_INVALID', `Unknown numeric filter ${key}.`);
    if (!snapshot.inputCapabilities.some(
      (item) => item.requestKey === capability.requestKey
        && item.inputType === capability.inputType,
    )) {
      searchContractError(
        'SEARCH_NUMERIC_FILTER_NOT_DISCOVERED',
        `Numeric filter ${key} is absent from the frozen filter snapshot.`,
      );
    }
    filterParams[capability.requestKey] = normalizeNumeric(value, capability);
  }
  assertRange(filterParams.priceStart, filterParams.priceEnd, 'price');
  assertRange(filterParams.shopCountStart, filterParams.shopCountEnd, 'shopCount');

  return Object.freeze({
    keyword: input.intent.keyword.trim(),
    sort,
    filterConfigSnapshotId: snapshot.snapshotId,
    filterConfigSnapshotHash: snapshot.snapshotHash,
    serializerCapabilitySnapshotId: capabilitySnapshot.snapshotId,
    serializerCapabilitySnapshotHash: capabilitySnapshot.snapshotHash,
    filterParams: Object.freeze(sortRecord(filterParams)),
    selectedOptions: Object.freeze(selected.map((option) => structuredClone(option))) as SearchFilterOptionV1[],
    maxPages: input.intent.maxPages,
    maxOffers: input.intent.maxOffers,
    advertisementPolicy: input.intent.advertisementPolicy,
  });
}

function collectOptions(
  value: unknown,
  path: string[],
  output: SearchFilterOptionV1[],
  inputCapabilities: Map<
    SearchFilterRequestKey,
    SearchFilterInputCapabilityV1
  >,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectOptions(
      item,
      [...path, String(index)],
      output,
      inputCapabilities,
    ));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const label = firstText(record.label, record.text, record.name, record.title);
  const rawKey = firstText(record.urlKey, record.key, record.requestKey);
  const rawValue = scalarString(record.value ?? record.urlValue ?? record.paramValue);
  const groupLabel = firstText(record.groupName, record.groupLabel, record.title, record.name);
  const nextPath = groupLabel && groupLabel !== label ? [...path, groupLabel] : path;
  if (label && rawKey && isSearchFilterRequestKey(rawKey)) {
    const inputCapability = KNOWN_INPUTS[rawKey];
    if (inputCapability !== undefined) {
      inputCapabilities.set(rawKey, inputCapability);
    } else if (rawValue !== null) {
      const parentRequestContext = scalarRecord(
        record.parentRequestContext ?? record.parentContext,
      );
      output.push({
        groupPath: nextPath.filter((segment) => !/^\d+$/.test(segment)),
        label,
        type: firstText(record.type, record.filterType) ?? 'option',
        urlKey: rawKey,
        value: rawValue,
        ...(firstText(record.filterId, record.id)
          ? { filterId: firstText(record.filterId, record.id)! }
          : {}),
        ...(typeof record.isMultiple === 'boolean'
          ? { isMultiple: record.isMultiple }
          : {}),
        ...(firstText(record.multiDivider)
          ? { multiDivider: firstText(record.multiDivider)! }
          : {}),
        ...(parentRequestContext ? { parentRequestContext } : {}),
      });
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (['parentRequestContext', 'parentContext'].includes(key)) continue;
    if (child && typeof child === 'object') {
      collectOptions(child, nextPath, output, inputCapabilities);
    }
  }
}

function uniqueOptions(options: SearchFilterOptionV1[]): SearchFilterOptionV1[] {
  const unique = new Map<string, SearchFilterOptionV1>();
  for (const option of options) {
    const key = JSON.stringify([
      option.groupPath,
      option.label,
      option.filterId ?? null,
      option.urlKey ?? null,
      option.value ?? null,
    ]);
    unique.set(key, option);
  }
  return [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function discoverSortNodes(filterData: Record<string, unknown>): SearchFilterConfigSnapshotV1['sortNodes'] {
  const found: SearchFilterConfigSnapshotV1['sortNodes'] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(visit);
    const record = asRecord(value);
    if (!record) return;
    const sortType = firstText(record.sortType);
    const descendOrder = record.descendOrder;
    if (sortType && typeof descendOrder === 'boolean') {
      found.push({
        label: firstText(record.label, record.text, record.name) ?? sortType,
        sortType,
        descendOrder,
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(filterData);
  return [...new Map(found.map((node) => [`${node.sortType}:${node.descendOrder}`, node])).values()];
}

function composeOptions(
  key: SearchFilterRequestKey,
  options: SearchFilterOptionV1[],
  snapshot: SearchSerializerCapabilitySnapshotV1,
): string {
  const values = options.map((option) => option.value!);
  if (options.length === 1) return values[0]!;
  if (options.some((option) => option.isMultiple !== true)) {
    searchContractError('SEARCH_FILTER_MULTI_VALUE_NOT_ALLOWED', `${key} contains a non-multiple option.`);
  }
  const capabilityName = `${key}.multi`;
  const capability = snapshot.capabilities.find((item) => item.capability === capabilityName);
  const expectedRevision = MULTI_COMPOSERS[key];
  if (!capability?.enabledForCompile || capability.serializerRevision !== expectedRevision) {
    searchContractError(
      'SEARCH_FILTER_MULTI_VALUE_CAPABILITY_NOT_ENABLED',
      `${capabilityName} is not enabled by the referenced serializer capability snapshot.`,
    );
  }
  if (key === 'featurePair') {
    const grouped = groupBy(options, (option) => option.groupPath.join('\u0000'));
    return [...grouped.values()].map((group) => group.map((option) => option.value!).join(',')).join(';');
  }
  if (!['filtMemberTags', 'filtOfferTags', 'tags', 'complexTags', 'bizType'].includes(key)) {
    searchContractError('SEARCH_FILTER_COMPOSER_UNVERIFIED', `${key} has no verified multi-value composer.`);
  }
  return values.join(';');
}

function normalizeNumeric(
  value: string,
  capability: SearchFilterInputCapabilityV1,
): string {
  const trimmed = value.trim();
  const pattern = capability.inputType === 'integer' ? /^\d+$/ : /^(?:\d+|\d*\.\d+)$/;
  if (!pattern.test(trimmed)) {
    searchContractError('SEARCH_NUMERIC_FILTER_INVALID', `${capability.requestKey} is not a canonical ${capability.inputType}.`);
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || (capability.minimum !== undefined && numeric < capability.minimum)) {
    searchContractError('SEARCH_NUMERIC_FILTER_INVALID', `${capability.requestKey} is outside its allowed range.`);
  }
  if (capability.inputType === 'integer') return String(numeric);
  return numeric.toString();
}

function assertRange(start: string | undefined, end: string | undefined, label: string): void {
  if (start !== undefined && end !== undefined && Number(start) > Number(end)) {
    searchContractError('SEARCH_NUMERIC_FILTER_INVALID', `${label} start must not exceed end.`);
  }
}

function assertPositiveBound(value: number, maximum: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    searchContractError('SEARCH_INTENT_INVALID', `${field} must be an integer between 1 and ${maximum}.`);
  }
}

function searchContractError(code: string, message: string): never {
  throw new CliError(2, code, message, {
    category: 'protocol',
    retryable: false,
    recoveryAction: 'refresh-search-contract',
  });
}

function isSearchFilterRequestKey(value: string): value is SearchFilterRequestKey {
  return (SEARCH_FILTER_REQUEST_KEYS as readonly string[]).includes(value);
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const group = key(item);
    const entries = result.get(group) ?? [];
    entries.push(item);
    result.set(group, entries);
  }
  return result;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    searchContractError('SEARCH_CONTRACT_INVALID', `${field} must be non-empty text without control characters.`);
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    searchContractError('SEARCH_CONTRACT_INVALID', `${field} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function scalarRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (!entries.every(([, item]) => typeof item === 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sortRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) as T;
}

function schemaShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [schemaShape(value[0])];
  const record = asRecord(value);
  if (record) return Object.fromEntries(Object.keys(record).sort().map((key) => [key, schemaShape(record[key])]));
  return value === null ? 'null' : typeof value;
}

function sha256(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (record) return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  return value;
}
