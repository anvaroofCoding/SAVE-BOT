const PROGRESS_BAR_WIDTH = 10;
const PROGRESS_SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";

const PLATFORM_TITLES = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  unknown: "Media"
};

const PHASE_LABELS = {
  preparing: "Preparing...",
  downloading: "Downloading...",
  uploading: "Server uploading...",
  processing: "Processing...",
  done: "Done"
};

function getPlatformTitle(platform) {
  return PLATFORM_TITLES[platform] || PLATFORM_TITLES.unknown;
}

function buildProgressBar(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((value / 100) * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;
  return `${"▉".repeat(filled)}${"░".repeat(empty)} ${Math.round(value)}%`;
}

function buildProgressMessage({
  platform,
  phase,
  percent,
  prefix = "",
  etaSeconds = null,
  customTitle = null
}) {
  const title = customTitle || getPlatformTitle(platform);
  const phaseLabel = PHASE_LABELS[phase] || PHASE_LABELS.downloading;
  const bar = buildProgressBar(percent);
  const etaLine =
    Number.isFinite(etaSeconds) && etaSeconds > 0
      ? `\n⏱ ${etaSeconds} qoldi`
      : "";

  return (
    `${prefix}📥 ${title} download\n`
    + `${PROGRESS_SEPARATOR}\n`
    + `⏳ State: ${phaseLabel}\n`
    + `${bar}${etaLine}`
  );
}

function buildDoneMessage({ platform, prefix = "", customTitle = null }) {
  const title = customTitle || getPlatformTitle(platform);

  return (
    `${prefix}✅ ${title} download\n`
    + `${PROGRESS_SEPARATOR}\n`
    + `🎬 Tayyor!`
  );
}

module.exports = {
  PROGRESS_SEPARATOR,
  getPlatformTitle,
  buildProgressBar,
  buildProgressMessage,
  buildDoneMessage
};
