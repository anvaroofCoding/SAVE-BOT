const { Telegraf } = require("telegraf");
const env = require("./config/env");
const { connectMongo } = require("./db/mongoose");
const { registerHandlers } = require("./bot/handlers");
const { registerAdminHandlers, adminMiddleware } = require("./bot/admin");

async function bootstrap() {
  await connectMongo();

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

  await bot.launch();
  console.log(`Save bot started (${env.nodeEnv})`);
  if (env.adminIds.length) {
    console.log(`Admins: ${env.adminIds.join(", ")}`);
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error("Failed to bootstrap app:", error);
  process.exit(1);
});
