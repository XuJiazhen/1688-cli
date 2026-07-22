export interface SupplierServiceScore {
  key: string;
  label: string;
  score: number | null;
}

export interface ShopCardMetric {
  key: string;
  valueText: string | null;
  value: number | null;
  unit: string | null;
}

export interface ShopCardInfo {
  name: string | null;
  url: string | null;
  shopType: string | null;
  iconType: string | null;
  badge: {
    code: string;
    label: string | null;
    imageUrl: string | null;
  } | null;
  mainCategoryName: string | null;
  years: number | null;
  attention: {
    isFollowing: boolean | null;
    followersText: string | null;
    operationType: string | null;
  };
  metrics: ShopCardMetric[];
  /** Decimal ratio in the range 0..1. */
  returnRate: number | null;
  serviceScore: number | null;
  /** Decimal ratio in the range 0..1. */
  onTimeDeliveryRate: number | null;
  /** Decimal ratio in the range 0..1. */
  positiveReviewRate: number | null;
  companyId: string | null;
  companyLabel: string | null;
  companyIcons: Array<{ title: string; link: string | null }>;
  shopTags: string[];
  factoryCardUrl: string | null;
  factoryAuthText: string | null;
  serviceScores: SupplierServiceScore[];
}

export interface ConsignmentMetric {
  key: string;
  name: string | null;
  valueText: string | null;
}

export interface ConsignmentPrice {
  text: string | null;
  price: number | null;
  minimumQuantity: number | null;
}

export interface ConsignmentOperation {
  name: string | null;
  operationType: string | null;
  displayStatus: string | null;
  buttonType: string | null;
  displayType: string | null;
  imageUrl: string | null;
  backgroundColor: string | null;
}

export interface ConsignmentProtection {
  serviceName: string | null;
  description: string | null;
  actions: Array<{
    text: string | null;
    url: string | null;
    appUrl: string | null;
  }>;
}

export interface ConsignmentInfo {
  name: string | null;
  /** Boolean page-model flags observed in the request that loaded this card. */
  offerFlags: Record<string, boolean>;
  metrics: ConsignmentMetric[];
  orderCount30dText: string | null;
  orderCount7dText: string | null;
  /** Decimal ratio in the range 0..1. */
  delivery24hRate: number | null;
  /** Decimal ratio in the range 0..1. */
  delivery48hRate: number | null;
  downstreamListingCountText: string | null;
  distributorCountText: string | null;
  offerPublishedAtText: string | null;
  prices: ConsignmentPrice[];
  minimumQuantity: number | null;
  onePieceEligible: boolean | null;
  onePiecePrice: number | null;
  operations: ConsignmentOperation[];
  protections: ConsignmentProtection[];
  supportedChannels: Array<{ name: string | null; iconUrl: string | null }>;
}

const SHOP_BADGES: Record<string, { label: string; imageUrl: string }> = {
  cjgc_global: {
    label: '超级工厂全球供',
    imageUrl:
      'https://img.alicdn.com/imgextra/i4/O1CN014ntq3r24nkFVzJqfW_!!6000000007436-55-tps-106-16.svg',
  },
  slsj: {
    label: '实力商家',
    imageUrl:
      'https://img.alicdn.com/imgextra/i2/O1CN01OBjMFF1f96iPN27qq_!!6000000003963-55-tps-78-20.svg',
  },
  ytqj: {
    label: '源头旗舰',
    imageUrl:
      'https://img.alicdn.com/imgextra/i1/O1CN01Ev234b26zJUUSp7eQ_!!6000000007732-55-tps-84-20.svg',
  },
};

export function mapShopCardPayload(payload: unknown): ShopCardInfo | null {
  const data = objectAt(payload, ['data']);
  if (!data) return null;
  const model = objectAt(data, ['model']);
  if (model) return mapModernShopCard(model);
  return mapLegacyShopCard(data);
}

