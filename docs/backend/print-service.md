# Print Service API (label-printing-center)

Server-side print service. Base URL: same host as `PRODUCTION_URL` (root `.env`), port **9003**
(e.g. `http://192.168.1.10:9003`). The admin console calls it from the browser via
`apps/admin/utils/print.ts` (`printFile`), which derives the base URL from
`NUXT_PUBLIC_API_BASE_URL` by swapping the port to 9003 (override with
`NUXT_PUBLIC_PRINT_BASE_URL`).

## POST /api/v1/print/files — 直接打印 PDF / 图片文件

直接提交已经生成好的 `pdf` 或图片文件到目标打印机。

支持两种调用方式：

- `application/json`：传 `filePath`、`pdfPath`、`imagePath`
- `multipart/form-data`：直接上传 `file`

`filePath`、`pdfPath`、`imagePath`、`file` 四选一即可。上传文件时，后端会先保存为临时文件，再进入统一打印链路。Windows 下仅传图片时，会优先收敛到 `windows-image-driver`；Linux / Ubuntu 下会走 `cups-lp`。

### application/json 请求体

```json
{
  "filePath": "/opt/label-printing-center-linux-x64/runtime/previews/carton-a4-sheet-001/preview.png",
  "printerName": "MYPRINTER",
  "copies": 1,
  "mode": "auto"
}
```

也支持显式区分：

```json
{
  "pdfPath": "/opt/label-printing-center-linux-x64/runtime/previews/carton-a4-sheet-001/render.pdf",
  "printerName": "MYPRINTER",
  "copies": 1,
  "mode": "auto",
  "additionalArgs": ["-o", "media=A4"]
}
```

### multipart/form-data 直接上传文件

表单字段：

- `file`: 要打印的 `pdf` 或图片文件
- `printerName`: 打印机名称
- `copies`: 份数，可选，默认 `1`
- `mode`: 打印模式，可选，默认 `auto`
- `validateOnly`: 是否仅校验，可选
- `additionalArgs`: 可选，可重复传多个字段，或传 JSON 字符串数组

示例：

```bash
curl -X POST "http://127.0.0.1:9003/api/v1/print/files" \
  -F "file=@./render.pdf" \
  -F "printerName=MYPRINTER" \
  -F "copies=1" \
  -F "mode=auto"
```

## 使用位置

- 用户证件打印（admin `/user-badges`）：把证件（姓名 + 用户名 + 登入 QR code）渲染成 PNG，用
  multipart 上传打印。

---

# 根据 templateId 动态打印 A4 / Label

适用于以下模板：`katata-3-8`、`katata-label`、`carton-a4-sheet`、`carton-label-canvas`、`LABEL-FLEXTRONICS-2-5`、`LABEL-HET-CAR-3-4`、`LABEL-HET-INTELLIGENT-3-4`、`LABEL-HW-1`、`rohs-7`、`rohs-18`。

统一前缀：`/api/v1`。统一响应格式：

```json
{ "ok": true, "data": {} }
```

错误响应：

```json
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "错误说明" } }
```

## 推荐联调顺序

1. `GET /api/v1/printers` 获取可用打印机
2. `POST /api/v1/print/route-preview` 预判当前 `templateId + printerName` 的打印链路
3. `POST /api/v1/templates/dynamic-print` 发起真实打印
4. `GET /api/v1/print/jobs/{jobId}` 查询单个任务执行结果

如需先校对版式：先 `POST /api/v1/render/preview` 生成预览，确认后再调用 `dynamic-print`。

## POST /api/v1/templates/dynamic-print — 按 templateId 动态打印

后端先按 `templateId` 读取模板，再根据模板类型自动区分 `label-canvas` / `a4-canvas` 两套处理逻辑。

请求体：

