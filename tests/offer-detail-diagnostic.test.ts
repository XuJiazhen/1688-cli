import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const FILE = new URL('./fixtures/offer-detail-diagnostic/118-gap-manifest.json', import.meta.url);

describe('118-record Offer Detail historical diagnostic', () => {
  it('freezes all known ShopCard/Consignment gaps without guessing absence', async () => {
    const report = JSON.parse(await readFile(FILE, 'utf8')) as {
      baselineCompletedOffers: number;
      shopCard: { responseObserved: number; parsed: number };
      consignment: { responseObserved: number; parsed: number };
      bothParsed: number;
      offers: Array<Record<string, unknown>>;
      gateStatus: string;
    };
    expect(report).toMatchObject({
      baselineCompletedOffers: 118,
      shopCard: { responseObserved: 118, parsed: 113 },
      consignment: { responseObserved: 113, parsed: 111 },
      bothParsed: 107,
      gateStatus: 'blocked_pending_controlled_recollection',
    });
    expect(report.offers).toHaveLength(12);
    expect(new Set(report.offers.map((row) => `${row.offerId}:${row.source}`)).size).toBe(12);
    expect(report.offers.every((row) =>
      row.rootCause === 'historical_evidence_insufficient' &&
      row.rawEvidenceRef === null &&
      row.expectedTerminalState === 'failed'
    )).toBe(true);
  });
});
