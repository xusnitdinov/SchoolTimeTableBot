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
let SEND_TIME = process.env.SEND_TIME || "18:00";
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "AzizbekEn").replace(/^@/, "");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "";

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

// ===== TIMETABLE =====
const TIMETABLE = {
  1: ["Sinf soati", "Ingliz tili", "Adabiyot", "Algebra", "Informatika", "Geografiya"],
  2: ["Fizika", "Ona tili", "O'zb tarix", "Ingliz tili", "Geometriya", "Jismoniy tarbiya"],
  3: ["Kimyo", "Informatika", "Geografiya", "Algebra", "Fizika", "Rus tili"],
  4: ["Adabiyot", "O'zb tarix", "Biologiya", "Texnologiya", "Geometriya", "Ingliz tili"],
  5: ["Ingliz tili", "Jahon tarixi", "Algebra", "Rus tili", "Fizika", "Tarbiya"],
  6: ["Kimyo", "Biologiya", "Algebra", "San'art", "Geometriya", "Ona tili"],
};

const DAY_NAMES = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];

function formatSubjects(dayIndex, subjects) {
  const title = DAY_NAMES[dayIndex];
  const lines = subjects.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `📚 *${title}* darslari:\n${lines}`;
}

function getTomorrowIndex(now = new Date()) {
  const today = now.getDay();
  if (today === 6) return 1;
  if (today === 0) return 1;
  return today + 1;
}

function getTodayIndex(now = new Date()) {
  return now.getDay();
}

