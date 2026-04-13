const fs = require("node:fs");
const pLimit = require("p-limit");
const { Markup } = require("telegraf");
const env = require("../config/env");
const User = require("../models/User");
const DownloadJob = require("../models/DownloadJob");
const MediaCache = require("../models/MediaCache");
const { extractUrls, detectPlatform } = require("../utils/url");
const { downloadMedia, downloadAudio, cleanupDownloadedFile } = require("../services/downloader");

const queue = pLimit(env.downloadConcurrency);
const requiredChannelUsername = (env.requiredChannelUsername || "").replace(/^@/, "") || null;

function buildSubscriptionKeyboard() {
  if (!requiredChannelUsername) {
    return undefined;
  }

  return Markup.inlineKeyboard([
    [Markup.button.url("📢 Kanalga o'tish", `https://t.me/${requiredChannelUsername}`)],
    [Markup.button.callback("✅ Obunani tekshirish", "check_sub")]
  ]).reply_markup;
}

async function checkChannelSubscription(ctx) {
  if (!requiredChannelUsername) {
    return true;
  }

  try {
    const chatId = `@${requiredChannelUsername}`;
    const member = await ctx.telegram.getChatMember(
      chatId,
      ctx.from.id
    );
    const isSubscribed =
      ["member", "administrator", "creator"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);
    console.log(`[CHECK] User ${ctx.from.id} channel ${chatId}: status=${member.status}, subscribed=${isSubscribed}`);
    return isSubscribed;
  } catch (error) {
    console.log(`[CHECK] Error checking subscription for user ${ctx.from.id}:`, error?.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTelegramError(error) {
  const code = String(error?.code || "").toUpperCase();
  const msg = String(error?.message || "").toLowerCase();

  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    msg.includes("timedout") ||
    msg.includes("network") ||
    msg.includes("429")
  );
}

async function withTelegramRetry(operation, attempts = 3) {
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientTelegramError(error) || i === attempts - 1) {
        throw error;
      }

      await sleep(700 * (i + 1));
    }
  }

  throw lastError;
}

function sendText(ctx, text, extra = undefined) {
  return withTelegramRetry(() => ctx.reply(text, extra));
}

function sendPhoto(ctx, source, options) {
  return withTelegramRetry(() => ctx.replyWithPhoto(source, options));
}

function sendVideo(ctx, source, options) {
  return withTelegramRetry(() => ctx.replyWithVideo(source, options));
}

function sendDocument(ctx, source, options) {
  return withTelegramRetry(() => ctx.replyWithDocument(source, options));
}

function sendAudio(ctx, source, options) {
  return withTelegramRetry(() => ctx.replyWithAudio(source, options));
}

function sendMediaGroup(ctx, mediaGroup) {
  return withTelegramRetry(() => ctx.replyWithMediaGroup(mediaGroup));
}

