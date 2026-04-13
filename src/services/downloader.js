const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const env = require("../config/env");

const execFileAsync = promisify(execFile);

let bundledFfmpegPath = null;
try {
  bundledFfmpegPath = require("@ffmpeg-installer/ffmpeg").path;
} catch (_) {
  bundledFfmpegPath = null;
}

function detectMediaTypeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const photoExt = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const videoExt = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

  if (photoExt.has(ext)) return "photo";
  if (videoExt.has(ext)) return "video";
  return "document";
}

function detectPlatform(url) {
  const lowerUrl = String(url || "").toLowerCase();

  if (lowerUrl.includes("instagram.com")) {
    return "instagram";
  }

  if (lowerUrl.includes("facebook.com") || lowerUrl.includes("fb.watch")) {
    return "facebook";
  }

  if (lowerUrl.includes("youtube.com") || lowerUrl.includes("youtu.be")) {
    return "youtube";
  }

  return "unknown";
}

async function createWorkDir() {
  const base = path.join(os.tmpdir(), "save-bot-");
  return fs.mkdtemp(base);
}

function buildYtDlpFormat(platform) {
  if (platform === "youtube") {
    return "best[height<=480][ext=mp4]/best[height<=720][ext=mp4]/best[ext=mp4]/best";
  }

  return "b[height<=480][ext=mp4]/b[height<=720][ext=mp4]/b[ext=mp4]/best";
}

async function runYtDlp(url, outputDir, options = {}) {
  const platform = options.platform || detectPlatform(url);
  const outputTemplate = "%(title).80s-%(id)s.%(ext)s";
  const ffmpegBinary = env.ffmpegBinary || bundledFfmpegPath;
  const ffmpegLocation = ffmpegBinary ? path.dirname(ffmpegBinary) : null;
  const noPlaylist = options.noPlaylist !== false;

  const args = [
    ...(noPlaylist ? ["--no-playlist"] : []),
    "--newline",
    "--force-ipv4",
    "--socket-timeout",
    "15",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--js-runtimes",
    env.ytJsRuntimes,
    "--merge-output-format",
    "mp4",
    "--format",
    buildYtDlpFormat(platform),
    "--print",
    "after_move:filepath",
    "-P",
    outputDir,
    "-o",
    outputTemplate
  ];

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  args.push(url);

  const lines = await runYtDlpWithProgress(args, {
    onProgress: options.onProgress
  });

  const filePaths = [...new Set(lines.filter((line) => line.startsWith(outputDir)))];

  if (!filePaths.length) {
    throw new Error("Could not resolve downloaded file path from yt-dlp output");
  }

  return filePaths;
}

function parseEtaToSeconds(rawEta) {
  if (!rawEta || typeof rawEta !== "string") {
    return null;
  }

  const parts = rawEta.trim().split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }

  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return null;
}

function parseYtDlpProgressLine(line) {
  if (!line || !line.includes("[download]")) {
    return null;
  }

  const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
  const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
  const speedMatch = line.match(/at\s+([^\s]+\/[a-zA-Z]+)/);

  const percent = percentMatch ? Number(percentMatch[1]) : null;
  const etaSeconds = etaMatch ? parseEtaToSeconds(etaMatch[1]) : null;
  const speed = speedMatch ? speedMatch[1] : null;

  if (percent === null && etaSeconds === null && speed === null) {
    return null;
  }

  return { percent, etaSeconds, speed };
}

function runYtDlpWithProgress(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.ytdlpBinary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const lines = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

    function flushChunk(chunk, fromStdErr = false) {
      const text = chunk.toString();
      const combined = fromStdErr ? (stderrBuffer + text) : (stdoutBuffer + text);
      const parts = combined.split(/\r?\n/);
      const remainder = parts.pop() || "";

      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;

        lines.push(line);
        const progress = parseYtDlpProgressLine(line);
        if (progress && typeof options.onProgress === "function") {
          options.onProgress(progress);
        }
      }

      if (fromStdErr) {
        stderrBuffer = remainder;
      } else {
        stdoutBuffer = remainder;
      }
    }

    child.stdout.on("data", (chunk) => flushChunk(chunk, false));
    child.stderr.on("data", (chunk) => flushChunk(chunk, true));

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const tailLines = [stdoutBuffer.trim(), stderrBuffer.trim()].filter(Boolean);
      lines.push(...tailLines);

      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }

      resolve(lines);
    });
  });
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractMetaContent(html, property) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const metaTag of metaTags) {
    const propertyMatch = metaTag.match(/property=["']([^"']+)["']/i);
    if (!propertyMatch || propertyMatch[1].trim().toLowerCase() !== property.toLowerCase()) {
      continue;
    }

    const contentMatch = metaTag.match(/content=["']([^"']+)["']/i);
    if (contentMatch) {
      return decodeHtmlEntities(contentMatch[1].trim());
    }
  }

  return null;
}

function resolveExtensionFromContentType(contentType, fallbackUrl) {
  const normalized = String(contentType || "").toLowerCase();

  if (normalized.includes("image/jpeg")) return ".jpg";
  if (normalized.includes("image/png")) return ".png";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("video/mp4")) return ".mp4";

  const pathname = new URL(fallbackUrl).pathname;
  const ext = path.extname(pathname);
  return ext || ".bin";
}

