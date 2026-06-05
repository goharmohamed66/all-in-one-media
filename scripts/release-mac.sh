#!/usr/bin/env bash
# Build the macOS app (.dmg + zip) and publish it to GitHub Releases.
# Run this ON A MAC:   bash scripts/release-mac.sh
set -e
cd "$(dirname "$0")/.."

# get a GitHub token (needs `gh auth login` once, or set GH_TOKEN yourself)
if [ -z "$GH_TOKEN" ] && command -v gh >/dev/null 2>&1; then
  export GH_TOKEN="$(gh auth token)"
fi
if [ -z "$GH_TOKEN" ]; then
  echo "محتاج GH_TOKEN. اعمل: gh auth login   (أو) export GH_TOKEN=ghp_xxx"
  exit 1
fi

echo "==> npm install"
npm install

echo "==> building + publishing macOS"
npx electron-builder --mac --publish always

echo "✅ تم بناء ورفع نسخة الماك على GitHub Releases."
echo "   زر تحميل الماك في البرنامج هيشتغل تلقائياً، والتحديث التلقائي مفعّل."
