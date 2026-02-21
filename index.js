import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import cron from "node-cron";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env / env vars");
  process.exit(1);
}

const TZ = process.env.TZ || "Asia/Tashkent";
let SEND_TIME = process.env.SEND_TIME || "14:00";

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "AzizbekEn").replace(/^@/, "");

const bot = new Telegraf(BOT_TOKEN);

const TIMETABLE = {
  1: ["Sinf soati", "Ingliz tili", "Adabiyot", "Algebra", "Informatika", "Geografiya"], // Mon
  2: ["Fizika", "Ona tili", "O'zb tarix", "Ingliz tili", "Geometriya", "Jismoniy tarbiya"], // Tue
  3: ["Kimyo", "Informatika", "Geografiya", "Algebra", "Fizika", "Rus tili"], // Wed
  4: ["Adabiyot", "O'zb tarix", "Biologiya", "Texnologiya", "Geometriya", "Ingliz tili"], // Thu
  5: ["Ingliz tili", "Jahon tarixi", "Algebra", "Rus tili", "Fizika", "Tarbiya"], // Fri
  6: ["Kimyo", "Biologiya", "Algebra", "San'at", "Geometriya", "Ona tili"], // Sat
  // 0 = Sunday (skip)
};

function formatSubjects(dayIndex, subjects) {
  const names = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
  const title = names[dayIndex];
  const lines = subjects.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `📚 *${title}* darslari:\n${lines}`;
}

function getTomorrowIndex(now = new Date()) {
  const today = now.getDay(); // 0..6
  if (today === 6) return 1; // Sat -> Mon
  if (today === 0) return 1; // Sun -> Mon
  return today + 1;
}

function getTodayIndex(now = new Date()) {
  return now.getDay();
}

