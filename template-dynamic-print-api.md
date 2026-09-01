# 根据 templateId 动态打印 A4 / Label 接口说明

本文基于当前后端实际实现整理，适用于以下模板：

- `katata-3-8`
- `katata-label`
- `carton-a4-sheet`
- `carton-label-canvas`
- `LABEL-FLEXTRONICS-2-5`
- `LABEL-HET-CAR-3-4`
- `LABEL-HET-INTELLIGENT-3-4`
- `LABEL-HW-1`
- `rohs-7`
- `rohs-18`

基础地址：

- 本地默认：`http://127.0.0.1:9003`
- 统一前缀：`/api/v1`

统一响应格式：

```json
{
  "ok": true,
  "data": {}
}
```

错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误说明"
  }
}
```

## 1. 推荐联调顺序

建议按下面顺序接入：

1. `GET /api/v1/printers` 获取可用打印机
2. `POST /api/v1/print/route-preview` 预判当前 `templateId + printerName` 的打印链路
3. `POST /api/v1/templates/dynamic-print` 发起真实打印
4. `GET /api/v1/print/jobs/{jobId}` 查询单个任务执行结果

如果需要先校对版式，再打印：

1. `POST /api/v1/render/preview` 生成预览
2. 确认版式无误后再调用 `POST /api/v1/templates/dynamic-print`

## 2. 主接口：按 templateId 动态打印

- 方法：`POST`
- 路径：`/api/v1/templates/dynamic-print`
- 说明：后端会先按 `templateId` 读取模板，再根据模板类型自动区分为 `label-canvas` / `a4-canvas` 两套处理逻辑。

### 2.1 请求体

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

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `templateId` | `string` | 是 | 要打印的模板 ID |
| `printingParams` | `array<object>` | 是 | 打印数据。`label` 与 `A4` 的结构不同，见下文 |
| `printerName` | `string` | 否 | 打印机名称。不传时会尝试使用模板上配置的默认打印机 |
| `copies` | `int` | 否 | 打印份数，最小按 `1` 处理 |
| `mode` | `string` | 否 | 打印模式，常用：`auto`、`sumatra-pdf`、`windows-image-driver` |
| `orientation` | `string` | 否 | `portrait` / `landscape` / `auto` |
| `previewFirst` | `bool` | 否 | 当前版本仅透传，后端未单独实现“先预览再打印”的分支控制，建议不要依赖 |

### 2.2 返回体

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
        "templateId": "LABEL-HW-1",
        "templateName": "HUAWEI 单页 A4 标签",
        "printerName": "Brother HL-5590DN Printer",
        "requestedMode": "auto",
        "status": "success",
        "strategy": {
          "mode": "windows-image-driver",
          "queueDriver": "Microsoft IPP Class Driver",
          "queuePort": "WSD-123456"
        },
        "output": {
          "imagePath": "runtime/previews/xxx/preview.png",
          "pdfPath": "runtime/previews/xxx/render.pdf"
        },
        "logPath": "logs/print-20260811-173000.log",
        "diagnostics": [
          "batch_page=1/1"
        ],
        "createdAt": "2026-08-11T17:30:00+08:00",
        "updatedAt": "2026-08-11T17:30:02+08:00"
      }
    ]
  }
}
```

### 2.3 模板类型分支规则

#### 2.3.1 Label 模板

当 `templateId` 对应的是 `label-canvas` 时：

- `printingParams` 的每一项就是一张标签的参数
- 后端会把 `printingParams` 中的每一项各生成一个打印任务
- `totalPages = printingParams.length`

示例：

```json
{
  "templateId": "katata-label",
  "printingParams": [
    {
      "deliveryName": "KATATA DELIVERY",
      "itemNum": "ITEM-001",
      "sku": "SKU-001",
      "qrcode": "KATATA|ITEM-001|SKU-001",
      "qty": "100",
      "cust": "KATATA",
      "makeIn": "CN"
    },
    {
      "deliveryName": "KATATA DELIVERY",
      "itemNum": "ITEM-002",
      "sku": "SKU-002",
      "qrcode": "KATATA|ITEM-002|SKU-002",
      "qty": "200",
      "cust": "KATATA",
      "makeIn": "CN"
    }
  ],
  "printerName": "ZDesigner ZD421",
  "copies": 1,
  "mode": "auto"
}
```

#### 2.3.2 A4 模板

当 `templateId` 对应的是 `a4-canvas` 时：

