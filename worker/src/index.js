// 富果 Fugle 即時報價中繼（Cloudflare Workers 免費方案）
// GET /quotes?symbols=2330,2454,0050  → { t, source, quotes: { "2330": { price, prev, change, pct, hi, lo, t } } }
// GET /debug?symbol=2330              → 富果原始回應（排查用）
// 金鑰放在 Worker secret：npx wrangler secret put FUGLE_API_KEY（不要寫進程式或 GitHub）

const API = "https://api.fugle.tw/marketdata/v1.0/stock";
const TTL = 20_000;          // 同一檔 20 秒內不重抓
const PER_MIN = 50;          // 逐檔模式每分鐘上限（富果免費方案約 60 次/分，留餘裕）
const MAX_SYMBOLS = 60;

// 同一個 Worker 實例內的記憶體快取（workers.dev 網域無法用 Cache API）
const cache = new Map();     // symbol -> { q, at }
let calls = [];              // 近 60 秒的請求時間
let snap = { at: 0, map: null, deniedUntil: 0 };

const num = (v) => (v == null || v === "" || !Number.isFinite(+v) ? null : +v);
const ms = (t) => { t = num(t); return t == null ? Date.now() : t > 1e14 ? Math.round(t / 1000) : t; };

function normalize(r) {
  if (!r) return null;
  // 只用真正成交價；開盤前的試撮價（lastTrial）不採用
  const price = num(r.lastPrice) ?? num(r.closePrice) ?? num(r.lastTrade?.price);
  if (price == null) return null;
  const change = num(r.change);
  const prev = num(r.previousClose) ?? num(r.referencePrice) ?? (change != null ? +(price - change).toFixed(2) : null);
  if (prev == null) return null;
  const ch = +(price - prev).toFixed(2);
  return { price, prev, change: ch, pct: num(r.changePercent) ?? (prev ? (ch / prev) * 100 : 0),
    hi: num(r.highPrice), lo: num(r.lowPrice), t: ms(r.lastUpdated), d: r.date || null, closed: !!r.isClose };
}

async function fugle(path, key) {
  calls.push(Date.now());
  const res = await fetch(API + path, { headers: { "X-API-KEY": key } });
  return { status: res.status, body: await res.text() };
}

// 全市場快照：一次請求拿全部（若方案不支援會回 401/403，之後 30 分鐘不再嘗試）
async function snapshot(key) {
  if (Date.now() < snap.deniedUntil) return null;
  if (snap.map && Date.now() - snap.at < TTL) return snap.map;
  const out = {};
  for (const mk of ["TSE", "OTC"]) {
    const r = await fugle(`/snapshot/quotes/${mk}`, key);
    if (r.status === 401 || r.status === 403 || r.status === 404) { snap.deniedUntil = Date.now() + 30 * 60_000; return null; }
    if (r.status !== 200) return snap.map;
    for (const row of JSON.parse(r.body).data || []) { const q = normalize(row); if (q) out[row.symbol] = q; }
  }
  snap = { ...snap, at: Date.now(), map: out };
  return out;
}

async function perSymbol(symbols, key) {
  const now = Date.now();
  calls = calls.filter((t) => now - t < 60_000);
  const stale = symbols.filter((s) => !cache.has(s) || now - cache.get(s).at > TTL)
    .sort((a, b) => (cache.get(a)?.at || 0) - (cache.get(b)?.at || 0));   // 最久沒更新的先抓
  const budget = Math.max(0, PER_MIN - calls.length);
  await Promise.all(stale.slice(0, budget).map(async (s) => {
    try {
      const r = await fugle(`/intraday/quote/${s}`, key);
      if (r.status === 200) { const q = normalize(JSON.parse(r.body)); if (q) cache.set(s, { q, at: Date.now() }); }
    } catch {}
  }));
  return Object.fromEntries(symbols.filter((s) => cache.has(s)).map((s) => [s, cache.get(s).q]));
}

// 當日 5 分 K（富果），同一檔 60 秒內不重抓
const candleCache = new Map();   // symbol -> { at, data }
async function candles(symbol, key, ttl = 60_000) {
  const c = candleCache.get(symbol);
  if (c && Date.now() - c.at < ttl) return c.data;
  const r = await fugle(`/intraday/candles/${symbol}?timeframe=5`, key);
  if (r.status !== 200) return c?.data || null;
  const j = JSON.parse(r.body);
  const pts = (j.data || []).map((k) => ({ t: Date.parse(k.date), p: num(k.close) })).filter((x) => Number.isFinite(x.t) && x.p != null).sort((a, b) => a.t - b.t);
  const data = { d: j.date || null, pts };
  candleCache.set(symbol, { at: Date.now(), data });
  return data;
}

