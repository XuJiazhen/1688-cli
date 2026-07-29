import {
  normalizeEvidence,
  type Evidence,
  type EvidenceSource,
} from '../collection/contracts.js';
import { CliError } from '../io/errors.js';
import {
  mapShopCardPayload,
  type ShopCardInfo,
  type ShopCardMetric,
  type SupplierServiceScore,
} from './offer-evidence.js';
import { ALISITE_MODULE_API } from './alisite-module.js';

export const STORE_PROFILE_API = 'mtop.1688.moga.pc.shopcard' as const;
export const STORE_PROFILE_COMPONENT_KEY = 'wp_pc_common_header' as const;
export const STORE_PROFILE_PARSER_VERSION = 'store-profile-v1' as const;

export interface StoreProfileWarning {
  code: string;
  message: string;
  fieldPath?: string;
}

export interface StoreProfileSnapshot {
  name: Evidence<string>;
  shopUrl: Evidence<string>;
  shopType: Evidence<string>;
  iconType: Evidence<string>;
  badge: Evidence<NonNullable<ShopCardInfo['badge']>>;
  mainCategoryName: Evidence<string>;
  years: Evidence<number>;
  isFollowing: Evidence<boolean>;
  followersText: Evidence<string>;
  attentionOperationType: Evidence<string>;
  metrics: Evidence<ShopCardMetric[]>;
  returnRate: Evidence<number>;
  serviceScore: Evidence<number>;
  onTimeDeliveryRate: Evidence<number>;
  positiveReviewRate: Evidence<number>;
  companyId: Evidence<string>;
  companyLabel: Evidence<string>;
  companyIcons: Evidence<ShopCardInfo['companyIcons']>;
  shopTags: Evidence<string[]>;
  factoryCardUrl: Evidence<string>;
  factoryAuthText: Evidence<string>;
  serviceScores: Evidence<SupplierServiceScore[]>;
  region: Evidence<string>;
  address: Evidence<string>;
  source: EvidenceSource;
  warnings: StoreProfileWarning[];
}

export interface StoreProfileParserOptions {
  sourceRef?: string;
  rawRef?: string;
}

export interface NamedStoreProfileEvidence {
  field: StoreProfileEvidenceField;
  evidence: Evidence<unknown>;
}

export type StoreProfileEvidenceField = Exclude<
  keyof StoreProfileSnapshot,
  'source' | 'warnings'
>;

