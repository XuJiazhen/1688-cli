import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import {
  canonicalCollectorSha256V1,
  computeExecutionLineageHashV1,
  computeLogicalLineageHashV1,
  normalizePageActionExecuteResponseV1,
  type CanonicalSearchRequestV1,
  type PageActionExecuteResponseV1,
  type PageActionRequestV1,
} from '../src/collection/page-action-contracts.js';
import { ProductionPageActionExecutor } from '../src/daemon/production-page-action-executor.js';
import type {
  PageActionExecutionScope,
  PageActionExecutor,
} from '../src/daemon/supervisor-runtime.js';
import {
  assertCollectorRawArchiveV1,
  type CollectorRawArchiveV1,
} from '../src/session/collector-raw-archive.js';
import {
  assertOfferSourceSidecarBindingV1,
  type OfferSourceSidecarV1,
} from '../src/session/offer-evidence.js';
import {
  compileSearchPageRequestV1,
  compileSearchParameterSetV1,
  verifyParameterSetHash,
  type CanonicalSearchParameterSetV1,
} from '../src/session/search-compiler.js';
import { SEARCH_MTOP_API } from '../src/session/search-mtop.js';
import { SUPPLIER_QUALIFICATION_COMPONENT_KEY } from '../src/session/supplier-qualification.js';

export const RUNTIME_PAGE_ACTION_FIXTURE_SCHEMA =
  'collector.runtime-derived-page-action-fixture-set.v1' as const;
export const RUNTIME_PAGE_ACTION_FIXTURE_GENERATOR_REVISION =
  'production-page-action-executor-offline-fake-v1@1' as const;
export const DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT = fileURLToPath(
  new URL('../tests/fixtures/page-actions-runtime-v1', import.meta.url),
);

const FIXED_NOW = '2026-08-02T00:00:00.000Z';
const ACTION_KINDS = [
  'search-list',
  'offer-detail',
  'store-qualification',
  'store-sample',
] as const;
export type RuntimeOfflinePageActionKind = (typeof ACTION_KINDS)[number];
type ActionKind = RuntimeOfflinePageActionKind;

export const RUNTIME_OFFLINE_PAGE_ACTION_SCENARIOS = [
  'chain-coherent-available-v1',
  'chain-coherent-technical-failure-v1',
] as const;
export type RuntimeOfflinePageActionScenario =
  (typeof RUNTIME_OFFLINE_PAGE_ACTION_SCENARIOS)[number];

const EXPECTED_COMPONENTS = Object.freeze({
  'search-list': [
    { component: 'search_origin', completenessProfile: 'eligible_observation_set_v1' },
  ],
  'offer-detail': [
    { component: 'offer_consignment', completenessProfile: 'offer_scoped_source_terminal_v1' },
    { component: 'offer_detail', completenessProfile: 'required_fields_v1' },
    { component: 'offer_media_manifest', completenessProfile: 'ordered_remote_refs_v1' },
    { component: 'offer_shop_card_observation', completenessProfile: 'offer_scoped_source_terminal_v1' },
    { component: 'sku_manifest', completenessProfile: 'complete_variant_set_v1' },
    { component: 'store_card_source_state', completenessProfile: 'offer_detail_card_terminal_v1' },
    { component: 'store_profile', completenessProfile: 'offer_card_subset_v1' },
  ],
  'store-qualification': [
    { component: 'qualification_media_manifest', completenessProfile: 'ordered_remote_refs_v1' },
    { component: 'store_card_source_state', completenessProfile: 'business_info_card_terminal_v1' },
    { component: 'store_profile', completenessProfile: 'business_card_subset_v1' },
    { component: 'store_qualification', completenessProfile: 'business_info_v1' },
  ],
  'store-sample': [
    { component: 'store_card_source_state', completenessProfile: 'wangpu_header_card_terminal_v1' },
    { component: 'store_catalog_sample', completenessProfile: 'bounded_first_pages_v1' },
    { component: 'store_categories', completenessProfile: 'category_tree_same_response_v1' },
    { component: 'store_profile', completenessProfile: 'wangpu_header_subset_v1' },
  ],
} satisfies Readonly<Record<ActionKind, readonly {
  component: string;
  completenessProfile: string;
}[]>>);

const SEARCH_INPUT = Object.freeze({
  keyword: 'runtime fixture drill',
  offerId: '700000000101',
    memberId: 'fixture-chain-member-1',
  response: {
    ret: ['SUCCESS::ok'],
    data: {
      code: 200,
      success: true,
      data: {
        OFFER: {
          items: [{
            data: {
              offerId: '700000000101',
              title: 'Runtime Fixture Drill',
              priceInfo: { price: '12.50' },
              memberId: 'fixture-chain-member-1',
              loginId: 'fixture-search-login-1',
              isP4P: 'false',
              winPortUrl: 'https://fixture-search-store.1688.com/',
              shop: { text: 'Runtime Fixture Store', tpYear: '3' },
              shopAddition: {
                shopLinkUrl: 'https://fixture-search-store.1688.com/',
              },
            },
          }],
          hasMore: false,
          found: 1,
        },
      },
    },
  },
});

const OFFER_INPUT = Object.freeze({
  offerId: '700000000101',
  memberId: 'fixture-chain-member-1',
  coreHtml: '<html><body>runtime fixture offer core</body></html>',
  skuResponse: {
    ret: ['SUCCESS::ok'],
    data: {
      skuSelectorBizModel: {
        skuPriceScale: '8.00-10.00',
        skuProps: [{
          prop: 'variant',
          value: [{
            name: 'fixture-a',
            imageUrl: 'https://img.example.test/runtime-offer-sku-a.jpg',
          }],
        }],
        skuInfoMap: {
          'fixture-a': {
            skuId: 'runtime-sku-1',
            specAttrs: 'variant:fixture-a',
            price: '8.00',
            canBookCount: '25',
            saleCount: 4,
          },
        },
        skuSelectorModel: {
          tradeModel: {
            beginAmount: 1,
            unit: 'piece',
            offerPriceModel: {
              currentPrices: [{ beginAmount: 1, price: '8.00' }],
            },
          },
        },
      },
    },
  },
  shopCardResponse: {
    ret: ['SUCCESS::ok'],
    data: {
      offerId: '700000000101',
      memberId: 'fixture-chain-member-1',
      model: {
        shopName: 'Runtime Fixture Offer Store',
        shopType: 'factory',
        mainCategoryName: 'Tools',
        shopUrl: 'https://fixture-offer-store.1688.com/',
        tpYear: 3,
        shopData: [{ dataKey: 'service score', dataValue: '4.8' }],
      },
    },
  },
  consignmentResponse: {
    ret: ['SUCCESS::ok'],
    data: {
      offerId: '700000000101',
      memberId: 'fixture-chain-member-1',
      data: {
        data: {
          data: {
            name: 'Runtime Fixture Consignment',
            priceInfoList: [{ price: '8.00', text: '1 piece price' }],
            adviseList: [{
              key: 'offerDelivery48hRate',
              name: '48h delivery rate',
              value: '98%',
            }],
          },
        },
      },
    },
  },
  detailScript:
    'var offer_details={content:\'<h2>Runtime fixture detail</h2><img src="https://img.example.test/runtime-detail.jpg">\'};',
  pageInfo: {
    title: 'Runtime Fixture Offer',
    supplierName: 'Runtime Fixture Offer Store',
    sellerLoginId: 'fixture-offer-login-1',
    sellerMemberId: 'fixture-chain-member-1',
    sellerUserId: 'fixture-user-1',
    saledCount: null,
    mainImage: 'https://img.example.test/runtime-main.jpg',
    images: [
      'https://img.example.test/runtime-main.jpg',
      'https://img.example.test/runtime-gallery.jpg',
    ],
    sendArea: 'fixture-region',
    province: null,
    city: null,
    categoryId: 'fixture-category-1',
    detailUrl: 'https://itemcdn.tmall.com/1688offer/runtime-fixture-detail',
    attributes: [{ name: 'material', value: 'fixture-alloy' }],
    packageInfo: [],
  },
});

const QUALIFICATION_INPUT = Object.freeze({
  memberId: 'fixture-chain-member-1',
  response: {
    ret: ['SUCCESS::ok'],
    data: {
      memberId: 'fixture-chain-member-1',
      companyName: 'Runtime Fixture Qualification Store',
      sellerType: 'manufacturer',
      productionService: 'fixture assembly',
      businessLine: 'fixture tools',
      strengthSignals: [{ code: 'fixture-factory', enabled: true }],
      guaranteeItems: [{ code: 'fixture-return', status: 'enabled' }],
      certList: [{
        certName: 'Runtime Fixture Certificate',
        certType: 'fixture-certificate',
        imgUrl: 'https://img.example.test/runtime-certificate.jpg',
      }],
      businessInfo: {
        companyBusinessLine: 'Fixture tool production and distribution.',
        companyYearStarted: '2020-01-01',
      },
      propaganda: { companyImg: [] },
    },
  },
});

