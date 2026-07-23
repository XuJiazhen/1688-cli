import { describe, expect, it } from 'vitest';
import {
  redactDiagnosticMetadata,
  redactUrlForDiagnostics,
  sanitizeEvidenceRef,
  scanFixtureSecrets,
} from '../src/session/redaction.js';

describe('redactUrlForDiagnostics', () => {
  it('removes unsafe query keys from persisted evidence refs', () => {
    expect(
      sanitizeEvidenceRef(
        'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&v=1.0&sign=secret&data=private',
      ),
    ).toBe(
      'https://h5api.m.1688.com/h5/catalog/1.0/?api=catalog&v=1.0',
    );
  });
  it('keeps diagnostic routing fields while redacting MTOP payload and credentials', () => {
    const result = redactUrlForDiagnostics(
      'https://h5api.m.1688.com/h5/mtop.example.catalog/1.0/' +
        '?api=mtop.example.catalog&v=1.0&type=json&dataType=json' +
        '&sign=secret-sign&_m_h5_tk=secret-token&data=%7B%22memberId%22%3A%22b2b-secret%22%7D',
    );
    const url = new URL(result);

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://h5api.m.1688.com/h5/mtop.example.catalog/1.0/',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api: 'mtop.example.catalog',
      v: '1.0',
      type: 'json',
      dataType: 'json',
      sign: '[redacted]',
      _m_h5_tk: '[redacted]',
      data: '[redacted]',
    });
    expect(result).not.toContain('secret-sign');
    expect(result).not.toContain('secret-token');
    expect(result).not.toContain('b2b-secret');
  });

  it('fails closed for malformed and non-HTTP URLs', () => {
    expect(redactUrlForDiagnostics('not a url?token=secret')).toBe(
      '[redacted-url]',
    );
    expect(redactUrlForDiagnostics('data:text/plain,secret-data')).toBe(
      '[redacted-url]',
    );
  });
});

describe('redactDiagnosticMetadata', () => {
  it('redacts sensitive fields and URLs recursively without hiding safe metadata', () => {
    expect(
      redactDiagnosticMetadata({
        api: 'mtop.example.catalog',
        dataType: 'json',
        requestUrl:
          'https://h5api.m.1688.com/h5/mtop.example.catalog/1.0/?api=mtop.example.catalog&sign=secret',
        headers: { authorization: 'Bearer secret' },
        nested: [{ token: 'secret-token', pageNum: 2 }],
      }),
    ).toEqual({
      api: 'mtop.example.catalog',
      dataType: 'json',
      requestUrl:
        'https://h5api.m.1688.com/h5/mtop.example.catalog/1.0/?api=mtop.example.catalog&sign=%5Bredacted%5D',
      headers: '[redacted]',
      nested: [{ token: '[redacted]', pageNum: 2 }],
    });
  });

  it('redacts common credential and payload key variants', () => {
    expect(
      redactDiagnosticMetadata({
        _m_h5_tk_enc: 'encrypted-token',
        authToken: 'auth-token',
        signatureValue: 'signature',
        requestData: { memberId: 'b2b-secret' },
        safe: 'visible',
      }),
    ).toEqual({
      _m_h5_tk_enc: '[redacted]',
      authToken: '[redacted]',
      signatureValue: '[redacted]',
      requestData: '[redacted]',
      safe: 'visible',
    });
  });

  it('produces JSON-safe diagnostic metadata', () => {
    expect(
      redactDiagnosticMetadata({
        present: true,
        missing: undefined,
        entries: [undefined, { optional: undefined, safe: 'ok' }],
      }),
    ).toEqual({
      present: true,
      entries: [null, { safe: 'ok' }],
    });
  });
});

describe('scanFixtureSecrets', () => {
  it('rejects replayable credentials and personal contact fields', () => {
    const findings = scanFixtureSecrets(`
      curl 'https://h5api.m.1688.com/h5/api/1.0/?sign=secret&data=%7B%7D'
      -H 'Authorization: Bearer secret'
      -b '_m_h5_tk=secret; cookie1=secret'
      {"contactInfo":[{"type":"mobileNo","value":"13800138000"}]}
    `);

    expect(findings).toEqual(expect.arrayContaining([
      'authorization',
      'cookie-header',
      'mtop-token',
      'request-signature',
      'personal-contact',
    ]));
  });

  it('allows sanitized fixture facts and non-secret product identifiers', () => {
    expect(scanFixtureSecrets(JSON.stringify({
      offerId: '12345678901',
      memberId: 'b2b-sanitized',
      specialSign: 'factory',
      data: { title: '帐篷' },
    }))).toEqual([]);
  });
});
