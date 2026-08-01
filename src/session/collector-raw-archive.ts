import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REDACTED = '[redacted]';
const NUMERIC_IDENTITY_KEYS = new Set([
  'businessid',
  'categoryid',
  'memberid',
  'offerid',
  'productbusinessid',
  'productid',
  'sellermemberid',
  'shopid',
  'skuid',
]);
const SECRET_KEY = /(?:authorization|cookie|credential|mh5tk|password|secret|session|signature|token|x5sec)/iu;
const SIGN_KEY = /^(?:sign|apiSign|mtopSign|querySign|requestSign|urlSign)$/u;
const PERSONAL_KEY = /(?:contact|email|loginid|mobile|phone|telephone|userid|wechat|weixin|whatsapp)/iu;
const MOBILE = /(?<!\d)(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/gu;
const LANDLINE = /(?<!\d)0\d{2,3}[ -]\d{7,8}(?!\d)/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CONTACT_HANDLE = /\b(?:wx|wechat|weixin|qq)\s*[:：=]\s*[A-Za-z0-9_-]{4,}\b/giu;
const CHINESE_CONTACT = /(?:联系人|联系方式|联系电话|电话|手机|微信号?|微\s*信号?|薇信|v信)\s*(?:[:：=]|\s)\s*[^\s,，;；<>"']{2,32}/giu;
const INLINE_SENSITIVE_FIELD = /["']?(?:authorization|contact|cookie|credential|email|loginid|mh5tk|mobile|password|phone|secret|session|sign(?:ature)?|token|userid|wechat|weixin|x5sec)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,，;；<>}]+)/giu;
const INLINE_SECRET = /\b(?:authorization|cookie|mh5tk|password|secret|sign(?:ature)?|token|x5sec)\s*[:=]\s*[^\s<>'"&]+/giu;

export type CollectorRawArchiveKindV1 =
  | 'search-response'
  | 'offer-core'
  | 'offer-sku'
  | 'offer-detail'
  | 'offer-shop-card'
  | 'offer-consignment'
  | 'qualification-response'
  | 'store-response';

export interface CollectorRawArchiveV1 {
  schema: 'collector.sanitized-raw-archive.v1';
  kind: CollectorRawArchiveKindV1;
  parserRevision: string;
  pageActionId: string;
  remoteRequestAttemptId: string;
  requestBusinessHash: string;
  sanitizedPayload: unknown;
  payloadHash: string;
}

export function sanitizeCollectorPayloadV1(
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
): unknown {
  const normalizedKey = key.replace(/[^A-Za-z0-9]/gu, '').toLocaleLowerCase('en-US');
  if (
    key
    && NUMERIC_IDENTITY_KEYS.has(normalizedKey)
    && typeof value === 'string'
    && /^\d+$/u.test(value)
  ) return value;
  if (
    key
    && (
      SECRET_KEY.test(key)
      || SECRET_KEY.test(normalizedKey)
      || SIGN_KEY.test(key)
      || PERSONAL_KEY.test(key)
      || PERSONAL_KEY.test(normalizedKey)
    )
  ) {
    return value === null ? null : REDACTED;
  }
  if (typeof value === 'string') {
    const structured = parseStructuredCollectorTextV1(value);
    return structured === undefined
      ? redactCollectorTextV1(value)
      : sanitizeCollectorPayloadV1(structured, key, seen);
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCollectorPayloadV1(item, '', seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([childKey, child]) => [
        childKey,
        sanitizeCollectorPayloadV1(child, childKey, seen),
      ]),
  );
}

export function redactCollectorTextV1(value: string): string {
  return value
    .replace(MOBILE, REDACTED)
    .replace(LANDLINE, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(CONTACT_HANDLE, REDACTED)
    .replace(CHINESE_CONTACT, REDACTED)
    .replace(INLINE_SENSITIVE_FIELD, REDACTED)
    .replace(INLINE_SECRET, REDACTED);
}

function parseStructuredCollectorTextV1(value: string): object | undefined {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? trimmed
    : trimmed.match(/^[A-Za-z_$][\w$.[\]]*\s*\(([\s\S]*)\)\s*;?$/u)?.[1];
  if (candidate === undefined) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createCollectorRawArchiveV1(input: {
  kind: CollectorRawArchiveKindV1;
  parserRevision: string;
  pageActionId: string;
  remoteRequestAttemptId: string;
  requestBusinessHash: string;
  payload: unknown;
}): { artifactRef: string; artifact: CollectorRawArchiveV1 } {
  const sanitizedPayload = sanitizeCollectorPayloadV1(input.payload);
  const payloadHash = hash(sanitizedPayload);
  const artifact: CollectorRawArchiveV1 = {
    schema: 'collector.sanitized-raw-archive.v1',
    kind: input.kind,
    parserRevision: required(input.parserRevision, 'parserRevision'),
    pageActionId: required(input.pageActionId, 'pageActionId'),
    remoteRequestAttemptId: required(
      input.remoteRequestAttemptId,
      'remoteRequestAttemptId',
    ),
    requestBusinessHash: sha256(input.requestBusinessHash, 'requestBusinessHash'),
    sanitizedPayload,
    payloadHash,
  };
  const digest = hash(artifact).slice('sha256:'.length);
  return {
    artifactRef: `artifact:collector-raw-${input.kind}-${digest}`,
    artifact: Object.freeze(artifact),
  };
}

export function assertCollectorRawArchiveV1(
  artifactRef: string,
  artifact: CollectorRawArchiveV1,
): void {
  const digest = hash(artifact).slice('sha256:'.length);
  if (
    artifact.schema !== 'collector.sanitized-raw-archive.v1'
    || artifact.payloadHash !== hash(artifact.sanitizedPayload)
    || artifactRef !== `artifact:collector-raw-${artifact.kind}-${digest}`
  ) {
    throw new TypeError('Collector raw archive reference does not match its content.');
  }
}

export async function persistCollectorRawArchiveV1(input: {
  artifactDirectory: string;
  archive: { artifactRef: string; artifact: CollectorRawArchiveV1 };
}): Promise<string> {
  assertCollectorRawArchiveV1(input.archive.artifactRef, input.archive.artifact);
  if (!path.isAbsolute(input.artifactDirectory)) {
    throw new TypeError('Collector raw archive directory must be absolute.');
  }
  const id = input.archive.artifactRef.slice('artifact:'.length);
  const destination = path.join(input.artifactDirectory, `${id}.json`);
  const relative = path.relative(input.artifactDirectory, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('Collector raw archive destination escapes its root.');
  }
  await fs.mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(input.archive.artifact, null, 2)}\n`;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await fs.readFile(destination, 'utf8') !== bytes) {
        throw new Error('Content-addressed Collector archive collision.');
      }
    }
    await fs.chmod(destination, 0o600);
    return input.archive.artifactRef;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} must be non-empty.`);
  return value;
}

function sha256(value: string, field: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 reference.`);
  }
  return value;
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}