const STORE_INPUT = Object.freeze({
  memberId: 'fixture-chain-member-1',
  canonicalShopUrl: 'https://fixture-store.1688.com/',
  headerResponse: {
    api: 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService',
    ret: ['SUCCESS::ok'],
    data: {
      success: true,
      data: {
        memberId: 'fixture-chain-member-1',
        companyName: 'Runtime Fixture Store Header',
        commonUrl: { shopUrl: 'https://fixture-store.1688.com/' },
        mainCate: 'Tools',
        tpYear: '3 years',
      },
    },
  },
  pages: [1, 2, 3].map((pageNumber) => ({
    pageNumber,
    response: {
      ret: ['SUCCESS::ok'],
      data: {
        content: {
          offerCount: 90,
          totalPages: 3,
          offerList: [{
            id: `70000000020${pageNumber}`,
            memberId: 'fixture-chain-member-1',
            subject: `Runtime Fixture Store Offer ${pageNumber}`,
            offerImages: [`https://img.example.test/runtime-store-${pageNumber}.jpg`],
          }],
          offerCategoryDataModel: {
            offerCategoryList: [{ id: 'fixture-cat-1', name: 'Tools', count: 90 }],
          },
        },
      },
    },
  })),
});

const TRANSPORT_INPUTS: Readonly<Record<ActionKind, unknown>> = Object.freeze({
  'search-list': SEARCH_INPUT,
  'offer-detail': OFFER_INPUT,
  'store-qualification': QUALIFICATION_INPUT,
  'store-sample': STORE_INPUT,
});

interface FileReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ActionManifest {
  readonly actionKind: ActionKind;
  readonly expectedComponents: readonly {
    readonly component: string;
    readonly completenessProfile: string;
  }[];
  readonly transportInputPath: string;
  readonly transportInputSha256: string;
  readonly responsePath: string;
  readonly responseSha256: string;
  readonly executionEnvelopePath: string;
  readonly executionEnvelopeSha256: string;
  readonly completionEnvelopePath: string;
  readonly completionEnvelopeSha256: string;
  readonly batchFiles: readonly FileReceipt[];
  readonly archiveFiles: readonly FileReceipt[];
}

export interface RuntimeOfflineSearchParameterSetArtifact {
  readonly artifactRef: string;
  /** Bare lowercase SHA-256 of the exact producer-owned bytes. */
  readonly contentSha256: string;
  readonly bytes: Uint8Array;
}

interface RuntimeOfflinePageActionExecutorInput {
  artifactDirectory: string;
  now: () => Date;
  scenario: RuntimeOfflinePageActionScenario;
  resolveSearchParameterSetArtifact?: (
    artifactRef: string,
  ) => Promise<RuntimeOfflineSearchParameterSetArtifact>;
}

export function createRuntimeOfflinePageActionExecutor(
  input: RuntimeOfflinePageActionExecutorInput,
): PageActionExecutor {
  if (!path.isAbsolute(input.artifactDirectory)) {
    throw new TypeError('Offline PageAction artifact directory must be absolute.');
  }
  if (!RUNTIME_OFFLINE_PAGE_ACTION_SCENARIOS.includes(input.scenario)) {
    throw new TypeError('Unknown offline PageAction scenario.');
  }
  return {
    execute: async (
      request: PageActionRequestV1,
      scope: PageActionExecutionScope,
    ): Promise<PageActionExecuteResponseV1> => {
      assertRuntimeOfflineRequestSafety(request);
      const parameterSet = await resolveRuntimeOfflineSearchParameterSet(input, request);
      assertRuntimeOfflineScenarioRequest(request, input.scenario, parameterSet);
      await seedArtifacts(
        request.actionKind,
        input.artifactDirectory,
        request,
        parameterSet !== undefined,
      );
      let sequence = 0;
      const requestPrefix = createHash('sha256')
        .update(request.pageActionExecutionAttemptId, 'utf8')
        .digest('hex')
        .slice(0, 16);
      const executor = new ProductionPageActionExecutor({
        artifactDirectory: input.artifactDirectory,
        now: input.now,
        idFactory: () => `offline-${requestPrefix}-${String(++sequence).padStart(3, '0')}`,
        pace: async () => {},
        random: () => 0,
        ...(parameterSet === undefined
          ? {}
          : {
              testOnlyResolveCanonicalSearchParameterSet: async (artifactRef: string) => {
                if (
                  request.action.kind !== 'search-list'
                  || artifactRef !== request.action.request.canonicalParameterSetArtifactRef
                ) {
                  throw new TypeError('Offline Search parameter-set artifact ref drifted.');
                }
                return structuredClone(parameterSet);
              },
            }),
      });
      return withClock(input.now(), () => executor.execute(request, {
        ...scope,
        page: fakePage(
          request.actionKind,
          request,
          input.scenario,
          scope.pageSessionId,
          parameterSet,
        ) as never,
      }));
    },
  };
}

async function resolveRuntimeOfflineSearchParameterSet(
  input: RuntimeOfflinePageActionExecutorInput,
  request: PageActionRequestV1,
): Promise<CanonicalSearchParameterSetV1 | undefined> {
  if (request.action.kind !== 'search-list') return undefined;
  const artifactRef = request.action.request.canonicalParameterSetArtifactRef;
  if (artifactRef === 'artifact:runtime-parameter-set') return undefined;
  const expectedContentSha256 = artifactRef.match(/^sha256:([0-9a-f]{64})$/u)?.[1];
  if (expectedContentSha256 === undefined) {
    throw new TypeError('Offline Search parameter-set artifact ref is invalid.');
  }
  if (input.resolveSearchParameterSetArtifact === undefined) {
    throw new TypeError(
      'Non-static offline Search authority requires an explicit test-only resolver.',
    );
  }
  const artifact = await input.resolveSearchParameterSetArtifact(artifactRef);
  if (!(artifact.bytes instanceof Uint8Array)) {
    throw new TypeError('Offline Search parameter-set resolver returned invalid bytes.');
  }
  const bytes = Buffer.from(artifact.bytes);
  const actualContentSha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    artifact.artifactRef !== artifactRef
    || artifact.contentSha256 !== expectedContentSha256
    || actualContentSha256 !== expectedContentSha256
  ) {
    throw new TypeError(
      'Offline Search parameter-set artifact is missing, stale, corrupted, or mismatched.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new TypeError('Offline Search parameter-set artifact contains invalid JSON.');
  }
  if ((value as { schema?: unknown })?.schema !== 'canonical-search-parameter-set-v1') {
    throw new TypeError('Offline Search parameter-set artifact schema is invalid.');
  }
  verifyParameterSetHash(value as CanonicalSearchParameterSetV1);
  return value as CanonicalSearchParameterSetV1;
}

