const fs = require("node:fs");
const pLimit = require("p-limit");
const { Markup } = require("telegraf");
const env = require("../config/env");
const User = require("../models/User");
const DownloadJob = require("../models/DownloadJob");
const MediaCache = require("../models/MediaCache");
const { extractUrls, detectPlatform } = require("../utils/url");
const {
  downloadMedia,
  downloadAudio,
  resolveMediaFast,
  streamDirectMedia,
  createYtDlpStdoutStream,
  waitForChildProcess,
  cleanupDownloadedFile
} = require("../services/downloader");
const {
  getCachedMedia,
  setCachedMedia,
  getCachedSubscription,
  setCachedSubscription
} = require("../services/fastCache");
const {
  buildProgressMessage,
  buildDoneMessage
} = require("../utils/progressUi");
const { isUserBlocked } = require("./admin");

const queue = pLimit(env.downloadConcurrency);
const requiredChannelUsername = (env.requiredChannelUsername || "").replace(/^@/, "") || null;
const PROGRESS_TICK_MS = 2000;
const PROGRESS_START_DELAY_MS = 4000;
const INSTAGRAM_PROGRESS_DELAY_MS = 0;
const PLATFORM_ETA_SECONDS = {
  youtube: 10,
  instagram: 5,
  facebook: 12,
  unknown: 10
};

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

  const cached = getCachedSubscription(ctx.from.id);
  if (cached === true) {
    return true;
  }

  try {
    const chatId = `@${requiredChannelUsername}`;
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    const isSubscribed =
      ["member", "administrator", "creator"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);

    setCachedSubscription(ctx.from.id, isSubscribed);
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

      await sleep(400 * (i + 1));
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

function upsertUser(from, ctx, extra = {}) {
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

  User.findOneAndUpdate(
    { telegramId: from.id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).catch((error) => {
    console.error("[USER] upsert failed:", error?.message);
  });
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

async function lookupMediaCache(sourceUrl) {
  const memoryHit = getCachedMedia(sourceUrl);
  if (memoryHit?.telegramFileId) {
    return memoryHit;
  }

  const dbHit = await MediaCache.findOne({ sourceUrl }).lean();
  if (dbHit?.telegramFileId) {
    setCachedMedia(sourceUrl, dbHit);
  }

  return dbHit;
}

async function persistMediaCache(sourceUrl, payload) {
  setCachedMedia(sourceUrl, payload);

  MediaCache.findOneAndUpdate(
    { sourceUrl },
    {
      sourceUrl,
      platform: payload.platform,
      title: payload.title || null,
      mediaType: payload.mediaType,
      telegramFileId: payload.telegramFileId,
      fileSizeBytes: payload.fileSizeBytes || 0
    },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch((error) => {
    console.error("[CACHE] persist failed:", error?.message);
  });
}

function sendChatActionForMedia(ctx, mediaType) {
  const action = mediaType === "photo" ? "upload_photo" : "upload_video";
  return ctx.sendChatAction(action).catch(() => {});
}

async function sendFromCache(ctx, cached, audioKeyboard) {
  if (cached.mediaType === "photo") {
    await sendPhoto(ctx, cached.telegramFileId, {
      caption: "⚡ Tayyor"
    });
    return;
  }

  if (cached.mediaType === "video") {
    await sendVideo(ctx, cached.telegramFileId, {
      caption: "⚡ Tayyor",
      reply_markup: audioKeyboard
    });
    return;
  }

  await sendDocument(ctx, cached.telegramFileId, {
    caption: "⚡ Tayyor"
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

function createProgressTracker(ctx, prefix, options = {}) {
  const fallbackEta = PLATFORM_ETA_SECONDS[options.platform] || PLATFORM_ETA_SECONDS.unknown;
  const startDelayMs = options.platform === "instagram"
    ? INSTAGRAM_PROGRESS_DELAY_MS
    : PROGRESS_START_DELAY_MS;
  const state = {
    platform: options.platform || "unknown",
    customTitle: options.customTitle || null,
    prefix,
    phase: "preparing",
    percent: 5,
    startedAt: Date.now(),
    fallbackEta,
    deadlineAt: Date.now() + fallbackEta * 1000,
    shownRemaining: fallbackEta,
    messageId: null,
    timer: null
  };

  function syncDeadline(etaSeconds) {
    if (!Number.isFinite(etaSeconds)) return;

    const candidate = Date.now() + Math.max(0, Math.round(etaSeconds)) * 1000;
    if (candidate < state.deadlineAt) {
      state.deadlineAt = candidate;
    }
  }

  function getRemainingSeconds() {
    const raw = Math.max(0, Math.ceil((state.deadlineAt - Date.now()) / 1000));
    if (raw < state.shownRemaining) {
      state.shownRemaining = raw;
    }
    return state.shownRemaining;
  }

  function getEffectivePercent() {
    if (state.phase === "uploading") {
      return Math.max(state.percent || 0, 95);
    }

    if (Number.isFinite(state.percent) && state.percent > 0) {
      return Math.min(94, state.percent);
    }

    const totalMs = state.fallbackEta * 1000;
    const remainingMs = Math.max(0, state.deadlineAt - Date.now());
    const doneRatio = 1 - remainingMs / totalMs;
    return Math.min(90, Math.max(6, Math.round(doneRatio * 100)));
  }

  function render() {
    return buildProgressMessage({
      platform: state.platform,
      customTitle: state.customTitle,
      phase: state.phase,
      percent: getEffectivePercent(),
      prefix: state.prefix,
      etaSeconds: getRemainingSeconds()
    });
  }

  async function refresh() {
    if (!state.messageId) return;
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      state.messageId,
      undefined,
      render()
    ).catch(() => {});
  }

  return {
    onProgress(progress) {
      if (state.phase === "preparing") {
        state.phase = "downloading";
      }

      syncDeadline(progress?.etaSeconds);

      if (Number.isFinite(progress?.percent)) {
        state.percent = Math.max(state.percent || 0, progress.percent);
      }
    },
    setPhase(phase) {
      state.phase = phase;
      if (phase === "uploading") {
        state.percent = Math.max(state.percent || 0, 95);
        state.shownRemaining = Math.min(state.shownRemaining, 2);
        state.deadlineAt = Math.min(state.deadlineAt, Date.now() + 2000);
      }
    },
    async start() {
      state.startTimeout = setTimeout(async () => {
        const progressMsg = await sendText(ctx, render()).catch(() => null);
        if (!progressMsg) return;

        state.messageId = progressMsg.message_id;
        state.timer = setInterval(() => {
          refresh();
        }, PROGRESS_TICK_MS);
      }, startDelayMs);
    },
    async finish(doneText) {
      if (state.startTimeout) {
        clearTimeout(state.startTimeout);
        state.startTimeout = null;
      }
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }

      if (!state.messageId) {
        await sendText(ctx, doneText).catch(() => {});
        return;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        state.messageId,
        undefined,
        doneText
      ).catch(() => {});
    },
    async stop() {
      if (state.startTimeout) {
        clearTimeout(state.startTimeout);
        state.startTimeout = null;
      }
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    },
    update: refresh
  };
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

function extractTelegramFileId(message) {
  return (
    message?.photo?.[message.photo.length - 1]?.file_id ||
    message?.video?.file_id ||
    message?.document?.file_id ||
    null
  );
}

async function sendResolvedMedia(ctx, {
  prefix,
  sourceUrl,
  platform,
  mediaType,
  directUrl,
  caption,
  audioKeyboard
}) {
  if (mediaType === "photo") {
    return sendPhoto(ctx, directUrl, { caption });
  }

  if (mediaType === "video") {
    return sendVideo(ctx, directUrl, {
      caption,
      supports_streaming: true,
      reply_markup: audioKeyboard
    });
  }

  return sendDocument(ctx, directUrl, { caption });
}

async function tryFastUrlDelivery(ctx, {
  sourceUrl,
  platform,
  prefix,
  jobId,
  fastMeta
}) {
  const audioKeyboard = buildAudioKeyboard(jobId, platform, fastMeta.mediaType);
  const caption = `${prefix}Mana, tayyor ✅`;

  try {
    const sent = await sendResolvedMedia(ctx, {
      prefix,
      sourceUrl,
      platform,
      mediaType: fastMeta.mediaType,
      directUrl: fastMeta.directUrl,
      caption,
      audioKeyboard
    });

    const fileId = extractTelegramFileId(sent);
    if (fileId) {
      await persistMediaCache(sourceUrl, {
        platform,
        mediaType: fastMeta.mediaType,
        telegramFileId: fileId,
        fileSizeBytes: 0,
        title: null
      });
    }

    return { ok: true, fileId, mediaType: fastMeta.mediaType };
  } catch (error) {
    console.log(`[FAST] URL delivery failed for ${sourceUrl}:`, error?.message);
    return { ok: false };
  }
}

async function tryStreamDelivery(ctx, {
  sourceUrl,
  platform,
  prefix,
  jobId,
  fastMeta,
  progress
}) {
  if (!fastMeta?.directUrl || platform !== "instagram") {
    return { ok: false };
  }

  try {
    progress?.setPhase("downloading");
    await progress?.update();

    const streamed = await streamDirectMedia(fastMeta.directUrl, fastMeta.mediaType);

    progress?.setPhase("uploading");
    await progress?.update();

    const audioKeyboard = buildAudioKeyboard(jobId, platform, streamed.mediaType);
    const caption = `${prefix}Mana, tayyor ✅`;
    const source = { source: streamed.stream };

    let sent;
    if (streamed.mediaType === "photo") {
      sent = await sendPhoto(ctx, source, { caption });
    } else {
      sent = await sendVideo(ctx, source, {
        caption,
        supports_streaming: true,
        reply_markup: audioKeyboard
      });
    }

    const fileId = extractTelegramFileId(sent);
    if (fileId) {
      await persistMediaCache(sourceUrl, {
        platform,
        mediaType: streamed.mediaType,
        telegramFileId: fileId,
        fileSizeBytes: streamed.contentLength || 0,
        title: null
      });
    }

    await progress?.finish(buildDoneMessage({ platform, prefix }));

    return { ok: true, fileId, mediaType: streamed.mediaType };
  } catch (error) {
    console.log(`[STREAM] delivery failed for ${sourceUrl}:`, error?.message);
    return { ok: false };
  }
}

async function tryYtDlpPipeDelivery(ctx, {
  sourceUrl,
  platform,
  prefix,
  jobId,
  progress
}) {
  if (!["youtube", "instagram", "facebook"].includes(platform)) {
    return { ok: false };
  }

  const { stream, child, onStderr } = createYtDlpStdoutStream(sourceUrl, platform);

  try {
    if (progress) {
      progress.setPhase("downloading");
      onStderr((chunk) => {
        const line = chunk.toString();
        const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
        const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
        if (percentMatch) {
          progress.onProgress({ percent: Number(percentMatch[1]) });
        }
        if (etaMatch) {
          const parts = etaMatch[1].split(":").map(Number);
          let etaSeconds = 0;
          if (parts.length === 3) {
            etaSeconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
          } else if (parts.length === 2) {
            etaSeconds = (parts[0] * 60) + parts[1];
          } else {
            etaSeconds = parts[0];
          }
          progress.onProgress({ etaSeconds });
        }
      });
      await progress.update();
    }

    const audioKeyboard = buildAudioKeyboard(jobId, platform, "video");
    const caption = `${prefix}Mana, tayyor ✅`;

    progress?.setPhase("uploading");
    await progress?.update();

    const sent = await sendVideo(ctx, { source: stream }, {
      caption,
      supports_streaming: true,
      reply_markup: audioKeyboard
    });

    await waitForChildProcess(child);

    const fileId = extractTelegramFileId(sent);
    if (fileId) {
      await persistMediaCache(sourceUrl, {
        platform,
        mediaType: "video",
        telegramFileId: fileId,
        fileSizeBytes: 0,
        title: null
      });
    }

    await progress?.finish(buildDoneMessage({ platform, prefix }));

    return { ok: true, fileId, mediaType: "video" };
  } catch (error) {
    child.kill("SIGKILL");
    console.log(`[PIPE] yt-dlp stream failed for ${sourceUrl}:`, error?.message);
    return { ok: false };
  }
}

async function deliverMediaFast(ctx, {
  sourceUrl,
  platform,
  prefix,
  jobId,
  fastMeta,
  progress
}) {
  if (platform === "instagram") {
    if (fastMeta?.directUrl) {
      const streamResult = await tryStreamDelivery(ctx, {
        sourceUrl,
        platform,
        prefix,
        jobId,
        fastMeta,
        progress
      });
      if (streamResult.ok) return streamResult;
    }

    const pipeResult = await tryYtDlpPipeDelivery(ctx, {
      sourceUrl,
      platform,
      prefix,
      jobId,
      progress
    });
    if (pipeResult.ok) return pipeResult;

    return { ok: false };
  }

  if (fastMeta?.directUrl && platform !== "youtube") {
    const urlResult = await tryFastUrlDelivery(ctx, {
      sourceUrl,
      platform,
      prefix,
      jobId,
      fastMeta
    });
    if (urlResult.ok) return urlResult;
  }

  const pipeResult = await tryYtDlpPipeDelivery(ctx, {
    sourceUrl,
    platform,
    prefix,
    jobId,
    progress
  });
  if (pipeResult.ok) return pipeResult;

  return { ok: false };
}

async function sendDownloadedMedia(ctx, {
  downloaded,
  platform,
  prefix,
  jobId,
  elapsedDisplay
}) {
  const primaryItem = downloaded.mediaItems?.[0] || {
    filePath: downloaded.filePath,
    mediaType: downloaded.mediaType,
    fileSizeBytes: downloaded.fileSizeBytes
  };

  const sizeKb = Math.round(downloaded.fileSizeBytes / 1024);
  const sizeDisplay = sizeKb >= 1024
    ? `${(sizeKb / 1024).toFixed(1)} MB`
    : `${sizeKb} KB`;
  const doneCaption = `${prefix}Mana, tayyor ✅ | 📦 ${sizeDisplay}`
    + (downloaded.note ? `\n\nℹ️ ${downloaded.note}` : "");

  const multiItems = downloaded.mediaItems || [];
  const canSendAlbum =
    multiItems.length > 1 &&
    platform === "instagram" &&
    multiItems.every((item) => item.mediaType === "photo" || item.mediaType === "video");

  if (canSendAlbum) {
    const mediaGroup = multiItems.slice(0, 10).map((item, index) => {
      const media = { source: fs.createReadStream(item.filePath) };
      const entry = { type: item.mediaType, media };
      if (index === 0) {
        entry.caption = doneCaption;
      }
      return entry;
    });

    const sentGroup = await sendMediaGroup(ctx, mediaGroup);
    return { message: sentGroup[0], primaryItem };
  }

  const source = { source: fs.createReadStream(primaryItem.filePath) };
  const audioKeyboard = buildAudioKeyboard(jobId, platform, primaryItem.mediaType);

  if (primaryItem.mediaType === "photo") {
    const message = await sendPhoto(ctx, source, { caption: doneCaption });
    return { message, primaryItem };
  }

  if (primaryItem.mediaType === "video") {
    const message = await sendVideo(ctx, source, {
      caption: doneCaption,
      supports_streaming: true,
      reply_markup: audioKeyboard
    });
    return { message, primaryItem };
  }

  const message = await sendDocument(ctx, source, { caption: doneCaption });
  return { message, primaryItem };
}

async function processLink(ctx, sourceUrl, meta = {}) {
  const platform = detectPlatform(sourceUrl);
  const prefix = getJobPrefix(meta.index, meta.total);
  let job;
  let downloaded;
  const startedAt = Date.now();

  const jobPromise = DownloadJob.create({
    telegramId: ctx.from.id,
    chatId: ctx.chat.id,
    sourceUrl,
    platform,
    status: "queued"
  }).catch((error) => {
    console.error("[JOB] create failed:", error?.message);
    return null;
  });

  try {
    const chatAction = sendChatActionForMedia(ctx, "video");
    const [cached, resolvedJob, fastMeta] = await Promise.all([
      lookupMediaCache(sourceUrl),
      jobPromise,
      resolveMediaFast(sourceUrl),
      chatAction
    ]);

    job = resolvedJob;

    if (cached?.telegramFileId) {
      const audioKeyboard = buildAudioKeyboard(job?._id, platform, cached.mediaType);
      await sendFromCache(ctx, cached, audioKeyboard);

      if (job?._id) {
        DownloadJob.findByIdAndUpdate(job._id, {
          status: "done",
          mediaType: cached.mediaType,
          telegramFileId: cached.telegramFileId,
          title: cached.title,
          fileSizeBytes: cached.fileSizeBytes,
          processedAt: new Date()
        }).catch(() => {});
      }
      return;
    }

    if (job?._id) {
      DownloadJob.findByIdAndUpdate(job._id, { status: "processing" }).catch(() => {});
    }

    const progress = createProgressTracker(ctx, prefix, { platform });

    if (platform === "instagram") {
      await ctx.sendChatAction("upload_video").catch(() => {});
    }

    await progress.start();

    const fastResult = await deliverMediaFast(ctx, {
      sourceUrl,
      platform,
      prefix,
      jobId: job?._id,
      fastMeta,
      progress
    });

    if (fastResult.ok) {
      if (job?._id) {
        DownloadJob.findByIdAndUpdate(job._id, {
          status: "done",
          mediaType: fastResult.mediaType,
          telegramFileId: fastResult.fileId,
          processedAt: new Date()
        }).catch(() => {});
      }
      return;
    }

    const downloadStart = Date.now();

    downloaded = await downloadMedia(sourceUrl, {
      prefetch: fastMeta.prefetch,
      onProgress: (payload) => progress.onProgress(payload)
    });

    const elapsedTotal = Math.floor((Date.now() - downloadStart) / 1000);
    const elapsedDisplay = formatSeconds(elapsedTotal);

    if (downloaded.fileSizeBytes > env.maxFileSizeBytes) {
      const sizeMb = (downloaded.fileSizeBytes / 1024 / 1024).toFixed(1);
      const limitMb = Math.floor(env.maxFileSizeBytes / 1024 / 1024);
      throw new Error(`FILE_TOO_LARGE:${sizeMb}:${limitMb}`);
    }

    progress.setPhase("uploading");
    await progress.update();

    const { message, primaryItem } = await sendDownloadedMedia(ctx, {
      downloaded,
      platform,
      prefix,
      jobId: job?._id,
      elapsedDisplay
    });

    await progress.finish(buildDoneMessage({ platform, prefix }));
    await progress.stop();

    const fileId = extractTelegramFileId(message);

    if (job?._id) {
      DownloadJob.findByIdAndUpdate(job._id, {
        status: "done",
        mediaType: primaryItem.mediaType,
        telegramFileId: fileId,
        fileSizeBytes: downloaded.fileSizeBytes,
        title: downloaded.fileName,
        processedAt: new Date()
      }).catch(() => {});
    }

    if (fileId) {
      await persistMediaCache(sourceUrl, {
        platform,
        mediaType: primaryItem.mediaType,
        telegramFileId: fileId,
        fileSizeBytes: downloaded.fileSizeBytes,
        title: downloaded.fileName
      });
    }
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unknown download error";

    if (!job) {
      job = await jobPromise;
    }

    if (job?._id) {
      DownloadJob.findByIdAndUpdate(job._id, {
        status: "failed",
        errorMessage: err,
        processedAt: new Date()
      }).catch(() => {});
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
        `${prefix}🌐 Tarmoq xatosi. 10-20 soniyadan keyin qayta urinib ko'ring.`
      );
      return;
    }

    await sendText(
      ctx,
      `${prefix}Yuklab olishda xatolik. Linkni tekshirib qayta urinib ko'ring.`
    );
  } finally {
    if (downloaded?.filePath || downloaded?.cleanupDir) {
      await cleanupDownloadedFile(downloaded.filePath, downloaded.cleanupDir);
    }

    const totalMs = Date.now() - startedAt;
    if (totalMs > 5000) {
      console.log(`[SLOW] ${sourceUrl} took ${totalMs}ms`);
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
    await ctx.sendChatAction("upload_voice").catch(() => {});

    const startedAt = Date.now();
    const progress = createProgressTracker(ctx, "", {
      platform: job.platform,
      customTitle: "Audio"
    });
    await progress.start();

    try {
      downloaded = await downloadAudio(job.sourceUrl, {
        onProgress: (payload) => progress.onProgress(payload)
      });
    } finally {
      await progress.stop();
    }

    if (downloaded.fileSizeBytes > env.maxFileSizeBytes) {
      const sizeMb = (downloaded.fileSizeBytes / 1024 / 1024).toFixed(1);
      const limitMb = Math.floor(env.maxFileSizeBytes / 1024 / 1024);
      await sendText(ctx, `⚠️ Audio hajmi ${sizeMb}MB — Telegram limiti ${limitMb}MB.`);
      return;
    }

    progress.setPhase("uploading");
    await progress.update();

    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const elapsedDisplay = formatSeconds(elapsed);

    const source = { source: fs.createReadStream(downloaded.filePath) };
    await sendAudio(ctx, source, {
      caption: `🎵 Audio tayyor\n⏱ ${elapsedDisplay}`,
      title: downloaded.fileName
    });

    await progress.finish(
      buildDoneMessage({
        platform: job.platform,
        customTitle: "Audio"
      })
    );
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unknown audio error";
    console.error("[AUDIO] Failed to extract audio:", err);

    if (err.toLowerCase().includes("ffmpeg")) {
      await sendText(ctx, "Audio ajratishda ffmpeg xatoligi bo'ldi.");
      return;
    }

    await sendText(ctx, "Audio ajratishda xatolik bo'ldi.");
  } finally {
    if (downloaded?.filePath || downloaded?.cleanupDir) {
      await cleanupDownloadedFile(downloaded.filePath, downloaded.cleanupDir);
    }
  }
}

async function ensureNotBlocked(ctx) {
  if (await isUserBlocked(ctx.from.id)) {
    await sendText(ctx, "🚫 Siz botdan bloklangansiz. Admin bilan bog'laning.");
    return false;
  }
  return true;
}

function registerHandlers(bot) {
  bot.start(async (ctx) => {
    upsertUser(ctx.from, ctx);

    if (!(await ensureNotBlocked(ctx))) {
      return;
    }

    const canUseBot = await ensureSubscriptionOrPrompt(ctx);
    if (!canUseBot) {
      return;
    }

    await sendText(ctx, "👋 Salom, xush kelibsiz!");
    await sendText(
      ctx,
      "🤖 Men Save Botman.\n\n📌 Instagram, Facebook, YouTube\n📥 Link yuboring — media tezda chiqadi\n⚡ Bir xil link qayta yuborilsa, darhol javob beraman\n\n🚀 Boshlash uchun link yuboring."
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
      "🛟 Yordam\n\n1. Link yuboring\n2. Bot media yuboradi\n\n✅ Instagram, Facebook, YouTube"
    );
  });

  bot.on("text", async (ctx) => {
    upsertUser(ctx.from, ctx);

    if (!(await ensureNotBlocked(ctx))) {
      return;
    }

    const canUseBot = await ensureSubscriptionOrPrompt(ctx);
    if (!canUseBot) {
      return;
    }

    const sourceUrls = extractUrls(ctx.message.text);
    if (!sourceUrls.length) {
      await sendText(ctx, "Link topilmadi. Iltimos, to'liq URL yuboring.");
      return;
    }

    sourceUrls.forEach((sourceUrl, index) => {
      queue(() => processLink(ctx, sourceUrl, { index: index + 1, total: sourceUrls.length })).catch(
        async () => {
          await sendText(
            ctx,
            `${getJobPrefix(index + 1, sourceUrls.length)}Ichki xatolik. Qayta urinib ko'ring.`
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
      await sendText(ctx, "Audio so'rovida ichki xatolik yuz berdi.");
    });
  });
}

module.exports = { registerHandlers };
