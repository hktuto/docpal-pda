// Verify the TS seed templates in apps/backend/src/db/seed-supplier-profiles.ts
// are byte-identical to the verified SQL templates in
// scripts/sql/restore-supplier-profiles-whhk.sql, and compile with the "u" flag.
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../scripts/sql/restore-supplier-profiles-whhk.sql", import.meta.url), "utf8");
const sqlTemplates = [...sql.matchAll(/\$re\$([\s\S]*?)\$re\$/g)].map((m) => m[1]);

const ts = readFileSync(new URL("../apps/backend/src/db/seed-supplier-profiles.ts", import.meta.url), "utf8");
const tsTemplates = [...ts.matchAll(/String\.raw`([\s\S]*?)`/g)].map((m) => m[1]);

console.log(`sql templates: ${sqlTemplates.length}, ts templates: ${tsTemplates.length}`);
const sqlSet = new Set(sqlTemplates);
let ok = sqlTemplates.length === 7 && tsTemplates.length === 6;
for (const t of tsTemplates) {
  if (!sqlSet.has(t)) {
    ok = false;
    console.log("MISMATCH:", t.slice(0, 70));
  }
  new RegExp(t, "u"); // must compile
}
console.log(ok ? "ALL TS TEMPLATES MATCH SQL + COMPILE" : "MISMATCH FOUND");
process.exit(ok ? 0 : 1);