// ===== KEYBOARDS =====
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📌 Bugun", callback_data: "cmd_today" },
        { text: "➡️ Ertaga", callback_data: "cmd_tomorrow" },
      ],
      [
        { text: "📅 To'liq jadval", callback_data: "cmd_full" },
        { text: "⚙️ Sozlamalar", callback_data: "cmd_settings" },
      ],
      [
        { text: "📊 Statistika", callback_data: "cmd_stats" },
        { text: "🛑 Stop", callback_data: "cmd_stop" },
      ],
      [{ text: "ℹ️ Yordam", callback_data: "cmd_help" }],
    ],
  };
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔔 Reminder On/Off", callback_data: "settings_toggle_reminder" },
        { text: "🌍 Til: O'zbek", callback_data: "settings_lang_uz" },
      ],
      [
        { text: "🕒 Reminder vaqti", callback_data: "settings_reminder_time" },
        { text: "🔙 Orqaga", callback_data: "cmd_back" },
      ],
    ],
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Boshqaruv paneli", callback_data: "admin_dashboard" },
        { text: "📢 Broadcast", callback_data: "admin_broadcast" },
      ],
      [
        { text: "📋 Chatlar", callback_data: "admin_list" },
        { text: "🕒 Jo'natish vaqti", callback_data: "admin_set_time" },
      ],
      [
        { text: "📈 Statistika", callback_data: "admin_stats" },
        { text: "🔙 Orqaga", callback_data: "admin_back" },
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
      [
        { text: "20:00", callback_data: "admin_time_20:00" },
        { text: "Custom", callback_data: "admin_time_custom" },
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
      last_start_ts INTEGER DEFAULT 0,
      reminder_enabled INTEGER DEFAULT 1,
      reminder_time TEXT DEFAULT '18:00',
      language TEXT DEFAULT 'uz',
      first_name TEXT,
      username TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_interaction_ts INTEGER DEFAULT 0
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_username TEXT,
      action TEXT,
      payload TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS banned_chats (
      chat_id INTEGER PRIMARY KEY,
      reason TEXT DEFAULT '',
      banned_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      chat_id INTEGER,
      data TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Helper functions
  async function upsertChat(chatId, firstName = "", username = "") {
    await db.run(
      `INSERT INTO chats(chat_id, first_name, username) VALUES (?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username`,
      chatId,
      firstName,
      username
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

  async function setLastInteraction(chatId) {
    await db.run(`UPDATE chats SET last_interaction_ts = ? WHERE chat_id = ?`, Math.floor(Date.now() / 1000), chatId);
  }

  async function listChats() {
    return db.all(`SELECT chat_id FROM chats`);
  }

  async function isBanned(chatId) {
    const row = await db.get(`SELECT chat_id FROM banned_chats WHERE chat_id = ?`, chatId);
    return !!row;
  }

  async function banChat(chatId, reason = "") {
    await db.run(`INSERT OR REPLACE INTO banned_chats(chat_id, reason) VALUES(?,?)`, chatId, reason);
    // also remove from chats list
    await removeChat(chatId);
  }

  async function unbanChat(chatId) {
    await db.run(`DELETE FROM banned_chats WHERE chat_id = ?`, chatId);
  }

  async function listBanned() {
    return db.all(`SELECT chat_id,reason,banned_at FROM banned_chats ORDER BY banned_at DESC`);
  }

  async function getSetting(key) {
    const row = await db.get(`SELECT value FROM settings WHERE key = ?`, key);
    return row?.value ?? null;
  }

  async function setSetting(key, value) {
    await db.run(
      `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      key,
      String(value)
    );
  }

  async function setPending(adminUsername, action, payload = null) {
    await db.run(`DELETE FROM pending_actions WHERE admin_username = ?`, adminUsername);
    await db.run(
      `INSERT INTO pending_actions(admin_username, action, payload) VALUES(?,?,?)`,
      adminUsername,
      action,
      payload
    );
  }

  async function getPending(adminUsername) {
    return db.get(
      `SELECT * FROM pending_actions WHERE admin_username = ? ORDER BY created_at DESC LIMIT 1`,
      adminUsername
    );
  }

  async function clearPending(adminUsername) {
    await db.run(`DELETE FROM pending_actions WHERE admin_username = ?`, adminUsername);
  }

  async function logStat(eventType, chatId, data = "") {
    await db.run(`INSERT INTO stats(event_type, chat_id, data) VALUES(?,?,?)`, eventType, chatId, data);
  }

  async function getStats() {
    const totalUsers = await db.get(`SELECT COUNT(*) as count FROM chats`);
    const totalInteractions = await db.get(`SELECT COUNT(*) as count FROM stats WHERE event_type='interaction'`);
    const activeToday = await db.get(
      `SELECT COUNT(*) as count FROM chats WHERE last_interaction_ts > ?`,
      Math.floor(Date.now() / 1000) - 86400
    );
    return { totalUsers: totalUsers?.count || 0, totalInteractions: totalInteractions?.count || 0, activeToday: activeToday?.count || 0 };
  }

  // Load SEND_TIME from settings
  const savedSend = await getSetting("SEND_TIME");
  if (savedSend) {
    SEND_TIME = savedSend;
  }

  // get bot username for deep links
  let BOT_USERNAME = null;
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log("Bot username:", BOT_USERNAME);
  } catch (e) {
    console.warn("Could not get bot username:", e?.message || e);
  }

  // ---- SEND FUNCTIONS ----
  async function sendSchedule(chatId, dayIndex) {
    if (dayIndex === 0) return;

    const subjects = TIMETABLE[dayIndex];
    if (!subjects) return;
    // don't send to banned chats
    if (await isBanned(chatId)) return;

    const lastId = await getLastMessage(chatId);
    if (lastId) {
      try {
        await bot.telegram.deleteMessage(chatId, lastId);
      } catch (_) {}
    }

    const text = formatSubjects(dayIndex, subjects);

    const sent = await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: mainMenuKeyboard().inline_keyboard },
    });

    await setLastMessage(chatId, sent.message_id);
    await logStat("interaction", chatId, "view_schedule");
  }

  async function sendFullTimetable(chatId) {
    const lines = [];
    for (let d = 1; d <= 6; d++) {
      lines.push(`*${DAY_NAMES[d]}*`);
      (TIMETABLE[d] || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push("");
    }
    const text = `📚 *To'liq dars jadvali*\n\n${lines.join("\n")}`;
    if (await isBanned(chatId)) return;
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: mainMenuKeyboard().inline_keyboard },
    });
    await logStat("interaction", chatId, "view_full_timetable");
  }

  // ---- CRON ----
  let cronTask = null;
  function scheduleDaily() {
    if (cronTask) {
      try {
        cronTask.destroy();
      } catch (_) {}
    }

    const [hh, mm] = SEND_TIME.split(":").map((x) => parseInt(x, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) {
      console.error("SEND_TIME must be HH:MM");
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
    const firstName = ctx.from?.first_name || "";
    const username = ctx.from?.username || "";

    const now = Math.floor(Date.now() / 1000);
    const lastTs = await getLastStartTs(chatId);
    if (now - lastTs < 10) {
      return ctx.reply("Biroz kuting 🙂");
    }

    // If in a group and user is not admin, do not allow subscribe here.
    if (ctx.chat.type && ctx.chat.type !== "private") {
      if (username !== ADMIN_USERNAME) {
        // send a private chat deep-link button so users go DM the bot instead
        const botLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;
        const buttons = botLink
          ? { reply_markup: { inline_keyboard: [[{ text: "📩 Shaxsiy suhbatga o'tish", url: botLink }]] } }
          : { reply_markup: { inline_keyboard: [[{ text: "📩 Yozish (ochilmaydi)", callback_data: "noop" }]] } };
        return ctx.reply("Iltimos, bot bilan shaxsiy suhbatda muloqot qiling. Tugmani bosing:", buttons);
      }
      // admin in group: allow admin panel
      await upsertChat(chatId, firstName, username);
    } else {
      await upsertChat(chatId, firstName, username);
    }
    await setLastStartTs(chatId, now);
    await setLastInteraction(chatId);
    await logStat("start", chatId, "");

    return ctx.reply(`✅ Bot tayyor.\n👋 Salom ${firstName || "do'st"}!\n\nQuyidagi tugmalarni bosing 👇`, {
      reply_markup: { inline_keyboard: mainMenuKeyboard().inline_keyboard },
    });
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
    const firstName = ctx.from?.first_name || "do'st";

    try {
      await ctx.answerCbQuery();
    } catch (_) {}

    await setLastInteraction(chatId);

    // ---- USER MENU ----
    if (data === "cmd_today") {
      await upsertChat(chatId, firstName);
      const dayIndex = getTodayIndex(new Date());
      if (dayIndex === 0) {
        return ctx.reply("😴 Yakshanba — dars yo'q.", { reply_markup: mainMenuKeyboard() });
      }
      await ctx.reply(`Salom ${firstName}! 📌 Bugungi darslar:`);
      await sendSchedule(chatId, dayIndex);
      return;
    }

    if (data === "cmd_tomorrow") {
      await upsertChat(chatId, firstName);
      const dayIndex = getTomorrowIndex(new Date());
      await ctx.reply(`Salom ${firstName}! ➡️ Ertangi darslar:`);
      await sendSchedule(chatId, dayIndex);
      return;
    }

    if (data === "cmd_full") {
      await upsertChat(chatId, firstName);
      await ctx.reply(`Salom ${firstName}! 📅 To'liq jadval:`);
      await sendFullTimetable(chatId);
      return;
    }

    if (data === "cmd_settings") {
      await ctx.reply("⚙️ Sozlamalar:", { reply_markup: settingsKeyboard() });
      return;
    }

    if (data === "cmd_stats") {
      const stats = await getStats();
      await ctx.reply(
        `📊 *Bot Statistikasi*\n\n` +
          `👥 Foydalanuvchilar: ${stats.totalUsers}\n` +
          `💬 Jami o'zaro muloqot: ${stats.totalInteractions}\n` +
          `🔥 Bugun faol: ${stats.activeToday}`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (data === "cmd_stop") {
      await removeChat(chatId);
      await logStat("stop", chatId, "");
      await ctx.reply("🛑 Obuna bekor qilindi.\nQayta yoqish uchun /start.", { reply_markup: { inline_keyboard: [] } });
      return;
    }

    if (data === "cmd_help") {
      await ctx.reply(
        `ℹ️ *Yordam*\n` +
          `• "Bugun" — bugungi darslar\n` +
          `• "Ertaga" — ertangi darslar\n` +
          `• "To'liq jadval" — hafta jadvali\n` +
          `• "Sozlamalar" — reminder va tili\n` +
          `• "Statistika" — bot statistikasi\n` +
          `• "Stop" — obunani bekor qilish\n\n` +
          `Admin: /admin`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (data === "cmd_back") {
      await ctx.reply("🔙 Asosiy menyu:", { reply_markup: mainMenuKeyboard() });
      return;
    }

    // ---- SETTINGS ----
    if (data === "settings_toggle_reminder") {
      const chat = await db.get(`SELECT reminder_enabled FROM chats WHERE chat_id = ?`, chatId);
      const newVal = chat?.reminder_enabled ? 0 : 1;
      await db.run(`UPDATE chats SET reminder_enabled = ? WHERE chat_id = ?`, newVal, chatId);
      const status = newVal ? "✅ Yoqilgan" : "🔇 O'chirilgan";
      await ctx.reply(`🔔 Reminder: ${status}`, { reply_markup: settingsKeyboard() });
      return;
    }

    if (data === "settings_lang_uz") {
      await db.run(`UPDATE chats SET language = ? WHERE chat_id = ?`, "uz", chatId);
      await ctx.reply(`🌍 Til: O'zbek tanlandi`, { reply_markup: settingsKeyboard() });
      return;
    }

    if (data === "settings_reminder_time") {
      await setPending(from || String(chatId), "user_reminder_time_wait");
      await ctx.reply(
        `🕒 Reminder vaqtini shu formatda yuboring: HH:MM\nMasalan: 07:00\n\n/cancel bilan bekor qiling.`
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

      if (data === "admin_dashboard") {
        const stats = await getStats();
        const chats = await listChats();
        await ctx.reply(
          `📊 *Admin Boshqaruv Paneli*\n\n` +
            `👥 Jami foydalanuvchilar: ${chats.length}\n` +
            `💬 Jami muloqot: ${stats.totalInteractions}\n` +
            `🔥 Bugun faol: ${stats.activeToday}\n` +
            `🕒 Jo'natish vaqti: ${SEND_TIME}\n\n` +
            `Boshqa amallarga admin panelini ishlating.`,
          { parse_mode: "Markdown", reply_markup: adminKeyboard() }
        );
        return;
      }

      if (data === "admin_list") {
        const chats = await listChats();
        const pageSize = 10;
        const page = 0;
        const start = page * pageSize;
        const pageItems = chats.slice(start, start + pageSize);
        if (pageItems.length === 0) return ctx.reply("Hech qanday chat topilmadi.");

        const lines = pageItems.map((c, i) => `${start + i + 1}. ${c.chat_id}`).join("\n");
        const rows = pageItems.map((c) => [{ text: `❌ ${c.chat_id}`, callback_data: `admin_remove_${c.chat_id}` }]);
        rows.push([{ text: "🔙 Orqaga", callback_data: "admin_back" }]);
        await ctx.answerCbQuery();
        await ctx.editMessageText(`🔎 Chatlar: ${chats.length} ta\n\n${lines}`, {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }

      if (data === "admin_broadcast") {
        await setPending(from, "broadcast_wait");
        return ctx.reply(
          "📣 Iltimos, yuboriladigan xabar matnini shu chatga yuboring.\n\n/cancel bilan bekor qiling.",
          { reply_markup: { inline_keyboard: [] } }
        );
      }

      if (data === "admin_set_time") {
        await setPending(from, "set_time_wait");
        return ctx.reply("🕒 Vaqtni tanlang yoki HH:MM formatida yuboring:", {
          reply_markup: { inline_keyboard: adminTimeKeyboard().inline_keyboard },
        });
      }

      if (data === "admin_stats") {
        const stats = await getStats();
        const chats = await listChats();
        await ctx.reply(
          `📈 *Chuqur Statistika*\n\n` +
            `👥 Foydalanuvchilar: ${chats.length}\n` +
            `💬 Jami muloqot: ${stats.totalInteractions}\n` +
            `🔥 Bugun faol: ${stats.activeToday}\n` +
            `🕐 Hozirgi jo'natish vaqti: ${SEND_TIME}`,
          { parse_mode: "Markdown", reply_markup: adminKeyboard() }
        );
        return;
      }

      if (data && data.startsWith("admin_time_")) {
        const time = data.replace("admin_time_", "");
        if (time !== "custom") {
          SEND_TIME = time;
          scheduleDaily();
          await setSetting("SEND_TIME", SEND_TIME);
          return ctx.reply(`✅ Jo'natish vaqti yangilandi: ${SEND_TIME}`);
        } else {
          await setPending(from, "set_time_wait");
          return ctx.reply("🕒 Iltimos, HH:MM formatida vaqt yuboring (masalan 08:30):");
        }
      }

      if (data && data.startsWith("admin_remove_")) {
        const id = data.replace("admin_remove_", "");
        try {
          await removeChat(Number(id));
          return ctx.reply(`✅ Chat ${id} o'chirildi.`);
        } catch (e) {
          return ctx.reply(`❌ Xato: ${e?.message || e}`);
        }
      }
    }
  });

  // ===== MESSAGE HANDLER =====
  bot.on("message", async (ctx) => {
    const from = ctx.from?.username || "";
    const text = ctx.message?.text || "";
    const chatId = ctx.chat.id;

    await setLastInteraction(chatId);

    if (text === "/cancel") {
      await clearPending(from || String(chatId));
      return ctx.reply("✅ Bekor qilindi.");
    }

    // User reminder time
    if (text && text.includes(":")) {
      const m = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (m) {
        const pending = await getPending(String(chatId));
        if (pending?.action === "user_reminder_time_wait") {
          const time = `${m[1].padStart(2, "0")}:${m[2]}`;
          await db.run(`UPDATE chats SET reminder_time = ? WHERE chat_id = ?`, time, chatId);
          await clearPending(String(chatId));
          return ctx.reply(`✅ Reminder vaqti o'rnatildi: ${time}`, { reply_markup: settingsKeyboard() });
        }
      }
    }

    const pending = await getPending(from);
    if (!pending) return;

    if (pending.action === "broadcast_wait") {
      const chats = await listChats();
      let sent = 0;
      for (const row of chats) {
        try {
          if (await isBanned(row.chat_id)) continue;
          await bot.telegram.sendMessage(row.chat_id, `📣 *Admin Broadcast*\n\n${text}`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] },
          });
          sent++;
        } catch (_) {}
      }
      await clearPending(from);
      return ctx.reply(`✅ Broadcast yuborildi: ${sent} ta chatga.`);
    }

    if (pending.action === "set_time_wait") {
      const m = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!m) return ctx.reply("❌ Noto'g'ri format. HH:MM formatida yuboring (masalan 08:30) yoki /cancel.");
      const time = `${m[1].padStart(2, "0")}:${m[2]}`;
      SEND_TIME = time;
      scheduleDaily();
      await setSetting("SEND_TIME", SEND_TIME);
      await clearPending(from);
      return ctx.reply(`✅ Jo'natish vaqti yangilandi: ${SEND_TIME}`);
    }
  });

  bot.catch((err) => console.error("Bot error:", err));

  // ===== WEBHOOK SERVER =====
  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => res.status(200).send("OK ✅ Bot is alive"));

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
