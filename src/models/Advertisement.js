const mongoose = require("mongoose");

const adMediaSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["photo", "video", "document"], required: true },
    fileId: { type: String, required: true }
  },
  { _id: false }
);

const advertisementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    linkUrl: { type: String, default: null },
    linkLabel: { type: String, default: "Batafsil" },
    media: { type: [adMediaSchema], default: [] },
    createdBy: { type: Number, required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "broadcasting", "sent", "failed"],
      default: "draft"
    },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 }
    },
    sentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Advertisement", advertisementSchema);
