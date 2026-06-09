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

// Path to yt-dlp binary
const YTDLP_PATH = path.join(__dirname, "bin", "yt-dlp");

// Ensure bin dir exists
if (!fs.existsSync(path.join(__dirname, "bin"))) {
  fs.mkdirSync(path.join(__dirname, "bin"));
}

// Download yt-dlp binary on startup if not present
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    console.log("yt-dlp already present");
    return;
  }
  console.log("Downloading yt-dlp...");
  await new Promise((resolve, reject) => {
    exec(
      `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}" && chmod +x "${YTDLP_PATH}"`,
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
  console.log("yt-dlp downloaded");
}

// Helper: run yt-dlp with args, return stdout
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// GET /api/info?url=...
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  // Basic YouTube URL validation
  if (!/youtube\.com|youtu\.be/.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs are supported" });
  }

  try {
    const raw = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);
    const info = JSON.parse(raw);

    // Collect available video formats (with both video+audio or video-only)
    const videoFormats = [];
    const seenRes = new Set();

    // Best combined formats by resolution
    const resolutions = [
      { label: "4K (2160p)", height: 2160 },
      { label: "1440p", height: 1440 },
      { label: "1080p", height: 1080 },
      { label: "720p", height: 720 },
      { label: "480p", height: 480 },
      { label: "360p", height: 360 },
    ];

    for (const res of resolutions) {
      const match = info.formats
        .filter(
          (f) =>
            f.height === res.height &&
            f.vcodec !== "none"
        )
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

      if (match && !seenRes.has(res.height)) {
        seenRes.add(res.height);
        videoFormats.push({
          id: match.format_id,
          label: res.label,
          ext: match.ext,
          height: res.height,
          hasAudio: match.acodec !== "none",
        });
      }
    }

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration_string || formatDuration(info.duration),
      channel: info.channel || info.uploader,
      videoFormats,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Could not fetch video info. Make sure the video is public." });
  }
});

// POST /api/download  { url, type, formatId }
// type: "video" | "audio"
app.post("/api/download", async (req, res) => {
  const { url, type, formatId } = req.body;
  if (!url || !type) return res.status(400).json({ error: "url and type required" });

  if (!/youtube\.com|youtu\.be/.test(url)) {
    return res.status(400).json({ error: "Only YouTube URLs are supported" });
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ytgrab_${Date.now()}`);

  try {
    let args;
    let contentType;
    let ext;

    if (type === "audio") {
      ext = "mp3";
      contentType = "audio/mpeg";
      args = [
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--no-playlist",
        "--no-warnings",
        "-o", `${tmpFile}.%(ext)s`,
        url,
      ];
    } else {
      // Video — merge best video + best audio
      ext = "mp4";
      contentType = "video/mp4";
      let formatSpec;
      if (formatId) {
        // If selected format has no audio, merge with best audio
        formatSpec = `${formatId}+bestaudio[ext=m4a]/bestaudio/${formatId}`;
      } else {
        formatSpec = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";
      }
      args = [
        "-f", formatSpec,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--no-warnings",
        "-o", `${tmpFile}.%(ext)s`,
        url,
      ];
    }

    // Fetch video title for filename
    let title = "video";
    try {
      const infoRaw = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
      const info = JSON.parse(infoRaw);
      title = info.title.replace(/[^a-z0-9 \-_]/gi, "").trim().slice(0, 80) || "video";
    } catch (_) {}

    await new Promise((resolve, reject) => {
      execFile(YTDLP_PATH, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    const outFile = `${tmpFile}.${ext}`;
    if (!fs.existsSync(outFile)) {
      // yt-dlp might have used a different ext
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(path.basename(tmpFile)));
      if (files.length === 0) throw new Error("Output file not found");
      const actualExt = path.extname(files[0]).slice(1);
      ext = actualExt;
      contentType = ext === "mp3" ? "audio/mpeg" : "video/mp4";
    }

    const finalFile = fs.existsSync(outFile) ? outFile : `${tmpFile}.${ext}`;
    const stat = fs.statSync(finalFile);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${title}.${ext}"`
    );

    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on("close", () => {
      fs.unlink(finalFile, () => {});
    });
  } catch (err) {
    console.error(err.message);
    // Clean up temp files
    try {
      fs.readdirSync(tmpDir)
        .filter((f) => f.startsWith(`ytgrab_`))
        .forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    } catch (_) {}
    res.status(500).json({ error: "Download failed. The video may be restricted or unavailable." });
  }
});

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

app.listen(PORT, async () => {
  console.log(`YTGrab running on port ${PORT}`);
  try {
    await ensureYtDlp();
  } catch (e) {
    console.error("Failed to download yt-dlp:", e.message);
  }
});
