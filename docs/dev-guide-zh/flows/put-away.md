---
tags: [dev-guide-zh, flow]
aliases: [上架, Put-away]
---

# 上架 Put-away 流程

把收货区(dock)库存搬到货架 lot,库存从此可被[分配](./allocation.md)。现为 **shelf-direct** 形态:操作员只见「扫件 → 选架 → 提交」,箱(`shelf_boxes`)降级为数据模型内部概念。CN 仓走并行变体(`put-away-cn`)。

**权威细节**:[ai-scope](../../app-docs/flows/put-away/ai-scope.md) · [steps](../../app-docs/flows/put-away/steps.md)。✅ ai-scope 的"批次值覆盖"错误措辞已于 2026-11-07 文档审计更正为 COALESCE 填充语义。

## 1. 流程图(节点标注入口)

```mermaid
flowchart TD
  A["收货 in_hand 后<br/>confirm-arrival 同事务建 put_away_tasks<br/>(autoCreateTasks 配置;或调拨单来源)"] --> B["PDA 上架列表(任务模式)<br/>pages/put-away/index.vue<br/>GET /put-away-tasks?status=pending(assignee 过滤)<br/>topic /put-away-tasks SSE 重载"]
  B --> C["任务详情(聚合单读)<br/>pages/put-away/[id].vue?task=<br/>GET /receiving-orders/:id/put-away<br/>PutAwayLotsPanel.vue 按部件分组卡片"]
  C --> D{"扫描 classifyPutAwayScan"}
  D -->|货架 QR| E["设为目标架(banner)<br/>待提交时弹 Put N pcs to shelf X?<br/>POST .../put-away-commit {shelfCode,scanIds}"]
  D -->|"BOX-* 箱码"| F["信息 toast 忽略(箱对操作员不可见)"]
  D -->|部件标签| G["POST .../put-away-scans(暂存 staging 盒)<br/>utils/putAwayScan.ts findPutAwayTargets<br/>FIFO 跨行拆分;armed 模式只匹配所选部件组"]
  G --> E
  C -.->|skipScan 开启(种子默认开)| H["勾选部件卡 → 直接扫架整批上架<br/>无标签校验/无序列号"]
  E --> I["assignScanToBoxTx 同事务:<br/>ensureOrderShelfBoxTx find-or-create 货架盒<br/>inventory_lots upsert + lot_sources<br/>PUT_AWAY dock −qty / on_hand +qty 两条账"]
  I --> J{"全部上完?"}
  J -->|是,无未解决过期警告| K["自动 in_hand→clear + task completed<br/>SSE put_away_task.completed"]
  J -->|有 outdated 警告| L["auto-clear 挂起<br/>admin resolve 后 retryReceivingOrderClear"]
  K --> M["分配不会自动重算!<br/>等 admin Re-allocate(见 allocation.md)"]
```

## 2. 步骤表

| 步骤 | 前端入口 | API | 关键表/模块 |
|------|----------|-----|-------------|
| 列表 | `pages/put-away/index.vue`(`taskMode = cnMode || autoCreateTasks`;非任务模式走 `GET /put-away/candidates`) | `GET /put-away-tasks`、`GET /put-away/candidates`、`GET /put-away-cn/tasks` | `put_away_tasks(_cn)` |
| 详情 | `pages/put-away/[id].vue` + `components/put-away/PutAwayLotsPanel.vue` | `GET /put-away-tasks/:id`、`GET /receiving-orders/:id/put-away` | `getPutAwayAggregate` |
| 扫件暂存 | `useHardwareScanner` + `utils/putAwayScan.ts` + `utils/labelDecode.ts` | `POST /receiving-orders/:id/put-away-scans`;撤销 `DELETE /put-away-scans/:scanId` | `shelf_boxes`(staging)+ `shelf_box_items`(无 ledger) |
| 提交上架 | 货架 banner / commit 确认 | `POST /receiving-orders/:id/put-away-commit`;已上架撤销 `DELETE /shelf-boxes/:boxId/scans/:scanId` | `inventory_lots`、`inventory_lot_sources`、`inventory_transactions` |
| CN 变体 | 同页面 CN 数据源(adapter 归一化) | `POST /put-away-cn/tasks/:id/complete`(客户端本地暂存,一次批确认) | `receiving_invoice_items_cn.put_away_qty`、单条 on_hand 账 |

## 3. 关键逻辑

