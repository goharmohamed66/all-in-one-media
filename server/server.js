'use strict';
/**
 * MediaGrab — Node server (Express + Socket.IO)
 * Orchestrates yt-dlp (YouTube / TikTok profiles / IG / FB) and TikWM (TikTok single + search),
 * plus a media proxy that spoofs Referer so CDN images/videos render in the UI.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// ───────────────────────────── config ─────────────────────────────
const PORT = process.env.PORT || 3456;
const APP_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DOWNLOAD_DIR =
  process.env.MEDIAGRAB_DOWNLOADS ||
  path.join(os.homedir(), 'Downloads', 'MediaGrab');

const YTDLP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIKWM_API = 'https://www.tikwm.com/api/';
const TIKWM_MIN_INTERVAL = 1100; // ms between TikWM calls
const TIKWM_MAX_RETRIES = 4;

// ───────────────────────────── binary paths ─────────────────────────────
function resolveYtDlp() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    path.join(APP_ROOT, 'bin', exe),
    path.join(process.resourcesPath || APP_ROOT, 'bin', exe),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return exe; // fall back to PATH
}

function resolveFfmpeg() {
  try {
    let p = require('ffmpeg-static');
    if (p) {
      // when packaged in asar, ffmpeg-static lives in app.asar.unpacked
      p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

const YTDLP_PATH = resolveYtDlp();
const FFMPEG_PATH = resolveFfmpeg();

// ───────────────────────────── persistent config ─────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.mediagrab');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_CONFIG = {
  downloadDir: DOWNLOAD_DIR,
  cookiesBrowser: 'none', // none | chrome | edge | firefox | brave | opera
  videoQuality: 'best',   // best | 1080 | 720 | 480
  anthropicApiKey: '',    // Claude API key (stored locally only)
  anthropicModel: 'claude-opus-4-8', // selected Claude model (default: highest)
  // stable "latest release" links — always serve the newest published build
  downloadWinUrl: 'https://github.com/goharmohamed66/all-in-one-media/releases/latest/download/All-In-One-Media-Setup.exe',
  downloadMacUrl: 'https://github.com/goharmohamed66/all-in-one-media/releases/latest/download/All-In-One-Media-macOS.dmg',
};

let APP_VERSION = '1.0.0';
try { APP_VERSION = require('../package.json').version || APP_VERSION; } catch {}
let CONFIG = { ...DEFAULT_CONFIG };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  }
} catch { /* keep defaults */ }
function saveConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
  } catch (e) { console.error('config save failed:', e.message); }
}
function getDownloadDir() { return CONFIG.downloadDir || DOWNLOAD_DIR; }

fs.mkdirSync(getDownloadDir(), { recursive: true });

// ───────────────────────────── app setup ─────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '25mb' })); // large enough for base64 image uploads
app.use(express.static(PUBLIC_DIR));

function emit(socketId, event, payload) {
  if (socketId) io.to(socketId).emit(event, payload);
  else io.emit(event, payload);
}
function emitProgress(socketId, data) {
  emit(socketId, 'progress', data);
}

// ───────────────────────────── platform detection ─────────────────────────────
function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/.test(u)) return 'tiktok';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/instagram\.com|instagr\.am/.test(u)) return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return 'facebook';
  return null;
}

function isTikTokUser(url) {
  // tiktok.com/@user  (profile, not a single video / photo)
  return /tiktok\.com\/@[^/]+\/?$/.test(url) || /tiktok\.com\/@[^/]+\?/.test(url);
}
function isYouTubeChannelOrPlaylist(url) {
  return /youtube\.com\/(@[^/]+|c\/|channel\/|user\/|playlist\?)/.test(url) ||
         /[?&]list=/.test(url);
}
function isInstagramProfile(url) {
  // instagram.com/<user>  but not /p/ /reel/ /reels/ /tv/ /stories/ /explore
  return /instagram\.com\/(?!p\/|reel\/|reels\/|tv\/|stories\/|explore\/|accounts\/)[^/?#]+\/?(\?|#|$)/.test(url);
}
function isFacebookProfile(url) {
  // facebook.com/<page>/videos  or /<page>  (not a single watch/video link)
  if (/facebook\.com\/watch\/?\?v=|\/videos\/\d+|fb\.watch|story_fbid|\/reel\/\d+/.test(url)) return false;
  return /facebook\.com\/[^/?#]+\/videos\/?($|\?|#)/.test(url) ||
         /facebook\.com\/[^/?#]+\/?$/.test(url);
}

/** YouTube quality → yt-dlp format selector */
function ytFormatSelector() {
  const q = CONFIG.videoQuality;
  const h = (q && q !== 'best' && /^\d+$/.test(q)) ? `[height<=${q}]` : '';
  // Prefer H.264 + AAC (plays everywhere, incl. QuickTime). Avoid AV1.
  // Anything that isn't H.264 is re-encoded to H.264 by --recode-video mp4.
  return `bv*${h}[vcodec^=avc1]+ba[acodec^=mp4a]/bv*${h}[vcodec^=avc1]+ba/bv*${h}[vcodec!*=av01]+ba/b${h}[vcodec!*=av01]/b${h}`;
}

// ───────────────────────────── small http helper ─────────────────────────────
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 30000, _redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      { method, headers, timeout },
      (res) => {
        // follow redirects (capped to avoid loops)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (_redirects >= 6) {
            return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
          }
          const next = new URL(res.headers.location, u).toString();
          return resolve(httpRequest(next, { method, headers, body, timeout, _redirects: _redirects + 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ───────────────────────────── TikWM (serialized + backoff) ─────────────────────────────
let _tikwmLast = 0;
let _tikwmChain = Promise.resolve();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tikwmSerializedRequest(endpoint, form) {
  // chain so calls never overlap, with a min interval between them
  _tikwmChain = _tikwmChain.then(async () => {
    const wait = TIKWM_MIN_INTERVAL - (Date.now() - _tikwmLast);
    if (wait > 0) await sleep(wait);

    const bodyStr = new URLSearchParams(form).toString();
    let attempt = 0;
    while (true) {
      attempt++;
      _tikwmLast = Date.now();
      try {
        const res = await httpRequest(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': YTDLP_UA,
            'Accept': 'application/json',
            'Referer': 'https://www.tikwm.com/',
          },
          body: bodyStr,
        });
        const text = res.body.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = null; }

        if (json && json.code === 0) return json;

        const msg = (json && (json.msg || json.message)) || text.slice(0, 120);
        if (/limit/i.test(msg) && attempt <= TIKWM_MAX_RETRIES) {
          await sleep(1500 * attempt); // escalating backoff
          continue;
        }
        throw new Error(`TikWM: ${msg || 'unknown error'}`);
      } catch (e) {
        if (attempt <= TIKWM_MAX_RETRIES && /limit|timeout|ECONN|socket/i.test(e.message)) {
          await sleep(1500 * attempt);
          continue;
        }
        throw e;
      }
    }
  });
  return _tikwmChain;
}

function tikwmAbs(u) {
  if (!u) return '';
  if (/^https?:/i.test(u)) return u;
  if (u.startsWith('/')) return 'https://www.tikwm.com' + u;
  return u;
}

function tikwmItemToCard(v, platform = 'tiktok') {
  const uid = (v.author && v.author.unique_id) || '';
  const vid = v.video_id || v.id || v.aweme_id || '';
  return {
    platform,
    id: String(vid),
    url: uid && vid ? `https://www.tiktok.com/@${uid}/video/${vid}` : (v.share_url || ''),
    title: v.title || '',
    thumbnail: tikwmAbs(v.cover || v.origin_cover || v.ai_dynamic_cover || ''),
    duration: v.duration || 0,
    views: v.play_count || 0,
    author: (v.author && (v.author.nickname || v.author.unique_id)) || '',
    // direct no-watermark links from tikwm (may be relative → absolutize)
    play: tikwmAbs(v.play || ''),
    hdplay: tikwmAbs(v.hdplay || ''),
    music: tikwmAbs(v.music || ''),
  };
}

async function tikwmGetVideo(videoUrl) {
  const json = await tikwmSerializedRequest(TIKWM_API, { url: videoUrl, hd: 1 });
  const d = json.data || {};
  return {
    play: tikwmAbs(d.play || ''),
    hdplay: tikwmAbs(d.hdplay || d.play || ''),
    music: tikwmAbs(d.music || ''),
    cover: tikwmAbs(d.cover || d.origin_cover || ''),
    title: d.title || '',
    duration: d.duration || 0,
    author: (d.author && (d.author.nickname || d.author.unique_id)) || '',
    id: String(d.id || d.video_id || ''),
  };
}

async function tikwmSearch(keywords, count = 30) {
  const json = await tikwmSerializedRequest('https://www.tikwm.com/api/feed/search', {
    keywords,
    count,
    cursor: 0,
    hd: 1,
  });
  const videos = (json.data && json.data.videos) || [];
  return videos.map((v) => tikwmItemToCard(v));
}

// ───────────────────────────── Instagram hashtag search (Reels only) ─────────────────────────────
// Reads the session cookies exported by the in-app login and calls Instagram's
// web hashtag API directly. Returns video reels only.
function igCookieHeader() {
  const file = cookieFileFor('instagram');
  if (!file) return null;
  try {
    const pairs = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const p = line.replace(/\r$/, '').split('\t');
      if (p.length >= 7 && p[5]) pairs.push(`${p[5].trim()}=${(p[6] || '').trim()}`);
    }
    return pairs.length ? pairs.join('; ') : null;
  } catch { return null; }
}

function igCollectMedia(lc, sink) {
  if (!lc || typeof lc !== 'object') return;
  if (Array.isArray(lc.medias)) lc.medias.forEach((m) => m && m.media && sink(m.media));
  if (Array.isArray(lc.fill_items)) lc.fill_items.forEach((m) => m && m.media && sink(m.media));
  const obt = lc.one_by_two_item;
  if (obt && obt.clips && Array.isArray(obt.clips.items)) {
    obt.clips.items.forEach((m) => m && m.media && sink(m.media));
  }
}

// Merge fresh Set-Cookie values returned by Instagram back into the cookie file,
// so the saved session keeps getting renewed and lasts much longer.
function igRefreshCookies(setCookie) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const file = cookieFileFor('instagram');
  if (!file) return;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return; }
  const map = new Map(); // name -> [domain, sub, path, secure, expiry, name, value]
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const p = line.replace(/\r$/, '').split('\t');
    if (p.length >= 7) map.set(p[5], p);
  }
  let changed = false;
  for (const sc of arr) {
    const m = sc.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (!m) continue;
    const name = m[1].trim();
    const value = m[2];
    if (value === '' || /^deleted$/i.test(value)) continue; // skip cookie deletions
    const exp = sc.match(/expires=([^;]+)/i);
    let expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    if (exp) { const t = Date.parse(exp[1]); if (!isNaN(t)) expiry = Math.floor(t / 1000); }
    const ex = map.get(name);
    map.set(name, [
      ex ? ex[0] : '.instagram.com',
      ex ? ex[1] : 'TRUE',
      ex ? ex[2] : '/',
      'TRUE',
      String(expiry),
      name,
      value,
    ]);
    changed = true;
  }
  if (!changed) return;
  const out = '# Netscape HTTP Cookie File\n# Generated by MediaGrab\n' +
    [...map.values()].map((p) => p.join('\t')).join('\n') + '\n';
  try { fs.writeFileSync(file, out); } catch {}
}