- `printingParams` 的每一项表示一页 A4
- 每一页必须通过 `items` 传本页要摆放的标签数据
- `items.length` 不能超过该 A4 模板的槽位数 `slotCount`
- 后端会自动把 `items` 归一化为内部 `labels` 结构
- 默认会自动带上 `__hideEmptySlots=true`，未占用的槽位不渲染

推荐结构：

```json
{
  "templateId": "katata-3-8",
  "printingParams": [
    {
      "items": [
        {
          "deliveryName": "KATATA DELIVERY",
          "itemNum": "ITEM-001",
          "sku": "SKU-001",
          "qrcode": "KATATA|ITEM-001|SKU-001",
          "qty": "100",
          "cust": "KATATA",
          "makeIn": "CN"
        },
        {
          "deliveryName": "KATATA DELIVERY",
          "itemNum": "ITEM-002",
          "sku": "SKU-002",
          "qrcode": "KATATA|ITEM-002|SKU-002",
          "qty": "200",
          "cust": "KATATA",
          "makeIn": "CN"
        }
      ]
    }
  ],
  "printerName": "Brother HL-5590DN Printer",
  "copies": 1,
  "mode": "auto",
  "orientation": "portrait"
}
```

`items` 也兼容以下两种写法：

```json
{
  "items": [
    {
      "templateId": "katata-label",
      "params": {
        "deliveryName": "KATATA DELIVERY",
        "itemNum": "ITEM-001"
      }
    }
  ]
}
```

或者：

```json
{
  "items": [
    {
      "templateId": "katata-label",
      "deliveryName": "KATATA DELIVERY",
      "itemNum": "ITEM-001"
    }
  ]
}
```

旧格式 `labels` 仍兼容，但新接入建议统一使用 `items`。

### 2.4 打印模式建议

对本文列出的模板，当前全部是 `canvas` 模板，不是 `label-zpl`，所以：

- 不建议使用 `zebra-raw`
- 推荐优先使用 `auto`
- Windows 下 A4 `canvas` 模板在 `auto` 模式时会优先切到 `windows-image-driver`
- 普通 Label `canvas` 一般走 `sumatra-pdf` 或 `windows-image-driver`

实用建议：

| 场景 | 建议 `mode` |
| --- | --- |
| Windows A4 打印 | `auto` |
| Windows 单标签 canvas 打印 | `auto` |
| 需要强制走 Windows 驱动图片打印 | `windows-image-driver` |
| 需要强制走 PDF 静默打印 | `sumatra-pdf` |

## 3. 辅助接口

## 3.1 获取打印机列表

- 方法：`GET`
- 路径：`/api/v1/printers`

用途：

- 获取系统打印机名称，供 `printerName` 下拉选择

## 3.2 打印路由预判

- 方法：`POST`
- 路径：`/api/v1/print/route-preview`

请求示例：

```json
{
  "templateId": "LABEL-HET-INTELLIGENT-3-4",
  "printerName": "Brother HL-5590DN Printer",
  "mode": "auto"
}
```

返回重点字段：

| 字段 | 说明 |
| --- | --- |
| `canPrint` | 当前参数下是否允许打印 |
| `resolvedMode` | 后端最终实际采用的打印模式 |
| `riskLevel` | 风险等级：`none` / `medium` / `high` |
| `summary` | 人类可读的链路说明 |
| `strategy.queueDriver` | 打印机驱动名 |
| `strategy.queuePort` | 打印机端口名 |

## 3.3 生成预览

- 方法：`POST`
- 路径：`/api/v1/render/preview`

请求示例：

```json
{
  "templateId": "LABEL-HET-INTELLIGENT-3-4",
  "outputMode": "png",
  "params": {
    "items": [
      {
        "year": "2026",
        "month": "07",
        "itemCode": "20100000554",
        "itemName": "贴片厚膜电阻器",
        "specModel": "KOA+RK73H1JTTD 4320F",
        "quantity": "125000",
        "supplier": "创意电子（澳门离岸商业服务）有限公司",
        "inspectionStatus": "OK",
        "productionDate": "2629",
        "orderNo": "4500370953",
        "traceCode": "20100000554-10806-2629-125000",
        "extraCode": "ME2607-0634"
      }
    ]
  }
}
```

说明：

- 主要用于联调时先确认版式
- 返回 `previewImageUrl`、`output.imagePath`、`output.pdfPath`

## 3.4 查看 A4 模板运行时信息

