import { createHash } from 'node:crypto';
import type { EvidenceSource } from '../collection/contracts.js';
import { redactUrlForDiagnostics } from './redaction.js';

export const OFFER_MEDIA_PARSER_VERSION = '1' as const;
export const OFFER_MEDIA_V2_PARSER_VERSION = 'offer-media-v2@1' as const;

export type MediaRoleV2 =
  | 'main'
  | 'gallery'
  | 'sku'
  | 'detail'
  | 'qualification';

export type SourceMediaOwnerV2 =
  | { ownerKind: 'target-offer'; offerId: string }
  | {
      ownerKind: 'target-sku';
      offerId: string;
      platformSkuId: string;
      singletonSourceKey?: never;
    }
  | {
      ownerKind: 'target-sku';
      offerId: string;
      platformSkuId: null;
      singletonSourceKey: string;
    }
  | {
      ownerKind: 'store-catalog-offer';
      catalogOfferId: string;
      catalogPage: number;
      catalogRank: number;
    }
  | { ownerKind: 'store-qualification'; memberId: string };

export interface SourceMediaReferenceV2 {
  role: MediaRoleV2;
  ownerKind: SourceMediaOwnerV2['ownerKind'];
  sourceOwnerKey: string;
  offerId?: string;
  platformSkuId?: string | null;
  singletonSourceKey?: string;
  catalogOfferId?: string;
  memberId?: string;
  order: number;
  sourceOrdinal: number;
  catalogPage?: number;
  catalogRank?: number;
  originalUrl: string;
  normalizedUrl: string;
  sourceField: string;
  sourceObservationId: string;
  sourceReceiptContentSha256: string;
  availability: 'available';
}

export interface MediaUrlNormalizationV2 {
  originalUrl: string;
  normalizedUrl: string | null;
  warningCode: 'MEDIA_URL_INVALID' | 'MEDIA_URL_HOST_UNRECOGNIZED' | null;
}

export interface OfferMediaManifestV2 {
  schema: 'offer-media-manifest-v2';
  offerId: string;
  sourceObservationId: string;
  availability: 'available' | 'not-present' | 'failed';
  items: SourceMediaReferenceV2[];
  itemSetHash: string;
  warnings: Array<{ code: string; sourceField: string; sourceOrdinal: number }>;
}

