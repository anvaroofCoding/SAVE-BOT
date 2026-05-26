const { execFile, spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const env = require("../config/env");
const { detectPlatform, isInstagramCarouselCandidate } = require("../utils/url");
const { resolveInstagramRacing } = require("./fastExtractors");

const execFileAsync = promisify(execFile);

let bundledFfmpegPath = null;
try {
  bundledFfmpegPath = require("@ffmpeg-installer/ffmpeg").path;
} catch (_) {
  bundledFfmpegPath = null;
}

const CURL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function detectMediaTypeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const photoExt = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const videoExt = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

  if (photoExt.has(ext)) return "photo";
  if (videoExt.has(ext)) return "video";
  return "document";
}

async function createWorkDir() {
  const base = path.join(os.tmpdir(), "save-bot-");
  return fs.mkdtemp(base);
}

function buildYtDlpFormat(platform, fast = false) {
  if (platform === "youtube") {
    if (fast) {
      return "18/134/243/b[height<=360][ext=mp4]/b[height<=480][ext=mp4]/worst[ext=mp4]";
    }
    return "best[height<=480][ext=mp4]/best[height<=720][ext=mp4]/best[ext=mp4]/best";
  }

  if (fast) {
    return "b[height<=360][ext=mp4]/b[height<=480][ext=mp4]/worst[ext=mp4]/best";
  }

  return "b[height<=480][ext=mp4]/b[height<=720][ext=mp4]/b[ext=mp4]/best";
}

function baseYtDlpArgs(platform, options = {}) {
  const ffmpegBinary = env.ffmpegBinary || bundledFfmpegPath;
  const ffmpegLocation = ffmpegBinary ? path.dirname(ffmpegBinary) : null;
  const args = [
    ...(options.noPlaylist !== false ? ["--no-playlist"] : []),
    "--no-warnings",
    "--force-ipv4",
    "--socket-timeout",
    "10",
    "--retries",
    "1",
    "--fragment-retries",
    "1",
    "--js-runtimes",
    env.ytJsRuntimes,
    "--no-mtime",
    "--no-write-info-json",
    "--no-write-thumbnail",
    "--no-write-playlist-metafiles"
  ];

  if (platform === "youtube") {
    args.push("--extractor-args", "youtube:player_client=android,web");
  }

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  if (options.format) {
    args.push("--format", options.format);
  } else if (!options.skipFormat) {
    args.push("--format", buildYtDlpFormat(platform, options.fast));
  }

  return args;
}

function runYtDlpCapture(args, options = {}) {
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

    child.on("error", reject);

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

async function resolveYtDlpDirectUrl(url, platform) {
  const args = [
    ...baseYtDlpArgs(platform, { fast: true, skipFormat: false }),
    "--skip-download",
    "--print",
    "url",
    url
  ];

  const lines = await runYtDlpCapture(args);
  const directUrl = lines.find((line) => line.startsWith("http"));
  if (!directUrl) {
    throw new Error("Direct media URL not found");
  }

  return directUrl;
}

async function runYtDlp(url, outputDir, options = {}) {
  const platform = options.platform || detectPlatform(url);
  const outputTemplate = "%(title).80s-%(id)s.%(ext)s";
  const isYoutubeFast = platform === "youtube" && options.fast !== false;

  const args = [
    ...baseYtDlpArgs(platform, {
      fast: options.fast,
      noPlaylist: options.noPlaylist
    }),
    "--newline",
    "--concurrent-fragments",
    "8",
    "--http-chunk-size",
    "10M",
    "--print",
    "after_move:filepath",
    "-P",
    outputDir,
    "-o",
    outputTemplate
  ];

  if (!isYoutubeFast) {
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  const lines = await runYtDlpCapture(args, {
    onProgress: options.onProgress
  });

  const filePaths = [...new Set(lines.filter((line) => line.startsWith(outputDir)))];

  if (!filePaths.length) {
    throw new Error("Could not resolve downloaded file path from yt-dlp output");
  }

  return filePaths;
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

async function fetchInstagramHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": CURL_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`Instagram page fetch failed with status ${response.status}`);
  }

  return response.text();
}

async function resolveInstagramFromHtml(url) {
  const html = await fetchInstagramHtml(url);

  const videoUrl =
    extractMetaContent(html, "og:video:secure_url") ||
    extractMetaContent(html, "og:video");
  const imageUrl =
    extractMetaContent(html, "og:image") ||
    extractMetaContent(html, "og:image:url");

  const directUrl = videoUrl || imageUrl;
  if (!directUrl) {
    throw new Error("Instagram media metadata not found in page HTML");
  }

  const isCarousel =
    html.includes('"carousel_media_count"') ||
    html.includes('"thumbnail_resources":[{') ||
    (html.match(/\d+ photos - /i) !== null);

  const mediaType = videoUrl ? "video" : "photo";

  return { directUrl, mediaType, isCarousel };
}

const INSTAGRAM_FETCH_HEADERS = {
  referer: "https://www.instagram.com/",
  "user-agent": CURL_UA,
  accept: "*/*"
};

async function downloadFromDirectUrl(directUrl, outputDir, mediaTypeHint) {
  const mediaResponse = await fetch(directUrl, {
    headers: INSTAGRAM_FETCH_HEADERS,
    signal: AbortSignal.timeout(18_000)
  });

  if (!mediaResponse.ok || !mediaResponse.body) {
    throw new Error(`Media fetch failed with status ${mediaResponse.status}`);
  }

  const contentType = mediaResponse.headers.get("content-type") || "";
  const extension = resolveExtensionFromContentType(contentType, directUrl);
  const outputPath = path.join(outputDir, `media${extension}`);

  await pipeline(mediaResponse.body, createWriteStream(outputPath));

  const mediaType =
    mediaTypeHint ||
    (contentType.includes("video") ? "video" : detectMediaTypeFromExt(outputPath));

  return { filePath: outputPath, mediaType };
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

function createYtDlpStdoutStream(url, platform) {
  const isYoutubeFast = platform === "youtube";
  const args = [
    ...baseYtDlpArgs(platform, { fast: true, noPlaylist: true }),
    "-o",
    "-",
    "--no-part",
    "--hls-prefer-native"
  ];

  if (!isYoutubeFast) {
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  const child = spawn(env.ytdlpBinary, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    stream: child.stdout,
    child,
    onStderr: (listener) => child.stderr.on("data", listener)
  };
}

function waitForChildProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`yt-dlp stream exited with code ${code}`));
    });
  });
}

