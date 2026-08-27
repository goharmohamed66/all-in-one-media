'use strict';
/**
 * Pure logic for classifying TikWM API responses.
 * No network here — everything is unit-testable.
 *
 * TikWM sometimes answers with an HTML block/overload page instead of JSON.
 * That case must be retried (it is transient) and must NEVER leak the raw
 * body into the error message shown to the user.
 */

// Arabic because every user-facing toast in this app is Arabic.
const TIKWM_BUSY_MSG =
  'خدمة TikWM مشغولة أو حاظرة الطلبات مؤقتًا — جرّب تاني بعد دقيقة.';

/**
 * classifyTikwmResponse(status, text) →
 *   { kind: 'ok', json }            valid JSON with code === 0
 *   { kind: 'retryable', message }  transient: non-JSON body (HTML/empty),
 *                                   or a JSON error mentioning a rate limit
 *   { kind: 'fatal', message }      a real JSON error from TikWM
 * `message` never contains any part of the raw body except TikWM's own
 * JSON `msg` field.
 */
function classifyTikwmResponse(status, text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json === null || typeof json !== 'object') {
    const suffix = status ? ` (HTTP ${status})` : '';
    return { kind: 'retryable', message: TIKWM_BUSY_MSG + suffix };
  }

  if (json.code === 0) return { kind: 'ok', json };

  const msg = json.msg || json.message || 'unknown error';
  if (/limit/i.test(msg)) return { kind: 'retryable', message: msg };
  return { kind: 'fatal', message: msg };
}

module.exports = { classifyTikwmResponse, TIKWM_BUSY_MSG };
