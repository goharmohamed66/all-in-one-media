# MediaGrab — Media Downloader

تطبيق سطح مكتب (Windows + macOS) لتحميل الفيديوهات من **TikTok / YouTube / Instagram / Facebook**،
مبني على Electron + سيرفر Node محلي (Express + Socket.IO) + yt-dlp + ffmpeg + TikWM.

## المعمارية
- **Electron Main** (`main.js`) — يشغّل السيرفر كـ child process ويفتح النافذة على `http://127.0.0.1:3456`.
- **Node Server** (`server/server.js`) — كل الـ routes: المعلومات، البحث، التنزيل، والـ media proxy. يشغّل yt-dlp و ffmpeg ويكلّم TikWM.
- **Frontend** (`server/public/`) — الواجهة، تتواصل بـ HTTP REST + Socket.IO (للتقدّم والبث الحي).

## المحركات
| المحرّك | الاستخدام |
|--------|-----------|
| `yt-dlp` | يوتيوب (الكل)، بروفايل تيك توك كامل، تنزيل إنستجرام/فيسبوك |
| `TikWM` | فيديو تيك توك الفردي (بدون علامة مائية) + البحث بالكلمات |
| Media Proxy | عرض صور/فيديو الـ CDN عبر انتحال الـ Referer الصحيح |

## التشغيل (تطوير)
```bash
npm install        # يثبّت كل شيء + ينزّل yt-dlp تلقائياً
npm start          # يشغّل التطبيق (Electron)
```
- لتشغيل السيرفر فقط في المتصفح: `npm run server` ثم افتح `http://127.0.0.1:3456`.
- مجلد التنزيل الافتراضي: `~/Downloads/MediaGrab` (يمكن تغييره بمتغيّر البيئة `MEDIAGRAB_DOWNLOADS`).

## التشغيل على ماك (macOS)
التطبيق cross-platform بالكامل. على ماك:
```bash
npm install     # ينزّل تلقائياً yt-dlp_macos + ffmpeg الخاص بماك
npm start       # يشغّل التطبيق
```
- لو ظهر خطأ "yt-dlp cannot be opened" أول مرة، شغّل:
  `xattr -dr com.apple.quarantine bin/yt-dlp`
- لتسجيل دخول إنستجرام/فيسبوك: نفس الطريقة (الإعدادات → الحسابات)، أو اختر **Safari** من خيار الكوكيز.

## البناء (تطبيق مثبَّت)
```bash
npm run build:win    # Windows (.exe / NSIS installer) — يُبنى على ويندوز
npm run build:mac    # macOS (.dmg) — لازم يُبنى على جهاز ماك
```
**مهم:**
- بناء نسخة ماك (`.dmg`) **لازم يتم على جهاز ماك** — مينفعش من ويندوز.
- النسخة المبنية غير موقّعة (unsigned)؛ أول تشغيل: كليك يمين على التطبيق → Open، ولو لزم: `xattr -cr "/Applications/MediaGrab.app"`.
- البناء بيكون لمعمارية الجهاز نفسه (Apple Silicon أو Intel) لأن `ffmpeg-static` ينزّل حسب الجهاز — ابنِ على نفس نوع الماك المستهدَف.

## ملاحظات
- `yt-dlp` يُنزَّل تلقائياً في `bin/` عند `npm install` (نسخة ويندوز أو ماك حسب النظام). لو فشل، نزّله يدوياً هناك.
- `ffmpeg` يأتي من حزمة `ffmpeg-static` (cross-platform).
- مفتاح Claude والجلسات تُخزَّن في `~/.mediagrab/` (نفس المكان على ويندوز وماك).
- نظام الترخيص (License) غير مفعّل في هذه النسخة.

استخدم التطبيق لتحميل المحتوى المسموح لك بتحميله فقط.
