const { Telegraf } = require("telegraf");
const env = require("./config/env");
const { connectMongo } = require("./db/mongoose");
const { registerHandlers } = require("./bot/handlers");

async function bootstrap() {
  await connectMongo();

  const bot = new Telegraf(env.telegramBotToken, {
    handlerTimeout: 120_000
  });

  registerHandlers(bot);

  bot.catch(async (error, ctx) => {
    console.error("Unhandled bot error:", error);
    if (ctx?.reply) {
      await ctx.reply("Serverda xatolik bo'ldi. Iltimos, keyinroq qayta urinib ko'ring.");
    }
  });

  await bot.launch();
  console.log("Save bot started");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error("Failed to bootstrap app:", error);
  process.exit(1);
});
