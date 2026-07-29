#!/usr/bin/env node
/**
 * setup-binaries.js
 * Downloads yt-dlp for the current platform into ./bin
 * ffmpeg is provided by the ffmpeg-static npm package (no download needed here).
 * Safe to run multiple times — skips files that already exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function ytdlpTarget() {
  const p = process.platform;
  if (p === 'win32') {
    return { file: 'yt-dlp.exe', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' };
  }
  if (p === 'darwin') {
    return { file: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos' };
  }
  // linux + others
  return { file: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp' };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'AllInOneMedia-Setup' } }, (res) => {
      // follow redirects BEFORE touching any file (avoids tmp-file races)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      // final response: now open the temp file
      const tmp = dest + '.part';
      const file = fs.createWriteStream(tmp);
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastLog = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total && Date.now() - lastLog > 400) {
          lastLog = Date.now();
          const pct = ((received / total) * 100).toFixed(0);
          process.stdout.write(`\r   ${path.basename(dest)}: ${pct}%   `);
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try { fs.renameSync(tmp, dest); }
          catch (e) { return reject(e); }
          process.stdout.write(`\r   ${path.basename(dest)}: done       \n`);
          resolve();
        });
      });
      file.on('error', (err) => { fs.rm(tmp, { force: true }, () => {}); reject(err); });
    });
    // a stalled connection must fail the setup, not hang CI forever
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

// sanity floor: a real yt-dlp binary is ~10MB+; a truncated/error-page file is not
function looksLikeRealBinary(p) {
  try { return fs.statSync(p).size > 5 * 1024 * 1024; } catch { return false; }
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const yt = ytdlpTarget();
  const ytPath = path.join(BIN_DIR, yt.file);

  if (fs.existsSync(ytPath) && looksLikeRealBinary(ytPath)) {
    console.log(`✓ yt-dlp already present (${yt.file})`);
  } else {
    if (fs.existsSync(ytPath)) {
      console.log('! existing yt-dlp looks truncated — re-downloading');
      fs.rmSync(ytPath, { force: true });
    }
    console.log(`↓ Downloading yt-dlp ...`);
    try {
      await download(yt.url, ytPath);
      if (!looksLikeRealBinary(ytPath)) throw new Error('downloaded file is suspiciously small');
      if (process.platform !== 'win32') fs.chmodSync(ytPath, 0o755);
      console.log(`✓ yt-dlp ready`);
    } catch (e) {
      console.error(`✗ Failed to download yt-dlp: ${e.message}`);
      console.error(`  You can download it manually into: ${ytPath}`);
      // shipping an installer without yt-dlp breaks every non-TikTok feature —
      // fail the build instead of packaging a broken app
      process.exitCode = 1;
    }
  }

  // ffmpeg comes from ffmpeg-static
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      console.log(`✓ ffmpeg ready (ffmpeg-static)`);
    } else {
      console.warn(`! ffmpeg-static path not found — run "npm install" again.`);
    }
  } catch {
    console.warn(`! ffmpeg-static not installed yet — it installs with "npm install".`);
  }

  console.log('\nSetup complete.');
}

main();
