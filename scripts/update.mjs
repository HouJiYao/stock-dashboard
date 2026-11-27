import fs from "node:fs";

// 單次請求逾時保護：20 秒，避免某個請求卡住拖垮整個流程
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opt = {}) =>
  _fetch(url, { signal: AbortSignal.timeout(20000), ...opt });
const T0 = Date.now();
const lap = (m) => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);

// 台北時間與交易時段：pre 盤前／open 盤中 09:00–13:30／post 盤後／closed 週末
const tpeDate = new Date(Date.now() + 8 * 3600e3);
const rocToday = `${tpeDate.getUTCFullYear() - 1911}${String(tpeDate.getUTCMonth() + 1).padStart(2, "0")}${String(tpeDate.getUTCDate()).padStart(2, "0")}`;
const sameTpeDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) === tpeDate.toISOString().slice(0, 10);
const tpeMin = tpeDate.getUTCHours() * 60 + tpeDate.getUTCMinutes(), tpeWd = tpeDate.getUTCDay();
const PHASE = tpeWd < 1 || tpeWd > 5 ? "closed" : tpeMin < 540 ? "pre" : tpeMin < 810 ? "open" : "post";
const PHASE_NAME = { pre: "盤前（用最新收盤）", open: "盤中（用即時價）", post: "盤後（用當日收盤）", closed: "休市（用最新收盤）" }[PHASE];