function igCsrfToken() {
  const file = cookieFileFor('instagram');
  if (!file) return '';
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const p = line.replace(/\r$/, '').split('\t');
      if (p.length >= 7 && p[5] === 'csrftoken') return (p[6] || '').trim();
    }
  } catch {}
  return '';
}

function igMediaToReelCard(m) {
  if (!m || !m.code) return null;
  const isVideo = m.media_type === 2 || !!(m.video_versions && m.video_versions.length);
  const cands = m.image_versions2 && m.image_versions2.candidates;
  return {
    platform: 'instagram',
    id: String(m.pk || m.id || m.code),
    // /reel/ for videos, /p/ for image / carousel posts
    url: `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${m.code}/`,
    title: (m.caption && m.caption.text) || '(منشور إنستجرام)',
    thumbnail: (cands && cands.length && cands[0].url) || '',
    duration: m.video_duration || 0,
    views: m.play_count || m.view_count || m.like_count || 0,
    author: (m.user && m.user.username) || '',
  };
}

function igReelCardsFromSections(sections) {
  const medias = [];
  (sections || []).forEach((s) => igCollectMedia(s.layout_content, (m) => medias.push(m)));
  return medias.map(igMediaToReelCard).filter(Boolean);
}

// Paginate one hashtag tab ('top' or 'recent'). Calls onNew for each unseen card.
async function igPaginateTab(tag, tab, headers, maxResults, seen, onNew) {
  const endpoint = `https://www.instagram.com/api/v1/tags/${encodeURIComponent(tag)}/sections/`;
  let page = 0, maxId = '', mediaIds = [], guard = 0, added = 0;
  while (seen.size < maxResults && guard < 12) {
    guard++;
    const form = new URLSearchParams({ tab, page: String(page), surface: 'grid', include_persistent: 'true' });
    if (maxId) form.set('max_id', maxId);
    if (mediaIds.length) form.set('next_media_ids', JSON.stringify(mediaIds));

    const res = await httpRequest(endpoint, { method: 'POST', headers, body: form.toString(), timeout: 30000 });
    igRefreshCookies(res.headers && res.headers['set-cookie']); // keep the session fresh
    let json = null;
    try { json = JSON.parse(res.body.toString('utf8')); } catch {}

    if (res.status === 401 || res.status === 403) { const e = new Error('IG_LOGIN_EXPIRED'); e.code = 'IG_LOGIN_EXPIRED'; throw e; }
    if (!json) {
      if (seen.size === 0) { const e = new Error('IG_LOGIN_EXPIRED'); e.code = 'IG_LOGIN_EXPIRED'; throw e; }
      break;
    }

    for (const card of igReelCardsFromSections(json.sections || [])) {
      if (card.id && !seen.has(card.id)) {
        seen.add(card.id); added++;
        if (onNew) onNew(card);
        if (seen.size >= maxResults) break;
      }
    }

    if (!json.more_available) break;
    maxId = json.next_max_id || '';
    page = (json.next_page != null) ? json.next_page : page + 1;
    mediaIds = json.next_media_ids || [];
    if (!maxId && !mediaIds.length) break;
  }
  return added;
}

