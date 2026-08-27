import { describe, it, expect } from 'vitest';
import { classifyTikwmResponse, TIKWM_BUSY_MSG } from './tikwm-utils.js';

const HTML_PAGE =
  '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html">' +
  '<title>Service busy</title></head><body>Too many requests</body></html>';

describe('classifyTikwmResponse', () => {
  it('valid JSON with code 0 → ok, same json object back', () => {
    const body = JSON.stringify({ code: 0, data: { videos: [{ id: '1' }] } });
    const r = classifyTikwmResponse(200, body);
    expect(r.kind).toBe('ok');
    expect(r.json.data.videos).toHaveLength(1);
  });

  it('HTML page with status 200 → retryable, message contains no HTML', () => {
    const r = classifyTikwmResponse(200, HTML_PAGE);
    expect(r.kind).toBe('retryable');
    expect(r.message).not.toContain('<');
    expect(r.message).toContain(TIKWM_BUSY_MSG);
  });

  it.each([403, 429, 503])('HTML page with status %i → retryable, status quoted', (status) => {
    const r = classifyTikwmResponse(status, HTML_PAGE);
    expect(r.kind).toBe('retryable');
    expect(r.message).toContain(`(HTTP ${status})`);
    expect(r.message).not.toContain('<');
  });

  it('empty body (redirect cap in httpRequest) → retryable with a real message', () => {
    const r = classifyTikwmResponse(200, '');
    expect(r.kind).toBe('retryable');
    expect(r.message).toContain(TIKWM_BUSY_MSG);
    expect(r.message).not.toContain('unknown');
  });

  it('non-object JSON (bare number) → retryable, not a crash', () => {
    const r = classifyTikwmResponse(200, '123');
    expect(r.kind).toBe('retryable');
  });

  it('JSON rate-limit error → retryable, TikWM msg passed through', () => {
    const body = JSON.stringify({ code: -1, msg: 'Free Api Limit: 1 request/second.' });
    const r = classifyTikwmResponse(200, body);
    expect(r.kind).toBe('retryable');
    expect(r.message).toBe('Free Api Limit: 1 request/second.');
  });

  it('JSON real error → fatal with the msg itself', () => {
    const body = JSON.stringify({ code: -1, msg: 'Url parsing is failed! Please check url.' });
    const r = classifyTikwmResponse(200, body);
    expect(r.kind).toBe('fatal');
    expect(r.message).toBe('Url parsing is failed! Please check url.');
  });

  it('JSON error with no msg at all → fatal "unknown error"', () => {
    const r = classifyTikwmResponse(200, JSON.stringify({ code: -1 }));
    expect(r.kind).toBe('fatal');
    expect(r.message).toBe('unknown error');
  });
});
