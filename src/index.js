const { Telegraf } = require("telegraf");
const env = require("./config/env");
const { initJsonDb } = require("./db/jsonStore");
const { registerHandlers } = require("./bot/handlers");
const { registerAdminHandlers, adminMiddleware } = require("./bot/admin");
const {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock
} = require("./utils/singleInstance");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(error) {
  const code = String(error?.code || error?.errno || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    error?.type === "request-timeout" ||
    message.includes("timeout") ||
    message.includes("network")
  );
}

async function launchBotWithRetry(bot, maxAttempts = 12) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.launch({
        dropPendingUpdates: true
      });
      return;
    } catch (error) {
      const waitSeconds = Math.min(30, 3 * attempt);
      console.error(
        `[BOT] Telegram ulanmadi (${attempt}/${maxAttempts}): ${error.message}`
      );

      if (!isNetworkError(error) || attempt === maxAttempts) {
        throw error;
      }

      console.log(`[BOT] ${waitSeconds}s dan keyin qayta uriniladi...`);
      await sleep(waitSeconds * 1000);
    }
  }
}

async function shutdown(bot, signal) {
  console.log(`[BOT] To'xtatilmoqda (${signal})...`);
  await bot.stop(signal);
  await releaseSingleInstanceLock();
}

async function bootstrap() {
  const hasLock = await acquireSingleInstanceLock();
  if (!hasLock) {
    process.exit(1);
  }

  await initJsonDb();

  const bot = new Telegraf(env.telegramBotToken, {
    handlerTimeout: 300_000
  });

  registerAdminHandlers(bot);
  bot.use(adminMiddleware);
  registerHandlers(bot);

  bot.catch(async (error, ctx) => {
    console.error("Unhandled bot error:", error);
    if (ctx?.reply) {
      await ctx.reply("Serverda xatolik bo'ldi. Iltimos, keyinroq qayta urinib ko'ring.");
    }
  });

  await launchBotWithRetry(bot);

  console.log(`Save bot started (${env.nodeEnv})`);
  if (env.adminIds.length) {
    console.log(`Admins: ${env.adminIds.join(", ")}`);
  }

  process.once("SIGINT", () => {
    shutdown(bot, "SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown(bot, "SIGTERM").finally(() => process.exit(0));
  });
}

bootstrap().catch(async (error) => {
  console.error("Failed to bootstrap app:", error);
  await releaseSingleInstanceLock();

  if (isNetworkError(error)) {
    console.error(
      "\n[TAVSIYA] Internet yoki VPN ni tekshiring.\n"
      + "   • npm run stop\n"
      + "   • VPN yoqing\n"
      + "   • npm run dev\n"
    );
  }

  process.exit(1);
});
