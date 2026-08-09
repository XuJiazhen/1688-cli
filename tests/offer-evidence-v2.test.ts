import { describe, expect, it } from 'vitest';
import {
  assertOfferSourceSidecarBindingV1,
  assertOfferSourceReceiptsCompleteV1,
  createOfferSourceSidecarV1,
  createOfferSourceTerminalReceiptV1,
} from '../src/session/offer-evidence.js';
import {
  buildOfferMediaManifestV2,
  createOfferSingletonSourceKeyV1,
  createSourceMediaReferenceV2,
  normalize1688MediaUrlV2,
  sourceMediaOwnershipKeyV2,
} from '../src/session/offer-media.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('Offer evidence and SourceMedia V2', () => {
  it.each([
    ['//cbu01.alicdn.com/a.jpg?__r__=1&x-oss-process=resize', 'https://cbu01.alicdn.com/a.jpg?x-oss-process=resize'],
    ['cbu01.alicdn.com/img/ibank/a.jpg', 'https://cbu01.alicdn.com/img/ibank/a.jpg'],
    ['img/ibank/a.jpg', 'https://cbu01.alicdn.com/img/ibank/a.jpg'],
    ['/img/ibank/a.jpg', 'https://cbu01.alicdn.com/img/ibank/a.jpg'],
    ['http://cbu01.alicdn.com/a.jpg?z=2&a=1', 'https://cbu01.alicdn.com/a.jpg?a=1&z=2'],
  ])('normalizes %s idempotently', (raw, expected) => {
    const first = normalize1688MediaUrlV2(raw);
    expect(first).toMatchObject({ normalizedUrl: expected, warningCode: null });
    expect(normalize1688MediaUrlV2(first.normalizedUrl!).normalizedUrl).toBe(expected);
  });

  it('warns for unknown hosts without pretending they are Alibaba and rejects unsafe URLs', () => {
    expect(normalize1688MediaUrlV2('https://images.example.test/a.jpg')).toMatchObject({
      normalizedUrl: 'https://images.example.test/a.jpg',
      warningCode: 'MEDIA_URL_HOST_UNRECOGNIZED',
    });
    expect(normalize1688MediaUrlV2('data:image/png;base64,x')).toMatchObject({
      normalizedUrl: null, warningCode: 'MEDIA_URL_INVALID',
    });
    expect(normalize1688MediaUrlV2('https://user:pass@cbu01.alicdn.com/a')).toMatchObject({
      normalizedUrl: null, warningCode: 'MEDIA_URL_INVALID',
    });
  });

  it('keeps the same URL separate for different SKU and catalog owners', () => {
    const create = (owner: Parameters<typeof createSourceMediaReferenceV2>[0]['owner']) =>
      createSourceMediaReferenceV2({
        role: owner.ownerKind === 'store-catalog-offer' ? 'main' : 'sku',
        owner, order: 0, sourceOrdinal: 0,
        originalUrl: '//cbu01.alicdn.com/shared.jpg',
        sourceField: 'fixture.image', sourceObservationId: 'observation-1',
        sourcePayloadContentSha256: HASH,
      }).reference!;
    const sku1 = create({ ownerKind: 'target-sku', offerId: '100', platformSkuId: 'sku-1' });
    const sku2 = create({ ownerKind: 'target-sku', offerId: '100', platformSkuId: 'sku-2' });
    const catalog = create({ ownerKind: 'store-catalog-offer', catalogOfferId: '100', catalogPage: 2, catalogRank: 5 });
    expect(new Set([sku1, sku2, catalog].map(sourceMediaOwnershipKeyV2)).size).toBe(3);
    expect(catalog).toMatchObject({ catalogPage: 2, catalogRank: 5, sourceOrdinal: 0 });
  });

  it('generates replay-stable singleton/source keys and rejects random singleton identities', () => {
    const singletonSourceKey = createOfferSingletonSourceKeyV1('100');
    const input = {
      role: 'sku' as const,
      owner: { ownerKind: 'target-sku' as const, offerId: '100', platformSkuId: null, singletonSourceKey },
      order: 0, sourceOrdinal: 0, originalUrl: '//cbu01.alicdn.com/single.jpg',
      sourceField: 'sku.image', sourceObservationId: 'observation-runtime-id',
      sourcePayloadContentSha256: HASH,
    };
    const first = createSourceMediaReferenceV2(input).reference!;
    const second = createSourceMediaReferenceV2(input).reference!;
    expect(first.sourceOwnerKey).toBe(second.sourceOwnerKey);
    expect(first.sourceReceiptContentSha256).toBe(second.sourceReceiptContentSha256);
    expect(() => createSourceMediaReferenceV2({
      ...input,
      owner: { ...input.owner, singletonSourceKey: 'random' },
    })).toThrow(/does not match/i);
  });

  it('builds the complete role manifest and refuses unresolved variant SKU ownership', () => {
    const manifest = buildOfferMediaManifestV2({
      offerId: '100', sourceObservationId: 'observation-1',
      sourcePayloadContentSha256: HASH,
      mainImage: '//cbu01.alicdn.com/main.jpg',
      galleryImages: ['//cbu01.alicdn.com/gallery.jpg'],
      skus: [{ platformSkuId: 'sku-1', image: '//cbu01.alicdn.com/sku.jpg' }],
      explicitSingleSkuWithoutPlatformId: false,
      detailImages: ['//cbu01.alicdn.com/detail.jpg'],
      detailSourceState: 'available',
    });
    expect(manifest.items.map((item) => item.role).sort()).toEqual(['detail', 'gallery', 'main', 'sku']);
    expect(manifest).toMatchObject({ availability: 'available' });
    expect(() => buildOfferMediaManifestV2({
      offerId: '100', sourceObservationId: 'observation-1',
      sourcePayloadContentSha256: HASH, mainImage: null, galleryImages: [],
      skus: [
        { platformSkuId: null, image: '//cbu01.alicdn.com/a.jpg' },
        { platformSkuId: 'sku-2', image: '//cbu01.alicdn.com/b.jpg' },
      ],
      explicitSingleSkuWithoutPlatformId: false,
      detailImages: [], detailSourceState: 'not-present',
    })).toThrow(/cannot be downgraded/i);
  });

  it('requires independent terminal ShopCard and Consignment receipts with proof for absence', () => {
    const shopSidecar = createOfferSourceSidecarV1({
      source: 'shop-card', offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z', rawPayload: { data: { model: { shopName: 'Shop' } } },
    });
    const consignmentSidecar = createOfferSourceSidecarV1({
      source: 'offer-consignment', offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z', rawPayload: { data: { data: { data: { data: {} } } } },
    });
    const coreConsignmentSidecar = createOfferSourceSidecarV1({
      source: 'offer-consignment', authoritySource: 'offer-core',
      offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      rawPayload: {
        contextResult: {
          data: { gallery: { fields: { offerId: '100' } } },
          global: { globalData: { model: {
            sellerModel: { memberId: 'member-1' },
            consignModel: {
              consignOffer: false,
              hasConsignPrice: false,
              consignSign: {
                supportConsignIssuing: false,
                signs: { isSupportConsignIssuing: false },
              },
            },
          } } },
        },
      },
    });
    const common = {
      offerId: '100', memberId: 'member-1', pageActionId: 'action-1',
      remoteRequestAttemptId: 'remote-1', responseObserved: true,
      responseSucceeded: true, correlatedOfferId: '100', correlatedMemberId: 'member-1',
    };
    const shopCard = createOfferSourceTerminalReceiptV1({
      ...common, source: 'shop-card', rawEvidenceRefs: [shopSidecar.artifactRef], parsedValue: {
        name: 'Shop', url: null, shopType: null, iconType: null, badge: null,
        mainCategoryName: null, years: null,
        attention: { isFollowing: null, followersText: null, operationType: null },
        metrics: [], returnRate: null, serviceScore: null, onTimeDeliveryRate: null,
        positiveReviewRate: null, companyId: null, companyLabel: null,
        companyIcons: [], shopTags: [], factoryCardUrl: null, factoryAuthText: null,
        serviceScores: [],
      },
    });
    const consignment = createOfferSourceTerminalReceiptV1({
      ...common, source: 'offer-consignment', rawEvidenceRefs: [consignmentSidecar.artifactRef], parsedValue: null,
      authoritativeEmpty: {
        sourcePath: 'data.data.data.data', sourceValue: {},
        reasonCode: 'CONSIGNMENT_SUCCESS_EMPTY_SENTINEL',
      },
    });
    expect(consignment).toMatchObject({ state: 'not-present', absenceProof: { reasonCode: 'CONSIGNMENT_SUCCESS_EMPTY_SENTINEL' } });
    const coreDeclaredConsignmentAbsence = createOfferSourceTerminalReceiptV1({
      ...common,
      source: 'offer-consignment',
      authoritySource: 'offer-core',
      responseObserved: false,
      responseSucceeded: false,
      rawEvidenceRefs: [coreConsignmentSidecar.artifactRef],
      parsedValue: null,
      authoritativeEmpty: {
        sourcePath: 'contextResult.global.globalData.model.consignModel.consignOffer',
        sourceValue: false,
        reasonCode: 'CONSIGNMENT_CORE_DECLARED_UNSUPPORTED',
      },
    });
    expect(coreDeclaredConsignmentAbsence).toMatchObject({
      authoritySource: 'offer-core',
      responseObserved: false,
      responseSucceeded: false,
      state: 'not-present',
      absenceProof: { reasonCode: 'CONSIGNMENT_CORE_DECLARED_UNSUPPORTED' },
    });
    expect(coreDeclaredConsignmentAbsence.absenceProof).toMatchObject({
      authorityArtifactRef: coreConsignmentSidecar.artifactRef,
    });
    expect(() => assertOfferSourceSidecarBindingV1(
      coreConsignmentSidecar.artifactRef,
      coreConsignmentSidecar.artifact,
    )).not.toThrow();
    expect(() => assertOfferSourceSidecarBindingV1(
      coreConsignmentSidecar.artifactRef,
      {
        ...coreConsignmentSidecar.artifact,
        authorityEvidence: {
          ...coreConsignmentSidecar.artifact.authorityEvidence!,
          memberId: 'member-forged',
        },
      },
    )).toThrow(/sidecar authority is invalid/iu);
    expect(() => assertOfferSourceReceiptsCompleteV1({
      offerId: '100', memberId: 'member-1', pageActionId: 'action-1',
      remoteRequestAttemptId: 'remote-1',
      remoteRawEvidenceRefs: [shopSidecar.artifactRef, coreConsignmentSidecar.artifactRef],
      shopCard, consignment: coreDeclaredConsignmentAbsence,
    })).not.toThrow();
    expect(() => createOfferSourceSidecarV1({
      source: 'shop-card', authoritySource: 'offer-core',
      offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z', rawPayload: {},
    })).toThrow(/only valid for Consignment absence/iu);
    expect(() => assertOfferSourceReceiptsCompleteV1({
      offerId: '100', memberId: 'member-1', pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      remoteRawEvidenceRefs: [shopSidecar.artifactRef, consignmentSidecar.artifactRef],
      shopCard, consignment,
    })).not.toThrow();
    const failed = createOfferSourceTerminalReceiptV1({
      ...common, source: 'offer-consignment', rawEvidenceRefs: [consignmentSidecar.artifactRef], parsedValue: null,
      responseObserved: false,
    });
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'OFFER_CONSIGNMENT_RESPONSE_NOT_OBSERVED' } });
    expect(() => assertOfferSourceReceiptsCompleteV1({
      offerId: '100', memberId: 'member-1', pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      remoteRawEvidenceRefs: [shopSidecar.artifactRef, consignmentSidecar.artifactRef],
      shopCard, consignment: failed,
    })).toThrow(/absent, failed/i);

    expect(() => createOfferSourceTerminalReceiptV1({
      ...common, source: 'offer-consignment', rawEvidenceRefs: [consignmentSidecar.artifactRef], parsedValue: null,
      authoritativeEmpty: {
        sourcePath: 'made.up.path', sourceValue: {}, reasonCode: 'UNREGISTERED_SENTINEL',
      },
    })).toThrow(/registered versioned sentinel/i);

    const missingRaw = createOfferSourceTerminalReceiptV1({
      ...common, rawEvidenceRefs: [], source: 'shop-card',
      parsedValue: { name: 'Shop' } as never,
    });
    expect(missingRaw).toMatchObject({
      state: 'failed',
      error: { code: 'SHOP_CARD_RAW_EVIDENCE_MISSING' },
    });

    expect(() => assertOfferSourceReceiptsCompleteV1({
      offerId: '100', memberId: 'member-1', pageActionId: 'another-action', remoteRequestAttemptId: 'remote-1',
      remoteRawEvidenceRefs: [shopSidecar.artifactRef, consignmentSidecar.artifactRef],
      shopCard, consignment,
    })).toThrow(/another scope/i);
    expect(() => assertOfferSourceReceiptsCompleteV1({
      offerId: '100', memberId: 'member-1', pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      remoteRawEvidenceRefs: [shopSidecar.artifactRef, consignmentSidecar.artifactRef],
      shopCard: { ...shopCard, rawEvidenceRefs: [] }, consignment,
    })).toThrow(/another scope/i);

    const synthetic = createOfferSourceTerminalReceiptV1({
      ...common, source: 'shop-card', parsedValue: { name: 'Shop' } as never,
      rawEvidenceRefs: ['runtime:offer:not-an-artifact'],
    });
    expect(synthetic).toMatchObject({
      state: 'failed', error: { code: 'SHOP_CARD_RAW_EVIDENCE_INVALID' },
    });
    expect(() => assertOfferSourceSidecarBindingV1(
      shopSidecar.artifactRef,
      { ...shopSidecar.artifact, memberId: 'tampered' },
    )).toThrow(/does not match/i);
  });

  it('content-addresses sanitized raw sidecars and removes credentials and contact PII', () => {
    const sidecar = createOfferSourceSidecarV1({
      source: 'shop-card', offerId: '100', memberId: 'member-1',
      correlatedOfferId: '100', correlatedMemberId: 'member-1',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      rawPayload: {
        data: {
          shopName: 'Factory',
          contactPhone: '13800138000',
          note: 'call 138 0013 8000, +1 (415) 555-1212 or email buyer@example.com',
        },
        token: 'secret',
        url: 'https://h5api.m.1688.com/h5/api/1.0/?api=safe&sign=secret&data=private',
      },
    });
    expect(sidecar.artifactRef).toMatch(/^artifact:offer-source-shop-card-[0-9a-f]{64}$/u);
    expect(sidecar.artifact.sanitizedRawPayload).toEqual({
      data: {
        shopName: 'Factory',
        contactPhone: '[redacted]',
        note: 'call [redacted], [redacted] or email [redacted]',
      },
      token: '[redacted]',
      url: 'https://h5api.m.1688.com/h5/api/1.0/?api=safe',
    });
    expect(() => assertOfferSourceSidecarBindingV1(
      sidecar.artifactRef,
      sidecar.artifact,
    )).not.toThrow();
  });

  it('preserves only exact Offer core authority identifiers through sanitization', () => {
    const sidecar = createOfferSourceSidecarV1({
      source: 'offer-consignment', authoritySource: 'offer-core',
      offerId: '968683334168', memberId: 'b2b-222035881045188136',
      correlatedOfferId: '968683334168', correlatedMemberId: 'b2b-222035881045188136',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      rawPayload: {
        contextResult: {
          data: { gallery: { fields: {
            offerId: '968683334168',
            unrelatedOfferId: '968683334168',
          } } },
          global: { globalData: { model: {
            sellerModel: {
              memberId: 'b2b-222035881045188136',
              contactPhone: '13800138000',
            },
            consignModel: {
              consignOffer: false,
              hasConsignPrice: false,
              consignSign: {
                supportConsignIssuing: false,
                signs: { isSupportConsignIssuing: false },
              },
            },
          } } },
        },
      },
    });
    expect(sidecar.artifact.sanitizedRawPayload).toMatchObject({
      contextResult: {
        data: { gallery: { fields: {
          offerId: '968683334168',
          unrelatedOfferId: '[redacted]',
        } } },
        global: { globalData: { model: { sellerModel: {
          memberId: 'b2b-222035881045188136',
          contactPhone: '[redacted]',
        } } } },
      },
    });
    expect(() => assertOfferSourceSidecarBindingV1(
      sidecar.artifactRef,
      sidecar.artifact,
    )).not.toThrow();

    const nonAuthoritySidecar = createOfferSourceSidecarV1({
      source: 'shop-card',
      offerId: '968683334168', memberId: 'b2b-222035881045188136',
      correlatedOfferId: '968683334168', correlatedMemberId: 'b2b-222035881045188136',
      pageActionId: 'action-1', remoteRequestAttemptId: 'remote-1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      rawPayload: {
        contextResult: {
          data: { gallery: { fields: { offerId: '968683334168' } } },
          global: { globalData: { model: { sellerModel: {
            memberId: 'b2b-222035881045188136',
          } } } },
        },
      },
    });
    expect(nonAuthoritySidecar.artifact.sanitizedRawPayload).toMatchObject({
      contextResult: {
        data: { gallery: { fields: { offerId: '[redacted]' } } },
        global: { globalData: { model: { sellerModel: {
          memberId: 'b2b-[redacted]',
        } } } },
      },
    });
  });
});