export async function generateRuntimeDerivedPageActionFixtures(
  outputRoot = DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
): Promise<void> {
  await withFixedClock(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(outputRoot, { recursive: true });
    const generatorSource = await fs.readFile(fileURLToPath(import.meta.url));
    const actionManifests: ActionManifest[] = [];

    for (const actionKind of ACTION_KINDS) {
      const transportInputPath = `inputs/${actionKind}.transport.json`;
      const transportInputBytes = jsonBytes(TRANSPORT_INPUTS[actionKind]);
      await writeRelative(outputRoot, transportInputPath, transportInputBytes);
      const runtime = await executeAction(actionKind);
      const responsePath = `responses/${actionKind}.wire-response.json`;
      const responseBytes = jsonBytes(runtime.response);
      await writeRelative(outputRoot, responsePath, responseBytes);

      const executionEnvelopePath =
        `envelopes/${actionKind}.execution-attempt-receipt.json`;
      const executionEnvelopeBytes = jsonBytes(
        runtime.response.executionAttemptReceipt,
      );
      await writeRelative(outputRoot, executionEnvelopePath, executionEnvelopeBytes);
      const completion = runtime.response.completionReceipt;
      if (!completion) throw new Error(`${actionKind} did not produce a completion receipt`);
      const completionEnvelopePath =
        `envelopes/${actionKind}.completion-receipt.json`;
      const completionEnvelopeBytes = jsonBytes(completion);
      await writeRelative(outputRoot, completionEnvelopePath, completionEnvelopeBytes);

      const batchFiles: FileReceipt[] = [];
      for (const [index, batch] of completion.batches.entries()) {
        const batchPath = `batches/${actionKind}/${String(index).padStart(2, '0')}-${batch.kind}.json`;
        const bytes = jsonBytes(batch);
        await writeRelative(outputRoot, batchPath, bytes);
        batchFiles.push(receipt(batchPath, bytes));
      }

      const archiveFiles: FileReceipt[] = [];
      for (const artifact of runtime.artifacts) {
        const archivePath = `archives/${actionKind}/${artifact.relativePath}`;
        await writeRelative(outputRoot, archivePath, artifact.bytes);
        archiveFiles.push(receipt(archivePath, artifact.bytes));
      }
      actionManifests.push({
        actionKind,
        expectedComponents: EXPECTED_COMPONENTS[actionKind],
        transportInputPath,
        transportInputSha256: sha256(transportInputBytes),
        responsePath,
        responseSha256: sha256(responseBytes),
        executionEnvelopePath,
        executionEnvelopeSha256: sha256(executionEnvelopeBytes),
        completionEnvelopePath,
        completionEnvelopeSha256: sha256(completionEnvelopeBytes),
        batchFiles,
        archiveFiles,
      });
    }

    const manifest = {
      schema: RUNTIME_PAGE_ACTION_FIXTURE_SCHEMA,
      fixtureSetVersion: 1,
      provenance: 'runtime-derived-production-page-action-executor-v1',
      productionExecutorModule: 'src/daemon/production-page-action-executor.ts',
      transportMode: 'offline-fake-page-capture-and-transport',
      generatedAt: FIXED_NOW,
      generator: {
        revision: RUNTIME_PAGE_ACTION_FIXTURE_GENERATOR_REVISION,
        sourcePath: 'scripts/generate_runtime_page_action_fixtures.ts',
        sourceSha256: sha256(generatorSource),
      },
      security: {
        recursiveSanitizationGate: true,
        containsLiveCredentials: false,
        containsPersonalData: false,
      },
      legacySyntheticFixtureSet: {
        path: 'tests/fixtures/page-actions',
        evidenceStatus: 'synthetic-non-runtime',
        acceptedAsRuntimeParityEvidence: false,
      },
      actions: actionManifests,
    };
    const manifestBytes = jsonBytes(manifest);
    await writeRelative(outputRoot, 'manifest.json', manifestBytes);

    const paths = (await listFiles(outputRoot))
      .filter((relativePath) => relativePath !== 'sha256-receipt.json');
    const fileReceipts = await Promise.all(paths.map(async (relativePath) => {
      const bytes = await fs.readFile(path.join(outputRoot, relativePath));
      return receipt(relativePath, bytes);
    }));
    await writeRelative(outputRoot, 'sha256-receipt.json', jsonBytes({
      schema: 'collector.runtime-derived-page-action-file-receipt.v1',
      fixtureSetSchema: RUNTIME_PAGE_ACTION_FIXTURE_SCHEMA,
      generatorRevision: RUNTIME_PAGE_ACTION_FIXTURE_GENERATOR_REVISION,
      files: fileReceipts,
    }));
  });
  await verifyRuntimeDerivedPageActionFixtureSet(outputRoot);
}