export function buildOfferMediaManifestV2(input: {
  offerId: string;
  sourceObservationId: string;
  sourcePayloadContentSha256: string;
  mainImage: string | null;
  galleryImages: string[];
  skus: Array<{ platformSkuId: string | null; image: string | null }>;
  explicitSingleSkuWithoutPlatformId: boolean;
  detailImages: string[];
  detailSourceState: 'available' | 'not-present' | 'failed';
}): OfferMediaManifestV2 {
  requireStableId(input.offerId, 'offerId');
  if (
    input.skus.some((sku) => sku.platformSkuId === null) &&
    !(input.explicitSingleSkuWithoutPlatformId && input.skus.length === 1)
  ) {
    throw new TypeError('Variant SKU without platformSkuId cannot be downgraded to a singleton owner.');
  }
  const items: SourceMediaReferenceV2[] = [];
  const warnings: OfferMediaManifestV2['warnings'] = [];
  const add = (
    role: MediaRoleV2,
    owner: SourceMediaOwnerV2,
    originalUrl: string | null,
    order: number,
    sourceOrdinal: number,
    sourceField: string,
  ) => {
    if (!originalUrl) return;
    const created = createSourceMediaReferenceV2({
      role, owner, originalUrl, order, sourceOrdinal, sourceField,
      sourceObservationId: input.sourceObservationId,
      sourcePayloadContentSha256: input.sourcePayloadContentSha256,
    });
    if (created.reference) items.push(created.reference);
    if (created.warningCode) warnings.push({
      code: created.warningCode,
      sourceField,
      sourceOrdinal,
    });
  };
  const offerOwner: SourceMediaOwnerV2 = {
    ownerKind: 'target-offer', offerId: input.offerId,
  };
  add('main', offerOwner, input.mainImage, 0, 0, 'gallery.mainImage');
  input.galleryImages.forEach((url, sourceOrdinal) =>
    add('gallery', offerOwner, url, sourceOrdinal, sourceOrdinal, 'gallery.images')
  );
  input.skus.forEach((sku, sourceOrdinal) => {
    const owner: SourceMediaOwnerV2 = sku.platformSkuId === null
      ? {
          ownerKind: 'target-sku', offerId: input.offerId, platformSkuId: null,
          singletonSourceKey: createOfferSingletonSourceKeyV1(input.offerId),
        }
      : {
          ownerKind: 'target-sku', offerId: input.offerId,
          platformSkuId: sku.platformSkuId,
        };
    add('sku', owner, sku.image, sourceOrdinal, sourceOrdinal, 'skuProps.imageUrl');
  });
  input.detailImages.forEach((url, sourceOrdinal) =>
    add('detail', offerOwner, url, sourceOrdinal, sourceOrdinal, 'offer_details.content')
  );
  const invalid = warnings.some((warning) => warning.code === 'MEDIA_URL_INVALID');
  const availability: OfferMediaManifestV2['availability'] =
    input.detailSourceState === 'failed' || invalid
      ? 'failed'
      : items.length === 0
        ? 'not-present'
        : 'available';
  const stableItems = [...items].sort((a, b) =>
    a.role.localeCompare(b.role) || a.order - b.order ||
    sourceMediaOwnershipKeyV2(a).localeCompare(sourceMediaOwnershipKeyV2(b))
  );
  return Object.freeze({
    schema: 'offer-media-manifest-v2',
    offerId: input.offerId,
    sourceObservationId: input.sourceObservationId,
    availability,
    items: Object.freeze(stableItems) as SourceMediaReferenceV2[],
    itemSetHash: `sha256:${digest(stableItems)}`,
    warnings,
  });
}

export interface OfferMediaRef {
  role: 'main' | 'gallery' | 'sku' | 'detail';
  order: number;
  originalUrl: string;
  normalizedUrl: string;
  sourceField: string;
  /** Present for SKU media so downstream storage can preserve ownership. */
  skuId?: string;
}

export interface OfferMediaManifest {
  availability: 'available' | 'not-present' | 'failed';
  items: OfferMediaRef[];
  source: EvidenceSource;
  warnings: Array<{
    code: string;
    message: string;
    order?: number;
    originalUrl?: string;
  }>;
}

export interface OfferDetailsEvidence {
  media: OfferMediaManifest;
  /** Present only when offer_details.content was readable. */
  detailText?: string | null;
}

