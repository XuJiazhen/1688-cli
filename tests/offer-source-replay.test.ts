import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as offerCommand from '../src/commands/offer.js';
import {
  assertOfferSourceReceiptsCompleteV1,
  assertOfferSourceSidecarBindingV1,
  createOfferSourceSidecarV1,
  createOfferSourceTerminalReceiptV1,
  mapConsignmentPayload,
  mapShopCardPayload,
  type OfferSourceTerminalReceiptV1,
} from '../src/session/offer-evidence.js';

interface ReplayFixtureV1 {
  schema: 'collector.offer-source-replay-fixture.v1';
  origin: {
    run: string;
    outerCommit: string | null;
    nestedCommit: string | null;
    sanitization: string;
  };
  subject: {
    offerId: string;
    sellerMemberId: string;
    sellerLoginId: string;
    canonicalShopUrl: string;
  };
  page: {
    canonicalOfferId: string;
    sellerShopUrl: string | null;
  };
  offerCore: unknown;
  shopCard: {
    requestScope: Record<string, unknown>;
    responseSucceeded: boolean;
    payload: unknown;
    legacySidecarCorrelation: {
      offerId: string | null;
      memberId: string | null;
    } | null;
  };
  consignment: {
    requestScope: Record<string, unknown>;
    responseSucceeded: boolean;
    payload: unknown;
  } | null;
  expected: {
    shopCardState: OfferSourceTerminalReceiptV1['state'];
    consignmentState: OfferSourceTerminalReceiptV1['state'];
    consignmentAuthoritySource: 'offer-core' | null;
  };
}

const FIXTURES_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'offer-source-replay-v1',
);

async function loadFixture(name: string): Promise<ReplayFixtureV1> {
  return JSON.parse(
    await fs.readFile(path.join(FIXTURES_DIR, name), 'utf8'),
  ) as ReplayFixtureV1;
}

function sourceRequestUrl(
  source: 'shop-card' | 'offer-consignment',
  requestScope: Record<string, unknown>,
): string {
  const api = source === 'shop-card'
    ? 'mtop.1688.moga.pc.shopcard'
    : 'mtop.1688.mmga.offerdetail.service';
  const url = new URL(`https://h5api.m.1688.com/h5/${api}/1.0/`);
  if (Object.keys(requestScope).length > 0) {
    url.searchParams.set('data', JSON.stringify(requestScope));
  }
  return url.toString();
}

function assertNoReplayableSecrets(value: unknown): void {
  const forbiddenKeys: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (
        /^(?:authorization|cookie|cookies|token|accesstoken|refreshtoken|sign|signature|mh5tk)$/u
          .test(normalized)
      ) {
        forbiddenKeys.push(key);
      }
      visit(child);
    }
  };
  visit(value);
  expect(forbiddenKeys).toEqual([]);
}

