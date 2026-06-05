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
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'MediaGrab-Setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rm(tmp, { force: true }, () => {});
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rm(tmp, { force: true }, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
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
          fs.renameSync(tmp, dest);
          process.stdout.write(`\r   ${path.basename(dest)}: done       \n`);
          resolve();
        });
      });
    });
    req.on('error', (err) => {
      file.close();
      fs.rm(tmp, { force: true }, () => {});
      reject(err);
    });
  });
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const yt = ytdlpTarget();
  const ytPath = path.join(BIN_DIR, yt.file);

  if (fs.existsSync(ytPath)) {
    console.log(`✓ yt-dlp already present (${yt.file})`);
  } else {
    console.log(`↓ Downloading yt-dlp ...`);
    try {
      await download(yt.url, ytPath);
      if (process.platform !== 'win32') fs.chmodSync(ytPath, 0o755);
      console.log(`✓ yt-dlp ready`);
    } catch (e) {
      console.error(`✗ Failed to download yt-dlp: ${e.message}`);
      console.error(`  You can download it manually into: ${ytPath}`);
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
