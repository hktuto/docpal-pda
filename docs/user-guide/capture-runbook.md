# 截圖拍攝 Runbook（內部工作文件）

呢份係拍攝 `pda/` 同 `admin/` 兩套指南截圖嘅執行手冊：每章用邊張單、掃咩碼、撳咩掣。
所有掃碼字串已對照 DB 真實資料準備好，拍攝時**逐個字輸入再撳 Enter**（keyboard-wedge 模式，貼上無效——Playwright 用 `pressSequentially` 模擬打字）。

## 0. 環境準備（拍攝前做一次）

1. `docker compose up -d`（DB 已行緊）
2. `pnpm dev:backend`（:3002，需要 `DOCPAL_URL`；用平時嘅起法）
3. `pnpm dev:admin`（:3100）
4. `pnpm --filter @warehouse/pda dev`（:3103）
5. 確認兩邊登入到（PDA 用操作員帳號、admin 用 admin 群組帳號）
6. **開測量步驟**（影 PDA 08 前必做，成個 PDA session 完咗先還原）：
   admin → 流程設定（flow-config）→ `steps.measuring.enabled` 改 `true` → 儲存。
   （而家 DB 入面係 `false`，主頁唔會顯示「測量」tile。還原：拍攝完改返 `false`。）
7. **加一條 internal 標籤列印規則**（影 PDA 06 完成揀貨**之前**必做，finish 嗰刻會 snapshot rule match）：
   admin → 標籤列印規則 → 新增：
   - 名稱：`漢立箱嘜（示範）`
   - 標籤類型：`carton`
   - 條件：欄位 `customer`、運算 `match`、值 `*广东汉立*`
   - 打印模板 ID：`demo-hanli-carton-01`（free-text，print service 冇行都入到）
   - 優先級 `100`、啟用 ✓
   - 效果：完成揀貨 GZ2611-0175 → 先入「標籤列印」queue（內部規則），嗰頁撥「完成」→ 自動落入「待貼標籤」queue，貼標詳情頁會見到有列印掣嘅規則行。
   - 現有外置規則「广东汉立」（item, zkyc-03）都會 match，喺列印視窗顯示做資訊行。
8. **插入一條過期日期碼警告**（Admin 06 用；PDA 掃描觸發唔到——picking 掃描要有 allocation 先生效，呢度直接 SQL）：

   ```sql
   insert into outdated_scan_warnings
     (id, order_kind, order_id, supplier_code, part_no, date_code, limit_months, qty, scanned_by, scanned_at, created_date, last_update_date)
   values
     ('demo-outdated-0001', 'picking', '01M6QQGYAT669TPA6XJJY1EXFZ', '32',
      'KOA+RK73H1ETTP 1001F', '2210', 24, 5000, 'operator', now(), now(), now());
   ```

   （掛喺 GZ2611-0177 度——呢張單邊章都唔影。`resolved_at` 留 null = 未處理。）

9. 截圖工具：Playwright `channel: 'chrome'`（用本機 Chrome，唔使下載 browser）。
   - PDA viewport：390×844、deviceScaleFactor 2；Admin viewport：1440×900。
   - 登入一次儲 `storageState` 重用。
   - 存圖去 `docs/user-guide/pda/shots/` 同 `docs/user-guide/admin/shots/`，檔名跟各章末尾清單。

## 掃碼字串總表

KOA（貨倉實貨格式，decode raw = 第 4 段起）：

| 代號 | 字串 | 解出 |
|---|---|---|
| KOA-A | `:RK73H1JRTTD3400F::253:X:1714Q713:S648:KOA+RK73H1JRTTD 3400F::::` | RK73H1JRTTD 3400F × 25000 |
| KOA-B | `:RK73H2BTTD1624F::53:X:1708H339:604:KOA+RK73H2BTTD 1624F::::` | RK73H2BTTD 1624F × 5000 |
| KOA-C | `:RK73H1ETTP2001F::54:X:1706Q306:S634:KOA+RK73H1ETTP 2001F::::` | RK73H1ETTP 2001F × 50000（GZE44 有現貨 320000）|
| KOA-C2 | `:RK73H1ETTP2001F::54:X:1706Q306:S635:KOA+RK73H1ETTP 2001F::::` | 同上，serial S635（避免重複拒收）|