```json
{
  "templateId": "LABEL-HW-1",
  "printingParams": [
    {
      "customerName": "HUAWEI",
      "invNo": "INV-20260811-001",
      "qrPayload": "HW|INV-20260811-001",
      "row_3_1": "SKU-001",
      "row_3_2": "Part Name",
      "row_3_3": "Spec",
      "row_3_4": "100",
      "row_3_5": "PCS",
      "makeIn": "CN",
      "page": "7",
      "total": "7",
      "showTailBox": true
    }
  ],
  "printerName": "Brother HL-5590DN Printer",
  "copies": 1,
  "mode": "auto",
  "orientation": "portrait"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `templateId` | `string` | 是 | 要打印的模板 ID |
| `printingParams` | `array<object>` | 是 | 打印数据。`label` 与 `A4` 的结构不同，见下文 |
| `printerName` | `string` | 否 | 打印机名称。不传时会尝试使用模板上配置的默认打印机 |
| `copies` | `int` | 否 | 打印份数，最小按 `1` 处理 |
| `mode` | `string` | 否 | 打印模式，常用：`auto`、`sumatra-pdf`、`windows-image-driver` |
| `orientation` | `string` | 否 | `portrait` / `landscape` / `auto` |
| `previewFirst` | `bool` | 否 | 仅透传，后端未实现“先预览再打印”分支，不建议依赖 |

返回体（`data.jobs[]` 每项一个打印任务）：

```json
{
  "ok": true,
  "data": {
    "templateId": "LABEL-HW-1",
    "templateName": "HUAWEI 单页 A4 标签",
    "templateType": "label-canvas",
    "printerName": "Brother HL-5590DN Printer",
    "totalPages": 1,
    "jobs": [
      {
        "jobId": "job-20260811-173000.123",
        "traceId": "job-20260811-173000.123",
        "status": "success",
        "strategy": { "mode": "windows-image-driver", "queueDriver": "Microsoft IPP Class Driver", "queuePort": "WSD-123456" },
        "output": { "imagePath": "runtime/previews/xxx/preview.png", "pdfPath": "runtime/previews/xxx/render.pdf" },
        "logPath": "logs/print-20260811-173000.log",
        "diagnostics": ["batch_page=1/1"],
        "createdAt": "2026-08-11T17:30:00+08:00",
        "updatedAt": "2026-08-11T17:30:02+08:00"
      }
    ]
  }
}
```

### Label 模板（`label-canvas`）

- `printingParams` 的每一项就是一张标签的参数，每项各生成一个打印任务
- `totalPages = printingParams.length`

### A4 模板（`a4-canvas`）

- `printingParams` 的每一项表示一页 A4；每页必须通过 `items` 传本页标签数据
- `items.length` 不能超过该模板的槽位数 `slotCount`
- 未占用槽位不渲染（自动带 `__hideEmptySlots=true`）
- `items[]` 也兼容 `{ templateId, params }` 或直接平铺字段两种写法；旧格式 `labels` 仍兼容，新接入建议统一用 `items`

### 打印模式建议

本文模板全部是 `canvas`（非 `label-zpl`）：不建议 `zebra-raw`，优先 `auto`；Windows A4 在 `auto` 下会优先切 `windows-image-driver`。

| 场景 | 建议 `mode` |
| --- | --- |
| Windows A4 打印 | `auto` |
| Windows 单标签 canvas 打印 | `auto` |
| 强制 Windows 驱动图片打印 | `windows-image-driver` |
| 强制 PDF 静默打印 | `sumatra-pdf` |

## 辅助接口

- `GET /api/v1/printers` — 系统打印机名称列表，供 `printerName` 下拉选择
- `POST /api/v1/print/route-preview` — 打印路由预判。入参 `{ templateId, printerName, mode }`；返回重点字段 `canPrint`、`resolvedMode`、`riskLevel`（`none`/`medium`/`high`）、`summary`、`strategy.queueDriver`、`strategy.queuePort`
- `POST /api/v1/render/preview` — 生成预览。入参 `{ templateId, outputMode: "png", params }`；返回 `previewImageUrl`、`output.imagePath`、`output.pdfPath`
- `GET /api/v1/a4-templates/{templateId}/runtime` — A4 模板关联的 Label Template、`slotCount`、`requestExample`，适合前端动态生成 A4 打印入参
- `GET /api/v1/print/jobs/{jobId}` — 查看单个任务状态、落盘文件路径、日志路径、diagnostics

## 模板清单

| templateId | 模板类型 | 模板名称 | 页面尺寸 | 槽位数 | 关联 Label Template | 建议请求结构 |
| --- | --- | --- | --- | --- | --- | --- |
| `katata-3-8` | `a4-canvas` | `katata-3-8` | `210 x 297 mm` | `24` | `katata-label` | `printingParams[].items[]` |
| `katata-label` | `label-canvas` | `KATATA-LABEL` | `70 x 37 mm` | `1` | - | `printingParams[]` 直接传字段 |
| `carton-a4-sheet` | `a4-canvas` | `CARTON_A4` | `210 x 297 mm` | `10` | `carton-label-canvas` | `printingParams[].items[]` |
| `carton-label-canvas` | `label-canvas` | `ALLIED-LABEL` | `100 x 60 mm` | `1` | - | `printingParams[]` 直接传字段 |
| `LABEL-FLEXTRONICS-2-5` | `a4-canvas` | `FLEXTRONICS A4 2x5` | `210 x 297 mm` | `10` | `LABEL-FLEXTRONICS-1` | `printingParams[].items[]` |
| `LABEL-HET-CAR-3-4` | `a4-canvas` | `HET CAR A4 3x4` | `210 x 297 mm` | `12` | `LABEL-HET-CAR-1` | `printingParams[].items[]` |
| `LABEL-HET-INTELLIGENT-3-4` | `a4-canvas` | `和而泰智能 3*4` | `210 x 297 mm` | `12` | `LABEL-HET-INTELLIGENT-1` | `printingParams[].items[]` |
| `LABEL-HW-1` | `label-canvas` | `HUAWEI 单页 A4 标签` | `297 x 210 mm` | `1` | - | `printingParams[]` 直接传字段 |
| `rohs-7` | `label-canvas` | `RoHS - 7` | `297 x 120 mm` | `1` | - | `printingParams[]`（内含模板自身 `items`，≤7 行） |
| `rohs-18` | `label-canvas` | `RoHS - 18` | `297 x 120 mm` | `1` | - | `printingParams[]`（内含模板自身 `items`，≤18 行） |

## 每个模板的请求参数

除特殊标注外，大多数字段 `required=false`，为空时页面通常显示占位值或空白。

### `katata-label`（亦用于 `katata-3-8` 的 `items[]`）

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `deliveryName` | `string` | Delivery Name |
| `itemNum` | `string` | Cust Item Num |
| `sku` | `string` | SKU |
| `qrcode` | `qrcode` | QR Code |
| `qty` | `string` | Delivery QTY |
| `cust` | `string` | Cust |
| `makeIn` | `string` | Make In |

### `carton-label-canvas`（亦用于 `carton-a4-sheet` 的 `items[]`）

| 参数 | 类型 |
| --- | --- |
| `ATICode` / `MFRCode` / `orderNo` / `qty` / `serialNo` | `string` |
| `qrcode` | `qrcode` |

### `LABEL-FLEXTRONICS-2-5` 的 `items[]`

| 参数 | 类型 | 占位示例 |
| --- | --- | --- |
| `productCode` | `string` | `ME2607-0628` |
| `topQr` | `qrcode` | `ME2607-0628\|KOA\|JAPAN` |
| `originCountry` | `string` | `Made in Japan` |
| `mfgName` | `string` | `KOA` |
| `custProdId` | `string` | `20100000635` |
| `custPo` | `string` | `4500358461` |
| `qty` | `string` | `10000` |
| `mfgPn` | `string` | `KOA/RN73H1ETTP 6802B25` |
| `midQr` | `qrcode` | `KOA/RN73H1ETTP 6802B25` |
| `dateCode` | `string` | `2624` |
| `lotNo` | `string` | `2624` |

### `LABEL-HET-CAR-3-4` 的 `items[]`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `year` / `month` | `string` | 否 | 年 / 月 |
| `itemCode` / `itemName` / `specModel` | `string` | 否 | 物料编码 / 名称 / 规格型号 |
| `qty` | `string` | 否 | 数量 |
| `supplier` | `string` | 否 | 供应商 |
| `inspectionStatus` | `string` | 否 | 检验状态 |
| `productionDate` | `string` | 否 | 生产日期 |
| `orderNo` | `string` | 否 | 订单号 |
| `originText` | `string` | 否 | 原产地文本 |
| `qrPayload` | `qrcode` | 否 | 二维码值 |
| `barcodeValue` | `string` | 否 | 条码值 |
| `extraCode` | `string` | 否 | 底部附加码 |
| `barCode` | `string` | **是** | 建议与 `barcodeValue` 保持一致或按模板实际绑定值传入 |

### `LABEL-HET-INTELLIGENT-3-4` 的 `items[]`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `year` / `month` | `string` | 年 / 月 |
| `itemCode` / `itemName` / `specModel` | `string` | 物料编码 / 名称 / 规格型号 |
| `quantity` | `string` | 数量 |
| `supplier` | `string` | 供应商 |
| `inspectionStatus` | `string` | 检验状态 |
| `productionDate` | `string` | 生产日期 |
| `orderNo` | `string` | 订单号 |
| `traceCode` | `qrcode` | 二维码与底部主码都围绕该值渲染，建议始终传 |
| `extraCode` | `string` | 底部附加码 |

### `LABEL-HW-1`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `customerName` / `invNo` | `string` | 客户名 / 发票号 |
| `qrPayload` | `qrcode` | 二维码值 |
| `row_3_1` … `row_3_5` | `string` | 明细行五列 |
| `makeIn` | `string` | 产地 |
| `page` / `total` | `string` | 页码 / 总页数 |
| `showTailBox` | `boolean` | `true` 且 `page = total` 时显示“尾箱 / NO TRUNKFUL”合并单元格文字；`false` 始终隐藏 |

### `rohs-7` / `rohs-18`

外层 `printingParams[]` 字段：`items`（模板自身明细表，非 A4 接口的 `items`）、`cusNo`、`page`、`total`、`qrcode`、`cusNo2`。

`items[]` 子项：`item`（序号）、`partNumber`（料号）、`desc`（描述）、`qty`（数量）、`poNumber`（PO 号）；`rohs-7` 另有 `drawingNo`（图号）。`rohs-7` ≤ 7 行，`rohs-18` ≤ 18 行。

## 常见错误

| 错误 | 原因 |
| --- | --- |
| `TEMPLATE_ID_REQUIRED` | `templateId` 未传 |
| `PRINTING_PARAMS_REQUIRED` | `printingParams` 为空数组 |
| `INVALID_PRINTING_PARAMS` | A4 模板没按 `printingParams[i].items` 传数组 / `items` 超槽位数 / 项不是对象 |
| `当前模板还没有关联 Label Template` | A4 模板未关联 Label Template；先用 `GET /api/v1/a4-templates/{templateId}/runtime` 确认 |
| `printerName is required` | 请求未传 `printerName` 且模板无默认打印机 |

## 联调示例

打印单张 Label：

```bash
curl -X POST "http://127.0.0.1:9003/api/v1/templates/dynamic-print" \
  -H "Content-Type: application/json" \
  -d '{"templateId":"katata-label","printingParams":[{"deliveryName":"KATATA DELIVERY","itemNum":"ITEM-001","sku":"SKU-001","qrcode":"KATATA|ITEM-001|SKU-001","qty":"100","cust":"KATATA","makeIn":"CN"}],"printerName":"ZDesigner ZD421","copies":1,"mode":"auto"}'
