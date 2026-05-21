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

/** Цена всегда с центами: $220.61 */
function formatMoneyCompact(currency, value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  const s = num.toFixed(2);
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

function sessionFields(label, price, change, pct) {
  if (price == null || Number.isNaN(Number(price))) return null;
  return { label, price, change: change ?? null, pct: pct ?? null };
}

/** Yahoo quoteSummary (formatted) отдаёт числа в { raw }, иначе — как есть. */
function yahooNum(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && value.raw != null) {
    const n = Number(value.raw);
    return Number.isNaN(n) ? null : n;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** В quoteSummary change% — доля (0.0124 = 1.24%); в quote() — уже проценты. */
function yahooChangePercent(value) {
  const n = yahooNum(value);
  if (n == null) return null;
  if (typeof value === "object" && value.raw != null) return n * 100;
  return n;
}

function normalizeQuoteSummaryPrice(p) {
  if (!p) return null;
  const prev = yahooNum(p.regularMarketPreviousClose);
  return {
    currency: p.currency,
    marketState: p.marketState,
    regularMarketPrice: yahooNum(p.regularMarketPrice),
    regularMarketChange: yahooNum(p.regularMarketChange),
    regularMarketChangePercent: yahooChangePercent(p.regularMarketChangePercent),
    regularMarketPreviousClose: prev,
    previousClose: prev,
    preMarketPrice: yahooNum(p.preMarketPrice),
    preMarketChange: yahooNum(p.preMarketChange),
    preMarketChangePercent: yahooChangePercent(p.preMarketChangePercent),
    postMarketPrice: yahooNum(p.postMarketPrice),
    postMarketChange: yahooNum(p.postMarketChange),
    postMarketChangePercent: yahooChangePercent(p.postMarketChangePercent),
    overnightMarketPrice: yahooNum(p.overnightMarketPrice),
    overnightMarketChange: yahooNum(p.overnightMarketChange),
    overnightMarketChangePercent: yahooChangePercent(
      p.overnightMarketChangePercent,
    ),
  };
}

function overnightSessionFields(q) {
  if (q?.overnightMarketPrice == null) return null;
  return sessionFields(
    "PM",
    q.overnightMarketPrice,
    q.overnightMarketChange,
    q.overnightMarketChangePercent,
  );
}

/** Локальное правило: в будни после 05:00 показываем premarket, иначе postmarket. */
function pickExtendedByLocalClock(q, now = new Date()) {
  const day = now.getDay(); // 0=Sun ... 6=Sat
  const isWorkday = day >= 1 && day <= 5;
  const hour = now.getHours();
  const preferPre = isWorkday && hour >= 5;

  if (preferPre && q?.preMarketPrice != null) {
    return sessionFields(
      "PM",
      q.preMarketPrice,
      q.preMarketChange,
      q.preMarketChangePercent,
    );
  }
  if (q?.postMarketPrice != null) {
    return sessionFields(
      "PM",
      q.postMarketPrice,
      q.postMarketChange,
      q.postMarketChangePercent,
    );
  }
  if (q?.preMarketPrice != null) {
    return sessionFields(
      "PM",
      q.preMarketPrice,
      q.preMarketChange,
      q.preMarketChangePercent,
    );
  }
  return null;
}

/** Актуальная цена «сейчас» по marketState (Yahoo Finance, incl. overnight). */
function pickCurrentSession(q) {
  const st = String(q?.marketState || "").toUpperCase();

  if (st === "OVERNIGHT") {
    const on = overnightSessionFields(q);
    if (on) return on;
  }
  if (st === "REGULAR") {
    return sessionFields(
      "M",
      q?.regularMarketPrice,
      q?.regularMarketChange,
      q?.regularMarketChangePercent,
    );
  }
  if (st === "PRE" || st === "PREPRE") {
    const byClock = pickExtendedByLocalClock(q);
    if (byClock) return byClock;
    const on = overnightSessionFields(q);
    if (on) return on;
  }
  if (st === "POST" || st === "POSTPOST") {
    const byClock = pickExtendedByLocalClock(q);
    if (byClock) return byClock;
    const on = overnightSessionFields(q);
    if (on) return on;
  }
  const on = overnightSessionFields(q);
  if (on) return on;
  const byClock = pickExtendedByLocalClock(q);
  if (byClock) return byClock;
  return sessionFields(
    "M",
    q?.regularMarketPrice,
    q?.regularMarketChange,
    q?.regularMarketChangePercent,
  );
}

/** Вчерашнее закрытие RTH — вторая строка, когда «сейчас» уже пре/пост. */
function pickReferenceSession(q, current) {
  const reg = q?.regularMarketPrice;
  if (reg == null || current?.price == null) return null;
  if (Math.abs(Number(current.price) - Number(reg)) <= 1e-4) return null;

  const st = String(q?.marketState || "").toUpperCase();
  const extended =
    st === "PRE" ||
    st === "PREPRE" ||
    st === "POST" ||
    st === "POSTPOST" ||
    st === "CLOSED" ||
    current.label === "PM";
  if (!extended && st === "REGULAR") return null;

  return sessionFields(
    "M",
    reg,
    q?.regularMarketChange,
    q?.regularMarketChangePercent,
  );
}

function formatQuote(symbol, q, _fetchedAtMs = Date.now()) {
  const currency = q?.currency || "";
  const current = pickCurrentSession(q);
  if (!current) {
    const fallback =
      q?.regularMarketPreviousClose ??
      q?.previousClose ??
      q?.postMarketPrice ??
      q?.preMarketPrice;
    if (fallback == null) {
      return `Не смог получить цену для ${symbol}. Попробуй другой тикер (например: /quote AAPL).`;
    }
    const prev = q?.regularMarketPreviousClose ?? q?.previousClose;
    const ch = prev != null ? Number(fallback) - Number(prev) : null;
    const pct =
      ch != null && prev != null && prev !== 0 ? (ch / Number(prev)) * 100 : null;
    const line = compactSessionLine("M", currency, fallback, ch, pct);
    return [`${symbol}:`, line].filter(Boolean).join("\n");
  }

  const lines = [
    `${symbol}:`,
    compactSessionLine(
      current.label,
      currency,
      current.price,
      current.change,
      current.pct,
    ),
  ];

  const ref = pickReferenceSession(q, current);
  if (ref) {
    lines.push(
      compactSessionLine(ref.label, currency, ref.price, ref.change, ref.pct),
    );
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Как на сайте Yahoo: overnight/pre/post/close.
 * Обычный quote() не отдаёт overnight — только quoteSummary?overnightPrice=true.
 */
async function fetchYahooQuoteSummary(symbol) {
  const price = await yahooFinance._moduleExec({
    moduleName: "quoteSummaryOvernight",
    query: {
      assertSymbol: symbol,
      url: "https://${YF_QUERY_HOST}/v10/finance/quoteSummary/" + symbol,
      needsCrumb: true,
      definitions: { type: "object", properties: {} },
      schemaKey: "#/definitions/QuoteSummaryOptions",
      defaults: {},
      overrides: {
        modules: "price",
        formatted: "true",
        overnightPrice: "true",
      },
      transformWith: (o) => o,
    },
    result: {
      definitions: { type: "object", properties: {} },
      schemaKey: "#/definitions/QuoteSummaryResult",
      transformWith: (r) => r?.quoteSummary?.result?.[0]?.price,
    },
    moduleOptions: { validateOptions: false, validateResult: false },
  });
  const normalized = normalizeQuoteSummaryPrice(price);
  if (!normalized?.regularMarketPrice && !normalized?.overnightMarketPrice) {
    throw new Error("empty quoteSummary price");
  }
  return normalized;
}

async function getQuote(symbol) {
  try {
    return await fetchYahooQuoteSummary(symbol);
  } catch (e) {
    console.warn("quoteSummary overnight failed, fallback quote()", {
      symbol,
      err: e?.message || e,
    });
    return await yahooFinance.quote(symbol);
  }
}

function isAllowed(ctx) {
  if (ALLOWED_CHAT_IDS.size === 0) return true;
  const chatId = String(ctx.chat?.id ?? "");
  return ALLOWED_CHAT_IDS.has(chatId);
}

function isReplyMessage(ctx) {
  return Boolean(ctx.message?.reply_to_message);
}

function isReplyToBotMessage(ctx) {
  const replied = ctx.message?.reply_to_message;
  if (!replied) return false;
  return Boolean(replied.from?.is_bot);
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) return;
  if (isReplyMessage(ctx) && !isReplyToBotMessage(ctx)) return;

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
  ["NVDA", "AMZN", "GOOGL"],
  ["ASTS", "RKLB", "BMNR"],
  ["NOW", "CRWV", "SBET"]
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
  const list = [];
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