export function mapStoreProfilePayload(
  payload: unknown,
  collectedAt = new Date().toISOString(),
  options: StoreProfileParserOptions = {},
): StoreProfileSnapshot {
  const commonHeader = mapCommonHeaderPayload(payload);
  const shopCard = commonHeader?.info ?? mapShopCardPayload(payload);
  const failed = commonHeader === null && shopCard === null;
  const data = record(record(payload)?.data);
  const model = record(data?.model);
  const factoryInfo = record(data?.factoryInfo);
  const appData = record(data?.appData);
  const lindormData = record(data?.lindormDataModel);
  const modern = model !== null;
  const current = commonHeader !== null;
  const source: EvidenceSource = {
    sourceType: 'supplier-payload',
    api: current ? ALISITE_MODULE_API : STORE_PROFILE_API,
    ...(current ? { componentKey: STORE_PROFILE_COMPONENT_KEY } : {}),
    fieldPath: current ? 'data.data' : 'data.model',
    sourceRef:
      options.sourceRef ??
      `mtop:${current ? ALISITE_MODULE_API : STORE_PROFILE_API}`,
    collectedAt,
    collectorVersion: '1688-cli',
    parserVersion: STORE_PROFILE_PARSER_VERSION,
    ...(options.rawRef === undefined ? {} : { rawRef: options.rawRef }),
  };
  const warnings: StoreProfileWarning[] = failed
    ? [{
        code: 'STORE_PROFILE_DATA_MISSING',
        message: 'The payload did not contain a recognized store profile.',
        fieldPath: 'data',
      }]
    : [];

  return {
    name: collectedEvidence(
      shopCard?.name ?? null,
      source,
      current
        ? 'data.data.companyName'
        : modern
          ? 'data.model.shopName'
          : 'data.companyName',
      failed,
    ),
    shopUrl: collectedEvidence(
      shopCard?.url ?? null,
      source,
      current
        ? 'data.data.commonUrl.shopUrl'
        : modern
          ? 'data.model.shopUrl'
          : 'data.shopUrl',
      failed,
    ),
    shopType: collectedEvidence(
      shopCard?.shopType ?? null,
      source,
      current ? 'data.data.sellerType' : 'data.model.shopType',
      failed,
    ),
    iconType: collectedEvidence(
      shopCard?.iconType ?? null,
      source,
      current ? 'data.data.pcV2SellerTagLogo' : 'data.model.iconType',
      failed,
    ),
    badge: collectedEvidence(
      shopCard?.badge ?? null,
      source,
      current
        ? commonHeader.paths.badge
        : modern
          ? 'data.model.iconType'
          : 'data.companyLabel',
      failed,
    ),
    mainCategoryName: collectedEvidence(
      shopCard?.mainCategoryName ?? null,
      source,
      current ? 'data.data.mainCate' : 'data.model.mainCategoryName',
      failed,
    ),
    years: collectedEvidence(
      shopCard?.years ?? null,
      source,
      current ? 'data.data.tpYear' : 'data.model.tpYear',
      failed,
    ),
    isFollowing: collectedEvidence(
      shopCard?.attention.isFollowing ?? null,
      source,
      current
        ? 'data.data.fans.isFans'
        : 'data.model.shopButton.attentionRelation',
      failed,
    ),
    followersText: collectedEvidence(
      shopCard?.attention.followersText ?? null,
      source,
      current ? 'data.data.fans.num' : 'data.model.shopButton.fuzzyFavCount',
      failed,
    ),
    attentionOperationType: collectedEvidence(
      shopCard?.attention.operationType ?? null,
      source,
      current ? 'data.data.fans' : 'data.model.shopButton.type',
      failed,
    ),
    metrics: arrayEvidence(
      shopCard?.metrics ?? null,
      current
        ? commonHeader.presence.metrics
        : Array.isArray(model?.shopData),
      source,
      current ? 'data.data.cardDetail' : 'data.model.shopData',
      failed,
    ),
    returnRate: collectedEvidence(
      shopCard?.returnRate ?? null,
      source,
      current
        ? commonHeader.paths.returnRate
        : modern
          ? 'data.model.shopData'
          : 'data.retentionRate',
      failed,
    ),
    serviceScore: collectedEvidence(
      shopCard?.serviceScore ?? null,
      source,
      current ? 'data.data.customerStar' : 'data.model.shopData',
      failed,
    ),
    onTimeDeliveryRate: collectedEvidence(
      shopCard?.onTimeDeliveryRate ?? null,
      source,
      current
        ? commonHeader.paths.onTimeDeliveryRate
        : 'data.model.shopData',
      failed,
    ),
    positiveReviewRate: collectedEvidence(
      shopCard?.positiveReviewRate ?? null,
      source,
      current
        ? 'data.data.cardDetail[code=goodRate]'
        : 'data.model.shopData',
      failed,
    ),
    companyId: collectedEvidence(
      shopCard?.companyId ?? null,
      source,
      current ? 'data.data.companyId' : 'data.companyId',
      failed,
    ),
    companyLabel: collectedEvidence(
      shopCard?.companyLabel ?? null,
      source,
      current ? 'data.data.certInfo.certType' : 'data.companyLabel',
      failed,
    ),
    companyIcons: arrayEvidence(
      shopCard?.companyIcons ?? null,
      current
        ? commonHeader.presence.companyIcons
        : modern
          ? shopCard?.companyIcons.length !== 0
          : Array.isArray(data?.companyIcons),
      source,
      current
        ? commonHeader.paths.companyIcons
        : modern
          ? 'data.model.iconType'
          : 'data.companyIcons',
      failed,
    ),
    shopTags: arrayEvidence(
      shopCard?.shopTags ?? null,
      current
        ? commonHeader.presence.shopTags
        : Array.isArray(factoryInfo?.shopTag),
      source,
      current ? 'data.data.shopTags' : 'data.factoryInfo.shopTag',
      failed,
    ),
    factoryCardUrl: collectedEvidence(
      shopCard?.factoryCardUrl ?? null,
      source,
      current
        ? 'data.data.factoryCardUrl'
        : 'data.factoryInfo.shopProperty.pcLinkUrl',
      failed,
    ),
    factoryAuthText: collectedEvidence(
      shopCard?.factoryAuthText ?? null,
      source,
      current
        ? 'data.data.certInfo'
        : 'data.factoryInfo.shopProperty.authText',
      failed,
    ),
    serviceScores: arrayEvidence(
      shopCard?.serviceScores ?? null,
      current
        ? commonHeader.presence.serviceScores
        : modern
          ? Array.isArray(model?.shopData)
          : Array.isArray(appData?.serviceList) ||
            Array.isArray(lindormData?.serviceStarList),
      source,
      current
        ? 'data.data.businessTags'
        : modern
          ? 'data.model.shopData'
          : Array.isArray(appData?.serviceList)
            ? 'data.appData.serviceList'
            : 'data.lindormDataModel.serviceStarList',
      failed,
    ),
    region: collectedEvidence(
      commonHeader?.region ?? null,
      source,
      current ? 'data.data.addr' : 'data.addr',
      failed,
    ),
    address: collectedEvidence(
      commonHeader?.address ?? null,
      source,
      current ? 'data.data.addr.entAddress' : 'data.addr.entAddress',
      failed,
    ),
    source,
    warnings,
  };
}

