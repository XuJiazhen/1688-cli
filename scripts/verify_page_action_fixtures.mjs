import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  normalizeCollectorWireResponseV1,
  normalizePageActionExecuteResponseV1,
} from '../src/collection/page-action-contracts.ts';

export const PAGE_ACTION_FIXTURE_ROOT = fileURLToPath(
  new URL('../tests/fixtures/page-actions/', import.meta.url),
);

const MANIFEST_FILE = 'manifest.json';
const RECEIPT_FILE = 'sha256-receipt.json';
const FIXTURE_SET_ID = 'fixture-page-actions-t0-v1';
const MANIFEST_SCHEMA = 'collector.page-action.sanitized-fixture-manifest.v1';
const RECEIPT_SCHEMA = 'collector.page-action.fixture-sha256-receipt.v1';
const FIXTURE_TIMESTAMP = '2026-07-31T00:00:00.000Z';
const FIXTURE_CANONICAL_SHOP_URL = 'https://fixture-store.1688.com/';
const EXPECTED_PAYLOAD_FILES = [
  'offer-detail.json',
  'store-sample-page-action-response.json',
  'search-list-page-1.json',
  'search-list-page-2-terminal.json',
  'store-qualification.json',
  'store-sample-pages-1-3.json',
];
const EXPECTED_FIXTURE_FILES = [
  MANIFEST_FILE,
  ...EXPECTED_PAYLOAD_FILES,
  RECEIPT_FILE,
].sort();
const EXPECTED_SANITIZATION_POLICY = Object.freeze({
  identifiers: 'deterministic fixture-prefixed placeholders',
  networkLocations: 'reserved example.test hosts plus the exact strict-contract fixture shop sentinel',
  customerData: 'omitted',
  requestCredentials: 'omitted',
  freeText: 'short ASCII structural labels only',
});
const EXPECTED_MANIFEST_FIXTURES = Object.freeze({
  'search-list-page-1.json': Object.freeze({
    actionKind: 'search-list',
    wireFormat: 'collection-batch-v1',
    semanticRole: 'first non-terminal search page',
  }),
  'search-list-page-2-terminal.json': Object.freeze({
    actionKind: 'search-list',
    wireFormat: 'collection-batch-v1',
    semanticRole: 'correlated terminal search page',
  }),
  'offer-detail.json': Object.freeze({
    actionKind: 'offer-detail',
    wireFormat: 'collection-batch-v1',
    semanticRole: 'core, explicit SKU, and owned media observations',
  }),
  'store-qualification.json': Object.freeze({
    actionKind: 'store-qualification',
    wireFormat: 'collection-batch-v1',
    semanticRole: 'qualification facts and complete qualification media',
  }),
  'store-sample-pages-1-3.json': Object.freeze({
    actionKind: 'store-sample',
    wireFormat: 'collection-batch-v1',
    semanticRole: 'bounded pages 1-3 with dormant page 4 checkpoint',
  }),
  'store-sample-page-action-response.json': Object.freeze({
    actionKind: 'store-sample',
    wireFormat: 'collector.page-action.execute-response.v1',
    semanticRole: 'strict PageAction response with execution and completion receipts',
  }),
});
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PLACEHOLDER_IDENTIFIER_KEYS = new Set([
  'batchid',
  'categoryobservationid',
  'collectiontaskid',
  'fixturesetid',
  'id',
  'memberid',
  'offerid',
  'pageactionid',
  'platformskuid',
  'searchquerykey',
  'searchsegmentid',
  'searchwaveid',
  'skuid',
  'sourcebatchid',
  'sourceobservationid',
  'sourcerequestid',
  'storefrontprofileobservationid',
  'unitid',
  'fencingtoken',
]);
const FORBIDDEN_IDENTIFIER_KEYS = new Set([
  'accountid',
  'buyerid',
  'deviceid',
  'loginid',
  'sellerid',
  'userid',
]);
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'accesskeysecret',
  'accesstoken',
  'accountkey',
  'apikey',
  'apisecret',
  'appkey',
  'appsecret',
  'authorization',
  'authtoken',
  'awsaccesskeyid',
  'awssecretaccesskey',
  'awssecuritytoken',
  'awssessiontoken',
  'clientsecret',
  'connectionstring',
  'cookie',
  'credential',
  'credentials',
  'csrftoken',
  'mh5tk',
  'mh5tkenc',
  'oauthaccesstoken',
  'oauthrefreshtoken',
  'password',
  'privatekey',
  'privatekeydata',
  'privatekeypem',
  'refreshtoken',
  'sastoken',
  'securitytoken',
  'secret',
  'secretaccesskey',
  'secretid',
  'secretkey',
  'session',
  'sessionid',
  'sessionkey',
  'sessiontoken',
  'setcookie',
  'sign',
  'signature',
  'slacktoken',
  'serviceaccountkey',
  'sshprivatekey',
  'token',
  'webhooksecret',
  'x5sec',
  'xapikey',
  'xauthtoken',
]);
const DECODED_CREDENTIAL_ASSIGNMENT_TOKENS = new Set([
  ...FORBIDDEN_CREDENTIAL_KEYS,
  'auth',
  'bearer',
]);
const CREDENTIAL_IDENTIFIER_SEGMENTS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'passwd',
  'password',
  'pwd',
  'session',
  'sign',
  'signature',
  'signing',
  'secret',
  'token',
]);
const PRIVATE_IDENTIFIER_SUFFIXES = new Set([
  'blob',
  'contents',
  'credential',
  'data',
  'key',
  'material',
  'pem',
  'secret',
  'token',
]);
const CLOUD_IDENTIFIER_PREFIXES = new Set([
  'alibaba',
  'aliyun',
  'aws',
  'azure',
  'cloud',
  'gcp',
  'google',
  'tencent',
]);
const CLOUD_IDENTIFIER_SUFFIXES = new Set([
  'credential',
  'key',
  'password',
  'secret',
  'sign',
  'signature',
  'token',
]);
const SECURITY_METADATA_KEYS = new Set(['fencingtoken', 'requestcredentials']);
const FORBIDDEN_PERSONAL_KEYS = new Set([
  'address',
  'bankaccount',
  'billingaddress',
  'companyname',
  'companyaddress',
  'companyprincipal',
  'consignee',
  'contactaddress',
  'contactemail',
  'contactname',
  'contactinfo',
  'contactperson',
  'contactphone',
  'detailedaddress',
  'email',
  'emailaddress',
  'fax',
  'firstname',
  'fullname',
  'givenname',
  'homeaddress',
  'iban',
  'idcard',
  'identitycard',
  'legalrepresentative',
  'lastname',
  'mailingaddress',
  'mobile',
  'mobilephone',
  'mobileno',
  'nationalid',
  'passportnumber',
  'phone',
  'phoneno',
  'phonenumber',
  'postaladdress',
  'postalcode',
  'qq',
  'recipient',
  'registeredaddress',
  'shippingaddress',
  'streetaddress',
  'surname',
  'taxid',
  'tel',
  'telephone',
  'wechat',
  'wechatid',
  'zipcode',
]);

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function identifierSegments(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/gu)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function hasCompoundIdentifierSyntax(value) {
  return /[_.-]/u.test(value) ||
    /[a-z0-9][A-Z]/u.test(value) ||
    /[A-Z]+[A-Z][a-z]/u.test(value);
}