TE（MH10 空格分隔版——template 接受空格做 separator）：

| 代號 | 字串 | 用途 |
|---|---|---|
| TE-9A | `[)>06 LT3S074726091991 PN205206-9 RVW QT2400 PO200234856713 BT26433M BX51 DC26433` | CN 掃描（對 2400 行）|
| TE-9B | `[)>06 LT3S074726091992 PN205206-9 RVW QT800 PO200234856713 BT26433M BX52 DC26433` | CN 掃描（對 800 行）|
| TE-9C | `[)>06 LT3S074726091993 PN205206-9 RVW QT1600 PO200234856713 BT26433M BX53 DC26433` | CN 掃描（對 1600 行）|
| TE-9D | `[)>06 LT3S074726091994 PN205206-9 RVW QT800 PO200234856713 BT26433M BX54 DC26433` | 上架示範掃一件 |
| TE-M1..M4 | `[)>06 LT3S07472609200N PN2232553-1 RVW QT54000 PO200234856801 BT0 BXN DC26221`（N=1..4，serial 尾三位 001–004）| 測量 + 覆核重掃 GZ2611-0175（4 掃 × 54000 = 216000 剛好掃齊 16 箱行）|

⚠ TE-M 系列 date code 必須係 `DC26221`（canonical 2622）——packages 嘅批次錨定係 2622，其他值會 match 唔到。
TE decode 會將 `PN2232553-1` resolve 做 `AMP(2232553-1)` / WCL `TE-AMP(2232553-1)`，同 packages 記錄一致 ✓

貨架碼（直接打 code，唔係顯示名）：`GZE66`（上架）、`GZE58`（臨時上架）、`GZE44`（調撥源）、`GZE51`（調撥目標）。

## PDA 拍攝順序（共 46 張）

### 01 手動收貨（4 張）
- 新增訂單號 `32926111001`（prefix 329 → GZSZ 倉位）同 `32926111002`（兩張卡片截圖用）。
- 入第一張 → 掃 KOA-A、KOA-B（品牌鎖定 KOA，唔好掃其他牌子）。
- 截：空白任務頁（未加單前）→ 兩張訂單卡 → 掃咗兩項嘅掃描畫面 → 完成確認視窗。
- 撳完成：會造 CN order + 一張 pending 上架 task（03 章用唔用都得）。

### 02 收貨掃描（5 張）— 用批次 **TE-20261109-03**（status scanning，AMP(205206-9) 2400/800/1600/8000/1600 五行）
- 截列表（見到 TE-20261109-03 同其他 scanning 單）。
- 入詳情 → 截單據卡同料行初始狀態。
- 掃 TE-9A、TE-9B、TE-9C（三行即刻收齊）。
- 喺 8000 嗰行撳「標記」→ 揀「缺貨」、填 8000 → 截彈窗。（會順手造多條收貨差異畀 Admin 06。）
- 展開掃描記錄 → 截每筆掃描同「移除」掣。
- 撳完成 → 有未收齊行 → 紅色「標記剩餘為缺貨」確認彈窗 → 截 → 確認（產生新上架 task）。

### 03 上架（5 張）— 用 **TE-20261106-09** 嘅 pending task（item AMP(205206-9) × 8000）
- 截列表（見到幾張待上架單）。
- 入詳情 → 截物料卡同進度。
- 掃 TE-9D 一件（800）→ 展開物料卡 → 截待上架掃描記錄同「移除掃描」掣。
- skipScan 已開：勾選 checkbox 將剩餘 7200 一次過上架 → 掃貨架 `GZE66` → 截貨架橫額 + 確認上架彈窗 → 確認。
- 截物料卡「已完成」狀態。

### 04 臨時上架（5 張）
- 主頁截「臨時上架」tile。
- 揀品牌 `KOA` + 位置（揀列表第一個 org/sub-inventory）→ 截已揀畫面。
- 掃貨架 `GZE58`（**case-sensitive**）→ 截貨架橫幅。
- 掃 KOA-C、KOA-C2 → 截項目清單（兩項、各 50000）。
- 截確認上架按鈕（顯示項目數/總件數/貨架）→ 確認。