// Hashtag search across BOTH the "top" and "recent" tabs (more results, all media
// types — no reels-only filter). onCard fires for each new de-duped item.
async function igHashtagSearch(tag, maxResults, onCard) {
  const cookie = igCookieHeader();
  if (!cookie) { const e = new Error('NO_IG_LOGIN'); e.code = 'NO_IG_LOGIN'; throw e; }
  const csrf = igCsrfToken();
  const headers = {
    'x-ig-app-id': '936619743392459',
    'User-Agent': YTDLP_UA,
    'Cookie': cookie,
    'Referer': `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
    'x-csrftoken': csrf,
    'x-requested-with': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': '*/*',
  };
  const seen = new Set();
  let firstErr = null;
  for (const tab of ['top', 'recent']) {
    if (seen.size >= maxResults) break;
    try {
      await igPaginateTab(tag, tab, headers, maxResults, seen, onCard);
    } catch (e) {
      if (e.code === 'NO_IG_LOGIN' || e.code === 'IG_LOGIN_EXPIRED') {
        if (seen.size === 0) throw e; // both empty + auth error → surface it
      } else { firstErr = e; }
    }
  }
  if (seen.size === 0 && firstErr) throw firstErr;
  return seen.size;
}

// Free-text keyword search (like the mobile app): /fbsearch/web/top_serp/ with
// Normalize Arabic (alef/hamza variants, tashkeel) so spelling differences match,
// the same way the mobile apps do — e.g. "القرءان" and "القرآن" both match.
function normalizeArabic(s) {
  return String(s || '')
    .replace(/[ً-ْٰـ]/g, '') // tashkeel + tatweel
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ؤ/g, 'و') // ؤ → و
    .replace(/ئ/g, 'ي') // ئ → ي
    .replace(/ء/g, '') // ء → (remove)
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/\s+/g, ' ')
    .trim();
}

// next_max_id + rank_token pagination. Handles phrases, not just hashtags.
async function igKeywordSearch(query, maxResults, seen, onCard) {
  const cookie = igCookieHeader();
  if (!cookie) { const e = new Error('NO_IG_LOGIN'); e.code = 'NO_IG_LOGIN'; throw e; }
  const csrf = igCsrfToken();
  const headers = {
    'x-ig-app-id': '936619743392459',
    'User-Agent': YTDLP_UA,
    'Cookie': cookie,
    'Referer': 'https://www.instagram.com/explore/search/',
    'x-csrftoken': csrf,
    'x-requested-with': 'XMLHttpRequest',
    'Accept': '*/*',
  };
  const q = encodeURIComponent(normalizeArabic(query));
  let nextMaxId = '', rankToken = '', guard = 0, startCount = seen.size;
  while (seen.size < maxResults && guard < 12) {
    guard++;
    let url = `https://www.instagram.com/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=${q}`;
    if (nextMaxId) url += `&next_max_id=${encodeURIComponent(nextMaxId)}&rank_token=${encodeURIComponent(rankToken)}`;

    const res = await httpRequest(url, { headers, timeout: 30000 });
    igRefreshCookies(res.headers && res.headers['set-cookie']);
    let json = null;
    try { json = JSON.parse(res.body.toString('utf8')); } catch {}

    if (res.status === 401 || res.status === 403) { const e = new Error('IG_LOGIN_EXPIRED'); e.code = 'IG_LOGIN_EXPIRED'; throw e; }
    const grid = json && json.media_grid;
    if (!grid) {
      if (seen.size === startCount && !json) { const e = new Error('IG_LOGIN_EXPIRED'); e.code = 'IG_LOGIN_EXPIRED'; throw e; }
      break;
    }

    for (const card of igReelCardsFromSections(grid.sections || [])) {
      if (card.id && !seen.has(card.id)) {
        if (onCard) onCard(card); // onCard adds to `seen` + emits
        if (seen.size >= maxResults) break;
      }
    }

    if (!grid.has_more) break;
    nextMaxId = grid.next_max_id || '';
    rankToken = json.rank_token || grid.rank_token || rankToken;
    if (!nextMaxId) break;
  }
  return seen.size - startCount;
}

async function igSearchStream(keywords, perKeyword, socketId) {
  const seen = new Set();
  let idx = 0;
  let err = null;
  for (const kw of keywords) {
    const raw = kw.trim();
    if (!raw) continue;
    const emitNew = (card) => {
      if (card.id && !seen.has(card.id)) { seen.add(card.id); emit(socketId, 'list:item', { card, index: idx++ }); }
    };
    try {
      if (raw.startsWith('#')) {
        // explicit hashtag → hashtag search
        const tag = raw.replace(/^#/, '').replace(/\s+/g, '').trim();
        emit(socketId, 'list:status', { message: `بحث: #${tag}` });
        await igHashtagSearch(tag, perKeyword, emitNew);
      } else {
        // free-text keyword/phrase → keyword search (like the mobile app)
        emit(socketId, 'list:status', { message: `بحث: ${raw}` });
        await igKeywordSearch(raw, perKeyword, seen, emitNew);
      }
    } catch (e) { err = e; }
  }
  if (seen.size === 0) {
    if (err && (err.code === 'NO_IG_LOGIN' || err.code === 'IG_LOGIN_EXPIRED')) {
      emit(socketId, 'list:error', { message: 'سجّل دخول إنستجرام من الإعدادات أولاً (أو الجلسة انتهت — أعد تسجيل الدخول).' });
    } else {
      emit(socketId, 'list:error', { message: (err && err.message) || 'لا توجد نتائج لهذه الكلمة.' });
    }
  } else {
    emit(socketId, 'list:done', { count: seen.size });
  }
}

// ───────────────────────────── yt-dlp helpers ─────────────────────────────
// Cookie file exported by the in-app login window (Netscape format).
function cookieFileFor(platform) {
  if (!platform) return null;
  const p = path.join(CONFIG_DIR, `cookies-${platform}.txt`);
  return fs.existsSync(p) ? p : null;
}

function ytdlpBaseArgs(useCookies = false, platform = null) {
  const args = [
    '--no-warnings',
    '--no-check-certificates',
    '--user-agent', YTDLP_UA,
  ];
  // Cookies are only added on an explicit retry (login-required content) so that
  // YouTube / public Facebook never touch the cookie store needlessly.
  if (useCookies) {
    const file = cookieFileFor(platform);
    if (file) {
      args.push('--cookies', file); // preferred: in-app login (no browser lock)
    } else if (CONFIG.cookiesBrowser && CONFIG.cookiesBrowser !== 'none') {
      args.push('--cookies-from-browser', CONFIG.cookiesBrowser);
    }
  }
  return args;
}

// True if any cookie source is available (in-app file or a configured browser).
function hasCookies(platform) {
  return !!cookieFileFor(platform) || (CONFIG.cookiesBrowser && CONFIG.cookiesBrowser !== 'none');
}

// Run an operation, using cookies up-front if a login file exists, otherwise
// retrying with cookies only when the failure looks login-related.
async function runWithCookieFallback(fn, platform) {
  const haveFile = !!cookieFileFor(platform);
  // Instagram needs the login cookies up-front. Facebook/YouTube/TikTok work on
  // PUBLIC content WITHOUT cookies — and Facebook actually FAILS ("Cannot parse
  // data") when logged-in cookies are sent, so for those try no-cookies first.
  const cookiesFirst = haveFile && platform === 'instagram';
  try {
    return await fn(cookiesFirst);
  } catch (e) {
    if (!cookiesFirst && hasCookies(platform) && isAuthError(e.raw || e.message)) {
      return await fn(true);
    }
    throw e;
  }
}
function isAuthError(msg) {
  return /login|private|sign in|sign-in|cookies|empty media|محتوى خاص|تسجيل دخول/i.test(msg || '');
}

/**
 * Flat-playlist stream: emits each item as soon as yt-dlp prints its JSON line.
 * onItem(item, index). Resolves with the full array.
 */
function ytdlpFlatList(targetUrl, { onItem, sleepRequests = '0.5', timeoutMs = 600000, useCookies = false, platform = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...ytdlpBaseArgs(useCookies, platform || detectPlatform(targetUrl)),
      '--sleep-requests', sleepRequests,
      '--flat-playlist',
      '--dump-json',
      targetUrl,
    ];
    const proc = spawn(YTDLP_PATH, args, { windowsHide: true });
    const items = [];
    let stdoutBuf = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('انتهت مهلة جلب القائمة (الحساب كبير جداً، حاول مجدداً).'));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          const card = ytdlpFlatToCard(item, targetUrl);
          items.push(card);
          if (onItem) onItem(card, items.length - 1);
        } catch { /* ignore non-json lines */ }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (items.length > 0) return resolve(items);
      if (code !== 0) return reject(new Error(friendlyYtdlpError(stderr, code)));
      resolve(items);
    });
  });
}