- 方法：`GET`
- 路径：`/api/v1/a4-templates/{templateId}/runtime`

用途：

- 查询 A4 模板当前关联的 Label Template
- 查询 `slotCount`
- 查询后端返回的 `requestExample`

适合用于前端动态生成 A4 打印入参。

## 3.5 查看打印任务

- 方法：`GET`
- 路径：`/api/v1/print/jobs/{jobId}`

用途：

- 查看单个任务状态
- 获取落盘文件路径、日志路径、diagnostics

## 4. 本次模板清单与建议入参

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
| `rohs-7` | `label-canvas` | `RoHS - 7` | `297 x 120 mm` | `1` | - | `printingParams[]` 直接传字段 |
| `rohs-18` | `label-canvas` | `RoHS - 18` | `297 x 120 mm` | `1` | - | `printingParams[]` 直接传字段 |

## 5. 每个模板的请求参数清单

说明：

- 本节按模板逐个展开
- `label-canvas` 模板：直接传 `printingParams[]` 中的字段
- `a4-canvas` 模板：外层固定为 `printingParams[].items[]`，`items[]` 内字段来自其关联的 Label Template
- 除特殊标注外，大多数字段在模板配置中 `required=false`，允许为空，但为空时页面上通常会显示占位值或空白

### 5.1 `katata-label`

请求结构：

```json
{
  "templateId": "katata-label",
  "printingParams": [
    {
      "deliveryName": "string",
      "itemNum": "string",
      "sku": "string",
      "qrcode": "string",
      "qty": "string",
      "cust": "string",
      "makeIn": "string"
    }
  ]
}
```

参数说明：

| 参数名 | 类型 | 必填 | 模板标题 | 占位示例 |
| --- | --- | --- | --- | --- |
| `deliveryName` | `string` | 否 | `Delivery Name` | `[deliveryName]` |
| `itemNum` | `string` | 否 | `Cust Item Num` | `[itemNum]` |
| `sku` | `string` | 否 | `SKU` | `[sku]` |
| `qrcode` | `qrcode` | 否 | `QR Code` | `[qrcode]` |
| `qty` | `string` | 否 | `Delivery QTY` | `[qty]` |
| `cust` | `string` | 否 | `Cust` | `[cust]` |
| `makeIn` | `string` | 否 | `Make In` | `[makeIn]` |

### 5.2 `katata-3-8`

模板类型：`a4-canvas`  
关联标签模板：`katata-label`  
槽位数：`24`

请求结构：

```json
{
  "templateId": "katata-3-8",
  "printingParams": [
    {
      "items": [
        {
          "deliveryName": "string",
          "itemNum": "string",
          "sku": "string",
          "qrcode": "string",
          "qty": "string",
          "cust": "string",
          "makeIn": "string"
        }
      ]
    }
  ]
}
```

说明：

- `printingParams` 每一项代表 1 页 A4
- `items` 最多传 `24` 条
- `items[]` 内字段与 `katata-label` 完全一致

### 5.3 `carton-label-canvas`

请求结构：

```json
{
  "templateId": "carton-label-canvas",
  "printingParams": [
    {
      "ATICode": "string",
      "MFRCode": "string",
      "orderNo": "string",
      "qty": "string",
      "serialNo": "string",
      "qrcode": "string"
    }
  ]
}
```

参数说明：

| 参数名 | 类型 | 必填 | 模板标题 | 占位示例 |
| --- | --- | --- | --- | --- |
| `ATICode` | `string` | 否 | `html-element-1785321129602-hs656` | `[ATICode]` |
| `MFRCode` | `string` | 否 | `html-element-1785321172910-vfpwr` | `[MFRCode]` |
| `orderNo` | `string` | 否 | `html-element-1785321202279-oeqqt` | `[orderNo]` |
| `qty` | `string` | 否 | `html-element-1785321213951-9ea7z` | `[qty]` |
| `serialNo` | `string` | 否 | `html-element-1785321227478-db6uf` | `[serialNo]` |
| `qrcode` | `qrcode` | 否 | `qrcode` | `[qrcode]` |

### 5.4 `carton-a4-sheet`

模板类型：`a4-canvas`  
关联标签模板：`carton-label-canvas`  
槽位数：`10`

请求结构：