function isCredentialIdentifier(value) {
  const identifier = value.trim();
  if (identifier === '') return false;
  const compact = normalizedKey(identifier);
  if (DECODED_CREDENTIAL_ASSIGNMENT_TOKENS.has(compact)) return true;
  if (!hasCompoundIdentifierSyntax(identifier)) return false;

  const segments = identifierSegments(identifier);
  if (segments.some((segment) => CREDENTIAL_IDENTIFIER_SEGMENTS.has(segment))) {
    return true;
  }
  if (
    segments.includes('private') &&
    segments.some((segment) => PRIVATE_IDENTIFIER_SUFFIXES.has(segment))
  ) {
    return true;
  }
  return segments.some((segment) => CLOUD_IDENTIFIER_PREFIXES.has(segment)) &&
    segments.some((segment) => CLOUD_IDENTIFIER_SUFFIXES.has(segment));
}

function canonicalHostnameIsProduction1688(hostname) {
  const canonical = hostname.toLowerCase().replace(/\.+$/gu, '');
  return canonical === '1688.com' || canonical.endsWith('.1688.com');
}

function decodeCommonHtmlEntities(value) {
  const named = {
    amp: '&', apos: "'", colon: ':', commat: '@', equals: '=',
    gt: '>', lt: '<', num: '#', period: '.', plus: '+', quest: '?',
    quot: '"', sol: '/',
  };
  return value.replace(/&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z]+));/giu, (
    match,
    decimal,
    hexadecimal,
    name,
  ) => {
    if (name !== undefined) return named[name.toLowerCase()] ?? match;
    const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal === undefined ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function decodedTextVariants(value) {
  const variants = new Set([value]);
  let frontier = [value];
  for (let pass = 0; pass < 4 && frontier.length > 0; pass++) {
    const next = [];
    for (const current of frontier) {
      const decodedHtml = decodeCommonHtmlEntities(current);
      if (!variants.has(decodedHtml)) {
        variants.add(decodedHtml);
        next.push(decodedHtml);
      }
      try {
        const decodedUri = decodeURIComponent(current);
        if (!variants.has(decodedUri)) {
          variants.add(decodedUri);
          next.push(decodedUri);
        }
      } catch {
        // A malformed URI escape does not prevent independent HTML decoding.
      }
    }
    frontier = next;
  }
  return variants;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateExactKeys(value, expectedKeys, jsonPath, violations) {
  if (!isRecord(value)) {
    violations.push(`${jsonPath}: expected an object`);
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const frozenKeys = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actualKeys, frozenKeys)) {
    violations.push(`${jsonPath}: fields do not exactly match the frozen contract`);
    return false;
  }
  return true;
}

function validateExactRecord(value, expected, jsonPath, violations) {
  const expectedKeys = Object.keys(expected).sort();
  if (!validateExactKeys(value, expectedKeys, jsonPath, violations)) return false;
  for (const key of expectedKeys) {
    if (value[key] !== expected[key]) {
      violations.push(`${jsonPath}.${key}: value does not match the frozen contract`);
    }
  }
  return true;
}

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function fileIdentity(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inventoriesEqual(left, right) {
  if (
    left.canonicalRoot !== right.canonicalRoot ||
    left.rootIdentity === undefined ||
    right.rootIdentity === undefined ||
    !sameDirectoryIdentity(left.rootIdentity, right.rootIdentity) ||
    left.files.length !== right.files.length
  ) {
    return false;
  }
  return left.files.every((entry, index) => {
    const current = right.files[index];
    return current !== undefined &&
      entry.relativePath === current.relativePath &&
      entry.canonicalPath === current.canonicalPath &&
      sameFileIdentity(entry.identity, current.identity);
  });
}

async function rootIdentityIsCurrent(inventory, violations, stage) {
  let stats;
  try {
    stats = await lstat(inventory.root, { bigint: true });
  } catch (error) {
    violations.push(`fixture root: cannot be inspected ${stage} (${String(error)})`);
    return false;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !sameDirectoryIdentity(inventory.rootIdentity, fileIdentity(stats))
  ) {
    violations.push(`fixture root: directory identity changed ${stage}`);
    return false;
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(inventory.root);
  } catch (error) {
    violations.push(`fixture root: cannot be resolved ${stage} (${String(error)})`);
    return false;
  }
  if (canonicalRoot !== inventory.canonicalRoot) {
    violations.push(`fixture root: resolved path changed ${stage}`);
    return false;
  }
  return true;
}

async function fixtureFiles(directory, violations) {
  const root = path.resolve(directory);
  let rootStats;
  try {
    rootStats = await lstat(root, { bigint: true });
  } catch (error) {
    violations.push(`fixture root: cannot be inspected (${String(error)})`);
    return { files: [], root };
  }
  if (rootStats.isSymbolicLink()) {
    violations.push('fixture root: symbolic links are not allowed');
    return { files: [], root };
  }
  if (!rootStats.isDirectory()) {
    violations.push('fixture root: expected a directory');
    return { files: [], root };
  }

  const canonicalRoot = await realpath(root);
  const files = [];
  async function visit(directoryPath) {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      const relativePath = path.relative(root, directoryPath) || '.';
      violations.push(`${relativePath}: directory cannot be read (${String(error)})`);
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directoryPath, entry.name);
      const relativePath = path.relative(root, target).split(path.sep).join('/');
      let stats;
      try {
        stats = await lstat(target, { bigint: true });
      } catch (error) {
        violations.push(`${relativePath}: entry cannot be inspected (${String(error)})`);
        continue;
      }
      if (stats.isSymbolicLink()) {
        violations.push(`${relativePath}: symbolic links are not allowed`);
        continue;
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        violations.push(`${relativePath}: special filesystem entries are not allowed`);
        continue;
      }

      let canonicalTarget;
      try {
        canonicalTarget = await realpath(target);
      } catch (error) {
        violations.push(`${relativePath}: entry cannot be resolved (${String(error)})`);
        continue;
      }
      if (!pathIsWithin(canonicalRoot, canonicalTarget)) {
        violations.push(`${relativePath}: entry resolves outside the fixture root`);
        continue;
      }
      if (stats.isDirectory()) await visit(target);
      else {
        files.push({
          path: target,
          relativePath,
          canonicalPath: canonicalTarget,
          identity: fileIdentity(stats),
        });
      }
    }
  }

  await visit(root);
  return {
    files: files.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    ),
    root,
    canonicalRoot,
    rootIdentity: fileIdentity(rootStats),
  };
}