- **两段式写入**:扫件先进 staging 盒(无账本);提交上架才在一个事务里:货架盒 find-or-create(复用该货架持本单物品的 open 盒 → 采纳空 open 盒 → 新建 `BOX-H-*`)→ lot upsert(唯一键含 canonical YYWW 日期码 + 全批次字段 + org/子库,**pair 取自盒**)→ `put_away_qty += qty` → **两条对冲账**(`RECEIVE_TO_DOCK` dock − / PUT_AWAY on_hand +)。撤销同样两行逆向。
- **Item-first(armed)**:卡片「枪扫」按钮锁定部件组,组满/切换/重载自动解除;非组内料号 → `scanned_part_does_not_match_item`。free-match 会静默接受「恰好解析成订单内部件」的外标签,所以现场推荐 armed。
- **FIFO 跨行拆分**:一张标签数量可覆盖同部件多行(300+20000),`findPutAwayTargets` 拆成逐行写;serial 只挂第一份避免自撞去重。
- **批次回写是「填充」不是「覆盖」**:`recordPutAwayScan` 用 `COALESCE(旧值,新值)` 回填 `receiving_invoice_items`——已有非空值永远赢过扫到的值(ai-scope 已同步为此措辞)。
- **货架建议 advisory、读时算、不落库**:三级排序 same-part-box → same-part-stock → 子库亲和(`shelves.sub_inventory_scopes`);`suggestShelf=off` 全抑制。
- **剩余量守卫**:`received − picked − put_away − allocated − staged`;lot 已有拣货分配 → 撤销 409 `lot_has_pick_allocations`。
- **assignee 语义**:队列列表**无** `allowedOrgIds` 过滤(有任务就能干),candidates 有;foreign assignee detail 404 = 权限语义,不是缺行。
- CN 变体差异:无 dock 账、无 `inventory_lot_sources`(FK 指标准表)、无盒实体(pair 取自 item);lot 键先经 `resolveCnMasterPart` 解回主档(TE `AMP(...)` 拆包)。
- 详情页 `useSupplierSymbologyScope(..., { withShelfCodes: true })`:货架/箱 QR 符号常开。

## 4. 关键业务决策

| 决策 | 理由 | spec |
|------|------|------|
| 扫描与提交解耦两段 | 一张收货行多件实物可逐件累计 | `2026-07-06-put-away-scan-first-design.md` |
| Shelf-direct:砍掉箱 UI,commit 时盒 find-or-create | 操作员不需要管箱;lot/ledger/分配/同步 feed 保持箱时代形状 | `2026-10-06-put-away-shelf-direct-design.md` |
| 真任务队列 + 建议(而非派生查询) | `allowDockStock=false` 时上架是拣货硬闸,需要可挂状态的实体 | `2026-08-10-put-away-tasks-design.md` |
| 建议三级排序、advisory 不强制 | 分区从盒打戳,硬约束只会平添拒绝路径 | `2026-08-12-put-away-shelf-org-suggestion-design.md` |
| Item-first opt-in 严格锚定 | 防外标签被静默接受 | `2026-10-02-put-away-item-first-scan-design.md` |
| 同部件合卡、写入按行 FIFO 拆分 | 一包装跨多行的现实 | `2026-10-05-put-away-part-grouping-design.md` |
| skip-scan 提速通道(勾选整组+扫架) | 纸货相符时提速;**明确放弃标签校验与序列号去重** | `2026-11-04-put-away-skip-scan-design.md` |
| 过期警告挂起 auto-clear 而非阻断上架 | 工人继续干活,管理员异步处置 | `2026-10-07-supplier-outdated-datecode-warning-design.md` |
| CN 客户端暂存 + 一次批确认、无 dock 账 | CN 收货本身无 RECEIVE_TO_DOCK(v1 接受的差异) | `2026-10-16-customer-receiving-upload-design.md` |

## 5. 坑

- **上架完成 ≠ 可拣**:分配 manual-only,新货架库存等 admin Re-allocate 才进分配池。
- **种子默认与代码相反**:`seed.ts` 的 HK/SZ flow config 都开 `skipScan: true`(代码默认 false)——培训按仓库实况讲。
- staging 盒**跨订单复用**:`shelf_boxes` 没有订单列,盒↔订单靠 items 派生(空盒回退 `transaction_logs.metadata`)。
- `put-away-commit` 返回 `{count:0}` 是合法结果(并发设备先提交了);循环中任一守卫失败整个提交回滚。
- serial 去重只在同部件内;相机 OCR / 多品表格路径**不传 serial** → 完全不 dedup。
- 详情页无 SSE topic(仅列表订阅);多设备收敛靠 mount/visibility 重载。
- CN flag 双向陷阱:`/put-away-cn/*` 在标准仓 404;PDA 页面 `load()` 必须先 `await loadFlowSteps()`(代码注释明说);CN 详情必须带 `?task=`。
- 代码残留:`[id].vue` CN 路径有 `console.log("parsed", ...)` 调试遗留。

## 6. Admin 控制点

- `pages/flow-config.vue`:put-away 步骤的 `autoCreateTasks`、`suggestShelf`、`skipScan`、`cnReceiving`。
- `pages/task-assignments.vue`:put-away / put-away-cn 页签派工。
- `pages/shelves.vue`:货架主档 + 子库亲和(`sub_inventory_scopes`)+ 警告 + 货架二维码打印(PDA 扫的架码出自这里);`pages/shelf-boxes/` 箱生命周期 admin/debug。
- `pages/outdated-warnings.vue`:resolve 补跑 auto-clear。
- 关联:换架(shelf-exchange)是独立页 `pages/shelf-exchange/`,预览先行、**已分配量不可动** — `2026-10-12-shelf-exchange-design.md`。