export function normalizeStoreProfileSnapshot(
  value: unknown,
): StoreProfileSnapshot {
  const profile = record(value);
  if (profile === null) {
    invalidStoreProfile('StoreProfileSnapshot must be an object.');
  }
  const source = normalizeEvidence<string>({
    availability: 'available',
    value: 'store-profile-source',
    source: profile.source,
  }).source;
  const field = <T>(entry: unknown) =>
    normalizeStoreProfileEvidence<T>(entry, source);

  return {
    name: field<string>(profile.name),
    shopUrl: field<string>(profile.shopUrl),
    shopType: field<string>(profile.shopType),
    iconType: field<string>(profile.iconType),
    badge: field<NonNullable<ShopCardInfo['badge']>>(
      profile.badge,
    ),
    mainCategoryName: field<string>(profile.mainCategoryName),
    years: field<number>(profile.years),
    isFollowing: field<boolean>(profile.isFollowing),
    followersText: field<string>(profile.followersText),
    attentionOperationType: field<string>(
      profile.attentionOperationType,
    ),
    metrics: field<ShopCardMetric[]>(profile.metrics),
    returnRate: field<number>(profile.returnRate),
    serviceScore: field<number>(profile.serviceScore),
    onTimeDeliveryRate: field<number>(
      profile.onTimeDeliveryRate,
    ),
    positiveReviewRate: field<number>(
      profile.positiveReviewRate,
    ),
    companyId: field<string>(profile.companyId),
    companyLabel: field<string>(profile.companyLabel),
    companyIcons: field<ShopCardInfo['companyIcons']>(
      profile.companyIcons,
    ),
    shopTags: field<string[]>(profile.shopTags),
    factoryCardUrl: field<string>(profile.factoryCardUrl),
    factoryAuthText: field<string>(profile.factoryAuthText),
    serviceScores: field<SupplierServiceScore[]>(
      profile.serviceScores,
    ),
    region: field<string>(profile.region),
    address: field<string>(profile.address),
    source,
    warnings: normalizeStoreProfileWarnings(profile.warnings),
  };
}

