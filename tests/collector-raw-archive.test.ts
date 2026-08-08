import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCollectorRawArchiveV1,
  createCollectorRawArchiveV1,
  persistCollectorRawArchiveV1,
  sanitizeCollectorPayloadV1,
} from '../src/session/collector-raw-archive.js';

describe('Collector immutable sanitized raw archives', () => {
  it('recursively removes embedded contacts and secrets while preserving provenance', () => {
    const sanitized = sanitizeCollectorPayloadV1({
      title: '批发 13800138000 138-0013-8000 010-12345678 wx:fixture_shop',
      nested: [{ email: 'person@example.com', description: 'token=secret-token value' }],
      headers: { cookie: 'session=value' },
      owner: {
        userId: 'user-private', sellerUserId: 'seller-private',
        note: '联系人：张三 电话: 138 0013 8000 微信号: fixture_shop',
      },
      memberId: '13800138000',
      offerId: '13800138000',
      productBusinessId: '13800138000',
      productId: '13800138000',
      offer_id: '13800138000',
      'product-business-id': '13800138000',
      MEMBER_ID: '13800138000',
      user_id: '13800138000',
      collisionText: 'identity-looking 13800138000',
      contactPhone: '13800138000',
    }) as Record<string, unknown>;
    expect(sanitized).toEqual({
      title: '批发 [redacted] [redacted] [redacted] [redacted]',
      nested: [{ email: '[redacted]', description: '[redacted] value' }],
      headers: { cookie: '[redacted]' },
      owner: {
        userId: '[redacted]', sellerUserId: '[redacted]',
        note: '[redacted] [redacted] [redacted]',
      },
      memberId: '13800138000',
      offerId: '13800138000',
      productBusinessId: '13800138000',
      productId: '13800138000',
      offer_id: '13800138000',
      'product-business-id': '13800138000',
      MEMBER_ID: '13800138000',
      user_id: '[redacted]',
      collisionText: 'identity-looking [redacted]',
      contactPhone: '[redacted]',
    });
  });

  it('recursively sanitizes received JSON and JSONP text before archiving it', () => {
    const json = sanitizeCollectorPayloadV1(JSON.stringify({
      sellerUserId: 'seller-private',
      nested: { phone: '138-0013-8000', cookie: 'secret-cookie' },
      offerId: '138001380001', businessId: '01012345678',
    }));
    expect(json).toEqual({
      sellerUserId: '[redacted]',
      nested: { phone: '[redacted]', cookie: '[redacted]' },
      offerId: '138001380001', businessId: '01012345678',
    });
    expect(sanitizeCollectorPayloadV1(
      'mtopjsonp1({"data":{"userId":"private","memberId":"member-1"}})',
    )).toEqual({ data: { userId: '[redacted]', memberId: 'member-1' } });
  });

  it('preserves identity-bearing URL hosts while redacting unknown query values', () => {
    expect(sanitizeCollectorPayloadV1({
      shopUrl: 'http://shop13800138000.1688.com/catalog?phone=13800138000#top',
    })).toEqual({
      shopUrl: 'http://shop13800138000.1688.com/catalog?phone=%5Bredacted%5D',
    });
  });

  it('writes one private content-addressed immutable artifact', async () => {
    const artifactDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-raw-'));
    const archive = createCollectorRawArchiveV1({
      kind: 'search-response',
      parserRevision: 'search-response-v1@1',
      pageActionId: 'page-action-1',
      remoteRequestAttemptId: 'remote-1',
      requestBusinessHash: `sha256:${'1'.repeat(64)}`,
      payload: { title: 'Offer 13800138000', cookie: 'do-not-store' },
    });
    const first = await persistCollectorRawArchiveV1({ artifactDirectory, archive });
    const second = await persistCollectorRawArchiveV1({ artifactDirectory, archive });
    expect(first).toBe(second);
    const destination = path.join(
      artifactDirectory,
      `${archive.artifactRef.slice('artifact:'.length)}.json`,
    );
    const stored = JSON.parse(await fs.readFile(destination, 'utf8'));
    expect(() => assertCollectorRawArchiveV1(first, stored)).not.toThrow();
    expect(stored.sanitizedPayload).toEqual({
      title: 'Offer [redacted]',
      cookie: '[redacted]',
    });
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  });
});
