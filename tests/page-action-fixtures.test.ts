import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeCollectorWireResponseV1,
  normalizePageActionExecuteResponseV1,
} from '../src/collection/page-action-contracts.js';
import {
  PAGE_ACTION_FIXTURE_ROOT,
  verifyPageActionFixtures,
} from '../scripts/verify_page_action_fixtures.mjs';

interface FixtureBatch {
  kind: string;
  status: string;
  scope: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  completeness: {
    observedPages: number[];
    state: string;
  };
  checkpoint?: {
    nextPage?: number;
    completedPages: number[];
    scope: Record<string, unknown>;
  };
  metrics: Record<string, number>;
}

const temporaryFixtureParents: string[] = [];

async function temporaryFixtureRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'page-action-fixtures-'));
  const root = path.join(parent, 'fixtures');
  temporaryFixtureParents.push(parent);
  await cp(PAGE_ACTION_FIXTURE_ROOT, root, { recursive: true });
  return { parent, root };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

function setNested(
  value: Record<string, unknown>,
  pathSegments: readonly string[],
  replacement: unknown,
): void {
  let target = value;
  for (const segment of pathSegments.slice(0, -1)) {
    target = target[segment] as Record<string, unknown>;
  }
  target[pathSegments.at(-1)!] = replacement;
}

