import fs from "node:fs";

// 單次請求逾時保護：一般 20 秒、Gemini 60 秒，避免某個請求卡住拖垮整個流程
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opt = {}) =>
  _fetch(url, { signal: AbortSignal.timeout(String(url).includes("generativelanguage") ? 90000 : 20000), ...opt });
const T0 = Date.now();
const lap = (m) => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);

const SITE = process.env.SITE_URL;
const SLOW = process.env.SLOW === "true";
const KEY = process.env.GEMINI_API_KEY;
let MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
let SECTORS = [];
let ALL = [];
const CFG = JSON.parse(fs.readFileSync("etfs.json", "utf8"));
const TOP_N = parseInt(process.env.TOP_N || "10");
const AI_TOP = parseInt(process.env.AI_TOP || "3");
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
// AI 分析範圍：每個產業市值前 AI_TOP 名 + 全部 ETF
const aiSet = new Set(SECTORS.flatMap((x) => [...x.stocks.slice(0, x.count ? AI_TOP : x.stocks.length).map((y) => y.s), ...(x.etfs || []).map((y) => y.s)]));

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
      const last = num(m.z) ?? first(m.b) ?? first(m.a) ?? num(m.o) ?? y;
      out[m.c] = { price: last, prev: y, change: last - y, pct: ((last - y) / y) * 100, hi: num(m.h), lo: num(m.l), lu: num(m.u), ld: num(m.w) };
    }
    await sleep(300);
  }
  return out;
}

// 今天的台北日期（民國年格式，例如 1151123）
const tpeDate = new Date(Date.now() + 8 * 3600e3);
const rocToday = `${tpeDate.getUTCFullYear() - 1911}${String(tpeDate.getUTCMonth() + 1).padStart(2, "0")}${String(tpeDate.getUTCDate()).padStart(2, "0")}`;
const sameTpeDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) === tpeDate.toISOString().slice(0, 10);

// 開放資料的收盤行情傍晚才換成當日，之前拿到的是上個交易日：日期不是今天就不用
async function quotesDayClose() {
  const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  const date = rows.find((r) => r.Date)?.Date;
  if (date !== rocToday) { console.log(`STOCK_DAY_ALL 日期 ${date ?? "未知"} 不是今天 ${rocToday}，略過`); return {}; }
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
try { fresh = await quotesMIS(); } catch (e) { console.error("MIS failed:", e.message); }
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
      if (d1.quote && sameTpeDay(d1.quote.t)) yq[st.s] = d1.quote;
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
if (Object.keys(fresh).length < ALL.length) {
  try { fresh = { ...(await quotesDayClose()), ...fresh }; } catch (e) { console.error("day-close fallback failed:", e.message); }
}
if (!Object.keys(fresh).length && !prev.quotes) { console.error("no quotes; abort"); process.exit(1); }
lap(`報價完成（${Object.keys(fresh).length}/${ALL.length} 檔，其餘沿用上一版）`);
const now = Date.now();
const quotes = {};
for (const { s } of ALL) {
  const old = prev.quotes?.[s];
  if (fresh[s]) {
    const series = (old?.series || []).concat({ t: now, p: fresh[s].price }).slice(-400);
    quotes[s] = { ...fresh[s], series, updated: now };
  } else if (old) quotes[s] = old;
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
async function news(st) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(st.s + " " + st.n)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const xml = await (await fetch(url, { headers: UA })).text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => {
    const g = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decode(r[1]) : ""; };
    return { title: g("title"), url: g("link"), src: g("source"), t: Date.parse(g("pubDate")) || null };
  });
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

