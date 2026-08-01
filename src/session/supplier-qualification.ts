import type { Evidence, EvidenceSource } from '../collection/contracts.js';

export const SUPPLIER_QUALIFICATION_COMPONENT_KEY =
  'wp_pc_shop_basic_info' as const;
export const SUPPLIER_QUALIFICATION_PARSER_VERSION = '1' as const;

export interface SupplierQualificationCertificate {
  name: string | null;
  type: string | null;
  imageUrl: string | null;
}

export interface SupplierQualificationImage {
  type: string | null;
  url: string;
}

export interface SupplierQualificationNamedFact {
  key: string;
  label: string | null;
  value: string | number | boolean | null;
}

export interface SupplierQualification {
  memberId: string | null;
  companyName: Evidence<string>;
  registeredBusinessScope: Evidence<string>;
  socialCreditCode: Evidence<string>;
  establishedAt: Evidence<string>;
  registeredAddress: Evidence<string>;
  sellerType: Evidence<string>;
  shopSummary: Evidence<string>;
  productionService: Evidence<string>;
  businessLine: Evidence<string>;
  strengthSignals: SupplierQualificationNamedFact[];
  strengthSignalsAvailability: 'available' | 'not-present' | 'failed';
  guaranteeItems: SupplierQualificationNamedFact[];
  guaranteeItemsAvailability: 'available' | 'not-present' | 'failed';
  certificates: SupplierQualificationCertificate[];
  certificateListAvailability: 'available' | 'not-present' | 'failed';
  certificationImages: SupplierQualificationImage[];
  source: EvidenceSource;
  warnings: Array<{ code: string; message: string; fieldPath?: string }>;
}

export function mapSupplierQualificationPayload(
  payload: unknown,
  collectedAt = new Date().toISOString(),
): SupplierQualification {
  const root = record(payload);
  const data = record(root?.data);
  const businessInfo = record(data?.businessInfo);
  const memberId = stringValue(data?.memberId);
  const source: EvidenceSource = {
    sourceType: 'supplier-payload',
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    componentKey: SUPPLIER_QUALIFICATION_COMPONENT_KEY,
    fieldPath: 'data.businessInfo.companyBusinessLine',
    sourceRef: `alisite:${SUPPLIER_QUALIFICATION_COMPONENT_KEY}:${memberId ?? 'unknown'}`,
    collectedAt,
    collectorVersion: '1688-cli',
    parserVersion: SUPPLIER_QUALIFICATION_PARSER_VERSION,
  };

  const certRaw = data?.certList;
  const certificateListMalformed = certRaw !== undefined && !Array.isArray(certRaw);
  const certificates = Array.isArray(certRaw)
    ? certRaw.map((item) => {
        const entry = record(item);
        return {
          name: stringValue(entry?.name) ?? stringValue(entry?.certName),
          type: stringValue(entry?.type) ?? stringValue(entry?.certType),
          imageUrl: normalizeUrl(
            stringValue(entry?.imageUrl) ??
              stringValue(entry?.url) ??
              stringValue(entry?.imgUrl),
          ),
        };
      })
    : [];

  const propaganda = record(data?.propaganda);
  const certificationImages = array(propaganda?.companyImg)
    .map((item) => {
      const entry = record(item);
      const url = normalizeUrl(stringValue(entry?.url));
      if (!url) return null;
      return { type: stringValue(entry?.type), url };
    })
    .filter((item): item is SupplierQualificationImage => item !== null);

  const strengthSignals = namedFacts([
    ['strengthSignals', data?.strengthSignals],
    ['factorySignals', data?.factorySignals],
    ['factoryInspection', data?.factoryInspection],
    ['businessInspection', data?.businessInspection],
    ['superFactory', data?.superFactory],
  ]);
  const guaranteeItems = namedFacts([
    ['guaranteeItems', data?.guaranteeItems],
    ['guarantees', data?.guarantees],
    ['serviceGuarantees', data?.serviceGuarantees],
  ]);

  const warnings: SupplierQualification['warnings'] = [];
  const collectionFailed = data === null;
  if (!data) {
    warnings.push({
      code: 'QUALIFICATION_DATA_MISSING',
      message: 'Qualification payload does not contain a data object.',
      fieldPath: 'data',
    });
  }
  if (certificateListMalformed) {
    warnings.push({
      code: 'QUALIFICATION_CERT_LIST_SCHEMA_INVALID',
      message: 'Qualification certList is present but is not an array.',
      fieldPath: 'data.certList',
    });
  }

  return {
    memberId,
    companyName: evidence(stringValue(businessInfo?.companyName) ?? stringValue(data?.companyName), source, 'data.businessInfo.companyName', collectionFailed),
    registeredBusinessScope: evidence(stringValue(businessInfo?.companyBusinessLine), source, 'data.businessInfo.companyBusinessLine', collectionFailed),
    socialCreditCode: evidence(stringValue(businessInfo?.socialCreditCode), source, 'data.businessInfo.socialCreditCode', collectionFailed),
    establishedAt: evidence(stringValue(businessInfo?.companyYearStarted), source, 'data.businessInfo.companyYearStarted', collectionFailed),
    registeredAddress: evidence(
      firstString(
        businessInfo?.registeredAddress,
        businessInfo?.companyRegisteredAddress,
        businessInfo?.companyAddress,
        data?.registeredAddress,
      ),
      source,
      'data.businessInfo.registeredAddress',
      collectionFailed,
    ),
    sellerType: evidence(
      firstString(businessInfo?.sellerType, data?.sellerType, data?.sellerIdentity),
      source,
      'data.sellerType',
      collectionFailed,
    ),
    shopSummary: evidence(stringValue(data?.summary), source, 'data.summary', collectionFailed),
    productionService: evidence(stringValue(data?.productionService), source, 'data.productionService', collectionFailed),
    businessLine: evidence(stringValue(data?.businessLine), source, 'data.businessLine', collectionFailed),
    strengthSignals: strengthSignals.items,
    strengthSignalsAvailability: collectionFailed
      ? 'failed'
      : strengthSignals.present
        ? 'available'
        : 'not-present',
    guaranteeItems: guaranteeItems.items,
    guaranteeItemsAvailability: collectionFailed
      ? 'failed'
      : guaranteeItems.present
        ? 'available'
        : 'not-present',
    certificates,
    certificateListAvailability: Array.isArray(certRaw)
      ? 'available'
      : certificateListMalformed
        ? 'failed'
        : data
          ? 'not-present'
          : 'failed',
    certificationImages,
    source,
    warnings,
  };
}

