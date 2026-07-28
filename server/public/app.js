'use strict';
/* MediaGrab frontend */

const socket = io();
let SOCKET_ID = null;
let DOWNLOAD_DIR = '';

const state = {
  platform: 'tiktok',
  results: [],          // current cards
  selected: new Set(),  // indices
  queue: new Map(),     // id -> queue item element data
  keywords: [],         // search keyword chips
  sortMode: 'default',  // 'default' | 'views'
  autoDownloadIncoming: false, // auto-download streamed list items (multi-link)
  productImages: [],    // [{base64, mediaType}] — reference photos for verification (max 4)
  verdicts: new Map(),  // card id -> {verdict:'match'|'no_match'|'unsure'|'checking', reason}
  matchFilter: 'all',   // 'all' | 'match'
  verifying: false,
};

// ── helpers ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const proxy = (url) => url ? `/api/proxy/media?u=${encodeURIComponent(url)}` : '';
const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtViews(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

// ── socket events ──
socket.on('connect', () => {
  SOCKET_ID = socket.id;
  setConn('online', 'Connected');
});
socket.on('disconnect', () => setConn('offline', 'Disconnected'));
socket.on('ready', (d) => { SOCKET_ID = d.id; DOWNLOAD_DIR = d.downloadDir || ''; });

let _listDone = null; // resolver used to await a streamed list (multi-link downloads)

socket.on('list:item', ({ card }) => {
  addResultCard(card);
  if (state.autoDownloadIncoming) startDownload(card, 'video');
});
socket.on('list:status', ({ message }) => setSearchStatus(message || 'جاري الجلب…'));
socket.on('list:done', ({ count, stale }) => {
  $('#resultsLoading').hidden = true;
  setSearchStatus('جاري الجلب…');
  updateResultsCount();
  if (stale) toast('عرض آخر نتيجة محفوظة (المنصة تحظر مؤقتاً).', 'error');
  else toast(`تم جلب ${count} فيديو.`, 'success');
  if (_listDone) { _listDone(count); _listDone = null; }
});
socket.on('list:error', ({ message }) => {
  $('#resultsLoading').hidden = true;
  toast(message || 'فشل الجلب.', 'error');
  if (_listDone) { _listDone(0); _listDone = null; }
});

socket.on('progress', (d) => updateQueue(d));

// show the real app version in the header badge (updates with each release)
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c && c.appVersion) $('#brandVersion').textContent = 'v' + c.appVersion;
}).catch(() => {});

function setConn(cls, text) {
  const c = $('#connStatus');
  c.className = 'conn ' + cls;
  c.innerHTML = `<i class="dot"></i> ${text}`;
}

// ── tabs ──
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  $$('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  state.platform = tab.dataset.platform;
  const ph = {
    tiktok: 'كلمات مفصولة بفاصلة: قرآن، تدبر، مصحف…',
    youtube: 'كلمات مفصولة بفاصلة على YouTube…',
    instagram: 'اسم حساب أو ‎#هاشتاج‎ على Instagram…',
    facebook: 'اسم صفحة على Facebook…',
  };
  $('#searchInput').placeholder = ph[state.platform];
  // depth applies to keyword search (TikTok / YouTube / Instagram hashtags)
  $('#searchDepth').style.display = (state.platform === 'facebook') ? 'none' : '';
});

// ── url actions ──
$('#btnPaste').addEventListener('click', async () => {
  try { $('#urlInput').value = await navigator.clipboard.readText(); }
  catch { toast('تعذّر اللصق من الحافظة.', 'error'); }
});
$('#btnClear').addEventListener('click', () => ($('#urlInput').value = ''));

$('#btnInfo').addEventListener('click', () => fetchInfo(false));
$('#btnDownload').addEventListener('click', () => fetchInfo(true));
// auto-grow the textarea; Ctrl/Cmd+Enter triggers download
$('#urlInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
});
$('#urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fetchInfo(true); }
});

