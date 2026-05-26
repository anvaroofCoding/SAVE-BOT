function extractUrls(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const seen = new Set();
  const urls = [];

  for (const match of text.match(/https?:\/\/[^\s]+/gi) || []) {
    const cleaned = match.trim().replace(/[),.;!?]+$/g, "");
    const normalized = normalizeSourceUrl(cleaned);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return urls;
}

function detectPlatform(url) {
  if (!url) {
    return "unknown";
  }

  const u = url.toLowerCase();
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com")) return "tiktok";
  return "unknown";
}

function normalizeSourceUrl(url) {
  if (!url || typeof url !== "string") {
    return url;
  }

  try {
    const parsed = new URL(url.trim());

    if (parsed.hostname.includes("instagram.com")) {
      const match = parsed.pathname.match(/\/(reel|reels|p|tv)\/([^/?#]+)/i);
      if (match) {
        const segment = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
        return `https://www.instagram.com/${segment}/${match[2]}/`;
      }
    }

    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace(/^\//, "").split("/")[0];
      if (id) {
        return `https://www.youtube.com/watch?v=${id}`;
      }
    }

    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      if (id) {
        return `https://www.youtube.com/watch?v=${id}`;
      }
      const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?#]+)/i);
      if (shortsMatch) {
        return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
      }
    }

    if (parsed.hostname.includes("fb.watch")) {
      return `https://fb.watch/${parsed.pathname.replace(/^\//, "").split("/")[0]}/`;
    }

    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function isInstagramReel(url) {
  return /instagram\.com\/(reel|reels)\//i.test(String(url || ""));
}

function isInstagramCarouselCandidate(url) {
  return /instagram\.com\/p\//i.test(String(url || ""));
}

module.exports = {
  extractUrls,
  detectPlatform,
  normalizeSourceUrl,
  isInstagramReel,
  isInstagramCarouselCandidate
};
