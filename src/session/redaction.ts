const REDACTED = '[redacted]';

const SAFE_DIAGNOSTIC_QUERY_KEYS = new Set([
  'api',
  'datatype',
  'method',
  'type',
  'v',
  'version',
]);

const SENSITIVE_METADATA_KEYS = new Set([
  'authorization',
  'body',
  'cookie',
  'data',
  'headers',
  'mh5tk',
  'password',
  'passwd',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'sign',
  'signature',
  'token',
  'accesstoken',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_METADATA_KEYS.has(normalized) ||
    normalized.includes('authorization') ||
    normalized.includes('cookie') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.startsWith('mh5tk') ||
    normalized.startsWith('sign') ||
    normalized.endsWith('body') ||
    normalized.endsWith('headers') ||
    (normalized.endsWith('data') && normalized !== 'metadata')
  );
}

/**
 * Keeps a response URL useful for routing diagnostics without retaining
 * request payloads, signatures, tokens, or unknown query values.
 */
export function redactUrlForDiagnostics(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '[redacted-url]';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '[redacted-url]';
  }

  url.username = '';
  url.password = '';
  url.hash = '';

  const redactedSearch = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    redactedSearch.append(
      key,
      SAFE_DIAGNOSTIC_QUERY_KEYS.has(key.toLowerCase()) ? value : REDACTED,
    );
  }
  url.search = redactedSearch.toString();
  return url.toString();
}

/** Returns a credential-free URL suitable for persisted evidence references. */
export function sanitizeEvidenceRef(rawRef: string): string {
  if (!/^https?:\/\//iu.test(rawRef)) {
    return redactTextForDiagnostics(rawRef);
  }
  const redacted = redactUrlForDiagnostics(rawRef);
  try {
    const url = new URL(redacted);
    for (const [key, value] of [...url.searchParams]) {
      if (value === REDACTED) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

/** Redacts absolute HTTP(S) URLs embedded in diagnostic messages. */
export function redactTextForDiagnostics(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
    redactUrlForDiagnostics(url),
  );
}

/** Redacts JSON-like request metadata before it is logged or persisted. */
export function redactDiagnosticMetadata(value: unknown, key?: string): unknown {
  if (key && isSensitiveMetadataKey(key)) return REDACTED;
  if (typeof value === 'string') {
    if (key && normalizedKey(key).endsWith('url')) {
      return redactUrlForDiagnostics(value);
    }
    return redactTextForDiagnostics(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : redactDiagnosticMetadata(item),
    );
  }

  const redacted: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childValue === undefined) continue;
    redacted[childKey] = redactDiagnosticMetadata(childValue, childKey);
  }
  return redacted;
}

/**
 * Returns stable policy labels for secrets or unrelated personal contact data
 * that must never be committed as replay fixtures.
 */
export function scanFixtureSecrets(text: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['authorization', /(?:^|[\s"'])authorization\s*:/imu],
    [
      'cookie-header',
      /(?:^|\s)-(?:b|H)\s+['"]?(?:cookie\s*:|[^\r\n]*\b(?:cookie1|cookie2|cookie17|sgcookie)=)|(?:^|[\s"'])set-cookie\s*:/imu,
    ],
    ['mtop-token', /\b_m_h5_tk(?:_enc)?\s*=/iu],
    ['request-signature', /[?&]sign=[^&#\s'"]+/iu],
    [
      'personal-contact',
      /["'](?:contactInfo|mobileNo|phoneNumber|companyPrincipal)["']\s*:/iu,
    ],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