export async function verifyRuntimeDerivedPageActionFixtureSet(
  root = DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
): Promise<{ actions: number; files: number }> {
  const manifest = strictRecord(
    JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')),
    'manifest',
    [
      'schema', 'fixtureSetVersion', 'provenance', 'productionExecutorModule',
      'transportMode', 'generatedAt', 'generator', 'security',
      'legacySyntheticFixtureSet', 'actions',
    ],
  );
  if (
    manifest['schema'] !== RUNTIME_PAGE_ACTION_FIXTURE_SCHEMA
    || manifest['fixtureSetVersion'] !== 1
    || manifest['provenance'] !== 'runtime-derived-production-page-action-executor-v1'
    || manifest['productionExecutorModule'] !== 'src/daemon/production-page-action-executor.ts'
    || manifest['transportMode'] !== 'offline-fake-page-capture-and-transport'
    || manifest['generatedAt'] !== FIXED_NOW
  ) {
    throw new Error('Runtime fixture manifest provenance or schema is invalid.');
  }
  const security = strictRecord(manifest['security'], 'security declaration', [
    'recursiveSanitizationGate', 'containsLiveCredentials', 'containsPersonalData',
  ]);
  if (
    security['recursiveSanitizationGate'] !== true
    || security['containsLiveCredentials'] !== false
    || security['containsPersonalData'] !== false
  ) {
    throw new Error('Runtime fixture security declaration is invalid.');
  }
  const legacy = strictRecord(
    manifest['legacySyntheticFixtureSet'],
    'legacy fixture declaration',
    ['path', 'evidenceStatus', 'acceptedAsRuntimeParityEvidence'],
  );
  if (
    legacy['path'] !== 'tests/fixtures/page-actions'
    || legacy['evidenceStatus'] !== 'synthetic-non-runtime'
    || legacy['acceptedAsRuntimeParityEvidence'] !== false
  ) {
    throw new Error('Legacy synthetic fixtures must remain explicitly non-runtime evidence.');
  }
  const generator = strictRecord(
    manifest['generator'],
    'generator',
    ['revision', 'sourcePath', 'sourceSha256'],
  );
  const generatorSource = await fs.readFile(fileURLToPath(import.meta.url));
  if (
    generator['revision'] !== RUNTIME_PAGE_ACTION_FIXTURE_GENERATOR_REVISION
    || generator['sourcePath'] !== 'scripts/generate_runtime_page_action_fixtures.ts'
    || generator['sourceSha256'] !== sha256(generatorSource)
  ) {
    throw new Error('Runtime fixture generator revision or source hash drifted.');
  }

  const receiptDocument = strictRecord(
    JSON.parse(await fs.readFile(path.join(root, 'sha256-receipt.json'), 'utf8')),
    'file receipt',
    ['schema', 'fixtureSetSchema', 'generatorRevision', 'files'],
  );
  if (
    receiptDocument['schema'] !== 'collector.runtime-derived-page-action-file-receipt.v1'
    || receiptDocument['fixtureSetSchema'] !== RUNTIME_PAGE_ACTION_FIXTURE_SCHEMA
    || receiptDocument['generatorRevision'] !== RUNTIME_PAGE_ACTION_FIXTURE_GENERATOR_REVISION
  ) {
    throw new Error('Runtime fixture file receipt schema is invalid.');
  }
  const fileReceipts = array(receiptDocument['files'], 'file receipts').map(
    (entry, index) => parseFileReceipt(entry, `file receipts[${index}]`),
  );
  const receiptPaths = fileReceipts.map((entry) => entry.path);
  if (
    new Set(receiptPaths).size !== receiptPaths.length
    || JSON.stringify(receiptPaths) !== JSON.stringify([...receiptPaths].sort())
  ) {
    throw new Error('Runtime fixture file receipts must be unique and sorted.');
  }
  const receiptByPath = new Map(fileReceipts.map((entry) => [entry.path, entry]));
  const actualPaths = await listFiles(root);
  const expectedPaths = [...fileReceipts.map((entry) => entry.path), 'sha256-receipt.json']
    .sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Runtime fixture file inventory is incomplete or contains unreceipted bytes.');
  }
  for (const file of fileReceipts) {
    const bytes = await fs.readFile(path.join(root, safeRelativePath(file.path)));
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Runtime fixture file receipt mismatch: ${file.path}`);
    }
    scanForSecretsAndPii(JSON.parse(bytes.toString('utf8')), file.path);
  }

  const actions = array(manifest['actions'], 'manifest actions');
  if (
    actions.length !== ACTION_KINDS.length
    || JSON.stringify(actions.map((entry) => record(entry, 'action')['actionKind']))
      !== JSON.stringify(ACTION_KINDS)
  ) {
    throw new Error('Runtime fixture manifest must contain the exact four PageActions.');
  }
  const manifestOwnedPaths = new Set(['manifest.json']);
  for (const actionValue of actions) {
    const action = strictRecord(actionValue, 'action manifest', [
      'actionKind', 'expectedComponents', 'transportInputPath', 'transportInputSha256',
      'responsePath', 'responseSha256', 'executionEnvelopePath',
      'executionEnvelopeSha256', 'completionEnvelopePath',
      'completionEnvelopeSha256', 'batchFiles', 'archiveFiles',
    ]);
    const actionKind = action['actionKind'];
    if (!ACTION_KINDS.includes(actionKind as ActionKind)) {
      throw new Error('Runtime fixture action kind is unknown.');
    }
    if (
      JSON.stringify(action['expectedComponents'])
      !== JSON.stringify(EXPECTED_COMPONENTS[actionKind as ActionKind])
    ) {
      throw new Error(`${String(actionKind)} expected component contract drifted.`);
    }
    const typedActionKind = actionKind as ActionKind;
    const transportPath = exactActionPath(
      action['transportInputPath'],
      `inputs/${typedActionKind}.transport.json`,
      'transport input path',
    );
    const responsePath = exactActionPath(
      action['responsePath'],
      `responses/${typedActionKind}.wire-response.json`,
      'response path',
    );
    const executionPath = exactActionPath(
      action['executionEnvelopePath'],
      `envelopes/${typedActionKind}.execution-attempt-receipt.json`,
      'execution envelope path',
    );
    const completionPath = exactActionPath(
      action['completionEnvelopePath'],
      `envelopes/${typedActionKind}.completion-receipt.json`,
      'completion envelope path',
    );
    for (const ownedPath of [transportPath, responsePath, executionPath, completionPath]) {
      claimManifestPath(manifestOwnedPaths, ownedPath);
    }
    await assertManifestFileBinding(
      root, receiptByPath, transportPath, action['transportInputSha256'],
    );
    await assertManifestFileBinding(
      root, receiptByPath, responsePath, action['responseSha256'],
    );
    await assertManifestFileBinding(
      root, receiptByPath, executionPath, action['executionEnvelopeSha256'],
    );
    await assertManifestFileBinding(
      root, receiptByPath, completionPath, action['completionEnvelopeSha256'],
    );
    const transport = JSON.parse(
      await fs.readFile(path.join(root, safeRelativePath(transportPath)), 'utf8'),
    ) as unknown;
    if (
      canonicalCollectorSha256V1(transport)
      !== canonicalCollectorSha256V1(TRANSPORT_INPUTS[typedActionKind])
    ) {
      throw new Error(`${typedActionKind} transport input differs from its offline fake transport.`);
    }
    const response = normalizePageActionExecuteResponseV1(
      JSON.parse(await fs.readFile(path.join(root, safeRelativePath(responsePath)), 'utf8')),
    );
    const completion = response.completionReceipt;
    if (
      response.executionAttemptReceipt.actionKind !== actionKind
      || response.executionAttemptReceipt.outcome !== 'completed'
      || completion === undefined
      || completion.actionKind !== actionKind
      || completion.status !== 'completed'
    ) {
      throw new Error(`${String(actionKind)} runtime response is not terminal completed evidence.`);
    }
    const executionBytes = await fs.readFile(path.join(root, safeRelativePath(executionPath)));
    const completionBytes = await fs.readFile(path.join(root, safeRelativePath(completionPath)));
    if (
      JSON.stringify(JSON.parse(executionBytes.toString('utf8')))
        !== JSON.stringify(response.executionAttemptReceipt)
      || JSON.stringify(JSON.parse(completionBytes.toString('utf8')))
        !== JSON.stringify(completion)
    ) {
      throw new Error(`${String(actionKind)} envelope bytes differ from its executor response.`);
    }
    const batchFiles = array(action['batchFiles'], 'action batch files')
      .map((entry, index) => parseFileReceipt(entry, `batch files[${index}]`));
    if (batchFiles.length !== completion.batches.length) {
      throw new Error(`${String(actionKind)} batch inventory is incomplete.`);
    }
    for (const [index, batchFile] of batchFiles.entries()) {
      const expectedPath = `batches/${typedActionKind}/`
        + `${String(index).padStart(2, '0')}-${completion.batches[index]!.kind}.json`;
      if (batchFile.path !== expectedPath) {
        throw new Error(`${typedActionKind} Batch manifest path drifted.`);
      }
      claimManifestPath(manifestOwnedPaths, batchFile.path);
      assertEmbeddedFileReceipt(receiptByPath, batchFile, `${typedActionKind} Batch`);
      const bytes = await fs.readFile(path.join(root, safeRelativePath(batchFile.path)));
      if (
        bytes.byteLength !== batchFile.bytes
        || sha256(bytes) !== batchFile.sha256
        || JSON.stringify(JSON.parse(bytes.toString('utf8')))
          !== JSON.stringify(completion.batches[index])
      ) {
        throw new Error(`${String(actionKind)} frozen Batch bytes drifted.`);
      }
    }
    const archiveFiles = array(action['archiveFiles'], 'action archive files')
      .map((entry, index) => parseFileReceipt(entry, `archive files[${index}]`));
    for (const archiveFile of archiveFiles) {
      if (!archiveFile.path.startsWith(`archives/${typedActionKind}/`)) {
        throw new Error(`${typedActionKind} archive path escapes its action inventory.`);
      }
      claimManifestPath(manifestOwnedPaths, archiveFile.path);
      assertEmbeddedFileReceipt(receiptByPath, archiveFile, `${typedActionKind} archive`);
    }
    await assertArchiveBindings(root, typedActionKind, archiveFiles, response);
    if (typedActionKind === 'store-sample') assertStoreFixtureAttempts(response);
    if (actionKind === 'offer-detail') {
      const detail = completion.batches.find(
        (batch) => batch.kind === 'offer-detail',
      );
      const observation = record(detail?.observations[0], 'offer observation');
      if (
        JSON.stringify(Object.keys(observation).sort())
          !== JSON.stringify(['collectedAt', 'collectorPageActionEvidence', 'offer', 'offerId'])
      ) {
        throw new Error(
          'Offer runtime observation must preserve {offerId, offer, collectedAt} plus PageAction evidence.',
        );
      }
    }
  }
  if (
    JSON.stringify([...manifestOwnedPaths].sort())
    !== JSON.stringify([...receiptByPath.keys()].sort())
  ) {
    throw new Error('Runtime fixture receipt contains bytes not owned by the strict manifest.');
  }
  return { actions: actions.length, files: actualPaths.length };
}

export async function checkRuntimeDerivedPageActionFixtures(
  root = DEFAULT_RUNTIME_PAGE_ACTION_FIXTURE_ROOT,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-page-actions-check-'));
  try {
    await generateRuntimeDerivedPageActionFixtures(tempRoot);
    const expected = await readFileMap(tempRoot);
    const actual = await readFileMap(root);
    if (expected.size !== actual.size) {
      throw new Error('Runtime fixture generation is not byte-for-byte deterministic.');
    }
    for (const [relativePath, bytes] of expected) {
      if (!actual.get(relativePath)?.equals(bytes)) {
        throw new Error(`Runtime fixture generation drifted: ${relativePath}`);
      }
    }
    await verifyRuntimeDerivedPageActionFixtureSet(root);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function executeAction(actionKind: ActionKind): Promise<{
  response: PageActionExecuteResponseV1;
  artifacts: Array<{ relativePath: string; bytes: Buffer }>;
}> {
  const artifactDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `runtime-page-action-${actionKind}-`),
  );
  try {
    const now = new Date(FIXED_NOW);
    const request = actionRequest(actionKind, now);
    const seedFiles = await seedArtifacts(actionKind, artifactDirectory, request);
    let sequence = 0;
    const executor = new ProductionPageActionExecutor({
      artifactDirectory,
      now: () => now,
      idFactory: () => `${actionKind}-fixture-${String(++sequence).padStart(3, '0')}`,
      pace: async () => {},
      random: () => 0,
    });
    const response = await executor.execute(request, {
      page: fakePage(actionKind, request) as never,
      pageSessionId: `${actionKind}-fixture-page-session`,
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
      admitRemoteAttempt: async (input) => ({
        remoteActionStartId: `${actionKind}-remote-start-${input.ordinal}`,
        admittedAt: new Date(now.getTime() + input.ordinal).toISOString(),
      }),
      classifyUrl: async () => {},
      closeOwnedPage: async () => {},
    });
    const normalized = normalizePageActionExecuteResponseV1(response);
    if (!normalized.completionReceipt) {
      throw new Error(`${actionKind} fake transport did not complete: ${
        normalized.executionAttemptReceipt.error?.code ?? 'unknown'
      }`);
    }
    const artifacts: Array<{ relativePath: string; bytes: Buffer }> = [];
    for (const relativePath of await listFiles(artifactDirectory)) {
      if (seedFiles.has(relativePath)) continue;
      artifacts.push({
        relativePath,
        bytes: await fs.readFile(path.join(artifactDirectory, relativePath)),
      });
    }
    return { response: normalized, artifacts };
  } finally {
    await fs.rm(artifactDirectory, { recursive: true, force: true });
  }
}

async function seedArtifacts(
  actionKind: ActionKind,
  artifactDirectory: string,
  request: PageActionRequestV1,
  searchParameterSetResolved = false,
): Promise<Set<string>> {
  const seeded = new Set<string>();
  if (actionKind === 'search-list' && !searchParameterSetResolved) {
    if (request.action.kind !== 'search-list') throw new TypeError('Search seed request drifted.');
    const parameterSet = searchParameterSet();
    const artifactId = artifactIdFromRef(
      request.action.request.canonicalParameterSetArtifactRef,
      'Search parameter artifact ref',
    );
    const relativePath = `${artifactId}.json`;
    await fs.writeFile(
      path.join(artifactDirectory, relativePath),
      JSON.stringify(parameterSet),
      { mode: 0o600 },
    );
    seeded.add(relativePath);
  }
  return seeded;
}

function artifactIdFromRef(value: string, label: string): string {
  const match = value.match(/^artifact:([A-Za-z0-9._-]+)$/u);
  if (!match?.[1]) throw new TypeError(`${label} is invalid.`);
  return match[1];
}

function searchParameterSet() {
  return compileSearchParameterSetV1({
    keyword: SEARCH_INPUT.keyword,
    sort: 'relevance',
    compatibilitySortInput: null,
    filterConfigSnapshotId: 'runtime-filter-snapshot-1',
    filterConfigSnapshotHash: canonicalCollectorSha256V1('runtime-filter-snapshot-1'),
    serializerCapabilitySnapshotId: 'runtime-serializer-snapshot-1',
    serializerCapabilitySnapshotHash:
      canonicalCollectorSha256V1('runtime-serializer-snapshot-1'),
    filterParams: {},
    selectedOptions: [],
    maxPages: 1,
    maxOffers: 60,
    advertisementPolicy: 'exclude-p4p',
  });
}

function actionRequest(actionKind: ActionKind, now: Date): PageActionRequestV1 {
  const businessSubject = actionKind === 'search-list'
    ? {
        kind: 'search-list' as const,
        searchQueryKeyHash: canonicalCollectorSha256V1('runtime-search-query-key'),
        querySnapshotHash: canonicalCollectorSha256V1('runtime-query-snapshot'),
      }
    : actionKind === 'offer-detail'
      ? {
          kind: 'offer-detail' as const,
          offerId: OFFER_INPUT.offerId,
          memberId: OFFER_INPUT.memberId,
          searchOriginReceiptId: 'runtime-search-origin-receipt-1',
          searchOriginReceiptHash: canonicalCollectorSha256V1('runtime-search-origin'),
        }
      : actionKind === 'store-qualification'
        ? {
            kind: 'store-qualification' as const,
            memberId: QUALIFICATION_INPUT.memberId,
            canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            canonicalShopUrl: 'https://fixture-qualification-store.1688.com/',
            canonicalStoreIdentityReceiptId: 'runtime-qualification-identity',
            canonicalStoreIdentityReceiptHash:
              canonicalCollectorSha256V1('runtime-qualification-identity'),
          }
        : {
            kind: 'store-sample' as const,
            memberId: STORE_INPUT.memberId,
            canonicalStoreId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            canonicalShopUrl: STORE_INPUT.canonicalShopUrl,
            canonicalShopIdentityReceiptId: 'runtime-store-identity',
            canonicalShopIdentityReceiptHash:
              canonicalCollectorSha256V1('runtime-store-identity'),
            pageScopeBusinessHash: canonicalCollectorSha256V1({
              firstPage: 1,
              lastPageInclusive: 3,
            }),
          };
  const pageActionBusinessHash = canonicalCollectorSha256V1({
    actionKind,
    businessSubject,
  });
  const logicalLineage = {
    schema: 'collector.logical-page-action-lineage.v1' as const,
    logicalLineageId: `runtime-logical-${actionKind}`,
    collectionTaskId: `runtime-collection-task-${actionKind}`,
    workUnitId: `runtime-work-unit-${actionKind}`,
    pageActionId: `runtime-page-action-${actionKind}`,
    pageActionBusinessHash,
    actionKind,
    businessSubject,
  };
  const logicalLineageHash = computeLogicalLineageHashV1(logicalLineage);
  const leaseNotAfter = new Date(now.getTime() + 10 * 60_000).toISOString();
  const executionLineage = {
    schema: 'collector.page-action-execution-lineage.v1' as const,
    logicalLineageId: logicalLineage.logicalLineageId,
    logicalLineageHash,
    workUnitAttemptId: `runtime-work-attempt-${actionKind}`,
    pageActionExecutionAttemptId: `runtime-execution-attempt-${actionKind}`,
    executionAttemptOrdinal: 1,
    requestId: `runtime-request-${actionKind}`,
    idempotencyKey: `runtime-idempotency-${actionKind}`,
    profile: {
      profileId: 'runtime-fixture-profile',
      profileName: 'runtime-fixture-profile',
      daemonInstanceId: 'runtime-fixture-daemon',
      contextGeneration: 1,
      egressId: 'runtime-fixture-egress',
    },
    fences: {
      supervisor: fence('supervisor', leaseNotAfter),
      reservation: fence('reservation', leaseNotAfter),
      workUnit: fence('work-unit', leaseNotAfter),
    },
  };
  const base = {
    schema: 'collector.page-action.request.v1' as const,
    requestId: executionLineage.requestId,
    idempotencyKey: executionLineage.idempotencyKey,
    pageActionId: logicalLineage.pageActionId,
    pageActionExecutionAttemptId: executionLineage.pageActionExecutionAttemptId,
    executionAttemptOrdinal: 1,
    pageActionBusinessHash,
    logicalLineage,
    logicalLineageHash,
    executionLineage,
    executionLineageHash: computeExecutionLineageHashV1(executionLineage),
    actionKind,
    startNotBefore: now.toISOString(),
    leaseNotAfter,
    deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    policyRevisionIds: ['runtime-fixture-policy-v1'],
  };
  if (actionKind === 'search-list') {
    const parameterSet = searchParameterSet();
    return {
      ...base,
      action: {
        kind: 'search-list',
        request: {
          schema: 'canonical-search-request-v1',
          searchQueryKeyHash: canonicalCollectorSha256V1('runtime-search-query-key'),
          searchSegmentId: 'runtime-search-segment-1',
          querySnapshotHash: canonicalCollectorSha256V1('runtime-query-snapshot'),
          searchQueryIdentity: 'runtime-search-query-1',
          page: 1,
          keyword: parameterSet.keyword,
          filterConfigSnapshotId: parameterSet.filterConfigSnapshotId,
          filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
          compilerRevision: parameterSet.compilerRevision,
          serializerCapabilitySnapshotId: parameterSet.serializerCapabilitySnapshotId,
          serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
          sort: parameterSet.sort,
          canonicalParameterSetArtifactRef: 'artifact:runtime-parameter-set',
          canonicalParameterSetHash: parameterSet.parameterSetHash,
          requestedStartPage: 1,
          requestedEndPage: 1,
          maxOffers: 60,
          advertisementPolicy: 'exclude-p4p',
          forwardPageBudget: 1,
          replayPageBudget: 0,
          maxSafeReplayPages: 0,
        },
        executionHandle: {} as never,
      },
    };
  }
  if (actionKind === 'offer-detail') {
    return {
      ...base,
      action: {
        kind: 'offer-detail',
        offerId: OFFER_INPUT.offerId,
        memberId: OFFER_INPUT.memberId,
        searchOriginReceiptId: 'runtime-search-origin-receipt-1',
        searchOriginReceiptHash: canonicalCollectorSha256V1('runtime-search-origin'),
        executionHandle: {} as never,
      },
    };
  }
  if (actionKind === 'store-qualification') {
    return {
      ...base,
      action: {
        kind: 'store-qualification',
        memberId: QUALIFICATION_INPUT.memberId,
        canonicalStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        canonicalShopUrl: 'https://fixture-qualification-store.1688.com/',
        canonicalStoreIdentityReceiptId: 'runtime-qualification-identity',
        canonicalStoreIdentityReceiptHash:
          canonicalCollectorSha256V1('runtime-qualification-identity'),
        executionHandle: {} as never,
      },
    };
  }
  return {
    ...base,
    action: {
      kind: 'store-sample',
      memberId: STORE_INPUT.memberId,
      canonicalStoreId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      canonicalShopUrl: STORE_INPUT.canonicalShopUrl,
      canonicalShopIdentityReceiptId: 'runtime-store-identity',
      canonicalShopIdentityReceiptHash:
        canonicalCollectorSha256V1('runtime-store-identity'),
      mode: 'phase-1-bounded',
      pageScope: { firstPage: 1, lastPageInclusive: 3 },
      executionHandle: {} as never,
    },
  };
}

/** Test-only request seed. Production E2E must supply its database-prepared request instead. */
export function createRuntimeOfflineScenarioRequestForTest(
  actionKind: RuntimeOfflinePageActionKind,
  now = new Date(FIXED_NOW),
): PageActionRequestV1 {
  return structuredClone(actionRequest(actionKind, now));
}

export function createRuntimeOfflineScenarioCanonicalSearchRequest(): Omit<
  CanonicalSearchRequestV1,
  'executionHandle'
> {
  const request = actionRequest('search-list', new Date(FIXED_NOW));
  if (request.action.kind !== 'search-list') throw new TypeError('Search scenario drifted.');
  const { executionHandle: _executionHandle, ...authority } = request.action.request;
  return structuredClone(authority);
}

export function createRuntimeOfflineScenarioDescriptor(): {
  scenario: 'chain-coherent-available-v1';
  canonicalSearchRequest: Omit<CanonicalSearchRequestV1, 'executionHandle'>;
  searchTransportAuthority: {
    keyword: string;
    sort: string;
    advertisementPolicy: string;
    pageSize: number;
    filterParams: Record<string, never>;
    selectedOptions: readonly never[];
    filterConfigSnapshotId: string;
    filterConfigSnapshotHash: string;
    serializerCapabilitySnapshotId: string;
    serializerCapabilitySnapshotHash: string;
    canonicalParameterSetHash: string;
  };
  chainSubject: { offerId: string; memberId: string };
} {
  const parameterSet = searchParameterSet();
  return {
    scenario: 'chain-coherent-available-v1',
    canonicalSearchRequest: createRuntimeOfflineScenarioCanonicalSearchRequest(),
    searchTransportAuthority: {
      keyword: parameterSet.keyword,
      sort: parameterSet.sort,
      advertisementPolicy: parameterSet.advertisementPolicy,
      pageSize: 60,
      filterParams: {},
      selectedOptions: [],
      filterConfigSnapshotId: parameterSet.filterConfigSnapshotId,
      filterConfigSnapshotHash: parameterSet.filterConfigSnapshotHash,
      serializerCapabilitySnapshotId: parameterSet.serializerCapabilitySnapshotId,
      serializerCapabilitySnapshotHash: parameterSet.serializerCapabilitySnapshotHash,
      canonicalParameterSetHash: parameterSet.parameterSetHash,
    },
    chainSubject: { offerId: SEARCH_INPUT.offerId, memberId: SEARCH_INPUT.memberId },
  };
}

function assertResolvedSearchAuthority(
  request: CanonicalSearchRequestV1,
  parameterSet: CanonicalSearchParameterSetV1,
): void {
  const mismatches = [
    request.keyword !== SEARCH_INPUT.keyword ? 'scenario keyword' : null,
    request.canonicalParameterSetHash !== parameterSet.parameterSetHash
      ? 'parameter-set hash'
      : null,
    request.keyword !== parameterSet.keyword ? 'keyword' : null,
    request.compilerRevision !== parameterSet.compilerRevision ? 'compiler revision' : null,
    request.filterConfigSnapshotId !== parameterSet.filterConfigSnapshotId
      ? 'Filter Catalog snapshot id'
      : null,
    request.filterConfigSnapshotHash !== parameterSet.filterConfigSnapshotHash
      ? 'Filter Catalog snapshot hash'
      : null,
    request.serializerCapabilitySnapshotId !== parameterSet.serializerCapabilitySnapshotId
      ? 'Serializer Capability snapshot id'
      : null,
    request.serializerCapabilitySnapshotHash !== parameterSet.serializerCapabilitySnapshotHash
      ? 'Serializer Capability snapshot hash'
      : null,
    request.sort !== parameterSet.sort ? 'sort' : null,
    !Number.isInteger(request.page)
      || !Number.isInteger(request.requestedStartPage)
      || !Number.isInteger(request.requestedEndPage)
      || request.page !== request.requestedStartPage
      || request.page < 1
      || request.page > request.requestedEndPage
      || request.requestedEndPage !== parameterSet.maxPages
      ? 'page range'
      : null,
    request.maxOffers !== parameterSet.maxOffers ? 'max offers' : null,
    request.advertisementPolicy !== parameterSet.advertisementPolicy
      ? 'advertisement policy'
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new TypeError(
      `Offline Search parameter-set authority mismatch: ${mismatches.join(', ')}.`,
    );
  }
}

function assertRuntimeOfflineScenarioRequest(
  request: PageActionRequestV1,
  scenario: RuntimeOfflinePageActionScenario,
  resolvedSearchParameterSet?: CanonicalSearchParameterSetV1,
): void {
  if (
    request.actionKind !== request.action.kind
    || request.logicalLineage.actionKind !== request.actionKind
    || request.logicalLineage.businessSubject.kind !== request.actionKind
  ) {
    throw new TypeError('Offline PageAction action and lineage kinds are inconsistent.');
  }
  const subject = request.logicalLineage.businessSubject;
  if (request.action.kind === 'search-list') {
    if (
      subject.kind !== 'search-list'
      || subject.searchQueryKeyHash !== request.action.request.searchQueryKeyHash
      || subject.querySnapshotHash !== request.action.request.querySnapshotHash
    ) {
      throw new TypeError('Offline Search request does not match the chain-coherent scenario.');
    }
    if (resolvedSearchParameterSet === undefined) {
      const legacy = searchParameterSet();
      if (
        request.action.request.canonicalParameterSetArtifactRef
          !== 'artifact:runtime-parameter-set'
        || request.action.request.keyword !== SEARCH_INPUT.keyword
        || request.action.request.page !== 1
        || request.action.request.requestedStartPage !== 1
        || request.action.request.requestedEndPage !== 1
        || request.action.request.canonicalParameterSetHash !== legacy.parameterSetHash
      ) {
        throw new TypeError('Offline Search request does not match the legacy deterministic scenario.');
      }
    } else {
      assertResolvedSearchAuthority(request.action.request, resolvedSearchParameterSet);
    }
  } else if (request.action.kind === 'offer-detail') {
    if (
      subject.kind !== 'offer-detail'
      || request.action.offerId !== OFFER_INPUT.offerId
      || request.action.memberId !== OFFER_INPUT.memberId
      || subject.offerId !== OFFER_INPUT.offerId
      || subject.memberId !== OFFER_INPUT.memberId
    ) {
      throw new TypeError('Offline Offer request is inconsistent with its SearchHit subject.');
    }
  } else if (request.action.kind === 'store-qualification') {
    if (
      subject.kind !== 'store-qualification'
      || request.action.memberId !== QUALIFICATION_INPUT.memberId
      || subject.memberId !== QUALIFICATION_INPUT.memberId
    ) {
      throw new TypeError('Offline Qualification request is inconsistent with the chain member.');
    }
  } else if (
    subject.kind !== 'store-sample'
    || request.action.memberId !== STORE_INPUT.memberId
    || subject.memberId !== STORE_INPUT.memberId
    || request.action.mode !== 'phase-1-bounded'
    || request.action.pageScope.firstPage !== 1
    || request.action.pageScope.lastPageInclusive !== 3
  ) {
    throw new TypeError('Offline Store request must preserve the chain member and pages 1-3.');
  }
  if (
    scenario === 'chain-coherent-technical-failure-v1'
    && request.actionKind !== 'offer-detail'
  ) {
    throw new TypeError('The technical-failure scenario is scoped to Offer Detail.');
  }
}

export function assertRuntimeOfflineRequestSafety(request: PageActionRequestV1): void {
  scanForSecretsAndPii(request, 'offline PageAction request');
  scanForExternalUrls(request, 'offline PageAction request');
}

function scanForExternalUrls(value: unknown, location: string, depth = 0): void {
  if (depth > 64) throw new Error(`${location}: external URL scan depth exceeded.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForExternalUrls(item, `${location}[${index}]`, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      scanForExternalUrls(child, `${location}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const urls = value.match(/https?:\/\/[^\s"'<>]+/giu) ?? [];
  for (const rawUrl of urls) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`${location}: invalid URL is forbidden in the offline harness.`);
    }
    if (parsed.protocol !== 'https:' || !/(?:^|\.)1688\.com$/iu.test(parsed.hostname)) {
      throw new Error(`${location}: external URL is forbidden in the offline harness.`);
    }
  }
}

function fakePage(
  actionKind: ActionKind,
  request: PageActionRequestV1,
  scenario: RuntimeOfflinePageActionScenario = 'chain-coherent-available-v1',
  pageSessionId = `${actionKind}-fixture-page-session`,
  resolvedSearchParameterSet?: CanonicalSearchParameterSetV1,
): unknown {
  switch (actionKind) {
    case 'search-list': {
      const parameterSet = resolvedSearchParameterSet ?? searchParameterSet();
      if (request.action.kind !== 'search-list') throw new TypeError('Search request drifted.');
      const compiled = compileSearchPageRequestV1({
        parameterSet,
        page: request.action.request.page,
        pageSessionId,
      });
      return new RuntimeSearchPage(compiled.outerDataJson);
    }
    case 'offer-detail':
      return scenario === 'chain-coherent-technical-failure-v1'
        ? new RuntimeOfferTechnicalFailurePage()
        : new RuntimeOfferPage();
    case 'store-qualification':
      return new RuntimeQualificationPage();
    case 'store-sample':
      return new RuntimeStorePage();
  }
}

class RuntimeOfferTechnicalFailurePage extends EventEmitter {
  async goto(): Promise<never> {
    throw new Error('OFFLINE_SCENARIO_OFFER_TRANSPORT_FAILURE');
  }

  url(): string { return 'about:blank'; }
}

class RuntimeSearchPage extends EventEmitter {
  constructor(private readonly outerDataJson: string) { super(); }

  async goto(): Promise<null> {
    const url = `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${
      encodeURIComponent(this.outerDataJson)
    }`;
    this.emit('response', response(url, JSON.stringify(SEARCH_INPUT.response)));
    return null;
  }
}

class RuntimeOfferPage extends EventEmitter {
  private currentUrl = 'about:blank';

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    const correlation = encodeURIComponent(JSON.stringify({
      offerId: OFFER_INPUT.offerId,
      memberId: OFFER_INPUT.memberId,
    }));
    const consignmentScope = encodeURIComponent(JSON.stringify({
      offerId: OFFER_INPUT.offerId,
      memberId: OFFER_INPUT.memberId,
      mmgaRequest: { serviceName: 'offerPCConsignInfoService' },
    }));
    this.emit('response', response(
      'https://h5api.m.1688.com/h5/mtop.1688.wosc.queryofferskuselectormodel/1.0/',
      JSON.stringify(OFFER_INPUT.skuResponse),
    ));
    await transportTurn();
    this.emit('response', response(
      `https://h5api.m.1688.com/h5/mtop.1688.moga.pc.shopcard/1.0/?data=${correlation}`,
      JSON.stringify(OFFER_INPUT.shopCardResponse),
    ));
    await transportTurn();
    this.emit('response', response(
      `https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/?data=${consignmentScope}`,
      JSON.stringify(OFFER_INPUT.consignmentResponse),
    ));
    await transportTurn();
    this.emit('response', response(
      'https://itemcdn.tmall.com/1688offer/runtime-fixture-detail',
      OFFER_INPUT.detailScript,
      'text/javascript',
    ));
    await transportTurn();
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Runtime Fixture Offer - Alibaba'; }
  async waitForFunction(): Promise<void> {}
  async content(): Promise<string> { return OFFER_INPUT.coreHtml; }

  async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
    const source = String(fn);
    if (source.includes('scrollTo')) throw new Error('fixture skips lazy scrolling');
    if (typeof arg === 'boolean') {
      return {
        sourcePayload: { fixture: 'runtime-offer-core' },
        skuContext: {},
        ...OFFER_INPUT.pageInfo,
      };
    }
    if (source.includes('document.body')) return '';
    return null;
  }
}

