const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    languageCode: { type: String, default: null },
    isBot: { type: Boolean, default: false },
    isPremium: { type: Boolean, default: null },
    phoneNumber: { type: String, default: null },
    phoneSharedAt: { type: Date, default: null },
    phoneShareMessageId: { type: Number, default: null },
    chatId: { type: Number, default: null, index: true },
    isBlocked: { type: Boolean, default: false, index: true },
    blockedAt: { type: Date, default: null },
    blockedBy: { type: Number, default: null },
    blockedReason: { type: String, default: null },
    rawFrom: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSeenAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
