# YTGrab

Download YouTube videos and audio at highest available quality.

## Features
- Video download: 4K / 1440p / 1080p / 720p / 480p / 360p (best available)
- Audio download: MP3 at best quality
- Auto-merges best video + best audio streams
- Clean, fast UI — no ads, no tracking

## Local dev

```bash
npm install
node server.js
# open http://localhost:3000
```

yt-dlp binary is auto-downloaded to `/bin/` on first start.

## Deploy on Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node
5. Click Deploy

Render's free tier works fine. First request after idle has a ~30s cold start.

## Notes
- For personal use only — respect copyright laws
- yt-dlp handles the actual downloading; keep it updated for best results
- Large videos (1080p+) may take a minute to process before downloading