```

打印一页 A4：

```bash
curl -X POST "http://127.0.0.1:9003/api/v1/templates/dynamic-print" \
  -H "Content-Type: application/json" \
  -d '{"templateId":"LABEL-HET-INTELLIGENT-3-4","printingParams":[{"items":[{"year":"2026","month":"07","itemCode":"20100000554","itemName":"贴片厚膜电阻器","specModel":"KOA+RK73H1JTTD 4320F","quantity":"125000","supplier":"创意电子（澳门离岸商业服务）有限公司","inspectionStatus":"OK","productionDate":"2629","orderNo":"4500370953","traceCode":"20100000554-10806-2629-125000","extraCode":"ME2607-0634"}]}],"printerName":"Brother HL-5590DN Printer","copies":1,"mode":"auto","orientation":"portrait"}'
```

---

# 打印任务状态确认

所有打印入口（`/print/files`、`/templates/dynamic-print`）的响应都带 `jobId`；提交成功不代表打印机已完成。用
`GET /api/v1/print/jobs/{jobId}` 轮询确认最终结果：

- `status: "success"` — 已提交到打印队列并完成
- `status: "failed"` / `"error"` — 失败，看 `diagnostics` 与 `logPath`

`/print/files` 的任务直接放在响应 `data` 里（`templateName: "direct-file-print"`），`/templates/dynamic-print`
的任务在 `data.jobs[]` 里。admin 的 `printFile()` / `waitForPrintJob()`（`apps/admin/utils/print.ts`）已封装这两种
结构与轮询逻辑。

`/print/files` 实测响应示例：

```json
{
  "ok": true,
  "data": {
    "jobId": "job-20260820-143254.710",
    "traceId": "job-20260820-143254.710",
    "templateName": "direct-file-print",
    "printerName": "MYPRINTER",
    "requestedMode": "auto",
    "status": "success",
    "strategy": { "mode": "cups-lp", "queueDriver": "CUPS IPP Queue", "queuePort": "ipp://192.168.5.11/ipp/print" },
    "output": { "imagePath": "/opt/label-printing-center-linux-x64/runtime/uploads/1787207574709775359-badge-wing_wu.png" },
    "logPath": "/opt/label-printing-center-linux-x64/logs/print-20260820-143259.log",
    "diagnostics": ["printer_name=MYPRINTER", "queue_found=true", "strategy_mode=cups-lp"],
    "createdAt": "2026-08-20T14:32:54+08:00",
    "updatedAt": "2026-08-20T14:32:59+08:00"
  }
}
```