// 新聞（Google 新聞 RSS），同一檔 30 分鐘內不重抓
const newsCache = new Map();     // symbol -> { at, items }
const decode = (t) => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
function parseRss(xml, defSrc) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => {
    const g = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decode(r[1]) : ""; };
    return { title: g("title"), url: g("link"), src: g("source") || defSrc, t: Date.parse(g("pubDate")) || null };
  }).filter((x) => x.title && x.url);
}
async function rss(url, defSrc) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "zh-TW,zh;q=0.9" } });
    return res.ok ? parseRss(await res.text(), defSrc) : [];
  } catch { return []; }
}
// 先找 Google 新聞，抓不到（被擋或查無資料）再改用 Yahoo 股市個股新聞
async function news(symbol, name) {
  const c = newsCache.get(symbol);
  if (c && Date.now() - c.at < 30 * 60_000) return c.items;
  let items = await rss(`https://news.google.com/rss/search?q=${encodeURIComponent(symbol + " " + name)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, "");
  if (!items.length) items = await rss(`https://tw.stock.yahoo.com/rss?s=${symbol}`, "Yahoo股市");
  if (!items.length) return c?.items || null;   // 都抓不到時不覆蓋舊結果
  newsCache.set(symbol, { at: Date.now(), items });
  return items;
}

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allow = (env.ALLOW_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = !allow.length || allow.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { "Access-Control-Allow-Origin": ok ? origin || "*" : allow[0], "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store" };
}
const json = (data, status, h) => new Response(JSON.stringify(data), { status, headers: { ...h, "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    const key = env.FUGLE_API_KEY;
    if (!key) return json({ error: "FUGLE_API_KEY 未設定" }, 500, h);

    if (url.pathname === "/debug") {
      const s = (url.searchParams.get("symbol") || "2330").replace(/[^0-9A-Z]/gi, "");
      const [q, sn] = await Promise.all([fugle(`/intraday/quote/${s}`, key), fugle(`/snapshot/quotes/TSE`, key)]);
      return json({ quote: { status: q.status, body: q.body.slice(0, 1500) }, snapshot: { status: sn.status, body: sn.body.slice(0, 500) } }, 200, h);
    }
    const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
    // 卡片小走勢圖：一次多檔，每檔 4 分鐘內不重抓；額度不夠時先回舊資料，下次再補
    if (url.pathname === "/candles" && url.searchParams.has("symbols")) {
      const list = [...new Set(url.searchParams.get("symbols").split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[0-9A-Z]{4,6}$/.test(x)))].slice(0, 30);
      const now = Date.now(); calls = calls.filter((t) => now - t < 60_000);
      const stale = list.filter((x) => !candleCache.has(x) || now - candleCache.get(x).at > 240_000)
        .sort((a, b) => (candleCache.get(a)?.at || 0) - (candleCache.get(b)?.at || 0));
      const budget = Math.max(0, PER_MIN - 10 - calls.length);   // 保留 10 次給即時報價
      await Promise.all(stale.slice(0, budget).map((x) => candles(x, key, 240_000).catch(() => null)));
      return json({ candles: Object.fromEntries(list.filter((x) => candleCache.has(x)).map((x) => [x, candleCache.get(x).data])) }, 200, h);
    }
    if (url.pathname === "/candles") {
      if (!/^[0-9A-Z]{4,6}$/.test(sym)) return json({ error: "symbol 格式錯誤" }, 400, h);
      try { return json((await candles(sym, key)) || { d: null, pts: [] }, 200, h); } catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    }
    if (url.pathname === "/news") {
      if (!/^[0-9A-Z]{4,6}$/.test(sym)) return json({ error: "symbol 格式錯誤" }, 400, h);
      const name = (url.searchParams.get("name") || "").slice(0, 30);
      try { return json({ items: (await news(sym, name)) || [] }, 200, h); } catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    }
    if (url.pathname !== "/quotes") return json({ ok: true, usage: "/quotes?symbols=2330,2454" }, 200, h);

    const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[0-9A-Z]{4,6}$/.test(s)))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({ error: "請帶 symbols 參數" }, 400, h);

    try {
      const all = await snapshot(key);
      if (all) return json({ t: Date.now(), source: "fugle-snapshot", quotes: Object.fromEntries(symbols.filter((s) => all[s]).map((s) => [s, all[s]])) }, 200, h);
      return json({ t: Date.now(), source: "fugle-quote", quotes: await perSymbol(symbols, key) }, 200, h);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, h);
    }
  },
};