async function readVerifiedFixtureFile(entry, inventory, violations) {
  if (!await rootIdentityIsCurrent(inventory, violations, 'before file open')) {
    return undefined;
  }
  if (typeof constants.O_NOFOLLOW !== 'number') {
    violations.push(`${entry.relativePath}: secure no-follow file opens are unavailable`);
    return undefined;
  }

  let handle;
  try {
    handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    violations.push(`${entry.relativePath}: file cannot be securely opened (${String(error)})`);
    return undefined;
  }

  try {
    const openedStats = await handle.stat({ bigint: true });
    const openedIdentity = fileIdentity(openedStats);
    if (!openedStats.isFile() || !sameFileIdentity(entry.identity, openedIdentity)) {
      violations.push(`${entry.relativePath}: file identity changed before read`);
      return undefined;
    }

    const bytes = await handle.readFile();
    const afterReadStats = await handle.stat({ bigint: true });
    const afterReadIdentity = fileIdentity(afterReadStats);
    if (!sameFileIdentity(openedIdentity, afterReadIdentity)) {
      violations.push(`${entry.relativePath}: opened file changed during read`);
      return undefined;
    }

    let pathStats;
    let canonicalPath;
    try {
      pathStats = await lstat(entry.path, { bigint: true });
      canonicalPath = await realpath(entry.path);
    } catch (error) {
      violations.push(`${entry.relativePath}: path cannot be revalidated after read (${String(error)})`);
      return undefined;
    }
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      !sameFileIdentity(afterReadIdentity, fileIdentity(pathStats)) ||
      canonicalPath !== entry.canonicalPath ||
      !pathIsWithin(inventory.canonicalRoot, canonicalPath)
    ) {
      violations.push(`${entry.relativePath}: path identity changed after read`);
      return undefined;
    }
    if (!await rootIdentityIsCurrent(inventory, violations, 'after file read')) {
      return undefined;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validateText(text, relativePath, violations) {
  const patterns = [
    ['authorization-header', /(?:^|[\s"'])authorization\s*:/imu],
    ['cookie-header', /(?:^|[\s"'])set-cookie\s*:/imu],
    ['mtop-credential', /\b_m_h5_tk(?:_enc)?\s*=/iu],
    ['request-signature', /[?&]sign=[^&#\s'"]+/iu],
    ['common-credential-assignment', /(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|ACCESS[_-]?KEY[_-]?SECRET|API[_-]?KEY|APP[_-]?(?:KEY|SECRET)|CLIENT[_-]?SECRET|CONNECTION[_-]?STRING|CSRF[_-]?TOKEN|PRIVATE[_-]?KEY|SECRET[_-]?(?:ACCESS_)?KEY|SERVICE[_-]?ACCOUNT[_-]?KEY|X5SEC)\s*["']?\s*[:=]/iu],
    ['private-key-material', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/iu],
    ['personal-contact', /["'](?:contactInfo|mobileNo|phoneNumber|companyPrincipal)["']\s*:/iu],
    ['mainland-phone-number', /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u],
    ['email-address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ['production-1688-host', /https?:\/\/(?:[^/]+\.)?1688\.com\b/iu],
  ];
  for (const [label, pattern] of patterns) {
    if (
      label === 'production-1688-host'
      && relativePath === 'store-sample-page-action-response.json'
    ) {
      // Structured validation below permits the sentinel only at canonicalShopUrl.
      continue;
    }
    if (pattern.test(text)) violations.push(`${relativePath}: ${label}`);
  }
}

function isFixtureCanonicalShopUrl(value, jsonPath) {
  return value === FIXTURE_CANONICAL_SHOP_URL
    && jsonPath.endsWith('.businessSubject.canonicalShopUrl');
}

function validateDecodedString(value, jsonPath, violations) {
  const fixtureCanonicalShopUrl = isFixtureCanonicalShopUrl(value, jsonPath);
  const patterns = [
    ['production-1688-host', /(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*1688\.com\.?(?::\d+)?(?=[/?#:\s]|$)/iu],
    ['private-key-material', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/iu],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
    ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/u],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
    ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u],
    ['live-secret-token', /\bsk_live_[A-Za-z0-9]{8,}\b/u],
    ['openai-api-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
    ['jwt-token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
    ['bearer-credential', /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*\b/iu],
    ['email-address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ['mainland-phone-number', /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u],
    ['mainland-phone-number', /(?:^|[^\d])(?:\+?86[\s().-]*)?1[3-9](?:[\s().-]*\d){9}(?!\d)/u],
    ['formatted-phone-number', /(?:^|\D)\+?[1-9]\d{0,2}[-.\s]\(?\d{2,3}\)?[-.\s]\d{3}[-.\s]\d{4}(?:\D|$)/u],
    ['e164-phone-number', /(?:^|[^\d+])\+[1-9]\d{7,14}(?=$|[^\d])/u],
    ['e164-phone-number', /(?:^|[^\d+])\+[1-9](?:[\s().-]*\d){7,14}(?!\d)/u],
  ];
  const variants = decodedTextVariants(value);
  const reportedPatterns = new Set();
  for (const variant of variants) {
    for (const [label, pattern] of patterns) {
      if (label === 'production-1688-host' && fixtureCanonicalShopUrl) continue;
      if (pattern.test(variant) && !reportedPatterns.has(label)) {
        violations.push(`${jsonPath}: ${label}`);
        reportedPatterns.add(label);
      }
    }
  }
  if ([...variants].some((variant) => containsCredentialAssignment(variant))) {
    violations.push(`${jsonPath}: credential-assignment`);
  }

  let reportedProductionHost = reportedPatterns.has('production-1688-host');
  for (const variant of variants) {
    for (const candidate of variant.match(/https?:\/\/[^\s"'<>]+/giu) ?? []) {
      let parsedUrl;
      try {
        parsedUrl = new URL(candidate);
      } catch {
        // The structural URL-field validator reports malformed URL values.
      }
      if (
        !reportedProductionHost &&
        parsedUrl !== undefined &&
        canonicalHostnameIsProduction1688(parsedUrl.hostname)
        && !fixtureCanonicalShopUrl
      ) {
        violations.push(`${jsonPath}: production-1688-host`);
        reportedProductionHost = true;
      }
      if (/^https?:\/\/[^/?#\s]+:[^@/\s]+@/iu.test(candidate)) {
        violations.push(`${jsonPath}: credential-bearing URL`);
      }
      if (/[?&](?:access[_-]?key(?:[_-]?id|[_-]?secret)?|access[_-]?token|api[_-]?key|app[_-]?(?:key|secret)|authorization|client[_-]?secret|cookie|credential|password|secret|secret[_-]?access[_-]?key|session|sign(?:ature)?|token|x5sec|x-amz-credential|x-amz-signature)=/iu.test(candidate)) {
        violations.push(`${jsonPath}: credential-bearing URL`);
      }
    }
  }
}

function containsCredentialAssignment(value) {
  for (const match of value.matchAll(/[:=]/gu)) {
    const delimiterIndex = match.index;
    if (delimiterIndex === undefined) continue;
    const assignmentValue = value.slice(delimiterIndex + 1);
    if (!/^\s*["']?[^\s"',;]+/u.test(assignmentValue)) continue;
    const before = value.slice(0, delimiterIndex);
    const previousDelimiter = Math.max(
      before.lastIndexOf(':'),
      before.lastIndexOf('='),
      before.lastIndexOf(','),
      before.lastIndexOf(';'),
      before.lastIndexOf('{'),
      before.lastIndexOf('['),
      before.lastIndexOf('\n'),
      before.lastIndexOf('\r'),
    );
    const lhs = before.slice(previousDelimiter + 1).trim().replace(/^["']|["']$/gu, '');
    if (isCredentialIdentifier(lhs)) return true;
  }
  return false;
}

function normalizedPayloadActionKind(payload) {
  if (isRecord(payload.executionAttemptReceipt)) {
    return payload.executionAttemptReceipt.actionKind;
  }
  return {
    'search-page': 'search-list',
    'offer-detail': 'offer-detail',
    'store-qualification': 'store-qualification',
    'store-catalog': 'store-sample',
  }[payload.kind];
}

function validatePayloadActionMapping(
  relativePath,
  declaration,
  payload,
  violations,
) {
  const actionKind = normalizedPayloadActionKind(payload);
  if (actionKind !== declaration.actionKind) {
    violations.push(
      `${relativePath}: normalized payload actionKind does not match manifest declaration`,
    );
  }

  if (declaration.wireFormat === 'collector.page-action.execute-response.v1') {
    const attempt = payload.executionAttemptReceipt;
    const completion = payload.completionReceipt;
    if (!isRecord(attempt) || !isRecord(completion)) {
      violations.push(`${relativePath}: completed PageAction fixture requires both receipts`);
      return;
    }
    if (attempt.outcome !== 'completed' || completion.status !== 'completed') {
      violations.push(`${relativePath}: PageAction fixture must be a completed response`);
    }
    const batches = [
      ...(Array.isArray(attempt.batches) ? attempt.batches : []),
      ...(Array.isArray(completion.batches) ? completion.batches : []),
    ];
    if (batches.length === 0) {
      violations.push(`${relativePath}: PageAction response does not contain a CollectionBatch`);
    }
    for (const batch of batches) {
      if (normalizedPayloadActionKind(batch) !== declaration.actionKind) {
        violations.push(`${relativePath}: contained batch actionKind does not match its receipt`);
      }
    }
  }

  if (declaration.actionKind !== 'search-list') return;
  const expectedSearchScope = {
    'search-list-page-1.json': {
      page: 1,
      terminal: false,
      terminalReason: null,
    },
    'search-list-page-2-terminal.json': {
      page: 2,
      terminal: true,
      terminalReason: 'source-end',
    },
  }[relativePath];
  if (expectedSearchScope === undefined || !isRecord(payload.scope)) {
    violations.push(`${relativePath}: search fixture role is not bound to a search page scope`);
    return;
  }
  for (const [key, expected] of Object.entries(expectedSearchScope)) {
    if (payload.scope[key] !== expected) {
      violations.push(
        `${relativePath}: search fixture ${key} does not match its declared file role`,
      );
    }
  }
}

function validateSearchFixtureCorrelation(normalizedPayloads, violations) {
  const first = normalizedPayloads.get('search-list-page-1.json');
  const terminal = normalizedPayloads.get('search-list-page-2-terminal.json');
  if (!isRecord(first) || !isRecord(terminal)) return;
  if (!isRecord(first.scope) || !isRecord(terminal.scope)) {
    violations.push('search fixtures: normalized payloads must expose page scopes');
    return;
  }

  const correlationFields = [
    'searchQueryKey',
    'querySnapshotHash',
    'searchSegmentId',
    'pageActionId',
  ];
  for (const field of correlationFields) {
    if (terminal.scope[field] !== first.scope[field]) {
      violations.push(`search fixtures: correlated ${field} values do not match`);
    }
  }
  if (first.scope.page !== 1 || terminal.scope.page !== 2) {
    violations.push('search fixtures: expected normalized page ordering 1 then 2');
  } else if (terminal.scope.page !== first.scope.page + 1) {
    violations.push('search fixtures: terminal page must immediately follow the first page');
  }
  if (
    first.scope.terminal !== false ||
    first.scope.terminalReason !== null ||
    terminal.scope.terminal !== true ||
    terminal.scope.terminalReason !== 'source-end'
  ) {
    violations.push('search fixtures: normalized terminal fields do not match their page roles');
  }

  const exactTopLevelFields = ['unitId', 'sourceRequestId', 'kind'];
  for (const field of exactTopLevelFields) {
    if (terminal[field] !== first[field]) {
      violations.push(`search fixtures: correlated ${field} values do not match`);
    }
  }
  if (!isRecord(first.subject) || !isRecord(terminal.subject)) {
    violations.push('search fixtures: both pages require a subject');
    return;
  }
  if (
    first.subject.keyword !== terminal.subject.keyword ||
    first.subject.keyword !== first.observations?.[0]?.keyword
  ) {
    violations.push('search fixtures: correlated subject keyword values do not match');
  }

  const scopeFields = ['requestedScope', 'requestedEndPage', 'advertisementPolicy'];
  for (const field of scopeFields) {
    if (terminal.scope[field] !== first.scope[field]) {
      violations.push(`search fixtures: correlated scope ${field} values do not match`);
    }
  }
  if (
    first.scope.requestedScope !== 'bounded-pages' ||
    first.scope.requestedEndPage !== 2 ||
    first.scope.advertisementPolicy !== 'exclude_promoted'
  ) {
    violations.push('search fixtures: frozen request scope, range, or advertisement policy changed');
  }

  const allObservations = [];
  const pages = [first, terminal];
  const commonObservationFields = [
    'collectionTaskId', 'searchWaveId', 'querySnapshotHash', 'keyword',
    'filtersHash', 'sort', 'advertisementPolicy',
  ];
  let commonObservation;
  for (const [pageIndex, payload] of pages.entries()) {
    if (!Array.isArray(payload.observations)) {
      violations.push(`search fixtures: page ${pageIndex + 1} observations must be an array`);
      continue;
    }
    for (const [observationIndex, observation] of payload.observations.entries()) {
      if (!isRecord(observation)) {
        violations.push(`search fixtures: page ${pageIndex + 1} observation must be an object`);
        continue;
      }
      commonObservation ??= observation;
      for (const field of commonObservationFields) {
        if (observation[field] !== commonObservation[field]) {
          violations.push(`search fixtures: correlated observation ${field} values do not match`);
        }
      }
      if (
        observation.querySnapshotHash !== payload.scope.querySnapshotHash ||
        observation.keyword !== payload.subject.keyword ||
        observation.advertisementPolicy !== payload.scope.advertisementPolicy ||
        observation.page !== payload.scope.page ||
        observation.sourceBatchId !== payload.batchId ||
        observation.rankInPage !== observationIndex + 1 ||
        observation.eligible !== true ||
        observation.ineligibilityReason !== null
      ) {
        violations.push(`search fixtures: page ${pageIndex + 1} observation lineage or rank is inconsistent`);
      }
      allObservations.push(observation);
    }
  }
  const offerIds = allObservations.map((observation) => observation.offerId);
  const observationIds = allObservations.map((observation) => observation.id);
  if (new Set(offerIds).size !== offerIds.length || new Set(observationIds).size !== observationIds.length) {
    violations.push('search fixtures: cumulative offer and observation identities must be unique');
  }
  if (
    !isRecord(first.completeness) ||
    first.status !== 'partial' ||
    first.completeness.state !== 'truncated' ||
    !isDeepStrictEqual(first.completeness.observedPages, [1]) ||
    !isDeepStrictEqual(first.completeness.failedPages, []) ||
    first.completeness.uniqueItems !== first.observations?.length ||
    !isDeepStrictEqual(first.duplicateObservations, []) ||
    !isRecord(first.metrics) ||
    first.metrics.eligibleSearchHits !== first.observations?.length
  ) {
    violations.push('search fixtures: first-page partial completeness is inconsistent');
  }
  if (
    !isRecord(terminal.completeness) ||
    terminal.status !== 'completed' ||
    terminal.completeness.state !== 'complete' ||
    !isDeepStrictEqual(terminal.completeness.observedPages, [1, 2]) ||
    !isDeepStrictEqual(terminal.completeness.failedPages, []) ||
    terminal.completeness.uniqueItems !== allObservations.length ||
    !isDeepStrictEqual(terminal.duplicateObservations, []) ||
    !isRecord(terminal.metrics) ||
    terminal.metrics.eligibleSearchHits !== terminal.observations?.length
  ) {
    violations.push('search fixtures: terminal cumulative completeness is inconsistent');
  }
  if (
    terminal.metrics.cumulativeEligibleSearchHits !== allObservations.length
  ) {
    violations.push('search fixtures: terminal cumulative metrics are inconsistent');
  }
  if (Date.parse(terminal.startedAt) < Date.parse(first.completedAt)) {
    violations.push('search fixtures: terminal page starts before the first page completed');
  }
}

function normalizeFixtureWirePayload(relativePath, declaration, payload) {
  if (declaration.wireFormat === 'collection-batch-v1') {
    return normalizeCollectorWireResponseV1(payload);
  }
  if (declaration.wireFormat === 'collector.page-action.execute-response.v1') {
    return normalizePageActionExecuteResponseV1(payload);
  }
  throw new Error(`${relativePath}: unsupported fixture wireFormat`);
}

function validateValue(value, jsonPath, violations) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateValue(entry, `${jsonPath}[${index}]`, violations));
    return;
  }
  if (typeof value === 'string') {
    if (/[^\x00-\x7f]/u.test(value)) {
      violations.push(`${jsonPath}: non-ASCII free text is not allowed in the synthetic corpus`);
    }
    validateDecodedString(value, jsonPath, violations);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const keyName = normalizedKey(key);
    const childPath = `${jsonPath}.${key}`;
    if (
      FORBIDDEN_CREDENTIAL_KEYS.has(keyName) ||
      (!SECURITY_METADATA_KEYS.has(keyName) && isCredentialIdentifier(key))
    ) {
      violations.push(`${childPath}: forbidden credential field`);
    }
    if (FORBIDDEN_PERSONAL_KEYS.has(keyName)) {
      violations.push(`${childPath}: forbidden personal-data field`);
    }
    if (FORBIDDEN_IDENTIFIER_KEYS.has(keyName)) {
      violations.push(`${childPath}: forbidden production identity class`);
    }
    if (
      PLACEHOLDER_IDENTIFIER_KEYS.has(keyName) &&
      typeof child === 'string' &&
      !child.startsWith('fixture-')
    ) {
      violations.push(`${childPath}: identifier is not a fixture placeholder`);
    }
    if (keyName.endsWith('url') && typeof child === 'string') {
      let url;
      try {
        url = new URL(child);
      } catch {
        violations.push(`${childPath}: URL is not absolute`);
      }
      if (url !== undefined) {
        const hostIsReserved =
          url.hostname === 'example.test'
          || url.hostname.endsWith('.example.test')
          || isFixtureCanonicalShopUrl(child, childPath);
        if (
          url.protocol !== 'https:' ||
          !hostIsReserved ||
          url.username !== '' ||
          url.password !== '' ||
          url.search !== '' ||
          url.hash !== ''
        ) {
          violations.push(`${childPath}: URL is not a credential-free reserved fixture URL`);
        }
      }
    }
    validateValue(child, childPath, violations);
  }
}

export async function verifyPageActionFixtures(
  root = PAGE_ACTION_FIXTURE_ROOT,
  options = {},
) {
  const violations = [];
  const inventory = await fixtureFiles(root, violations);
  root = inventory.root;
  const files = inventory.files;
  const parsed = new Map();
  const bytesByRelativePath = new Map();

  if (typeof options.afterInventory === 'function') {
    await options.afterInventory({
      root,
      files: files.map((entry) => entry.relativePath),
    });
  }

  for (const file of files) {
    const relativePath = file.relativePath;
    const bytes = await readVerifiedFixtureFile(file, inventory, violations);
    if (bytes === undefined) continue;
    bytesByRelativePath.set(relativePath, bytes);
    let raw;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      violations.push(`${relativePath}: file is not valid UTF-8 (${String(error)})`);
      continue;
    }
    validateText(raw, relativePath, violations);
    try {
      const value = JSON.parse(raw);
      parsed.set(relativePath, value);
      validateValue(value, relativePath, violations);
    } catch (error) {
      violations.push(`${relativePath}: invalid JSON (${String(error)})`);
    }
  }

  const finalInventory = await fixtureFiles(root, violations);
  if (!inventoriesEqual(inventory, finalInventory)) {
    violations.push('fixture root: inventory identity changed during verification');
  }

  const actualFiles = [...bytesByRelativePath.keys()].sort();
  for (const relativePath of actualFiles) {
    if (!EXPECTED_FIXTURE_FILES.includes(relativePath)) {
      violations.push(`${relativePath}: unexpected fixture file; only the explicit JSON corpus is allowed`);
    }
  }
  for (const relativePath of EXPECTED_FIXTURE_FILES) {
    if (!bytesByRelativePath.has(relativePath)) {
      violations.push(`${relativePath}: expected fixture file is missing`);
    }
  }

  const receipt = parsed.get(RECEIPT_FILE);
  if (receipt === undefined || receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    violations.push(`${RECEIPT_FILE}: missing machine-readable receipt`);
  } else {
    validateExactKeys(
      receipt,
      ['schema', 'fixtureSetId', 'algorithm', 'encoding', 'generatedAt', 'files'],
      RECEIPT_FILE,
      violations,
    );
    if (receipt.schema !== RECEIPT_SCHEMA) {
      violations.push(`${RECEIPT_FILE}: unexpected schema`);
    }
    if (receipt.fixtureSetId !== FIXTURE_SET_ID) {
      violations.push(`${RECEIPT_FILE}: unexpected fixtureSetId`);
    }
    if (receipt.generatedAt !== FIXTURE_TIMESTAMP) {
      violations.push(`${RECEIPT_FILE}: unexpected generatedAt`);
    }
    if (receipt.algorithm !== 'sha256' || receipt.encoding !== 'raw-file-bytes') {
      violations.push(`${RECEIPT_FILE}: unsupported digest declaration`);
    }
    const listed = receipt.files;
    if (listed === null || typeof listed !== 'object' || Array.isArray(listed)) {
      violations.push(`${RECEIPT_FILE}: files must be an object`);
    } else {
      const expectedPaths = [...bytesByRelativePath.keys()]
        .filter((name) => name !== RECEIPT_FILE)
        .sort();
      const listedPaths = Object.keys(listed).sort();
      if (JSON.stringify(listedPaths) !== JSON.stringify(expectedPaths)) {
        violations.push(`${RECEIPT_FILE}: file inventory does not exactly match fixture corpus`);
      }
      for (const relativePath of expectedPaths) {
        const declared = listed[relativePath];
        if (typeof declared !== 'string' || !HASH_PATTERN.test(declared)) {
          violations.push(`${RECEIPT_FILE}: invalid digest for ${relativePath}`);
          continue;
        }
        const actual = sha256(bytesByRelativePath.get(relativePath));
        if (declared !== actual) {
          violations.push(`${RECEIPT_FILE}: digest mismatch for ${relativePath}`);
        }
      }
    }
  }

  const manifest = parsed.get(MANIFEST_FILE);
  if (
    manifest === undefined ||
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.fixtures === null ||
    typeof manifest.fixtures !== 'object' ||
    Array.isArray(manifest.fixtures)
  ) {
    violations.push(`${MANIFEST_FILE}: fixtures must be an object`);
  } else {
    validateExactKeys(
      manifest,
      [
        'schema',
        'fixtureSetId',
        'createdAt',
        'source',
        'sanitizationPolicy',
        'fixtures',
      ],
      MANIFEST_FILE,
      violations,
    );
    if (manifest.schema !== MANIFEST_SCHEMA) {
      violations.push(`${MANIFEST_FILE}: unexpected schema`);
    }
    if (manifest.fixtureSetId !== FIXTURE_SET_ID) {
      violations.push(`${MANIFEST_FILE}: unexpected fixtureSetId`);
    }
    if (manifest.createdAt !== FIXTURE_TIMESTAMP) {
      violations.push(`${MANIFEST_FILE}: unexpected createdAt`);
    }
    if (manifest.source !== 'synthetic-structural-derivative-no-raw-values') {
      violations.push(`${MANIFEST_FILE}: unexpected sanitization source declaration`);
    }
    validateExactRecord(
      manifest.sanitizationPolicy,
      EXPECTED_SANITIZATION_POLICY,
      `${MANIFEST_FILE}.sanitizationPolicy`,
      violations,
    );
    if (isRecord(receipt) && receipt.fixtureSetId !== manifest.fixtureSetId) {
      violations.push(`${RECEIPT_FILE}: fixtureSetId does not match ${MANIFEST_FILE}`);
    }
    const declaredPayloads = Object.keys(manifest.fixtures).sort();
    const actualPayloads = [...bytesByRelativePath.keys()]
      .filter((name) => name !== RECEIPT_FILE && name !== MANIFEST_FILE)
      .sort();
    if (JSON.stringify(declaredPayloads) !== JSON.stringify(actualPayloads)) {
      violations.push(`${MANIFEST_FILE}: fixture inventory does not exactly match payload files`);
    }

    const normalizedPayloads = new Map();
    for (const relativePath of EXPECTED_PAYLOAD_FILES) {
      const declaration = manifest.fixtures[relativePath];
      validateExactRecord(
        declaration,
        EXPECTED_MANIFEST_FIXTURES[relativePath],
        `${MANIFEST_FILE}.fixtures.${relativePath}`,
        violations,
      );
      const payload = parsed.get(relativePath);
      if (payload === undefined) continue;
      try {
        const normalized = normalizeFixtureWirePayload(relativePath, declaration, payload);
        if (!isDeepStrictEqual(normalized, payload)) {
          violations.push(`${relativePath}: payload is not canonical under the current collector contract`);
        }
        normalizedPayloads.set(relativePath, normalized);
        validatePayloadActionMapping(
          relativePath,
          declaration,
          normalized,
          violations,
        );
      } catch (error) {
        violations.push(`${relativePath}: current collector contract rejected payload (${String(error)})`);
      }
    }
    validateSearchFixtureCorrelation(normalizedPayloads, violations);
  }

  if (violations.length > 0) {
    throw new Error(`PageAction fixture gate failed:\n${violations.join('\n')}`);
  }

  return {
    root,
    files: [...parsed.keys()].sort(),
    parsed,
    verifiedPayloadCount: EXPECTED_PAYLOAD_FILES.length,
  };
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = await verifyPageActionFixtures();
    process.stdout.write(`${JSON.stringify({
      schema: 'collector.page-action.fixture-verification.v1',
      status: 'passed',
      fixtureRoot: path.relative(process.cwd(), result.root),
      parsedJsonFiles: result.files.length,
      verifiedPayloadCount: result.verifiedPayloadCount,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