// extract one-or-more links from the box (one per line, or space-separated)
function parseUrls(text) {
  const out = [];
  const seen = new Set();
  (text || '').split(/[\s\n]+/).forEach((tok) => {
    const u = tok.trim();
    if (/^https?:\/\//i.test(u) && !seen.has(u)) { seen.add(u); out.push(u); }
  });
  return out;
}

async function fetchInfo(autoDownload = false) {
  const urls = parseUrls($('#urlInput').value);
  if (!urls.length) return toast('الصق رابطاً واحداً على الأقل.', 'error');

  clearResults();
  showResults();
  $('#resultsLoading').hidden = false;
  setBtnLoading('#btnInfo', true);
  setBtnLoading('#btnDownload', true);

  let okCount = 0, errCount = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (urls.length > 1) setSearchStatus(`(${i + 1}/${urls.length}) ${url.slice(0, 50)}…`);
    try {
      const r = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, socketId: SOCKET_ID }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'فشل الجلب.');

      if (data.streaming) {
        // playlist / channel / profile → items arrive via socket
        state.autoDownloadIncoming = autoDownload;
        await new Promise((res) => { _listDone = res; });
        state.autoDownloadIncoming = false;
      } else {
        (data.items || []).forEach(addResultCard);
        if (autoDownload) (data.items || []).forEach((c) => startDownload(c, 'video'));
      }
      okCount++;
    } catch (e) {
      errCount++;
      toast(`رابط ${i + 1}: ${e.message}`, 'error');
    }
  }

  $('#resultsLoading').hidden = true;
  setSearchStatus('جاري الجلب…');
  updateResultsCount();
  setBtnLoading('#btnInfo', false);
  setBtnLoading('#btnDownload', false);
  if (urls.length > 1) {
    toast(autoDownload ? `بدأ تحميل من ${okCount} رابط${errCount ? ` (فشل ${errCount})` : ''}.`
                       : `تم جلب ${okCount} رابط${errCount ? ` (فشل ${errCount})` : ''}.`,
          errCount ? '' : 'success');
  }
}

