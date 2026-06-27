import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutputFlags } from '../src/io/output.js';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock('../src/session/dispatch.js', () => ({
  dispatch: dispatchMock,
}));

import { run } from '../src/commands/search.js';

let stdout = '';
let stderr = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = '';
  stderr = '';
  dispatchMock.mockReset();
  setOutputFlags({ json: true, cmd: 'search' });
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  setOutputFlags({ json: false, jsonV2: false, pretty: false });
});

describe('search --deeppro', () => {
  it('runs search and detail collection inline and adds a deeppro summary', async () => {
    dispatchMock
      .mockResolvedValueOnce({
        keyword: '修枝剪',
        sort: 'relevance',
        filters: { verified: 'any' },
        totalBeforeFilter: 1,
        total: 1,
        offers: [{ offerId: '100', title: 'Search hit' }],
      })
      .mockResolvedValueOnce(offerResult('100'));

    await run('修枝剪', {
      max: '1',
      deeppro: true,
      deepproDelayMin: '1',
      deepproDelayMax: '1',
      profile: 'buyer',
    });

    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      'search',
      expect.objectContaining({ keyword: '修枝剪', max: 1 }),
      { headed: undefined, profile: 'buyer', noDaemon: true },
    );
    expect(dispatchMock).toHaveBeenNthCalledWith(
      2,
      'offer',
      { offerId: '100', headed: undefined },
      { headed: undefined, profile: 'buyer', noDaemon: true },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      keyword: '修枝剪',
      total: 1,
      deeppro: {
        enabled: true,
        total: 1,
        success: 1,
        failed: 0,
        offerIds: ['100'],
        offers: [{ offerId: '100' }],
        failures: [],
      },
    });
    expect(stderr).toContain('DEEPPRO: starting deep collection of 1 offers');
    expect(stderr).toContain('DEEPPRO complete: 1/1 valid');
  });
});

function offerResult(offerId: string) {
  return {
    offerId,
    title: `Offer ${offerId}`,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    priceRange: '¥1.00',
    priceMin: 1,
    priceMax: 1,
    unitName: '件',
    minOrderQty: 1,
    mixOrderQty: null,
    priceTiers: [],
    detailUrl: null,
    attributes: [],
    packageInfo: [],
    supplier: { name: null, loginId: null, memberId: null, userId: null },
    freight: {
      receiveAddress: null,
      sendArea: null,
      province: null,
      city: null,
      unitWeight: null,
    },
    saledCount: null,
    categoryId: null,
    options: [],
    skus: [],
    mainImage: null,
    images: ['https://img.example/1.jpg'],
  };
}