async function streamDirectMedia(directUrl, mediaTypeHint) {
  const mediaResponse = await fetch(directUrl, {
    headers: INSTAGRAM_FETCH_HEADERS,
    signal: AbortSignal.timeout(12_000)
  });

  if (!mediaResponse.ok || !mediaResponse.body) {
    throw new Error(`Media stream failed with status ${mediaResponse.status}`);
  }

  const contentType = mediaResponse.headers.get("content-type") || "";
  const mediaType =
    mediaTypeHint ||
    (contentType.includes("video") ? "video" : "photo");

  return {
    stream: Readable.fromWeb(mediaResponse.body),
    mediaType,
    contentLength: Number(mediaResponse.headers.get("content-length")) || null
  };
}

async function resolveMediaFast(url) {
  const platform = detectPlatform(url);

  if (platform === "youtube") {
    return { mode: "download", platform };
  }

  if (platform === "instagram") {
    try {
      const meta = await resolveInstagramRacing(url);
      return {
        mode: "url",
        platform,
        directUrl: meta.directUrl,
        mediaType: meta.mediaType,
        prefetch: meta,
        note: meta.isCarousel ? "Carousel postda birinchi media yuborildi." : null
      };
    } catch (_) {
      return { mode: "download", platform };
    }
  }

  if (platform === "facebook") {
    return { mode: "download", platform };
  }

  return { mode: "download", platform };
}

async function downloadInstagramFast(url, workDir, options = {}) {
  const meta = options.prefetch || await resolveInstagramFromHtml(url);
  const downloaded = await downloadFromDirectUrl(
    meta.directUrl,
    workDir,
    meta.mediaType
  );
  const stat = await fs.stat(downloaded.filePath);

  return {
    items: [
      {
        filePath: downloaded.filePath,
        fileName: path.basename(downloaded.filePath),
        mediaType: downloaded.mediaType,
        fileSizeBytes: stat.size
      }
    ],
    note: meta.isCarousel ? "Carousel postda birinchi media yuborildi." : null
  };
}

async function downloadMedia(url, options = {}) {
  const workDir = await createWorkDir();
  const platform = detectPlatform(url);

  try {
    let mediaItems = [];
    let note = null;

    if (platform === "instagram") {
      try {
        const fast = await downloadInstagramFast(url, workDir, options);
        mediaItems = fast.items;
        note = fast.note;
      } catch (_) {
        const reelPaths = await runYtDlp(url, workDir, {
          platform: "instagram",
          fast: true,
          noPlaylist: !isInstagramCarouselCandidate(url),
          onProgress: options.onProgress
        });
        mediaItems = await mapFilesToMediaItems(reelPaths);
        if (mediaItems.length > 1) {
          note = `Carousel aniqlandi: ${mediaItems.length} ta media topildi.`;
        }
      }
    } else {
      const filePaths = await runYtDlp(url, workDir, {
        platform,
        fast: true,
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
    ...baseYtDlpArgs(detectPlatform(url), { fast: true }),
    "--newline",
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
    outputTemplate,
    url
  ];

  if (ffmpegLocation) {
    args.push("--ffmpeg-location", ffmpegLocation);
  }

  try {
    const lines = await runYtDlpCapture(args, {
      onProgress: options.onProgress
    });

    let filePaths = [...new Set(lines.filter((line) => line.startsWith(workDir)))];

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
  resolveMediaFast,
  streamDirectMedia,
  createYtDlpStdoutStream,
  waitForChildProcess,
  cleanupDownloadedFile
};
