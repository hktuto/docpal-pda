import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { and, asc, desc, eq, count as countFn, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTableWithColumns } from "drizzle-orm/pg-core";
import { db } from "../../db.js";

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code ?? err?.cause?.code;
}

/** Map Postgres driver errors to HTTP responses. */
export function mapDbError(e: unknown): never {
  const code = pgCode(e);
  if (code === "23503") throw new HTTPException(409, { message: "in use or invalid reference" });
  if (code === "23505") throw new HTTPException(409, { message: "duplicate" });
  if (code === "23502") throw new HTTPException(400, { message: "missing required field" });
  throw e;
}

// ---- field helpers for per-entity validators (throw HTTPException(400)) ----

export function reqStr(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new HTTPException(400, { message: `${field} is required` });
  }
  return v.trim();
}

export function optStr(body: Record<string, unknown>, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HTTPException(400, { message: `${field} must be a string` });
  return v.trim() === "" ? null : v.trim();
}

export function reqInt(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new HTTPException(400, { message: `${field} must be an integer` });
  }
  return v;
}

export function optInt(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new HTTPException(400, { message: `${field} must be an integer` });
  }
  return v;
}

export function optStrArray(body: Record<string, unknown>, field: string): string[] | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw new HTTPException(400, { message: `${field} must be an array of strings` });
  }
  const trimmed = (v as string[]).map((s) => s.trim()).filter((s) => s !== "");
  return trimmed.length > 0 ? trimmed : null;
}

export function reqNum(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HTTPException(400, { message: `${field} must be a number` });
  }
  return v;
}

export function optJson(body: Record<string, unknown>, field: string): unknown | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") throw new HTTPException(400, { message: `${field} must be an object` });
  return v;
}

export interface CrudConfig<T extends PgTableWithColumns<any>> {
  table: T;
  /** Text primary-key column used in /:id lookups and list ordering. */
  pk: AnyPgColumn;
  /** WHERE clause for /:id lookups; defaults to eq(pk, id). Needed for
   *  composite-PK tables (e.g. user_group_members addressed as userId:groupCode). */
  match?: (id: string) => SQL;
  /** Optional search predicate for server-side list paging. When set and the
   *  list request carries ?page=/?pageSize=/?q=, GET / returns
   *  { rows, total } (LIMIT/OFFSET + COUNT) instead of the full array. */
  search?: (q: string) => SQL;
  /** Extra AND predicates keyed by query-param name (server-paging branch only).
   *  Each non-empty ?<name>= value applies filters[name](value). */
  filters?: Record<string, (value: string) => SQL>;
  /** Whitelisted sortable columns keyed by sort name (server-paging branch only).
   *  ?sort=<name>&dir=asc|desc (default dir asc; unknown name falls back to orderBy). */
  sorts?: Record<string, AnyPgColumn>;
  /** List ordering column; defaults to pk. */
  orderBy?: AnyPgColumn;
  /** Build the insert row from a validated body (throw HTTPException(400) on bad input). */
  create: (body: Record<string, unknown>) => T["$inferInsert"];
  /** Build the update set from a validated body; only provided fields are updated. */
  update: (body: Record<string, unknown>) => Partial<T["$inferInsert"]>;
}

/** Generic master-data CRUD router: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id. */
export function createCrudRouter<T extends PgTableWithColumns<any>>(cfg: CrudConfig<T>): Hono {
  // Loosen the table type internally: drizzle's data-modifying statement
  // generics don't resolve across a generic boundary. The public config above
  // keeps create/update fully type-checked at each call site.
  const table = cfg.table as PgTableWithColumns<any>;
  const match = cfg.match ?? ((id: string) => eq(cfg.pk, id));
  const orderBy = cfg.orderBy ?? cfg.pk;
  const r = new Hono();

  r.get("/", async (c) => {
    // Server-side paging/search (opt-in per entity via cfg.search) for large
    // tables like the ~100k-row parts master.
    if (cfg.search && (c.req.query("page") !== undefined || c.req.query("q") !== undefined)) {
      const page = Math.max(1, Number(c.req.query("page")) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize")) || 50));
      const q = (c.req.query("q") ?? "").trim();
      const predicates: SQL[] = [];
      if (q) predicates.push(cfg.search(q));
      for (const [name, build] of Object.entries(cfg.filters ?? {})) {
        const v = (c.req.query(name) ?? "").trim();
        if (v) predicates.push(build(v));
      }
      const where = predicates.length === 0 ? undefined : and(...predicates);
      const sortName = c.req.query("sort");
      const sortCol = sortName ? cfg.sorts?.[sortName] : undefined;
      const sortExpr = sortCol
        ? c.req.query("dir") === "desc"
          ? desc(sortCol)
          : asc(sortCol)
        : orderBy;
      const [rows, count] = await Promise.all([
        db
          .select()
          .from(table)
          .where(where)
          .orderBy(sortExpr)
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db.select({ total: countFn() }).from(table).where(where),
      ]);
      return c.json({ rows, total: Number(count[0]?.total ?? 0) });
    }
    const rows = await db.select().from(table).orderBy(orderBy);
    return c.json(rows);
  });

  r.get("/:id", async (c) => {
    const rows = await db.select().from(table).where(match(c.req.param("id")));
    if (rows.length === 0) throw new HTTPException(404, { message: "not found" });
    return c.json(rows[0]);
  });

  r.post("/", async (c) => {
    const body = await readJson(c);
    const row = cfg.create(body);
    try {
      const inserted = await db.insert(table).values(row as never).returning();
      return c.json(inserted[0], 201);
    } catch (e) {
      mapDbError(e);
    }
  });

  r.patch("/:id", async (c) => {
    const body = await readJson(c);
    const set = cfg.update(body);
    if (Object.keys(set).length === 0) {
      throw new HTTPException(400, { message: "no fields to update" });
    }
    try {
      const updated = await db
        .update(table)
        .set(set as never)
        .where(match(c.req.param("id")))
        .returning();
      if (updated.length === 0) throw new HTTPException(404, { message: "not found" });
      return c.json(updated[0]);
    } catch (e) {
      mapDbError(e);
    }
  });

  r.delete("/:id", async (c) => {
    try {
      const deleted = await db
        .delete(table)
        .where(match(c.req.param("id")))
        .returning({ id: cfg.pk });
      if (deleted.length === 0) throw new HTTPException(404, { message: "not found" });
      return c.json({ ok: true });
    } catch (e) {
      mapDbError(e);
    }
  });

  return r;
}
