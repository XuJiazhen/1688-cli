import { describe, expect, it } from 'vitest';
import {
  buildSupplierConversationUrl,
  classifyConversationMessage,
  decodeSupplierInquiryCursor,
  encodeSupplierInquiryCursor,
  messagesAfterSupplierInquiryCursor,
  parseSupplierInquiryWsFrames,
} from '../src/session/supplier-inquiry-actions.js';
import { offerIdFromImCardEvidence } from '../src/session/im-locators.js';
import { parseProductionCollectionRpcRequestV1 } from '../src/daemon/production-collection-protocol.js';

describe('supplier inquiry shared browser actions', () => {
  it('builds a true store-direct conversation URL without order or offer scope', () => {
    const url = new URL(buildSupplierConversationUrl({ memberId: 'seller-login' }));
    expect(url.hostname).toBe('air.1688.com');
    expect(url.searchParams.get('touid')).toBe('cnalichnseller-login');
    expect(url.searchParams.get('siteid')).toBe('cnalichn');
    expect(url.searchParams.get('offerId')).toBe('');
    expect(url.searchParams.get('orderId')).toBe('');
  });

  it('preserves cid/messageId and applies an opaque bounded cursor', () => {
    const frames = [
      {
        direction: 'sent' as const,
        method: '/r/MessageManager/listUserMessages',
        mid: 'request-1',
        payload: JSON.stringify({ body: ['cid-1'] }),
      },
      {
        direction: 'received' as const,
        method: '',
        mid: 'request-1',
        payload: JSON.stringify({
          body: {
            userMessageModels: [
              model('100', 1_700_000_000_000, 'first'),
              model('101', 1_700_000_001_000, 'second'),
              model('102', 1_700_000_002_000, 'third'),
            ],
          },
        }),
      },
    ];
    const parsed = parseSupplierInquiryWsFrames(frames);
    expect(parsed.map((message) => [message.cid, message.messageId, message.text])).toEqual([
      ['cid-1', '100', 'first'],
      ['cid-1', '101', 'second'],
      ['cid-1', '102', 'third'],
    ]);

    const cursor = encodeSupplierInquiryCursor({ cid: 'cid-1', messageId: '100' });
    expect(decodeSupplierInquiryCursor(cursor)).toEqual({
      schema: 'supplier-inquiry-message-cursor.v1',
      cid: 'cid-1',
      messageId: '100',
    });
    const bounded = messagesAfterSupplierInquiryCursor(parsed, cursor, 1);
    expect(bounded.messages.map((message) => message.messageId)).toEqual(['101']);
    expect(decodeSupplierInquiryCursor(bounded.nextCursor!)).toMatchObject({
      cid: 'cid-1',
      messageId: '101',
    });
  });

  it('classifies offer links as product cards while retaining the platform identity', () => {
    const parsed = parseSupplierInquiryWsFrames([
      {
        direction: 'sent',
        method: '/r/MessageManager/listUserMessages',
        mid: 'request-1',
        payload: JSON.stringify({ body: ['cid-offer'] }),
      },
      {
        direction: 'received',
        method: '',
        mid: 'request-1',
        payload: JSON.stringify({
          body: {
            userMessageModels: [model(
              '200',
              1_700_000_003_000,
              'https://detail.1688.com/offer/123456.html',
              'cid-offer',
            )],
          },
        }),
      },
    ]);
    expect(parsed[0]).toMatchObject({
      cid: 'cid-offer',
      messageId: '200',
      type: 'product_card',
      offerId: '123456',
    });
  });

  it('extracts only explicit offer identities from observed card evidence', () => {
    expect(offerIdFromImCardEvidence(
      'href=https://detail.1688.com/offer/123456.html?spm=card',
    )).toBe('123456');
    expect(offerIdFromImCardEvidence('data-offer-id=654321')).toBe('654321');
    expect(offerIdFromImCardEvidence('https://img.1688.com/20260820/123456.jpg')).toBeNull();
  });

  it('attributes sender-less messages only from an explicit receiver identity', () => {
    expect(classifyConversationMessage({
      senderNick: null,
      receiverNick: 'cnalichncurrent-buyer',
    }, 'seller-login')).toBe('seller');
    expect(classifyConversationMessage({
      senderNick: null,
      receiverNick: 'cnalichnseller-login',
    }, 'seller-login')).toBe('self');
    expect(classifyConversationMessage({
      senderNick: null,
      receiverNick: null,
    }, 'seller-login')).toBe('unknown');
  });

  it('retains sender-less wire messages for fail-closed receiver-based attribution', () => {
    const senderless = model('300', 1_700_000_004_000, '可以的');
    delete (senderless.message.extension as Record<string, unknown>)['sender_nick'];
    (senderless.message.extension as Record<string, unknown>)['receiver_nick'] =
      'cnalichncurrent-buyer';
    const parsed = parseSupplierInquiryWsFrames([
      {
        direction: 'sent',
        method: '/r/MessageManager/listUserMessages',
        mid: 'request-senderless',
        payload: JSON.stringify({ body: ['cid-1'] }),
      },
      {
        direction: 'received',
        method: '',
        mid: 'request-senderless',
        payload: JSON.stringify({ body: { userMessageModels: [senderless] } }),
      },
    ]);
    expect(parsed[0]).toMatchObject({ senderNick: null, receiverNick: 'cnalichncurrent-buyer' });
    expect(classifyConversationMessage(parsed[0]!, 'seller-login')).toBe('seller');
  });

  it('accepts the fifth fenced work kind and rejects controlled work in the real daemon', () => {
    const request = productionRequest('real_1688');
    expect(parseProductionCollectionRpcRequestV1(request)).toMatchObject({
      workKind: 'supplier_inquiry',
      workInput: { action: 'read_messages', executionMode: 'real_1688' },
    });
    expect(() => parseProductionCollectionRpcRequestV1(
      productionRequest('controlled_mock'),
    )).toThrow(/only real_1688/u);
  });
});