export function storeProfileEvidence(
  profile: StoreProfileSnapshot,
): NamedStoreProfileEvidence[] {
  return [
    ['name', profile.name],
    ['shopUrl', profile.shopUrl],
    ['shopType', profile.shopType],
    ['iconType', profile.iconType],
    ['badge', profile.badge],
    ['mainCategoryName', profile.mainCategoryName],
    ['years', profile.years],
    ['isFollowing', profile.isFollowing],
    ['followersText', profile.followersText],
    ['attentionOperationType', profile.attentionOperationType],
    ['metrics', profile.metrics],
    ['returnRate', profile.returnRate],
    ['serviceScore', profile.serviceScore],
    ['onTimeDeliveryRate', profile.onTimeDeliveryRate],
    ['positiveReviewRate', profile.positiveReviewRate],
    ['companyId', profile.companyId],
    ['companyLabel', profile.companyLabel],
    ['companyIcons', profile.companyIcons],
    ['shopTags', profile.shopTags],
    ['factoryCardUrl', profile.factoryCardUrl],
    ['factoryAuthText', profile.factoryAuthText],
    ['serviceScores', profile.serviceScores],
    ['region', profile.region],
    ['address', profile.address],
  ].map(([field, evidence]) => ({
    field: field as StoreProfileEvidenceField,
    evidence: evidence as Evidence<unknown>,
  }));
}

function collectedEvidence<T>(
  value: T | null,
  base: EvidenceSource,
  fieldPath: string,
  failed: boolean,
): Evidence<T> {
  const source = { ...base, fieldPath };
  if (failed) {
    return {
      availability: 'failed',
      value: null,
      source,
      error: {
        code: 'STORE_PROFILE_DATA_MISSING',
        message: 'The payload did not contain a recognized store profile.',
      },
    };
  }
  return value === null
    ? { availability: 'not-present', value: null, source }
    : { availability: 'available', value, source };
}

