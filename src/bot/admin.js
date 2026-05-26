const { Markup } = require("telegraf");
const env = require("../config/env");
const User = require("../models/User");
const Advertisement = require("../models/Advertisement");
const {
  broadcastAdvertisement,
  broadcastCopyMessage,
  getBroadcastTargets
} = require("../services/broadcast");

const USERS_PAGE_SIZE = 8;
const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;

const adminSessions = new Map();

const SESSION_STATE = {
  IDLE: "idle",
  BLOCK_WAIT_ID: "block_wait_id",
  AD_TITLE: "ad_title",
  AD_DESCRIPTION: "ad_description",
  AD_LINK: "ad_link",
  AD_MEDIA: "ad_media",
  AD_CONFIRM: "ad_confirm",
  FORWARD_BROADCAST: "forward_broadcast"
};

function isAdmin(telegramId) {
  const id = Number(telegramId);
  if (!Number.isFinite(id) || id <= 0) {
    return false;
  }

  return env.adminIds.some((adminId) => adminId === id);
}

function canUseAdminPanel(ctx) {
  return isAdmin(ctx?.from?.id) && ctx?.chat?.type === "private";
}

function getSession(telegramId) {
  const session = adminSessions.get(Number(telegramId));
  if (!session) return null;

  if (Date.now() - session.updatedAt > ADMIN_SESSION_TTL_MS) {
    adminSessions.delete(Number(telegramId));
    return null;
  }

  return session;
}

function setSession(telegramId, patch) {
  const current = getSession(telegramId) || {
    state: SESSION_STATE.IDLE,
    data: {},
    updatedAt: Date.now()
  };

  const next = {
    ...current,
    ...patch,
    data: { ...current.data, ...(patch.data || {}) },
    updatedAt: Date.now()
  };

  adminSessions.set(Number(telegramId), next);
  return next;
}

function clearSession(telegramId) {
  adminSessions.delete(Number(telegramId));
}

function formatUserLine(user, index) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "—";
  const username = user.username ? `@${user.username}` : "—";
  const status = user.isBlocked ? "🚫" : "✅";
  return `${index}. ${status} <b>${name}</b>\n   ID: <code>${user.telegramId}</code> | ${username}`;
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Foydalanuvchilar", "admin:users:1")],
    [
      Markup.button.callback("🚫 Bloklash", "admin:block:menu"),
      Markup.button.callback("✅ Blokdan chiqarish", "admin:unblock:menu")
    ],
    [Markup.button.callback("📢 Reklama bo'limi", "admin:ads:menu")],
    [Markup.button.callback("📊 Statistika", "admin:stats")]
  ]);
}

function adsMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Reklama yaratish", "admin:ads:create")],
    [Markup.button.callback("📤 Lichkadan yuborish", "admin:ads:forward")],
    [Markup.button.callback("📋 Saqlangan reklamalar", "admin:ads:list:1")],
    [Markup.button.callback("◀️ Admin panel", "admin:home")]
  ]);
}

async function getUserStats() {
  const [total, blocked, activeToday] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isBlocked: true }),
    User.countDocuments({
      lastSeenAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    })
  ]);

  return { total, blocked, activeToday, active: total - blocked };
}

async function renderUsersPage(page) {
  const currentPage = Math.max(1, Number(page) || 1);
  const skip = (currentPage - 1) * USERS_PAGE_SIZE;

  const [users, total] = await Promise.all([
    User.find()
      .sort({ lastSeenAt: -1 })
      .skip(skip)
      .limit(USERS_PAGE_SIZE)
      .lean(),
    User.countDocuments()
  ]);

  const totalPages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const lines = users.map((user, index) =>
    formatUserLine(user, skip + index + 1)
  );

  const text = [
    "👥 <b>Foydalanuvchilar</b>",
    `Sahifa ${currentPage}/${totalPages} | Jami: ${total}`,
    "",
    lines.length ? lines.join("\n\n") : "Foydalanuvchi topilmadi."
  ].join("\n");

  const rows = users.map((user) => [
    Markup.button.callback(
      `${user.isBlocked ? "✅" : "🚫"} ${user.username || user.telegramId}`,
      user.isBlocked ? `admin:unblock:${user.telegramId}` : `admin:block:${user.telegramId}`
    )
  ]);

  const nav = [];
  if (currentPage > 1) nav.push(Markup.button.callback("⬅️", `admin:users:${currentPage - 1}`));
  if (currentPage < totalPages) nav.push(Markup.button.callback("➡️", `admin:users:${currentPage + 1}`));

  const keyboard = [...rows];
  if (nav.length) keyboard.push(nav);
  keyboard.push([Markup.button.callback("◀️ Admin panel", "admin:home")]);

  return { text, keyboard: Markup.inlineKeyboard(keyboard) };
}