class RuntimeQualificationPage extends EventEmitter {
  private currentUrl = 'about:blank';

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Runtime Fixture Qualification'; }
  async waitForFunction(): Promise<void> {}

  async evaluate(fn: unknown, arg?: { data?: { componentKey?: string; params?: string } }): Promise<unknown> {
    if (arg === undefined) return String(fn).includes('document.body') ? '' : null;
    const data = encodeURIComponent(JSON.stringify({
      componentKey: SUPPLIER_QUALIFICATION_COMPONENT_KEY,
      params: JSON.stringify({ memberId: QUALIFICATION_INPUT.memberId }),
    }));
    this.emit('response', response(
      `https://h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.ModuleAsyncService/1.0/?data=${data}`,
      JSON.stringify(QUALIFICATION_INPUT.response),
    ));
    return null;
  }
}

class RuntimeStorePage extends EventEmitter {
  private currentUrl = 'about:blank';

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    const data = encodeURIComponent(JSON.stringify({
      componentKey: 'wp_pc_common_header',
      params: JSON.stringify({ memberId: STORE_INPUT.memberId }),
    }));
    this.emit('response', response(
      `https://h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.ModuleAsyncService/1.0/?data=${data}`,
      JSON.stringify(STORE_INPUT.headerResponse),
    ));
    return null;
  }

  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return 'Runtime Fixture Store'; }
  async waitForFunction(): Promise<void> {}

  async evaluate(fn: unknown, arg?: { data?: { params?: string } }): Promise<unknown> {
    if (arg === undefined) return String(fn).includes('document.body') ? '' : null;
    const params = JSON.parse(arg.data?.params ?? '{}') as { appdata?: { pageNum?: number } };
    const page = STORE_INPUT.pages.find(
      (candidate) => candidate.pageNumber === params.appdata?.pageNum,
    );
    if (!page) throw new Error('Unknown runtime fixture Store page.');
    return structuredClone(page.response);
  }
}