```json
{
  "templateId": "carton-a4-sheet",
  "printingParams": [
    {
      "items": [
        {
          "ATICode": "string",
          "MFRCode": "string",
          "orderNo": "string",
          "qty": "string",
          "serialNo": "string",
          "qrcode": "string"
        }
      ]
    }
  ]
}
```

说明：

- `items` 最多传 `10` 条
- `items[]` 内字段与 `carton-label-canvas` 完全一致

### 5.5 `LABEL-FLEXTRONICS-2-5`

模板类型：`a4-canvas`  
关联标签模板：`LABEL-FLEXTRONICS-1`  
槽位数：`10`

请求结构：

```json
{
  "templateId": "LABEL-FLEXTRONICS-2-5",
  "printingParams": [
    {
      "items": [
        {
          "productCode": "string",
          "topQr": "string",
          "originCountry": "string",
          "mfgName": "string",
          "custProdId": "string",
          "custPo": "string",
          "qty": "string",
          "mfgPn": "string",
          "midQr": "string",
          "dateCode": "string",
          "lotNo": "string"
        }
      ]
    }
  ]
}
```

参数说明（`items[]` 内）：

| 参数名 | 类型 | 必填 | 占位示例 |
| --- | --- | --- | --- |
| `productCode` | `string` | 否 | `ME2607-0628` |
| `topQr` | `qrcode` | 否 | `ME2607-0628|KOA|JAPAN` |
| `originCountry` | `string` | 否 | `Made in Japan` |
| `mfgName` | `string` | 否 | `KOA` |
| `custProdId` | `string` | 否 | `20100000635` |
| `custPo` | `string` | 否 | `4500358461` |
| `qty` | `string` | 否 | `10000` |
| `mfgPn` | `string` | 否 | `KOA/RN73H1ETTP 6802B25` |
| `midQr` | `qrcode` | 否 | `KOA/RN73H1ETTP 6802B25` |
| `dateCode` | `string` | 否 | `2624` |
| `lotNo` | `string` | 否 | `2624` |

### 5.6 `LABEL-HET-CAR-3-4`

模板类型：`a4-canvas`  
关联标签模板：`LABEL-HET-CAR-1`  
槽位数：`12`

请求结构：

```json
{
  "templateId": "LABEL-HET-CAR-3-4",
  "printingParams": [
    {
      "items": [
        {
          "year": "string",
          "month": "string",
          "itemCode": "string",
          "itemName": "string",
          "specModel": "string",
          "qty": "string",
          "supplier": "string",
          "inspectionStatus": "string",
          "productionDate": "string",
          "orderNo": "string",
          "originText": "string",
          "qrPayload": "string",
          "barcodeValue": "string",
          "extraCode": "string",
          "barCode": "string"
        }
      ]
    }
  ]
}
```

参数说明（`items[]` 内）：

| 参数名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `year` | `string` | 否 | `2026` | 年 |
| `month` | `string` | 否 | `07` | 月 |
| `itemCode` | `string` | 否 | `20100000554` | 物料编码 |
| `itemName` | `string` | 否 | `貼片厚膜電阻器` | 物料名称 |
| `specModel` | `string` | 否 | `KOA+RK73H1JTTD 4320F` | 规格型号 |
| `qty` | `string` | 否 | `5000` | 数量 |
| `supplier` | `string` | 否 | `創意電子(澳門離岸商業服務)有限公司` | 供应商 |
| `inspectionStatus` | `string` | 否 | `OK` | 检验状态 |
| `productionDate` | `string` | 否 | `2629` | 生产日期 |
| `orderNo` | `string` | 否 | `4500370953` | 订单号 |
| `originText` | `string` | 否 | `Made In China` | 原产地文本 |
| `qrPayload` | `qrcode` | 否 | `20100000554-10806-26290001-005000` | 二维码值 |
| `barcodeValue` | `string` | 否 | `20100000554-10806-26290001-005000` | 条码值 |
| `extraCode` | `string` | 否 | `ME2607-0634` | 底部附加码 |
| `barCode` | `string` | 是 | `20100000554-10806-26290003-005000` | 模板配置里单独存在，建议与 `barcodeValue` 保持一致或按模板实际绑定值传入 |

### 5.7 `LABEL-HET-INTELLIGENT-3-4`

模板类型：`a4-canvas`  
关联标签模板：`LABEL-HET-INTELLIGENT-1`  
槽位数：`12`

请求结构：