async function main() {
  const db = await open({
    filename: "./bot.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      last_message_id INTEGER DEFAULT NULL,
      last_start_ts INTEGER DEFAULT 0
    );
  `);

  // Migration safety
  try {
    const cols = await db.all("PRAGMA table_info(chats);");
    const hasLastStart = cols.some((c) => c.name === "last_start_ts");
    if (!hasLastStart) {
      await db.run("ALTER TABLE chats ADD COLUMN last_start_ts INTEGER DEFAULT 0");
    }
  } catch (e) {
    console.warn("DB migration check failed:", e?.message || e);
  }

  async function upsertChat(chatId) {
    await db.run(
      `INSERT INTO chats(chat_id) VALUES (?) 
       ON CONFLICT(chat_id) DO NOTHING`,
      chatId
    );
  }

  async function setLastStartTs(chatId, ts) {
    await db.run(`UPDATE chats SET last_start_ts = ? WHERE chat_id = ?`, ts, chatId);
  }

  async function getLastStartTs(chatId) {
    const row = await db.get(`SELECT last_start_ts FROM chats WHERE chat_id = ?`, chatId);
    return row?.last_start_ts ?? 0;
  }

  async function removeChat(chatId) {
    await db.run(`DELETE FROM chats WHERE chat_id = ?`, chatId);
  }

  async function setLastMessage(chatId, msgId) {
    await db.run(`UPDATE chats SET last_message_id = ? WHERE chat_id = ?`, msgId, chatId);
  }

  async function getLastMessage(chatId) {
    const row = await db.get(`SELECT last_message_id FROM chats WHERE chat_id = ?`, chatId);
    return row?.last_message_id ?? null;
  }

  async function listChats() {
    return db.all(`SELECT chat_id FROM chats`);
  }

  let cronTask = null;

  async function sendSchedule(chatId, dayIndex) {
    if (dayIndex === 0) return;

    const subjects = TIMETABLE[dayIndex];
    if (!subjects) return;

    // delete previous timetable message (anti-spam)
    const lastId = await getLastMessage(chatId);
    if (lastId) {
      try {
        await bot.telegram.deleteMessage(chatId, lastId);
      } catch (e) {
        // ignore
      }
    }

    const text = formatSubjects(dayIndex, subjects);

    const sent = await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
    });

    await setLastMessage(chatId, sent.message_id);
  }

  async function sendFullTimetable(chatId) {
    const lines = [];
    const names = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
    for (let d = 1; d <= 6; d++) {
      const subjects = TIMETABLE[d] || [];
      lines.push(`*${names[d]}*:`);
      subjects.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push('');
    }
    const text = `📚 To'liq jadval:\n\n${lines.join('\n')}`;
    const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    return sent;
  }

  function scheduleDaily() {
    if (cronTask) {
      try {
        cronTask.destroy();
      } catch (e) {}
    }

    const [hh, mm] = SEND_TIME.split(":").map((x) => parseInt(x, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) {
      console.error("SEND_TIME must be HH:MM, like 14:00");
      process.exit(1);
    }

    cronTask = cron.schedule(
      `${mm} ${hh} * * *`,
      async () => {
        const dayIndex = getTomorrowIndex(new Date());
        const chats = await listChats();
        for (const row of chats) {
          try {
            await sendSchedule(row.chat_id, dayIndex);
          } catch (e) {}
        }
      },
      { timezone: TZ }
    );
  }

  // ---------- Commands ----------
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;

    const now = Math.floor(Date.now() / 1000);
    const lastTs = await getLastStartTs(chatId);
    if (now - lastTs < 30) {
      return ctx.reply("Iltimos, biroz kuting — /start spam qilmaslik kerak.");
    }

    await upsertChat(chatId);
    await setLastStartTs(chatId, now);

    // If started in group/supergroup, show commands only (your original behavior)
      // inline keyboard for commands (works in groups and private)
      const kb = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Bugun", callback_data: "cmd_today" },
              { text: "Ertaga", callback_data: "cmd_tomorrow" }
            ],
            [
              { text: "To'liq jadval", callback_data: "cmd_full" },
              { text: "Obunani bekor qilish", callback_data: "cmd_stop" }
            ],
            [{ text: "Yordam", callback_data: "cmd_help" }]
          ]
        }
      };

      // If started in group/supergroup, show commands only (don't subscribe)
      if (ctx.chat.type && ctx.chat.type !== "private") {
        return ctx.reply(`📘 Buyruqlar:`, kb);
      }

      // private chat: subscribe and show keyboard
      await ctx.reply(
        `✅ Obuna bo'ldingiz!\n` +
          `Men har kuni *${SEND_TIME}* da ertangi darslarni yuboraman (${TZ}).`,
        { parse_mode: "Markdown", ...kb }
      );
  });

  bot.command("stop", async (ctx) => {
    const chatId = ctx.chat.id;
    await removeChat(chatId);
    await ctx.reply("🛑 Obuna bekor qilindi. Qayta obuna bo'lish uchun /start yuboring.");
  });

  bot.command("tomorrow", async (ctx) => {
    const chatId = ctx.chat.id;
    await upsertChat(chatId);
    const dayIndex = getTomorrowIndex(new Date());
    await sendSchedule(chatId, dayIndex);
  });

  bot.command("today", async (ctx) => {
    const chatId = ctx.chat.id;
    await upsertChat(chatId);

    const dayIndex = getTodayIndex(new Date());
    if (dayIndex === 0) return ctx.reply("😴 Yakshanba — dars yo'q.");
    await sendSchedule(chatId, dayIndex);
  });

  bot.command("help", async (ctx) => {
    return ctx.reply(
      `📘 Yordam:\n` +
        `/today - bugun darslar\n` +
        `/tomorrow - ertaga darslar\n` +
        `/stop - obunani bekor qilish\n` +
        `/admin - admin panel (faqat admin uchun)`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("admin", async (ctx) => {
    const from = ctx.from?.username || "";
    if (from !== ADMIN_USERNAME) return ctx.reply("Siz admin emassiz.");

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 Hozir yuborish", callback_data: "admin_broadcast" },
            { text: "📋 Chatlar", callback_data: "admin_list" },
          ],
          [
            { text: "🕒 Vaqtni o'zgartirish", callback_data: "admin_set_time" },
            { text: "⚠️ To'xtatish", callback_data: "admin_shutdown" },
          ],
        ],
      },
    };

    return ctx.reply("⚙️ Admin panel:", keyboard);
  });

  bot.on("callback_query", async (ctx) => {
    const from = ctx.from?.username || "";
    const data = ctx.callbackQuery?.data;

    // User-facing command callbacks (clickable buttons)
    if (data === "cmd_today") {
      const chatId = ctx.chat.id;
      await ctx.answerCbQuery();
      const dayIndex = getTodayIndex(new Date());
      if (dayIndex === 0) {
        await ctx.reply("😴 Yakshanba — dars yo'q.");
      } else {
        await sendSchedule(chatId, dayIndex);
      }
      return;
    }

    if (data === "cmd_tomorrow") {
      const chatId = ctx.chat.id;
      await ctx.answerCbQuery();
      const dayIndex = getTomorrowIndex(new Date());
      await sendSchedule(chatId, dayIndex);
      return;
    }

    if (data === "cmd_full") {
      const chatId = ctx.chat.id;
      await ctx.answerCbQuery();
      await sendFullTimetable(chatId);
      return;
    }

    if (data === "cmd_stop") {
      const chatId = ctx.chat.id;
      await ctx.answerCbQuery();
      await removeChat(chatId);
      await ctx.reply("🛑 Obuna bekor qilindi.");
      return;
    }

    if (data === "cmd_help") {
      await ctx.answerCbQuery();
      await ctx.reply(`📘 Yordam:\nBugun — Bugungi darslar\nErtaga — Ertangi darslar\nTo'liq jadval — haftalik jadval`);
      return;
    }

    // Admin callbacks
    if (data && data.startsWith("admin_")) {
      if (from !== ADMIN_USERNAME) {
        await ctx.answerCbQuery("Ruxsat yo'q");
        return;
      }

      if (data === "admin_broadcast") {
        await ctx.answerCbQuery("Boshlanmoqda...");
        const dayIndex = getTomorrowIndex(new Date());
        const chats = await listChats();
        let sent = 0;
        for (const row of chats) {
          try {
            await sendSchedule(row.chat_id, dayIndex);
            sent++;
          } catch (e) {}
        }
        await ctx.editMessageText(`✅ Xabar yuborildi: ${sent} chatlarga.`);
        return;
      }

      if (data === "admin_list") {
        const chats = await listChats();
        const ids = chats.map((c) => c.chat_id).slice(0, 50);
        await ctx.answerCbQuery();
        await ctx.editMessageText(`🔎 Chatlar: ${chats.length} ta\nIDs(1-50): ${ids.join(", ")}`);
        return;
      }

      if (data === "admin_set_time") {
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "08:00", callback_data: "admin_time_08:00" },
                { text: "12:00", callback_data: "admin_time_12:00" },
                { text: "18:00", callback_data: "admin_time_18:00" },
              ],
              [{ text: "Bekor qilish", callback_data: "admin_cancel" }],
            ],
          },
        };
        await ctx.answerCbQuery();
        await ctx.editMessageText("🕒 Jo'natish vaqtini tanlang:", keyboard);
        return;
      }

      if (data && data.startsWith("admin_time_")) {
        const time = data.replace("admin_time_", "");
        SEND_TIME = time;
        scheduleDaily();
        await ctx.answerCbQuery("Vaqt o'zgartirildi");
        await ctx.editMessageText(`✅ Jo'natish vaqti ${SEND_TIME} ga o'rnatildi.`);
        return;
      }

      if (data === "admin_shutdown") {
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Tasdiqlash: To'xtatish", callback_data: "admin_shutdown_confirm" }],
              [{ text: "Bekor qilish", callback_data: "admin_cancel" }],
            ],
          },
        };
        await ctx.answerCbQuery();
        await ctx.editMessageText("⚠️ Botni to'xtatishni tasdiqlang:", keyboard);
        return;
      }

      if (data === "admin_shutdown_confirm") {
        await ctx.editMessageText("🛑 Bot to'xtatildi (admin tomonidan).");
        process.exit(0);
      }

      if (data === "admin_cancel") {
        await ctx.answerCbQuery("Bekor qilindi");
        try {
          await ctx.deleteMessage();
        } catch (e) {}
        return;
      }
    }

    await ctx.answerCbQuery();
  });

  bot.catch((err) => console.error("Bot error:", err));

  // schedule cron (still here)
  scheduleDaily();

  // ---------- WEBHOOK SERVER ----------
  const app = express();

  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
  const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  app.get("/", (req, res) => res.status(200).send("OK ✅ Bot is alive"));

  // optional: manual trigger endpoint (protected) for platform scheduler later
  // call: GET /sendTomorrow?key=WEBHOOK_SECRET
  app.get("/sendTomorrow", async (req, res) => {
    if (req.query.key !== WEBHOOK_SECRET) return res.status(403).send("Forbidden");
    try {
      const dayIndex = getTomorrowIndex(new Date());
      const chats = await listChats();
      let sent = 0;
      for (const row of chats) {
        try {
          await sendSchedule(row.chat_id, dayIndex);
          sent++;
        } catch (e) {}
      }
      return res.status(200).send(`Sent to ${sent} chats`);
    } catch (e) {
      console.error(e);
      return res.status(500).send("Error");
    }
  });

  // Telegraf webhook handler
  app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

  app.listen(PORT, async () => {
    console.log(`🌐 Server listening on port ${PORT}`);

    const BASE_URL = process.env.BASE_URL;
    if (!BASE_URL) {
      console.log("⚠️ BASE_URL missing. Webhook NOT set. Set BASE_URL in Choreo env vars.");
      return;
    }

    const webhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log("✅ Webhook set:", webhookUrl);
      console.log(`✅ Timezone=${TZ} Daily=${SEND_TIME}`);
    } catch (e) {
      console.error("❌ setWebhook failed:", e?.message || e);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});