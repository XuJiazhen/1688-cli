import { CliError } from '../io/errors.js';
import type { Offer } from '../session/search-mtop.js';
import type { OfferResult, PriceTier } from './offer.js';

export type SearchSort = 'relevance' | 'best-selling' | 'price-asc' | 'price-desc';
export type VerifiedFilter = 'any' | 'factory' | 'business' | 'super-factory';

export interface SearchFilterInput {
  priceMin?: number | null;
  priceMax?: number | null;
  province?: string | null;
  city?: string | null;
  verified?: VerifiedFilter;
  minTurnover?: number | null;
  excludeAds?: boolean;
}

export interface SearchFilterSummary {
  priceMin: number | null;
  priceMax: number | null;
  province: string | null;
  city: string | null;
  verified: VerifiedFilter;
  minTurnover: number | null;
  excludeAds: boolean;
}

export interface DemandSignals {
  turnoverText: string | null;
  orderCount: number | null;
  repurchaseRateText: string | null;
  repurchaseRate: number | null;
}

export interface ScorePart {
  name: string;
  points: number;
  reason: string;
}

export interface SourcingScore {
  score: number;
  scoreBreakdown: ScorePart[];
}

export interface OfferDetailSummary {
  offerId: string;
  title: string;
  url: string;
  priceMin: number | null;
  priceMax: number | null;
  unitName: string | null;
  minOrderQty: number | null;
  mixOrderQty: number | null;
  priceTiers: PriceTier[];
  saledCount: number | null;
  categoryId: string | null;
  supplier: OfferResult['supplier'];
  skuCount: number;
  totalStock: number | null;
  stockKnown: boolean;
  packageCount: number;
  freight: OfferResult['freight'];
  mainImage: string | null;
}

export interface ResearchItem {
  sourceKeyword: string;
  sourceRank: number;
  globalRank: number;
  offer: Offer;
  demand: DemandSignals;
  supplier: {
    years: number | null;
    verified: Offer['verified'];
    tags: string[];
    isAd: boolean;
  };
  score: number;
  scoreBreakdown: ScorePart[];
  enriched?: OfferDetailSummary;
  error?: { code: string; message: string };
}

export interface CompareItem {
  offerId: string;
  ok: boolean;
  score: number | null;
  scoreBreakdown: ScorePart[];
  summary: OfferDetailSummary | null;
  error?: { code: string; message: string };
}

export function normalizeSearchSort(raw: string | undefined): SearchSort {
  const value = (raw ?? 'relevance').trim();
  if (
    value === 'relevance' ||
    value === 'best-selling' ||
    value === 'price-asc' ||
    value === 'price-desc'
  ) {
    return value;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    `Invalid --sort: ${value}. Use relevance | best-selling | price-asc | price-desc.`,
  );
}

export function normalizeVerifiedFilter(raw: string | undefined): VerifiedFilter {
  const value = (raw ?? 'any').trim();
  if (
    value === 'any' ||
    value === 'factory' ||
    value === 'business' ||
    value === 'super-factory'
  ) {
    return value;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    `Invalid --verified: ${value}. Use any | factory | business | super-factory.`,
  );
}

export function parseOptionalNumber(
  raw: string | undefined,
  flag: string,
): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliError(2, 'BAD_INPUT', `Invalid ${flag}: ${raw}`);
  }
  return n;
}

export function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  fallback: number,
  cap?: number,
): number {
  const value = raw ?? String(fallback);
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(2, 'BAD_INPUT', `${flag} must be a positive integer.`);
  }
  return cap ? Math.min(n, cap) : n;
}

export function normalizeFilters(input: SearchFilterInput): SearchFilterSummary {
  const priceMin = input.priceMin ?? null;
  const priceMax = input.priceMax ?? null;
  if (priceMin !== null && priceMin < 0) {
    throw new CliError(2, 'BAD_INPUT', '--price-min must be >= 0.');
  }
  if (priceMax !== null && priceMax < 0) {
    throw new CliError(2, 'BAD_INPUT', '--price-max must be >= 0.');
  }
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    throw new CliError(2, 'BAD_INPUT', '--price-min cannot exceed --price-max.');
  }
  const minTurnover = input.minTurnover ?? null;
  if (minTurnover !== null && minTurnover < 0) {
    throw new CliError(2, 'BAD_INPUT', '--min-turnover must be >= 0.');
  }
  return {
    priceMin,
    priceMax,
    province: input.province?.trim() || null,
    city: input.city?.trim() || null,
    verified: input.verified ?? 'any',
    minTurnover,
    excludeAds: input.excludeAds === true,
  };
}