function ytdlpFlatToCard(item, sourceUrl) {
  const platform = detectPlatform(item.url || item.webpage_url || sourceUrl) || detectPlatform(sourceUrl);
  let url = item.url || item.webpage_url || '';
  // flat-playlist sometimes gives bare ids
  if (url && !/^https?:/.test(url)) {
    if (platform === 'youtube') url = `https://www.youtube.com/watch?v=${item.id}`;
  }
  let thumb = item.thumbnail || '';
  if (!thumb && Array.isArray(item.thumbnails) && item.thumbnails.length) {
    thumb = item.thumbnails[item.thumbnails.length - 1].url;
  }
  if (!thumb && platform === 'youtube' && item.id) {
    thumb = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  }
  return {
    platform,
    id: String(item.id || ''),
    url,
    title: item.title || item.description || '(بدون عنوان)',
    thumbnail: thumb,
    duration: item.duration || 0,
    views: item.view_count || 0,
    author: item.uploader || item.channel || item.uploader_id || '',
  };
}

/** Full JSON for a single video. */
function ytdlpSingleInfo(url, { timeoutMs = 90000, useCookies = false, platform = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...ytdlpBaseArgs(useCookies, platform || detectPlatform(url)),
      '--sleep-requests', '1',
      '-J',
      url,
    ];
    const proc = spawn(YTDLP_PATH, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('انتهت مهلة جلب المعلومات.')); }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return reject(new Error(friendlyYtdlpError(err, code)));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('فشل قراءة بيانات الفيديو.')); }
    });
  });
}

function ytdlpInfoToCard(info, sourceUrl) {
  const platform = detectPlatform(info.webpage_url || sourceUrl);
  let thumb = info.thumbnail || '';
  if (!thumb && Array.isArray(info.thumbnails) && info.thumbnails.length) {
    thumb = info.thumbnails[info.thumbnails.length - 1].url;
  }
  return {
    platform,
    id: String(info.id || ''),
    url: info.webpage_url || sourceUrl,
    title: info.title || '(بدون عنوان)',
    thumbnail: thumb,
    duration: info.duration || 0,
    views: info.view_count || 0,
    author: info.uploader || info.channel || info.uploader_id || '',
  };
}

function friendlyYtdlpError(stderr, code) {
  const s = (stderr || '').toLowerCase();
  if (/could not copy .*cookie database|cookie database/.test(s)) {
    return 'تعذّر قراءة كوكيز المتصفح (المتصفح مفتوح أو محمي). اقفل المتصفح تماماً ثم حاول، أو اختر Firefox، أو اضبط الكوكيز على "بدون" من الإعدادات.';
  }
  if (/429|too many requests|rate.?limit/.test(s)) {
    return 'المنصة تحظر الطلبات مؤقتاً، انتظر 5-10 دقائق ثم حاول مجدداً.';
  }
  if (/login required|private|sign in|cookies|empty media/.test(s)) {
    return hasCookies()
      ? 'هذا المحتوى خاص أو يتطلب تسجيل دخول (تأكد أنك مسجّل دخول في المتصفح المختار).'
      : 'هذا المحتوى خاص أو يتطلب تسجيل دخول. فعّل "الكوكيز من المتصفح" من الإعدادات.';
  }
  if (/unsupported url|no video/.test(s)) {
    return 'الرابط غير مدعوم أو لا يحتوي على فيديو.';
  }
  if (code === 101) return 'NOT_A_VIDEO';
  const firstErr = (stderr || '').split('\n').reverse().find((l) => /error/i.test(l));
  return firstErr ? firstErr.replace(/^ERROR:\s*/i, '').trim() : 'فشل جلب البيانات من المنصة.';
}

// Try without cookies first; only retry with cookies if the failure looks
// login-related and a cookies browser is configured.
async function ytdlpSingleInfoSmart(url, opts = {}) {
  const platform = detectPlatform(url);
  return runWithCookieFallback(
    (useCookies) => ytdlpSingleInfo(url, { ...opts, useCookies, platform }),
    platform
  );
}

// ───────────────────────────── caching (stale-on-error) ─────────────────────────────
const _cache = new Map(); // key -> { ts, data }
const CACHE_TTL = 5 * 60 * 1000;
const STALE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts < CACHE_TTL) return { fresh: true, data: e.data };
  if (Date.now() - e.ts < STALE_TTL) return { fresh: false, data: e.data };
  return null;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

// ───────────────────────────── ROUTES ─────────────────────────────

// Health / config
app.get('/api/health', (req, res) => {
  res.json({ ok: true, downloadDir: getDownloadDir(), ytdlp: YTDLP_PATH, ffmpeg: FFMPEG_PATH });
});

function publicConfig() {
  // never expose the raw API key to the renderer
  const { anthropicApiKey, ...rest } = CONFIG;
  return { ...rest, downloadDir: getDownloadDir(), hasApiKey: !!anthropicApiKey, appVersion: APP_VERSION };
}

app.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

// Verify the Instagram session is actually valid (not just that a cookie file exists).
// Hard-capped so a slow/hanging Instagram response can never freeze the settings UI.
async function igSessionValid() {
  const cookie = igCookieHeader();
  if (!cookie) return false;
  const check = (async () => {
    try {
      const res = await httpRequest('https://www.instagram.com/api/v1/tags/web_info/?tag_name=nature', {
        headers: {
          'x-ig-app-id': '936619743392459',
          'User-Agent': YTDLP_UA,
          'Cookie': cookie,
          'Referer': 'https://www.instagram.com/',
          'Accept': '*/*',
        },
        timeout: 6000,
      });
      let json = null;
      try { json = JSON.parse(res.body.toString('utf8')); } catch {}
      return !!(json && json.data); // expired sessions redirect to a login HTML page → no JSON
    } catch { return false; }
  })();
  const guard = new Promise((resolve) => setTimeout(() => resolve(false), 8000));
  return Promise.race([check, guard]);
}

app.get('/api/cookies-status', async (req, res) => {
  const igFile = !!cookieFileFor('instagram');
  const igValid = igFile ? await igSessionValid() : false;
  res.json({
    instagram: igValid,
    instagramHasFile: igFile,
    facebook: !!cookieFileFor('facebook'),
    facebookHasFile: !!cookieFileFor('facebook'),
  });
});
app.post('/api/config', (req, res) => {
  const { downloadDir, cookiesBrowser, videoQuality } = req.body || {};
  if (typeof downloadDir === 'string' && downloadDir.trim()) CONFIG.downloadDir = downloadDir.trim();
  if (typeof cookiesBrowser === 'string') CONFIG.cookiesBrowser = cookiesBrowser;
  if (typeof videoQuality === 'string') CONFIG.videoQuality = videoQuality;
  const { downloadWinUrl, downloadMacUrl } = req.body || {};
  if (typeof downloadWinUrl === 'string') CONFIG.downloadWinUrl = downloadWinUrl.trim();
  if (typeof downloadMacUrl === 'string') CONFIG.downloadMacUrl = downloadMacUrl.trim();
  saveConfig();
  try { fs.mkdirSync(getDownloadDir(), { recursive: true }); } catch {}
  res.json(publicConfig());
});

// ───────────────────────── Claude (Anthropic) integration ─────────────────────────
function getAnthropicClient() {
  if (!CONFIG.anthropicApiKey) return null;
  return new Anthropic({ apiKey: CONFIG.anthropicApiKey });
}

// Connect/validate an API key, then return the available Claude models.
app.post('/api/ai/connect', async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'أدخل مفتاح API.' });
  try {
    const client = new Anthropic({ apiKey: apiKey.trim() });
    const models = [];
    for await (const m of client.models.list()) {
      if (/claude/i.test(m.id)) models.push({ id: m.id, name: m.display_name || m.id });
    }
    CONFIG.anthropicApiKey = apiKey.trim();
    if (!CONFIG.anthropicModel || !models.some((m) => m.id === CONFIG.anthropicModel)) {
      CONFIG.anthropicModel = models.some((m) => m.id === 'claude-opus-4-8')
        ? 'claude-opus-4-8'
        : ((models[0] && models[0].id) || 'claude-opus-4-8');
    }
    saveConfig();
    res.json({ ok: true, models, selected: CONFIG.anthropicModel });
  } catch (e) {
    const msg = (e && e.status === 401) ? 'المفتاح غير صالح.' : (e.message || 'فشل الاتصال بـ Claude.');
    res.status(400).json({ error: msg });
  }
});

