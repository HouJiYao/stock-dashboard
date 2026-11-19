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

## 排程（台北時間，平日）
- 08:30 新聞、基本面、AI 分析 ＋ 報價
- 09:00–13:59 每 10 分鐘更新報價（GitHub 排程常延遲數分鐘到十幾分鐘）
- 14:00 收盤價

## 注意
- 證交所即時報價可能擋 GitHub 的海外 IP；被擋時自動退回開放資料的收盤價（頁面變成收盤後更新）。
- 公開儲存庫 60 天無活動，排程會被 GitHub 暫停，到 Actions 頁面點 Enable 即可。
- 增減個股：改 `stocks.json`（僅支援上市股票）。
- Gemini 型號可用環境變數 `GEMINI_MODEL` 調整。
