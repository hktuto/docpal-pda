# 截圖任務進度狀態（compaction 保命用，2026-11-10）

## 完成咗
- Runbook：`docs/user-guide/capture-runbook.md`（每章用邊張單+掃碼字串總表+逐步操作）
- DB backup：`.db-backups/warehouse_backend_pre_screenshots_20261110.dump`（pg_dump -Fc；還原：`docker cp` 返入去 + `pg_restore -U warehouse -d warehouse_backend -c --if-exists`；**要等用戶驗收 OK 先還原**）
- 前置改動（拍完要還原/停用）：measuring step 已開（SQL jsonb_set + tsx watch reload，PUT /admin/flow-config 會被 stored config 嘅 legacy `pickingAllocation` key 擋，唔好用 PUT）；internal label rule「漢立箱嘜（示範）」id `01a1c5a4-62cf-7d20-9b9b-fa49534b0aa9`；outdated warning `demo-outdated-0001`（掛 GZ2611-0177）。
- Harness：`scripts/capture/lib.mjs`（login/launch/pdaContext/adminContext/wedge/shot；playwright 由 `../../node_modules/.pnpm/playwright@1.61.1/...` absolute import；Chrome channel；PDA 390×844 dsf2、Admin 1440×900 dsf2；藏 DEV SCAN CSS——用戶已喺 app 度 hide 咗，CSS 係兜底）。
- Login token cache：`.db-backups/.token`（12h TTL，過期用 lib 嘅 login() 重攞）。帳號 Administrator / 2'KMzF}zK2ZmwQe（PDA Group + admin 兩個 group 都有）。
- **PDA 10 查貨 5 張 ✓**（script `scripts/capture/pda-10-goods-verify.mjs`；GZA01A 已 verified；list 用 2026-11-04 有兩張 pending：BJA01、GZB06A）
- **PDA 01–05 已拍（24 張）**，見各 subagent 報告。重點副作用：
  - 新 CN 收貨單 KOA-20261110-01（in_hand）+ 佢嘅 pending put_away_tasks_cn（未郁）
  - TE-20261109-03 → in_hand（造咗 mismatch 差異記錄畀 Admin 06）；新 pending 上架 task
  - TE-20261106-03 被掃咗 2×54000 credit（仍 scanning，唔好再用）
  - TE-20261106-09 上架 task → completed
  - GZE44 lot 320000→270000；GZE51 +50000；GZE58 +100000（ad-hoc）
  - 數據修正：GZE44 兩行 lot_code 由空格 ' ' 改做 ''（否則 shelf-exchange preview 409）
- Scripts：`scripts/capture/pda-01..05-*.mjs`（03 有 retake 版；04 重跑要 SKIP_COMMIT=1）

## 行緊（background subagents，等 notification）
（全部完成——最後更新 2026-11-10 晚）

## 已完成嘅後續
- 全部 84 個 `【截圖：…】` 佔位符已換做 `![desc](shots/<檔名>.png)`（`scripts/capture/embed-shots.mjs`，0 broken refs）；各章末尾截圖清單已搬入 `capture-runbook.md` 附錄；兩個 index.md 嘅「截圖狀態」段已更新。
- Admin 05/06 由 agent-37 完成；之後重影咗：`06-receiving-issues-list.png`（insert 咗兩條示範 mismatch 落 HK 表 `01M5BYV3HE3FYN38YCZA2R6NX8` / `01M5BYV3HBP8BVBB88WHSRNFC8` + 将 04958899-W-01 嘅 supplier_code 由 UUID 改 '32'，2400px 闊 viewport）、`05-cancel-records-awaiting-confirm.png` 同 `06-picking-issues-resolve.png`（2300px 闊版，`admin-05-06-wide-retake.mjs`）。
- UAT 已記：**BUG-054**（flagQty.trim crash，PDA-008）、**BUG-055**（admin 收貨問題頁唔顯示 CN mismatch，ADM-031），xlsx 已 regen。
- **未還原**：DB dump、measuring config、label rule、兩條示範 mismatch、`capture-pending-02` workflow 行、`.db-backups/.token`——等用戶驗收後先還原（見下面第 4 點）。

## 截圖檔案位置
`docs/user-guide/pda/shots/`（檔名前綴章號，如 `01-manual-receiving-empty.png`）、`docs/user-guide/admin/shots/`。
