import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkVmiDrafts, parseVmiAoa, vmiQty } from "~/utils/vmiExcel";

const require = createRequire(import.meta.url);

// The real reference sheet (supporting_doc/vmi/VMI_Template_20261105.xlsx) —
// read via xlsx here and passed to the parser as a plain AOA.
const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../supporting_doc/vmi/VMI_Template_20261105.xlsx"
);

function fixtureAoa(): unknown[][] {
  const XLSX = require("xlsx");
  const wb = XLSX.read(readFileSync(FIXTURE));
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

describe("parseVmiAoa", () => {
  it("groups the real sheet by VMI Ref.No in first-seen order", () => {
    const orders = parseVmiAoa(fixtureAoa());
    expect(orders).toHaveLength(10);
    expect(orders.map((o) => o.orderNo)).toEqual([
      "VMI-58051",
      "VMI-58052",
      "VMI-58053",
      "VMI-58054",
      "VMI-58055",
      "VMI-58056",
      "VMI-58057",
      "VMI-58058",
      "VMI-58059",
      "VMI-58060",
    ]);

    const first = orders[0]!;
    expect(first.customerCode).toBe("SZ-HUAWEI-02");
    expect(first.customerName).toBe("华为技术有限公司");
    expect(first.poNo).toBe("VHWH00022045");
    expect(first.subInventoryCode).toBe("HUAWEI");
    expect(first.shipTo).toMatch(/^Huawei Technologies/);
    expect(first.items).toHaveLength(2); // PO lines 1 + 2 of the same ref
    expect(first.items[0]).toEqual({
      customerItem: "07092612",
      partNo: "KOA/TLR3APDTE L500F75",
      qty: "2000",
      lineNumber: "1",
    });
    expect(first.items[1]!.qty).toBe("4000");
    expect(first.items[1]!.lineNumber).toBe("2");
  });

  it("throws when no VMI header row exists", () => {
    expect(() => parseVmiAoa([["foo", "bar"], ["1", "2"]])).toThrow(/Not a VMI sheet/);
  });

  it("keeps blank-ref rows as their own flagged group", () => {
    const aoa = fixtureAoa();
    aoa.push(["", "SZ-HUAWEI-02", "", "", "", 1, "", "KOA/X", 10, "HUAWEI"]);
    const orders = parseVmiAoa(aoa);
    const last = orders[orders.length - 1]!;
    expect(last.orderNo).toBe("");
    expect(last.items).toHaveLength(1);
  });
});

describe("checkVmiDrafts", () => {
  const order = (over: object = {}) => ({
    orderNo: "VMI-1",
    customerCode: "C",
    customerName: "",
    shipTo: "",
    poNo: "",
    subInventoryCode: "HUAWEI",
    orgId: null,
    items: [{ customerItem: "", partNo: "KOA/A", qty: "100", lineNumber: "1" }],
    ...over,
  });

  it("passes a clean draft", () => {
    expect(checkVmiDrafts([order()], () => true, () => [7])).toEqual([]);
  });

  it("flags blank refs, bad qty and unknown parts", () => {
    const issues = checkVmiDrafts(
      [
        order({ orderNo: "" }),
        order({ items: [{ customerItem: "", partNo: "KOA/A", qty: "1,0X0", lineNumber: "" }] }),
        order({ items: [{ customerItem: "", partNo: "KOA/NOPE", qty: "0", lineNumber: "" }] }),
      ],
      (k) => k !== "KOA/NOPE",
      () => [7]
    );
    expect(issues.map((i) => i.code)).toEqual(["noRef", "invalidQty", "invalidQty", "unknownPart"]);
    expect(issues[3]!.partNo).toBe("KOA/NOPE");
  });

  it("flags unknown and blank sub-inventories; multi-org codes are a pick, not an issue", () => {
    const issues = checkVmiDrafts(
      [order({ subInventoryCode: "MISSING" }), order({ subInventoryCode: "TWO" }), order({ subInventoryCode: "" })],
      () => true,
      (code) => (code === "TWO" ? [2, 9] : [])
    );
    expect(issues.map((i) => i.code)).toEqual(["subInvUnknown", "noSubInv"]);
  });
});

describe("vmiQty", () => {
  it("accepts positive integers only, thousands separators tolerated", () => {
    expect(vmiQty("2000")).toBe(2000);
    expect(vmiQty("1,000")).toBe(1000);
    expect(vmiQty("0")).toBeNull();
    expect(vmiQty("-5")).toBeNull();
    expect(vmiQty("1.5")).toBeNull();
    expect(vmiQty("")).toBeNull();
  });
});