async function blockUser(telegramId, adminId, reason = null) {
  await User.findOneAndUpdate(
    { telegramId: Number(telegramId) },
    {
      isBlocked: true,
      blockedAt: new Date(),
      blockedBy: adminId,
      blockedReason: reason || "Admin tomonidan bloklandi"
    },
    { upsert: true }
  );
}

async function unblockUser(telegramId) {
  await User.findOneAndUpdate(
    { telegramId: Number(telegramId) },
    {
      isBlocked: false,
      blockedAt: null,
      blockedBy: null,
      blockedReason: null
    }
  );
}

async function isUserBlocked(telegramId) {
  const user = await User.findOne({ telegramId: Number(telegramId) })
    .select("isBlocked")
    .lean();
  return Boolean(user?.isBlocked);
}

async function showAdminHome(ctx, edit = false) {
  clearSession(ctx.from.id);
  const stats = await getUserStats();
  const text = [
    "🛡 <b>Admin panel</b>",
    "",
    `👥 Jami: <b>${stats.total}</b>`,
    `✅ Faol: <b>${stats.active}</b>`,
    `🚫 Blok: <b>${stats.blocked}</b>`,
    `📈 24 soat: <b>${stats.activeToday}</b>`,
    "",
    "📌 <b>Foydalanuvchilarni ko'rish:</b>",
    "• /users — to'g'ridan-to'g'ri ro'yxat",
    "• 👥 Foydalanuvchilar tugmasi",
    "",
    "📌 Boshqa buyruqlar:",
    "/admin — panel | /users — userlar | /myid — ID"
  ].join("\n");

  const extra = {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard().reply_markup
  };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));
    return;
  }

  await ctx.reply(text, extra);
}

function extractMediaFromMessage(message) {
  const items = [];

  if (message.photo?.length) {
    items.push({
      type: "photo",
      fileId: message.photo[message.photo.length - 1].file_id
    });
  }

  if (message.video) {
    items.push({ type: "video", fileId: message.video.file_id });
  }

  if (message.document && !message.video) {
    items.push({ type: "document", fileId: message.document.file_id });
  }

  return items;
}

async function handleAdminMessage(ctx) {
  const session = getSession(ctx.from.id);
  if (!session || session.state === SESSION_STATE.IDLE) {
    return false;
  }

  const text = ctx.message?.text?.trim() || "";

  if (session.state === SESSION_STATE.BLOCK_WAIT_ID) {
    const targetId = Number(text);
    if (!Number.isFinite(targetId)) {
      await ctx.reply("❌ To'g'ri Telegram ID yuboring. Masalan: 123456789");
      return true;
    }

    if (session.data.mode === "unblock") {
      await unblockUser(targetId);
      clearSession(ctx.from.id);
      await ctx.reply(`✅ Blokdan chiqarildi: <code>${targetId}</code>`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard().reply_markup
      });
      return true;
    }

    await blockUser(targetId, ctx.from.id);
    clearSession(ctx.from.id);
    await ctx.reply(`🚫 Foydalanuvchi bloklandi: <code>${targetId}</code>`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard().reply_markup
    });
    return true;
  }

  if (session.state === SESSION_STATE.AD_TITLE) {
    if (!text) {
      await ctx.reply("❌ Sarlavha bo'sh bo'lmasin.");
      return true;
    }

    setSession(ctx.from.id, {
      state: SESSION_STATE.AD_DESCRIPTION,
      data: { title: text.slice(0, 120) }
    });
    await ctx.reply("📝 <b>Reklama tavsifi</b> yuboring (- bo'lsa o'tkazib yuborish):", {
      parse_mode: "HTML"
    });
    return true;
  }

  if (session.state === SESSION_STATE.AD_DESCRIPTION) {
    setSession(ctx.from.id, {
      state: SESSION_STATE.AD_LINK,
      data: { description: text === "-" ? "" : text.slice(0, 1000) }
    });
    await ctx.reply(
      "🔗 <b>Link</b> yuboring (https://...)\nYoki - yozing (linksiz):",
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (session.state === SESSION_STATE.AD_LINK) {
    const patch = { state: SESSION_STATE.AD_MEDIA, data: {} };

    if (text !== "-") {
      if (!/^https?:\/\//i.test(text)) {
        await ctx.reply("❌ Link https:// bilan boshlanishi kerak.");
        return true;
      }
      patch.data.linkUrl = text;
      patch.data.linkLabel = "Batafsil";
    }

    setSession(ctx.from.id, patch);
    await ctx.reply(
      "🖼 <b>Rasm/video</b> yuboring (bir nechta bo'lishi mumkin).\nTayyor bo'lsa: /done",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Tayyor — ko'rib chiqish", "admin:ads:preview")]
        ]).reply_markup
      }
    );
    return true;
  }

  if (session.state === SESSION_STATE.AD_MEDIA) {
    const media = extractMediaFromMessage(ctx.message);
    if (!media.length) {
      await ctx.reply("❌ Rasm yoki video yuboring. Tayyor bo'lsa /done");
      return true;
    }

    const current = getSession(ctx.from.id);
    const merged = [...(current.data.media || []), ...media].slice(0, 10);
    setSession(ctx.from.id, { data: { media: merged } });
    await ctx.reply(`✅ Media qabul qilindi (${merged.length}). Yana yuboring yoki /done`);
    return true;
  }

  if (session.state === SESSION_STATE.FORWARD_BROADCAST) {
    const source = {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id
    };

    clearSession(ctx.from.id);
    const progressMsg = await ctx.reply("📤 Reklama yuborilmoqda... 0%");

    const stats = await broadcastCopyMessage(ctx.telegram, source, async (payload) => {
      const percent = payload.total
        ? Math.round((payload.processed / payload.total) * 100)
        : 0;
      const line = payload.done
        ? `✅ Tayyor!\n📨 Yuborildi: ${payload.sent}\n❌ Xato: ${payload.failed}\n👥 Jami: ${payload.total}`
        : `📤 Yuborilmoqda... ${percent}%\n✅ ${payload.sent} | ❌ ${payload.failed} | 👥 ${payload.total}`;

      await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, line).catch(() => {});
    });

    await Advertisement.create({
      title: "Lichkadan reklama",
      description: "Forward/copy broadcast",
      media: [],
      createdBy: ctx.from.id,
      status: "sent",
      stats,
      sentAt: new Date()
    }).catch(() => {});

    return true;
  }

  return false;
}

