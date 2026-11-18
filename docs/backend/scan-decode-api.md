# 标签解码接口使用说明（对外公开接口）

`POST /scan/decode` 是仓库系统的**服务端标签解码接口**：把扫码枪扫到的原始标签内容（raw）交给服务端，按已维护的供应商 QR 模板解析出料号、数量、日期码、批次号等信息。

- 该接口自 2026-11-18 起**对第三方系统公开**，调用时**不需要 Bearer Token**。
- 接口为**只读**操作，不会修改任何业务数据。
- 实现位置：`apps/backend/src/routes/decode.ts` + `apps/backend/src/decode/`。

## 请求

```
POST {后端地址}/scan/decode
Content-Type: application/json
```

例如本机开发环境：`http://127.0.0.1:3002/scan/decode`

### 请求体参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `raw` | string | **是** | 扫码得到的原始标签内容（完整字符串，原样传入，不要自行截断或转小写） |
| `targets` | string[] | 否 | 当前单据的料号 / WCL 货号列表。传入后只有解析出的料号命中其中一项才算匹配；不传表示接受任意料号 |
| `supplierCode` | string | 否 | 已知供应商编号时传入，该供应商的模板会优先尝试，可提高准确率 |
| `brands` | string[] | 否 | 当前单据涉及的品牌列表（如 `["NCC"]`），与品牌相关的模板会排在前面优先尝试 |

> 建议：如果你能确定这是某张收货单 / 拣货单上的标签，把单据上的料号放进 `targets`，可以避免同一家供应商不同料号模板之间的误匹配。

### 请求示例

```bash
curl -X POST "http://127.0.0.1:3002/scan/decode" \
  -H "Content-Type: application/json" \
  -d '{
    "raw": "PN=RK73H1JTTD3302F;Q=500;DC=2609;SN=900001",
    "targets": ["RK73H1JTTD3302F"],
    "supplierCode": "22"
  }'
```

> 上面 `raw` 只是示例格式，真实标签内容以各供应商实际打印为准，原样传入即可。

## 响应

返回 `application/json`，结构如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `matched` | boolean | 是否有模板命中。`false` 表示服务端无法解析该标签（可自行做兜底解析） |
| `parsed.itemId` | string \| null | 解析出的料号（已按系统规则规范化） |
| `parsed.qty` | number | 数量（标签上有才返回） |
| `parsed.coo` | string | 产地（Country of Origin，标签上有才返回） |
| `parsed.dateCode` | string | 日期码（标签上有才返回） |
| `parsed.lotCode` | string | 批次号（标签上有才返回） |
| `parsed.wclItemNo` | string | 对应的 WCL 货号（标签上有才返回） |
| `parsed.serialNo` | string | 序列号（标签上有才返回） |
| `options` | object | 各字段的候选值列表（一般取 `parsed` 即可；`options.itemIds` 等为解析过程中出现过的候选） |
| `supplier` | object | 命中的供应商信息：`{ code, brands }` |

### 响应示例（命中）

```json
{
  "matched": true,
  "parsed": {
    "itemId": "RK73H1JTTD3302F",
    "qty": 500,
    "dateCode": "2609",
    "serialNo": "900001"
  },
  "options": {
    "itemIds": ["RK73H1JTTD3302F"],
    "qtys": [500],
    "coos": [],
    "dateCodes": ["2609"],
    "lotCodes": [],
    "cows": []
  },
  "supplier": { "code": "22" }
}
```

### 响应示例（未命中）

```json
{
  "matched": false,
  "parsed": { "itemId": null },
  "options": { "itemIds": [], "qtys": [], "coos": [], "dateCodes": [], "lotCodes": [], "cows": [] }
}
```

## 错误码

| HTTP 状态码 | 说明 |
|---|---|
| 200 | 成功（注意：`matched:false` 也是 200，只是没解析出来） |
| 400 | 请求体不合法，例如 `raw` 缺失 / 不是字符串，或 `targets`、`brands` 不是字符串数组 |
| 405 | 方法错误（只接受 POST） |

## 注意事项

1. **无需鉴权**：任何人能访问到后端地址即可调用，请确保后端只在内网 / 受控网络中暴露。
2. `raw` 请原样传入完整的扫码内容；如果扫码枪会在末尾带换行，建议先 `trim`。
3. NCC（Chemi-Con）标签上的数字图号是**内部绘图码**，接口会自动通过图号对照表解析出真实货号；TE 品牌标签截断的 MPN 也会自动从物料主档补全。
4. 需要新增 / 调整某家供应商的解析模板时，请在仓库后台的供应商资料中维护 QR 模板，无需改动调用方代码。
