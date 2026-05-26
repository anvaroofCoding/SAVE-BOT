const pLimit = require("p-limit");
const { Markup } = require("telegraf");
const env = require("../config/env");
const User = require("../models/User");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBroadcastTargets() {
  return User.find({
    isBlocked: { $ne: true },
    $or: [{ chatId: { $ne: null } }, { telegramId: { $ne: null } }]
  })
    .select("telegramId chatId username")
    .lean();
}

function resolveChatId(user) {
  return user.chatId || user.telegramId;
}

async function broadcastAdvertisement(telegram, ad, onProgress) {
  const users = await getBroadcastTargets();
  const limit = pLimit(env.broadcastConcurrency);
  const stats = { total: users.length, sent: 0, failed: 0 };
  let processed = 0;

  const caption = buildAdCaption(ad);
  const replyMarkup = buildAdKeyboard(ad);

  await Promise.all(
    users.map((user) =>
      limit(async () => {
        const chatId = resolveChatId(user);

        try {
          await sendAdToChat(telegram, chatId, ad, caption, replyMarkup);
          stats.sent += 1;
        } catch (error) {
          stats.failed += 1;
          if (error?.response?.error_code === 403) {
            await User.updateOne(
              { telegramId: user.telegramId },
              { $set: { isBlocked: true, blockedReason: "Bot blocked by user" } }
            ).catch(() => {});
          }
        } finally {
          processed += 1;
          if (typeof onProgress === "function" && processed % 25 === 0) {
            await onProgress({ ...stats, processed });
          }
          if (env.broadcastDelayMs > 0) {
            await sleep(env.broadcastDelayMs);
          }
        }
      })
    )
  );

  if (typeof onProgress === "function") {
    await onProgress({ ...stats, processed: stats.total, done: true });
  }

  return stats;
}

async function broadcastCopyMessage(telegram, source, onProgress) {
  const users = await getBroadcastTargets();
  const limit = pLimit(env.broadcastConcurrency);
  const stats = { total: users.length, sent: 0, failed: 0 };
  let processed = 0;

  await Promise.all(
    users.map((user) =>
      limit(async () => {
        const chatId = resolveChatId(user);

        try {
          await telegram.copyMessage(chatId, source.chatId, source.messageId);
          stats.sent += 1;
        } catch (error) {
          stats.failed += 1;
          if (error?.response?.error_code === 403) {
            await User.updateOne(
              { telegramId: user.telegramId },
              { $set: { isBlocked: true, blockedReason: "Bot blocked by user" } }
            ).catch(() => {});
          }
        } finally {
          processed += 1;
          if (typeof onProgress === "function" && processed % 25 === 0) {
            await onProgress({ ...stats, processed });
          }
          if (env.broadcastDelayMs > 0) {
            await sleep(env.broadcastDelayMs);
          }
        }
      })
    )
  );

  if (typeof onProgress === "function") {
    await onProgress({ ...stats, processed: stats.total, done: true });
  }

  return stats;
}

function buildAdCaption(ad) {
  const parts = [`📢 <b>${escapeHtml(ad.title)}</b>`];

  if (ad.description) {
    parts.push("", escapeHtml(ad.description));
  }

  return parts.join("\n");
}

function buildAdKeyboard(ad) {
  if (!ad.linkUrl) {
    return undefined;
  }

  return Markup.inlineKeyboard([
    [Markup.button.url(ad.linkLabel || "Batafsil", ad.linkUrl)]
  ]).reply_markup;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendAdToChat(telegram, chatId, ad, caption, replyMarkup) {
  const media = ad.media || [];

  if (media.length > 1) {
    const group = media.slice(0, 10).map((item, index) => {
      const entry = {
        type: item.type === "document" ? "document" : item.type,
        media: item.fileId
      };

      if (index === 0 && item.type === "photo") {
        entry.caption = caption;
        entry.parse_mode = "HTML";
      }

      return entry;
    });

    await telegram.sendMediaGroup(chatId, group);

    if (replyMarkup) {
      await telegram.sendMessage(chatId, "👇", { reply_markup: replyMarkup });
    }
    return;
  }

  if (media.length === 1) {
    const item = media[0];
    const extra = {
      caption,
      parse_mode: "HTML",
      reply_markup: replyMarkup
    };

    if (item.type === "video") {
      await telegram.sendVideo(chatId, item.fileId, extra);
      return;
    }

    if (item.type === "document") {
      await telegram.sendDocument(chatId, item.fileId, extra);
      return;
    }

    await telegram.sendPhoto(chatId, item.fileId, extra);
    return;
  }

  await telegram.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_web_page_preview: false
  });
}

module.exports = {
  getBroadcastTargets,
  broadcastAdvertisement,
  broadcastCopyMessage,
  buildAdCaption
};
