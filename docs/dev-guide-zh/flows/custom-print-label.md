---
tags: [dev-guide-zh, flow]
aliases: [自訂列印標籤, Custom Print Label]
---

# 自訂列印標籤 Custom Print Label(交接中,未實作)

**現況:只有佔位頁。** 頁面能選 CSV、顯示檔名/大小,沒有解析、沒有組裝、沒有列印。後端**沒有任何改動**——現有泛用代理 `POST /print/dynamic` 已夠用,不需要新後端路由(見 §3)。

給接手的開發者:先寫 spec + plan(`docs/superpowers/specs/`、`plans/`,見 AGENTS.md §Feature workflow),再動手。

## 0. 需求素材(已複製入 repo,原檔是 email 附件會消失)

| 素材 | repo 路徑 | 原始位置(Spark Mail 附件) |
|------|-----------|------------------------------|
| 上傳 CSV 範例 | `docs/custom-print-label-example/20261023_PC1.csv` | `~/Library/Group Containers/3L68KQB4HG.group.com.readdle.smartemail/databases/messagesData/7/12299/20261023_PC1.csv` |
| 標籤內容規則 | `docs/custom-print-label-example/蓝微新源标签内容规则.xlsx` | 同上目錄 `HK蓝微新源标签内容规则.xlsx` |

### 0.1 上傳 CSV 格式(`20261023_PC1.csv`)

UTF-8 **帶 BOM**、逗號分隔、37 欄、表頭中文,**一行 = 一條掃描記錄 = 一張標籤**(範例 178 行)。多數欄位經常為空(CUST_* / Attribute_* 視供應商而定),解析按表頭名取值、不要按位置:

| 欄位 | 範例 | 說明 |
|------|------|------|
| `單號` | `HK2610-0450` | 內部單號(→ Inv / [PI_NUM]) |
| `物料號` | `KOA+SG73P2ATTD 4701F` | 供應商 MPN,含 `KOA+`/`KOA/` 前綴及空格 |
| `數量` | `25000` | → Qty / [MOQ] |
| `物品序列` / `箱序列` | `1` / `1 of 1` | 序號 |
| `LOTNO` | `1907Q031` | → Lot / [LOT_NO] |
| `DATECODE` | `20260907` | YYYYMMDD,→ DC / [DATE_CODE] |
| `DATECODE_2` | `2637` | KOA 週碼 |
| `標籤一` | `0;HK2610-0450;1;1;2;KOA+…;853;20;;1153;MADE IN CHINA;` | 掃到的內部標籤原始字串(分號分隔) |
| `標籤二` | `:SG73P2ATTD4701F::253:X:1907Q031:S613:KOA+…::::` | 掃到的供應商 QR 原始字串 |
| `CUST_LOTNO`/`CUST_DATECODE`/`CustAttribute_4~7`/`Attribute_04~14` | (多為空) | 掃客戶標籤時才拆出的欄位 |
| 其餘 | `掃描時間`/`相關日期`/`流程`/`類別`(`DAILY_HK`)/`Site_Code`(`WHHK`)/`Voided` | 掃描中繼資料 |

### 0.2 標籤內容規則(蓝微新源 = LWXY,xlsx 逐行抄錄)

「使用字段」是模板佔位符;`組裝=Y` 表示要前端拼接:

| 標籤位置 | 使用字段 | 範例 | 組裝 | 備註 |
|---|---|---|---|---|
| 頂部一維碼 | `[CUST_ITEM_NUMBER]` | `22058-0028895` | N | 數據來自 Oracle |
| LOT NO | `[LOT_NO]` | `1728Q505` | N | 來自 BVS |
| VENDOR | `[VENDER_CODE]` | `10892` | N | **需更改為 `71279`** |
| Date Code | `[DATE_CODE]` | `20260728` | N | 格式 YYYYMMDD |
| QTY | `[MOQ]` | `10000 PCS` | N | Oracle + BVS |
| REEL NO | `[VENDER][DeliveryDate][WEEKLY_SERIAL]` | `10892260929000019` | Y | DeliveryDate=當天發貨日期 `yyMMdd`;WEEKLY_SERIAL=流水號**6 位小數補 0** |
| 品名 | `[ITEM_CLEAN]` | `RK73H1ETTP1003F` | N | **刪 `KOA+`、`KOA-`、`KOA*`、`KOA/` 及空格** |
| 物料描述 | `[ITEM_DESCRIPTION]` | `CHIP.RES 0402 100K OHM 1% …` | N | Oracle |
| 橫線下(公司名) | (寫死) | `创能电子(深圳)有限公司` | N | **需更改為 `創意電子(澳門商業服務)有限公司`** |
| Inv | `[PI_NUM]` | `SZ2609-0314` | N | Oracle |
| MPN | `[ITEM_CLEAN]` | `RK73H1ETTP1003F` | N | 同品名 |
| Qty | `[MOQ]` | `10000` | N | |
| DC | `[DATE_CODE]` | `20260728` | N | |
| Lot | `[LOT_NO]` | `1728Q505` | N | |
| 送貨日期 | `[Delivery_Date]` | `260929` | N | 當天發貨日期,`yyMMdd` |
| 右上角二維碼 | `[CUST_ITEM_NUMBER]*[LOT_NO]*[DATE_CODE]*[VENDER_CODE]*[MOQ]*[VENDER][DeliveryDate][WEEKLY_SERIAL]` | | Y | `*` 連接 |
| 右下角二維碼 | `[PI_NUM];[ITEM_CLEAN];[MOQ];[LOT_NO];[DATE_CODE]` | | Y | `;` 連接 |