function model(messageId: string, createAt: number, text: string, cid = 'cid-1') {
  return {
    readStatus: 2,
    message: {
      messageId,
      createAt,
      cid,
      content: { contentType: 1, text: { content: text } },
      extension: {
        sender_nick: 'cnalichnseller-login',
        senderNickName: 'Seller',
      },
    },
  };
}

function productionRequest(executionMode: 'real_1688' | 'controlled_mock') {
  return {
    schema: 'production-collection.rpc.v1',
    rpcId: 'rpc-1',
    method: 'production.collection.execute',
    deadlineAt: '2026-08-20T01:05:00.000Z',
    attemptId: '00000000-0000-4000-8000-000000000001',
    executionToken: '00000000-0000-4000-8000-000000000002',
    workItemId: '00000000-0000-4000-8000-000000000003',
    profileId: '00000000-0000-4000-8000-000000000004',
    supervisorLeaseId: '00000000-0000-4000-8000-000000000005',
    supervisorGeneration: 1,
    supervisorFencingToken: '1',
    daemonInstanceId: '00000000-0000-4000-8000-000000000006',
    contextGeneration: 1,
    runtimeHostId: 'runtime-1',
    attemptOrdinal: 1,
    freshnessSeconds: 60,
    startNotBefore: '2026-08-20T01:00:00.000Z',
    subjectKey: 'supplier-inquiry:test',
    workKind: 'supplier_inquiry',
    workInput: {
      kind: 'supplier_inquiry',
      executionMode,
      inquiryTaskId: '00000000-0000-4000-8000-000000000007',
      outboundIntentId: '00000000-0000-4000-8000-000000000008',
      action: 'read_messages',
      conversationScope: 'offer',
      idempotencyKey: 'inquiry:read:1',
      canonicalStoreId: '00000000-0000-4000-8000-000000000009',
      normalizedStoreUrl: 'https://example.1688.com/',
      memberId: 'seller-login',
      realSendAuthorizationId: 'authorization-1',
      offerId: '123456',
      cursor: null,
      limit: 50,
      timeoutMs: 15_000,
    },
    query: null,
  };
}
