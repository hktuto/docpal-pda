import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../../db/id.js";
import { and, eq, or, ilike } from "drizzle-orm";
import {
  shelves,
  suppliers,
  supplierProfiles,
  parts,
  countryList,
  boxSizeList,
  customerProfiles,
  netWeightFormula,
  userGroups,
  userGroupMembers,
} from "../../db/schema/index.js";
import { createCrudRouter, reqStr, optStr, reqInt, reqNum, optJson } from "./crud.js";
import { shelfBoxesRoute } from "./shelfBoxes.js";
import { adminUsersRoute } from "./users.js";
import { adminFlowEditsRoute } from "./flowEdits.js";
import { adminSubInventoriesRoute } from "./subInventories.js";
import { adminSubInventoryShareGroupsRoute } from "./subInventoryShareGroups.js";
import { adminIssuesRoute } from "./issues.js";
import { adminAppDownloadRoute } from "./appDownload.js";

// Optional id on create: use the client's when given, else generate one.
function optId(body: Record<string, unknown>): string {
  const v = body.id;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : newId();
}

export const adminRoute = new Hono();

adminRoute.route(
  "/shelves",
  createCrudRouter({
    table: shelves,
    pk: shelves.code,
    create: (b) => ({
      id: optId(b),
      code: reqStr(b, "code"),
      zone: optStr(b, "zone"),
    }),
    update: (b) => ({
      ...(b.zone !== undefined && { zone: optStr(b, "zone") }),
      lastUpdateDate: new Date(),
    }),
  })
);

adminRoute.route(
  "/suppliers",
  createCrudRouter({
    table: suppliers,
    pk: suppliers.id,
    create: (b) => ({
      id: optId(b),
      code: reqStr(b, "code"),
      name: reqStr(b, "name"),
      shortName: optStr(b, "shortName"),
    }),
    update: (b) => ({
      ...(b.code !== undefined && { code: reqStr(b, "code") }),
      ...(b.name !== undefined && { name: reqStr(b, "name") }),
      ...(b.shortName !== undefined && { shortName: optStr(b, "shortName") }),
    }),
  })
);

