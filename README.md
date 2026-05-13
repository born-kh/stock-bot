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

## Commands

- `/start` — help
- `/quote <TICKER>` — example: `/quote NVDA`
- `/nvda` — shortcut
