# 台股產業龍頭儀表板（完全免費版）

架構：GitHub Actions 定時抓資料 → 產生 `public/data.json` → 部署到 Firebase Hosting（Spark 免費方案即可，不需 Blaze）。

## 設定步驟
1. **建立公開 GitHub 儲存庫**，把本資料夾全部推上去（公開儲存庫的 Actions 免費、不限時數）。
2. **Firebase Hosting 授權**：在本資料夾執行
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase init hosting:github
   ```
   選你的儲存庫；問到「build script」答 No、「deploy on merge」答 No，且**不要覆蓋**已有的 `update.yml`。它會自動在 GitHub 建立 secret `FIREBASE_SERVICE_ACCOUNT_STOCK_DASHBOARD_A2324`。
3. **Gemini 免費金鑰**：到 https://aistudio.google.com/app/apikey 建立，於 GitHub → Settings → Secrets and variables → Actions 新增 `GEMINI_API_KEY`。（不設則略過 AI 分析）
4. 到 GitHub → Actions → update-data → **Run workflow**（slow 保持 true）。完成後開啟 https://stock-dashboard-a2324.web.app

## 盤中即時報價（富果 Fugle API + Cloudflare Worker，免費）
網頁在盤中（平日 08:55–13:35）每 20 秒向 Worker 取「目前畫面上」個股／ETF 的即時報價；其餘時間照舊讀 `data.json`。
1. 註冊 Cloudflare（免費）。在本資料夾的 `worker` 目錄執行：
   ```bash
   cd worker
   npx wrangler login
   npx wrangler secret put FUGLE_API_KEY   # 貼上富果 API 金鑰
   npx wrangler deploy
   ```
2. 部署完成會顯示網址，例如 `https://stock-live.xxx.workers.dev`。先開 `…/debug?symbol=2330` 確認富果有回資料（status 200）。
3. 把網址填到 `public/index.html` 的 `const LIVE_URL=""`，再部署 Firebase（推上 GitHub 等下次 Actions，或 `firebase deploy --only hosting`）。
- 金鑰只存在 Cloudflare secret，**不要寫進任何檔案**（本儲存庫是公開的）。
- 若方案支援全市場快照（`snapshot`），一次請求拿全部；不支援時自動改逐檔查詢，每分鐘最多 50 次。
- 只允許 `wrangler.toml` 的 `ALLOW_ORIGINS` 網域呼叫 Worker。

## 排程（台北時間，平日）
- 08:30 新聞、基本面、AI 分析 ＋ 報價
- 09:00–13:59 每 10 分鐘更新報價（GitHub 排程常延遲數分鐘到十幾分鐘）
- 14:00 收盤價＋新聞

## 注意
- 證交所即時報價可能擋 GitHub 的海外 IP；被擋時自動退回開放資料的收盤價（頁面變成收盤後更新）。
- 公開儲存庫 60 天無活動，排程會被 GitHub 暫停，到 Actions 頁面點 Enable 即可。
- 增減個股：改 `stocks.json`（僅支援上市股票）。
- Gemini 型號可用環境變數 `GEMINI_MODEL` 調整。
