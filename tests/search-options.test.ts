import { describe, expect, it } from 'vitest';
import {
  SEARCH_WARMUP_URL,
  buildSearchUrl,
  classifyUncapturedSearchPage,
  shouldUseMainSiteSearchSubmit,
} from '../src/commands/search.js';

describe('search options', () => {
  it('uses the main-site warmup URL before entering search', () => {
    expect(SEARCH_WARMUP_URL).toBe('https://www.1688.com/');
  });

  it('encodes keywords as GBK and appends remote sort hints', () => {
    const url = buildSearchUrl('雨伞', 'best-selling');

    expect(url).toContain('keywords=%D3%EA%C9%A1');
    expect(url).toContain('sortType=va_rmdarkgmv30');
  });

  it('does not add a sortType for relevance', () => {
    expect(buildSearchUrl('hat', 'relevance')).toBe(
      'https://s.1688.com/selloffer/offer_search.htm?keywords=%68%61%74',
    );
  });

  it('uses main-site submit only when remote sort flags are not needed', () => {
    expect(shouldUseMainSiteSearchSubmit('relevance')).toBe(true);
    expect(shouldUseMainSiteSearchSubmit('best-selling')).toBe(false);
    expect(shouldUseMainSiteSearchSubmit('price-asc')).toBe(false);
    expect(shouldUseMainSiteSearchSubmit('price-desc')).toBe(false);
  });

  it('treats a deep-page login redirect as authentication failure, not partial success', () => {
    expect(
      classifyUncapturedSearchPage(
        4,
        'https://login.taobao.com/?redirect_url=https%3A%2F%2Fs.1688.com',
        false,
      ),
    ).toBe('not_logged_in');
  });
});