function arrayEvidence<T>(
  value: T[] | null,
  sourcePresent: boolean,
  base: EvidenceSource,
  fieldPath: string,
  failed: boolean,
): Evidence<T[]> {
  if (failed) {
    return collectedEvidence(value, base, fieldPath, true);
  }
  if (!sourcePresent && (value?.length ?? 0) === 0) {
    return {
      availability: 'not-present',
      value: null,
      source: { ...base, fieldPath },
    };
  }
  return {
    availability: 'available',
    value: value ?? [],
    source: { ...base, fieldPath },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface CommonHeaderMapping {
  info: ShopCardInfo;
  region: string | null;
  address: string | null;
  presence: {
    metrics: boolean;
    companyIcons: boolean;
    shopTags: boolean;
    serviceScores: boolean;
  };
  paths: {
    badge: string;
    companyIcons: string;
    returnRate: string;
    onTimeDeliveryRate: string;
  };
}

function mapCommonHeaderPayload(payload: unknown): CommonHeaderMapping | null {
  const root = record(payload);
  const envelope = record(root?.data);
  const data = jsonRecord(envelope?.data) ?? record(envelope?.data);
  const api = stringOrNull(root?.api)?.toLowerCase();
  const recognized = data !== null && (
    api === ALISITE_MODULE_API ||
    booleanLike(envelope?.success) === true ||
    COMMON_HEADER_FIELDS.some((field) => Object.hasOwn(data, field))
  );
  if (!recognized || data === null) return null;

  const cardDetailRaw = Array.isArray(data.cardDetail) ? data.cardDetail : null;
  const metrics = (cardDetailRaw ?? [])
    .map((entry) => {
      const item = record(entry);
      const key = stringOrNull(item?.code) ?? stringOrNull(item?.title);
      if (!key) return null;
      const valueText = stringOrNull(item?.info);
      return {
        key,
        valueText,
        value: numberOrNull(valueText),
        unit: stringOrNull(record(item?.extendInfo)?.infoUnit),
      } satisfies ShopCardMetric;
    })
    .filter((entry): entry is ShopCardMetric => entry !== null);
  const metric = (key: string) =>
    metrics.find((entry) => entry.key === key);

  const businessModelRaw = Array.isArray(data.businessModelList)
    ? data.businessModelList
    : null;
  const certInfo = record(data.certInfo);
  const businessModelIcons = (businessModelRaw ?? [])
    .map((entry) => {
      const item = record(entry);
      const title = stringOrNull(item?.title);
      if (!title) return null;
      return {
        title,
        link: normalizeUrl(
          stringOrNull(item?.link) ?? stringOrNull(item?.icon),
        ),
      };
    })
    .filter(
      (entry): entry is { title: string; link: string | null } =>
        entry !== null,
    );
  const companyIcons = [...businessModelIcons];
  if (companyIcons.length === 0 && certInfo !== null) {
    const title = stringOrNull(certInfo.certType);
    if (title) {
      companyIcons.push({
        title,
        link: normalizeUrl(
          stringOrNull(certInfo.linkUrl) ?? stringOrNull(certInfo.certLogo),
        ),
      });
    }
  }

  const businessTagsRaw = Array.isArray(data.businessTags)
    ? data.businessTags
    : null;
  const serviceScores = (businessTagsRaw ?? [])
    .map((entry) => {
      const item = record(entry);
      const label = stringOrNull(item?.text);
      if (!label) return null;
      return {
        key: stringOrNull(item?.code) ?? label,
        label,
        score: numberOrNull(item?.value),
      } satisfies SupplierServiceScore;
    })
    .filter((entry): entry is SupplierServiceScore => entry !== null);
  const sellerType = stringOrNull(data.sellerType);
  const badgeImage = normalizeUrl(
    stringOrNull(data.pcV2ShopCardTypeImg) ??
      stringOrNull(data.pcV2SellerTagLogo),
  );
  const fans = record(data.fans);
  const commonUrl = record(data.commonUrl);
  const returnRateSource = metric('byrRepeatRate');
  const returnRateText =
    stringOrNull(data.byrRepeatRateText) ??
    returnRateSource?.valueText ??
    null;
  const deliveryRateSource = metric('lgtFulfillGotRate');
  const deliveryRateText =
    stringOrNull(data.lgtFulfillGotRateText) ??
    deliveryRateSource?.valueText ??
    null;
  const shopTagsRaw = Array.isArray(data.shopTags)
    ? data.shopTags
    : null;
  const shopTags = (shopTagsRaw ?? [])
    .map((entry) =>
      stringOrNull(entry) ?? stringOrNull(record(entry)?.text),
    )
    .filter((entry): entry is string => entry !== null);
  const certText = joinText([
    stringOrNull(certInfo?.certType),
    stringOrNull(certInfo?.certNum),
  ], ' ');
  const addr = record(data.addr);
  const region = joinDistinctText([
    stringOrNull(addr?.province),
    stringOrNull(addr?.capitalName),
    stringOrNull(addr?.city),
  ]);

  return {
    info: {
      name: stringOrNull(data.companyName),
      url: normalizeUrl(stringOrNull(commonUrl?.shopUrl)),
      shopType: sellerType,
      iconType: null,
      badge:
        sellerType === null && badgeImage === null
          ? null
          : {
              code: sellerType ?? 'shop-card-type',
              label: null,
              imageUrl: badgeImage,
            },
      mainCategoryName: stringOrNull(data.mainCate),
      years: parseInteger(data.tpYear),
      attention: {
        isFollowing: booleanLike(fans?.isFans),
        followersText: stringOrNull(fans?.num),
        operationType: null,
      },
      metrics,
      returnRate: percentRatio(
        returnRateText,
        Object.hasOwn(data, 'byrRepeatRateText')
          ? undefined
          : returnRateSource?.unit,
      ),
      serviceScore: numberOrNull(data.customerStar),
      onTimeDeliveryRate: percentRatio(
        deliveryRateText,
        Object.hasOwn(data, 'lgtFulfillGotRateText')
          ? undefined
          : deliveryRateSource?.unit,
      ),
      positiveReviewRate: percentRatio(
        metric('goodRate')?.valueText,
        metric('goodRate')?.unit,
      ),
      companyId: stringOrNull(data.companyId),
      companyLabel: stringOrNull(certInfo?.certType),
      companyIcons,
      shopTags,
      factoryCardUrl: null,
      factoryAuthText: certText,
      serviceScores,
    },
    region,
    address: stringOrNull(addr?.entAddress),
    presence: {
      metrics: cardDetailRaw !== null,
      companyIcons:
        businessModelRaw !== null || certInfo !== null,
      shopTags: shopTagsRaw !== null,
      serviceScores: businessTagsRaw !== null,
    },
    paths: {
      badge: Object.hasOwn(data, 'pcV2ShopCardTypeImg')
        ? 'data.data.pcV2ShopCardTypeImg'
        : 'data.data.pcV2SellerTagLogo',
      companyIcons:
        businessModelIcons.length > 0 ||
        (companyIcons.length === 0 && businessModelRaw !== null)
          ? 'data.data.businessModelList'
          : 'data.data.certInfo',
      returnRate: Object.hasOwn(data, 'byrRepeatRateText')
        ? 'data.data.byrRepeatRateText'
        : 'data.data.cardDetail[code=byrRepeatRate]',
      onTimeDeliveryRate: Object.hasOwn(data, 'lgtFulfillGotRateText')
        ? 'data.data.lgtFulfillGotRateText'
        : 'data.data.cardDetail[code=lgtFulfillGotRate]',
    },
  };
}

const COMMON_HEADER_FIELDS = [
  'companyName',
  'commonUrl',
  'cardDetail',
  'addr',
  'mainCate',
  'fans',
  'companyId',
] as const;

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function percentRatio(value: unknown, unit?: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null) return null;
  const text = stringOrNull(value) ?? '';
  const unitText = stringOrNull(unit) ?? '';
  return text.includes('%') || unitText.includes('%')
    ? number / 100
    : null;
}

function booleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return null;
}