function response(
  url: string,
  body: string,
  contentType = 'application/json',
) {
  return {
    url: () => url,
    text: async () => body,
    headers: () => ({ 'content-type': contentType }),
    request: () => ({ postData: () => null }),
  };
}

async function transportTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function fence(prefix: string, leaseNotAfter: string) {
  return {
    leaseId: `runtime-${prefix}-lease`,
    generation: 1,
    fencingToken: `runtime-${prefix}-fence`,
    leaseNotAfter,
  };
}

async function withFixedClock<T>(operation: () => Promise<T>): Promise<T> {
  return withClock(new Date(FIXED_NOW), operation);
}

async function withClock<T>(now: Date, operation: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Date');
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      super(value ?? now.toISOString());
    }
    static override now(): number { return now.getTime(); }
  }
  Object.defineProperty(globalThis, 'Date', {
    ...original,
    configurable: true,
    value: FixedDate,
  });
  try {
    return await operation();
  } finally {
    if (original) Object.defineProperty(globalThis, 'Date', original);
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRelative(root: string, relativePath: string, bytes: Buffer): Promise<void> {
  const resolved = path.join(root, safeRelativePath(relativePath));
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, bytes, { mode: 0o600 });
}

function safeRelativePath(value: string): string {
  if (!value || path.isAbsolute(value) || value.split('/').includes('..')) {
    throw new Error(`Fixture path is not a safe relative path: ${value}`);
  }
  return value;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function readFileMap(root: string): Promise<Map<string, Buffer>> {
  return new Map(await Promise.all((await listFiles(root)).map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(root, relativePath)),
  ] as const)));
}