export function hasActiveFilters(filters: SearchFilterSummary): boolean {
  return (
    filters.priceMin !== null ||
    filters.priceMax !== null ||
    filters.province !== null ||
    filters.city !== null ||
    filters.verified !== 'any' ||
    filters.minTurnover !== null ||
    filters.excludeAds
  );
}

export function applySearchControls(
  offers: Offer[],
  sort: SearchSort,
  filters: SearchFilterSummary,
): Offer[] {
  const filtered = offers.filter((offer) => offerMatchesFilters(offer, filters));
  return sortOffers(filtered, sort);
}

export function offerMatchesFilters(
  offer: Offer,
  filters: SearchFilterSummary,
): boolean {
  const price = offer.price.min ?? offer.price.max;
  if (filters.priceMin !== null && (price === null || price < filters.priceMin)) {
    return false;
  }
  if (filters.priceMax !== null && (price === null || price > filters.priceMax)) {
    return false;
  }
  if (
    filters.province &&
    !includesNormalized(offer.location.province, filters.province)
  ) {
    return false;
  }
  if (filters.city && !includesNormalized(offer.location.city, filters.city)) {
    return false;
  }
  if (filters.excludeAds && offer.isP4P) return false;
  if (filters.verified === 'factory' && !offer.verified.factory) return false;
  if (filters.verified === 'business' && !offer.verified.business) return false;
  if (filters.verified === 'super-factory' && !offer.verified.superFactory) {
    return false;
  }
  if (filters.minTurnover !== null) {
    const demand = demandSignals(offer);
    if (demand.orderCount === null || demand.orderCount < filters.minTurnover) {
      return false;
    }
  }
  return true;
}

export function sortOffers(offers: Offer[], sort: SearchSort): Offer[] {
  if (sort === 'relevance') return [...offers];
  return [...offers].sort((a, b) => {
    if (sort === 'price-asc') {
      return nullableNumberLast(a.price.min) - nullableNumberLast(b.price.min);
    }
    if (sort === 'price-desc') {
      return nullableNumberLastDesc(b.price.min) - nullableNumberLastDesc(a.price.min);
    }
    const bd = demandSignals(b).orderCount ?? -1;
    const ad = demandSignals(a).orderCount ?? -1;
    if (bd !== ad) return bd - ad;
    return scoreOffer(b).score - scoreOffer(a).score;
  });
}

export function demandSignals(offer: Offer): DemandSignals {
  const repurchaseText =
    offer.demand?.repurchaseRateText ??
    findPercentText([...(offer.serviceTags ?? []), ...offer.tags]);
  return {
    turnoverText: offer.turnover ?? offer.demand?.orderCountText ?? null,
    orderCount:
      offer.demand?.orderCount ??
      parseCountText(offer.turnover ?? offer.demand?.orderCountText ?? null),
    repurchaseRateText: repurchaseText,
    repurchaseRate:
      offer.demand?.repurchaseRate ?? parsePercentText(repurchaseText),
  };
}

