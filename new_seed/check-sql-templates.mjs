// Consistency check: qr_template strings in scripts/sql/restore-supplier-profiles-whhk.sql
// must equal the verified TEMPLATES in new_seed/test-qr-templates.mjs.
// Run: node new_seed/check-sql-templates.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "../scripts/sql/restore-supplier-profiles-whhk.sql"), "utf8");
const harness = readFileSync(join(here, "test-qr-templates.mjs"), "utf8");

const sqlBlocks = [...sql.matchAll(/'00000000-0000-7000-8000-00000000900\d', '([A-Z]+)', NULL,\s*\$re\$([\s\S]*?)\$re\$/g)];
const jsBlocks = [...harness.matchAll(/^ {2}([A-Z]+): \{[\s\S]*?template:\s*"((?:[^"\\]|\\.)*)"/gm)];

let bad = 0;
console.log("SQL templates:", sqlBlocks.map((b) => b[1]).join(", "));
for (const [, code, sqlT] of sqlBlocks) {
  const h = jsBlocks.find((b) => b[1] === code);
  if (!h) { console.log(`${code}: MISSING in harness`); bad++; continue; }
  const jsT = JSON.parse(`"${h[2]}"`); // unescape the JS string literal body
  if (jsT !== sqlT) {
    console.log(`${code}: MISMATCH\n  sql: ${JSON.stringify(sqlT)}\n  js : ${JSON.stringify(jsT)}`);
    bad++;
    continue;
  }
  try {
    new RegExp(sqlT, "u");
    console.log(`${code}: match + compiles`);
  } catch (e) {
    console.log(`${code}: REGEX COMPILE FAIL: ${e.message}`);
    bad++;
  }
}
console.log(bad === 0 ? "SQL templates consistent with harness" : `${bad} problems`);
process.exit(bad === 0 ? 0 : 1);