adminRoute.route(
  "/supplier-profiles",
  createCrudRouter({
    table: supplierProfiles,
    pk: supplierProfiles.id,
    create: (b) => ({
      id: optId(b),
      supplierCode: reqStr(b, "supplierCode"),
      name: optStr(b, "name"),
      qrTemplate: optStr(b, "qrTemplate"),
      qrTemplateConfig: optJson(b, "qrTemplateConfig"),
      qrType: optStr(b, "qrType"),
      qtyEncoding: optStr(b, "qtyEncoding"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.supplierCode !== undefined && { supplierCode: reqStr(b, "supplierCode") }),
      ...(b.name !== undefined && { name: optStr(b, "name") }),
      ...(b.qrTemplate !== undefined && { qrTemplate: optStr(b, "qrTemplate") }),
      ...(b.qrTemplateConfig !== undefined && { qrTemplateConfig: optJson(b, "qrTemplateConfig") }),
      ...(b.qrType !== undefined && { qrType: optStr(b, "qrType") }),
      ...(b.qtyEncoding !== undefined && { qtyEncoding: optStr(b, "qtyEncoding") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      lastUpdateDate: new Date(),
    }),
  })
);

adminRoute.route(
  "/parts",
  createCrudRouter({
    table: parts,
    pk: parts.id,
    orderBy: parts.partNo,
    // ~100k rows from the Oracle parts master — the admin list uses
    // server-side paging/search (?page=&pageSize=&q=).
    search: (q) => {
      const like = `%${q}%`;
      return or(
        ilike(parts.partNo, like),
        ilike(parts.wclItemNo, like),
        ilike(parts.description, like),
        ilike(parts.brand, like)
      )!;
    },
    filters: { brand: (v) => ilike(parts.brand, `%${v}%`) },
    sorts: {
      partNo: parts.partNo,
      brand: parts.brand,
      wclItemNo: parts.wclItemNo,
      description: parts.description,
      defaultCoo: parts.defaultCoo,
    },
    create: (b) => ({
      id: optId(b),
      brand: reqStr(b, "brand"),
      partNo: reqStr(b, "partNo"),
      wclItemNo: optStr(b, "wclItemNo"),
      description: optStr(b, "description"),
      defaultCoo: optStr(b, "defaultCoo"),
    }),
    update: (b) => ({
      ...(b.brand !== undefined && { brand: reqStr(b, "brand") }),
      ...(b.partNo !== undefined && { partNo: reqStr(b, "partNo") }),
      ...(b.wclItemNo !== undefined && { wclItemNo: optStr(b, "wclItemNo") }),
      ...(b.description !== undefined && { description: optStr(b, "description") }),
      ...(b.defaultCoo !== undefined && { defaultCoo: optStr(b, "defaultCoo") }),
    }),
  })
);

adminRoute.route(
  "/countries",
  createCrudRouter({
    table: countryList,
    pk: countryList.code,
    create: (b) => ({ id: optId(b), code: reqStr(b, "code"), name: reqStr(b, "name") }),
    update: (b) => ({
      ...(b.name !== undefined && { name: reqStr(b, "name") }),
    }),
  })
);

adminRoute.route(
  "/box-sizes",
  createCrudRouter({
    table: boxSizeList,
    pk: boxSizeList.code,
    create: (b) => ({ id: optId(b), code: reqStr(b, "code"), description: optStr(b, "description") }),
    update: (b) => ({
      ...(b.description !== undefined && { description: optStr(b, "description") }),
    }),
  })
);

adminRoute.route(
  "/customer-profiles",
  createCrudRouter({
    table: customerProfiles,
    pk: customerProfiles.code,
    create: (b) => ({
      id: optId(b),
      code: reqStr(b, "code"),
      label: reqStr(b, "label"),
      rule: optStr(b, "rule"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.label !== undefined && { label: reqStr(b, "label") }),
      ...(b.rule !== undefined && { rule: optStr(b, "rule") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      lastUpdateDate: new Date(),
    }),
  })
);

// Sub-inventories: custom router (3-level model — list aggregates tags,
// group create makes its default tag).
adminRoute.route("/sub-inventories", adminSubInventoriesRoute);

// Sub-inventory share groups (which stores may serve each other's demands).
adminRoute.route("/sub-inventory-share-groups", adminSubInventoryShareGroupsRoute);

adminRoute.route(
  "/net-weight-formulas",
  createCrudRouter({
    table: netWeightFormula,
    pk: netWeightFormula.id,
    orderBy: netWeightFormula.partNo,
    // Large master table — server-side paging/search/sort (?page=&q=&sort=&dir=).
    search: (q) => ilike(netWeightFormula.partNo, `%${q}%`),
    sorts: {
      partNo: netWeightFormula.partNo,
      qty: netWeightFormula.qty,
      weight: netWeightFormula.weight,
    },
    create: (b) => ({
      id: optId(b),
      partNo: reqStr(b, "partNo"),
      qty: reqInt(b, "qty"),
      weight: reqNum(b, "weight"),
    }),
    update: (b) => ({
      ...(b.partNo !== undefined && { partNo: reqStr(b, "partNo") }),
      ...(b.qty !== undefined && { qty: reqInt(b, "qty") }),
      ...(b.weight !== undefined && { weight: reqNum(b, "weight") }),
    }),
  })
);

// Users: custom router (write-only `password`, never returns password_hash).
adminRoute.route("/users", adminUsersRoute);

adminRoute.route(
  "/user-groups",
  createCrudRouter({
    table: userGroups,
    pk: userGroups.code,
    create: (b) => ({
      id: optId(b),
      code: reqStr(b, "code"),
      label: reqStr(b, "label"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.label !== undefined && { label: reqStr(b, "label") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      lastUpdateDate: new Date(),
    }),
  })
);

// Composite business key (UNIQUE) — rows are addressed as `:userId::groupCode` in the URL.
adminRoute.route(
  "/user-group-members",
  createCrudRouter({
    table: userGroupMembers,
    pk: userGroupMembers.userId,
    match: (id) => {
      const sep = id.indexOf(":");
      if (sep <= 0) throw new HTTPException(400, { message: "id must be userId:groupCode" });
      return and(eq(userGroupMembers.userId, id.slice(0, sep)), eq(userGroupMembers.groupCode, id.slice(sep + 1)))!;
    },
    create: (b) => ({
      id: optId(b),
      userId: reqStr(b, "userId"),
      groupCode: reqStr(b, "groupCode"),
    }),
    update: () => ({}),
  })
);

adminRoute.route("/shelf-boxes", shelfBoxesRoute);

// Flow-data edits for the admin console (delivery date / item date code).
adminRoute.route("/", adminFlowEditsRoute);

// Issues console (cross-order receiving mismatch list).
adminRoute.route("/", adminIssuesRoute);

// APK download (signed release APK published by `pnpm build:apk`).
adminRoute.route("/", adminAppDownloadRoute);
