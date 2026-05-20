# stock-bot

Telegram bot to fetch stock quotes via `yahoo-finance2`.

## Setup

1. Install deps:

```bash
npm i
```

2. Create `.env`:

```bash
cp .env.example .env
```

Set `BOT_TOKEN` in `.env`.

## Run

```bash
npm start
```

## PM2 (server)

```bash
npm run server
```

Useful commands:

- `npm run server:status` - PM2 status
- `npm run server:logs` - live logs
- `npm run server:restart` - restart bot
- `npm run server:stop` - stop bot
- `npm run server:save` - save current PM2 process list
- `npm run server:resurrect` - restore saved PM2 process list

### Windows Server auto-start after reboot

Run once as Administrator:

```bash
npm run server
npm run server:startup:windows
```

This creates a Scheduled Task (`stock-bot-pm2-resurrect`) that runs on system startup and executes `npx pm2 resurrect`.

## Commands

- `/start` — help
- `/quote <TICKER>` — example: `/quote NVDA`
- `/nvda` — shortcut