// 模型下架（404）時，自動從 ListModels 挑選可用的 flash 模型
async function pickModel() {
  try {
    const j = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}&pageSize=200`);
    const c = (j.models || [])
      .filter((m) => /flash/.test(m.name) && !/lite|image|tts|live|audio|thinking|preview|exp/.test(m.name) && m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", "")).sort().reverse();
    return c[0] || null;
  } catch { return null; }
}

// AI 分析（Gemini 免費額度，每日一次）
const analysis = { ...(prev.analysis || {}) };
// 只在每日 08:30（或手動 slow=true）做 AI 分析；盤中報價更新不補做，避免拖慢部署
if (KEY && (SLOW || process.env.AI === "true")) {
  const aiTotal = ALL.filter((x) => aiSet.has(x.s) && (SLOW || !analysis[x.s])).length;
  let aiDone = 0;
  lap(`開始 AI 分析，共 ${aiTotal} 檔，型號 ${MODEL}`);
  // 優化：每批 6 檔合併成 1 次請求（56 次 → 約 10 次），並加上熔斷與時間預算
  const BATCH = 6;
  const AI_BUDGET_MS = (parseFloat(process.env.AI_BUDGET_MIN) || 12) * 60000;
  const aiStart = Date.now();
  const todo = ALL.filter((x) => aiSet.has(x.s) && (SLOW || !analysis[x.s]));
  const line = (st) => {
    const q = quotes[st.s], f = fundamentals[st.s] || {};
    const heads = (f.news || []).slice(0, 3).map((n) => n.title).join("；") || "無";
    const recent = (q?.series || []).filter((_, i) => i % 5 === 0).map((x) => x.p).slice(-20).join(",");
    const fund = st.e ? "" : `｜本益比 ${f.pe ?? "無資料"}｜股價淨值比 ${f.pb ?? "無資料"}｜殖利率 ${f.yield ?? "無資料"}%`;
    return `- 代號 ${st.s}｜${st.n}｜${st.e ? "ETF" : "個股"}｜現價 ${q?.price}｜漲跌 ${q?.pct?.toFixed(2)}%｜近期價格 ${recent}${fund}｜新聞：${heads}`;
  };
  const batchPrompt = (batch) =>
    `你是台股分析助理。請以繁體中文，為下列每一檔各寫約120字的當前分析：走勢觀察、${"個股看基本面評價、ETF看追蹤主題與成分重點"}、新聞重點、需留意的風險。` +
    `只依據提供的數據、新聞標題與一般知識；不確定的資訊請說明不確定，不要編造數字與新聞細節；每則結尾註明僅供參考、非投資建議。\n` +
    `只輸出一個 JSON 物件，鍵為代號、值為該檔的分析文字，不要輸出其他文字。\n${batch.map(line).join("\n")}`;

  // 429／5xx 指數退避重試；若為「每日額度用完」則立刻放棄
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  async function callGemini(prompt) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
        });
        if (res.status === 404) {
          const alt = await pickModel();
          if (alt && alt !== MODEL) { console.log(`model ${MODEL} unavailable, switching to ${alt}`); MODEL = alt; continue; }
        }
        if (RETRYABLE.has(res.status)) {
          const body = await res.text();
          if (res.status === 429 && /PerDay|per day|daily/i.test(body)) throw new Error("QUOTA_DAY");
          const wait = Math.min(10000 * 2 ** attempt, 60000);
          console.log(`  … 伺服器忙碌或限流（${res.status}），${wait / 1000} 秒後重試（${attempt + 1}/4）`);
          await sleep(wait); continue;
        }
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || null;
      } catch (e) {
        if (e.message === "QUOTA_DAY") throw e;
        console.error(`  ✗ ${e.name === "TimeoutError" ? "逾時" : e.message}，重試（${attempt + 1}/4）`);
        await sleep(5000);
      }
    }
    return null;
  }

  let fails = 0;
  const nBatch = Math.ceil(todo.length / BATCH);
  for (let i = 0; i < todo.length; i += BATCH) {
    if (Date.now() - aiStart > AI_BUDGET_MS) { lap("AI 分析超過時間預算，停止（其餘沿用舊分析）"); break; }
    const batch = todo.slice(i, i + BATCH);
    console.log(`[AI 分析] 批次 ${i / BATCH + 1}/${nBatch}：${batch.map((x) => x.s).join(", ")}`);
    let ok = 0;
    try {
      const text = await callGemini(batchPrompt(batch));
      const obj = text ? JSON.parse(text.replace(/^```json|```$/g, "").trim()) : {};
      for (const st of batch) {
        const t = obj[st.s];
        if (typeof t === "string" && t.trim()) { analysis[st.s] = { text: t.trim(), updated: now }; ok++; }
      }
    } catch (e) {
      if (e.message === "QUOTA_DAY") { lap("Gemini 每日額度已用完，停止 AI 分析（其餘沿用舊分析）"); break; }
      console.error("  ✗ 批次失敗：", e.message);
    }
    console.log(`  ✓ ${ok}/${batch.length} 檔完成`);
    fails = ok ? 0 : fails + 1;
    if (fails >= 2) { lap("連續 2 批失敗，停止 AI 分析（其餘沿用舊分析，下次執行會再補）"); break; }
    await sleep(8000);
  }
}

lap("AI 分析階段結束");
fs.writeFileSync("public/data.json", JSON.stringify({ updated: now, sectors: SECTORS, quotes, charts, fundamentals, analysis, aiCodes: [...aiSet] }));
fs.writeFileSync("public/charts-long.json", JSON.stringify(long));
lap(`全部完成：${Object.keys(quotes).length} 檔報價、${Object.keys(analysis).length} 篇分析`);
