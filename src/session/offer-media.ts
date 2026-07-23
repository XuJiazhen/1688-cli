import type { EvidenceSource } from '../collection/contracts.js';
import { redactUrlForDiagnostics } from './redaction.js';

export const OFFER_MEDIA_PARSER_VERSION = '1' as const;

export interface OfferMediaRef {
  role: 'main' | 'sku' | 'detail';
  order: number;
  originalUrl: string;
  normalizedUrl: string;
  sourceField: string;
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

export function parseOfferDetailsScript(
  script: string,
  sourceUrl = 'offer_details.content',
  collectedAt = new Date().toISOString(),
): OfferMediaManifest {
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
  const content = readContentString(script);
  if (content === null) {
    return {
      availability: 'failed',
      items: [],
      source,
      warnings: [{
        code: 'OFFER_DETAILS_CONTENT_UNREADABLE',
        message: 'offer_details.content was not found or was not a supported string literal.',
      }],
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
    availability: items.length > 0 ? 'available' : 'not-present',
    items,
    source,
    warnings,
  };
}

export function buildOfferMediaManifest(input: {
  offerId: string;
  mainImage: string | null;
  images: string[];
  skuImages: Array<string | null>;
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
    const key = `${role}:${normalizedUrl}`;
    if (seenByRole.has(key)) return;
    seenByRole.add(key);
    items.push({ role, order, originalUrl, normalizedUrl, sourceField });
  };

  add('main', input.mainImage, 0, 'gallery.mainImage');
  input.images.forEach((url, order) => add('main', url, order, 'gallery.mainImage'));
  input.skuImages.forEach((url, order) => add('sku', url, order, 'skuProps.imageUrl'));
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

function normalizeRemoteMediaUrl(value: string): string | null {
  const candidate = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.searchParams.delete('__r__');
    return url.toString();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
