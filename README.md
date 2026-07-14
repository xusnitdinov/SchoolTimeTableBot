# SchoolTimeTableBot

Telegram bot for a school class timetable (Uzbek UI). Students can check today's / tomorrow's lessons, see duty students (*navbatchilar*), and get daily reminder messages.

Built with **Telegraf**, **SQLite**, and **node-cron**. Designed for private chats with optional webhook hosting (e.g. Choreo / Express).

## Features

- Inline menu: today, tomorrow, yesterday, full week
- Navbatchilar (group duty leaders) by weekday
- Daily scheduled reminders (default timezone `Asia/Tashkent`)
- Per-chat reminder on/off and reminder time settings
- Admin panel (`/admin`): broadcast, chat list, stats, send-time control
- SQLite persistence (`bot.db`) for chats, bans, settings, stats
- Express webhook server when `BASE_URL` is set (polling otherwise)

## Stack

| Piece | Package |
|---|---|
| Bot | `telegraf` |
| HTTP / webhook | `express` |
| Schedule | `node-cron` |
| DB | `sqlite` + `sqlite3` |
| Config | `dotenv` |

## Setup

1. Clone and install:

```bash
npm install
```

2. Create a `.env` file:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_USERNAME=YourTelegramUsername
TZ=Asia/Tashkent
SEND_TIME=15:00
PORT=8000
# Optional webhook deploy:
# BASE_URL=https://your-host.example
# WEBHOOK_SECRET=change-me
```

3. Edit the hard-coded timetable / navbatchilar in `index.js` if needed (`TIMETABLE`, `NAVBATCHILAR`).

4. Run:

```bash
npm start
```

## Main commands / buttons

| Action | What it does |
|---|---|
| `/start` | Register chat + quick buttons |
| Bugun / Ertaga / Kecha | Show that day's lessons |
| To'liq jadval | Full weekly timetable |
| Navbatchilar | Duty students for the day |
| Sozlamalar | Reminder toggle / time |
| `/admin` | Admin tools (username must match `ADMIN_USERNAME`) |
| Stop | Stop bot interaction / reminders for that chat |

## Project layout

```
index.js           Bot + Express + cron + SQLite logic
package.json       Dependencies and start script
bot.db             Created at runtime (not committed)
.env               Secrets (not committed)
```

## Notes

- Timetable content is currently hard-coded for one class schedule - change arrays in `index.js` for another class.
- Prefer private chats; group use is limited by design.
- Keep `BOT_TOKEN` and admin username private.