```json
{
  "templateId": "LABEL-HET-INTELLIGENT-3-4",
  "printingParams": [
    {
      "items": [
        {
          "year": "string",
          "month": "string",
          "itemCode": "string",
          "itemName": "string",
          "specModel": "string",
          "quantity": "string",
          "supplier": "string",
          "inspectionStatus": "string",
          "productionDate": "string",
          "orderNo": "string",
          "traceCode": "string",
          "extraCode": "string"
        }
      ]
    }
  ]
}
```

参数说明（`items[]` 内）：

| 参数名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `year` | `string` | 否 | `2026` | 年 |
| `month` | `string` | 否 | `07` | 月 |
| `itemCode` | `string` | 否 | `20100000554` | 物料编码 |
| `itemName` | `string` | 否 | `贴片厚膜电阻器` | 物料名称 |
| `specModel` | `string` | 否 | `KOA+RK73H1JTTD 4320F` | 规格型号 |
| `quantity` | `string` | 否 | `125000` | 数量 |
| `supplier` | `string` | 否 | `创意电子（澳门离岸商业服务）有限公司` | 供应商 |
| `inspectionStatus` | `string` | 否 | `OK` | 检验状态 |
| `productionDate` | `string` | 否 | `2629` | 生产日期 |
| `orderNo` | `string` | 否 | `4500370953` | 订单号 |
| `traceCode` | `qrcode` | 否 | `20100000554-10806-2629-125000` | 当前模板中二维码与底部主码都围绕该值渲染，建议始终传 |
| `extraCode` | `string` | 否 | `ME2607-0634` | 底部附加码 |

### 5.8 `LABEL-HW-1`

请求结构：

```json
{
  "templateId": "LABEL-HW-1",
  "printingParams": [
    {
      "customerName": "string",
      "invNo": "string",
      "qrPayload": "string",
      "row_3_1": "string",
      "row_3_2": "string",
      "row_3_3": "string",
      "row_3_4": "string",
      "row_3_5": "string",
      "makeIn": "string",
      "page": "string",
      "total": "string",
      "showTailBox": true
    }
  ]
}
```

参数说明：

| 参数名 | 类型 | 必填 | 占位示例 |
| --- | --- | --- | --- |
| `customerName` | `string` | 否 | `HUAWEI` |
| `invNo` | `string` | 否 | `ME2607-0611` |
| `qrPayload` | `qrcode` | 否 | `QR Payload` |
| `row_3_1` | `string` | 否 | `1` |
| `row_3_2` | `string` | 否 | `07790001-009` |
| `row_3_3` | `string` | 否 | `SG73P2ARTTD 60R4F` |
| `row_3_4` | `string` | 否 | `HKHWWYG3576614-10` |
| `row_3_5` | `string` | 否 | `200,000` |
| `makeIn` | `string` | 否 | `MADE IN JAPAN` |
| `page` | `string` | 否 | `7` |
| `total` | `string` | 否 | `7` |
| `showTailBox` | `boolean` | 否 | `true` |

说明：

- `showTailBox` 用于控制“尾箱 / NO TRUNKFUL”合并单元格功能是否启用
- 当 `showTailBox = true` 且 `page = total` 时，显示该合并单元格内的文字内容
- 当 `showTailBox = false` 时，无论是否最后一页都隐藏该合并单元格内的文字内容

### 5.9 `rohs-7`

请求结构：

```json
{
  "templateId": "rohs-7",
  "printingParams": [
    {
      "items": [
        {
          "item": "string",
          "partNumber": "string",
          "desc": "string",
          "qty": "string",
          "poNumber": "string",
          "drawingNo": "string"
        }
      ],
      "cusNo": "string",
      "page": "string",
      "total": "string",
      "qrcode": "string",
      "cusNo2": "string"
    }
  ]
}
```

参数说明：

| 参数名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `items` | `array<object>` | 否 | `[items]` | 模板自身业务字段，不是 A4 打印接口里的 `items` |
| `cusNo` | `string` | 否 | `0` | 客户编号 |
| `page` | `string` | 否 | `[page]` | 页码 |
| `total` | `string` | 否 | `[total]` | 总数 |
| `qrcode` | `qrcode` | 否 | `[qrcode]` | 二维码值 |
| `cusNo2` | `string` | 否 | `0` | 备用客户编号 |

`items[]` 子项字段：

| 字段名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `item` | `string` | 否 | `0` | 序号/项次 |
| `partNumber` | `string` | 否 | `0` | 料号 |
| `desc` | `string` | 否 | `0` | 描述 |
| `qty` | `string` | 否 | `-` | 数量 |
| `poNumber` | `string` | 否 | `0` | PO 号 |
| `drawingNo` | `string` | 否 | `0` | 图号 |