async function createAndBroadcastAd(ctx, session) {
  const ad = await Advertisement.create({
    title: session.data.title,
    description: session.data.description || "",
    linkUrl: session.data.linkUrl || null,
    linkLabel: session.data.linkLabel || "Batafsil",
    media: session.data.media || [],
    createdBy: ctx.from.id,
    status: "broadcasting"
  });

  clearSession(ctx.from.id);

  const progressMsg = await ctx.reply("📤 Reklama yuborilmoqda... 0%");

  const stats = await broadcastAdvertisement(ctx.telegram, ad, async (payload) => {
    const percent = payload.total
      ? Math.round((payload.processed / payload.total) * 100)
      : 0;
    const line = payload.done
      ? `✅ Tayyor!\n📨 Yuborildi: ${payload.sent}\n❌ Xato: ${payload.failed}\n👥 Jami: ${payload.total}`
      : `📤 Yuborilmoqda... ${percent}%\n✅ ${payload.sent} | ❌ ${payload.failed} | 👥 ${payload.total}`;

    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, line).catch(() => {});
  });

  await Advertisement.findByIdAndUpdate(ad._id, {
    status: "sent",
    stats,
    sentAt: new Date()
  });

  return stats;
}

async function showUsersList(ctx, page = 1, edit = false) {
  const { text, keyboard } = await renderUsersPage(page);
  const extra = { parse_mode: "HTML", reply_markup: keyboard.reply_markup };

  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));
    return;
  }

  await ctx.reply(text, extra);
}

