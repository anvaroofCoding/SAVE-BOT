const mongoose = require("mongoose");

const mediaCacheSchema = new mongoose.Schema(
  {
    sourceUrl: { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: "unknown" },
    title: { type: String, default: null },
    mediaType: { type: String, enum: ["video", "photo", "document"], required: true },
    telegramFileId: { type: String, required: true },
    fileSizeBytes: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("MediaCache", mediaCacheSchema);
