import { describe, it, expect } from 'vitest';
import verifyUtils from './verify-utils.js';

const {
  chunk,
  isAllowedThumbUrl,
  normalizeVerdict,
  parseVerdictResults,
  cardToVerifyItem,
  normalizeRefImages,
  VERIFY_SCHEMA,
} = verifyUtils;

const ALLOW = ['tiktokcdn', 'tikwm', 'ytimg'];

describe('chunk', () => {
  it('splits into consecutive batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('handles empty arrays and bad sizes', () => {
    expect(chunk([], 8)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunk([1, 2], -3)).toEqual([[1], [2]]);
  });
});

describe('isAllowedThumbUrl', () => {
  it('accepts allowlisted https hosts', () => {
    expect(isAllowedThumbUrl('https://p16-sign.tiktokcdn-us.com/x.jpg', ALLOW)).toBe(true);
    expect(isAllowedThumbUrl('https://www.tikwm.com/video/cover/a.webp', ALLOW)).toBe(true);
  });
  it('rejects other hosts, bad urls and non-http schemes', () => {
    expect(isAllowedThumbUrl('https://evil.example.com/x.jpg', ALLOW)).toBe(false);
    expect(isAllowedThumbUrl('file:///etc/passwd', ALLOW)).toBe(false);
    expect(isAllowedThumbUrl('not-a-url', ALLOW)).toBe(false);
    expect(isAllowedThumbUrl('', ALLOW)).toBe(false);
    expect(isAllowedThumbUrl(null, ALLOW)).toBe(false);
  });
  it('rejects allowlisted substring in the path only', () => {
    expect(isAllowedThumbUrl('https://evil.com/tiktokcdn/x.jpg', ALLOW)).toBe(false);
  });
});

describe('normalizeVerdict', () => {
  it('maps canonical and synonym values', () => {
    expect(normalizeVerdict('match')).toBe('match');
    expect(normalizeVerdict('MATCH')).toBe('match');
    expect(normalizeVerdict('yes')).toBe('match');
    expect(normalizeVerdict('no_match')).toBe('no_match');
    expect(normalizeVerdict('different')).toBe('no_match');
  });
  it('defaults anything unknown to unsure', () => {
    expect(normalizeVerdict('maybe')).toBe('unsure');
    expect(normalizeVerdict('')).toBe('unsure');
    expect(normalizeVerdict(undefined)).toBe('unsure');
    expect(normalizeVerdict(42)).toBe('unsure');
  });
});

describe('parseVerdictResults', () => {
  it('maps model output onto expected ids', () => {
    const text = JSON.stringify({
      results: [
        { id: 'a', verdict: 'match', reason: 'نفس الزجاجة' },
        { id: 'b', verdict: 'no_match' },
      ],
    });
    const map = parseVerdictResults(text, ['a', 'b']);
    expect(map.get('a')).toEqual({ verdict: 'match', reason: 'نفس الزجاجة' });
    expect(map.get('b').verdict).toBe('no_match');
  });
  it('missing ids come back unsure', () => {
    const text = JSON.stringify({ results: [{ id: 'a', verdict: 'match' }] });
    const map = parseVerdictResults(text, ['a', 'b']);
    expect(map.get('b').verdict).toBe('unsure');
  });
  it('malformed JSON never throws — everything unsure', () => {
    const map = parseVerdictResults('{{{not json', ['x', 'y']);
    expect(map.get('x').verdict).toBe('unsure');
    expect(map.get('y').verdict).toBe('unsure');
  });
  it('ignores ids the model invented and coerces numeric ids', () => {
    const text = JSON.stringify({ results: [{ id: 123, verdict: 'match' }, { id: 'ghost', verdict: 'match' }] });
    const map = parseVerdictResults(text, ['123']);
    expect(map.size).toBe(1);
    expect(map.get('123').verdict).toBe('match');
  });
  it('truncates very long reasons', () => {
    const text = JSON.stringify({ results: [{ id: 'a', verdict: 'match', reason: 'x'.repeat(1000) }] });
    expect(parseVerdictResults(text, ['a']).get('a').reason.length).toBe(300);
  });
});

describe('cardToVerifyItem', () => {
  it('keeps only the fields verification needs, sanitized', () => {
    const item = cardToVerifyItem({
      id: 42, platform: 'tiktok', url: 'https://t.example/v/42',
      title: 'عنوان', thumbnail: 'https://cdn/x.jpg', duration: 31,
      play: 'https://direct-link', views: 999,
    });
    expect(item).toEqual({
      id: '42', platform: 'tiktok', url: 'https://t.example/v/42',
      title: 'عنوان', thumbnail: 'https://cdn/x.jpg', duration: 31,
    });
  });
  it('rejects cards without an id', () => {
    expect(cardToVerifyItem({ title: 'no id' })).toBe(null);
    expect(cardToVerifyItem(null)).toBe(null);
  });
  it('caps abusive field lengths and durations', () => {
    const item = cardToVerifyItem({ id: 'a', title: 'x'.repeat(500), duration: 999999 });
    expect(item.title.length).toBe(120);
    expect(item.duration).toBe(3600);
  });
  it('strips path-traversal characters from ids (used in temp paths)', () => {
    expect(cardToVerifyItem({ id: '../../etc' }).id).toBe('etc');
    expect(cardToVerifyItem({ id: 'a/b\\c..d' }).id).toBe('abcd');
    expect(cardToVerifyItem({ id: '../..' })).toBe(null);
  });
});

describe('normalizeRefImages', () => {
  it('accepts the images array shape', () => {
    const out = normalizeRefImages({ images: [{ base64: 'aaa', mediaType: 'image/png' }] });
    expect(out).toEqual([{ base64: 'aaa', mediaType: 'image/png' }]);
  });
  it('accepts the legacy single-image shape', () => {
    const out = normalizeRefImages({ imageBase64: 'bbb', mediaType: 'image/jpeg' });
    expect(out).toEqual([{ base64: 'bbb', mediaType: 'image/jpeg' }]);
  });
  it('caps to 4 images and drops empties', () => {
    const images = [1, 2, 3, 4, 5, 6].map((i) => ({ base64: 'img' + i, mediaType: 'image/jpeg' }));
    images.push({ base64: '', mediaType: 'image/jpeg' });
    expect(normalizeRefImages({ images }).length).toBe(4);
    expect(normalizeRefImages({})).toEqual([]);
    expect(normalizeRefImages(null)).toEqual([]);
  });
  it('falls back to jpeg for unknown media types', () => {
    const out = normalizeRefImages({ images: [{ base64: 'x', mediaType: 'application/evil' }] });
    expect(out[0].mediaType).toBe('image/jpeg');
  });
});

describe('VERIFY_SCHEMA', () => {
  it('constrains verdicts to the three canonical values', () => {
    expect(VERIFY_SCHEMA.properties.results.items.properties.verdict.enum)
      .toEqual(['match', 'unsure', 'no_match']);
  });
});