export function parseOfferDetailsEvidence(
  script: string,
  sourceUrl = 'offer_details.content',
  collectedAt = new Date().toISOString(),
): OfferDetailsEvidence {
  const source: EvidenceSource = {
    sourceType: 'offer-payload',
    fieldPath: 'offer_details.content',
    sourceRef: /^https?:\/\//iu.test(sourceUrl)
      ? redactUrlForDiagnostics(sourceUrl)
      : sourceUrl,
    collectedAt,
    collectorVersion: '1688-cli',
    parserVersion: OFFER_MEDIA_PARSER_VERSION,
  };
  const content = readContentString(script) ?? readDirectHtmlFragment(script);
  if (content === null) {
    return {
      media: {
        availability: 'failed',
        items: [],
        source,
        warnings: [{
          code: 'OFFER_DETAILS_CONTENT_UNREADABLE',
          message: 'offer_details.content was not found or was not a supported string literal.',
        }],
      },
    };
  }

  const items: OfferMediaRef[] = [];
  const warnings: OfferMediaManifest['warnings'] = [];
  const imagePattern = /<img\b[^>]*?\b(?:src|data-src)\s*=\s*(["'])(.*?)\1/giu;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = imagePattern.exec(content))) {
    const originalUrl = decodeHtmlEntities(match[2] ?? '').trim();
    const normalizedUrl = normalizeRemoteMediaUrl(originalUrl);
    if (!normalizedUrl) {
      warnings.push({
        code: 'MEDIA_URL_INVALID',
        message: 'Detail image URL is not a supported HTTP(S) URL.',
        order,
        originalUrl,
      });
      order += 1;
      continue;
    }
    items.push({
      role: 'detail',
      order,
      originalUrl,
      normalizedUrl,
      sourceField: 'offer_details.content',
    });
    order += 1;
  }

  return {
    media: {
      availability: items.length > 0 ? 'available' : 'not-present',
      items,
      source,
      warnings,
    },
    detailText: extractVisibleDetailText(content),
  };
}

export function parseOfferDetailsScript(
  script: string,
  sourceUrl = 'offer_details.content',
  collectedAt = new Date().toISOString(),
): OfferMediaManifest {
  return parseOfferDetailsEvidence(script, sourceUrl, collectedAt).media;
}

export function buildOfferMediaManifest(input: {
  offerId: string;
  mainImage: string | null;
  images: string[];
  skus: Array<{ skuId: string; image: string | null }>;
  detail: OfferMediaManifest | null;
  collectedAt?: string;
}): OfferMediaManifest {
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const source: EvidenceSource = {
    sourceType: 'offer-payload',
    fieldPath: 'offer.media',
    sourceRef: `offer:${input.offerId}:media`,
    collectedAt,
    collectorVersion: '1688-cli',
    parserVersion: OFFER_MEDIA_PARSER_VERSION,
  };
  const items: OfferMediaRef[] = [];
  const seenByRole = new Set<string>();
  const warnings = [...(input.detail?.warnings ?? [])];
  const add = (
    role: OfferMediaRef['role'],
    originalUrl: string | null,
    order: number,
    sourceField: string,
    skuId?: string,
  ) => {
    if (!originalUrl) return;
    const normalizedUrl = normalizeRemoteMediaUrl(originalUrl);
    if (!normalizedUrl) {
      warnings.push({
        code: 'MEDIA_URL_INVALID',
        message: `${role} image URL is not a supported HTTP(S) URL.`,
        order,
        originalUrl,
      });
      return;
    }
    const key = `${role}:${skuId ?? ''}:${normalizedUrl}`;
    if (seenByRole.has(key)) return;
    seenByRole.add(key);
    items.push({
      role,
      order,
      originalUrl,
      normalizedUrl,
      sourceField,
      ...(skuId === undefined ? {} : { skuId }),
    });
  };

  const primary = input.mainImage ?? input.images[0] ?? null;
  add('main', primary, 0, 'gallery.mainImage');
  input.images
    .filter((url) => normalizeRemoteMediaUrl(url) !== normalizeRemoteMediaUrl(primary ?? ''))
    .forEach((url, order) => add('gallery', url, order, 'gallery.images'));
  input.skus.forEach((sku, order) =>
    add('sku', sku.image, order, 'skuProps.imageUrl', sku.skuId)
  );
  items.push(...(input.detail?.items ?? []));

  return {
    availability: items.length > 0 ? 'available' : 'not-present',
    items,
    source,
    warnings,
  };
}

function readContentString(script: string): string | null {
  const key = /(?:["']content["']|\bcontent)\s*:\s*/gu.exec(script);
  if (!key) return null;
  const quote = script[key.index + key[0].length];
  if (quote !== "'" && quote !== '"') return null;
  let output = '';
  for (let index = key.index + key[0].length + 1; index < script.length; index++) {
    const char = script[index];
    if (char === quote) return output;
    if (char !== '\\') {
      output += char;
      continue;
    }
    const escaped = script[++index];
    if (escaped === undefined) return null;
    if (escaped === 'n') output += '\n';
    else if (escaped === 'r') output += '\r';
    else if (escaped === 't') output += '\t';
    else if (escaped === 'b') output += '\b';
    else if (escaped === 'f') output += '\f';
    else if (escaped === 'v') output += '\v';
    else if (escaped === '\n') continue;
    else if (escaped === 'x' || escaped === 'u') {
      const length = escaped === 'x' ? 2 : 4;
      const hex = script.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return null;
      output += String.fromCharCode(parseInt(hex, 16));
      index += length;
    } else output += escaped;
  }
  return null;
}

function readDirectHtmlFragment(payload: string): string | null {
  const fragment = payload.trim();
  if (
    !fragment.startsWith('<')
    || !fragment.endsWith('>')
    || /<(?:!doctype|html|head|body)\b/iu.test(fragment)
    || !/<(?:div|p|span|section|article|table|tbody|tr|td|ul|ol|li|h[1-6]|img|video|br)\b/iu.test(fragment)
  ) {
    return null;
  }
  return fragment;
}

export function normalize1688MediaUrlV2(value: string): MediaUrlNormalizationV2 {
  const originalUrl = decodeHtmlEntities(value).trim();
  if (!originalUrl || /[\u0000-\u001f\u007f]/.test(originalUrl)) {
    return { originalUrl, normalizedUrl: null, warningCode: 'MEDIA_URL_INVALID' };
  }
  let candidate = originalUrl;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (/^cbu01\.alicdn\.com\//i.test(candidate)) candidate = `https://${candidate}`;
  else if (/^\/?img\/ibank\//i.test(candidate)) {
    candidate = `https://cbu01.alicdn.com/${candidate.replace(/^\/+/, '')}`;
  }
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return { originalUrl, normalizedUrl: null, warningCode: 'MEDIA_URL_INVALID' };
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.port === '80' && url.protocol === 'http:') url.port = '';
    if (url.port === '443' && url.protocol === 'https:') url.port = '';
    if (isAlibabaMediaHost(url.hostname) && url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    url.hash = '';
    url.searchParams.delete('__r__');
    const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
      aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
    );
    url.search = '';
    for (const [key, item] of sorted) url.searchParams.append(key, item);
    return {
      originalUrl,
      normalizedUrl: url.toString(),
      warningCode: isAlibabaMediaHost(url.hostname)
        ? null
        : 'MEDIA_URL_HOST_UNRECOGNIZED',
    };
  } catch {
    return { originalUrl, normalizedUrl: null, warningCode: 'MEDIA_URL_INVALID' };
  }
}

export function normalizeRemoteMediaUrl(value: string): string | null {
  return normalize1688MediaUrlV2(value).normalizedUrl;
}

export function createOfferSingletonSourceKeyV1(offerId: string): string {
  requireStableId(offerId, 'offerId');
  return `1688-offer-singleton-source-v1:${digest({
    platform: '1688',
    identityKind: 'offer_singleton',
    offerId,
    sourceContractRevision: 'offer-singleton-source-v1',
  })}`;
}

export function createSourceMediaReferenceV2(input: {
  role: MediaRoleV2;
  owner: SourceMediaOwnerV2;
  order: number;
  sourceOrdinal: number;
  originalUrl: string;
  sourceField: string;
  sourceObservationId: string;
  sourcePayloadContentSha256: string;
}): { reference: SourceMediaReferenceV2 | null; warningCode: MediaUrlNormalizationV2['warningCode'] } {
  assertNonNegativeInteger(input.order, 'order');
  assertNonNegativeInteger(input.sourceOrdinal, 'sourceOrdinal');
  const normalized = normalize1688MediaUrlV2(input.originalUrl);
  if (!normalized.normalizedUrl) return { reference: null, warningCode: normalized.warningCode };
  const identity = sourceOwnerIdentity(input.owner);
  const sourceOwnerKey = `1688-media-owner-v2:${digest(identity)}`;
  const ownerFields = sourceOwnerFields(input.owner);
  const content = {
    role: input.role,
    ownerKind: input.owner.ownerKind,
    sourceOwnerKey,
    ...ownerFields,
    order: input.order,
    sourceOrdinal: input.sourceOrdinal,
    originalUrl: normalized.originalUrl,
    normalizedUrl: normalized.normalizedUrl,
    sourceField: requiredText(input.sourceField, 'sourceField'),
    sourceObservationId: requiredText(input.sourceObservationId, 'sourceObservationId'),
    sourcePayloadContentSha256: requireSha256(input.sourcePayloadContentSha256),
    availability: 'available' as const,
  };
  const { sourcePayloadContentSha256, ...wire } = content;
  return {
    reference: Object.freeze({
      ...wire,
      sourceReceiptContentSha256: `sha256:${digest({
        owner: identity,
        role: input.role,
        normalizedUrl: normalized.normalizedUrl,
        order: input.order,
        sourceOrdinal: input.sourceOrdinal,
        sourceField: input.sourceField,
        sourcePayloadContentSha256,
      })}`,
    }),
    warningCode: normalized.warningCode,
  };
}

export function sourceMediaOwnershipKeyV2(reference: SourceMediaReferenceV2): string {
  return [reference.ownerKind, reference.sourceOwnerKey, reference.role, reference.normalizedUrl].join('\u0000');
}

function sourceOwnerIdentity(owner: SourceMediaOwnerV2): Record<string, string> {
  if (owner.ownerKind === 'target-offer') {
    requireStableId(owner.offerId, 'offerId');
    return { platform: '1688', ownerKind: owner.ownerKind, offerId: owner.offerId };
  }
  if (owner.ownerKind === 'target-sku') {
    requireStableId(owner.offerId, 'offerId');
    if (owner.platformSkuId !== null) {
      requireStableId(owner.platformSkuId, 'platformSkuId');
      return {
        platform: '1688',
        ownerKind: owner.ownerKind,
        identityKind: 'platform',
        offerId: owner.offerId,
        platformSkuId: owner.platformSkuId,
      };
    }
    const expected = createOfferSingletonSourceKeyV1(owner.offerId);
    if (owner.singletonSourceKey !== expected) {
      throw new TypeError('Singleton media owner key does not match its deterministic offer identity.');
    }
    return {
      platform: '1688',
      ownerKind: owner.ownerKind,
      identityKind: 'offer_singleton',
      offerId: owner.offerId,
      singletonSourceKey: owner.singletonSourceKey,
    };
  }
  if (owner.ownerKind === 'store-catalog-offer') {
    requireStableId(owner.catalogOfferId, 'catalogOfferId');
    if (!Number.isInteger(owner.catalogPage) || owner.catalogPage < 1 ||
        !Number.isInteger(owner.catalogRank) || owner.catalogRank < 1) {
      throw new TypeError('Catalog media owner requires positive catalogPage/catalogRank.');
    }
    return { platform: '1688', ownerKind: owner.ownerKind, catalogOfferId: owner.catalogOfferId };
  }
  requireStableId(owner.memberId, 'memberId');
  return { platform: '1688', ownerKind: owner.ownerKind, memberId: owner.memberId };
}

function sourceOwnerFields(owner: SourceMediaOwnerV2): Partial<SourceMediaReferenceV2> {
  if (owner.ownerKind === 'target-offer') return { offerId: owner.offerId };
  if (owner.ownerKind === 'target-sku') {
    return {
      offerId: owner.offerId,
      platformSkuId: owner.platformSkuId,
      ...(owner.platformSkuId === null ? { singletonSourceKey: owner.singletonSourceKey } : {}),
    };
  }
  if (owner.ownerKind === 'store-catalog-offer') {
    return {
      catalogOfferId: owner.catalogOfferId,
      catalogPage: owner.catalogPage,
      catalogRank: owner.catalogRank,
    };
  }
  return { memberId: owner.memberId };
}

function isAlibabaMediaHost(host: string): boolean {
  return /(?:^|\.)(?:alicdn\.com|1688\.com|alibaba\.com)$/i.test(host);
}

function requireStableId(value: string, field: string): void {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${field} is invalid.`);
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${field} is invalid.`);
  return normalized;
}

function requireSha256(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('sourcePayloadContentSha256 is invalid.');
  return value;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer.`);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function extractVisibleDetailText(content: string): string | null {
  const text = content
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(
      /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
      ' ',
    )
    .replace(/<(?:br|hr)\b[^>]*\/?>/giu, '\n')
    .replace(
      /<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/giu,
      '\n',
    )
    .replace(/<[^>]*>/gu, ' ');
  const normalized = decodeHtmlEntities(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v \u00a0]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return normalized || null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/giu, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&ensp;', ' ')
    .replaceAll('&emsp;', ' ')
    .replaceAll('&thinsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