说明：

- `rohs-7` 的明细表有 `7` 行，建议 `items.length <= 7`

### 5.10 `rohs-18`

请求结构：

```json
{
  "templateId": "rohs-18",
  "printingParams": [
    {
      "items": [
        {
          "item": "string",
          "partNumber": "string",
          "desc": "string",
          "qty": "string",
          "poNumber": "string"
        }
      ],
      "cusNo": "string",
      "page": "string",
      "total": "string",
      "qrcode": "string",
      "cusNo2": "string"
    }
  ]
}
```

参数说明：

| 参数名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `items` | `array<object>` | 否 | `[items]` | 模板自身业务字段，不是 A4 打印接口里的 `items` |
| `cusNo` | `string` | 否 | `0` | 客户编号 |
| `page` | `string` | 否 | `[page]` | 页码 |
| `total` | `string` | 否 | `[total]` | 总数 |
| `qrcode` | `qrcode` | 否 | `[qrcode]` | 二维码值 |
| `cusNo2` | `string` | 否 | `0` | 备用客户编号 |

`items[]` 子项字段：

| 字段名 | 类型 | 必填 | 占位示例 | 备注 |
| --- | --- | --- | --- | --- |
| `item` | `string` | 否 | `0` | 序号/项次 |
| `partNumber` | `string` | 否 | `0` | 料号 |
| `desc` | `string` | 否 | `0` | 描述 |
| `qty` | `string` | 否 | `-` | 数量 |
| `poNumber` | `string` | 否 | `0` | PO 号 |

说明：

- `rohs-18` 的明细表有 `18` 行，建议 `items.length <= 18`

## 6. 常见错误与排查

### 6.1 `TEMPLATE_ID_REQUIRED`

原因：

- `templateId` 未传

### 6.2 `PRINTING_PARAMS_REQUIRED`

原因：

- `printingParams` 为空数组

### 6.3 `INVALID_PRINTING_PARAMS`

常见原因：

- A4 模板没有按 `printingParams[i].items` 传数组
- `items` 数量超过当前 A4 模板槽位数
- `printingParams[i]` 不是对象

### 6.4 `当前模板还没有关联 Label Template`

原因：

- A4 模板没有关联对应的 Label Template

处理建议：

- 先调用 `GET /api/v1/a4-templates/{templateId}/runtime` 确认 `labelTemplate`

### 6.5 `printerName is required`

原因：

- 请求没有传 `printerName`
- 模板本身也没有配置默认打印机

## 7. 最简联调示例

### 7.1 打印单张 Label

```bash
curl -X POST "http://127.0.0.1:9003/api/v1/templates/dynamic-print" ^
  -H "Content-Type: application/json" ^
  -d "{\"templateId\":\"katata-label\",\"printingParams\":[{\"deliveryName\":\"KATATA DELIVERY\",\"itemNum\":\"ITEM-001\",\"sku\":\"SKU-001\",\"qrcode\":\"KATATA|ITEM-001|SKU-001\",\"qty\":\"100\",\"cust\":\"KATATA\",\"makeIn\":\"CN\"}],\"printerName\":\"ZDesigner ZD421\",\"copies\":1,\"mode\":\"auto\"}"
```

### 7.2 打印一页 A4

```bash
curl -X POST "http://127.0.0.1:9003/api/v1/templates/dynamic-print" ^
  -H "Content-Type: application/json" ^
  -d "{\"templateId\":\"LABEL-HET-INTELLIGENT-3-4\",\"printingParams\":[{\"items\":[{\"year\":\"2026\",\"month\":\"07\",\"itemCode\":\"20100000554\",\"itemName\":\"贴片厚膜电阻器\",\"specModel\":\"KOA+RK73H1JTTD 4320F\",\"quantity\":\"125000\",\"supplier\":\"创意电子（澳门离岸商业服务）有限公司\",\"inspectionStatus\":\"OK\",\"productionDate\":\"2629\",\"orderNo\":\"4500370953\",\"traceCode\":\"20100000554-10806-2629-125000\",\"extraCode\":\"ME2607-0634\"}]}],\"printerName\":\"Brother HL-5590DN Printer\",\"copies\":1,\"mode\":\"auto\",\"orientation\":\"portrait\"}"
```
