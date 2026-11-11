# Admin 收貨問題頁支援 CN mismatch（BUG-055）

2026-11-10 · 狀態：已實裝

## 問題

PDA 國內收貨掃描（receiving-cn-scan）用 `flagCnItem` 標記異常時，係寫落 `receiving_invoice_items_cn` 嘅 `reported_mismatch` / `mismatch_reason` / `mismatch_qty` / `wrong_part_no` / `mismatch_note` 欄。但 admin「收貨問題」頁（`/admin/receiving-mismatches` → `listReceivingMismatches`）只讀 HK 三表（`receiving_invoice_items` → `receiving_invoices` → `receiving_orders`），CN mismatch 完全隱形；confirm/cancel endpoints（`POST /receiving-invoice-items/:id/mismatch/confirm|cancel`）亦只郁 HK 表，俾 CN item id 會 404 `receiving_invoice_item_not_found`。

## 設計

### 後端

1. **`listReceivingMismatches`（`src/db/receiving.ts`）**：`UNION ALL` CN 三表（`receiving_invoice_items_cn` → `receiving_invoices_cn` → `receiving_orders_cn`）。回傳列新增 `source: "hk" | "cn"`。CN 側冇 supplier 欄 → `supplierCode` 恒 `NULL`。排序照舊（order/invoice created_date DESC），union 外層統一 ORDER BY。

2. **Mismatch lifecycle 函數加 `source` 參數**（預設 `"hk"`，向後兼容）：
   - `loadMismatchItem` / `getReceivingItemMismatch` / `reportReceivingItemMismatch` / `editReceivingItemMismatch` / `confirmReceivingItemMismatch` / `cancelReceivingItemMismatch`
   - 表名由內部常數 map 決定（`hk` → `receiving_invoice_items`，`cn` → `receiving_invoice_items_cn`），經 `sql.raw` 注入——值只係兩個 hardcoded 常數，唔係用戶輸入。
   - `transaction_logs.entityType`：CN 用 `receiving_invoice_item_cn`。
   - SSE event topics：CN 加 `/admin/receiving-cn`（CN 相關頁面嘅 reload topic）；event type 照舊 `receiving.mismatch_*`。

3. **Routes（`src/routes/receiving.ts`）**：4 個 mismatch endpoints 接受 `?source=cn` query param，傳落 domain。冇 param = hk，現有調用唔受影響。

4. **`flagCnItem`（`src/db/receivingCnScan.ts`）**：補 emit `receiving.mismatch_reported`（topics `["/receiving-cn-scan-tasks", "/admin/receiving-cn"]`），等 admin 收貨問題頁嘅 change-notice 可以即時提示。

### Admin 前端

5. **`utils/flowApi.ts`**：`MismatchListRow` 加 `source: "hk" | "cn"`；`confirmReceivingMismatch` / `cancelReceivingMismatch` 加 optional `source`，CN 時 append `?source=cn`。

6. **`pages/issues/receiving.vue`**：
   - 新增「來源」列（HK / CN badge）。
   - confirm/cancel 傳 `row.source`。
   - Row click：CN 行跳 `/receiving-cn/${batchNo}`，HK 行照舊 `/receiving/${receivingOrderId}`。

7. **i18n**：`admin.pages.issues.source`（en "Source" / zh-CN "来源" / zh-HK "來源"）。

### 刻意唔做

- **CN cancel 唔郁 `scan_status`**：admin cancel 只清 mismatch 欄（同 HK 行為一致）；CN item 嘅 `scan_status='error'` 留返 PDA 操作員用 reset 完整清除。管理員取消 mismatch 係「呢單嘢唔使跟」，唔係「幫佢重掃」。
- **Report/edit 唔開畀 CN 做入口**：CN mismatch 嘅來源係 PDA 掃描 flag，admin 只 confirm/cancel；report/edit endpoints 加 source 支援只係統一接口，admin UI 唔加入口。

## 測試

- `receivingCnScan.test.ts`：flag 一個 CN item 後 `listReceivingMismatches` 見到 `source: "cn"` 行；confirm/cancel 經 `?source=cn` route 成功；hk source 攞 CN id → 404。
- `receiving.test.ts` 現有 mismatch 測試：`source: "hk"` 斷言（deepEqual 要補呢個 field）。
- `pnpm --filter @warehouse/backend build` + `test`；`pnpm --filter @warehouse/pda test`（BUG-054 相關）。