const SITE = process.env.SITE_URL;
const SLOW = process.env.SLOW === "true";
const NEWS = process.env.NEWS === "true";   // 收盤後的排程：只重抓新聞
let SECTORS = [];
let ALL = [];
const CFG = JSON.parse(fs.readFileSync("etfs.json", "utf8"));
const TOP_N = parseInt(process.env.TOP_N || "10");
const UA = { "User-Agent": "Mozilla/5.0" };
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = async (url, opt) => { const r = await fetch(url, opt); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

// 讀取上一版資料（保留走勢、新聞、分析）
let prev = {};
try { prev = await getJSON(`${SITE}/data.json?t=${Date.now()}`); } catch { console.log("no previous data"); }
let longPrev = {};
try { longPrev = await getJSON(`${SITE}/charts-long.json?t=${Date.now()}`); } catch {}

// 依證交所官方產業別，取各產業市值前 N 名（市值＝發行股數 × 最新收盤價）
const IND = { "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜", "08": "玻璃陶瓷", "09": "造紙工業", "10": "鋼鐵工業", "11": "橡膠工業", "12": "汽車工業", "14": "建材營造業", "15": "航運業", "16": "觀光餐旅", "17": "金融保險業", "18": "貿易百貨業", "21": "化學工業", "22": "生技醫療業", "23": "油電燃氣業", "24": "半導體業", "25": "電腦及週邊設備業", "26": "光電業", "27": "通信網路業", "28": "電子零組件業", "29": "電子通路業", "30": "資訊服務業", "31": "其他電子業", "35": "綠能環保", "36": "數位雲端", "37": "運動休閒", "38": "居家生活" };
async function buildSectors() {
  const [co, px] = await Promise.all([
    getJSON("https://openapi.twse.com.tw/v1/opendata/t187ap03_L"),
    getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
  ]);
  const price = Object.fromEntries(px.map((r) => [r.Code, num(r.ClosingPrice)]));
  const groups = {};
  for (const c of co) {
    const code = c["公司代號"], ind = String(c["產業別"] ?? "").trim().padStart(2, "0");
    const sh = num(c["已發行普通股數或TDR原股發行股數"]), p = price[code];
    if (!IND[ind] || !sh || !p || !/^\d{4}$/.test(code)) continue;
    (groups[ind] ||= []).push({ s: code, n: c["公司簡稱"], m: "TW", cap: sh * p });
  }
  if (!Object.keys(groups).length) { console.error("產業別欄位格式不符，範例：", JSON.stringify(co[0])); throw new Error("no sectors"); }
  const list = Object.entries(groups).map(([ind, a]) => {
    a.sort((x, y) => y.cap - x.cap);
    const name = IND[ind], e = CFG.etfs?.[name] || {};
    return { name, count: a.length, total: a.reduce((t, x) => t + x.cap, 0),
      stocks: a.slice(0, TOP_N).map(({ s, n, m }) => ({ s, n, m })),
      etfs: (e.list || []).map(([s, n]) => ({ s, n, m: "TW", e: 1 })), note: e.note };
  }).sort((a, b) => b.total - a.total).map(({ total, ...x }) => x);
  for (const x of CFG.extraSectors || [])
    list.push({ name: x.name, stocks: (x.stocks || []).map(([s, n]) => ({ s, n, m: "TW" })), etfs: (x.etfs || []).map(([s, n]) => ({ s, n, m: "TW", e: 1 })), note: x.note });
  return list;
}
if (SLOW || !prev.sectors?.length) {
  try { SECTORS = await buildSectors(); lap(`官方產業別排名完成：${SECTORS.length} 個產業`); }
  catch (e) { console.error("buildSectors failed:", e.message); }
}
if (!SECTORS.length) SECTORS = prev.sectors || [];
if (!SECTORS.length) { console.error("無法取得產業清單，中止"); process.exit(1); }
ALL = [...new Map(SECTORS.flatMap((x) => [...x.stocks, ...(x.etfs || [])]).map((x) => [x.s, x])).values()];

async function quotesMIS() {
  let cookie = "";
  try {
    const r = await fetch("https://mis.twse.com.tw/stock/index.jsp", { headers: UA });
    cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  } catch {}
  const out = {};
  for (let i = 0; i < ALL.length; i += 40) {
    const ex = ALL.slice(i, i + 40).map((x) => `tse_${x.s}.tw`).join("|");
    const d = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}&json=1&delay=0&_=${Date.now()}`,
      { headers: { ...UA, Cookie: cookie, Referer: "https://mis.twse.com.tw/stock/index.jsp" } });
    for (const m of d.msgArray || []) {
      const y = num(m.y); if (y == null) continue;
      // 兩筆成交之間 z 會是 "-"：改用最佳買價／賣價／開盤價，最後才退回昨收
      const first = (v) => num(String(v ?? "").split("_")[0]);
      // 盤後 z 沒有值就不採用 MIS（交給 Yahoo／開放資料），避免把昨收當今天收盤
      const last = PHASE === "open" ? num(m.z) ?? first(m.b) ?? first(m.a) ?? num(m.o) ?? y : num(m.z);
      if (last == null) continue;
      out[m.c] = { price: last, prev: y, change: last - y, pct: ((last - y) / y) * 100, hi: num(m.h), lo: num(m.l), lu: num(m.u), ld: num(m.w) };
    }
    await sleep(300);
  }
  return out;
}

// 開放資料的收盤行情傍晚才換成當日，之前拿到的是上個交易日：日期不是今天就不用
async function quotesDayClose() {
  const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  const date = rows.find((r) => r.Date)?.Date;
  // 盤後只收當日資料；盤前／休市時它就是最新收盤，日期不限
  if (PHASE === "post" && date !== rocToday) { console.log(`STOCK_DAY_ALL 日期 ${date ?? "未知"} 不是今天 ${rocToday}，略過`); return {}; }
  const m = Object.fromEntries(rows.map((r) => [r.Code, r]));
  const out = {};
  for (const { s } of ALL) {
    const r = m[s]; const price = num(r?.ClosingPrice), ch = num(r?.Change);
    if (price == null || ch == null) continue;
    const y = price - ch;
    out[s] = { price, prev: y, change: ch, pct: y ? (ch / y) * 100 : 0, hi: num(r.HighestPrice), lo: num(r.LowestPrice) };
  }
  return out;
}

let fresh = {};
lap(`報價時段：${PHASE_NAME}`);
if (PHASE === "open" || PHASE === "post") {   // 盤前的 MIS 是試撮價，不用
  try { fresh = await quotesMIS(); } catch (e) { console.error("MIS failed:", e.message); }
}
lap(`證交所即時報價：${Object.keys(fresh).length}/${ALL.length} 檔`);

// 走勢圖：Yahoo Finance 免費圖表介面（當日 5 分、近 5 日 15 分、近 3 月日線）
const charts = Object.fromEntries(Object.entries(prev.charts || {}).map(([k, v]) => [k, { d1: v.d1, prev: v.prev }]));
const long = { ...longPrev };
async function yahoo(code, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?range=${range}&interval=${interval}&includePrePost=false`;
  let j;
  try { j = await getJSON(url, { headers: UA }); } catch { await sleep(1500); j = await getJSON(url, { headers: UA }); }
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp || [], cl = r?.indicators?.quote?.[0]?.close || [];
  const pts = [];
  ts.forEach((t, i) => { if (cl[i] != null) pts.push({ t: t * 1000, p: +cl[i].toFixed(2) }); });
  const m = r?.meta || {};
  return { pts, prev: m.chartPreviousClose ?? null,
    quote: num(m.regularMarketPrice) != null && num(m.chartPreviousClose) != null && m.regularMarketTime
      ? { price: num(m.regularMarketPrice), prev: num(m.chartPreviousClose), hi: num(m.regularMarketDayHigh), lo: num(m.regularMarketDayLow), t: m.regularMarketTime * 1000 } : null };
}
let cOk = 0, cFail = 0, cErr = "";
const yq = {};   // Yahoo 的最新價（當日）
const queue = [...ALL];
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const st = queue.shift();
    try {
      const c = { ...(charts[st.s] || {}) };
      const d1 = await yahoo(st.s, "1d", "5m");
      if (d1.pts.length) { c.d1 = d1.pts; if (d1.prev != null) c.prev = d1.prev; }
      // 盤中／盤後只收當日價；盤前／休市時 Yahoo 回的就是最新一個交易日的收盤
      if (d1.quote && (PHASE === "pre" || PHASE === "closed" || sameTpeDay(d1.quote.t))) yq[st.s] = d1.quote;
      if (SLOW || !long[st.s]?.d5) {
        const L = { ...(long[st.s] || {}) };
        const d5 = await yahoo(st.s, "5d", "15m"); if (d5.pts.length) L.d5 = d5.pts;
        const m3 = await yahoo(st.s, "3mo", "1d"); if (m3.pts.length) L.m3 = m3.pts;
        long[st.s] = L;
      }
      charts[st.s] = c; cOk++;
    } catch (e) { cFail++; cErr ||= e.message; }
  }
}));
lap(`走勢圖完成：成功 ${cOk}、失敗 ${cFail}${cErr ? "（" + cErr + "）" : ""}`);

