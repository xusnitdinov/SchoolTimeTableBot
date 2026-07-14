# School TimeTable Bot

Telegram bot that sends a class their daily timetable and *navbatchilar* (duty students) - in Uzbek.

Built for one school class: open the bot in a private chat, tap **Bugun / Ertaga**, get today’s or tomorrow’s lessons, and optionally get a daily reminder at a set time (default `Asia/Tashkent`).

## Why it exists

Paper schedules get lost. Group chats get noisy. This bot keeps the week’s lessons and duty list one tap away, with optional auto-reminders so people don’t forget navbatchilik.

## Features

- Today / tomorrow / yesterday lesson lists
- Full weekly timetable
- Navbatchilar by weekday
- Per-user reminder on/off + reminder time
- Admin panel: broadcast, chat list, stats, global send time
- SQLite storage for chats, bans, settings, and stats
- Polling locally, or Express webhook when `BASE_URL` is set (easy to host on Choreo / similar)

## Stack

| Piece | Tech |
|---|---|
| Bot | Telegraf |
| HTTP / webhook | Express |
| Schedule | node-cron |
| Database | SQLite (`sqlite` + `sqlite3`) |
| Config | dotenv |

## Setup

```bash
git clone https://github.com/xusnitdinov/SchoolTimeTableBot.git
cd SchoolTimeTableBot
npm install
```

Create `.env`:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_USERNAME=YourTelegramUsername
TZ=Asia/Tashkent
SEND_TIME=15:00
PORT=8000

# Optional (webhook deploy):
# BASE_URL=https://your-host.example
# WEBHOOK_SECRET=change-me
```

Edit `TIMETABLE` and `NAVBATCHILAR` in `index.js` for your class, then:

```bash
npm start
```

## How people use it

| Action | Result |
|---|---|
| `/start` | Registers the chat and shows quick buttons |
| Bugun / Ertaga / Kecha | That day's subjects |
| To'liq jadval | Whole week |
| Navbatchilar | Duty students |
| Sozlamalar | Reminder toggle / time |
| Stop | Opt out of reminders / bot use |
| `/admin` | Admin tools (must match `ADMIN_USERNAME`) |

## Layout

```
index.js        Bot logic, cron jobs, SQLite, Express webhook
package.json    Dependencies + npm start
bot.db          Created at runtime (local data)
.env            Secrets (do not commit)
```

## Limits

- Timetable is hard-coded for one class - swap the arrays for another class.
- Best in private chats; full group support is limited on purpose.
- Never commit `BOT_TOKEN` or real student data.
