---
tags: [dev-guide-zh, flow]
aliases: [自訂列印標籤, Custom Print Label]
---

# 自訂列印標籤 Custom Print Label(交接中,未實作)

**現況:只有佔位頁。** 頁面能選 CSV、顯示檔名/大小,沒有解析、沒有渲染、沒有列印。後端**沒有任何改動**,也不需要(設計方向是純前端處理)。

給接手的開發者:先寫 spec + plan(`docs/superpowers/specs/`、`plans/`,見 AGENTS.md §Feature workflow),再動手。

## 1. 現有程式碼位置

| 位置 | 內容 |
|------|------|
| `apps/admin/pages/custom-print-label.vue` | 佔位頁:`<input type="file" accept=".csv">`,只記錄 `fileName` / `fileSize` |
| `apps/admin/utils/entities.ts` | 側邊欄連結 `/custom-print-label`,放在 **Dropdown & Policy**(`Label Print Rules` 之後) |
| `layers/i18n/i18n/locales/{en-US,zh-HK,zh-CN}.ts` | `admin.navLinks.customPrintLabel`、`admin.pages.customPrintLabel.*`(三個語系都要同步加字) |
| `docs/uat/functions.json` ADM-039 | UAT 功能條目(狀態:佔位) |

## 2. 待做(建議順序)

1. **解析 CSV**:瀏覽器端讀 `File.text()` 自己切(不要為幾行解析加依賴)。處理 BOM、CRLF、引號內逗號、欄位數不符 → 明確報錯行號。表頭即欄位名,至少要有「主文字 + QR 內容」兩欄。
2. **預覽表格**:解析後列出前 N 行 + 總張數,讓使用者確認欄位對應再印(對錯欄位直接印出幾百張錯標籤)。
3. **渲染標籤**:重用 `apps/admin/utils/print.ts`。目前只有「左邊一行大字 + 右邊 QR」的 cell(`drawLabelCell` / `renderStockLabelPng`,私有),多欄位標籤需要擴充或另寫 renderer;沿用同一個 `LabelCell` + `LabelLayout` 概念與 `labelSizePx()`/`activeLabelSizes`,不要另建一套尺寸表。
4. **列印**:`listPrinters()` 選機(localStorage key 建議 `custom_label_printer`,不要跟既有的 `label_printer` / `doc_printer` 搶)→ `printFile(blob, filename, { printer })` → `waitForPrintJob(jobId)` 輪詢。多張 = 一次一個 job。
5. **可選**:沿用 A4 批次模式(`renderShelfBatchPagePng` 的 grid 邏輯)做「A4 拼版 + 下載 PDF」(`downloadPagesAsPdf`)。

## 3. 列印鏈路(照抄既有頁面,不要新開通道)

```
瀏覽器 canvas → PNG blob → POST /print/files (multipart, 經後端 /print/* 代理)
                                 → 上游標籤列印服務(PRINT_API_BASE_URL)
                                 → GET /print/jobs/:jobId 輪詢
```

- 前端**永不直連**列印服務;一律 `apps/admin/utils/print.ts`(已封裝 JWT、錯誤、超時)。
- 一次 job 只能一個檔案 —— 多頁/多張要逐個送,或先拼成一張 A4 頁面 PNG。
- 參考實作:`components/PrintLabelsDialog.vue`(單張)、`components/ShelfBatchPrintDialog.vue`(A4 批次 + 縮放)、`components/PrintDocumentDialog.vue`(多頁文件)。

## 4. 動手前要定的事(先問需求方)

| 問題 | 影響 |
|------|------|
| CSV 欄位規格?(目前無人提供範例檔) | 解析與欄位對應的全部設計 |
| 標籤是「QR + 一行字」還是多欄位排版? | 只需重用 `drawLabelCell`,還是要新 renderer |
| 標籤尺寸 = 倉庫既有目錄(`activeLabelSizes`,HK `a4-24` / SZ 四種)還是自訂 mm? | 尺寸目錄現在按 `warehouseCode` 分,新增尺寸要改 `LABEL_SIZES` |
| 要不要留列印紀錄? | 現在 `label_prints` 只記 PDA 揀貨標籤;自訂標籤若要稽核就得加後端 |

## 5. 坑

- **畫布字型**:`ctx.fillText` 在 webfont 未載入時會靜默用系統字型,各機器印出來不一樣 → 畫之前 `await ensureLabelTextFont()`。
- **300 dpi**:`labelSizePx()` 已按 300 dpi 換算;自己算 px 會印出錯尺寸。SZ 尺寸另帶 `renderScale`(1.05)抵印表機自動縮放,別重複補償。
- **印表機 key 是 `serviceId|deviceKey` 成對**,用 `parsePrinterKey` 拆;記住的機台可能已下線,送出前仍會照原值打(既有行為)。
- **不要為 CSV 解析加套件**,專案已裝 `exceljs`(xlsx)但 CSV 用 `File.text()` + 手寫切分即可。
- admin 是桌面瀏覽器,Chrome 101 限制(AGENTS.md)主要針對 PDA WebView;但 `utils/print.ts` 是共用的,不要在其中引入新 Web API。

## 6. 完成時要一併更新的文件

1. spec + plan:`docs/superpowers/specs/YYYY-MM-DD-custom-print-label-design.md`、`plans/…`。
2. `docs/app-docs/ai/code-map.md`、`ai/feature-registry.md`(把 Custom Print Label 那行的 Planned 改成 Shipped + 實際檔案)。
3. `apps/admin/TOC.md`。
4. `docs/uat/functions.json` ADM-039(`remarks` 補 commit / spec),再跑 `node scripts/gen-uat-xlsx.mjs`。
5. 本文件:改成正式流程文件(流程圖 / 步驟表 / 決策 / 坑),或刪掉並在 `README.md` §6 改指向新 spec。

## 7. 參考

- [打印标签流程](./label-printing.md) — 既有標籤列印的規則、參數轉換與 `/print/*` 代理
- `docs/backend/label-printing.md` — 列印服務代理細節
- `apps/admin/utils/print.ts` — 尺寸目錄、canvas 渲染、印表機/任務 API