function mapModernShopCard(model: Record<string, unknown>): ShopCardInfo | null {
  const metrics = arrayAt(model, ['shopData'])
    .map((raw) => {
      const item = recordOrNull(raw);
      if (!item) return null;
      const key = stringOrNull(item.dataKey);
      if (!key) return null;
      const valueText = stringOrNull(item.dataValue);
      return {
        key,
        valueText,
        value: numberOrNull(valueText),
        unit: stringOrNull(item.unit),
      } satisfies ShopCardMetric;
    })
    .filter((item): item is ShopCardMetric => item !== null);
  const metric = (key: string) => metrics.find((item) => item.key === key);
  const iconType = stringOrNull(model.iconType);
  const knownBadge = iconType ? SHOP_BADGES[iconType] : undefined;
  const shopButton = objectAt(model, ['shopButton']);
  const serviceScore = metric('店铺服务分')?.value ?? null;
  const badge = iconType
    ? {
        code: iconType,
        label: knownBadge?.label ?? null,
        imageUrl: knownBadge?.imageUrl ?? null,
      }
    : null;
  const info: ShopCardInfo = {
    name: stringOrNull(model.shopName),
    url: normalizeUrl(stringOrNull(model.shopUrl)),
    shopType: stringOrNull(model.shopType),
    iconType,
    badge,
    mainCategoryName: stringOrNull(model.mainCategoryName),
    years: parseInteger(model.tpYear),
    attention: {
      isFollowing: booleanOrNull(shopButton?.attentionRelation),
      followersText: stringOrNull(shopButton?.fuzzyFavCount),
      operationType: stringOrNull(shopButton?.type),
    },
    metrics,
    returnRate: percentRatio(metric('店铺回头率')?.valueText),
    serviceScore,
    onTimeDeliveryRate: percentRatio(metric('准时发货率')?.valueText),
    positiveReviewRate: percentRatio(metric('店铺好评率')?.valueText),
    companyId: null,
    companyLabel: badge?.label ?? null,
    companyIcons: badge?.imageUrl
      ? [{ title: badge.label ?? badge.code, link: badge.imageUrl }]
      : [],
    shopTags: [],
    factoryCardUrl: null,
    factoryAuthText: null,
    serviceScores:
      serviceScore === null
        ? []
        : [{ key: 'shop_service_score', label: 'shop', score: serviceScore }],
  };
  return hasShopCardEvidence(info) ? info : null;
}

function mapLegacyShopCard(data: Record<string, unknown>): ShopCardInfo | null {
  const factoryInfo = objectAt(data, ['factoryInfo']);
  const shopProperty = objectAt(factoryInfo, ['shopProperty']);
  const appData = objectAt(data, ['appData']);
  const lindormData = objectAt(data, ['lindormDataModel']);
  const appServices = arrayAt(appData, ['serviceList']);
  const serviceRaw = appServices.length
    ? appServices
    : arrayAt(lindormData, ['serviceStarList']);
  const serviceScores = serviceRaw
    .map(mapServiceScore)
    .filter((score) => score.key);
  const companyLabel = stringOrNull(data.companyLabel);
  const info: ShopCardInfo = {
    name: stringOrNull(data.companyName),
    url: normalizeUrl(stringOrNull(data.shopUrl)),
    shopType: null,
    iconType: null,
    badge: companyLabel
      ? { code: companyLabel, label: companyLabel, imageUrl: null }
      : null,
    mainCategoryName: null,
    years: null,
    attention: {
      isFollowing: null,
      followersText: null,
      operationType: null,
    },
    metrics: [],
    returnRate:
      percentRatio(data.retentionRate) ?? numberOrNull(data.retentionRate),
    serviceScore: null,
    onTimeDeliveryRate: null,
    positiveReviewRate: null,
    companyId: stringOrNull(data.companyId),
    companyLabel,
    companyIcons: arrayAt(data, ['companyIcons'])
      .map((raw) => {
        const item = recordOrNull(raw);
        return {
          title: stringOrNull(item?.title) ?? '',
          link: normalizeUrl(stringOrNull(item?.link)),
        };
      })
      .filter((item) => item.title),
    shopTags: arrayAt(factoryInfo, ['shopTag'])
      .map((raw) => stringOrNull(recordOrNull(raw)?.text))
      .filter((text): text is string => text !== null),
    factoryCardUrl: normalizeUrl(
      stringOrNull(shopProperty?.pcLinkUrl) ??
        stringOrNull(shopProperty?.linkUrl),
    ),
    factoryAuthText: stringOrNull(shopProperty?.authText),
    serviceScores,
  };
  return hasShopCardEvidence(info) ? info : null;
}

