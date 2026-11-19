import fs from "node:fs";

const SITE = process.env.SITE_URL;
const SLOW = process.env.SLOW === "true";
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const SECTORS = JSON.parse(fs.readFileSync("stocks.json", "utf8"));
const ALL = SECTORS.flatMap((x) => x.stocks);
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
    out[m.c] = { price: last, change: last - y, pct: ((last - y) / y) * 100, hi: num(m.h), lo: num(m.l) };
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
    out[s] = { price, change: ch, pct: y ? (ch / y) * 100 : 0, hi: num(r.HighestPrice), lo: num(r.LowestPrice) };
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
for (const st of ALL) {
  if (!need(st.s)) continue;
  const r = bw.find((x) => x.Code === st.s) || {};
  const c = co.find((x) => x["公司代號"] === st.s) || {};
  const shares = num(c["已發行普通股數或TDR原股發行股數"]);
  const price = quotes[st.s]?.price;
  let items = fundamentals[st.s]?.news || [];
  try { items = await news(st); } catch (e) { console.error("news", st.s, e.message); }
  fundamentals[st.s] = { pe: num(r.PEratio), pb: num(r.PBratio), yield: num(r.DividendYield),
    mcap: shares && price ? shares * price : null, news: items, updated: now };
}

// AI 分析（Gemini 免費額度，每日一次）
const analysis = { ...(prev.analysis || {}) };
if (KEY) {
  for (const st of ALL) {
    if (!(SLOW || !analysis[st.s])) continue;
    const q = quotes[st.s], f = fundamentals[st.s] || {};
    const heads = (f.news || []).map((n) => "- " + n.title).join("\n") || "（無）";
    const recent = (q?.series || []).filter((_, i) => i % 5 === 0).map((x) => x.p).slice(-30).join(", ");
    const prompt = `請以繁體中文，為台股「${st.n}（${st.s}）」寫約150字的當前分析。最新價 ${q?.price}，漲跌幅 ${q?.pct?.toFixed(2)}%，近期價格序列：${recent}。` +
      `基本面：本益比 ${f.pe ?? "無資料"}、股價淨值比 ${f.pb ?? "無資料"}、殖利率 ${f.yield ?? "無資料"}%。近期新聞標題：\n${heads}\n` +
      `內容含：走勢觀察、基本面評價、新聞重點、產業地位、需留意的風險。只依據提供的數據、標題與一般知識，標題以外的新聞細節不要編造，結尾註明僅供參考、非投資建議。`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (res.status === 429) { await sleep(30000); continue; }
        const j = await res.json();
        const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
        if (text) analysis[st.s] = { text, updated: now };
        else console.error("gemini empty", st.s, JSON.stringify(j).slice(0, 200));
        break;
      } catch (e) { console.error("gemini", st.s, e.message); break; }
    }
    await sleep(5000);
  }
}

fs.writeFileSync("public/data.json", JSON.stringify({ updated: now, sectors: SECTORS, quotes, fundamentals, analysis }));
console.log("done", Object.keys(quotes).length, "quotes");