function registerAdminHandlers(bot) {
  if (!env.adminIds.length) {
    console.warn("[ADMIN] ADMIN_IDS is empty — admin panel disabled.");
    return;
  }

  console.log(`[ADMIN] Panel enabled for ${env.adminIds.length} admin(s): ${env.adminIds.join(", ")}`);

  bot.command(["admin", "panel"], async (ctx) => {
    if (!canUseAdminPanel(ctx)) {
      return;
    }
    await showAdminHome(ctx);
  });

  bot.command("users", async (ctx) => {
    if (!canUseAdminPanel(ctx)) {
      return;
    }
    await showUsersList(ctx, 1);
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(`🆔 Sizning Telegram ID: <code>${ctx.from.id}</code>`, {
      parse_mode: "HTML"
    });
  });

  bot.command("done", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;

    const session = getSession(ctx.from.id);
    if (session?.state !== SESSION_STATE.AD_MEDIA) return;

    setSession(ctx.from.id, { state: SESSION_STATE.AD_CONFIRM });
    const preview = [
      "📢 <b>Reklama preview</b>",
      "",
      `<b>${session.data.title}</b>`,
      session.data.description || "—",
      session.data.linkUrl ? `🔗 ${session.data.linkUrl}` : "🔗 —",
      `🖼 Media: ${(session.data.media || []).length} ta`
    ].join("\n");

    await ctx.reply(preview, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Hammaga yuborish (100%)", "admin:ads:send")],
        [Markup.button.callback("❌ Bekor", "admin:ads:menu")]
      ]).reply_markup
    });
  });

  bot.action("admin:home", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();
    await showAdminHome(ctx, true);
  });

  bot.action("admin:stats", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();

    const [stats, targets] = await Promise.all([
      getUserStats(),
      getBroadcastTargets()
    ]);

    await ctx.editMessageText(
      [
        "📊 <b>Statistika</b>",
        "",
        `👥 Jami: ${stats.total}`,
        `📨 Broadcastga tayyor: ${targets.length}`,
        `🚫 Blok: ${stats.blocked}`,
        `📈 24 soat faol: ${stats.activeToday}`
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("◀️ Orqaga", "admin:home")]
        ]).reply_markup
      }
    );
  });

  bot.action(/^admin:users:(\d+)$/, async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();
    await showUsersList(ctx, ctx.match[1], true);
  });

  bot.action("admin:block:menu", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { state: SESSION_STATE.BLOCK_WAIT_ID, data: {} });

    await ctx.editMessageText(
      "🚫 <b>Bloklash</b>\n\nFoydalanuvchi Telegram ID sini yuboring.\nYoki foydalanuvchilar ro'yxatidan tanlang.",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("👥 Ro'yxatdan tanlash", "admin:users:1")],
          [Markup.button.callback("◀️ Orqaga", "admin:home")]
        ]).reply_markup
      }
    );
  });

  bot.action("admin:unblock:menu", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { state: SESSION_STATE.BLOCK_WAIT_ID, data: { mode: "unblock" } });

    await ctx.editMessageText(
      "✅ <b>Blokdan chiqarish</b>\n\nFoydalanuvchi Telegram ID sini yuboring.",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("👥 Ro'yxatdan tanlash", "admin:users:1")],
          [Markup.button.callback("◀️ Orqaga", "admin:home")]
        ]).reply_markup
      }
    );
  });

  bot.action(/^admin:block:(\d+)$/, async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery("Bloklandi");

    const targetId = Number(ctx.match[1]);
    await blockUser(targetId, ctx.from.id);

    const { text, keyboard } = await renderUsersPage(1);
    await ctx.editMessageText(`🚫 Bloklandi: <code>${targetId}</code>\n\n${text}`, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup
    }).catch(() => {});
  });

  bot.action(/^admin:unblock:(\d+)$/, async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery("Blokdan chiqarildi");

    const targetId = Number(ctx.match[1]);
    await unblockUser(targetId);

    const { text, keyboard } = await renderUsersPage(1);
    await ctx.editMessageText(`✅ Blokdan chiqarildi: <code>${targetId}</code>\n\n${text}`, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup
    }).catch(() => {});
  });

  bot.action("admin:ads:menu", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();
    clearSession(ctx.from.id);

    await ctx.editMessageText(
      [
        "📢 <b>Reklama bo'limi</b>",
        "",
        "• Reklama yaratish — rasm, sarlavha, tavsif, link",
        "• Lichkadan yuborish — postni shu yerga yuboring, hammaga ketadi",
        "• Saqlangan reklamalar — oldingi reklamalar"
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: adsMenuKeyboard().reply_markup
      }
    );
  });

  bot.action("admin:ads:create", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();

    setSession(ctx.from.id, {
      state: SESSION_STATE.AD_TITLE,
      data: { media: [] }
    });

    await ctx.editMessageText(
      "➕ <b>Yangi reklama</b>\n\n1/4 — Sarlavha yuboring:",
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("❌ Bekor", "admin:ads:menu")]
        ]).reply_markup
      }
    );
  });

  bot.action("admin:ads:forward", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();

    setSession(ctx.from.id, {
      state: SESSION_STATE.FORWARD_BROADCAST,
      data: {}
    });

    await ctx.editMessageText(
      [
        "📤 <b>Lichkadan reklama joylash</b>",
        "",
        "Endi reklama postini shu chatga yuboring:",
        "• matn",
        "• rasm / video",
        "• forward qilingan post",
        "",
        "📨 100% foydalanuvchilarga yuboriladi."
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("❌ Bekor", "admin:ads:menu")]
        ]).reply_markup
      }
    );
  });

  bot.action("admin:ads:preview", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();

    const session = getSession(ctx.from.id);
    if (!session?.data?.title) {
      await ctx.reply("❌ Avval reklama ma'lumotlarini to'ldiring.");
      return;
    }

    setSession(ctx.from.id, { state: SESSION_STATE.AD_CONFIRM });

    await ctx.editMessageText(
      [
        "📢 <b>Reklama preview</b>",
        "",
        `<b>${session.data.title}</b>`,
        session.data.description || "—",
        session.data.linkUrl ? `🔗 ${session.data.linkUrl}` : "🔗 —",
        `🖼 Media: ${(session.data.media || []).length} ta`
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🚀 Hammaga yuborish (100%)", "admin:ads:send")],
          [Markup.button.callback("❌ Bekor", "admin:ads:menu")]
        ]).reply_markup
      }
    );
  });

  bot.action("admin:ads:send", async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery("Yuborish boshlandi...");

    const session = getSession(ctx.from.id);
    if (!session?.data?.title) {
      await ctx.reply("❌ Reklama ma'lumotlari topilmadi.");
      return;
    }

    await ctx.editMessageText("📤 Barcha foydalanuvchilarga yuborilmoqda...").catch(() => {});
    await createAndBroadcastAd(ctx, session);
  });

  bot.action(/^admin:ads:list:(\d+)$/, async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery();

    const page = Math.max(1, Number(ctx.match[1]) || 1);
    const skip = (page - 1) * 5;

    const [ads, total] = await Promise.all([
      Advertisement.find().sort({ createdAt: -1 }).skip(skip).limit(5).lean(),
      Advertisement.countDocuments()
    ]);

    const totalPages = Math.max(1, Math.ceil(total / 5));
    const lines = ads.map(
      (ad, i) =>
        `${skip + i + 1}. <b>${ad.title}</b>\n   ${ad.status} | ✅${ad.stats?.sent || 0} ❌${ad.stats?.failed || 0}`
    );

    const keyboard = ads.map((ad) => [
      Markup.button.callback(`🚀 ${ad.title.slice(0, 20)}`, `admin:ads:resend:${ad._id}`)
    ]);

    const nav = [];
    if (page > 1) nav.push(Markup.button.callback("⬅️", `admin:ads:list:${page - 1}`));
    if (page < totalPages) nav.push(Markup.button.callback("➡️", `admin:ads:list:${page + 1}`));
    if (nav.length) keyboard.push(nav);
    keyboard.push([Markup.button.callback("◀️ Reklama", "admin:ads:menu")]);

    await ctx.editMessageText(
      ["📋 <b>Saqlangan reklamalar</b>", `Sahifa ${page}/${totalPages}`, "", lines.join("\n\n") || "—"].join(
        "\n"
      ),
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
      }
    );
  });

  bot.action(/^admin:ads:resend:(.+)$/, async (ctx) => {
    if (!canUseAdminPanel(ctx)) return;
    await ctx.answerCbQuery("Qayta yuborilmoqda...");

    const ad = await Advertisement.findById(ctx.match[1]).lean();
    if (!ad) {
      await ctx.reply("❌ Reklama topilmadi.");
      return;
    }

    const progressMsg = await ctx.reply("📤 Qayta yuborilmoqda...");

    const stats = await broadcastAdvertisement(ctx.telegram, ad, async (payload) => {
      const percent = payload.total
        ? Math.round((payload.processed / payload.total) * 100)
        : 0;
      const line = payload.done
        ? `✅ Tayyor!\n📨 ${payload.sent} | ❌ ${payload.failed} | 👥 ${payload.total}`
        : `📤 ${percent}% | ✅ ${payload.sent} | ❌ ${payload.failed}`;

      await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, line).catch(() => {});
    });

    await Advertisement.findByIdAndUpdate(ad._id, { stats, sentAt: new Date(), status: "sent" });
  });
}

async function adminMiddleware(ctx, next) {
  if (!canUseAdminPanel(ctx)) {
    return next();
  }

  if (!ctx.message) {
    return next();
  }

  const handled = await handleAdminMessage(ctx);
  if (handled) {
    return;
  }

  return next();
}

module.exports = {
  registerAdminHandlers,
  adminMiddleware,
  isAdmin,
  canUseAdminPanel,
  isUserBlocked,
  showAdminHome
};
