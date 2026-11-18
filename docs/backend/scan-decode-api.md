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

## KOA 批次號 → 日期碼轉換（輔助接口）

`POST /scan/koa-date-code` 把 KOA 標籤上的批次號（LOT NO）轉換回日期碼。KOA 批次號以「2 位月計數 + 2 位日期」開頭（例如 `5420Q156` 的 `5420`）：月計數每 90 個月循環一次（10→99 後重新開始），必須對照本服務的 `date_code_counter_periods` 週期表才能還原真實日期——第三方系統不需要自行實作這套規則。

- 同樣自 2026-11-18 起**對第三方系統公開**，**不需要 Bearer Token**，只讀操作。
- `wwyy` 欄位依本倉 flow config 的 `dateCodeFormat`（香港倉為 `wwyy`）。

### 请求

```
POST {后端地址}/scan/koa-date-code
Content-Type: application/json
```

### 请求体参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `lotCode` | string | **是** | KOA 標籤上的批次號（LOT NO），原樣傳入；只有開頭的數字會被使用，後面的字母尾綴不影響結果 |
| `asOf` | string | 否 | `YYYY-MM-DD` 參考日期。同一個月計數會在每個週期重複出現，預設以「今天」為準選擇**不在未來**的最近一個週期；查歷史批次時建議傳入該批次的收貨日期，避免滾動後撞到舊週期 |

### 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `yyww` | string \| null | 標準日期碼（2 位 ISO 年 + 2 位 ISO 週），例如 `"2207"` |
| `yymmdd` | string \| null | 批次號還原出的實際日期（YYMMDD），例如 `"220220"`；保留了週格式會丟掉的具體日子 |
| `wwyy` | string \| null | 標籤格式日期碼（依本倉 `dateCodeFormat`，香港倉為 WWYY），例如 `"0722"` |
| `reason` | string | 只有解析失敗時出現，固定為 `"unresolvable_lot_code"` |

### 请求示例

```bash
curl -X POST "http://127.0.0.1:3002/scan/koa-date-code" \
  -H "Content-Type: application/json" \
  -d '{ "lotCode": "5420Q156", "asOf": "2023-01-01" }'
```

### 响应示例

```json
{ "yyww": "2207", "yymmdd": "220220", "wwyy": "0722" }
```

解析失敗（批次號不是數字開頭、計數超出週期範圍、日期不可能存在如 2 月 30 日）會回 **HTTP 200**，但三個欄位為 `null` 並附 `reason`（與 `/scan/decode` 的 `matched:false` 同一套理念）。

## 日期碼 → KOA 批次號（反向輔助接口）

`POST /scan/koa-lot-code` 是上面的反向接口：給定日期碼，算出 KOA 批次號開頭的「月計數 + 日期」4 位數字（例如 `5420`）。適用情境：外部系統握有日期碼（例如本系統收貨資料中的日期碼），需要列印或核對 KOA 相容標籤。

- 同樣自 2026-11-18 起**公開**，**不需要 Bearer Token**，只讀操作。
- 請求體與正向接口的回傳欄位同名，**三個欄位必須恰好填一個**，方便把正向接口的回應直接回填：
  | 欄位 | 說明 |
  |---|---|
  | `yyww` | 標準日期碼，如 `"2207"`；取該 ISO 週的**星期一**編碼（與標籤列印同一規則） |
  | `yymmdd` | 精確日期，如 `"220220"`；按該日編碼 |
  | `wwyy` | 標籤格式日期碼，如 `"0722"`；同樣取該週的星期一 |

### 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `lotCodeDigits` | string \| null | 批次號開頭的 4 位數字（月計數 + 日期），例如 `"5420"` |
| `counter` | number \| null | 月計數，例如 `54` |
| `day` | number \| null | 日期數字，例如 `20` |
| `reason` | string | 只有編碼失敗時出現，固定為 `"date_outside_counter_periods"` |

> 注意：`lotCodeDigits` 是標籤上 LOT NO 的**開頭數字部分**；尾綴（如 `Q156`）不由日期決定，無法由此產生。日期超出所有週期範圍（早於 2010/12，或晚於最後一個週期的 2033/05）會回 HTTP 200 但欄位為 `null`。

### 请求示例

```bash
curl -X POST "http://127.0.0.1:3002/scan/koa-lot-code" \
  -H "Content-Type: application/json" \
  -d '{ "yymmdd": "220220" }'
```

### 响应示例

```json
{ "lotCodeDigits": "5420", "counter": 54, "day": 20 }
```

## 料號 / WCL 貨號 → 物料明細（查詢接口）

`POST /scan/part-details` 用 part_no 或 wcl_item_no 查詢物料主檔（parts master）：品牌、描述、MOQ 等明細。適用情境：外部系統握有料號（例如本系統收貨資料中的 part_no / wcl_item_no），需要取得對應的物料資料。

- 同樣自 2026-11-18 起**對第三方系統公開**，**不需要 Bearer Token**，只讀操作。
- **請求體兩個欄位必須恰好填一個**：

| 欄位 | 說明 |
|---|---|
| `partNo` | 供應商料號（part_no）。注意 part_no **不是唯一 key**：同一個料號可能對應多個 WCL 貨號，此時會全部回傳 |
| `wclItemNo` | WCL 貨號（wcl_item_no，唯一業務 key） |

- 比對為**精確比對（已規範化）**：忽略大小寫、空白字元，並自動拆解 TE 的 `AMP(...)` / `TE-AMP(...)` 包裝（與 PDA 掃碼解析同一套規則）。沒有模糊 / 子字串比對——查不到的 key 就是查不到，不會回傳相近料號。

### 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `found` | boolean | 是否有命中 |
| `parts` | object[] | 命中的物料主檔列（見下） |
| `reason` | string | 只有查無資料時出現，固定為 `"part_not_found"` |

`parts` 每一列：`{ id, partNo, wclItemNo, brand, description, moq }` — `description` / `moq` 可能為 `null`；`moq` 以十進位字串回傳。

### 请求示例

```bash
curl -X POST "http://127.0.0.1:3002/scan/part-details" \
  -H "Content-Type: application/json" \
  -d '{ "partNo": "1-1571983-1" }'
```

### 响应示例

```json
{
  "found": true,
  "parts": [
    { "id": "…", "partNo": "TE-AMP(1-1571983-1)", "wclItemNo": "TE-1571983-1", "brand": "TE", "description": "…", "moq": null }
  ]
}
```

查無資料時回 **HTTP 200**，`found` 為 `false`、`parts` 為空陣列並附 `reason`（與 `/scan/decode` 的 `matched:false` 同一套理念）。

## 注意事项

1. **无需鉴权**：任何人能访问到后端地址即可调用，请确保后端只在内网 / 受控网络中暴露。
2. `raw` 请原样传入完整的扫码内容；如果扫码枪会在末尾带换行，建议先 `trim`。
3. NCC（Chemi-Con）标签上的数字图号是**内部绘图码**，接口会自动通过图号对照表解析出真实货号；TE 品牌标签截断的 MPN 也会自动从物料主档补全。
4. 需要新增 / 调整某家供应商的解析模板时，请在仓库后台的供应商资料中维护 QR 模板，无需改动调用方代码。