async function refreshReceipt(root: string): Promise<void> {
  const receiptFile = path.join(root, 'sha256-receipt.json');
  const receipt = await readJson(receiptFile) as {
    files: Record<string, string>;
  };
  for (const name of Object.keys(receipt.files)) {
    const bytes = await readFile(path.join(root, name));
    receipt.files[name] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  await writeJson(receiptFile, receipt);
}

afterEach(async () => {
  await Promise.all(
    temporaryFixtureParents.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function fixtures() {
  const verified = await verifyPageActionFixtures();
  const fixture = (name: string): FixtureBatch => {
    const value = verified.parsed.get(name);
    if (value === undefined) throw new Error(`Missing fixture ${name}`);
    return value as FixtureBatch;
  };
  return { verified, fixture };
}

describe('sanitized PageAction fixture gate', () => {
  it('parses every JSON file, rejects sensitive identities, and verifies raw-byte hashes', async () => {
    const { verified } = await fixtures();
    expect(verified.files).toEqual([
      'manifest.json',
      'offer-detail.json',
      'search-list-page-1.json',
      'search-list-page-2-terminal.json',
      'sha256-receipt.json',
      'store-qualification.json',
      'store-sample-page-action-response.json',
      'store-sample-pages-1-3.json',
    ]);
    expect(verified.verifiedPayloadCount).toBe(6);
  });

  it('dual-read normalizes bare CollectionBatch V1 and strict PageAction responses', async () => {
    const { verified } = await fixtures();
    const manifest = verified.parsed.get('manifest.json') as {
      fixtures: Record<string, { wireFormat: string }>;
    };
    for (const [name, declaration] of Object.entries(manifest.fixtures)) {
      const payload = verified.parsed.get(name);
      expect(normalizeCollectorWireResponseV1(payload)).toEqual(payload);
      if (declaration.wireFormat === 'collector.page-action.execute-response.v1') {
        expect(normalizePageActionExecuteResponseV1(payload)).toEqual(payload);
      } else {
        expect(declaration.wireFormat).toBe('collection-batch-v1');
      }
    }
  });

  it('keeps the strict PageAction response receipt-complete and batch-preserving', async () => {
    const { verified } = await fixtures();
    const payload = verified.parsed.get('store-sample-page-action-response.json');
    const response = normalizePageActionExecuteResponseV1(payload);

    expect(response.executionAttemptReceipt).toMatchObject({
      actionKind: 'store-sample',
      outcome: 'completed',
      terminal: true,
    });
    expect(response.completionReceipt).toMatchObject({
      actionKind: 'store-sample',
      status: 'completed',
      terminal: true,
    });
    expect(response.completionReceipt?.batches).toEqual(
      response.executionAttemptReceipt.batches,
    );
  });

  it('correlates page 1 and page 2 before publishing a source-end terminal search result', async () => {
    const { fixture } = await fixtures();
    const page1 = fixture('search-list-page-1.json');
    const page2 = fixture('search-list-page-2-terminal.json');
    const correlationFields = [
      'searchQueryKey',
      'querySnapshotHash',
      'searchSegmentId',
      'pageActionId',
    ];

    for (const field of correlationFields) {
      expect(page2.scope[field]).toBe(page1.scope[field]);
    }
    expect(page1.scope).toMatchObject({ page: 1, terminal: false, terminalReason: null });
    expect(page2.scope).toMatchObject({
      page: 2,
      terminal: true,
      terminalReason: 'source-end',
    });
    expect(page2.completeness).toMatchObject({ state: 'complete', observedPages: [1, 2] });
    const offerIds = [...page1.observations, ...page2.observations]
      .map((entry) => entry.offerId);
    expect(new Set(offerIds).size).toBe(3);
  });

  it('preserves explicit SKU identity and media ownership without network credentials', async () => {
    const { fixture } = await fixtures();
    const batch = fixture('offer-detail.json');
    const observation = batch.observations[0]!;
    const skuManifest = observation.skuManifest as {
      state: string;
      explicitSkuCount: number;
      items: Array<{ skuId: string }>;
    };
    const mediaSources = observation.mediaSources as Array<{
      role: string;
      ownerKind: string;
      offerId: string;
      platformSkuId?: string;
    }>;

    expect(skuManifest.state).toBe('explicit-variants');
    expect(skuManifest.items.map((entry) => entry.skuId)).toEqual([
      'fixture-sku-001',
      'fixture-sku-002',
    ]);
    expect(skuManifest.explicitSkuCount).toBe(skuManifest.items.length);
    expect(mediaSources.map((entry) => entry.role)).toEqual([
      'main',
      'gallery',
      'sku',
      'detail',
    ]);
    expect(mediaSources.find((entry) => entry.role === 'sku')).toMatchObject({
      ownerKind: 'target-sku',
      offerId: 'fixture-offer-001',
      platformSkuId: 'fixture-sku-001',
    });
  });

  it('keeps qualification coverage explicit and tied to the sanitized store identity', async () => {
    const { fixture } = await fixtures();
    const batch = fixture('store-qualification.json');
    const observation = batch.observations[0]!;
    const sources = observation.qualificationMediaSources as Array<Record<string, unknown>>;

    expect(observation).toMatchObject({
      memberId: 'fixture-member-001',
      qualificationMediaSourceCoverage: 'complete',
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      role: 'qualification',
      ownerKind: 'store-qualification',
      memberId: 'fixture-member-001',
    });
  });

  it('completes bounded store pages 1-3 while keeping page 4 dormant and unfetched', async () => {
    const { fixture } = await fixtures();
    const batch = fixture('store-sample-pages-1-3.json');

    expect(batch.scope).toMatchObject({
      mode: 'phase-1-bounded',
      firstPage: 1,
      lastPageInclusive: 3,
      checkpointState: 'dormant',
    });
    expect(batch.observations.map((entry) => entry.page)).toEqual([1, 2, 3]);
    expect(batch.checkpoint).toMatchObject({
      nextPage: 4,
      completedPages: [1, 2, 3],
      scope: { checkpointState: 'dormant' },
    });
    expect(batch.metrics).toMatchObject({ dormantNextPage: 4, page4Requests: 0 });
    expect(batch.completeness).toMatchObject({ state: 'complete', observedPages: [1, 2, 3] });
  });

  it('rejects a non-JSON file even when its secrets would previously have escaped inventory', async () => {
    const { root } = await temporaryFixtureRoot();
    await writeFile(
      path.join(root, 'leak.env'),
      'AWS_SECRET_ACCESS_KEY=live-secret\nSOURCE=https://detail.1688.com/offer/1\n',
    );

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /leak\.env: unexpected fixture file/u,
    );
  });

  it('rejects a file added after the checked inventory', async () => {
    const { root } = await temporaryFixtureRoot();

    await expect(verifyPageActionFixtures(root, {
      afterInventory: async () => {
        await writeFile(
          path.join(root, 'late-leak.env'),
          'AWS_SECRET_ACCESS_KEY=production-secret\n',
        );
      },
    })).rejects.toThrow(/fixture root: inventory identity changed during verification/u);
  });

  it('rejects a file removed after the checked inventory', async () => {
    const { root } = await temporaryFixtureRoot();

    await expect(verifyPageActionFixtures(root, {
      afterInventory: async () => {
        await rm(path.join(root, 'offer-detail.json'));
      },
    })).rejects.toThrow(/fixture root: inventory identity changed during verification/u);
  });

  it('rejects a symlink instead of hashing a payload outside the fixture root', async () => {
    const { parent, root } = await temporaryFixtureRoot();
    const external = path.join(parent, 'outside.json');
    await writeJson(external, { note: 'fixture-external-payload' });
    await symlink(external, path.join(root, 'linked.json'));

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /linked\.json: symbolic links are not allowed/u,
    );
  });

  it('rejects a same-byte path replacement after the checked inventory', async () => {
    const { parent, root } = await temporaryFixtureRoot();
    const target = path.join(root, 'offer-detail.json');
    const original = path.join(parent, 'offer-detail-original.json');

    await expect(verifyPageActionFixtures(root, {
      afterInventory: async () => {
        await rename(target, original);
        await writeFile(target, await readFile(original));
      },
    })).rejects.toThrow(/offer-detail\.json: file identity changed before read/u);
  });

  it('rejects replacement of the fixture root after inventory', async () => {
    const { parent, root } = await temporaryFixtureRoot();
    const originalRoot = path.join(parent, 'fixtures-original');

    await expect(verifyPageActionFixtures(root, {
      afterInventory: async () => {
        await rename(root, originalRoot);
        await cp(originalRoot, root, { recursive: true });
      },
    })).rejects.toThrow(/fixture root: directory identity changed before file open/u);
  });

  it('scans decoded strings for escaped production 1688 hosts regardless of key name', async () => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    offer.endpoint = 'https://detail.1688.com/offer/123';
    const escaped = `${JSON.stringify(offer, null, 2)}\n`.replace(
      'https://detail.1688.com',
      'https:\\/\\/detail.1688.com',
    );
    await writeFile(offerFile, escaped);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json\.endpoint: production-1688-host/u,
    );
  });

  it('keeps the strict-contract shop sentinel confined to canonicalShopUrl', async () => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = 'https://fixture-store.1688.com/';
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json\.observations\[0\]\.core\.title: production-1688-host/u,
    );
  });

  it.each([
    'source detail.1688.com./offer/123',
    'source HTTPS://DETAIL.1688.COM.:443/offer/123',
    'source https://detail%2e1688%2ecom/offer/123',
  ])('rejects a canonical production host spelling: %s', async (title) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = title;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json\.observations\[0\]\.core\.title: production-1688-host/u,
    );
  });

  it('rejects an unformatted E.164 personal phone string', async () => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = 'fixture contact +12025550123';
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json\.observations\[0\]\.core\.title: e164-phone-number/u,
    );
  });

  it.each([
    '+86 138 0013 8000',
    '+86 (138) 0013-8000',
    '138 0013 8000',
  ])('rejects a separator-formatted mainland phone string: %s', async (phone) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{ core: { title: string } }>;
    observations[0]!.core.title = `fixture contact ${phone}`;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /mainland-phone-number/u,
    );
  });

  it.each([
    [
      'numeric host entities',
      'source https://detail&#46;1688&#x2e;com/offer/123',
      'production-1688-host',
    ],
    [
      'named host entities',
      'source https&colon;&sol;&sol;detail&period;1688&period;com/offer/123',
      'production-1688-host',
    ],
    [
      'encoded credential assignment',
      'token&#x3d;production-token-secret',
      'credential-assignment',
    ],
  ])('rejects %s after repeated HTML decoding', async (_label, title, expected) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{ core: { title: string } }>;
    observations[0]!.core.title = title;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      new RegExp(expected, 'u'),
    );
  });

  it('rejects credential assignments embedded in an otherwise valid product string', async () => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = 'Cookie : sessionid=production-session-secret';
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json\.observations\[0\]\.core\.title: credential-assignment/u,
    );
  });

  it.each([
    ['Set-Cookie', 'Set-Cookie = production-cookie-secret'],
    ['session', 'session id : production-session-secret'],
    ['token', 'ToKeN=production-token-secret'],
    ['access token', 'accessToken=production-access-token-secret'],
    ['auth token', 'authToken = production-auth-token-secret'],
    ['signature', 'Signature : production-signature-secret'],
    ['auth', 'AuTh = production-auth-secret'],
    ['bearer', 'Bearer: production-bearer-secret'],
    ['password', 'password = production-password-secret'],
    ['nested password', 'note=password=production-password-secret'],
    ['credential', 'credential: production-credential-secret'],
    ['key', 'api_key = production-api-key-secret'],
    ['private key', 'privateKey = production-private-key-secret'],
    ['cloud key', 'AWS_SECRET_ACCESS_KEY=production-cloud-secret'],
    ['secret', 'secret: production-secret-value'],
    ['camel password', 'dbPassword=production-password-secret'],
    ['snake token', 'request_token=production-token-secret'],
    ['kebab cookie', 'session-cookie=production-cookie-secret'],
    ['session composite', 'browserSession=production-session-secret'],
    ['auth composite', 'requestAuth=production-auth-secret'],
    ['sign composite', 'requestSign=production-sign-secret'],
    ['bearer composite', 'bearerToken=production-bearer-secret'],
    ['cloud composite', 'cloudKey=production-cloud-secret'],
    ['dotted credential', 'cloud.credential=production-cloud-secret'],
    ['private composite', 'privateKeyContents=production-private-key'],
  ])('rejects a case/spacing variant of a %s assignment', async (_label, title) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = title;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /credential-assignment/u,
    );
  });

  it.each([
    'fixture secret token key holder with cookie jar',
    'fixture product key: brass',
    'fixture keyboard key = brass',
    'fixture token holder: brass',
    'fixture secret: garden key holder',
  ])('does not treat ordinary product prose as a credential assignment: %s', async (title) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    const observations = offer.observations as Array<{
      core: { title: string };
    }>;
    observations[0]!.core.title = title;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).resolves.toMatchObject({
      verifiedPayloadCount: 6,
    });
  });

  it.each([
    ['schema', 'schema', 'collector.page-action.sanitized-fixture-manifest.v999', 'unexpected schema'],
    ['fixture set', 'fixtureSetId', 'fixture-unrelated-set', 'unexpected fixtureSetId'],
    ['action kind', 'actionKind', 'search-list', 'actionKind: value does not match'],
    ['sanitization policy', 'requestCredentials', 'retained', 'requestCredentials: value does not match'],
    ['extra field', 'extraManifestField', 'fixture-extra', 'fields do not exactly match'],
  ])('rejects a rehashed manifest with a changed %s', async (_label, field, value, message) => {
    const { root } = await temporaryFixtureRoot();
    const manifestFile = path.join(root, 'manifest.json');
    const manifest = await readJson(manifestFile);
    if (field === 'actionKind') {
      const fixtures = manifest.fixtures as Record<
        string,
        Record<string, unknown>
      >;
      fixtures['offer-detail.json']!.actionKind = value;
    } else if (field === 'requestCredentials') {
      const policy = manifest.sanitizationPolicy as Record<string, unknown>;
      policy.requestCredentials = value;
    } else {
      manifest[field] = value;
    }
    await writeJson(manifestFile, manifest);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      new RegExp(message, 'u'),
    );
  });

  it('binds the receipt fixture set to the frozen manifest fixture set', async () => {
    const { root } = await temporaryFixtureRoot();
    const receiptFile = path.join(root, 'sha256-receipt.json');
    const receipt = await readJson(receiptFile);
    receipt.fixtureSetId = 'fixture-unrelated-set';
    await writeJson(receiptFile, receipt);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /sha256-receipt\.json: unexpected fixtureSetId/u,
    );
  });

  it('binds each manifest action kind to the normalized payload action kind', async () => {
    const { root } = await temporaryFixtureRoot();
    await writeFile(
      path.join(root, 'offer-detail.json'),
      await readFile(path.join(root, 'search-list-page-1.json')),
    );
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json: normalized payload actionKind does not match manifest declaration/u,
    );
  });

  it('binds each search fixture file to its declared page role', async () => {
    const { root } = await temporaryFixtureRoot();
    await writeFile(
      path.join(root, 'search-list-page-2-terminal.json'),
      await readFile(path.join(root, 'search-list-page-1.json')),
    );
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /search-list-page-2-terminal\.json: search fixture page does not match its declared file role/u,
    );
  });

  it.each([
    ['searchQueryKey', 'fixture-search-query-999'],
    ['querySnapshotHash', `sha256:${'9'.repeat(64)}`],
    ['searchSegmentId', 'fixture-search-segment-999'],
    ['pageActionId', 'fixture-page-action-search-999'],
  ])('binds terminal search correlation field %s to page 1', async (field, value) => {
    const { root } = await temporaryFixtureRoot();
    const page2File = path.join(root, 'search-list-page-2-terminal.json');
    const page2 = await readJson(page2File);
    const scope = page2.scope as Record<string, unknown>;
    scope[field] = value;
    await writeJson(page2File, page2);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      new RegExp(`search fixtures: correlated ${field} values do not match`, 'u'),
    );
  });

  it.each([
    ['unitId', ['unitId'], 'fixture-unit-search-999', 'correlated unitId'],
    ['sourceRequestId', ['sourceRequestId'], 'fixture-request-search-999', 'correlated sourceRequestId'],
    ['requested scope', ['scope', 'requestedScope'], 'page', 'correlated scope requestedScope'],
    ['requested range', ['scope', 'requestedEndPage'], 3, 'correlated scope requestedEndPage'],
    [
      'advertisement policy',
      ['scope', 'advertisementPolicy'],
      'include_promoted',
      'correlated scope advertisementPolicy',
    ],
    [
      'filter hash',
      ['observations', '0', 'filtersHash'],
      `sha256:${'8'.repeat(64)}`,
      'correlated observation filtersHash',
    ],
    ['sort', ['observations', '0', 'sort'], 'sales', 'correlated observation sort'],
    [
      'task',
      ['observations', '0', 'collectionTaskId'],
      'fixture-collection-task-999',
      'correlated observation collectionTaskId',
    ],
    [
      'wave',
      ['observations', '0', 'searchWaveId'],
      'fixture-search-wave-999',
      'correlated observation searchWaveId',
    ],
  ])('rejects cross-page %s divergence', async (_label, pathSegments, value, expected) => {
    const { root } = await temporaryFixtureRoot();
    const page2File = path.join(root, 'search-list-page-2-terminal.json');
    const page2 = await readJson(page2File);
    setNested(page2, pathSegments, value);
    await writeJson(page2File, page2);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      new RegExp(expected, 'u'),
    );
  });

  it('rejects a different page-2 keyword even when its observation agrees locally', async () => {
    const { root } = await temporaryFixtureRoot();
    const page2File = path.join(root, 'search-list-page-2-terminal.json');
    const page2 = await readJson(page2File);
    (page2.subject as Record<string, unknown>).keyword = 'fixture-other-keyword';
    ((page2.observations as Array<Record<string, unknown>>)[0]!).keyword =
      'fixture-other-keyword';
    await writeJson(page2File, page2);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /correlated subject keyword values do not match/u,
    );
  });

  it.each([
    ['AWS access key', 'awsAccessKeyId', 'AKIAIOSFODNN7EXAMPLE', 'credential'],
    ['client secret', 'clientSecret', 'sk_live_counterexample', 'credential'],
    ['database password', 'dbPassword', 'production-password-secret', 'credential'],
    ['cookie jar', 'cookieJar', 'production-cookie-secret', 'credential'],
    [
      'private key',
      'privateKey',
      '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
      'credential',
    ],
    ['full name', 'fullName', 'Jane Doe', 'personal-data'],
    ['telephone', 'telephone', '+1-202-555-0123', 'personal-data'],
    ['street address', 'streetAddress', '100 Main Street', 'personal-data'],
  ])('rejects a rehashed payload containing a %s field', async (_label, key, value, reason) => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    offer[key] = value;
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      new RegExp(`offer-detail\\.json\\.${key}: forbidden ${reason} field`, 'u'),
    );
  });

  it('rejects a contract-invalid payload even when its receipt hash is current', async () => {
    const { root } = await temporaryFixtureRoot();
    const offerFile = path.join(root, 'offer-detail.json');
    const offer = await readJson(offerFile);
    offer.observations = 'fixture-not-an-array';
    await writeJson(offerFile, offer);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /offer-detail\.json: current collector contract rejected payload/u,
    );
  });

  it('rejects a rehashed corpus when an envelope receipt is tampered internally', async () => {
    const { root } = await temporaryFixtureRoot();
    const envelopeFile = path.join(root, 'store-sample-page-action-response.json');
    const envelope = await readJson(envelopeFile);
    const attempt = envelope.executionAttemptReceipt as Record<string, unknown>;
    (attempt.metrics as Record<string, unknown>).remoteRequests = 2;
    await writeJson(envelopeFile, envelope);
    await refreshReceipt(root);

    await expect(verifyPageActionFixtures(root)).rejects.toThrow(
      /current collector contract rejected payload.*execution receipt content hash/isu,
    );
  });
});
