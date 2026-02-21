import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import cron from "node-cron";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const TZ = process.env.TZ || "Asia/Tashkent";
let SEND_TIME = process.env.SEND_TIME || "18:00"; // HH:MM
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "AzizbekEn").replace(/^@/, "");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || ""; // set in Choreo after you get public URL

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== TIMETABLE =====
const TIMETABLE = {
  1: ["Sinf soati", "Ingliz tili", "Adabiyot", "Algebra", "Informatika", "Geografiya"], // Mon
  2: ["Fizika", "Ona tili", "O'zb tarix", "Ingliz tili", "Geometriya", "Jismoniy tarbiya"], // Tue
  3: ["Kimyo", "Informatika", "Geografiya", "Algebra", "Fizika", "Rus tili"], // Wed
  4: ["Adabiyot", "O'zb tarix", "Biologiya", "Texnologiya", "Geometriya", "Ingliz tili"], // Thu
  5: ["Ingliz tili", "Jahon tarixi", "Algebra", "Rus tili", "Fizika", "Tarbiya"], // Fri
  6: ["Kimyo", "Biologiya", "Algebra", "San'at", "Geometriya", "Ona tili"], // Sat
};

const DAY_NAMES = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];

function formatSubjects(dayIndex, subjects) {
  const title = DAY_NAMES[dayIndex];
  const lines = subjects.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `📚 *${title}* darslari:\n${lines}`;
}

function getTomorrowIndex(now = new Date()) {
  const today = now.getDay(); // 0..6
  if (today === 6) return 1; // Sat -> Mon (skip Sun)
  if (today === 0) return 1; // Sun -> Mon
  return today + 1;
}

function getTodayIndex(now = new Date()) {
  return now.getDay();
}

// ===== KEYBOARDS (GREY BUTTONS) =====
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📌 Bugun", callback_data: "cmd_today" },
        { text: "➡️ Ertaga", callback_data: "cmd_tomorrow" },
      ],
      [
        { text: "📅 To'liq jadval", callback_data: "cmd_full" },
        { text: "🛑 Stop", callback_data: "cmd_stop" },
      ],
      [{ text: "ℹ️ Yordam", callback_data: "cmd_help" }],
    ],
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📢 Broadcast (ertaga)", callback_data: "admin_broadcast" },
        { text: "📋 Chatlar ro'yxati", callback_data: "admin_list" },
      ],
      [
        { text: "🕒 Vaqtni o'zgartirish", callback_data: "admin_set_time" },
        { text: "🔙 Menu", callback_data: "admin_back" },
      ],
    ],
  };
}

function adminTimeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "08:00", callback_data: "admin_time_08:00" },
        { text: "12:00", callback_data: "admin_time_12:00" },
        { text: "18:00", callback_data: "admin_time_18:00" },
      ],
      [{ text: "🔙 Orqaga", callback_data: "admin_back" }],
    ],
  };
}