function replayOfferSources(fixture: ReplayFixtureV1): {
  shopCard: OfferSourceTerminalReceiptV1;
  consignment: OfferSourceTerminalReceiptV1;
} {
  const { subject } = fixture;
  offerCommand.assertOfferPageIdentityV1(
    fixture.page.canonicalOfferId,
    subject.offerId,
  );
  const readCoreShopUrl = (
    offerCommand as typeof offerCommand & {
      readOfferCoreSellerShopUrlAuthorityV1?: (
        payload: unknown,
        offerId: string,
        memberId: string | null,
        loginId?: string | null,
      ) => string | null;
    }
  ).readOfferCoreSellerShopUrlAuthorityV1;
  const coreShopUrl = readCoreShopUrl?.(
    fixture.offerCore,
    subject.offerId,
    subject.sellerMemberId,
    subject.sellerLoginId,
  ) ?? null;
  expect(coreShopUrl).toBe(subject.canonicalShopUrl);

  const shopCardValue = mapShopCardPayload(fixture.shopCard.payload);
  expect(shopCardValue).not.toBeNull();
  const shopCardCorrelation = offerCommand.resolveOfferSourceCorrelationScopeV1({
    requestUrl: sourceRequestUrl('shop-card', fixture.shopCard.requestScope),
    rawPayload: fixture.shopCard.payload,
    observedOfferId: subject.offerId,
    observedSellerLoginId: subject.sellerLoginId,
    observedSellerMemberId: subject.sellerMemberId,
    observedSellerShopUrl: fixture.page.sellerShopUrl ?? coreShopUrl,
    allowSellerShopUrlBinding: true,
  });
  const shopCardSidecar = createOfferSourceSidecarV1({
    source: 'shop-card',
    offerId: subject.offerId,
    memberId: subject.sellerMemberId,
    correlatedOfferId: shopCardCorrelation.correlatedOfferId,
    correlatedMemberId: shopCardCorrelation.correlatedMemberId,
    pageActionId: 'replay-action',
    remoteRequestAttemptId: 'replay-remote-attempt',
    capturedAt: '2026-08-09T00:00:00.000Z',
    rawPayload: fixture.shopCard.payload,
  });
  assertOfferSourceSidecarBindingV1(
    shopCardSidecar.artifactRef,
    shopCardSidecar.artifact,
  );
  expect(shopCardSidecar.artifact).toMatchObject({
    offerId: subject.offerId,
    memberId: subject.sellerMemberId,
    correlatedOfferId: subject.offerId,
    correlatedMemberId: subject.sellerMemberId,
  });
  const shopCard = createOfferSourceTerminalReceiptV1({
    source: 'shop-card',
    offerId: subject.offerId,
    memberId: subject.sellerMemberId,
    pageActionId: 'replay-action',
    remoteRequestAttemptId: 'replay-remote-attempt',
    responseObserved: true,
    responseSucceeded: fixture.shopCard.responseSucceeded,
    correlatedOfferId: shopCardCorrelation.correlatedOfferId,
    correlatedMemberId: shopCardCorrelation.correlatedMemberId,
    parsedValue: shopCardValue,
    rawEvidenceRefs: [shopCardSidecar.artifactRef],
  });

  let consignment: OfferSourceTerminalReceiptV1;
  let consignmentArtifactRef: string;
  if (fixture.consignment !== null) {
    const consignmentValue = mapConsignmentPayload(
      fixture.consignment.payload,
      sourceRequestUrl('offer-consignment', fixture.consignment.requestScope),
    );
    expect(consignmentValue).not.toBeNull();
    const correlation = offerCommand.resolveOfferSourceCorrelationScopeV1({
      requestUrl: sourceRequestUrl(
        'offer-consignment',
        fixture.consignment.requestScope,
      ),
      rawPayload: fixture.consignment.payload,
      observedOfferId: subject.offerId,
      observedSellerLoginId: subject.sellerLoginId,
      observedSellerMemberId: subject.sellerMemberId,
    });
    const sidecar = createOfferSourceSidecarV1({
      source: 'offer-consignment',
      offerId: subject.offerId,
      memberId: subject.sellerMemberId,
      correlatedOfferId: correlation.correlatedOfferId,
      correlatedMemberId: correlation.correlatedMemberId,
      pageActionId: 'replay-action',
      remoteRequestAttemptId: 'replay-remote-attempt',
      capturedAt: '2026-08-09T00:00:00.000Z',
      rawPayload: fixture.consignment.payload,
    });
    consignmentArtifactRef = sidecar.artifactRef;
    assertOfferSourceSidecarBindingV1(sidecar.artifactRef, sidecar.artifact);
    consignment = createOfferSourceTerminalReceiptV1({
      source: 'offer-consignment',
      offerId: subject.offerId,
      memberId: subject.sellerMemberId,
      pageActionId: 'replay-action',
      remoteRequestAttemptId: 'replay-remote-attempt',
      responseObserved: true,
      responseSucceeded: fixture.consignment.responseSucceeded,
      correlatedOfferId: correlation.correlatedOfferId,
      correlatedMemberId: correlation.correlatedMemberId,
      parsedValue: consignmentValue,
      rawEvidenceRefs: [sidecar.artifactRef],
    });
  } else {
    const readCoreAbsence = (
      offerCommand as typeof offerCommand & {
        readOfferCoreConsignmentAbsenceV1?: (
          payload: unknown,
          offerId: string,
          memberId: string | null,
        ) => ReturnType<typeof offerCommand.readOfferCoreConsignmentAbsenceV1>;
      }
    ).readOfferCoreConsignmentAbsenceV1;
    const coreAbsence = readCoreAbsence?.(
      fixture.offerCore,
      subject.offerId,
      subject.sellerMemberId,
    ) ?? null;
    expect(coreAbsence).not.toBeNull();
    const sidecar = createOfferSourceSidecarV1({
      source: 'offer-consignment',
      authoritySource: 'offer-core',
      offerId: subject.offerId,
      memberId: subject.sellerMemberId,
      correlatedOfferId: coreAbsence!.correlatedOfferId,
      correlatedMemberId: coreAbsence!.correlatedMemberId,
      pageActionId: 'replay-action',
      remoteRequestAttemptId: 'replay-remote-attempt',
      capturedAt: '2026-08-09T00:00:00.000Z',
      rawPayload: fixture.offerCore,
    });
    consignmentArtifactRef = sidecar.artifactRef;
    assertOfferSourceSidecarBindingV1(sidecar.artifactRef, sidecar.artifact);
    expect(sidecar.artifact).toMatchObject({
      authoritySource: 'offer-core',
      offerId: subject.offerId,
      memberId: subject.sellerMemberId,
      correlatedOfferId: subject.offerId,
      correlatedMemberId: subject.sellerMemberId,
      sanitizedRawPayload: {
        contextResult: {
          data: { gallery: { fields: { offerId: Number(subject.offerId) } } },
          global: { globalData: { model: {
            sellerModel: { memberId: subject.sellerMemberId },
            consignModel: { consignSign: { signs: {
              isSupportConsignIssuing: false,
            } } },
          } } },
        },
      },
    });
    consignment = createOfferSourceTerminalReceiptV1({
      source: 'offer-consignment',
      authoritySource: 'offer-core',
      offerId: subject.offerId,
      memberId: subject.sellerMemberId,
      pageActionId: 'replay-action',
      remoteRequestAttemptId: 'replay-remote-attempt',
      responseObserved: coreAbsence!.responseObserved,
      responseSucceeded: coreAbsence!.responseSucceeded,
      correlatedOfferId: coreAbsence!.correlatedOfferId,
      correlatedMemberId: coreAbsence!.correlatedMemberId,
      parsedValue: null,
      authoritativeEmpty: coreAbsence!.authoritativeEmpty,
      rawEvidenceRefs: [sidecar.artifactRef],
    });
  }

  assertOfferSourceReceiptsCompleteV1({
    offerId: subject.offerId,
    memberId: subject.sellerMemberId,
    pageActionId: 'replay-action',
    remoteRequestAttemptId: 'replay-remote-attempt',
    remoteRawEvidenceRefs: [
      shopCardSidecar.artifactRef,
      consignmentArtifactRef,
    ],
    shopCard,
    consignment,
  });
  return { shopCard, consignment };
}

