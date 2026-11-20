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
const SECTORS = JSON.parse(fs.readFileSync("stocks.json", "utf8"));
const ALL = [...new Map(SECTORS.flatMap((x) => [...x.stocks, ...(x.etfs || [])]).map((x) => [x.s, x])).values()];
const UA = { "User-Agent": "Mozilla/5.0" };
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = async (url, opt) => { const r = await fetch(url, opt); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

// 讀取上一版資料（保留走勢、新聞、分析）
let prev = {};
try { prev = await getJSON(`${SITE}/data.json?t=${Date.now()}`); } catch { console.log("no previous data"); }

async function quotesMIS() {
  let cookie = "";
  try {
    const r = await fetch("https://mis.twse.com.tw/stock/index.jsp", { headers: UA });
    cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  } catch {}
  const ex = ALL.map((x) => `tse_${x.s}.tw`).join("|");
  const d = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}&json=1&delay=0&_=${Date.now()}`,
    { headers: { ...UA, Cookie: cookie, Referer: "https://mis.twse.com.tw/stock/index.jsp" } });
  const out = {};
  for (const m of d.msgArray || []) {
    const y = num(m.y); if (y == null) continue;
    const last = num(m.z) ?? y;
    out[m.c] = { price: last, prev: y, change: last - y, pct: ((last - y) / y) * 100, hi: num(m.h), lo: num(m.l) };
  }
  return out;
}

async function quotesDayClose() {
  const rows = await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
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
if (Object.keys(fresh).length < ALL.length / 2) {
  try { fresh = { ...(await quotesDayClose()), ...fresh }; console.log("using day-close fallback"); }
  catch (e) { console.error("fallback failed:", e.message); }
}
if (!Object.keys(fresh).length) { console.error("no quotes; abort"); process.exit(1); }

lap(`報價完成（${Object.keys(fresh).length}/${ALL.length} 檔）`);
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
if (KEY) {
  const aiTotal = ALL.filter((x) => SLOW || !analysis[x.s]).length;
  let aiDone = 0;
  lap(`開始 AI 分析，共 ${aiTotal} 檔，型號 ${MODEL}`);
  // 優化：每批 6 檔合併成 1 次請求（56 次 → 約 10 次），並加上熔斷與時間預算
  const BATCH = 6;
  const AI_BUDGET_MS = (parseFloat(process.env.AI_BUDGET_MIN) || 12) * 60000;
  const aiStart = Date.now();
  const todo = ALL.filter((x) => SLOW || !analysis[x.s]);
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
fs.writeFileSync("public/data.json", JSON.stringify({ updated: now, sectors: SECTORS, quotes, fundamentals, analysis }));
lap(`全部完成：${Object.keys(quotes).length} 檔報價、${Object.keys(analysis).length} 篇分析`);