function normalizeUrl(value: string | null): string | null {
  if (value?.startsWith('//')) return `https:${value}`;
  return value;
}

function joinText(
  values: Array<string | null>,
  separator: string,
): string | null {
  const collected = values.filter((value): value is string => value !== null);
  return collected.length > 0 ? collected.join(separator) : null;
}

function joinDistinctText(values: Array<string | null>): string | null {
  return joinText([...new Set(values.filter(
    (value): value is string => value !== null,
  ))], ' ');
}

function normalizeStoreProfileWarnings(value: unknown): StoreProfileWarning[] {
  if (!Array.isArray(value)) {
    invalidStoreProfile('StoreProfileSnapshot.warnings must be an array.');
  }
  return value.map((entry, index) => {
    const warning = record(entry);
    if (warning === null) {
      invalidStoreProfile(
        `StoreProfileSnapshot.warnings[${index}] must be an object.`,
      );
    }
    const code = storeProfileString(
      warning.code,
      `StoreProfileSnapshot.warnings[${index}].code`,
    );
    const message = storeProfileString(
      warning.message,
      `StoreProfileSnapshot.warnings[${index}].message`,
    );
    const fieldPath =
      warning.fieldPath === undefined
        ? undefined
        : storeProfileString(
            warning.fieldPath,
            `StoreProfileSnapshot.warnings[${index}].fieldPath`,
          );
    return {
      code,
      message,
      ...(fieldPath === undefined ? {} : { fieldPath }),
    };
  });
}

function normalizeStoreProfileEvidence<T>(
  value: unknown,
  source: EvidenceSource,
): Evidence<T> {
  const evidence = normalizeEvidence<T>(value);
  return normalizeEvidence<T>({
    ...evidence,
    source: {
      ...source,
      fieldPath: evidence.source.fieldPath,
    },
  });
}

function storeProfileString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidStoreProfile(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function invalidStoreProfile(message: string): never {
  throw new CliError(2, 'BAD_INPUT', message, {
    category: 'collection-contract',
  });
}
