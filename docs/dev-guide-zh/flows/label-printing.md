---
tags: [dev-guide-zh, flow]
aliases: [打印标签, Label Printing]
---

# 打印标签 Label Printing 流程

按 `label_print_rules`(管理数据,非代码)为拣货完成的订单打印内部标签;打印参数转换在后端完成,经 `/print/*` 单点代理送打印服务。只收 **internal** 规则命中的单;打印完成后流入[贴标签](./labeling.md)。

**权威细节**:**[docs/backend/label-printing.md](../../backend/label-printing.md)** · [ai-scope](../../app-docs/flows/label-printing/ai-scope.md) · [steps](../../app-docs/flows/label-printing/steps.md)。⚠ label-printing.md 两处过时:默认打印服务 URL(代码 `http://localhost:9003`)、转换器「empty by default」(已注册 `yhft-ch-01`)。

## 1. 流程图(节点标注入口)

```mermaid
flowchart TD
  A["finishPickingOrder:label-printing 步开 且 ≥1 条 internal 规则命中<br/>→ label_printing_pending=true(进队列+即时弹打印提示)<br/>components/picking/LabelPrintPrompt.vue"] --> B["PDA 打印队列<br/>pages/label-printing/index.vue + useLabelPrintingOrders.ts<br/>GET /label-printing-orders(assignee: picking_tasks step=label-printing)"]
  B --> C["订单页规则面板<br/>pages/label-printing/[id].vue → LabelPrintRulesPanel.vue<br/>GET /picking-orders/:id/label-print-rules(含 labelCount)"]
  C --> D["Print(单规则)/ Print all<br/>POST /picking-orders/:id/label-print {ruleId, serviceId?, deviceKey?}"]
  D --> E["后端 printOrderLabel(db/labelPrintParams.ts)<br/>模板注册表 linkedConverters 或 label_type 超集 builder<br/>批次锚=拣货扫描值(scanned* 回退存量)"]
  E --> F["代理上游 POST /print/* → 打印服务(PRINT_API_BASE_URL)<br/>选机 GET /print/printers(localStorage label_printer 记忆)"]  F --> G["成功才写 label_prints 一行(append-only,重印=新行)<br/>payload jsonb 逐张参数(packageId/shippingBoxId)"]
  G --> H["轮询任务 GET /print/jobs/:jobId(utils/print.ts waitForPrintJob 30s/1.5s)"]
  H --> I["Finish printing<br/>POST /picking-orders/:id/label-printing-finish<br/>→ labeling 开:置 labeling_pending(PDA 跳贴标页)<br/>→ labeling 关:advanceAfterPickingFinish 放行箱子"]
  I --> J["label_prints 内容被复核 label 模式消费<br/>(见 verify.md scan-label)"]
```

## 2. 步骤表

| 步骤 | 入口 | API | 关键表/模块 |
|------|------|-----|-------------|
| 队列 | `pages/label-printing/index.vue` | `GET /label-printing-orders` | `db/picking.ts` `listLabelPrintingOrders` |
| 规则/计数 | `[id].vue` → `LabelPrintRulesPanel.vue` | `GET /picking-orders/:id/label-print-rules` | `db/labelPrint.ts`(每 label_type 首条命中) |
| 打印 | 同上 Print 按钮;阶段后重印也在 `LabelPrintRulesPanel` | `POST /picking-orders/:id/label-print` | `db/labelPrintParams.ts` `printOrderLabel` → `label_prints` |
| 选机/轮询 | 面板下拉;`utils/print.ts` | `GET /print/printers`、`GET /print/jobs/:jobId` | `src/print.ts`(超时:读 10s/打印 120s,错误统一 502) |
| 完成 | finish 按钮 | `POST /picking-orders/:id/label-printing-finish` | `db/picking.ts`;SSE `picking.label_printing_finished` |
| 规则管理 | admin `pages/label-print-rules/`(index CRUD+启停;`[id]` 编辑+test-match 预览) | `GET/POST/PATCH/DELETE /admin/label-print-rules(/:id)`、`POST .../test-match` | `label_print_rules` |

## 3. 关键逻辑

- **规则匹配**:active 行按 `priority ASC, created_date ASC`,**每 label_type(carton|item_box|item)首个命中赢**;条件字段 `org_id|sub_inventory|order_no|order_type|customer|supplier`,算子 `eq|match`(match=glob,SQL `globToLike` / JS `globToRegExp` 两套实现语义必须一致)。supplier 条件 = 订单任一行的 `parts.brand`(经 `part_no=wcl_item_no` 连接)。
- **参数转换在后端**:PDA 只有订单详情,拿不到富化字段;超集参数让画布模板按名绑定、多余键忽略;batch 字段锚定**拣货时扫描值**。`labelCount` 只在路由侧算。
- `label_prints` **仅上游成功后写**——打印失败无痕迹行;列反范式化(rule_id/template_id 随存)以在规则被改后仍可追溯;`payload` 是 verify label 模式比对的源。
- A4 模板走 `printingParams[].items[]`(≤槽数),label 模板每项一张;页面尺寸目录见 `docs/backend/print-service.md` §模板清单。
- 服务端打印时**重验规则**:客户端拿旧 matches 直接打 → 409(`label_print_rule_inactive` / `label_rule_no_longer_matches` / `label_rule_external`)。
- `printerName` 实际传上游 `deviceKey`;`serviceId/deviceKey` 必须成对(400 `printer_incomplete`)。

## 4. 关键业务决策

| 决策 | 理由 | spec |
|------|------|------|
| 规则=管理数据(AND/OR+priority),免部署可改 | 模板映射随客户/仓库变,写死分支无法运维 | `2026-09-16-label-print-rules-design.md` |
| 完成即弹打印提示 + 队列并存 | 提示管「顺手就印」,队列管「稍后坐 bench 印」,都留 `label_prints` | `2026-10-27-picking-finish-label-print-prompt-design.md` |
| 参数转换移到后端 | 前端缺 DB 富化字段;superset 解耦模板 | `2026-10-29-backend-label-print-conversion-design.md` |
| 拆独立打印站(默认链:printing→labeling) | 两岗分离;禁 printing 退化单站,禁 labeling 得纯打印站 | `2026-11-02-label-printing-step-design.md` |
| internal/external 之分 | 客户供标不该出现打印按钮 | `2026-10-30-label-source-and-label-verify-design.md` |
| 客户端永不直连打印服务 | `/print/*` 单点代理 + JWT 收口 | `docs/backend/label-printing.md` |
| 标签**尺寸目录**放 admin 前端按 `warehouseCode` 分(HK/SZ 不同)| 是展示选择非业务数据;仍是配置不是 git 分支 | `2026-10-15-per-warehouse-label-sizes-design.md` |

## 5. 坑

- 上游路径以代码为准:`dynamicPrint` 实际打 `/api/v1/templates/service-dynamic-print`(print-service.md 文档写的名字不同);`/print/printers` 只保留 `isActive` 行。
- 记忆的下拉打印机若已不在列表仍会照原值发(「remembered key still prints」)。
- 详情页 `labelPrintingPending===false` 弹回列表;409 `label_printing_not_pending` PDA 视作已完成。
- `waitForPrintJob` 用 setTimeout 轮询——Chrome 101 禁 `AbortSignal.timeout`(BUG-043)。
- admin 模板字段 `printTemplateId` 是**自由文本 slug**,打错只会运行时 409/502,test-match 不校验模板存在。