function namedFacts(
  sources: Array<[string, unknown]>,
): { present: boolean; items: SupplierQualificationNamedFact[] } {
  const presentSources = sources.filter(([, value]) => value !== undefined);
  const items = presentSources.flatMap(([sourceKey, value]) => namedFactValues(sourceKey, value));
  return { present: presentSources.length > 0, items };
}

function namedFactValues(
  sourceKey: string,
  value: unknown,
): SupplierQualificationNamedFact[] {
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => namedFactEntry(`${sourceKey}.${index}`, entry));
  }
  const object = record(value);
  if (object) {
    const direct = namedFactEntry(sourceKey, object);
    if (direct.length > 0 && hasNamedFactShape(object)) return direct;
    return Object.entries(object).flatMap(([key, entry]) =>
      namedFactEntry(key, entry, key)
    );
  }
  return namedFactEntry(sourceKey, value);
}

function namedFactEntry(
  fallbackKey: string,
  value: unknown,
  fallbackLabel?: string,
): SupplierQualificationNamedFact[] {
  const scalar = qualificationScalar(value);
  if (scalar !== undefined) {
    return [{ key: fallbackKey, label: fallbackLabel ?? null, value: scalar }];
  }
  const entry = record(value);
  if (!entry) return [];
  const key = firstString(entry.key, entry.code, entry.id, entry.type) ?? fallbackKey;
  const label = firstString(entry.label, entry.name, entry.title) ?? fallbackLabel ?? null;
  const entryValue = firstQualificationScalar(
    entry.value,
    entry.status,
    entry.enabled,
    entry.displayStatus,
  );
  return [{ key, label, value: entryValue ?? null }];
}

function hasNamedFactShape(value: Record<string, unknown>): boolean {
  return ['key', 'code', 'id', 'type', 'label', 'name', 'title', 'value', 'status', 'enabled', 'displayStatus']
    .some((key) => Object.hasOwn(value, key));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstQualificationScalar(
  ...values: unknown[]
): string | number | boolean | undefined {
  for (const value of values) {
    const parsed = qualificationScalar(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function qualificationScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function evidence(
  value: string | null,
  base: EvidenceSource,
  fieldPath: string,
  failed: boolean,
): Evidence<string> {
  const source = { ...base, fieldPath };
  if (failed) {
    return {
      availability: 'failed',
      value: null,
      source,
      error: {
        code: 'QUALIFICATION_DATA_MISSING',
        message: 'Qualification payload does not contain a data object.',
      },
    };
  }
  return value === null
    ? { availability: 'not-present', value: null, source }
    : { availability: 'available', value, source };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
