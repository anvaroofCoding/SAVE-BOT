const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const mongodbUri = process.env.MONGODB_URI || process.env.DB_LINK || process.env.DATABASE_URL;
const required = ["TELEGRAM_BOT_TOKEN"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (!mongodbUri) {
  throw new Error("Missing required environment variable: MONGODB_URI (or DB_LINK / DATABASE_URL)");
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  mongodbUri,
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_MB || 49) * 1024 * 1024,
  downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY || 3),
  ytdlpBinary: process.env.YTDLP_BINARY || "yt-dlp",
  ffmpegBinary: process.env.FFMPEG_BINARY || null,
  ytJsRuntimes: process.env.YT_JS_RUNTIMES || "node",
  requiredChannelUsername: process.env.REQUIRED_CHANNEL_USERNAME || null
};
