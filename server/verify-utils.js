'use strict';
/**
 * Pure logic for the visual product-match verification (/api/ai/verify).
 * No network / fs here — everything is unit-testable.
 */

const VERDICTS = ['match', 'unsure', 'no_match'];

// JSON schema forced on the model's output (same pattern as KEYWORDS_SCHEMA).
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The video id exactly as given' },
          verdict: {
            type: 'string',
            enum: VERDICTS,
            description: 'match = the exact same product; no_match = clearly a different product; unsure = cannot tell from this image',
          },
          reason: { type: 'string', description: 'One short sentence in Arabic explaining the verdict' },
        },
        required: ['id', 'verdict'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// split an array into consecutive batches of `size`
function chunk(arr, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// http(s) URL whose hostname matches the media-proxy allowlist
function isAllowedThumbUrl(u, allowHosts) {
  if (!u || typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return (allowHosts || []).some((h) => host.includes(h));
}

// tolerate model wording drift: map any phrasing onto the 3 canonical verdicts
function normalizeVerdict(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['match', 'yes', 'same', 'exact', 'مطابق'].includes(s)) return 'match';
  if (['no_match', 'no-match', 'no', 'different', 'غير مطابق'].includes(s)) return 'no_match';
  return 'unsure';
}

/**
 * Parse the model's JSON text into { id → { verdict, reason } }.
 * Ids the model skipped (or malformed output) come back as 'unsure' —
 * verification must never crash the request, worst case is "not sure".
 */
function parseVerdictResults(text, expectedIds) {
  const out = new Map();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* malformed → all unsure */ }
  const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
  const byId = new Map();
  for (const r of results) {
    if (r && r.id != null) byId.set(String(r.id), r);
  }
  for (const id of expectedIds || []) {
    const r = byId.get(String(id));
    out.set(String(id), {
      verdict: normalizeVerdict(r && r.verdict),
      reason: (r && typeof r.reason === 'string') ? r.reason.slice(0, 300) : '',
    });
  }
  return out;
}

// keep only what verification needs from a result card, sanitized.
// id is later used inside a temp-dir path that gets rm -rf'ed, so it MUST
// stay strictly alphanumeric — no path separators or dots ever.
function cardToVerifyItem(card) {
  if (!card || typeof card !== 'object') return null;
  const id = card.id != null ? String(card.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
  if (!id) return null;
  return {
    id,
    platform: String(card.platform || 'tiktok').slice(0, 20),
    url: typeof card.url === 'string' ? card.url.slice(0, 500) : '',
    title: typeof card.title === 'string' ? card.title.slice(0, 120) : '',
    thumbnail: typeof card.thumbnail === 'string' ? card.thumbnail.slice(0, 1000) : '',
    duration: Number(card.duration) > 0 ? Math.min(Number(card.duration), 3600) : 0,
  };
}

module.exports = {
  VERDICTS,
  VERIFY_SCHEMA,
  chunk,
  isAllowedThumbUrl,
  normalizeVerdict,
  parseVerdictResults,
  cardToVerifyItem,
};