// List models for an already-connected key.
app.get('/api/ai/models', async (req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(400).json({ error: 'لم يتم ربط مفتاح Claude.' });
  try {
    const models = [];
    for await (const m of client.models.list()) {
      if (/claude/i.test(m.id)) models.push({ id: m.id, name: m.display_name || m.id });
    }
    res.json({ models, selected: CONFIG.anthropicModel });
  } catch (e) {
    res.status(400).json({ error: e.message || 'فشل جلب الموديلز.' });
  }
});

// Save the selected model.
app.post('/api/ai/model', (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: 'اختر موديل.' });
  CONFIG.anthropicModel = model;
  saveConfig();
  res.json({ ok: true, selected: CONFIG.anthropicModel });
});

// Disconnect (clear the key).
app.post('/api/ai/disconnect', (req, res) => {
  CONFIG.anthropicApiKey = '';
  saveConfig();
  res.json({ ok: true });
});

const KEYWORDS_SCHEMA = {
  type: 'object',
  properties: {
    product: { type: 'string', description: 'The EXACT product identity as printed on it: brand + product name + variant/edition' },
    english: { type: 'array', items: { type: 'string' }, description: 'Exactly 7 English search phrases' },
    arabic: { type: 'array', items: { type: 'string' }, description: 'Exactly 4 Arabic search phrases' },
    chinese: { type: 'array', items: { type: 'string' }, description: 'Exactly 3 Chinese search phrases' },
  },
  required: ['product', 'english', 'arabic', 'chinese'],
  additionalProperties: false,
};

// Generate product search keywords from an uploaded image (Claude vision).
app.post('/api/ai/keywords', async (req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(400).json({ error: 'اربط مفتاح Claude من الإعدادات أولاً.' });

  const { imageBase64, mediaType = 'image/jpeg', platform = 'tiktok' } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'لم يتم إرسال صورة.' });

  const model = CONFIG.anthropicModel || 'claude-opus-4-8';
  const prompt =
    `STEP 1 — Identify the product EXACTLY. Read carefully every piece of text printed on the ` +
    `product and its packaging: brand, product name, variant/edition, size. Zoom into labels, ` +
    `logos and embossed text. The goal is the exact identity as written on the box — not a description.\n\n` +
    `STEP 2 — Generate search phrases to find videos of THIS EXACT product on ${platform}. ` +
    `When you identified a brand/product name, EVERY phrase MUST contain that exact name verbatim ` +
    `(e.g. "<brand> <name> review", "<name> unboxing", "<brand> <name> original vs fake") — ` +
    `no generic descriptors like "black perfume bottle".\n` +
    `- "english": EXACTLY 7 phrases, each built around the exact printed name\n` +
    `- "arabic": EXACTLY 4 genuinely-Arabic phrases: 2 with the printed Latin name inside Arabic ` +
    `wording (e.g. "عطر <name> الأصلي") AND 2 with the common ARABIC TRANSLITERATION of the ` +
    `brand/name as Arab TikTok users would type it (e.g. "افنان" for Afnan) — Arab creators often ` +
    `write the name in Arabic letters, so both spellings are needed\n` +
    `- "chinese": EXACTLY 3 Chinese (Simplified) phrases — same rule, keep the printed name verbatim\n` +
    `- "product": one line = the exact identity as printed (brand + name + variant).\n` +
    `ONLY if no brand or name text is readable anywhere: fall back to the most precise descriptors ` +
    `possible (type + color + shape + any partial visible text). No hashtags, no numbering.`;

  try {
    const r = await client.messages.create({
      model,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: KEYWORDS_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    const textBlock = (r.content || []).find((b) => b.type === 'text');
    let parsed = {};
    try { parsed = JSON.parse(textBlock.text); } catch {}
    const keywords = []
      .concat(parsed.english || [], parsed.arabic || [], parsed.chinese || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    res.json({ keywords, product: parsed.product || '', model });
  } catch (e) {
    const msg = (e && e.status === 401) ? 'مفتاح Claude غير صالح.' : (e.message || 'فشل تحليل الصورة.');
    res.status(400).json({ error: msg });
  }
});

// ───────────────────── visual product-match verification ─────────────────────
const {
  VERIFY_SCHEMA,
  chunk: verifyChunk,
  isAllowedThumbUrl,
  parseVerdictResults,
  cardToVerifyItem,
  normalizeRefImages,
} = require('./verify-utils');

const VERIFY_MAX_CARDS = 24;   // per request
const VERIFY_BATCH = 8;        // thumbnails per Claude call
const VERIFY_DEEP_MAX = 6;     // auto deep-checks per request
const VERIFY_DEEP_FRAMES = 6;  // frames per deep check

// fetch a thumbnail (allowlisted host only) and return it as a base64 image block
async function fetchThumbBase64(url) {
  const host = new URL(url).hostname.toLowerCase();
  const headers = { 'User-Agent': YTDLP_UA, 'Accept': 'image/*' };
  const ref = refererForHost(host);
  if (ref) headers.Referer = ref;
  const r = await httpRequest(url, { headers, timeout: 20000 });
  if (r.status !== 200 || !r.body || !r.body.length) throw new Error(`thumb HTTP ${r.status}`);
  if (r.body.length > 6 * 1024 * 1024) throw new Error('thumb too large');
  const ct = (r.headers['content-type'] || '').toLowerCase();
  const mediaType = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: r.body.toString('base64') } };
}

// uniform-sample n frames from a local video with the bundled ffmpeg
function extractFrames(videoPath, outDir, n, durationSec) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const dur = Math.max(1, durationSec || 30);
    const fps = Math.min(2, Math.max(0.05, n / dur));
    const proc = spawn(FFMPEG_PATH, [
      '-y', '-i', videoPath,
      '-vf', `fps=${fps},scale=512:-2`,
      '-frames:v', String(n),
      path.join(outDir, 'f_%02d.jpg'),
    ], { windowsHide: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('فشل استخراج الفريمات (ffmpeg).'));
      const frames = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg'))
        .sort().map((f) => path.join(outDir, f));
      if (!frames.length) return reject(new Error('لا توجد فريمات.'));
      resolve(frames);
    });
  });
}

function productImageBlocks(refImages) {
  return refImages.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));
}

function verifyPromptIntro(refCount) {
  return (
    `The FIRST ${refCount === 1 ? 'image is a reference photo' : refCount + ' images are reference photos'} ` +
    'of ONE product. Each numbered image after that is a video thumbnail/frame labeled with its id. ' +
    'For each id decide if the video shows the EXACT same product (same model, color, packaging/label — ' +
    'not just a similar item). Be strict: variants of the same brand (different edition, color or ' +
    'label text) are no_match. If the image is too unclear or the product is not visible, answer unsure.'
  );
}

async function claudeVerdicts(client, model, contentBlocks, expectedIds) {
  const r = await client.messages.create({
    model,
    max_tokens: 1500,
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
    messages: [{ role: 'user', content: contentBlocks }],
  });
  const textBlock = (r.content || []).find((b) => b.type === 'text');
  return parseVerdictResults(textBlock ? textBlock.text : '', expectedIds);
}

