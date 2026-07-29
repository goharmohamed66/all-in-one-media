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

// strict allowlist match: the host must BE the domain or a subdomain of it.
// Substring matching is forbidden here — `tiktok.evil.com` must never pass.
function isAllowedHost(host, domains) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return (domains || []).some((d) => h === d || h.endsWith('.' + d));
}

// http(s) URL whose hostname matches the media allowlist (strict suffix match)
function isAllowedThumbUrl(u, domains) {
  if (!u || typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isAllowedHost(parsed.hostname, domains);
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
  const rawId = card.id != null ? String(card.id).slice(0, 200) : '';
  const id = rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!id) return null;
  return {
    id,          // path-safe — used for temp dirs only
    rawId,       // exactly what the client sent — echoed back in verify:item
    platform: String(card.platform || 'tiktok').slice(0, 20),
    url: typeof card.url === 'string' ? card.url.slice(0, 500) : '',
    title: typeof card.title === 'string' ? card.title.slice(0, 120) : '',
    thumbnail: typeof card.thumbnail === 'string' ? card.thumbnail.slice(0, 1000) : '',
    duration: Number(card.duration) > 0 ? Math.min(Number(card.duration), 3600) : 0,
  };
}

const REF_IMAGE_MAX = 4;
const REF_IMAGE_B64_MAX = 11 * 1024 * 1024; // ~8MB binary once decoded
const REF_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Normalize the request's reference image(s) into a validated array.
 * Accepts the new `images: [{base64, mediaType}]` shape and the legacy
 * single `imageBase64`/`mediaType` pair. Caps count, size and media type.
 */
function normalizeRefImages(body) {
  const raw = [];
  if (body && Array.isArray(body.images)) raw.push(...body.images);
  if (body && body.imageBase64) raw.push({ base64: body.imageBase64, mediaType: body.mediaType });
  const out = [];
  for (const img of raw) {
    if (out.length >= REF_IMAGE_MAX) break;
    const base64 = img && typeof img.base64 === 'string' ? img.base64 : '';
    if (!base64 || base64.length > REF_IMAGE_B64_MAX) continue;
    const mediaType = REF_MEDIA_TYPES.includes(img.mediaType) ? img.mediaType : 'image/jpeg';
    out.push({ base64, mediaType });
  }
  return out;
}

module.exports = {
  VERDICTS,
  VERIFY_SCHEMA,
  REF_IMAGE_MAX,
  chunk,
  isAllowedHost,
  isAllowedThumbUrl,
  normalizeVerdict,
  parseVerdictResults,
  cardToVerifyItem,
  normalizeRefImages,
};