## 1. 現有程式碼位置

| 位置 | 內容 |
|------|------|
| `apps/admin/pages/custom-print-label.vue` | 佔位頁:`<input type="file" accept=".csv">`,只記錄 `fileName` / `fileSize` |
| `apps/admin/utils/entities.ts` | 側邊欄連結 `/custom-print-label`,放在 **Dropdown & Policy**(`Label Print Rules` 之後) |
| `layers/i18n/i18n/locales/{en-US,zh-HK,zh-CN}.ts` | `admin.navLinks.customPrintLabel`、`admin.pages.customPrintLabel.*`(三個語系都要同步加字) |
| `docs/uat/functions.json` ADM-039 | UAT 功能條目(狀態:佔位) |

## 2. 待做(建議順序)

1. **解析 CSV**:瀏覽器端 `File.text()` 自己切(不要為幾行解析加依賴)。處理 **BOM**、CRLF、引號內逗號、欄位數不符 → 明確報錯行號。按表頭名取欄(不要按索引)。
2. **組裝模板參數(後端)**:轉換邏輯放在 `apps/backend/src/db/labelPrintParams.ts`——跟其他打印模板一樣,按 templateId 註冊 converter(見 §3.1)。
3. **預覽表格**:列出前 N 行 + 總張數,讓使用者核對欄位再印(對錯欄位直接印幾百張錯標籤)。
4. **列印**:選機(`listPrinters()`,localStorage key 建議 `custom_label_printer`,不要跟 `label_printer` / `doc_printer` 搶)→ 把解析好的 CSV 行 POST 到新的後端列印路由(轉換 + 送印一條龍,骨架照 `printOrderLabel`,見 §3.1)→ 逐 job `GET /print/jobs/:jobId` 輪詢。

## 3. 列印方式:**模板打印(A4-LWXY),不是 canvas 渲染**

⚠ **不要用 `utils/print.ts` 的 `renderShelfLabelPng` / `printFile` 那套**——那是貨架/盒標的「前端畫 PNG 直印」路徑。這裡走**打印服務模板**:

```
前端解析 CSV 成行(預覽/核對用)
  → POST /admin/custom-label-print(新路由,建議名){ rows, printer? }
      → db/labelPrintParams.ts 的 A4-LWXY converter 組 printingParams(見 §3.1)
      → dynamicPrint({ templateId: "A4-LWXY", printingParams, serviceId, deviceKey })(src/print.ts)
      → 回 jobs[] 給前端
  → 逐個 GET /print/jobs/:jobId 輪詢(waitForPrintJob)
```

(`POST /print/dynamic` 泛用代理仍然存在,但別讓前端自己組好參數直叫它——轉換規則要進後端 + 進測試,見 §3.1。)

### 3.1 轉換邏輯放哪:**`apps/backend/src/db/labelPrintParams.ts`**,跟其他打印模板同一套做法

- 這個檔案就是模板參數轉換的權威模組:per-template converter 按 `print_template_id` 註冊在 `linkedConverters`(現有 `"yhft-ch-01": yhftCh01Linked`,註冊表上方註釋「A4 chunking, customer-specific payloads, DB-enriched fields」),無註冊的模板落到 `buildDefaultLinkedLabelPrintParams` 超集 builder。
- **A4-LWXY 的規則(KOA 前綴剝除、VENDER_CODE 替 71279、`yyMMdd`、流水號補 0、兩個 QR 用 `*` / `;` 拼)就寫在這裡**,不要散在 Vue 頁裡。既有 converter 是揀貨單綁定的(`LabelPrintContext = { db, order, match }`),自訂標籤沒有揀貨單——加一個平行的 `customLabelConverters` 註冊表(同樣 keyed templateId,`"A4-LWXY": a4LwxyCustom`),**輸入是解析好的 CSV 行**(header→row 的欄位對應也在這裡做,回傳 `LabelPrintParamRow[]` 形狀),跟 `linkedConverters` 放同一檔案,複用它的 `str()` 等小工具。
- 新路由 `POST /admin/custom-label-print`(骨架照 `printOrderLabel`:查 converter → 組參數 → `dynamicPrint` → (要的話)寫列印紀錄;**actorId 從 JWT 來**,不收 body),薄路由放 `src/routes/admin/`,錯誤照 `HTTPException` snake_code 慣例。
- **測試**放 `apps/backend/src/db/labelPrintParams.test.ts`——既有檔案已經一半是純函數測試(default builder 的 page/total、trace 拼接、空值處理),CSV 行 → 參數的轉換同樣寫純測試(拿 `docs/custom-print-label-example/20261023_PC1.csv` 的真實行當 fixture),不需要 DB。
- 「labeling 果邊」就這麼做:揀貨標籤 = 後端 `printOrderLabel`(converter → `dynamicPrint` → 成功才寫 `label_prints`),PDA 只選機 + 輪詢。自訂標籤唯一的差別是**數據源從揀貨單換成上傳的 CSV 行**,轉換同樣留在後端。

