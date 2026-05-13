const { Telegraf, Markup } = require("telegraf");
const YahooFinance = require("yahoo-finance2").default;

require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error(
    "Missing BOT_TOKEN. Create a .env file (see .env.example) and set BOT_TOKEN.",
  );
}

const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const bot = new Telegraf(BOT_TOKEN);
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

// Simple in-memory cache (0 = always fetch fresh quote from Yahoo)
const quoteCache = new Map(); // symbol -> { ts, data }
const _ttl = Number(process.env.QUOTE_TTL_MS);
const QUOTE_TTL_MS =
  process.env.QUOTE_TTL_MS === undefined || process.env.QUOTE_TTL_MS === ""
    ? 0
    : Number.isFinite(_ttl) && _ttl >= 0
      ? _ttl
      : 0;

// Lightweight per-chat rate limit
const lastRequestByChat = new Map(); // chatId -> ms
const MIN_REQUEST_INTERVAL_MS = Number(
  process.env.MIN_REQUEST_INTERVAL_MS || 1_000,
);

function normalizeSymbol(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 15);
}

/** Для USD показываем $ вместо текста USD */
function currencyDisplayPrefix(currency) {
  const c = String(currency || "").trim().toUpperCase();
  if (c === "USD") return "$";
  if (!c) return "";
  return `${c} `;
}

/** Короткая цена: $220 или $12.18 */
function formatMoneyCompact(currency, value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  const d = Math.abs(num) >= 100 ? 0 : 2;
  let s = num.toFixed(d);
  if (d > 0) s = s.replace(/\.?0+$/, "");
  return `${currencyDisplayPrefix(currency)}${s}`;
}

/** Изменение без $: +15 или -6.4 (целые, если близко к целому) */
function formatDeltaPlain(change) {
  if (change == null || Number.isNaN(Number(change))) return null;
  const n = Number(change);
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) < 0.05) {
    if (rounded > 0) return `+${rounded}`;
    if (rounded < 0) return `${rounded}`;
    return "0";
  }
  const abs = Math.abs(n);
  let body = abs.toFixed(2).replace(/\.?0+$/, "");
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return "0";
}

/**
 * Yahoo `*ChangePercent` уже в процентах: 0.61 → 0.61%, 12 → 12%.
 * Не умножать на 100 — иначе 0.61 превращается в «61%».
 */
function formatPctParen(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  const p = Number(pct);
  const rounded = Math.round(p * 100) / 100;
  const inner = rounded.toFixed(2).replace(/\.?0+$/, "");
  return `(${inner}%)`;
}

function compactSessionLine(label, currency, price, change, changePct) {
  if (price == null || Number.isNaN(Number(price))) return null;
  const pr = formatMoneyCompact(currency, price);
  const d = formatDeltaPlain(change);
  const p = formatPctParen(changePct);
  if (d && p) return `${label}: ${pr}, ${d} ${p}`;
  if (d) return `${label}: ${pr}, ${d}`;
  if (p) return `${label}: ${pr}, ${p}`;
  return `${label}: ${pr}`;
}

/** Пре/пост для строки PM */
function pickExtendedSession(q) {
  const st = String(q?.marketState || "").toUpperCase();
  const reg = q?.regularMarketPrice;
  if ((st === "POST" || st === "POSTPOST") && q?.postMarketPrice != null) {
    return {
      price: q.postMarketPrice,
      change: q.postMarketChange,
      pct: q.postMarketChangePercent,
    };
  }
  if ((st === "PRE" || st === "PREPRE") && q?.preMarketPrice != null) {
    return {
      price: q.preMarketPrice,
      change: q.preMarketChange,
      pct: q.preMarketChangePercent,
    };
  }
  if (
    q?.postMarketPrice != null &&
    reg != null &&
    Math.abs(Number(q.postMarketPrice) - Number(reg)) > 1e-4
  ) {
    return {
      price: q.postMarketPrice,
      change: q.postMarketChange,
      pct: q.postMarketChangePercent,
    };
  }
  if (
    q?.preMarketPrice != null &&
    reg != null &&
    Math.abs(Number(q.preMarketPrice) - Number(reg)) > 1e-4
  ) {
    return {
      price: q.preMarketPrice,
      change: q.preMarketChange,
      pct: q.preMarketChangePercent,
    };
  }
  return null;
}

function formatQuote(symbol, q, _fetchedAtMs = Date.now()) {
  const currency = q?.currency || "";
  const reg = q?.regularMarketPrice;
  if (reg == null && q?.preMarketPrice == null && q?.postMarketPrice == null) {
    return `Не смог получить цену для ${symbol}. Попробуй другой тикер (например: /quote AAPL).`;
  }

  const fallbackPrice = q?.regularMarketPreviousClose ?? q?.previousClose;
  const leftPrice = reg ?? fallbackPrice;
  if (leftPrice == null) {
    return `Не смог получить цену для ${symbol}. Попробуй другой тикер (например: /quote AAPL).`;
  }

  const mLine = compactSessionLine(
    "M",
    currency,
    leftPrice,
    q.regularMarketChange ?? null,
    q.regularMarketChangePercent ?? null,
  );

  const lines = [`${symbol}:`, mLine];

  const ext = pickExtendedSession(q);
  if (ext?.price != null) {
    const regNum = reg != null ? Number(reg) : NaN;
    const extNum = Number(ext.price);
    const showPm =
      !Number.isFinite(regNum) || Math.abs(extNum - regNum) > 1e-6;
    if (showPm) {
      const pmLine = compactSessionLine(
        "PM",
        currency,
        ext.price,
        ext.change ?? null,
        ext.pct ?? null,
      );
      if (pmLine) lines.push(pmLine);
    }
  }

  return lines.filter(Boolean).join("\n");
}