// deep check: download the TikTok video to a temp dir, sample frames, ask again
async function deepVerifyOne(client, model, productImgs, item) {
  const workDir = path.join(os.tmpdir(), 'mediagrab-verify', String(item.id));
  try {
    let play = '';
    const v = await tikwmGetVideo(item.url);
    play = v.hdplay || v.play;
    if (!play) throw new Error('لا يوجد رابط فيديو.');
    fs.mkdirSync(workDir, { recursive: true });
    // 'verify:silent' is an empty socket room → progress events go nowhere
    const videoPath = await downloadFile(play, path.join(workDir, 'video'), `verify_${item.id}`, 'verify:silent');
    const frames = await extractFrames(videoPath, path.join(workDir, 'frames'), VERIFY_DEEP_FRAMES, item.duration);
    const content = [...productImgs, { type: 'text', text: verifyPromptIntro(productImgs.length) }];
    content.push({ type: 'text', text: `id=${item.id} — the following ${frames.length} images are frames from ONE video:` });
    for (const f of frames) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
    }
    const map = await claudeVerdicts(client, model, content, [item.id]);
    return map.get(item.id) || { verdict: 'unsure', reason: '' };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function runVerify(client, model, productImgs, items, socketId, deep, deepOnly = false) {
  const verdicts = new Map();
  const report = (item, v, stage) => {
    verdicts.set(item.id, v.verdict);
    emit(socketId, 'verify:item', { id: item.id, verdict: v.verdict, reason: v.reason || '', stage });
  };

  // deepOnly (manual re-check) skips the thumbnail stage entirely
  if (deepOnly) items.forEach((it) => verdicts.set(it.id, 'unsure'));

  // stage 1 — thumbnails, in sequential batches
  for (const batch of deepOnly ? [] : verifyChunk(items, VERIFY_BATCH)) {
    const withImages = [];
    for (const item of batch) {
      if (!isAllowedThumbUrl(item.thumbnail, PROXY_ALLOW)) {
        report(item, { verdict: 'unsure', reason: 'لا توجد صورة مصغرة صالحة.' }, 'thumb');
        continue;
      }
      try {
        withImages.push({ item, img: await fetchThumbBase64(item.thumbnail) });
      } catch {
        report(item, { verdict: 'unsure', reason: 'تعذّر جلب الصورة المصغرة.' }, 'thumb');
      }
    }
    if (!withImages.length) continue;
    const content = [...productImgs, { type: 'text', text: verifyPromptIntro(productImgs.length) }];
    withImages.forEach(({ item }, i) => {
      content.push({ type: 'text', text: `${i + 1}) id=${item.id}` });
      content.push(withImages[i].img);
    });
    try {
      const map = await claudeVerdicts(client, model, content, withImages.map(({ item }) => item.id));
      for (const { item } of withImages) report(item, map.get(item.id), 'thumb');
    } catch (e) {
      for (const { item } of withImages) report(item, { verdict: 'unsure', reason: 'فشل نداء التحقق.' }, 'thumb');
    }
  }

  // stage 2 — deep frames for unsure TikTok results (capped)
  if (deep) {
    const unsure = items.filter((it) => verdicts.get(it.id) === 'unsure' && it.platform === 'tiktok' && it.url)
      .slice(0, VERIFY_DEEP_MAX);
    for (const item of unsure) {
      emit(socketId, 'verify:item', { id: item.id, verdict: 'checking', stage: 'deep' });
      try {
        report(item, await deepVerifyOne(client, model, productImgs, item), 'deep');
      } catch {
        report(item, { verdict: 'unsure', reason: 'تعذّر الفحص العميق.' }, 'deep');
      }
    }
  }

  const counts = { match: 0, no_match: 0, unsure: 0 };
  for (const v of verdicts.values()) counts[v] = (counts[v] || 0) + 1;
  emit(socketId, 'verify:done', { counts });
}

/**
 * POST /api/ai/verify  { imageBase64, mediaType, cards[], socketId, deep? }
 * Streams verify:item / verify:done / verify:error over the socket.
 */
app.post('/api/ai/verify', (req, res) => {
  const client = getAnthropicClient();
  if (!client) return res.status(400).json({ error: 'اربط مفتاح Claude من الإعدادات أولاً.' });

  const { cards, socketId, deep = true, deepOnly = false } = req.body || {};
  const refImages = normalizeRefImages(req.body);
  if (!refImages.length) return res.status(400).json({ error: 'لم يتم إرسال صورة المنتج.' });
  const items = (Array.isArray(cards) ? cards : []).slice(0, VERIFY_MAX_CARDS)
    .map(cardToVerifyItem).filter(Boolean);
  if (!items.length) return res.status(400).json({ error: 'لا توجد نتائج للتحقق منها.' });

  const model = CONFIG.anthropicModel || 'claude-opus-4-8';
  const productImgs = productImageBlocks(refImages);
  res.json({ started: true, count: items.length, refImages: refImages.length });

  runVerify(client, model, productImgs, items, socketId, deep === false ? false : true, deepOnly === true)
    .catch((e) => emit(socketId, 'verify:error', { message: e.message || 'فشل التحقق.' }));
});

/**
 * POST /api/info  { url, socketId }
 * - single video → returns { type:'video', items:[card] }
 * - profile/channel/playlist → streams items over socket and returns { type:'list', streaming:true }
 */
app.post('/api/info', async (req, res) => {
  const { url, socketId } = req.body || {};
  if (!url) return res.status(400).json({ error: 'لم يتم إدخال رابط.' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'الرابط غير مدعوم. المنصات المتاحة: تيك توك، يوتيوب، إنستجرام، فيسبوك.' });

  const isList =
    (platform === 'tiktok' && isTikTokUser(url)) ||
    (platform === 'youtube' && isYouTubeChannelOrPlaylist(url)) ||
    (platform === 'instagram' && isInstagramProfile(url)) ||
    (platform === 'facebook' && isFacebookProfile(url));

  try {
    if (isList) {
      // stream the list over socket; respond immediately
      res.json({ type: 'list', platform, streaming: true });
      streamList(url, platform, socketId);
      return;
    }

    // single video
    if (platform === 'tiktok') {
      const v = await tikwmGetVideo(url);
      const card = {
        platform: 'tiktok',
        id: v.id,
        url,
        title: v.title || '(بدون عنوان)',
        thumbnail: v.cover,
        duration: v.duration,
        views: 0,
        author: v.author,
        play: v.play,
        hdplay: v.hdplay,
        music: v.music,
      };
      return res.json({ type: 'video', platform, items: [card] });
    }

    const info = await ytdlpSingleInfoSmart(url);
    const card = ytdlpInfoToCard(info, url);
    return res.json({ type: 'video', platform, items: [card] });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'فشل جلب المعلومات.' });
  }
});

async function streamList(url, platform, socketId) {
  const cacheKey = `list:${url}`;
  const run = (useCookies) => ytdlpFlatList(url, {
    sleepRequests: '0.5',
    timeoutMs: 600000,
    useCookies,
    platform,
    onItem: (card, i) => emit(socketId, 'list:item', { card, index: i }),
  });
  try {
    const items = await runWithCookieFallback(run, platform);
    cacheSet(cacheKey, items);
    emit(socketId, 'list:done', { count: items.length });
  } catch (e) {
    const stale = cacheGet(cacheKey);
    if (stale) {
      stale.data.forEach((card, i) => emit(socketId, 'list:item', { card, index: i }));
      emit(socketId, 'list:done', { count: stale.data.length, stale: true });
    } else {
      emit(socketId, 'list:error', { message: e.message || 'فشل جلب القائمة.' });
    }
  }
}