function receipt(relativePath: string, bytes: Buffer): FileReceipt {
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function strictRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const parsed = record(value, label);
  if (
    JSON.stringify(Object.keys(parsed).sort())
    !== JSON.stringify([...expectedKeys].sort())
  ) {
    throw new TypeError(`${label} contains missing or unknown fields.`);
  }
  return parsed;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseFileReceipt(value: unknown, label: string): FileReceipt {
  const parsed = strictRecord(value, label, ['path', 'bytes', 'sha256']);
  const filePath = safeRelativePath(text(parsed['path'], `${label}.path`));
  const bytes = parsed['bytes'];
  const digest = parsed['sha256'];
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
    throw new TypeError(`${label}.bytes must be a non-negative integer.`);
  }
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError(`${label}.sha256 must be SHA-256.`);
  }
  return { path: filePath, bytes: bytes as number, sha256: digest };
}

function exactActionPath(value: unknown, expected: string, label: string): string {
  const parsed = safeRelativePath(text(value, label));
  if (parsed !== expected) throw new Error(`${label} drifted from ${expected}.`);
  return parsed;
}

function claimManifestPath(paths: Set<string>, relativePath: string): void {
  if (paths.has(relativePath)) {
    throw new Error(`Runtime fixture manifest claims ${relativePath} more than once.`);
  }
  paths.add(relativePath);
}

function assertEmbeddedFileReceipt(
  receiptByPath: ReadonlyMap<string, FileReceipt>,
  embedded: FileReceipt,
  label: string,
): void {
  const global = receiptByPath.get(embedded.path);
  if (
    !global
    || global.bytes !== embedded.bytes
    || global.sha256 !== embedded.sha256
  ) {
    throw new Error(`${label} differs from the global file receipt.`);
  }
}