### 05 貨架調撥（4 張）
- 主頁截「貨架調撥」tile。
- 掃源貨架 `GZE44` → 截源貨架橫額（提示掃商品）。
- 掃 KOA-C（RK73H1ETTP 2001F × 50000，架上批次 dc 2641 ≥ 掃描 2628 ✓）→ 截匹配商品卡。
- 掃目標貨架 `GZE51` → 截確認調撥視窗 → 確認。

### 10 查貨（5 張，隨時影得）
- 主頁截「查貨」tile → 列表（5 張 pending，有日期欄同狀態篩選）→ 截。
- 入第一張 → 截貨架資料同異動明細卡 → 截底部「確定」掣 → 撳 → 截「已查貨」狀態。

### 06 揀貨（5 張）— 用 **GZ2611-0175**（广东汉立，已全揀 216000，16 packages 喺 BOX-S-20261109-0003）
⚠ 前置：步驟 0.7 嘅 label rule 已加；measuring 已開（步驟 0.6）。
- 截揀貨列表（按日期分組）。
- 入 GZ2611-0175 → 截詳情頂部（訂單資料；如有「整箱取用」橫額會見到——呢張單冇就畧過）。
- 截已掃描進度（216000/216000）同底部掃碼工具列。
- 截箱號區域（BOX-S-20261109-0003 箱卡）。
- 撳「完成揀貨」→ 列印標籤視窗彈出（見到 internal carton 規則 + 外置 item 規則兩行）→ **截呢個視窗** → 撳 Skip/關閉（print service 冇行，撳列印會即時 502 toast，唔會 hang）。
- **順手做**：返揀貨列表，對 **GZ2611-0178** 撳「回報問題」（原因揀缺貨，備註任意）→ 造 Admin 06 揀貨問題記錄。
- 跟住去主頁「標籤列印」（唔係指南內容，純過場）→ 對 GZ2611-0175 撳完成列印 → 張單落入「待貼標籤」。

### 07 待貼標籤（5 張）— 用 GZ2611-0175
- 主頁截「待貼標籤」tile → 列表截圖（見到單同標籤數目標記）。
- 入詳情 → 截頂部（訂單號/客戶/總數）。
- 截標籤清單（internal 規則行有「列印」掣 + 「全部列印」掣）。
- 截底部「完成貼標籤」掣 → 撳 → 截確認對話框 → 確認。
- （完成後 measuring 已開 → 箱保持 open，唔會即造 verify task。）

### 08 測量（3 張）— 箱 **BOX-S-20261109-0003**
- 截測量列表（按揀貨單分組見到箱號）。
- 打 `BOX-S-20261109-0003` + Enter 入箱 → 截包裹核實進度同待掃描行。
- 掃 TE-M1 → 截進度更新（可同上一張合併）。
- 掃埋 TE-M2、TE-M3、TE-M4（4 × 54000 = 216000 掃齊）→ 自動彈箱號測量視窗 → 填尺寸 `20 X 16 X 20`、淨重 `8.5`、毛重 `9.2` → **截視窗** → 確認（會關箱 + 造 verify task）。

### 09 覆核（5 張）— 接住 08
- 截覆核列表（見到 pending 箱號）。
- 入箱 → 截待核實清單。
- 截底部「重新開啟箱號」掣（**唔好撳**）。
- 再掃 TE-M1..M4 一次（rescanned 歸零後重計；另一頁面 session，重複 raw 唔會被擋）。
- 掃齊後「完成覆核」著燈 → 截 → 撳 → 完成（訂單變 measuring_finished）。
- 如要「箱號測量」視窗截圖：喺度冇得再彈，用返 08 嗰張（章節清單有寫係測量視窗，覆核章呢張係同一 dialog 嘅外觀參考）。

## Admin 拍攝順序（共 40 張）

### 01 收貨單（5 張）
- 列表頁：狀態篩選 + 搜尋欄 + 表格 → 截；展開狀態下拉 → 截。
- 入 **BATCH-2026-09-28-000406**（KOA，部分已收，行數多）→ 截上半部訂單資料 + 發票項目表。
- 撳一項「編輯」→ 截編輯彈窗（唔使儲存）。
- 截右上角按鈕列（重新分配、確認收貨——唔好撳）。