// split "ad, اعلان; product" → ['ad','اعلان','product']
function splitKeywords(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input || '')
    .split(/[,،;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// TikTok multi-keyword search with pagination + cross-keyword de-dup, streamed live.
async function tiktokSearchStream(keywords, perKeyword, socketId) {
  const seen = new Set();
  let idx = 0;
  let errored = null;
  for (const kw0 of keywords) {
    const kw = normalizeArabic(kw0) || kw0;
    emit(socketId, 'list:status', { message: `بحث: ${kw0}` });
    let cursor = 0;
    let pulled = 0;
    let guard = 0;
    try {
      while (pulled < perKeyword && guard < 12) {
        guard++;
        const json = await tikwmSerializedRequest('https://www.tikwm.com/api/feed/search', {
          keywords: kw, count: 30, cursor, hd: 1,
        });
        const videos = (json.data && json.data.videos) || [];
        if (!videos.length) break;
        for (const v of videos) {
          const card = tikwmItemToCard(v);
          if (!card.id || seen.has(card.id)) continue;
          seen.add(card.id);
          emit(socketId, 'list:item', { card, index: idx++ });
        }
        pulled += videos.length;
        cursor = (json.data && json.data.cursor) || (cursor + videos.length);
        if (!(json.data && json.data.hasMore)) break;
      }
    } catch (e) { errored = e; }
  }
  if (seen.size === 0 && errored) emit(socketId, 'list:error', { message: errored.message || 'فشل البحث.' });
  else emit(socketId, 'list:done', { count: seen.size });
}

// YouTube multi-keyword search (yt-dlp ytsearch) + cross-keyword de-dup, streamed live.
async function youtubeSearchStream(keywords, perKeyword, socketId) {
  const seen = new Set();
  let idx = 0;
  let errored = null;
  for (const kw0 of keywords) {
    const kw = normalizeArabic(kw0) || kw0;
    emit(socketId, 'list:status', { message: `بحث: ${kw0}` });
    try {
      await ytdlpFlatList(`ytsearch${perKeyword}:${kw}`, {
        platform: 'youtube',
        sleepRequests: '0.4',
        onItem: (card) => {
          if (!card.id || seen.has(card.id)) return;
          seen.add(card.id);
          emit(socketId, 'list:item', { card, index: idx++ });
        },
      });
    } catch (e) { errored = e; }
  }
  if (seen.size === 0 && errored) emit(socketId, 'list:error', { message: errored.message || 'فشل البحث.' });
  else emit(socketId, 'list:done', { count: seen.size });
}

/**
 * POST /api/search  { platform, query | keywords[], perKeyword, socketId }
 * TikTok → TikWM ; YouTube → yt-dlp ytsearch (both multi-keyword + de-duped).
 * IG/FB single keyword → treated as account/hashtag/page.
 */
app.post('/api/search', async (req, res) => {
  const { platform, query, keywords, socketId } = req.body || {};
  const kws = splitKeywords(keywords && keywords.length ? keywords : query);
  if (!kws.length) return res.status(400).json({ error: 'اكتب كلمة واحدة على الأقل للبحث.' });

  // clamp depth: 30..150 results per keyword
  let perKeyword = parseInt(req.body && req.body.perKeyword, 10) || 30;
  perKeyword = Math.max(30, Math.min(150, perKeyword));

  try {
    if (platform === 'tiktok') {
      res.json({ streaming: true, keywords: kws });
      tiktokSearchStream(kws, perKeyword, socketId);
      return;
    }

    if (platform === 'youtube') {
      res.json({ streaming: true, keywords: kws });
      youtubeSearchStream(kws, perKeyword, socketId);
      return;
    }

    const q = kws[0];
    if (platform === 'instagram') {
      // URL or @username → list that profile; otherwise keyword(s) → hashtag Reels search
      if (/^https?:/i.test(q) || q.startsWith('@')) {
        const target = /^https?:/i.test(q) ? q : `https://www.instagram.com/${q.replace(/^@/, '')}/`;
        res.json({ streaming: true });
        streamList(target, 'instagram', socketId);
        return;
      }
      res.json({ streaming: true, keywords: kws });
      igSearchStream(kws, perKeyword, socketId);
      return;
    }
    if (platform === 'facebook') {
      let target;
      if (/^https?:/i.test(q)) target = q;
      else target = `https://www.facebook.com/${encodeURIComponent(q.replace(/^@/, ''))}/videos/`;
      res.json({ streaming: true });
      streamList(target, 'facebook', socketId);
      return;
    }

    return res.status(400).json({ error: 'منصة غير مدعومة للبحث.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'فشل البحث.' });
  }
});

// Fetch real metadata for a single video URL (title, views, hi-res thumbnail,
// duration) — used to enrich Facebook search results to full quality.
app.post('/api/video-meta', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'no url' });
  try {
    const info = await ytdlpSingleInfoSmart(url);
    res.json({ card: ytdlpInfoToCard(info, url) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'meta failed' });
  }
});

/**
 * POST /api/download  { item, format, socketId }
 * format: 'video' | 'mp3'
 * returns { id }; progress streamed over socket as 'progress' events.
 */
app.post('/api/download', async (req, res) => {
  const { item, format = 'video', socketId } = req.body || {};
  if (!item || !item.url) return res.status(400).json({ error: 'عنصر غير صالح.' });

  const id = `${Date.now()}_${Math.floor(performance.now() % 100000)}`;
  res.json({ id });

  emitProgress(socketId, { id, status: 'starting', progress: 0, title: item.title });

  try {
    let filePath;
    if (item.platform === 'tiktok') {
      filePath = await downloadTikTok(item, format, id, socketId);
    } else {
      filePath = await downloadViaYtdlpSmart(item, format, id, socketId);
    }
    emitProgress(socketId, {
      id, status: 'completed', progress: 100,
      title: item.title, filePath, fileName: path.basename(filePath),
    });
  } catch (e) {
    const msg = e.message === 'NOT_A_VIDEO'
      ? 'هذا منشور صور وليس فيديو.'
      : (e.message || 'فشل التنزيل.');
    emitProgress(socketId, { id, status: 'error', error: msg, title: item.title });
  }
});

// ───────────────────────────── download engines ─────────────────────────────

function safeName(s) {
  return (s || 'video').replace(/[<>:"/\\|?*\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  let i = 1;
  while (fs.existsSync(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

function extFromContentType(ct) {
  ct = (ct || '').toLowerCase();
  if (ct.includes('video/webm')) return '.webm';
  if (ct.includes('video/mp4')) return '.mp4';
  if (ct.includes('audio/mpeg')) return '.mp3';
  if (ct.includes('audio/mp4') || ct.includes('audio/m4a')) return '.m4a';
  if (ct.includes('image/jpeg')) return '.jpg';
  if (ct.includes('image/png')) return '.png';
  return '.mp4';
}

/** Stream a direct URL to disk with progress. */
function downloadFile(url, destNoExt, id, socketId, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('روابط إعادة توجيه كثيرة.'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;

    const req = lib.get(
      u,
      { headers: { 'User-Agent': YTDLP_UA, 'Referer': 'https://www.tiktok.com/' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadFile(new URL(res.headers.location, u).toString(), destNoExt, id, socketId, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`فشل التنزيل (HTTP ${res.statusCode}).`));
        }

        const ext = extFromContentType(res.headers['content-type']);
        const dest = uniquePath(destNoExt + ext);
        const file = fs.createWriteStream(dest);
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const start = Date.now();
        let lastEmit = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit >= 250) {
            lastEmit = now;
            const elapsed = (now - start) / 1000 || 1;
            const speed = received / elapsed;
            const progress = total ? (received / total) * 100 : 0;
            const eta = total && speed ? (total - received) / speed : 0;
            emitProgress(socketId, {
              id, status: 'downloading',
              progress: Math.min(99, progress),
              speed: humanSpeed(speed),
              eta: humanEta(eta),
              received, total,
            });
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (e) => { fs.rm(dest, { force: true }, () => {}); reject(e); });
      }
    );
    req.on('error', reject);
  });
}

async function downloadTikTok(item, format, id, socketId) {
  // ensure we have a direct media url (no-watermark) via TikWM
  const isHttp = (u) => /^https?:/i.test(u || '');
  let play = isHttp(item.hdplay) ? item.hdplay : (isHttp(item.play) ? item.play : '');
  let music = isHttp(item.music) ? item.music : '';
  if (!play || (format === 'mp3' && !music)) {
    const v = await tikwmGetVideo(item.url);
    play = tikwmAbs(v.hdplay || v.play) || play;
    music = tikwmAbs(v.music) || music;
  }
  if (!play) throw new Error('تعذّر الحصول على رابط الفيديو من تيك توك.');

  const baseName = safeName(item.title) + ` [${item.id || ''}]`.trim();
  fs.mkdirSync(getDownloadDir(), { recursive: true });
  const destNoExt = path.join(getDownloadDir(), baseName);

  if (format === 'mp3') {
    // download the video first, then extract audio with ffmpeg
    emitProgress(socketId, { id, status: 'downloading', progress: 0, title: item.title });
    const videoPath = await downloadFile(play, destNoExt + '_tmp', id, socketId);
    emitProgress(socketId, { id, status: 'converting', progress: 99, title: item.title });
    const mp3Path = uniquePath(destNoExt + '.mp3');
    await ffmpegToMp3(videoPath, mp3Path);
    fs.rm(videoPath, { force: true }, () => {});
    return mp3Path;
  }

  return downloadFile(play, destNoExt, id, socketId);
}

function ffmpegToMp3(src, dest) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      '-y', '-i', src,
      '-vn',
      '-acodec', 'libmp3lame',
      '-q:a', '2',
      dest,
    ], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(dest);
      else reject(new Error('فشل تحويل الصوت (ffmpeg).'));
    });
  });
}