async function upsertUser(from, ctx, extra = {}) {
  if (!from) return;

  const update = {
    telegramId: from.id,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    languageCode: from.language_code || null,
    isBot: Boolean(from.is_bot),
    isPremium: typeof from.is_premium === "boolean" ? from.is_premium : null,
    chatId: ctx?.chat?.id || null,
    rawFrom: from,
    lastSeenAt: new Date(),
    ...extra
  };

  await User.findOneAndUpdate(
    { telegramId: from.id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureSubscriptionOrPrompt(ctx) {
  const isSubscribed = await checkChannelSubscription(ctx);
  if (isSubscribed) {
    return true;
  }

  await sendText(
    ctx,
    `📢 Botdan foydalanish uchun @${requiredChannelUsername} kanaliga obuna bo'ling, keyin "Obunani tekshirish" tugmasini bosing.`,
    { reply_markup: buildSubscriptionKeyboard() }
  );
  return false;
}

async function sendFromCache(ctx, cached, audioKeyboard) {
  if (cached.mediaType === "photo") {
    await sendPhoto(ctx, cached.telegramFileId, {
      caption: "⚡ Keshdan yuborildi"
    });
    return;
  }

  if (cached.mediaType === "video") {
    await sendVideo(ctx, cached.telegramFileId, {
      caption: "⚡ Keshdan yuborildi",
      reply_markup: audioKeyboard
    });
    return;
  }

  await sendDocument(ctx, cached.telegramFileId, {
    caption: "⚡ Keshdan yuborildi"
  });
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0 s";
  }

  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }

  return `${seconds} s`;
}

function buildAudioKeyboard(jobId, platform, mediaType) {
  const supportsAudioButton =
    mediaType === "video" &&
    ["instagram", "facebook", "youtube"].includes(platform) &&
    Boolean(jobId);

  if (!supportsAudioButton) {
    return undefined;
  }

  return Markup.inlineKeyboard([
    Markup.button.callback("🎵 Ovozini alohida olish", `audio:${jobId}`)
  ]).reply_markup;
}

function getJobPrefix(index, total) {
  if (!total || total <= 1) {
    return "";
  }

  return `${index}/${total} `;
}

async function processLink(ctx, sourceUrl, meta = {}) {
  const platform = detectPlatform(sourceUrl);
  const prefix = getJobPrefix(meta.index, meta.total);
  let job;
  let downloaded;

  try {
    job = await DownloadJob.create({
      telegramId: ctx.from.id,
      chatId: ctx.chat.id,
      sourceUrl,
      platform,
      status: "queued"
    });

    const useCache = platform !== "instagram";
    const cached = useCache ? await MediaCache.findOne({ sourceUrl }).lean() : null;
    const cachedAudioKeyboard = buildAudioKeyboard(job?._id, platform, cached?.mediaType);
    if (cached?.telegramFileId) {
      await sendFromCache(ctx, cached, cachedAudioKeyboard);
      await DownloadJob.findByIdAndUpdate(job._id, {
        status: "done",
        mediaType: cached.mediaType,
        telegramFileId: cached.telegramFileId,
        title: cached.title,
        fileSizeBytes: cached.fileSizeBytes,
        processedAt: new Date()
      });
      return;
    }

    await DownloadJob.findByIdAndUpdate(job._id, { status: "processing" });

    const downloadStart = Date.now();
    const progressState = {
      etaSeconds: null,
      etaUpdatedAt: 0,
      percent: null
    };
    const progressMsg = await sendText(ctx, `${prefix}Yuklab olinmoqda... ⏳ ETA kutilmoqda`);

    const progressTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - downloadStart) / 1000);
      const etaDisplay = progressState.etaSeconds === null
        ? `ETA kutilmoqda | o'tdi ${formatSeconds(elapsed)}`
        : `${formatSeconds(Math.max(0, progressState.etaSeconds - Math.floor((Date.now() - progressState.etaUpdatedAt) / 1000)))} qoldi`;
      const percentDisplay = Number.isFinite(progressState.percent)
        ? ` (${progressState.percent.toFixed(1)}%)`
        : "";
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        undefined,
        `${prefix}Yuklab olinmoqda... ⏳ ${etaDisplay}${percentDisplay}`
      ).catch(() => {});
    }, 5000);

    try {
      downloaded = await downloadMedia(sourceUrl, {
        onProgress: (progress) => {
          if (Number.isFinite(progress?.etaSeconds)) {
            progressState.etaSeconds = Math.max(0, Math.round(progress.etaSeconds));
            progressState.etaUpdatedAt = Date.now();
          }
          if (Number.isFinite(progress?.percent)) {
            progressState.percent = progress.percent;
          }
        }
      });
    } finally {
      clearInterval(progressTimer);
    }

    const elapsedTotal = Math.floor((Date.now() - downloadStart) / 1000);
    const elapsedDisplay = elapsedTotal >= 60
      ? `${Math.floor(elapsedTotal / 60)} min ${elapsedTotal % 60} s`
      : `${elapsedTotal} s`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMsg.message_id,
      undefined,
      `${prefix}Yuklandi ✅ (${elapsedDisplay})`
    ).catch(() => {});

    if (downloaded.fileSizeBytes > env.maxFileSizeBytes) {
      const sizeMb = (downloaded.fileSizeBytes / 1024 / 1024).toFixed(1);
      const limitMb = Math.floor(env.maxFileSizeBytes / 1024 / 1024);
      throw new Error(`FILE_TOO_LARGE:${sizeMb}:${limitMb}`);
    }

    const primaryItem = downloaded.mediaItems?.[0] || {
      filePath: downloaded.filePath,
      mediaType: downloaded.mediaType,
      fileSizeBytes: downloaded.fileSizeBytes
    };
    const source = { source: fs.createReadStream(primaryItem.filePath) };
    let sent;

    const sizeKb = Math.round(downloaded.fileSizeBytes / 1024);
    const sizeDisplay = sizeKb >= 1024
      ? `${(sizeKb / 1024).toFixed(1)} MB`
      : `${sizeKb} KB`;
    const doneCaption = `${prefix}Mana, tayyor ✅\n⏱ ${elapsedDisplay} | 📦 ${sizeDisplay}`
      + (downloaded.note ? `\n\nℹ️ ${downloaded.note}` : "");

    const multiItems = downloaded.mediaItems || [];
    const canSendAlbum =
      multiItems.length > 1 &&
      platform === "instagram" &&
      multiItems.every((item) => item.mediaType === "photo" || item.mediaType === "video");

    if (canSendAlbum) {
      const mediaGroup = multiItems.slice(0, 10).map((item, index) => {
        const media = { source: fs.createReadStream(item.filePath) };
        const entry = {
          type: item.mediaType,
          media
        };

        if (index === 0) {
          entry.caption = doneCaption;
        }

        return entry;
      });

      const sentGroup = await sendMediaGroup(ctx, mediaGroup);
      sent = sentGroup[0];
    } else if (primaryItem.mediaType === "photo") {
      sent = await sendPhoto(ctx, source, {
        caption: doneCaption
      });
    } else if (primaryItem.mediaType === "video") {
      const audioKeyboard = buildAudioKeyboard(job?._id, platform, primaryItem.mediaType);
      sent = await sendVideo(ctx, source, {
        caption: doneCaption,
        supports_streaming: true,
        reply_markup: audioKeyboard
      });
    } else {
      sent = await sendDocument(ctx, source, {
        caption: doneCaption
      });
    }

    const message = sent;
    const fileId =
      message.photo?.[message.photo.length - 1]?.file_id ||
      message.video?.file_id ||
      message.document?.file_id ||
      null;

    await DownloadJob.findByIdAndUpdate(job._id, {
      status: "done",
      mediaType: primaryItem.mediaType,
      telegramFileId: fileId,
      fileSizeBytes: downloaded.fileSizeBytes,
      title: downloaded.fileName,
      processedAt: new Date()
    });

    if (fileId && useCache) {
      await MediaCache.findOneAndUpdate(
        { sourceUrl },
        {
          sourceUrl,
          platform,
          title: downloaded.fileName,
          mediaType: primaryItem.mediaType,
          telegramFileId: fileId,
          fileSizeBytes: downloaded.fileSizeBytes
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unknown download error";

    if (job?._id) {
      await DownloadJob.findByIdAndUpdate(job._id, {
        status: "failed",
        errorMessage: err,
        processedAt: new Date()
      });
    }

    if (err.startsWith("FILE_TOO_LARGE:")) {
      const parts = err.split(":");
      await sendText(
        ctx,
        `${prefix}⚠️ Video hajmi ${parts[1]}MB — Telegram limiti ${parts[2]}MB.\nQisqaroq yoki past sifatli versiyasini ko'ring.`
      );
      return;
    }

    if (err.includes("nodename nor servname") || err.includes("Failed to resolve")) {
      await sendText(
        ctx,
        `${prefix}🌐 Tarmoq xatosi: video serverga ulanish bo'lmadi. Iltimos 10-20 soniyadan keyin qayta urinib ko'ring.`
      );
      return;
    }

    await sendText(
      ctx,
      `${prefix}Yuklab olishda xatolik bo'ldi. Linkni tekshirib qayta urinib ko'ring yoki boshqa link yuboring.`
    );
  } finally {
    if (downloaded?.filePath || downloaded?.cleanupDir) {
      await cleanupDownloadedFile(downloaded.filePath, downloaded.cleanupDir);
    }
  }
}

async function processAudioRequest(ctx, jobId) {
  let downloaded;

  try {
    const job = await DownloadJob.findById(jobId).lean();
    if (!job) {
      await ctx.answerCbQuery("Bu so'rov topilmadi", { show_alert: true });
      return;
    }

    if (job.telegramId !== ctx.from.id) {
      await ctx.answerCbQuery("Bu tugma siz uchun emas", { show_alert: true });
      return;
    }

    if (!["instagram", "facebook", "youtube"].includes(job.platform)) {
      await ctx.answerCbQuery("Bu platformada audio ajratish yoqilmagan", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery("Audio tayyorlanmoqda...");

    const startedAt = Date.now();
    const progressState = {
      etaSeconds: null,
      etaUpdatedAt: 0,
      percent: null
    };
    const progressMsg = await sendText(ctx, "🎵 Audio ajratilmoqda... ⏳ ETA kutilmoqda");

    const progressTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const etaDisplay = progressState.etaSeconds === null
        ? `ETA kutilmoqda | o'tdi ${formatSeconds(elapsed)}`
        : `${formatSeconds(Math.max(0, progressState.etaSeconds - Math.floor((Date.now() - progressState.etaUpdatedAt) / 1000)))} qoldi`;
      const percentDisplay = Number.isFinite(progressState.percent)
        ? ` (${progressState.percent.toFixed(1)}%)`
        : "";

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        undefined,
        `🎵 Audio ajratilmoqda... ⏳ ${etaDisplay}${percentDisplay}`
      ).catch(() => {});
    }, 5000);

    try {
      downloaded = await downloadAudio(job.sourceUrl, {
        onProgress: (progress) => {
          if (Number.isFinite(progress?.etaSeconds)) {
            progressState.etaSeconds = Math.max(0, Math.round(progress.etaSeconds));
            progressState.etaUpdatedAt = Date.now();
          }
          if (Number.isFinite(progress?.percent)) {
            progressState.percent = progress.percent;
          }
        }
      });
    } finally {
      clearInterval(progressTimer);
    }

    if (downloaded.fileSizeBytes > env.maxFileSizeBytes) {
      const sizeMb = (downloaded.fileSizeBytes / 1024 / 1024).toFixed(1);
      const limitMb = Math.floor(env.maxFileSizeBytes / 1024 / 1024);
      await sendText(ctx, `⚠️ Audio hajmi ${sizeMb}MB — Telegram limiti ${limitMb}MB.`);
      return;
    }

    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMsg.message_id,
      undefined,
      `🎵 Audio tayyor ✅ (${formatSeconds(elapsed)})`
    ).catch(() => {});

    const source = { source: fs.createReadStream(downloaded.filePath) };
    await sendAudio(ctx, source, {
      caption: `🎵 Audio tayyor\n⏱ ${formatSeconds(elapsed)}`,
      title: downloaded.fileName
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unknown audio error";
    console.error("[AUDIO] Failed to extract audio:", err);

    if (err.toLowerCase().includes("ffmpeg")) {
      await sendText(ctx, "Audio ajratishda ffmpeg xatoligi bo'ldi. Server sozlamasini tekshirib qayta urinib ko'ring.");
      return;
    }

    await sendText(ctx, "Audio ajratishda xatolik bo'ldi. Linkni tekshirib qayta urinib ko'ring.");
  } finally {
    if (downloaded?.filePath || downloaded?.cleanupDir) {
      await cleanupDownloadedFile(downloaded.filePath, downloaded.cleanupDir);
    }
  }
}

function registerHandlers(bot) {
  bot.start(async (ctx) => {
    await upsertUser(ctx.from, ctx);

    const canUseBot = await ensureSubscriptionOrPrompt(ctx);
    if (!canUseBot) {
      return;
    }

    await sendText(
      ctx,
      "👋 Salom, xush kelibsiz!");
    await sendText(
      ctx,
      "🤖 Men Save Botman.\n\n📌 Platformalar: Instagram, Facebook, YouTube\n📥 Link yuboring, media yuklab beraman\n🖼 Foto bo'lsa foto, 🎬 video bo'lsa video yuboraman\n⚡ Bir nechta link bo'lsa navbat bilan ishlayman\n\n🚀 Boshlash uchun link yuboring."
    );
  });

  bot.action("check_sub", async (ctx) => {
    if (!requiredChannelUsername) {
      await ctx.answerCbQuery("Majburiy kanal sozlanmagan");
      return;
    }

    const isSubscribed = await checkChannelSubscription(ctx);
    if (!isSubscribed) {
      await ctx.answerCbQuery("Hali obuna bo'lmagansiz", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery("Obuna tasdiqlandi ✅");
    await ctx.editMessageText("✅ Obuna tasdiqlandi. Endi link yuborishingiz mumkin.").catch(() => {});
  });

  bot.command("help", async (ctx) => {
    await sendText(
      ctx,
      "🛟 Yordam\n\n1. Link yuboring\n2. Bot yuklab oladi\n3. Natijani yuboradi\n\n✅ Qo'llab-quvvatlanadi: Instagram, Facebook, YouTube"
    );
  });

  bot.on("text", async (ctx) => {
    await upsertUser(ctx.from, ctx);

    const canUseBot = await ensureSubscriptionOrPrompt(ctx);
    if (!canUseBot) {
      return;
    }

    const sourceUrls = extractUrls(ctx.message.text);
    if (!sourceUrls.length) {
      await sendText(ctx, "Link topilmadi. Iltimos, to'liq URL yuboring.");
      return;
    }

    if (sourceUrls.length === 1) {
      await sendText(ctx, "Link qabul qilindi. Navbatga qo'shildi.");
    } else {
      await sendText(ctx, `${sourceUrls.length} ta link qabul qilindi. Hammasi navbatga qo'shildi.`);
    }

    sourceUrls.forEach((sourceUrl, index) => {
      queue(() => processLink(ctx, sourceUrl, { index: index + 1, total: sourceUrls.length })).catch(
        async () => {
          await sendText(
            ctx,
            `${getJobPrefix(index + 1, sourceUrls.length)}Ichki navbat xatoligi yuz berdi. Iltimos, qayta urinib ko'ring.`
          );
        }
      );
    });
  });

  bot.action(/^audio:(.+)$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCbQuery("Noto'g'ri so'rov", { show_alert: true });
      return;
    }

    queue(() => processAudioRequest(ctx, jobId)).catch(async () => {
      await sendText(ctx, "Audio so'rovini bajarishda ichki xatolik yuz berdi.");
    });
  });
}

module.exports = { registerHandlers };
