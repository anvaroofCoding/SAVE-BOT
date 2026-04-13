function extractUrls(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  return (text.match(/https?:\/\/[^\s]+/gi) || []).map((match) => match.trim());
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

module.exports = { extractUrls, detectPlatform };