export function mapConsignmentPayload(
  payload: unknown,
  requestUrl?: string,
): ConsignmentInfo | null {
  const candidates = [
    objectAt(payload, ['data', 'data', 'data', 'data']),
    objectAt(payload, ['data', 'data', 'data']),
  ];
  const data = candidates.find(
    (candidate) =>
      candidate &&
      (stringOrNull(candidate.name) ||
        arrayAt(candidate, ['adviseList']).length > 0 ||
        arrayAt(candidate, ['priceInfoList']).length > 0 ||
        arrayAt(candidate, ['operateButtonList']).length > 0 ||
        arrayAt(candidate, ['protectionInfoList']).length > 0 ||
        arrayAt(candidate, ['supportList']).length > 0),
  );
  if (!data) return null;
  const metrics = arrayAt(data, ['adviseList'])
    .map((raw) => {
      const item = recordOrNull(raw);
      const key = stringOrNull(item?.key);
      if (!key) return null;
      return {
        key,
        name: stringOrNull(item?.name),
        valueText: stringOrNull(item?.value),
      } satisfies ConsignmentMetric;
    })
    .filter((item): item is ConsignmentMetric => item !== null);
  const metricText = (key: string) =>
    metrics.find((item) => item.key === key)?.valueText ?? null;
  const prices = arrayAt(data, ['priceInfoList']).map((raw) => {
    const item = recordOrNull(raw);
    const text = stringOrNull(item?.text);
    return {
      text,
      price: numberOrNull(item?.price),
      minimumQuantity: parseMinimumQuantity(text),
    } satisfies ConsignmentPrice;
  });
  const quantities = prices
    .map((item) => item.minimumQuantity)
    .filter((value): value is number => value !== null);
  const minimumQuantity = quantities.length ? Math.min(...quantities) : null;
  const onePiecePrice =
    prices.find((item) => item.minimumQuantity === 1)?.price ?? null;
  const operations = arrayAt(data, ['operateButtonList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      name: stringOrNull(item?.name),
      operationType: stringOrNull(item?.operateType),
      displayStatus: stringOrNull(item?.operateDisplayStatus),
      buttonType: stringOrNull(item?.buttonType),
      displayType: stringOrNull(item?.disType),
      imageUrl: normalizeUrl(stringOrNull(item?.imgUrl)),
      backgroundColor: stringOrNull(item?.backgroundColor),
    } satisfies ConsignmentOperation;
  });
  const protections = arrayAt(data, ['protectionInfoList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      serviceName: stringOrNull(item?.serviceName),
      description: stringOrNull(item?.description),
      actions: arrayAt(item, ['actions']).map((actionRaw) => {
        const action = recordOrNull(actionRaw);
        return {
          text: stringOrNull(action?.text),
          url: normalizeUrl(stringOrNull(action?.url)),
          appUrl: normalizeUrl(stringOrNull(action?.appUrl)),
        };
      }),
    } satisfies ConsignmentProtection;
  });
  const supportedChannels = arrayAt(data, ['supportList']).map((raw) => {
    const item = recordOrNull(raw);
    return {
      name: stringOrNull(item?.name),
      iconUrl: normalizeUrl(stringOrNull(item?.icon)),
    };
  });
  const name = stringOrNull(data.name);
  if (
    !name &&
    metrics.length === 0 &&
    prices.length === 0 &&
    operations.length === 0 &&
    protections.length === 0 &&
    supportedChannels.length === 0
  ) {
    return null;
  }
  return {
    name,
    offerFlags: parseOfferModelSignFromUrl(requestUrl),
    metrics,
    orderCount30dText: metricText('orderCnt30d'),
    orderCount7dText: metricText('orderCnt7d'),
    delivery24hRate: percentRatio(metricText('offerDelivery24hRate')),
    delivery48hRate: percentRatio(metricText('offerDelivery48hRate')),
    downstreamListingCountText: metricText('outDistributeCnt'),
    distributorCountText: metricText('distributorCnt'),
    offerPublishedAtText: metricText('offerPublishDate'),
    prices,
    minimumQuantity,
    onePieceEligible:
      minimumQuantity === null ? null : minimumQuantity <= 1,
    onePiecePrice,
    operations,
    protections,
    supportedChannels,
  };
}

export function parseOfferModelSignFromUrl(
  requestUrl: string | undefined,
): Record<string, boolean> {
  if (!requestUrl) return {};
  try {
    const dataText = new URL(requestUrl).searchParams.get('data');
    if (!dataText) return {};
    const data = JSON.parse(dataText) as {
      mmgaRequest?: { offerModelSign?: Record<string, unknown> };
    };
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(
      data.mmgaRequest?.offerModelSign ?? {},
    )) {
      if (typeof value === 'boolean') flags[key] = value;
    }
    return flags;
  } catch {
    return {};
  }
}

function hasShopCardEvidence(info: ShopCardInfo): boolean {
  return !!(
    info.name ||
    info.url ||
    info.companyId ||
    info.companyLabel ||
    info.mainCategoryName ||
    info.metrics.length ||
    info.companyIcons.length ||
    info.shopTags.length ||
    info.factoryCardUrl ||
    info.serviceScores.length
  );
}

function mapServiceScore(raw: unknown): SupplierServiceScore {
  const item = recordOrNull(raw);
  const key = stringOrNull(item?.serviceKey) ?? '';
  return {
    key,
    label: serviceScoreLabel(key),
    score: numberOrNull(item?.score),
  };
}

function serviceScoreLabel(key: string): string {
  const labels: Record<string, string> = {
    cst_group_value_new: 'response',
    lgt_group_value_new: 'logistics',
    dspt_group_value: 'dispute',
    goods_group_value: 'goods',
    rdf_group_value_new: 'repurchase',
  };
  return labels[key] ?? key;
}

function parseMinimumQuantity(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(?:>=|>|\u2265)?\s*(\d+)\s*\u4ef6/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

function percentRatio(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number / 100 : null;
}

function objectAt(
  value: unknown,
  path: string[],
): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return recordOrNull(current);
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  const parent = path.length ? objectAt(value, path.slice(0, -1)) : value;
  const key = path.at(-1);
  const result =
    key && parent && typeof parent === 'object'
      ? (parent as Record<string, unknown>)[key]
      : parent;
  return Array.isArray(result) ? result : [];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = stringOrNull(value);
  if (!text) return null;
  const number = Number(text.replace(/,/g, '').replace('%', ''));
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const match = text.match(/\d+/);
  return match?.[0] ? parseInt(match[0], 10) : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}
