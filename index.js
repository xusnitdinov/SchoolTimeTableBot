import "dotenv/config";
import { Telegraf } from "telegraf";
import cron from "node-cron";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

const TZ = process.env.TZ || "Asia/Tashkent"; // important for Uzbekistan time
let SEND_TIME = process.env.SEND_TIME || "18:00"; // HH:MM (24h) - will be reschedulable by admin

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
  // JS: 0=Sun, 1=Mon ... 6=Sat
  const today = now.getDay();
  if (today === 6) return 1; // Sat -> Mon (skip Sun)
  if (today === 0) return 1; // Sun -> Mon
  return today + 1; // normal
}

function getTodayIndex(now = new Date()) {
  const today = now.getDay();
  return today; // 0..6
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

  // Migration: if the DB was created before last_start_ts existed, add the column
  try {
    const cols = await db.all("PRAGMA table_info(chats);");
    const hasLastStart = cols.some((c) => c.name === "last_start_ts");
    if (!hasLastStart) {
      await db.run("ALTER TABLE chats ADD COLUMN last_start_ts INTEGER DEFAULT 0");
    }
  } catch (e) {
    // ignore migration errors but log
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

  // admin username (without @)
  const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "AzizbekEn").replace(/^@/, "");

  // cron task handle so we can reschedule
  let cronTask = null;
  function scheduleDaily() {
    // destroy existing task
    if (cronTask) {
      try {
        cronTask.destroy();
      } catch (e) {
        // ignore
      }
    }

    const [hh, mm] = SEND_TIME.split(":").map((x) => parseInt(x, 10));
    cronTask = cron.schedule(
      `${mm} ${hh} * * *`,
      async () => {
        const dayIndex = getTomorrowIndex(new Date());
        const chats = await listChats();
        for (const row of chats) {
          try {
            await sendSchedule(row.chat_id, dayIndex);
          } catch (e) {
            // ignore errors per chat
          }
        }
      },
      { timezone: TZ }
    );
  }

  async function sendSchedule(chatId, dayIndex) {
    // Skip Sunday
    if (dayIndex === 0) return;

    const subjects = TIMETABLE[dayIndex];
    if (!subjects) return;

    // delete previous timetable message (anti-spam)
    const lastId = await getLastMessage(chatId);
    if (lastId) {
      try {
        await bot.telegram.deleteMessage(chatId, lastId);
      } catch (e) {
        // ignore: message may be too old or already deleted or no permission
      }
    }

    const text = formatSubjects(dayIndex, subjects);

    const sent = await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
    });

    await setLastMessage(chatId, sent.message_id);
  }

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;

    // rate-limit /start to avoid spam (per chat)
    const now = Math.floor(Date.now() / 1000);
    const lastTs = await getLastStartTs(chatId);
    if (now - lastTs < 30) {
      // too frequent
      return ctx.reply("Iltimos, biroz kuting — /start spam qilmaslik kerak.");
    }
    await upsertChat(chatId);
    await setLastStartTs(chatId, now);

    // If started in group/supergroup, only show commands (don't subscribe)
    if (ctx.chat.type && ctx.chat.type !== "private") {
      return ctx.reply(
        `📘 Buyruqlar (commands):\n` +
          `/today - bugun\n` +
          `/tomorrow - ertaga\n` +
          `/help - yordam`,
        { parse_mode: "Markdown" }
      );
    }

    // private chat: subscribe
    await ctx.reply(
      `✅ Obuna bo'ldingiz!\n` +
        `Men har kuni *${SEND_TIME}* da ertangi darslarni yuboraman (${TZ}).\n\n` +
        `Buyruqlar:\n` +
        `/tomorrow - ertaga darslar\n` +
        `/today - bugun darslar\n` +
        `/stop - obunani bekor qilish\n` +
        `/help - yordam`,
      { parse_mode: "Markdown" }
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
    if (dayIndex === 0) {
      await ctx.reply("😴 Yakshanba — dars yo'q.");
      return;
    }
    await sendSchedule(chatId, dayIndex);
  });

  bot.command("help", async (ctx) => {
    return ctx.reply(
      `📘 Yordam (Help):\n` +
        `/today - bugun darslar\n` +
        `/tomorrow - ertaga darslar\n` +
        `/stop - obunani bekor qilish\n` +
        `/admin - admin panel (faqat admin uchun)`,
      { parse_mode: "Markdown" }
    );
  });

  // Admin panel: only for ADMIN_USERNAME
  bot.command("admin", async (ctx) => {
    const from = ctx.from?.username || "";
    if (from !== ADMIN_USERNAME) {
      return ctx.reply("Siz admin emassiz.");
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 Hozircha barcha chatlarga yuborish", callback_data: "admin_broadcast" },
            { text: "📋 Chatlarni ko'rsatish", callback_data: "admin_list" }
          ],
          [
            { text: "🕒 Jo'natish vaqtini o'zgartirish", callback_data: "admin_set_time" },
            { text: "⚠️ To'xtatish (shutdown)", callback_data: "admin_shutdown" }
          ]
        ]
      }
    };

    return ctx.reply("⚙️ Admin panel:", keyboard);
  });

  bot.on("callback_query", async (ctx) => {
    const from = ctx.from?.username || "";
    if (from !== ADMIN_USERNAME) {
      await ctx.answerCbQuery("Ruxsat yo'q");
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data === "admin_broadcast") {
      await ctx.answerCbQuery("Boshlanmoqda...");
      const dayIndex = getTomorrowIndex(new Date());
      const chats = await listChats();
      let sent = 0;
      for (const row of chats) {
        try {
          await sendSchedule(row.chat_id, dayIndex);
          sent++;
        } catch (e) {
          // ignore per chat
        }
      }
      await ctx.editMessageText(`✅ Xabar yuborildi: ${sent} chatlarga.`);
    } else if (data === "admin_list") {
      const chats = await listChats();
      const ids = chats.map((c) => c.chat_id).slice(0, 50);
      await ctx.answerCbQuery();
      await ctx.editMessageText(`🔎 Chatlar: ${ids.length} ta\nIDs: ${ids.join(", ")}`);
    } else if (data === "admin_set_time") {
      // show quick options
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "08:00", callback_data: "admin_time_08:00" },
              { text: "12:00", callback_data: "admin_time_12:00" },
              { text: "18:00", callback_data: "admin_time_18:00" }
            ],
            [{ text: "Bekor qilish", callback_data: "admin_cancel" }]
          ]
        }
      };
      await ctx.answerCbQuery();
      await ctx.editMessageText("🕒 Jo'natish vaqtini tanlang:", keyboard);
    } else if (data && data.startsWith("admin_time_")) {
      const time = data.replace("admin_time_", "");
      SEND_TIME = time;
      scheduleDaily();
      await ctx.answerCbQuery("Vaqt o'zgartirildi");
      await ctx.editMessageText(`✅ Jo'natish vaqti ${SEND_TIME} ga o'rnatildi.`);
    } else if (data === "admin_shutdown") {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [[{ text: "Tasdiqlash: To'xtatish", callback_data: "admin_shutdown_confirm" }], [{ text: "Bekor qilish", callback_data: "admin_cancel" }]]
        }
      };
      await ctx.answerCbQuery();
      await ctx.editMessageText("⚠️ Botni to'xtatishni tasdiqlang:", keyboard);
    } else if (data === "admin_shutdown_confirm") {
      await ctx.editMessageText("🛑 Bot to'xtatildi (admin tomonidan).\nProcess exit...");
      process.exit(0);
    } else if (data === "admin_cancel") {
      await ctx.answerCbQuery("Bekor qilindi");
      await ctx.deleteMessage();
    } else {
      await ctx.answerCbQuery();
    }
  });

  // Validate SEND_TIME and schedule the daily job
  const [hh, mm] = SEND_TIME.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    console.error("SEND_TIME must be HH:MM, like 14:00");
    process.exit(1);
  }
  scheduleDaily();

  bot.catch((err) => console.error("Bot error:", err));

  await bot.launch();
  console.log(`✅ Bot running. Timezone=${TZ} Daily=${SEND_TIME}`);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});