### 02 客戶收貨上傳（5 張）
- 列表頁 → 截。
- 新增上傳 → 截拖放區 → 揀 `supporting_doc/cn_receiving/TE20261012-1.xls`。
- 核對資料步驟（錯誤提示 + 可編輯明細表）→ 截 → 確認匯入。
- 列表頂部「處理中」行 → 截。
- 入新造嘅收貨單詳情（狀態卡 + 按發票分組明細）→ 截。

### 03 揀貨單（6 張）— 主要用 **GZ2611-0176**（allocated、未被其他章節郁過）
- 列表整體 → 截；展開「狀態」下拉勾多個 → 截。
- 入 GZ2611-0176 詳情 → 截交貨日期欄 + 「儲存」掣。
- 撳「零件可用量」→ 截庫存批次視窗。
- 截頂部按鈕列（下載揀貨清單 / 列印）。
- 撳「重新分配」→ 截綠色「分配完成」橫額。（NIDEC 冇貨，分配結果係空，但 banner 照出。）

### 04 新增 VMI（4 張）
- 揀貨單列表 → 截右上方「新增 VMI」掣位置。
- 入新增頁 → 揀 `supporting_doc/vmi/VMI_Template_20261105.xlsx` → 截已揀檔名畫面。
- 預覽區（VMI-58051~58054 + 「套用到所有訂單」下拉）→ 截 → 確認建立。
- 列表用類型篩選 `vmi` → 截到啱啱建立嘅單。

### 05 取消發票（4 張）
⚠ 前置：PDA 06–09 鏈已完成。先落 SQL 再等 cron（≤2 分鐘，backend 要行緊）：

```sql
insert into cancel_invoice (id, state, pi_deliver_id, pi_invoice_num, organization_id, last_update_date)
values ('demo-cancel-0001', 'cancel', 999001, 'GZ2611-0175', 14, now());
```

- cron 處理後：`cancel_records` 多一條（outcome `cancelled_with_putback`）+ 待確認 put-back。
- 截取消發票頁整體；展開「結果」下拉（四個選項）→ 截。
- 喺替代發票欄打 `GZ2611` → 彈出建議列表 → 截。
- 「退回上架」欄顯示待確認數 + 「確認退回上架」掣 → **截完先撳**（撳完變 done）。

### 06 問題與警示（5 張）
- 左邊 menu 展開「問題」分組（四個連結 + badge）→ 截。
- 收貨差異列表（現有 5 條 + PDA 02 新造嘅）→ 截「確認/取消」掣。
- 揀貨單問題（PDA 06 回報咗 GZ2611-0178）→ 撳處理 → 截「解決備註」輸入框。
- 過期日期碼警告（步驟 0.8 insert 嗰條）→ 撳處理 → 截「處理過期警告」對話框。
- 問題回報詳情對話框 → 截。⚠ 現有 9 條 open 都冇相——想要有相嘅截圖，PDA session 期間喺 PDA 問題回報交一個附上相片嘅報告（browser 上傳任何 png 都得）。

### 07 倉庫設定（5 張）
- 貨架列表（1095 行、搜尋框、區域篩選）→ 截。
- 新增貨架 → 填示例（code `DEMO01`、區域揀現有）→ **截完關閉唔儲存**（或儲存咗之後刪返）。
- 列印標籤對話框（打印機/尺寸/份數）→ 截（唔好真印，print service 冇行）。
- 貨架箱：新增 → 數量 10 + 勾「建立並列印標籤」→ 截（呢個真做都得——shelf_boxes 而家係 0，造 10 個無壞處；列印會 502 就唔勾列印）。
- 子庫 → 管理共享組對話框（左群組右成員）→ 截。

### 08 庫存查詢（4 張）
- 頁頂 + menu 高亮 → 截；篩選欄（品牌/位置/貨架下拉）→ 截。
- 搜 `RK73H1ETTP` → 截批次表多行結果。
- 撳一行嘅歷史 → 截批次歷史彈窗（來源 + 出入記錄）。

## 拍攝後

1. 還原 flow config `steps.measuring.enabled=false`。
2. 示範 label rule「漢立箱嘜（示範）」停用或刪除（用戶決定留唔留）。
3. 按各章末尾清單檢查 86 張圖齊唔齊，將 `【截圖：…】` 佔位符換做 `![](shots/xxx.png)`。
4. DB 變動（完成咗嘅單、取消記錄、新库存）屬預期；需要還原就 `pnpm --filter @warehouse/backend db:seed`。