// ===== MAIN =====
async function main() {
  // ---- DB ----
  const db = await open({ filename: "./bot.db", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      last_message_id INTEGER DEFAULT NULL,
      last_start_ts INTEGER DEFAULT 0
    );
  `);

  async function upsertChat(chatId) {
    await db.run(
      `INSERT INTO chats(chat_id) VALUES (?)
       ON CONFLICT(chat_id) DO NOTHING`,
      chatId
    );
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

  async function setLastStartTs(chatId, ts) {
    await db.run(`UPDATE chats SET last_start_ts = ? WHERE chat_id = ?`, ts, chatId);
  }

  async function getLastStartTs(chatId) {
    const row = await db.get(`SELECT last_start_ts FROM chats WHERE chat_id = ?`, chatId);
    return row?.last_start_ts ?? 0;
  }

  async function listChats() {
    return db.all(`SELECT chat_id FROM chats`);
  }

  // ---- SEND FUNCTIONS ----
  async function sendSchedule(chatId, dayIndex) {
    if (dayIndex === 0) return;

    const subjects = TIMETABLE[dayIndex];
    if (!subjects) return;

    // delete previous timetable message
    const lastId = await getLastMessage(chatId);
    if (lastId) {
      try {
        await bot.telegram.deleteMessage(chatId, lastId);
      } catch (_) {}
    }

    const text = formatSubjects(dayIndex, subjects);

    const sent = await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });

    await setLastMessage(chatId, sent.message_id);
  }

  async function sendFullTimetable(chatId) {
    const lines = [];
    for (let d = 1; d <= 6; d++) {
      lines.push(`*${DAY_NAMES[d]}*`);
      (TIMETABLE[d] || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push("");
    }
    const text = `📚 *To'liq dars jadvali*\n\n${lines.join("\n")}`;
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
  }

  // ---- CRON (optional) ----
  let cronTask = null;
  function scheduleDaily() {
    if (cronTask) {
      try {
        cronTask.destroy();
      } catch (_) {}
    }

    const [hh, mm] = SEND_TIME.split(":").map((x) => parseInt(x, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) {
      console.error("SEND_TIME must be HH:MM, like 18:00");
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
          } catch (_) {}
        }
      },
      { timezone: TZ }
    );
  }
  scheduleDaily();

  // ===== COMMANDS =====
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;

    // rate limit start
    const now = Math.floor(Date.now() / 1000);
    const lastTs = await getLastStartTs(chatId);
    if (now - lastTs < 10) {
      return ctx.reply("Biroz kuting 🙂");
    }

    await upsertChat(chatId);
    await setLastStartTs(chatId, now);

    return ctx.reply(
      `✅ Bot tayyor.\nQuyidagi tugmalarni bosing 👇`,
      { reply_markup: mainMenuKeyboard() }
    );
  });

  bot.command("admin", async (ctx) => {
    const from = ctx.from?.username || "";
    if (from !== ADMIN_USERNAME) return ctx.reply("Siz admin emassiz.");

    return ctx.reply("⚙️ Admin panel:", { reply_markup: adminKeyboard() });
  });

  // ===== BUTTON HANDLER =====
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data || "";
    const chatId = ctx.chat.id;
    const from = ctx.from?.username || "";

    // always answer to remove Telegram loading spinner
    try {
      await ctx.answerCbQuery();
    } catch (_) {}

    // ---- USER MENU ----
    if (data === "cmd_today") {
      await upsertChat(chatId);
      const dayIndex = getTodayIndex(new Date());
      if (dayIndex === 0) return ctx.reply("😴 Yakshanba — dars yo'q.", { reply_markup: mainMenuKeyboard() });
      await sendSchedule(chatId, dayIndex);
      return;
    }

    if (data === "cmd_tomorrow") {
      await upsertChat(chatId);
      const dayIndex = getTomorrowIndex(new Date());
      await sendSchedule(chatId, dayIndex);
      return;
    }

    if (data === "cmd_full") {
      await upsertChat(chatId);
      await sendFullTimetable(chatId);
      return;
    }

    if (data === "cmd_stop") {
      await removeChat(chatId);
      await ctx.reply("🛑 Obuna bekor qilindi.\nQayta yoqish uchun /start.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (data === "cmd_help") {
      await ctx.reply(
        `ℹ️ *Yordam*\n` +
          `• "Bugun" — bugungi darslar\n` +
          `• "Ertaga" — ertangi darslar\n` +
          `• "To'liq jadval" — hafta jadvali\n` +
          `• "Stop" — obunani bekor qilish\n\n` +
          `Admin: /admin`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // ---- ADMIN MENU ----
    if (data.startsWith("admin_")) {
      if (from !== ADMIN_USERNAME) {
        return ctx.reply("Ruxsat yo'q.");
      }

      if (data === "admin_back") {
        return ctx.reply("⚙️ Admin panel:", { reply_markup: adminKeyboard() });
      }

      if (data === "admin_list") {
        const chats = await listChats();
        const ids = chats.map((c) => c.chat_id).slice(0, 50);
        return ctx.reply(`📋 Chatlar: ${chats.length}\nIDs(1-50): ${ids.join(", ")}`);
      }

      if (data === "admin_broadcast") {
        const dayIndex = getTomorrowIndex(new Date());
        const chats = await listChats();
        let sent = 0;
        for (const row of chats) {
          try {
            await sendSchedule(row.chat_id, dayIndex);
            sent++;
          } catch (_) {}
        }
        return ctx.reply(`✅ Broadcast tugadi. Yuborildi: ${sent} chatga.`);
      }

      if (data === "admin_set_time") {
        return ctx.reply("🕒 Vaqtni tanlang:", { reply_markup: adminTimeKeyboard() });
      }

      if (data.startsWith("admin_time_")) {
        const time = data.replace("admin_time_", "");
        SEND_TIME = time;
        scheduleDaily();
        return ctx.reply(`✅ Jo'natish vaqti yangilandi: ${SEND_TIME}`);
      }
    }
  });

  bot.catch((err) => console.error("Bot error:", err));

  // ===== WEBHOOK SERVER (Choreo friendly) =====
  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => res.status(200).send("OK ✅ Bot is alive"));

  // manual trigger (for scheduler)
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
        } catch (_) {}
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

    if (!BASE_URL) {
      console.log("⚠️ BASE_URL missing. Set BASE_URL in Choreo env vars then redeploy.");
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