import { describe, expect, it } from 'vitest';
import { classifyPageState, recoverHintForPageState } from '../src/session/page-state.js';

describe('classifyPageState', () => {
  it('detects login redirects', () => {
    const state = classifyPageState({
      url: 'https://login.1688.com/member/signin.htm',
      title: '登录',
    });
    expect(state.kind).toBe('not_logged_in');
    expect(state.indicators).toContain('login-url');
  });

  it('detects risk challenges from page text', () => {
    const state = classifyPageState({
      url: 'https://detail.1688.com/offer/123.html',
      title: '安全验证',
      text: '请拖动滑块完成验证',
    });
    expect(state.kind).toBe('risk_challenge');
    expect(recoverHintForPageState(state.kind)).toMatch(/--headed/);
  });

  it('detects canvas-based challenge pages from their URL', () => {
    expect(
      classifyPageState({
        url: 'https://punish.1688.com/punish?x5secdata=secret',
        title: '1688',
        text: '',
      }),
    ).toMatchObject({
      kind: 'risk_challenge',
      indicators: ['risk-url'],
    });
  });

  it('detects the English Captcha Interception page seen in offer artifacts', () => {
    const state = classifyPageState({
      url: 'https://detail.1688.com/offer/123.html',
      title: 'Captcha Interception',
      text: '',
    });

    expect(state.kind).toBe('risk_challenge');
    expect(state.indicators).toContain('risk-text');
  });

  it('detects rate limiting before normal 1688 pages', () => {
    const state = classifyPageState({
      url: 'https://s.1688.com/selloffer/offer_search.htm',
      title: '系统繁忙',
      text: '访问频繁，请稍后再试',
    });
    expect(state.kind).toBe('rate_limited');
  });

  it('treats normal 1688 URLs as usable', () => {
    const state = classifyPageState({
      url: 'https://cart.1688.com/',
      title: '采购车',
      text: '商品列表',
    });
    expect(state.kind).toBe('normal_1688_page');
  });
});