export function parseCountText(text: string | null | undefined): number | null {
  if (!text) return null;
  const compact = text.replace(/,/g, '').replace(/\s+/g, '');
  const match = compact.match(/(\d+(?:\.\d+)?)(万|w|W|亿|k|K)?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ?? '';
  const multiplier =
    unit === '亿'
      ? 100000000
      : unit === '万' || unit === 'w' || unit === 'W'
      ? 10000
      : unit === 'k' || unit === 'K'
      ? 1000
      : 1;
  return Math.round(value * multiplier);
}

export function parsePercentText(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export function scoreOffer(offer: Offer): SourcingScore {
  const demand = demandSignals(offer);
  const parts: ScorePart[] = [];
  const price = offer.price.min;
  let pricePoints = 0;
  if (price !== null) {
    pricePoints = price <= 5 ? 25 : price <= 20 ? 22 : price <= 50 ? 18 : price <= 100 ? 12 : price <= 200 ? 8 : 4;
  }
  parts.push({
    name: 'price',
    points: pricePoints,
    reason: price === null ? 'no price' : `min price ${price}`,
  });

  const orderCount = demand.orderCount ?? 0;
  const demandPoints =
    orderCount >= 10000
      ? 25
      : orderCount >= 1000
      ? 20
      : orderCount >= 100
      ? 15
      : orderCount >= 10
      ? 8
      : orderCount > 0
      ? 4
      : 0;
  parts.push({
    name: 'demand',
    points: demandPoints,
    reason: demand.turnoverText ?? 'no turnover',
  });

  const years = offer.supplier.years ?? 0;
  const tenurePoints = Math.min(15, years * 3);
  parts.push({
    name: 'supplier-tenure',
    points: tenurePoints,
    reason: years > 0 ? `${years} years` : 'no tenure',
  });

  const verifiedPoints = offer.verified.superFactory
    ? 15
    : offer.verified.factory
    ? 10
    : offer.verified.business
    ? 8
    : 0;
  parts.push({
    name: 'verification',
    points: verifiedPoints,
    reason: verificationLabel(offer.verified),
  });

  const tags = [...new Set([...(offer.serviceTags ?? []), ...offer.tags])];
  const servicePoints = Math.min(10, tags.length * 2);
  parts.push({
    name: 'service-tags',
    points: servicePoints,
    reason: tags.length ? tags.join(', ') : 'no tags',
  });

  parts.push({
    name: 'organic',
    points: offer.isP4P ? 0 : 10,
    reason: offer.isP4P ? 'ad result' : 'organic result',
  });

  return {
    score: Math.min(100, Math.round(parts.reduce((sum, p) => sum + p.points, 0))),
    scoreBreakdown: parts,
  };
}

export function detailSummary(detail: OfferResult): OfferDetailSummary {
  const knownStocks = detail.skus
    .map((sku) => sku.stock)
    .filter((stock): stock is number => stock !== null);
  return {
    offerId: detail.offerId,
    title: detail.title,
    url: detail.url,
    priceMin: detail.priceMin,
    priceMax: detail.priceMax,
    unitName: detail.unitName,
    minOrderQty: detail.minOrderQty,
    mixOrderQty: detail.mixOrderQty,
    priceTiers: detail.priceTiers,
    saledCount: detail.saledCount,
    categoryId: detail.categoryId,
    supplier: detail.supplier,
    skuCount: detail.skus.length,
    totalStock:
      knownStocks.length > 0
        ? knownStocks.reduce((sum, stock) => sum + stock, 0)
        : null,
    stockKnown: knownStocks.length > 0,
    packageCount: detail.packageInfo.length,
    freight: detail.freight,
    mainImage: detail.mainImage,
  };
}

export function scoreDetail(detail: OfferResult): SourcingScore {
  const pseudoOffer: Offer = {
    offerId: detail.offerId,
    title: detail.title,
    price: {
      text: detail.priceRange ?? '',
      min: detail.priceMin,
      max: detail.priceMax,
    },
    purchase: {
      priceTiers: detail.priceTiers.map((tier) => ({
        quantityText: String(tier.minQty),
        minimumQuantity: tier.minQty,
        price: tier.price,
      })),
      minimumQuantity: detail.minOrderQty,
      onePieceEligible:
        detail.minOrderQty === null ? null : detail.minOrderQty <= 1,
    },
    supplier: {
      name: detail.supplier.name,
      loginId: detail.supplier.loginId,
      memberId: detail.supplier.memberId,
      shopUrl: null,
      years: null,
      badgeImageUrl: detail.shopCard?.badge?.imageUrl ?? null,
      tradeService: {
        compositeScore: null,
        consultationScore: null,
        logisticsScore: null,
        disputeScore: null,
        returnScore: null,
        goodsScore: null,
        inspectionCreditUrl: null,
        sameDesignUrl: null,
      },
    },
    location: {
      province: detail.freight.province,
      city: detail.freight.city,
    },
    bizType: null,
    verified: { factory: false, business: false, superFactory: false },
    tags: [],
    isP4P: false,
    turnover: detail.saledCount !== null ? String(detail.saledCount) : null,
    url: detail.url,
    image: detail.mainImage,
    images: detail.images,
  };
  const scored = scoreOffer(pseudoOffer);
  const skuPoints = detail.skus.length >= 20 ? 5 : detail.skus.length >= 5 ? 3 : detail.skus.length > 0 ? 1 : 0;
  scored.scoreBreakdown.push({
    name: 'sku-depth',
    points: skuPoints,
    reason: `${detail.skus.length} skus`,
  });
  scored.score = Math.min(100, scored.score + skuPoints);
  return scored;
}

export function makeResearchItem(input: {
  sourceKeyword: string;
  sourceRank: number;
  globalRank: number;
  offer: Offer;
}): ResearchItem {
  const scored = scoreOffer(input.offer);
  return {
    sourceKeyword: input.sourceKeyword,
    sourceRank: input.sourceRank,
    globalRank: input.globalRank,
    offer: input.offer,
    demand: demandSignals(input.offer),
    supplier: {
      years: input.offer.supplier.years,
      verified: input.offer.verified,
      tags: [...new Set([...(input.offer.serviceTags ?? []), ...input.offer.tags])],
      isAd: input.offer.isP4P,
    },
    score: scored.score,
    scoreBreakdown: scored.scoreBreakdown,
  };
}

export function parseEnrichTop(raw: string | undefined): number {
  if (!raw || raw === '0' || raw === 'none') return 0;
  const normalized = raw.startsWith('top:') ? raw.slice(4) : raw;
  const n = parseInt(normalized, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(2, 'BAD_INPUT', `Invalid --enrich: ${raw}. Use top:N, N, 0, or none.`);
  }
  return Math.min(n, 50);
}

export function researchItemsToJsonl(items: ResearchItem[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

export function researchItemsToCsv(items: ResearchItem[]): string {
  const header = [
    'globalRank',
    'score',
    'sourceKeyword',
    'sourceRank',
    'offerId',
    'title',
    'priceMin',
    'turnover',
    'supplierName',
    'supplierYears',
    'verified',
    'tags',
    'isAd',
    'url',
    'enrichedPriceMin',
    'minOrderQty',
    'saledCount',
    'skuCount',
    'errorCode',
  ];
  const rows = items.map((item) => [
    item.globalRank,
    item.score,
    item.sourceKeyword,
    item.sourceRank,
    item.offer.offerId,
    item.offer.title,
    item.offer.price.min ?? '',
    item.demand.turnoverText ?? '',
    item.offer.supplier.name ?? '',
    item.offer.supplier.years ?? '',
    verificationLabel(item.offer.verified),
    item.supplier.tags.join('|'),
    item.offer.isP4P ? 'true' : 'false',
    item.offer.url,
    item.enriched?.priceMin ?? '',
    item.enriched?.minOrderQty ?? '',
    item.enriched?.saledCount ?? '',
    item.enriched?.skuCount ?? '',
    item.error?.code ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function compareItemsToCsv(items: CompareItem[]): string {
  const header = [
    'offerId',
    'ok',
    'score',
    'title',
    'priceMin',
    'minOrderQty',
    'saledCount',
    'skuCount',
    'supplierName',
    'errorCode',
  ];
  const rows = items.map((item) => [
    item.offerId,
    item.ok ? 'true' : 'false',
    item.score ?? '',
    item.summary?.title ?? '',
    item.summary?.priceMin ?? '',
    item.summary?.minOrderQty ?? '',
    item.summary?.saledCount ?? '',
    item.summary?.skuCount ?? '',
    item.summary?.supplier.name ?? '',
    item.error?.code ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function errorInfo(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; message?: unknown };
    return {
      code: typeof rec.code === 'string' ? rec.code : 'ERROR',
      message: typeof rec.message === 'string' ? rec.message : String(error),
    };
  }
  return { code: 'ERROR', message: String(error) };
}

function includesNormalized(value: string | null, needle: string): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().includes(needle.trim().toLowerCase());
}

function nullableNumberLast(n: number | null): number {
  return n === null ? Number.POSITIVE_INFINITY : n;
}

function nullableNumberLastDesc(n: number | null): number {
  return n === null ? Number.NEGATIVE_INFINITY : n;
}

function findPercentText(values: string[]): string | null {
  return values.find((value) => /\d+(?:\.\d+)?\s*%/.test(value)) ?? null;
}

function verificationLabel(verified: Offer['verified']): string {
  if (verified.superFactory) return 'super-factory';
  if (verified.factory) return 'factory';
  if (verified.business) return 'business';
  return 'none';
}

function csvCell(value: unknown): string {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