// 報價合併：證交所即時 > Yahoo（當日）> 開放資料收盤（當日）> 沿用上一版
for (const [s, y] of Object.entries(yq)) {
  if (fresh[s]) continue;
  const ch = +(y.price - y.prev).toFixed(2);
  fresh[s] = { price: y.price, prev: y.prev, change: ch, pct: y.prev ? (ch / y.prev) * 100 : 0, hi: y.hi, lo: y.lo };
}
if (PHASE !== "open" && Object.keys(fresh).length < ALL.length) {
  try { fresh = { ...(await quotesDayClose()), ...fresh }; } catch (e) { console.error("day-close fallback failed:", e.message); }
}
if (!Object.keys(fresh).length && !prev.quotes) { console.error("no quotes; abort"); process.exit(1); }
lap(`報價完成（${Object.keys(fresh).length}/${ALL.length} 檔，其餘沿用上一版）`);
const now = Date.now();
const quotes = {};
for (const { s } of ALL) {
  const old = prev.quotes?.[s];
  if (fresh[s]) {
    quotes[s] = { ...fresh[s], updated: now };
  } else if (old) { const { series, ...rest } = old; quotes[s] = rest; }   // 舊版留下的累積走勢不再保存
}

// 基本面 + 新聞（每日一次，或首次缺資料時）
const fundamentals = { ...(prev.fundamentals || {}) };
const need = (s) => SLOW || !fundamentals[s];
let bw = [], co = [];
if (ALL.some((x) => need(x.s))) {
  try { bw = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL"); } catch (e) { console.error("BWIBBU", e.message); }
  try { co = await getJSON("https://openapi.twse.com.tw/v1/opendata/t187ap03_L"); } catch (e) { console.error("t187ap03_L", e.message); }
}
const decode = (t) => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
let newsFail = 0;   // 連續失敗次數：連續 8 檔失敗就視為被擋，其餘直接沿用舊新聞，避免整個排程卡到逾時
async function news(st) {
  if (newsFail >= 8) throw new Error("略過（新聞來源暫時被擋）");
  try { const r = await newsOnce(st); newsFail = 0; return r; } catch (e) { newsFail++; throw e; }
}
async function rssItems(url, defSrc) {
  await sleep(300);   // 放慢速度，避免被判定為大量請求而擋下
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => {
      const g = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decode(r[1]) : ""; };
      return { title: g("title"), url: g("link"), src: g("source") || defSrc, t: Date.parse(g("pubDate")) || null };
    }).filter((x) => x.title && x.url);
  } catch { return []; }
}
// 先找 Google 新聞，抓不到再改用 Yahoo 股市個股新聞
async function newsOnce(st) {
  let items = await rssItems(`https://news.google.com/rss/search?q=${encodeURIComponent(st.s + " " + st.n)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, "");
  if (!items.length) items = await rssItems(`https://tw.stock.yahoo.com/rss?s=${st.s}`, "Yahoo股市");
  if (!items.length) throw new Error("沒有新聞（可能被擋）");   // 丟錯讓呼叫端保留舊新聞，不會被清空
  return items;
}
const fTotal = ALL.filter((x) => need(x.s)).length;
let fDone = 0;
if (fTotal) lap(`開始抓基本面與新聞，共 ${fTotal} 檔`);
for (const st of ALL) {
  if (!need(st.s)) continue;
  console.log(`[基本面/新聞] ${++fDone}/${fTotal} ${st.s} ${st.n}`);
  if (st.e) {
    let items = fundamentals[st.s]?.news || [];
    try { items = await news(st); } catch (e) { console.error("news", st.s, e.message); }
    fundamentals[st.s] = { news: items, updated: now };
    continue;
  }
  const r = bw.find((x) => x.Code === st.s) || {};
  const c = co.find((x) => x["公司代號"] === st.s) || {};
  const shares = num(c["已發行普通股數或TDR原股發行股數"]);
  const price = quotes[st.s]?.price;
  let items = fundamentals[st.s]?.news || [];
  try { items = await news(st); } catch (e) { console.error("news", st.s, e.message); }
  fundamentals[st.s] = { pe: num(r.PEratio), pb: num(r.PBratio), yield: num(r.DividendYield),
    mcap: shares && price ? shares * price : null, news: items, updated: now };
}

if (fTotal) lap("基本面與新聞完成");

// 收盤後再更新一次新聞（基本面不動）
if (NEWS && !SLOW) {
  const list = ALL.filter((x) => !need(x.s));
  lap(`收盤後更新新聞，共 ${list.length} 檔`);
  let nOk = 0;
  for (const st of list) {
    try { fundamentals[st.s] = { ...fundamentals[st.s], news: await news(st) }; nOk++; }
    catch (e) { console.error("news", st.s, e.message); }
  }
  lap(`新聞更新完成：${nOk}/${list.length} 檔`);
}

fs.writeFileSync("public/data.json", JSON.stringify({ updated: now, sectors: SECTORS, quotes, charts, fundamentals }));
fs.writeFileSync("public/charts-long.json", JSON.stringify(long));
lap(`全部完成：${Object.keys(quotes).length} 檔報價`);
