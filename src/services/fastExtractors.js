const { spawn } = require("node:child_process");
const env = require("../config/env");

const CURL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const FAST_TIMEOUT_MS = 2200;
const BACKUP_TIMEOUT_MS = 4500;

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    })
  ]);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unescapeJsonUrl(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
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

function extractSmallestVideoFromHtml(html) {
  const versions = [];
  const blockMatch = html.match(/"video_versions"\s*:\s*(\[[\s\S]*?\])\s*,/i);

  if (blockMatch?.[1]) {
    try {
      const normalized = blockMatch[1].replace(/\\\//g, "/");
      const parsed = JSON.parse(normalized);
      for (const item of parsed) {
        if (!item?.url) continue;
        versions.push({
          url: unescapeJsonUrl(item.url),
          width: Number(item.width) || 9999,
          height: Number(item.height) || 9999
        });
      }
    } catch {
      // ignore malformed json
    }
  }

  if (versions.length) {
    versions.sort((a, b) => (a.width * a.height) - (b.width * b.height));
    return { directUrl: versions[0].url, mediaType: "video" };
  }

  const videoUrl =
    extractMetaContent(html, "og:video:secure_url") ||
    extractMetaContent(html, "og:video");
  const imageUrl =
    extractMetaContent(html, "og:image") ||
    extractMetaContent(html, "og:image:url");

  if (videoUrl) {
    return { directUrl: videoUrl, mediaType: "video" };
  }

  if (imageUrl) {
    return { directUrl: imageUrl, mediaType: "photo" };
  }

  const jsonPatterns = [
    /"video_url":"([^"]+)"/i,
    /"playback_url":"([^"]+)"/i,
    /"contentUrl":"([^"]+)"/i
  ];

  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const directUrl = unescapeJsonUrl(match[1]);
      if (directUrl.startsWith("http")) {
        return { directUrl, mediaType: "video" };
      }
    }
  }

  return null;
}

async function fetchText(url, timeoutMs = FAST_TIMEOUT_MS) {
  const response = await fetch(url, {
    headers: {
      "user-agent": CURL_UA,
      accept: "text/html,application/xhtml+xml,application/json",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status})`);
  }

  return response.text();
}

function getInstagramEmbedUrl(url) {
  const match = String(url).match(/\/(reel|reels|p|tv)\/([^/?#]+)/i);
  if (!match) return null;
  return `https://www.instagram.com/reel/${match[2]}/embed/`;
}

async function resolveFromHtml(url) {
  const html = await fetchText(url, FAST_TIMEOUT_MS);
  const media = extractSmallestVideoFromHtml(html);
  if (!media) {
    throw new Error("No media in HTML");
  }

  return {
    ...media,
    source: "html",
    isCarousel: html.includes('"carousel_media_count"')
  };
}

async function resolveFromEmbed(url) {
  const embedUrl = getInstagramEmbedUrl(url);
  if (!embedUrl) {
    throw new Error("No embed URL");
  }

  return resolveFromHtml(embedUrl);
}

async function resolveViaSaveig(url) {
  const body = new URLSearchParams({
    q: url,
    t: "media",
    lang: "en"
  });

  const response = await fetch("https://v3.saveig.app/api/ajaxSearch", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": CURL_UA,
      origin: "https://saveig.app",
      referer: "https://saveig.app/"
    },
    body,
    signal: AbortSignal.timeout(BACKUP_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`saveig failed (${response.status})`);
  }

  const payload = await response.json();
  const html = String(payload?.data || payload?.html || "");
  const media = extractSmallestVideoFromHtml(html);

  if (!media) {
    throw new Error("saveig returned no media");
  }

  return { ...media, source: "saveig" };
}

function runYtDlpUrlOnly(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--force-ipv4",
      "--socket-timeout",
      "6",
      "--format",
      "b[ext=mp4][height<=360]/b[ext=mp4][filesize<6M]/b[height<=480]/worst[ext=mp4]",
      "--print",
      "url",
      "--skip-download",
      url
    ];

    const child = spawn(env.ytdlpBinary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp url failed: ${stderr.slice(-200)}`));
        return;
      }

      const directUrl = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("http"));

      if (!directUrl) {
        reject(new Error("yt-dlp url output missing"));
        return;
      }

      resolve({
        directUrl,
        mediaType: "video",
        source: "ytdlp-url"
      });
    });
  });
}

async function resolveInstagramRacing(url) {
  const fastTier = [
    () => withTimeout(resolveFromEmbed(url), FAST_TIMEOUT_MS, "embed"),
    () => withTimeout(resolveFromHtml(url), FAST_TIMEOUT_MS, "html")
  ];

  const backupTier = [
    () => withTimeout(resolveViaSaveig(url), BACKUP_TIMEOUT_MS, "saveig"),
    () => withTimeout(runYtDlpUrlOnly(url), BACKUP_TIMEOUT_MS, "ytdlp-url")
  ];

  try {
    return await Promise.any(fastTier.map((run) => run()));
  } catch {
    return Promise.any(backupTier.map((run) => run()));
  }
}

module.exports = {
  resolveInstagramRacing,
  extractSmallestVideoFromHtml,
  fetchText
};