async function downloadInstagramFallback(url, outputDir) {
  const { stdout: html } = await execFileAsync(
    "curl",
    ["-sL", url],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const videoUrl =
    extractMetaContent(html, "og:video:secure_url") ||
    extractMetaContent(html, "og:video");
  const imageUrl =
    extractMetaContent(html, "og:image") ||
    extractMetaContent(html, "og:image:url");

  const fallbackUrl = videoUrl || imageUrl;
  if (!fallbackUrl) throw new Error("Instagram media metadata not found in page HTML");

  // Detect carousel: Instagram embeds carousel_media_count or thumbnail_resources in the page
  const isCarousel =
    html.includes('"carousel_media_count"') ||
    html.includes('"thumbnail_resources":[{') ||
    (html.match(/\d+ photos - /i) !== null);

  const mediaResponse = await fetch(fallbackUrl, {
    headers: {
      referer: "https://www.instagram.com/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    }
  });

  if (!mediaResponse.ok || !mediaResponse.body) {
    throw new Error(`Instagram media fetch failed with status ${mediaResponse.status}`);
  }

  const contentType = mediaResponse.headers.get("content-type") || "";
  const extension = resolveExtensionFromContentType(
    contentType,
    fallbackUrl
  );
  const outputPath = path.join(outputDir, `instagram-fallback${extension}`);

  await pipeline(mediaResponse.body, createWriteStream(outputPath));

  const mediaType =
    videoUrl || contentType.includes("video") ? "video" : "photo";

  return { filePath: outputPath, mediaType, isCarousel };
}

function sortByName(a, b) {
  return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" });
}

async function mapFilesToMediaItems(filePaths) {
  const items = [];

  for (const filePath of filePaths) {
    const stat = await fs.stat(filePath);
    items.push({
      filePath,
      fileName: path.basename(filePath),
      mediaType: detectMediaTypeFromExt(filePath),
      fileSizeBytes: stat.size
    });
  }

  return items.sort(sortByName);
}

async function downloadMedia(url, options = {}) {
  const workDir = await createWorkDir();
  const platform = detectPlatform(url);

  try {
    let mediaItems = [];
    let note = null;

    if (platform === "instagram") {
      const isReel = url.toLowerCase().includes("/reel/");
      if (isReel) {
        const reelPaths = await runYtDlp(url, workDir, {
          platform: "instagram",
          noPlaylist: true,
          onProgress: options.onProgress
        });
        mediaItems = await mapFilesToMediaItems(reelPaths);
      } else {
        try {
          const postPaths = await runYtDlp(url, workDir, {
            platform: "instagram",
            noPlaylist: false,
            onProgress: options.onProgress
          });
          mediaItems = await mapFilesToMediaItems(postPaths);
          if (mediaItems.length > 1) {
            note = `Carousel aniqlandi: ${mediaItems.length} ta media topildi.`;
          }
        } catch (_) {
          const result = await downloadInstagramFallback(url, workDir);
          const stat = await fs.stat(result.filePath);
          mediaItems = [
            {
              filePath: result.filePath,
              fileName: path.basename(result.filePath),
              mediaType: result.mediaType,
              fileSizeBytes: stat.size
            }
          ];
          if (result.isCarousel) {
            note = "Carousel postda barcha media olinmadi, birinchi media yuborildi.";
          }
        }
      }
    } else {
      const filePaths = await runYtDlp(url, workDir, {
        platform,
        noPlaylist: true,
        onProgress: options.onProgress
      });
      mediaItems = await mapFilesToMediaItems(filePaths);
    }

    if (!mediaItems.length) {
      throw new Error("Media list is empty");
    }

    const totalSize = mediaItems.reduce((acc, item) => acc + item.fileSizeBytes, 0);

    return {
      filePath: mediaItems[0].filePath,
      fileName: mediaItems[0].fileName,
      mediaType: mediaItems[0].mediaType,
      fileSizeBytes: totalSize,
      mediaItems,
      cleanupDir: workDir,
      note
    };
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function downloadAudio(url, options = {}) {
  const workDir = await createWorkDir();
  const outputTemplate = "%(title).80s-%(id)s.%(ext)s";
  const ffmpegBinary = env.ffmpegBinary || bundledFfmpegPath;
  const ffmpegLocation = ffmpegBinary ? path.dirname(ffmpegBinary) : null;
  const args = [
    "--no-playlist",
    "--newline",
    "--force-ipv4",
    "--socket-timeout",
    "15",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--js-runtimes",
    env.ytJsRuntimes,
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5",
    "--print",
    "after_move:filepath",
    "-P",
    workDir,
    "-o",
    outputTemplate
  ];

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  args.push(url);

  try {
    const lines = await runYtDlpWithProgress(args, {
      onProgress: options.onProgress
    });

    let filePaths = [...new Set(lines.filter((line) => line.startsWith(workDir)))];

    // Some yt-dlp/ffmpeg combinations do not print after_move path; fall back to scanning the work dir.
    if (!filePaths.length) {
      const entries = await fs.readdir(workDir);
      const audioExt = new Set([".mp3", ".m4a", ".aac", ".opus", ".wav", ".ogg", ".flac"]);
      filePaths = entries
        .map((name) => path.join(workDir, name))
        .filter((fullPath) => audioExt.has(path.extname(fullPath).toLowerCase()));
    }

    if (!filePaths.length) {
      throw new Error("Could not resolve downloaded audio file path from yt-dlp output");
    }

    const audioPath = filePaths[0];
    const stat = await fs.stat(audioPath);

    return {
      filePath: audioPath,
      fileName: path.basename(audioPath),
      mediaType: "audio",
      fileSizeBytes: stat.size,
      cleanupDir: workDir
    };
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupDownloadedFile(filePath, dirPath) {
  if (filePath) {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
  if (dirPath) {
    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  downloadMedia,
  downloadAudio,
  cleanupDownloadedFile
};
