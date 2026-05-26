const { spawn } = require("node:child_process");
const env = require("../config/env");

const CURL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const EXTRACT_TIMEOUT_MS = 5500;

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

function extractVideoFromHtml(html) {
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
    /"contentUrl":"([^"]+)"/i,
    /"src":"(https:\\\/\\\/[^"]+\.mp4[^"]*)"/i
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

async function fetchText(url, timeoutMs = EXTRACT_TIMEOUT_MS) {
  const response = await fetch(url, {
    headers: {
      "user-agent": CURL_UA,
      accept: "text/html,application/xhtml+xml,application/json",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }

  return response.text();
}

function getInstagramEmbedUrl(url) {
  const match = String(url).match(/\/(reel|reels|p|tv)\/([^/?#]+)/i);
  if (!match) return null;
  return `https://www.instagram.com/p/${match[2]}/embed/captioned/`;
}

async function resolveFromHtml(url) {
  const html = await fetchText(url);
  const media = extractVideoFromHtml(html);
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
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`saveig failed (${response.status})`);
  }

  const payload = await response.json();
  const html = String(payload?.data || payload?.html || "");
  const media = extractVideoFromHtml(html);

  if (!media) {
    const hrefMatch = html.match(/href="(https:\/\/[^"]+)"/i);
    if (!hrefMatch) {
      throw new Error("saveig returned no media");
    }
    return {
      directUrl: hrefMatch[1],
      mediaType: "video",
      source: "saveig"
    };
  }

  return { ...media, source: "saveig" };
}

async function resolveViaCobalt(url) {
  const endpoints = [
    "https://api.cobalt.tools/api/json",
    "https://co.wuk.sh/api/json"
  ];

  let lastError;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url,
          downloadMode: "auto",
          videoQuality: "480"
        }),
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(`cobalt ${response.status}`);
      }

      const data = await response.json();
      const directUrl = data?.url || data?.picker?.[0]?.url;

      if (!directUrl) {
        throw new Error("cobalt returned no url");
      }

      return {
        directUrl,
        mediaType: "video",
        source: "cobalt"
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("cobalt unavailable");
}

function runYtDlpUrlOnly(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--force-ipv4",
      "--socket-timeout",
      "8",
      "--format",
      "b[ext=mp4][filesize<8M]/b[height<=480]/worst[ext=mp4]/worst",
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
  const extractors = [
    () => resolveFromEmbed(url),
    () => resolveFromHtml(url),
    () => resolveViaSaveig(url),
    () => resolveViaCobalt(url),
    () => runYtDlpUrlOnly(url)
  ];

  const results = await Promise.allSettled(
    extractors.map((extract) => extract())
  );

  const winner = results.find((result) => result.status === "fulfilled");
  if (winner) {
    return winner.value;
  }

  const reasons = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "unknown")
    .join(" | ");

  throw new Error(`All extractors failed: ${reasons}`);
}

module.exports = {
  resolveInstagramRacing,
  extractVideoFromHtml,
  fetchText
};
