import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  shelves,
  suppliers,
  supplierProfiles,
  parts,
  countryList,
  boxSizeList,
  subInventories,
  customerProfiles,
  netWeightFormula,
  users,
  warehouseSections,
} from "../../db/schema/index.js";
import { createCrudRouter, reqStr, optStr, reqInt, optInt, reqNum } from "./crud.js";
import { shelfBoxesRoute } from "./shelfBoxes.js";

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
      orgId: optInt(b, "orgId"),
      warehouseSectionCode: optStr(b, "warehouseSectionCode"),
      subInventoryCode: optStr(b, "subInventoryCode"),
      locationType: optStr(b, "locationType") ?? "shelf",
    }),
    update: (b) => ({
      ...(b.zone !== undefined && { zone: optStr(b, "zone") }),
      ...(b.orgId !== undefined && { orgId: optInt(b, "orgId") }),
      ...(b.warehouseSectionCode !== undefined && { warehouseSectionCode: optStr(b, "warehouseSectionCode") }),
      ...(b.subInventoryCode !== undefined && { subInventoryCode: optStr(b, "subInventoryCode") }),
      ...(b.locationType !== undefined && { locationType: optStr(b, "locationType") ?? "shelf" }),
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
      qtyEncoding: optStr(b, "qtyEncoding"),
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.supplierCode !== undefined && { supplierCode: reqStr(b, "supplierCode") }),
      ...(b.name !== undefined && { name: optStr(b, "name") }),
      ...(b.qrTemplate !== undefined && { qrTemplate: optStr(b, "qrTemplate") }),
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
      partNo: reqStr(b, "partNo"),
      wclItemNo: optStr(b, "wclItemNo"),
      internalCode: optStr(b, "internalCode"),
      description: optStr(b, "description"),
      defaultCoo: optStr(b, "defaultCoo"),
    }),
    update: (b) => ({
      ...(b.partNo !== undefined && { partNo: reqStr(b, "partNo") }),
      ...(b.wclItemNo !== undefined && { wclItemNo: optStr(b, "wclItemNo") }),
      ...(b.internalCode !== undefined && { internalCode: optStr(b, "internalCode") }),
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
  "/sub-inventories",
  createCrudRouter({
    table: subInventories,
    pk: subInventories.code,
    create: (b) => ({
      code: reqStr(b, "code"),
      name: reqStr(b, "name"),
      customerCode: optStr(b, "customerCode"),
    }),
    update: (b) => ({
      ...(b.name !== undefined && { name: reqStr(b, "name") }),
      ...(b.customerCode !== undefined && { customerCode: optStr(b, "customerCode") }),
    }),
  })
);

adminRoute.route(
  "/warehouse-sections",
  createCrudRouter({
    table: warehouseSections,
    pk: warehouseSections.code,
    create: (b) => ({
      code: reqStr(b, "code"),
      name: reqStr(b, "name"),
    }),
    update: (b) => ({
      ...(b.name !== undefined && { name: reqStr(b, "name") }),
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
      remark: optStr(b, "remark"),
    }),
    update: (b) => ({
      ...(b.label !== undefined && { label: reqStr(b, "label") }),
      ...(b.remark !== undefined && { remark: optStr(b, "remark") }),
      updatedAt: new Date(),
    }),
  })
);

adminRoute.route(
  "/net-weight-formulas",
  createCrudRouter({
    table: netWeightFormula,
    pk: netWeightFormula.id,
    create: (b) => ({
      id: optId(b),
      partId: reqStr(b, "partId"),
      qty: reqInt(b, "qty"),
      weight: reqNum(b, "weight"),
    }),
    update: (b) => ({
      ...(b.partId !== undefined && { partId: reqStr(b, "partId") }),
      ...(b.qty !== undefined && { qty: reqInt(b, "qty") }),
      ...(b.weight !== undefined && { weight: reqNum(b, "weight") }),
    }),
  })
);

adminRoute.route(
  "/users",
  createCrudRouter({
    table: users,
    pk: users.id,
    create: (b) => ({
      id: optId(b),
      username: reqStr(b, "username"),
      passwordHash: reqStr(b, "passwordHash"),
      displayName: reqStr(b, "displayName"),
      role: optStr(b, "role") ?? "operator",
    }),
    update: (b) => ({
      ...(b.username !== undefined && { username: reqStr(b, "username") }),
      ...(b.passwordHash !== undefined && { passwordHash: reqStr(b, "passwordHash") }),
      ...(b.displayName !== undefined && { displayName: reqStr(b, "displayName") }),
      ...(b.role !== undefined && { role: reqStr(b, "role") }),
    }),
  })
);

adminRoute.route("/shelf-boxes", shelfBoxesRoute);