## 已知限制

- PDA 06 冇「即場掃描貨品」示範：全部 6 張 open 揀貨單嘅料都冇库存、allocations=0，掃描必需要有 allocation 先 match 到。GZ2611-0175 已全揀，截圖顯示 100% 進度代替。
- 列印唔會真係成功（冇 print service）：列印掣會 502 toast——指南文字寫嘅係正常流程，截圖避免影到 error toast，唔撳列印掣（除咗 07 章想示範掣嘅外觀）。
- CN 流程冇測量/覆核（用戶確認）——測量覆核鏈行嘅係 GZ 普通揀貨單。


## 附錄：各章截圖清單（embed 前嘅原文備份，重拍時用）

### pda/01-manual-receiving.md
> 截圖清單
> 1. `01-manual-receiving-empty.png` — 手動收貨空白任務頁，顯示「新增訂單號」欄位
> 2. `01-manual-receiving-orders.png` — 已加入兩張訂單卡片嘅任務頁
> 3. `01-manual-receiving-scan.png` — 掃描畫面，已掃入數項貨品，顯示「掃描到 ＜訂單號＞」
> 4. `01-manual-receiving-confirm.png` — 撳「完成」後嘅確認視窗

### pda/02-receiving-cn-scan.md
> 截圖清單
> 1. `02-receiving-cn-scan-list.png` — 收貨掃描列表，顯示待掃描收貨單同進度徽章
> 2. `02-receiving-cn-scan-detail.png` — 掃描詳情頁，單據卡 + 按料號分組嘅掃描狀態
> 3. `02-receiving-cn-scan-flag.png` — 「標記」彈窗（原因選擇、短缺數量、備註）
> 4. `02-receiving-cn-scan-history.png` — 展開嘅掃描記錄（▾），每筆掃描有「移除」掣
> 5. `02-receiving-cn-scan-finalize.png` — 「完成」確認彈窗

### pda/03-put-away.md
> 截圖清單
> 1. `03-list.png` — 上架列表頁，顯示數張待上架收貨單（主頁撳「上架」後）
> 2. `03-detail.png` — 上架詳情頁，顯示物料卡同「總數／已掃描／已上架」進度
> 3. `03-pending.png` — 展開物料卡，顯示待上架掃描記錄同「移除掃描」掣
> 4. `03-shelf.png` — 掃描貨架後嘅貨架橫額同「將 N 件放到貨架 XXX？」確認彈窗
> 5. `03-done.png` — 物料卡變灰顯示「已完成」標籤嘅完成狀態

### pda/04-ad-hoc-put-away.md
> 截圖清單
> 1. `04-home-tile.png` — 主頁，標示「臨時上架」tile
> 2. `04-brand-location.png` — 已揀品牌同位置嘅畫面
> 3. `04-shelf-banner.png` — 掃完貨架後顯示嘅藍色貨架橫幅
> 4. `04-item-list.png` — 掃咗幾項貨品嘅「項目」清單（含批量修改欄）
> 5. `04-confirm-button.png` — 底部確認上架大掣（顯示項數、件數、貨架）

### pda/05-shelf-exchange.md
> 截圖清單
> 1. `05-home-tile.png` — 主頁「貨架調撥」方塊位置
> 2. `05-source-shelf.png` — 已選源貨架，頂部「源貨架」橫額 +「掃描貨架上的商品標籤」提示
> 3. `05-matched-item.png` — 「匹配的商品」卡片，顯示料號、移動數量、可用數量
> 4. `05-confirm-modal.png` — 「確認貨架調撥」視窗，顯示來源 → 目標路線同「移動」掣

### pda/06-picking.md
> 截圖清單
> 1. picking-list.png — 揀貨列表頁，按送貨日期分組，頂部有搜尋欄同篩選掣
> 2. picking-detail-top.png — 揀貨詳情頁頂部，訂單資料、狀態徽章、整箱取用橫額
> 3. picking-scan-progress.png — 揀貨詳情頁，顯示料號進度、未裝箱包裹同底部掃碼工具列
> 4. picking-boxes.png — 箱號區域展開，顯示箱卡、全部加入／掃描物料入箱／封箱按鈕
> 5. picking-finish-print.png — 全部入箱後底部「完成揀貨」掣，及完成後嘅「列印標籤」視窗

