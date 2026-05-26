const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const required = ["TELEGRAM_BOT_TOKEN"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  dataFile: process.env.DATA_FILE || null,
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_MB || 49) * 1024 * 1024,
  downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY || 6),
  ytdlpBinary: process.env.YTDLP_BINARY || "yt-dlp",
  ffmpegBinary: process.env.FFMPEG_BINARY || null,
  ytJsRuntimes: process.env.YT_JS_RUNTIMES || "node",
  requiredChannelUsername: process.env.REQUIRED_CHANNEL_USERNAME || null,
  adminIds: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0),
  broadcastConcurrency: Number(process.env.BROADCAST_CONCURRENCY || 28),
  broadcastDelayMs: Number(process.env.BROADCAST_DELAY_MS || 35)
};
