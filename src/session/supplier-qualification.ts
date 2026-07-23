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

export interface SupplierQualification {
  memberId: string | null;
  companyName: Evidence<string>;
  registeredBusinessScope: Evidence<string>;
  socialCreditCode: Evidence<string>;
  establishedAt: Evidence<string>;
  shopSummary: Evidence<string>;
  productionService: Evidence<string>;
  businessLine: Evidence<string>;
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

  const warnings: SupplierQualification['warnings'] = [];
  const collectionFailed = data === null;
  if (!data) {
    warnings.push({
      code: 'QUALIFICATION_DATA_MISSING',
      message: 'Qualification payload does not contain a data object.',
      fieldPath: 'data',
    });
  }

  return {
    memberId,
    companyName: evidence(stringValue(businessInfo?.companyName) ?? stringValue(data?.companyName), source, 'data.businessInfo.companyName', collectionFailed),
    registeredBusinessScope: evidence(stringValue(businessInfo?.companyBusinessLine), source, 'data.businessInfo.companyBusinessLine', collectionFailed),
    socialCreditCode: evidence(stringValue(businessInfo?.socialCreditCode), source, 'data.businessInfo.socialCreditCode', collectionFailed),
    establishedAt: evidence(stringValue(businessInfo?.companyYearStarted), source, 'data.businessInfo.companyYearStarted', collectionFailed),
    shopSummary: evidence(stringValue(data?.summary), source, 'data.summary', collectionFailed),
    productionService: evidence(stringValue(data?.productionService), source, 'data.productionService', collectionFailed),
    businessLine: evidence(stringValue(data?.businessLine), source, 'data.businessLine', collectionFailed),
    certificates,
    certificateListAvailability: Array.isArray(certRaw)
      ? 'available'
      : data
        ? 'not-present'
        : 'failed',
    certificationImages,
    source,
    warnings,
  };
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