### pda/07-labeling.md
> 截圖清單
> 1. 07-labeling-home.png — 主頁，「待貼標籤」tile 位置
> 2. 07-labeling-list.png — 待貼標籤列表，顯示幾張單、標籤數目標記同搜尋框
> 3. 07-labeling-detail-header.png — 詳情頁頂部：訂單號、狀態、客戶、總數
> 4. 07-labeling-rules.png — 標籤規則清單：每行規則連「列印」掣、打印機下拉、「全部列印」掣（含一條「標籤由客戶提供」行更佳）
> 5. 07-labeling-finish.png — 底部「完成貼標籤」掣及確認對話框

### pda/08-measuring.md
> 截圖清單
> 1. `08-measuring-list.png` — 測量列表：按揀貨單分組顯示待測量箱號（主頁「測量」進入後）
> 2. `08-measuring-box.png` — 測量箱頁：包裹核實進度、待核實標籤／待複核掃描物料行、掃描提示
> 3. `08-measuring-modal.png` — 「箱號測量」視窗：已選箱號尺寸、淨重（自動計算）、毛重，顯示「確認箱號」掣

### pda/09-verify.md
> 截圖清單
> 1. `verify-list.png` — 覆核列表畫面，顯示數個待覆核箱號（主頁撳「覆核」後）
> 2. `verify-box-detail.png` — 箱號詳情頁，顯示「待核實標籤」同「待複核掃描物料」區域同掃描進度
> 3. `verify-reopen-button.png` — 已關閉箱號頁面底部嘅「重新開啟箱號」掣
> 4. `verify-measurements-modal.png` — 「箱號測量」視窗，已填箱號尺寸、淨重、毛重
> 5. `verify-complete.png` — 全部掃齊後出現「完成覆核」掣嘅畫面

### pda/10-goods-verify.md
> 截圖清單
> 1. `10-home-tile.png` — 主頁，標示「查貨」圖示位置
> 2. `10-list.png` — 查貨任務列表，顯示日期欄、狀態篩選（待處理）同任務卡
> 3. `10-detail-pending.png` — 查貨詳情頁，顯示貨架資料同異動明細卡（+／− 數量）
> 4. `10-confirm-button.png` — 詳情頁底部嘅「確定」掣
> 5. `10-detail-verified.png` — 確認後嘅詳情頁，狀態「已查貨」、顯示確認人同確認時間

### admin/01-receiving-orders.md
> 截圖清單
> 1. `01-receiving-list.png` — 收貨單列表頁（預設狀態篩選、搜尋欄、表格）
> 2. `01-receiving-status-filter.png` — 狀態下拉框展開，四個狀態可勾選
> 3. `01-receiving-detail-top.png` — 詳情頁上半部：訂單資料、可修改嘅交貨日期、發票項目表
> 4. `01-receiving-edit-modal.png` — 「編輯項目」彈窗（Date Code 連今日／下週掣、Lot Code、COO、COW、箱號）
> 5. `01-receiving-detail-actions.png` — 詳情頁右上角按鈕列（下載出貨單／重新分配／確認收貨／覆寫狀態）

### admin/02-receiving-cn-upload.md
> 截圖清單
> 1. `02-receiving-cn-list.png` — 「客戶收貨上傳」列表頁，有幾張收貨單同頂部搜尋欄、新增上傳按鈕
> 2. `02-receiving-cn-new.png` — 「新增客戶收貨上傳」步驟一，拖放區同「選擇 PDF / Excel 檔案」按鈕
> 3. `02-receiving-cn-verify.png` — 步驟二「核對資料」，紅色錯誤提示列 + 可編輯明細表 + 底部合計對照
> 4. `02-receiving-cn-pending.png` — 列表頂部灰色「處理中」行同 pendingHint 提示文字
> 5. `02-receiving-cn-detail.png` — 收貨單詳情頁：狀態卡（含指派人下拉）、發票分組明細表、「確認收貨／下載 Excel／列印／重設訂單」按鈕

