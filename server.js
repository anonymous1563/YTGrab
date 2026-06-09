const express = require("express");
const cors = require("cors");
const path = require("path");
const { execFile, exec } = require("child_process");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BIN_DIR = path.join(__dirname, "bin");
const YTDLP_PATH = path.join(BIN_DIR, "yt-dlp");

let ytdlpReady = false;

// ── Ensure yt-dlp binary ──────────────────────────────────────────────────────
async function ensureYtDlp() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  if (fs.existsSync(YTDLP_PATH)) {
    console.log("[ytgrab] yt-dlp found, updating to latest...");
    // Update silently; ignore errors
    await new Promise((res) => {
      exec(`"${YTDLP_PATH}" -U 2>&1`, { timeout: 30000 }, () => res());
    });
    ytdlpReady = true;
    return;
  }

  console.log("[ytgrab] Downloading yt-dlp binary...");
  await new Promise((resolve, reject) => {
    exec(
      `curl -L --retry 3 --retry-delay 2 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${YTDLP_PATH}" && chmod +x "${YTDLP_PATH}"`,
      { timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[ytgrab] curl failed:", stderr);
          reject(err);
        } else {
          console.log("[ytgrab] yt-dlp downloaded OK");
          resolve();
        }
      }
    );
  });
  ytdlpReady = true;
}

// ── Run yt-dlp with timeout ───────────────────────────────────────────────────
function runYtDlp(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!ytdlpReady) return reject(new Error("yt-dlp not ready yet, please retry in a moment"));
    execFile(
      YTDLP_PATH,
      args,
      { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          // Log real error for debugging
          console.error("[ytgrab] yt-dlp error:", stderr || err.message);
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ready: ytdlpReady, ytdlpPath: YTDLP_PATH, exists: fs.existsSync(YTDLP_PATH) });
});

// ── GET /api/info?url=... ─────────────────────────────────────────────────────
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  if (!/youtube\.com\/|youtu\.be\//.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs are supported" });
  }

  if (!ytdlpReady) {
    return res.status(503).json({ error: "Server is still starting up, please retry in a few seconds" });
  }

  try {
    const raw = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--flat-playlist",
      url,
    ], 45000);

    let info;
    try {
      info = JSON.parse(raw);
    } catch (parseErr) {
      console.error("[ytgrab] JSON parse fail. Raw output:", raw.slice(0, 500));
      return res.status(500).json({ error: "Failed to parse video info" });
    }

    const resolutions = [
      { label: "4K (2160p)", height: 2160 },
      { label: "1440p",      height: 1440 },
      { label: "1080p",      height: 1080 },
      { label: "720p",       height: 720  },
      { label: "480p",       height: 480  },
      { label: "360p",       height: 360  },
    ];

    const seenRes = new Set();
    const videoFormats = [];

    for (const res of resolutions) {
      const match = (info.formats || [])
        .filter((f) => f.height === res.height && f.vcodec && f.vcodec !== "none")
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

      if (match && !seenRes.has(res.height)) {
        seenRes.add(res.height);
        videoFormats.push({
          id: match.format_id,
          label: res.label,
          ext: match.ext,
          height: res.height,
          hasAudio: match.acodec && match.acodec !== "none",
        });
      }
    }

    // Fallback: if no formats parsed, still show best option
    if (videoFormats.length === 0) {
      videoFormats.push({ id: "bestvideo", label: "Best available", ext: "mp4", height: 0, hasAudio: false });
    }

    return res.json({
      title: info.title || "Unknown title",
      thumbnail: info.thumbnail || "",
      duration: info.duration_string || formatDuration(info.duration),
      channel: info.channel || info.uploader || "Unknown",
      videoFormats,
    });
  } catch (err) {
    const msg = err.message || "";
    let friendly = "Could not fetch video info.";
    if (msg.includes("Private video"))       friendly = "This video is private.";
    else if (msg.includes("not available"))  friendly = "This video is not available in your region.";
    else if (msg.includes("removed"))        friendly = "This video has been removed.";
    else if (msg.includes("Sign in"))        friendly = "This video requires sign-in and cannot be downloaded.";
    else if (msg.includes("timed out"))      friendly = "Request timed out. Try again.";
    return res.status(500).json({ error: friendly, detail: msg.slice(0, 200) });
  }
});

// ── POST /api/download ────────────────────────────────────────────────────────
app.post("/api/download", async (req, res) => {
  const { url, type, formatId } = req.body;
  if (!url || !type) return res.status(400).json({ error: "url and type required" });

  if (!/youtube\.com\/|youtu\.be\//.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs are supported" });
  }

  if (!ytdlpReady) {
    return res.status(503).json({ error: "Server still starting, retry shortly" });
  }

  const tmpFile = path.join(os.tmpdir(), `ytgrab_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  try {
    let args;
    let ext;
    let contentType;

    if (type === "audio") {
      ext = "mp3";
      contentType = "audio/mpeg";
      args = [
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "--no-playlist", "--no-warnings",
        "-o", `${tmpFile}.%(ext)s`,
        url,
      ];
    } else {
      ext = "mp4";
      contentType = "video/mp4";
      const fmtSpec = formatId
        ? `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/bestvideo+bestaudio/best`
        : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best";
      args = [
        "-f", fmtSpec,
        "--merge-output-format", "mp4",
        "--no-playlist", "--no-warnings",
        "-o", `${tmpFile}.%(ext)s`,
        url,
      ];
    }

    console.log(`[ytgrab] Starting ${type} download: ${url}`);
    await runYtDlp(args, 5 * 60 * 1000); // 5 min timeout for download

    // Find output file
    const tmpDir = os.tmpdir();
    const base = path.basename(tmpFile);
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(base));
    if (files.length === 0) throw new Error("Output file not created");

    const outFile = path.join(tmpDir, files[0]);
    const actualExt = path.extname(files[0]).slice(1) || ext;
    const stat = fs.statSync(outFile);

    // Sanitize title for filename
    let title = "video";
    try {
      const infoRaw = await runYtDlp(["--print", "title", "--no-playlist", url], 20000);
      title = infoRaw.replace(/[^\w\s\-]/g, "").trim().slice(0, 80) || "video";
    } catch (_) {}

    res.setHeader("Content-Type", actualExt === "mp3" ? "audio/mpeg" : "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${actualExt}"`);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on("close", () => { try { fs.unlinkSync(outFile); } catch (_) {} });
    stream.on("error", (e) => { console.error("[ytgrab] stream error:", e.message); });

  } catch (err) {
    console.error("[ytgrab] download error:", err.message);
    // Cleanup
    try {
      const base = path.basename(tmpFile);
      fs.readdirSync(os.tmpdir())
        .filter((f) => f.startsWith(base))
        .forEach((f) => { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} });
    } catch (_) {}
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed. The video may be restricted or age-gated." });
    }
  }
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ── Start: wait for yt-dlp before accepting requests ─────────────────────────
async function start() {
  try {
    await ensureYtDlp();
  } catch (e) {
    console.error("[ytgrab] WARN: yt-dlp setup failed:", e.message);
    console.error("[ytgrab] Server will start but /api/info will return 503 until resolved");
  }
  app.listen(PORT, () => {
    console.log(`[ytgrab] Server running on port ${PORT} | yt-dlp ready: ${ytdlpReady}`);
  });
}

start();