async function assertManifestFileBinding(
  root: string,
  receiptByPath: ReadonlyMap<string, FileReceipt>,
  relativePath: string,
  expectedHash: unknown,
): Promise<void> {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedHash)) {
    throw new TypeError(`${relativePath} manifest hash is invalid.`);
  }
  const bytes = await fs.readFile(path.join(root, safeRelativePath(relativePath)));
  const global = receiptByPath.get(relativePath);
  if (
    sha256(bytes) !== expectedHash
    || !global
    || global.bytes !== bytes.byteLength
    || global.sha256 !== expectedHash
  ) {
    throw new Error(`${relativePath} differs from its manifest or global file receipt.`);
  }
}

async function assertArchiveBindings(
  root: string,
  actionKind: ActionKind,
  archiveFiles: readonly FileReceipt[],
  response: PageActionExecuteResponseV1,
): Promise<void> {
  const archivePaths = archiveFiles.map((entry) => entry.path);
  if (JSON.stringify(archivePaths) !== JSON.stringify([...archivePaths].sort())) {
    throw new Error(`${actionKind} archive manifest must be sorted.`);
  }
  const attempts = response.executionAttemptReceipt.remoteRequestAttempts;
  const attemptById = new Map(attempts.map((attempt) => [attempt.remoteRequestAttemptId, attempt]));
  const responseArtifactRefs = new Set(
    attempts.flatMap((attempt) => attempt.rawEvidenceRefs),
  );
  const archiveArtifactRefs = new Set<string>();
  let cursorArtifacts = 0;
  for (const file of archiveFiles) {
    const artifactRef = `artifact:${path.basename(file.path, '.json')}`;
    const artifact = record(
      JSON.parse(await fs.readFile(path.join(root, safeRelativePath(file.path)), 'utf8')),
      `${actionKind} archive`,
    );
    const schema = artifact['schema'];
    if (schema === 'collector.sanitized-raw-archive.v1') {
      strictRecord(artifact, `${actionKind} raw archive`, [
        'schema', 'kind', 'parserRevision', 'pageActionId', 'remoteRequestAttemptId',
        'requestBusinessHash', 'sanitizedPayload', 'payloadHash',
      ]);
      assertCollectorRawArchiveV1(artifactRef, artifact as unknown as CollectorRawArchiveV1);
      assertRemoteArtifactLineage(actionKind, artifact, attemptById);
      archiveArtifactRefs.add(artifactRef);
      continue;
    }
    if (schema === 'collector.offer-source-sidecar.v1') {
      strictRecord(artifact, `${actionKind} offer source sidecar`, [
        'schema', 'source', 'offerId', 'memberId', 'correlatedOfferId',
        'correlatedMemberId', 'pageActionId', 'remoteRequestAttemptId', 'capturedAt',
        'sanitizedRawPayload',
      ]);
      assertOfferSourceSidecarBindingV1(
        artifactRef,
        artifact as unknown as OfferSourceSidecarV1,
      );
      assertRemoteArtifactLineage(actionKind, artifact, attemptById);
      archiveArtifactRefs.add(artifactRef);
      continue;
    }
    if (schema === 'collector.store-sample-cursor-artifact.v1') {
      strictRecord(artifact, `${actionKind} Store cursor archive`, [
        'schema', 'generation', 'cursor', 'contentHash',
      ]);
      if (actionKind !== 'store-sample') {
        throw new Error('Store cursor artifact belongs to a non-Store action.');
      }
      const generation = text(artifact['generation'], 'Store cursor generation');
      const cursor = record(artifact['cursor'], 'Store cursor');
      const content = { schema, generation, cursor };
      const expectedFilename = 'store-sample-cursor-'
        + createHash('sha256').update(generation, 'utf8').digest('hex')
        + '.json';
      if (
        path.basename(file.path) !== expectedFilename
        || artifact['contentHash'] !== canonicalCollectorSha256V1(content)
        || !containsCanonicalValue(response.completionReceipt, cursor)
      ) {
        throw new Error('Store cursor archive is not bound to its runtime completion.');
      }
      cursorArtifacts += 1;
      continue;
    }
    throw new Error(`${actionKind} archive schema is not a runtime artifact schema.`);
  }
  if (
    JSON.stringify([...archiveArtifactRefs].sort())
      !== JSON.stringify([...responseArtifactRefs].sort())
  ) {
    throw new Error(`${actionKind} raw archives differ from execution-attempt artifact refs.`);
  }
  const batchArtifactRefs = collectStringArrayProperty(
    response.completionReceipt,
    'rawEvidenceRefs',
  );
  if (
    JSON.stringify([...new Set(batchArtifactRefs)].sort())
      !== JSON.stringify([...responseArtifactRefs].sort())
  ) {
    throw new Error(`${actionKind} Batch raw evidence differs from execution-attempt refs.`);
  }
  if ((actionKind === 'store-sample' ? 1 : 0) !== cursorArtifacts) {
    throw new Error(`${actionKind} cursor archive inventory is invalid.`);
  }
}

function assertRemoteArtifactLineage(
  actionKind: ActionKind,
  artifact: Record<string, unknown>,
  attemptById: ReadonlyMap<
    string,
    PageActionExecuteResponseV1['executionAttemptReceipt']['remoteRequestAttempts'][number]
  >,
): void {
  const attemptId = text(artifact['remoteRequestAttemptId'], 'archive attempt id');
  const attempt = attemptById.get(attemptId);
  if (
    !attempt
    || artifact['pageActionId'] !== `runtime-page-action-${actionKind}`
    || (
      artifact['schema'] === 'collector.sanitized-raw-archive.v1'
      && artifact['requestBusinessHash'] !== attempt.requestBusinessHash
    )
  ) {
    throw new Error(`${actionKind} archive lineage differs from its execution attempt.`);
  }
}

function collectStringArrayProperty(
  value: unknown,
  property: string,
  depth = 0,
): string[] {
  if (depth > 64) throw new Error('Archive semantic scan depth exceeded.');
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStringArrayProperty(item, property, depth + 1));
  }
  if (value === null || typeof value !== 'object') return [];
  const output: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === property) {
      output.push(...array(child, property).map((item) => text(item, property)));
    } else {
      output.push(...collectStringArrayProperty(child, property, depth + 1));
    }
  }
  return output;
}

function containsCanonicalValue(value: unknown, expected: unknown, depth = 0): boolean {
  if (depth > 64) throw new Error('Archive cursor scan depth exceeded.');
  if (
    value !== null
    && typeof value === 'object'
    && canonicalCollectorSha256V1(value) === canonicalCollectorSha256V1(expected)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsCanonicalValue(item, expected, depth + 1));
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>)
    .some((item) => containsCanonicalValue(item, expected, depth + 1));
}

function assertStoreFixtureAttempts(response: PageActionExecuteResponseV1): void {
  const actual = response.executionAttemptReceipt.remoteRequestAttempts.map((attempt) => ({
    ordinal: attempt.ordinal,
    logicalPage: attempt.logicalPage,
    purpose: attempt.purpose,
    status: attempt.status,
  }));
  const expected = [
    { ordinal: 1, logicalPage: 1, purpose: 'discovery', status: 'succeeded' },
    { ordinal: 2, logicalPage: 1, purpose: 'forward', status: 'succeeded' },
    { ordinal: 3, logicalPage: 2, purpose: 'forward', status: 'succeeded' },
    { ordinal: 4, logicalPage: 3, purpose: 'forward', status: 'succeeded' },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Store fixture must preserve discovery plus exact forward pages 1-3.');
  }
}

function scanForSecretsAndPii(value: unknown, location: string, depth = 0): void {
  if (depth > 64) throw new Error(`${location}: recursive security scan depth exceeded.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecretsAndPii(item, `${location}[${index}]`, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/iu.test(key)) {
        throw new Error(`${location}.${key}: credential-bearing key is forbidden.`);
      }
      if (
        /(?:hash|sha256)$/iu.test(key)
        && typeof child === 'string'
        && /^(?:sha256:)?[0-9a-f]{64}$/iu.test(child)
      ) {
        continue;
      }
      scanForSecretsAndPii(child, `${location}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const violations = [
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/iu,
    /\b(?:cookie|authorization|password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/iu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
    /(?<!\d)\d{3}[- ]\d{3}[- ]\d{4}(?!\d)/u,
    /(?<!\d)\d{17}[0-9Xx](?!\d)/u,
  ];
  if (violations.some((pattern) => pattern.test(value))) {
    throw new Error(`${location}: secret, credential, or personal-data pattern detected.`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await checkRuntimeDerivedPageActionFixtures();
    process.stdout.write('runtime PageAction fixtures: deterministic and verified\n');
    return;
  }
  await generateRuntimeDerivedPageActionFixtures();
  process.stdout.write('runtime PageAction fixtures: generated and verified\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