### admin/03-picking-orders.md
> 截圖清單
> 1. `03-picking-orders-list.png` — 揀貨單列表整體版面（標題、按鈕列、篩選欄、訂單列表）
> 2. `03-picking-orders-status-filter.png` — 「狀態」篩選下拉展開，勾選多個狀態
> 3. `03-picking-orders-edit-info.png` — 詳情頁資料區，交貨日期欄同右下角「儲存」掣
> 4. `03-picking-orders-availability.png` — 「零件可用量」視窗，顯示庫存批次列表同「日期代碼由／至」篩選
> 5. `03-picking-orders-download.png` — 詳情頁頂部按鈕列，圈出「下載揀貨清單」同「列印」
> 6. `03-picking-orders-reallocate-done.png` — 撳「重新分配」後顯示綠色「分配完成」橫額

### admin/04-vmi-upload.md
> 截圖清單
> 1. `04-picking-orders-list.png` — 揀貨單列表頁，標出右上方「新增 VMI」按鈕
> 2. `04-vmi-pick-file.png` — 新增 VMI 揀貨單頁，已揀檔案後按鈕旁顯示檔名
> 3. `04-vmi-preview.png` — 預覽區塊顯示多張 VMI 揀貨單（VMI 編號／客戶／子庫存／行數／總數量）連「套用到所有訂單」下拉框
> 4. `04-vmi-created-list.png` — 揀貨單列表用類型篩選 `vmi`，見到啱建立嘅揀貨單

### admin/05-cancel-records.md
> 截圖清單
> 1. `05-cancel-records-overview.png` — 取消發票頁面整體版面（標題、說明文字、篩選欄、記錄列表）
> 2. `05-cancel-records-filter-outcome.png` — 「結果」篩選下拉展開，顯示「已取消 / 已取消 + 退回上架 / 已忽略 / 錯誤」四個選項
> 3. `05-cancel-records-replacement-search.png` — 「替代發票」欄輸入中，彈出揀貨單建議列表
> 4. `05-cancel-records-awaiting-confirm.png` — 退回上架欄顯示「N 項待確認」同「確認退回上架」按鈕嘅行

### admin/06-issues.md
> 截圖清單
> 1. `06-nav-issues-section.png` — 左邊導航 menu「問題」分組展開，見到四個連結同「過期日期碼警告」／「問題回報」嘅數字 badge
> 2. `06-receiving-issues-list.png` — 收貨差異列表，見到欄位同每行嘅「確認」／「取消」按鈕
> 3. `06-picking-issues-resolve.png` — 揀貨單問題列表，彈出「解決備註（可選）：」輸入框
> 4. `06-outdated-warnings-dialog.png` — 過期日期碼警告頁，彈出「處理過期警告 — （單號）」對話框，正填寫備註
> 5. `06-bug-report-detail.png` — 問題回報詳情對話框，見到描述、環境資料、操作紀錄、照片同底部狀態／UAT 編號欄

### admin/07-warehouse-setup.md
> 截圖清單
> 1. `07-shelves-list.png` — 貨架列表頁，顯示表格、搜尋框同區域篩選
> 2. `07-shelf-new-dialog.png` — 新增貨架對話框，已填示例資料
> 3. `07-shelf-print-dialog.png` — 列印標籤對話框，顯示打印機、尺寸、份數選項
> 4. `07-shelf-box-new.png` — 新增貨架箱對話框，數量填 10 並勾選建立並列印標籤
> 5. `07-share-group-manager.png` — 管理共享組對話框，左邊群組列表、右邊成員勾選

### admin/08-stock-search.md
> 截圖清單
> 1. `08-stock-search-overview.png` — 庫存查詢頁面整體：左邊 menu 高亮「庫存查詢」，頂部概要卡顯示全倉總數
> 2. `08-stock-search-filters.png` — 篩選欄特寫：品牌／位置／貨架下拉框、料號同圖紙編號輸入框、日期代碼範圍
> 3. `08-stock-search-results.png` — 搜尋後嘅批次表：多行結果、欄位齊全、底部有分頁、「匯出 Excel」掣已亮起
> 4. `08-stock-search-lot-history.png` — 批次歷史彈窗：顯示來源（收貨）表同出入記錄表（有正負數量）
