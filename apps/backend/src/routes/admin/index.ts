import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { createCrudRouter, reqStr, optStr, reqInt, reqNum } from "./crud.js";
import { shelfBoxesRoute } from "./shelfBoxes.js";
import { adminUsersRoute } from "./users.js";
import { adminFlowEditsRoute } from "./flowEdits.js";
import { adminSubInventoriesRoute } from "./subInventories.js";

// Optional id on create: use the client's when given, else generate one.
function optId(body: Record<string, unknown>): string {
  const v = body.id;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : randomUUID();
}

export const adminRoute = new Hono();

adminRoute.route(
  "/shelves",
  createCrudRouter({
    table: shelves,
    pk: shelves.code,
    create: (b) => ({
      code: reqStr(b, "code"),
      zone: optStr(b, "zone"),
    }),
    update: (b) => ({
      ...(b.zone !== undefined && { zone: optStr(b, "zone") }),
      updatedAt: new Date(),
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
      qrType: optStr(b, "qrType"),
      qtyEncoding: optStr(b, "qtyEncoding"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.supplierCode !== undefined && { supplierCode: reqStr(b, "supplierCode") }),
      ...(b.name !== undefined && { name: optStr(b, "name") }),
      ...(b.qrTemplate !== undefined && { qrTemplate: optStr(b, "qrTemplate") }),
      ...(b.qrType !== undefined && { qrType: optStr(b, "qrType") }),
      ...(b.qtyEncoding !== undefined && { qtyEncoding: optStr(b, "qtyEncoding") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      updatedAt: new Date(),
    }),
  })
);

adminRoute.route(
  "/parts",
  createCrudRouter({
    table: parts,
    pk: parts.id,
    create: (b) => ({
      id: optId(b),
      supplierCode: reqStr(b, "supplierCode"),
      partNo: reqStr(b, "partNo"),
      wclItemNo: optStr(b, "wclItemNo"),
      description: optStr(b, "description"),
      defaultCoo: optStr(b, "defaultCoo"),
    }),
    update: (b) => ({
      ...(b.supplierCode !== undefined && { supplierCode: reqStr(b, "supplierCode") }),
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
    create: (b) => ({ code: reqStr(b, "code"), name: reqStr(b, "name") }),
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
    create: (b) => ({ code: reqStr(b, "code"), description: optStr(b, "description") }),
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
      code: reqStr(b, "code"),
      label: reqStr(b, "label"),
      rule: optStr(b, "rule"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.label !== undefined && { label: reqStr(b, "label") }),
      ...(b.rule !== undefined && { rule: optStr(b, "rule") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      updatedAt: new Date(),
    }),
  })
);

// Sub-inventories: custom router (3-level model — list aggregates tags,
// group create makes its default tag).
adminRoute.route("/sub-inventories", adminSubInventoriesRoute);

adminRoute.route(
  "/net-weight-formulas",
  createCrudRouter({
    table: netWeightFormula,
    pk: netWeightFormula.id,
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
      code: reqStr(b, "code"),
      label: reqStr(b, "label"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.label !== undefined && { label: reqStr(b, "label") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      updatedAt: new Date(),
    }),
  })
);

// Composite PK — rows are addressed as `:userId::groupCode` in the URL.
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
      userId: reqStr(b, "userId"),
      groupCode: reqStr(b, "groupCode"),
    }),
    update: () => ({}),
  })
);

adminRoute.route("/shelf-boxes", shelfBoxesRoute);

// Flow-data edits for the admin console (delivery date / item date code).
adminRoute.route("/", adminFlowEditsRoute);