// ── search keyword chips ──
function renderTags() {
  const list = $('#tagList');
  list.innerHTML = '';
  state.keywords.forEach((kw) => {
    const chip = el('span', 'chip');
    chip.innerHTML = `<span>${esc(kw)}</span><span class="x" title="إزالة"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
    chip.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); removeKeyword(kw); });
    list.appendChild(chip);
  });
}
function addKeyword(text) {
  splitKeywords(text).forEach((kw) => {
    const exists = state.keywords.some((k) => k.toLowerCase() === kw.toLowerCase());
    if (!exists) state.keywords.push(kw);
  });
  renderTags();
}
function removeKeyword(kw) {
  state.keywords = state.keywords.filter((k) => k !== kw);
  renderTags();
}

$('#tagInput').addEventListener('click', () => $('#searchInput').focus());

$('#searchInput').addEventListener('keydown', (e) => {
  const inp = e.target;
  if (e.key === 'Enter' || e.key === ',' || e.key === '،') {
    if (inp.value.trim()) {
      e.preventDefault();
      addKeyword(inp.value);
      inp.value = '';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  } else if (e.key === 'Backspace' && !inp.value && state.keywords.length) {
    removeKeyword(state.keywords[state.keywords.length - 1]);
  }
});

// ── search ──
$('#btnSearch').addEventListener('click', () => doSearch());

function splitKeywords(s) {
  return s.split(/[,،;\n]+/).map((x) => x.trim()).filter(Boolean);
}

async function doSearch() {
  // commit any leftover text in the box as a chip first
  const leftover = $('#searchInput').value.trim();
  if (leftover) { addKeyword(leftover); $('#searchInput').value = ''; }

  const keywords = [...state.keywords];
  if (!keywords.length) return toast('أضف كلمة واحدة على الأقل للبحث.', 'error');
  const raw = keywords.join(', ');
  const perKeyword = parseInt($('#searchDepth').value, 10) || 30;

  clearResults();
  showResults();
  $('#resultsLoading').hidden = false;
  setBtnLoading('#btnSearch', true);

  // Facebook keyword search runs through a logged-in hidden window (FB locks its API)
  if (state.platform === 'facebook' && window.electronAPI && window.electronAPI.fbSearch
      && !keywords.some((k) => /^https?:/i.test(k) || k.startsWith('@'))) {
    try {
      const seen = new Set();
      const pending = [];
      for (const kw of keywords) {
        setSearchStatus(`بحث فيسبوك: ${kw}`);
        const r = await window.electronAPI.fbSearch(kw, perKeyword);
        (r.items || []).forEach((card) => {
          if (card.id && !seen.has(card.id)) { seen.add(card.id); pending.push(card); }
        });
      }
      if (!pending.length) {
        $('#resultsLoading').hidden = true; setSearchStatus('جاري الجلب…');
        toast('لا توجد نتائج (تأكد إنك مسجّل دخول فيسبوك من الإعدادات).', '');
        setBtnLoading('#btnSearch', false);
        return;
      }
      // enrich each result with real metadata (title, views, hi-res thumbnail) in
      // small parallel batches; show each card as soon as it's ready.
      setSearchStatus(`جاري جلب تفاصيل ${pending.length} فيديو…`);
      $('#resultsLoading').hidden = true;
      const BATCH = 5;
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        await Promise.all(batch.map(async (basic) => {
          try {
            const m = await (await fetch('/api/video-meta', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: basic.url }),
            })).json();
            addResultCard(m.card && m.card.id ? { ...basic, ...m.card } : basic);
          } catch { addResultCard(basic); }
        }));
        updateResultsCount();
      }
      setSearchStatus('جاري الجلب…');
      toast(`تم جلب ${state.results.length} فيديو من فيسبوك.`, 'success');
    } catch (e) {
      $('#resultsLoading').hidden = true;
      toast('فشل بحث فيسبوك. تأكد من تسجيل الدخول.', 'error');
    } finally {
      setBtnLoading('#btnSearch', false);
    }
    return;
  }

  try {
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: state.platform, keywords, perKeyword, socketId: SOCKET_ID }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'فشل البحث.');

    if (data.streaming) return; // socket delivers items (list:item / list:done)
    $('#resultsLoading').hidden = true;
    (data.items || []).forEach(addResultCard);
    updateResultsCount();
    if (data.stale) toast('عرض نتيجة محفوظة.', 'error');
    if (!data.items || !data.items.length) toast('لا توجد نتائج.', '');
  } catch (e) {
    $('#resultsLoading').hidden = true;
    toast(e.message, 'error');
  } finally {
    setBtnLoading('#btnSearch', false);
  }
}

function setSearchStatus(msg) {
  const loading = $('#resultsLoading');
  const span = loading.querySelector('span');
  if (span) span.textContent = msg;
}

function setBtnLoading(sel, on) {
  const b = $(sel);
  if (!b) return;
  b.disabled = on;
}

// ── results rendering ──
function showResults() { $('#resultsPanel').hidden = false; }
function clearResults() {
  state.results = [];
  state.selected.clear();
  state.verdicts.clear();
  state.matchFilter = 'all';
  $('#matchFilter').value = 'all';
  $('#matchFilter').hidden = true;
  $('#resultsGrid').innerHTML = '';
  updateResultsCount();
}
function updateResultsCount() {
  $('#resultsCount').textContent = `${state.results.length} عنصر`;
  $('#selCount').textContent = state.selected.size;
  updateVerifyBtn();
}
function updateVerifyBtn() {
  const b = $('#btnVerify');
  if (b) b.hidden = !(state.productImages.length && state.results.length && !state.verifying);
  const rb = $('#btnRefImages');
  if (rb) {
    rb.hidden = !state.results.length;
    rb.querySelector('span').textContent = state.productImages.length || '';
  }
  const rc = $('#btnRefClear');
  if (rc) rc.hidden = !(state.results.length && state.productImages.length);
}

function buildCard(card, idx) {
  const platformIcons = {
    tiktok: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M23 12s0-3.5-.46-5.2a3 3 0 0 0-2.1-2.1C18.7 4.2 12 4.2 12 4.2s-6.7 0-8.44.5A3 3 0 0 0 1.46 6.8C1 8.5 1 12 1 12s0 3.5.46 5.2a3 3 0 0 0 2.1 2.1c1.74.5 8.44.5 8.44.5s6.7 0 8.44-.5a3 3 0 0 0 2.1-2.1C23 15.5 23 12 23 12zM9.75 15.5v-7l6 3.5z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>',
  };

  const c = el('div', 'card');
  c.dataset.idx = idx;
  if (state.selected.has(idx)) c.classList.add('selected');
  const thumb = card.thumbnail ? `<img src="${proxy(card.thumbnail)}" loading="lazy" onerror="this.style.display='none';this.parentElement.querySelector('.ph')?.removeAttribute('hidden')">` : '';
  const meta = [card.author && esc(card.author), card.views && (fmtViews(card.views) + ' مشاهدة')].filter(Boolean).join(' · ');

  c.innerHTML = `
    <div class="card-thumb">
      ${thumb}
      <div class="ph" ${card.thumbnail ? 'hidden' : ''}>
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <div class="card-check"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="card-platform ${card.platform || 'tiktok'}">${platformIcons[card.platform] || ''}</div>
      ${card.duration ? `<div class="card-dur">${fmtDur(card.duration)}</div>` : ''}
      ${verdictBadgeHtml(card)}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(card.title)}</div>
      ${meta ? `<div class="card-meta">${meta}</div>` : ''}
      <div class="card-actions">
        <button class="card-btn act-info" title="معلومات"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
        <button class="card-btn act-mp3" title="تحميل صوت MP3"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></button>
        <button class="card-btn dl act-dl"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> تحميل</button>
      </div>
    </div>`;

  // hover preview: play the video (with sound) inside the thumb
  const previewSrc = (card.play || card.hdplay) ? proxy(card.play || card.hdplay) : '';
  if (previewSrc) {
    const thumbEl = c.querySelector('.card-thumb');
    thumbEl.addEventListener('mouseenter', () => startPreview(thumbEl, previewSrc));
    thumbEl.addEventListener('mouseleave', stopPreview);
  }

  c.querySelector('.card-check').addEventListener('click', () => toggleSelect(idx, c));
  c.querySelector('.act-dl').addEventListener('click', () => startDownload(card, 'video'));
  c.querySelector('.act-mp3').addEventListener('click', () => startDownload(card, 'mp3'));
  c.querySelector('.act-info').addEventListener('click', () => showInfo(card));
  // "unsure" and "no match" badges are clickable → manual deep re-check (frames)
  const badge = c.querySelector('.card-verdict.v-unsure, .card-verdict.v-nomatch');
  if (badge) badge.addEventListener('click', () => startVerify([card], { deep: true, single: true, deepOnly: true }));
  return c;
}

// verdict badge (labels are fixed strings; reason is escaped into the tooltip)
function verdictBadgeHtml(card) {
  const v = state.verdicts.get(String(card.id));
  if (!v) return '';
  const labels = {
    match: 'مطابق ✓',
    no_match: 'غير مطابق — إعادة فحص؟',
    unsure: 'غير متأكد — فحص عميق؟',
    checking: '⏳ جاري الفحص…',
  };
  const cls = { match: 'v-match', no_match: 'v-nomatch', unsure: 'v-unsure', checking: 'v-checking' };
  if (!labels[v.verdict]) return '';
  return `<div class="card-verdict ${cls[v.verdict]}" title="${esc(v.reason || '')}">${labels[v.verdict]}</div>`;
}

// ── hover preview (one at a time; created on enter, torn down on leave) ──
let _previewEl = null;
let _previewTimer = null;

function stopPreview() {
  clearTimeout(_previewTimer);
  _previewTimer = null;
  if (_previewEl) {
    try { _previewEl.pause(); } catch {}
    _previewEl.removeAttribute('src');
    _previewEl.remove();
    _previewEl = null;
  }
}

function startPreview(thumbEl, src) {
  stopPreview();
  // small delay so skimming the grid doesn't spawn players
  _previewTimer = setTimeout(() => {
    const v = document.createElement('video');
    v.className = 'card-preview';
    v.src = src;
    v.loop = true;
    v.playsInline = true;
    v.volume = 0.85;
    v.addEventListener('error', () => { if (_previewEl === v) stopPreview(); });
    thumbEl.appendChild(v);
    _previewEl = v;
    v.play().catch(() => {}); // if autoplay-with-sound is blocked, stay on the thumbnail
  }, 180);
}

// display order: insertion order, or by views (desc) when sorting is on
function displayOrder() {
  let idxs = state.results.map((_, i) => i);
  if (state.matchFilter === 'match') {
    idxs = idxs.filter((i) => {
      const v = state.verdicts.get(String(state.results[i].id));
      return v && v.verdict === 'match';
    });
  }
  if (state.sortMode === 'views') {
    idxs.sort((a, b) => (state.results[b].views || 0) - (state.results[a].views || 0));
  }
  return idxs;
}
function renderAll() {
  stopPreview(); // a detached <video> would keep playing audio otherwise
  const grid = $('#resultsGrid');
  grid.innerHTML = '';
  displayOrder().forEach((i) => grid.appendChild(buildCard(state.results[i], i)));
  updateResultsCount();
}
let _renderTimer;
function scheduleRender() { clearTimeout(_renderTimer); _renderTimer = setTimeout(renderAll, 120); }

function addResultCard(card) {
  const idx = state.results.length;
  state.results.push(card);
  if (state.sortMode === 'views' || state.matchFilter !== 'all') {
    scheduleRender(); // re-sort / re-filter as items stream in
  } else {
    $('#resultsGrid').appendChild(buildCard(card, idx));
    updateResultsCount();
  }
}

function toggleSelect(idx, cardEl) {
  if (state.selected.has(idx)) { state.selected.delete(idx); cardEl.classList.remove('selected'); }
  else { state.selected.add(idx); cardEl.classList.add('selected'); }
  updateResultsCount();
}

function showInfo(card) {
  const lines = [
    card.title,
    card.author ? `الحساب: ${card.author}` : '',
    card.views ? `المشاهدات: ${fmtViews(card.views)}` : '',
    card.duration ? `المدة: ${fmtDur(card.duration)}` : '',
  ].filter(Boolean).join('\n');
  toast(lines || 'لا توجد معلومات.', '');
}

// ── sort ──
$('#sortSelect').addEventListener('change', (e) => {
  state.sortMode = e.target.value;
  renderAll();
});

// ── visual verification (product images vs results) ──
const VERIFY_MAX_UI = 24;
const REF_IMAGES_MAX_UI = 4;

// read picked files into state.productImages (base64), capped
async function addRefImageFiles(files) {
  for (const file of Array.from(files || [])) {
    if (state.productImages.length >= REF_IMAGES_MAX_UI) {
      toast(`أقصى عدد صور مرجعية: ${REF_IMAGES_MAX_UI}.`, '');
      break;
    }
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (m) state.productImages.push({ base64: m[2], mediaType: m[1] });
  }
  updateVerifyBtn();
  if (state.productImages.length) toast(`صور المنتج المرجعية: ${state.productImages.length}.`, 'success');
}

async function startVerify(cards, { deep = true, single = false, deepOnly = false } = {}) {
  if (!state.productImages.length) return toast('أضف صورة المنتج أولاً بزر «صور المنتج» أو «بحث بصورة».', 'error');
  if (!cards.length) return toast('لا توجد نتائج للتحقق منها.', 'error');
  if (state.verifying) return toast('التحقق شغال بالفعل…', '');

  state.verifying = true;
  updateVerifyBtn();
  cards.forEach((c) => state.verdicts.set(String(c.id), { verdict: 'checking', reason: '' }));
  scheduleRender();

  try {
    const r = await fetch('/api/ai/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: state.productImages,
        cards: cards.map((c) => ({
          id: c.id, platform: c.platform, url: c.url,
          title: c.title, thumbnail: c.thumbnail, duration: c.duration,
        })),
        deep,
        deepOnly,
        socketId: SOCKET_ID,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'فشل بدء التحقق.');
    if (!single) toast(`بدأ التحقق من ${data.count} فيديو…`, '');
  } catch (e) {
    state.verifying = false;
    cards.forEach((c) => {
      const v = state.verdicts.get(String(c.id));
      if (v && v.verdict === 'checking') state.verdicts.delete(String(c.id));
    });
    updateVerifyBtn();
    scheduleRender();
    toast(e.message, 'error');
  }
}

$('#btnVerify').addEventListener('click', () => {
  const cards = displayOrder().map((i) => state.results[i]).slice(0, VERIFY_MAX_UI);
  startVerify(cards, { deep: true });
});

$('#btnRefImages').addEventListener('click', () => $('#refImagesInput').click());
$('#refImagesInput').addEventListener('change', async (e) => {
  const files = e.target.files;
  e.target.value = '';
  await addRefImageFiles(files);
});
$('#btnRefClear').addEventListener('click', () => {
  state.productImages = [];
  updateVerifyBtn();
  toast('تم مسح الصور المرجعية.', '');
});

$('#matchFilter').addEventListener('change', (e) => {
  state.matchFilter = e.target.value;
  renderAll();
});

socket.on('verify:item', ({ id, verdict, reason, stage }) => {
  state.verdicts.set(String(id), { verdict, reason: reason || '', stage });
  scheduleRender();
});
socket.on('verify:done', ({ counts }) => {
  state.verifying = false;
  updateVerifyBtn();
  $('#matchFilter').hidden = false;
  const c = counts || {};
  toast(`خلص التحقق — مطابق: ${c.match || 0} · غير مطابق: ${c.no_match || 0} · غير متأكد: ${c.unsure || 0}`, 'success');
});
socket.on('verify:error', ({ message }) => {
  state.verifying = false;
  updateVerifyBtn();
  toast(message || 'فشل التحقق.', 'error');
});

// ── results bulk actions ──
$('#btnSelectAll').addEventListener('click', () => {
  state.results.forEach((_, i) => state.selected.add(i));
  $$('.card').forEach((c) => c.classList.add('selected'));
  updateResultsCount();
});
$('#btnDeselectAll').addEventListener('click', () => {
  state.selected.clear();
  $$('.card').forEach((c) => c.classList.remove('selected'));
  updateResultsCount();
});
$('#btnDownloadSelected').addEventListener('click', () => {
  if (!state.selected.size) return toast('لم تحدّد أي عنصر.', '');
  [...state.selected].forEach((i) => startDownload(state.results[i], 'video'));
});
$('#btnDownloadAll').addEventListener('click', () => {
  if (!state.results.length) return toast('لا توجد نتائج للتحميل.', '');
  state.results.forEach((card) => startDownload(card, 'video'));
});

// ── downloads / queue ──
async function startDownload(card, format) {
  try {
    const r = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: card, format, socketId: SOCKET_ID }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'فشل بدء التنزيل.');
    addQueueItem(data.id, card, format);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function addQueueItem(id, card, format) {
  $('#queueEmpty').hidden = true;
  const item = el('div', 'q-item');
  item.dataset.id = id;
  const fmtLabel = format === 'mp3' ? ' (MP3)' : '';
  item.innerHTML = `
    <img class="q-thumb" src="${proxy(card.thumbnail)}" onerror="this.style.visibility='hidden'">
    <div class="q-main">
      <div class="q-top">
        <span class="q-title">${esc(card.title)}${fmtLabel}</span>
        <span class="q-status starting">في الانتظار…</span>
      </div>
      <div class="q-bar"><div class="q-fill"></div></div>
      <div class="q-info"><span class="q-pct">0%</span><span class="q-speed"></span></div>
    </div>
    <div class="q-actions">
      <button class="card-btn act-open" title="فتح المجلد" hidden><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
      <button class="card-btn act-remove" title="إزالة"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`;
  item.querySelector('.act-remove').addEventListener('click', () => {
    item.remove();
    state.queue.delete(id);
    if (!$('#queueList').children.length) $('#queueEmpty').hidden = false;
  });
  item.querySelector('.act-open').addEventListener('click', () => {
    const fp = state.queue.get(id)?.filePath;
    if (window.electronAPI && fp) window.electronAPI.showItem(fp);
    else toast('الملف في: ' + (DOWNLOAD_DIR || 'مجلد التنزيلات'), '');
  });
  $('#queueList').prepend(item);
  state.queue.set(id, { card, format, el: item });
}

const STATUS_TEXT = {
  starting: 'بدء…', queued: 'في الانتظار…', downloading: 'جاري التنزيل',
  converting: 'تحويل الصوت…', completed: 'اكتمل ✓', error: 'فشل',
};

function updateQueue(d) {
  const q = state.queue.get(d.id);
  if (!q) return;
  const item = q.el;
  const statusEl = item.querySelector('.q-status');
  const fill = item.querySelector('.q-fill');
  const pct = item.querySelector('.q-pct');
  const speed = item.querySelector('.q-speed');

  statusEl.className = 'q-status ' + d.status;
  statusEl.textContent = STATUS_TEXT[d.status] || d.status;

  if (typeof d.progress === 'number') {
    fill.style.width = Math.max(0, Math.min(100, d.progress)) + '%';
    pct.textContent = Math.round(d.progress) + '%';
  }
  speed.textContent = [d.speed, d.eta && ('باقي ' + d.eta)].filter(Boolean).join(' · ');

  if (d.status === 'completed') {
    fill.classList.add('done'); fill.style.width = '100%'; pct.textContent = '100%';
    speed.textContent = d.fileName || '';
    item.querySelector('.act-open').hidden = false;
    q.filePath = d.filePath;
    toast('اكتمل التنزيل: ' + (d.fileName || d.title || ''), 'success');
  }
  if (d.status === 'error') {
    fill.classList.add('err');
    speed.textContent = d.error || '';
    toast(d.error || 'فشل التنزيل.', 'error');
  }
}

$('#btnClearCompleted').addEventListener('click', () => {
  $$('.q-item').forEach((it) => {
    const st = it.querySelector('.q-status');
    if (st.classList.contains('completed') || st.classList.contains('error')) {
      state.queue.delete(it.dataset.id);
      it.remove();
    }
  });
  if (!$('#queueList').children.length) $('#queueEmpty').hidden = false;
});

// ── settings modal ──
const modal = $('#settingsModal');
async function openSettings() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    $('#setDownloadDir').value = cfg.downloadDir || '';
    $('#setQuality').value = cfg.videoQuality || 'best';
    $('#setCookies').value = cfg.cookiesBrowser || 'none';
    DOWNLOAD_DIR = cfg.downloadDir || DOWNLOAD_DIR;
    $('#appVersion').textContent = cfg.appVersion || '1.0.0';
    $('#setWinUrl').value = cfg.downloadWinUrl || '';
    $('#setMacUrl').value = cfg.downloadMacUrl || '';
  } catch {}
  refreshAccountStatus();
  refreshAIStatus();
  modal.hidden = false;
}
function closeSettings() { modal.hidden = true; }

$('#btnSettings').addEventListener('click', openSettings);
$('#btnCloseSettings').addEventListener('click', closeSettings);
$('#btnCancelSettings').addEventListener('click', closeSettings);
modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });

// ── in-app accounts (login / logout) ──
async function refreshAccountStatus() {
  // show "checking" while we verify real session validity
  $('#igStatus').textContent = 'جاري التحقق…'; $('#igStatus').classList.remove('on');
  let status = { instagram: false, instagramHasFile: false, facebook: false };
  try {
    // always use the server endpoint — it verifies the session is actually valid
    status = await (await fetch('/api/cookies-status')).json();
  } catch {}
  setAcc('instagram', '#igStatus', status.instagram, status.instagramHasFile);
  setAcc('facebook', '#fbStatus', status.facebook, status.facebookHasFile);
}
function setAcc(platform, statusSel, valid, hasFile) {
  const s = $(statusSel);
  if (valid) { s.textContent = 'مسجّل ✓'; s.classList.add('on'); }
  else if (hasFile) { s.textContent = 'الجلسة انتهت — سجّل دخول'; s.classList.remove('on'); }
  else { s.textContent = 'غير مسجّل'; s.classList.remove('on'); }
  const loginBtn = document.querySelector(`[data-login="${platform}"]`);
  const logoutBtn = document.querySelector(`[data-logout="${platform}"]`);
  if (loginBtn) loginBtn.hidden = valid;       // show login when not valid (even if expired)
  if (logoutBtn) logoutBtn.hidden = !hasFile;  // allow clearing a stored (even expired) session
}

document.querySelectorAll('[data-login]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const platform = btn.dataset.login;
    if (!window.electronAPI || !window.electronAPI.loginPlatform) {
      return toast('تسجيل الدخول المدمج متاح في تطبيق سطح المكتب فقط.', 'error');
    }
    toast('افتح النافذة وسجّل دخولك… (هتتقفل تلقائياً بعد الدخول)', '');
    try {
      const r = await window.electronAPI.loginPlatform(platform);
      if (r && r.loggedIn) toast('تم تسجيل الدخول بنجاح ✓', 'success');
      else if (r && r.count) toast('تم حفظ الجلسة. لو مش اشتغل، أعد تسجيل الدخول.', '');
      else toast('لم يكتمل تسجيل الدخول.', 'error');
    } catch (e) { toast('فشل تسجيل الدخول.', 'error'); }
    refreshAccountStatus();
  });
});
document.querySelectorAll('[data-logout]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const platform = btn.dataset.logout;
    try { if (window.electronAPI) await window.electronAPI.logoutPlatform(platform); } catch {}
    toast('تم تسجيل الخروج.', '');
    refreshAccountStatus();
  });
});

$('#btnChooseDir').addEventListener('click', async () => {
  if (window.electronAPI && window.electronAPI.chooseFolder) {
    const dir = await window.electronAPI.chooseFolder();
    if (dir) $('#setDownloadDir').value = dir;
  } else {
    const dir = prompt('مسار مجلد التنزيل:', $('#setDownloadDir').value);
    if (dir) $('#setDownloadDir').value = dir;
  }
});

$('#btnSaveSettings').addEventListener('click', async () => {
  const body = {
    downloadDir: $('#setDownloadDir').value.trim(),
    videoQuality: $('#setQuality').value,
    cookiesBrowser: $('#setCookies').value,
    downloadWinUrl: $('#setWinUrl').value.trim(),
    downloadMacUrl: $('#setMacUrl').value.trim(),
  };
  try {
    const cfg = await (await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    DOWNLOAD_DIR = cfg.downloadDir || DOWNLOAD_DIR;
    closeSettings();
    toast('تم حفظ الإعدادات.', 'success');
  } catch (e) {
    toast('فشل حفظ الإعدادات.', 'error');
  }
});

// ── Claude API (image → keywords) ──
let AI_CONNECTED = false;

function renderModels(models, selected) {
  const sel = $('#setModel');
  sel.innerHTML = '';
  (models || []).forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name || m.id;
    if (m.id === selected) o.selected = true;
    sel.appendChild(o);
  });
}
function setAIConnected(on) {
  AI_CONNECTED = on;
  $('#claudeStatusRow').hidden = !on;
  $('#modelField').hidden = !on;
  $('#setApiKey').parentElement.hidden = on; // hide key input row once connected
}

async function refreshAIStatus() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.hasApiKey) {
      setAIConnected(true);
      // load models for the dropdown
      try {
        const r = await (await fetch('/api/ai/models')).json();
        if (r.models) renderModels(r.models, r.selected || cfg.anthropicModel);
      } catch {}
    } else {
      setAIConnected(false);
    }
  } catch {}
}

$('#btnConnectAI').addEventListener('click', async () => {
  const apiKey = $('#setApiKey').value.trim();
  if (!apiKey) return toast('أدخل مفتاح Claude API.', 'error');
  $('#btnConnectAI').disabled = true;
  $('#btnConnectAI').textContent = 'جاري الربط…';
  try {
    const r = await fetch('/api/ai/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'فشل الربط.');
    renderModels(data.models, data.selected);
    setAIConnected(true);
    $('#setApiKey').value = '';
    toast('تم ربط Claude ✓ (الموديل: ' + data.selected + ')', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('#btnConnectAI').disabled = false;
    $('#btnConnectAI').textContent = 'ربط';
  }
});

$('#btnDisconnectAI').addEventListener('click', async () => {
  try { await fetch('/api/ai/disconnect', { method: 'POST' }); } catch {}
  setAIConnected(false);
  toast('تم فصل Claude.', '');
});

$('#setModel').addEventListener('change', async () => {
  const model = $('#setModel').value;
  try {
    await fetch('/api/ai/model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    });
    toast('تم اختيار الموديل: ' + model, 'success');
  } catch { toast('فشل حفظ الموديل.', 'error'); }
});

// ── download / update buttons ──
function openDownload(sel, platformName) {
  const url = $(sel).value.trim();
  if (!url) return toast(`لم يُضبط رابط نسخة ${platformName} بعد (افتح «روابط التحميل» وحطّ الرابط).`, '');
  if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
  else window.open(url, '_blank');
}
$('#btnDlWin').addEventListener('click', () => openDownload('#setWinUrl', 'ويندوز'));
$('#btnDlMac').addEventListener('click', () => openDownload('#setMacUrl', 'ماك'));

// ── image search (Claude vision → keywords) ──
$('#btnImageSearch').addEventListener('click', () => $('#imageFileInput').click());

$('#imageFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking same file
  if (!file) return;

  const btn = $('#btnImageSearch');
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '⏳ جاري التحليل…';
  try {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('صورة غير صالحة.');
    const r = await fetch('/api/ai/keywords', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: m[2], mediaType: m[1], platform: state.platform }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'فشل تحليل الصورة.');
    if (!data.keywords || !data.keywords.length) { toast('لم يتم استخراج كلمات من الصورة.', ''); return; }
    // seed the verification references with this image if none were added yet
    if (!state.productImages.length) {
      state.productImages.push({ base64: m[2], mediaType: m[1] });
      updateVerifyBtn();
    }
    data.keywords.forEach((kw) => addKeyword(kw));
    const desc = data.product ? `${data.product} · ` : '';
    toast(`${desc}تم توليد ${data.keywords.length} كلمة (إنجليزي/عربي/صيني) — عدّلها ثم اضغط Search.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
});

// ── auto-update notifications ──
if (window.electronAPI && window.electronAPI.onUpdateStatus) {
  window.electronAPI.onUpdateStatus((d) => {
    if (d.state === 'available') toast(`تحديث جديد (${d.version}) — جاري التنزيل…`, '');
    else if (d.state === 'downloading') setConn('online', `Connected · تحديث ${d.percent}%`);
    else if (d.state === 'downloaded') toast(`التحديث ${d.version} جاهز — هيتثبّت عند إعادة التشغيل.`, 'success');
  });
}

// ── other top icon buttons ──
$('#btnHistory').addEventListener('click', () => toast('السجل: قريباً.', ''));
$('#btnSaved').addEventListener('click', () => toast('المحفوظات: قريباً.', ''));
$('#btnStats').addEventListener('click', () => toast(`النتائج: ${state.results.length} · التنزيلات: ${state.queue.size}`, ''));