describe('sanitized Offer source replay', () => {
  it.each([
    'r37-offer-968683334168.json',
    'r43-control-offer-975300719504.json',
    'dedicated-consignment-control.json',
  ])('replays %s to terminal source receipts', async (name) => {
    const fixture = await loadFixture(name);
    assertNoReplayableSecrets(fixture);

    const receipts = replayOfferSources(fixture);

    expect(receipts.shopCard.state).toBe(fixture.expected.shopCardState);
    expect(receipts.consignment.state).toBe(fixture.expected.consignmentState);
    expect(receipts.consignment.authoritySource ?? null).toBe(
      fixture.expected.consignmentAuthoritySource,
    );
    expect(receipts.shopCard).toMatchObject({
      offerId: fixture.subject.offerId,
      memberId: fixture.subject.sellerMemberId,
      correlation: 'matched',
    });
    expect(receipts.consignment).toMatchObject({
      offerId: fixture.subject.offerId,
      memberId: fixture.subject.sellerMemberId,
      correlation: 'matched',
    });
  });

  it('records the exact r37/r43 legacy null-correlation symptom before replay', async () => {
    for (const name of [
      'r37-offer-968683334168.json',
      'r43-control-offer-975300719504.json',
    ]) {
      const fixture = await loadFixture(name);
      expect(fixture.shopCard.legacySidecarCorrelation).toEqual({
        offerId: null,
        memberId: null,
      });
      expect(replayOfferSources(fixture).shopCard).toMatchObject({
        state: 'available',
        correlation: 'matched',
      });
    }
  });
});
