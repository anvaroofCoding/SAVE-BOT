const mongoose = require("mongoose");

const downloadJobSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, index: true },
    chatId: { type: Number, required: true, index: true },
    sourceUrl: { type: String, required: true },
    platform: { type: String, default: "unknown" },
    status: {
      type: String,
      enum: ["queued", "processing", "done", "failed"],
      default: "queued"
    },
    title: { type: String, default: null },
    mediaType: { type: String, enum: ["video", "photo", "document"], default: "document" },
    fileSizeBytes: { type: Number, default: 0 },
    telegramFileId: { type: String, default: null },
    errorMessage: { type: String, default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

downloadJobSchema.index({ sourceUrl: 1, status: 1 });

module.exports = mongoose.model("DownloadJob", downloadJobSchema);
