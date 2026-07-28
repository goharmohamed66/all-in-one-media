// Live E2E for /api/ai/verify — run with the dev server up:
//   PORT=3457 node server/server.js
//   node scripts/e2e-verify-live.mjs <image-path> <tiktok-url...>
// Builds cards via /api/info, starts verification, prints streamed verdicts.
import { io } from 'socket.io-client';
import fs from 'node:fs';

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:3457';
const [imagePath, ...urls] = process.argv.slice(2);
if (!imagePath || !urls.length) {
  console.error('usage: node scripts/e2e-verify-live.mjs <image> <url...>');
  process.exit(2);
}

const imageBase64 = fs.readFileSync(imagePath).toString('base64');
const mediaType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

const socket = io(BASE, { transports: ['websocket'] });
await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
console.log('socket connected:', socket.id);

const cards = [];
for (const url of urls) {
  const r = await fetch(`${BASE}/api/info`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await r.json();
  if (!r.ok || !data.items || !data.items.length) {
    console.error('info FAILED for', url, data.error || data);
    continue;
  }
  cards.push(data.items[0]);
  console.log('card:', data.items[0].id, '-', (data.items[0].title || '').slice(0, 50));
}
if (!cards.length) { console.error('no cards'); process.exit(1); }

const done = new Promise((resolve) => {
  socket.on('verify:item', (d) => console.log(`  verdict [${d.stage}] ${d.id}: ${d.verdict}${d.reason ? ' — ' + d.reason : ''}`));
  socket.on('verify:done', (d) => { console.log('DONE:', JSON.stringify(d.counts)); resolve(d); });
  socket.on('verify:error', (d) => { console.error('VERIFY ERROR:', d.message); resolve(d); });
});

const vr = await fetch(`${BASE}/api/ai/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64, mediaType, cards, deep: true, socketId: socket.id }),
});
const vdata = await vr.json();
if (!vr.ok) { console.error('verify start FAILED:', vdata.error); process.exit(1); }
console.log('verify started for', vdata.count, 'cards…');

await done;
socket.close();