async function getQuote(symbol) {
  const cached = quoteCache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.ts < QUOTE_TTL_MS) return cached.data;

  const data = await yahooFinance.quote(symbol);
  quoteCache.set(symbol, { ts: now, data });
  return data;
}

function isAllowed(ctx) {
  if (ALLOWED_CHAT_IDS.size === 0) return true;
  const chatId = String(ctx.chat?.id ?? "");
  return ALLOWED_CHAT_IDS.has(chatId);
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) return;

  const chatId = String(ctx.chat?.id ?? "");
  const now = Date.now();
  const last = lastRequestByChat.get(chatId) || 0;
  if (now - last < MIN_REQUEST_INTERVAL_MS) return;
  lastRequestByChat.set(chatId, now);

  return await next();
});

bot.catch((err, ctx) => {
  console.error("Bot error", err);
  // Best-effort reply
  if (ctx?.reply) ctx.reply("Что-то пошло не так. Попробуй ещё раз чуть позже.");
});

const QUICK_TICKERS = [
  ["AAPL", "MSFT", "GOOGL"],
  ["NVDA", "TSLA", "AMZN"],
  ["META", "BTC-USD", "ETH-USD"],
  ["ASTS", "OKLO"],
];

function flatQuickTickers() {
  return [...new Set(QUICK_TICKERS.flat())];
}

/** Telegram: command = 1–32 символов [a-z0-9_] */
function tickerToCommand(ticker) {
  const c = ticker.toLowerCase().replace(/[^a-z0-9]/g, "");
  return c ? c.slice(0, 32) : null;
}

const TICKER_BY_COMMAND = new Map();
for (const sym of flatQuickTickers()) {
  const cmd = tickerToCommand(sym);
  if (!cmd) continue;
  TICKER_BY_COMMAND.set(cmd, sym);
}

function buildMyCommands() {
  const list = [
    { command: "start", description: "Справка" },
    { command: "help", description: "Справка" },
    { command: "quote", description: "Цена или клавиатура тикеров" },
  ];
  const used = new Set(list.map((c) => c.command));
  for (const [cmd, sym] of TICKER_BY_COMMAND) {
    if (used.has(cmd)) continue;
    used.add(cmd);
    list.push({ command: cmd, description: `Цена ${sym}` });
  }
  return list.slice(0, 100);
}

function helpText() {
  return [
    "Я показываю цену по тикеру.",
    "",
    "Как пользоваться:",
    "- Нажми / — выбери команду с тикером (/aapl, /nvda, /btcusd …).",
    "- Или: /quote NVDA",
    "- Или просто текстом: NVDA",
  ].join("\n");
}

function hideKeyboard() {
  return Markup.removeKeyboard();
}

bot.start((ctx) => ctx.reply(helpText(), hideKeyboard()));
bot.command("help", (ctx) => ctx.reply(helpText(), hideKeyboard()));

async function replyQuote(ctx, symbol) {
  const clean = normalizeSymbol(symbol);
  if (!clean) {
    await ctx.reply(
      "Открой меню / и выбери тикер (например /aapl) или напиши: /quote AAPL",
      hideKeyboard(),
    );
    return;
  }

  try {
    const fetchedAt = Date.now();
    const data = await getQuote(clean);
    await ctx.reply(formatQuote(clean, data, fetchedAt), hideKeyboard());
  } catch (e) {
    console.error("quote error", { symbol: clean, e });
    await ctx.reply(
      `Не получилось получить цену для ${clean}. Проверь тикер и попробуй ещё раз.`,
      hideKeyboard(),
    );
  }
}

for (const [cmd, sym] of TICKER_BY_COMMAND) {
  bot.command(cmd, async (ctx) => {
    await replyQuote(ctx, sym);
  });
}

bot.command("quote", async (ctx) => {
  const text = ctx.message?.text || "";
  const [, ...rest] = text.split(/\s+/);
  const raw = rest.join(" ").trim();
  if (!raw) {
    await ctx.reply(
      "Открой меню / — там список тикеров. Или так: /quote AAPL",
      hideKeyboard(),
    );
    return;
  }
  await replyQuote(ctx, raw);
});

bot.hears(/^[a-zA-Z.^=-]{1,15}$/, async (ctx) => {
  await replyQuote(ctx, ctx.message?.text);
});

async function main() {
  const cmds = buildMyCommands();
  try {
    await bot.telegram.setMyCommands(cmds);
    await bot.telegram.setMyCommands(cmds, {
      scope: { type: "all_private_chats" },
    });
    await bot.telegram.setMyCommands(cmds, {
      scope: { type: "all_group_chats" },
    });
    await bot.telegram.setChatMenuButton({
      menu_button: { type: "commands" },
    });
  } catch (e) {
    console.warn("Telegram menu/commands:", e?.message || e);
  }
  await bot.launch();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));