- **模板 id:`A4-LWXY`**。它**不在** `docs/backend/print-service.md` 的模板清單(那是舊目錄)——實際佔位符欄位名、label-canvas / a4-canvas 類型、slotCount 要向打印服務負責人確認,或直連上游 `GET /api/v1/a4-templates/A4-LWXY/runtime`(後端沒代理這條,預覽類端點也只有上游有)。§0.2 的 `[...]` 佔位符名以模板實測為準。
- 若是 **a4-canvas** 類:`printingParams` 每項 = 一頁 A4,本頁標籤放 `items[]`(≤ slotCount),要分頁;若是 **label-canvas**:每項 = 一張標籤。
- 選機/輪詢仍重用 `apps/admin/utils/print.ts` 的 `listPrinters` / `printerKey` / `parsePrinterKey` / `waitForPrintJob`。
- 不傳 `serviceId`/`deviceKey` 時上游用**模板上配置的預設打印機**;要傳就成對(`deviceKey` 兼作 `printerName`)。

## 4. 動手前要定的事(先問需求方)

| 問題 | 影響 |
|------|------|
| **CSV 欄 → 模板字段對應**:`[LOT_NO]`↔`LOTNO`、`[DATE_CODE]`↔`DATECODE`、`[MOQ]`↔`數量`、`[PI_NUM]`↔`單號`、`[ITEM_CLEAN]`↔`物料號`(剝 KOA)看似對得上;但 `[CUST_ITEM_NUMBER]`、`[ITEM_DESCRIPTION]`、`[VENDER_CODE]`、`[Delivery_Date]`、`[WEEKLY_SERIAL]` 在 CSV 無同名欄——取自 `CUST_*`/`Attribute_*`?還是從 `標籤一/二/三` 切? | 組裝邏輯的全部設計,佔位符不對印出來就是廢紙 |
| `A4-LWXY` 的實際欄位名 / 類型 / slotCount | 佔位符名、a4 分頁 |
| `VENDER_CODE` 替 71279、公司名改「創意電子(澳門商業服務)有限公司」——寫死在 converter 還是要可配置? | 需求方備註裡的「需更改為」 |
| 要不要列印歷史? | 揀貨標籤寫 `label_prints`;自訂標籤要審計就得加後端(新表或 `transaction_logs`) |

## 5. 坑

- **不要為 CSV 解析加套件**(專案有 `exceljs` 但那是 xlsx;CSV 手寫切分即可)。
- CSV **帶 BOM**(`\uFEFF`)——不剝掉第一個表頭名就匹配不上。
- 打印服務回應是 `data.jobs[]`,**多頁/多張 = 多個 job**,要逐個輪詢;`waitForPrintJob` 是 setTimeout 輪詢(共享代碼,Chrome 101 限制見 AGENTS.md,不要在其中引入新 Web API)。
- 打印機 key 是 `serviceId|deviceKey` **成對**(`parsePrinterKey` 拆);記住的機台可能已下線,送出前仍照原值發(既有行為)。
- 需求方範例值(22058-0028895 / SZ2609-0314)與上傳 CSV 內容(HK2610-xxxx / KOA 料)是**不同客戶/單據**的例子——對應關係務必按 §4 問清,不要拿範例值反推。

## 6. 完成時要一併更新的文件

1. spec + plan:`docs/superpowers/specs/YYYY-MM-DD-custom-print-label-design.md`、`plans/…`。
2. `docs/app-docs/ai/code-map.md`、`ai/feature-registry.md`(把 Custom Print Label 那行的 Planned 改成 Shipped + 實際檔案)。
3. `apps/admin/TOC.md`。
4. `docs/uat/functions.json` ADM-039(`remarks` 補 commit / spec),再跑 `node scripts/gen-uat-xlsx.mjs`。
5. 本文件:改成正式流程文件(流程圖 / 步驟表 / 決策 / 坑),或刪掉並在 `README.md` §6 改指向新 spec。
6. 若確認了 `A4-LWXY` 的欄位/類型,補進 `docs/backend/print-service.md` 模板清單。
7. 新後端路由補進 `docs/backend/api-design.md`(路由目錄)。

## 7. 參考

- [打印标签流程](./label-printing.md) — 既有標籤打印(規則、`printOrderLabel` 參數轉換、`/print/*` 代理)
- `docs/backend/print-service.md` — 打印服務 API、模板類型(label-canvas / a4-canvas)、`printingParams` 結構
- `apps/backend/src/routes/print.ts` + `src/print.ts` — `POST /print/dynamic` 泛用模板打印代理
- `apps/backend/src/db/labelPrintParams.ts` — 後端組參數 + `dynamicPrint` 的既有寫法(labeling 果邊)