function downloadViaYtdlp(item, format, id, socketId, useCookies = false) {
  return new Promise((resolve, reject) => {
    const platform = item.platform || detectPlatform(item.url);
    fs.mkdirSync(getDownloadDir(), { recursive: true });
    const outTpl = path.join(getDownloadDir(), '%(title).80s [%(id)s].%(ext)s');
    const args = [
      ...ytdlpBaseArgs(useCookies, platform),
      '--no-playlist',
      '--newline',
      '--progress-template',
      'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '-o', outTpl,
      '--ffmpeg-location', FFMPEG_PATH,
    ];
    if (format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '2');
    } else {
      // recode-video re-encodes ONLY non-mp4 (VP9/AV1) sources to H.264 mp4;
      // H.264 sources are just merged (fast). Guarantees QuickTime playback.
      args.push('-f', ytFormatSelector(), '--recode-video', 'mp4');
    }
    // print final path after move
    args.push('--print', 'after_move:filepath', '--no-simulate');
    args.push(item.url);

    const proc = spawn(YTDLP_PATH, args, { windowsHide: true });
    let finalPath = '';
    let lastDest = '';
    let stderr = '';

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      if (line.startsWith('PROG|')) {
        const [, dl, tot, totEst, speed, eta] = line.split('|');
        const total = parseInt(tot, 10) || parseInt(totEst, 10) || 0;
        const got = parseInt(dl, 10) || 0;
        const progress = total ? (got / total) * 100 : 0;
        emitProgress(socketId, {
          id, status: 'downloading',
          progress: Math.min(99, progress),
          speed: humanSpeed(parseFloat(speed) || 0),
          eta: humanEta(parseFloat(eta) || 0),
          received: got, total,
        });
        return;
      }
      const mDest = line.match(/\[download\] Destination:\s*(.+)$/) ||
                    line.match(/Merging formats into "(.+)"$/);
      if (mDest) lastDest = mDest[1].trim();
      if (/\.(mp4|webm|mkv|mp3|m4a|jpg|png)$/i.test(line) && (line.includes(path.sep) || line.includes('/'))) {
        finalPath = line;
      }
    }

    let outBuf = '';
    proc.stdout.on('data', (d) => {
      outBuf += d.toString();
      let nl;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        handleLine(outBuf.slice(0, nl));
        outBuf = outBuf.slice(nl + 1);
      }
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // progress on some platforms appears on stderr too
      s.split('\n').forEach(handleLine);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (outBuf) handleLine(outBuf);
      if (code !== 0) {
        const err = new Error(friendlyYtdlpError(stderr, code));
        err.raw = stderr;
        return reject(err);
      }
      const result = finalPath || lastDest;
      if (result && fs.existsSync(result)) return resolve(result);
      // fallback: newest file in download dir
      try {
        const files = fs.readdirSync(getDownloadDir())
          .map((f) => path.join(getDownloadDir(), f))
          .filter((f) => fs.statSync(f).isFile())
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (files[0]) return resolve(files[0]);
      } catch {}
      reject(new Error('تم التنزيل لكن تعذّر تحديد مسار الملف.'));
    });
  });
}

async function downloadViaYtdlpSmart(item, format, id, socketId) {
  const platform = item.platform || detectPlatform(item.url);
  return runWithCookieFallback(
    (useCookies) => downloadViaYtdlp(item, format, id, socketId, useCookies),
    platform
  );
}

function humanSpeed(bps) {
  if (!bps || bps < 1) return '';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (bps >= 1024 && i < u.length - 1) { bps /= 1024; i++; }
  return `${bps.toFixed(1)} ${u[i]}`;
}
function humanEta(sec) {
  if (!sec || sec < 0 || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}م ${s}ث` : `${s}ث`;
}

// ───────────────────────────── MEDIA PROXY ─────────────────────────────
const PROXY_ALLOW = [
  'tiktokcdn', 'tiktok', 'muscdn', 'byteoversea', 'ibyteimg', 'tiktokv',
  'cdninstagram', 'instagram', 'fbcdn', 'facebook',
  'ytimg', 'googlevideo', 'ggpht', 'youtube',
  'tikwm', 'akamaized',
];

function refererForHost(host) {
  if (/tiktok|muscdn|byteoversea|ibyteimg|tiktokv|tikwm/.test(host)) return 'https://www.tiktok.com/';
  if (/instagram|cdninstagram/.test(host)) return 'https://www.instagram.com/';
  if (/fbcdn|facebook/.test(host)) return 'https://www.facebook.com/';
  if (/ytimg|googlevideo|ggpht|youtube/.test(host)) return 'https://www.youtube.com/';
  return '';
}

app.get('/api/proxy/media', (req, res) => {
  const u = req.query.u;
  if (!u) return res.status(400).send('missing url');
  let target;
  try { target = new URL(u); } catch { return res.status(400).send('bad url'); }

  const host = target.hostname.toLowerCase();
  if (!PROXY_ALLOW.some((h) => host.includes(h))) {
    return res.status(403).send('host not allowed');
  }

  const lib = target.protocol === 'http:' ? http : https;
  const headers = {
    'User-Agent': YTDLP_UA,
    'Accept': '*/*',
  };
  const ref = refererForHost(host);
  if (ref) headers.Referer = ref;
  if (req.headers.range) headers.Range = req.headers.range;

  const doRequest = (urlObj, redirects) => {
    if (redirects > 6) return res.status(502).send('too many redirects');
    const upstream = lib.get(urlObj, { headers }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = new URL(r.headers.location, urlObj);
        const nlib = next.protocol === 'http:' ? http : https;
        return doRequestWith(nlib, next, redirects + 1);
      }
      res.status(r.statusCode || 200);
      ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control'].forEach((h) => {
        if (r.headers[h]) res.setHeader(h, r.headers[h]);
      });
      r.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).send('proxy error'); });
  };
  const doRequestWith = (nlib, urlObj, redirects) => {
    const upstream = nlib.get(urlObj, { headers }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = new URL(r.headers.location, urlObj);
        return doRequestWith(next.protocol === 'http:' ? http : https, next, redirects + 1);
      }
      res.status(r.statusCode || 200);
      ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control'].forEach((h) => {
        if (r.headers[h]) res.setHeader(h, r.headers[h]);
      });
      r.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).send('proxy error'); });
  };

  doRequest(target, 0);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ───────────────────────────── socket ─────────────────────────────
io.on('connection', (socket) => {
  socket.emit('ready', { id: socket.id, downloadDir: getDownloadDir() });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MediaGrab server on http://127.0.0.1:${PORT}`);
  console.log(`yt-dlp:   ${YTDLP_PATH}`);
  console.log(`ffmpeg:   ${FFMPEG_PATH}`);
  console.log(`downloads: ${DOWNLOAD_DIR}`);
});
