// One-shot: embed captured screenshots into the user-guide chapters.
// For each chapter md: parse the trailing "> 截圖清單" block (ordered
// "`file.png` — description" lines), replace the 【截圖：…】 placeholders
// top-to-bottom with ![description](shots/file.png), verify every file
// exists on disk, then drop the checklist block (archived into
// capture-runbook.md appendix by the caller step).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide";
const CHAPTERS = [
  ...["01-manual-receiving", "02-receiving-cn-scan", "03-put-away", "04-ad-hoc-put-away",
      "05-shelf-exchange", "06-picking", "07-labeling", "08-measuring", "09-verify",
      "10-goods-verify"].map((n) => `pda/${n}.md`),
  ...["01-receiving-orders", "02-receiving-cn-upload", "03-picking-orders", "04-vmi-upload",
      "05-cancel-records", "06-issues", "07-warehouse-setup", "08-stock-search"].map(
      (n) => `admin/${n}.md`),
];

let failed = false;
for (const rel of CHAPTERS) {
  const file = join(ROOT, rel);
  const dir = rel.split("/")[0];
  const text = readFileSync(file, "utf8");

  const marker = text.lastIndexOf("> 截圖清單");
  if (marker === -1) {
    if (!text.includes("【截圖")) { console.log(`SKIP (already embedded): ${rel}`); continue; }
    console.error(`NO CHECKLIST: ${rel}`); failed = true; continue;
  }
  const body = text.slice(0, marker);
  const block = text.slice(marker);

  const items = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^> \d+\.\s+`?([A-Za-z0-9._-]+\.png)`?\s+—\s+(.+)$/);
    if (m) items.push({ name: m[1], desc: m[2].trim() });
  }

  const placeholders = body.match(/【截圖：[^】]*】/g) ?? [];
  if (items.length !== placeholders.length) {
    console.error(`COUNT MISMATCH: ${rel} checklist=${items.length} placeholders=${placeholders.length}`);
    failed = true; continue;
  }
  for (const it of items) {
    if (!existsSync(join(ROOT, dir, "shots", it.name))) {
      console.error(`MISSING FILE: ${dir}/shots/${it.name} (${rel})`);
      failed = true;
    }
  }
  if (failed) continue;

  let i = 0;
  const replaced = body.replace(/【截圖：[^】]*】/g, () => {
    const it = items[i++];
    return `![${it.desc}](shots/${it.name})`;
  });

  // drop the checklist block plus the "---" separator line right before it
  const trimmed = replaced.replace(/\n---\s*$/, "").replace(/\s*$/, "\n");
  writeFileSync(file, trimmed);
  console.log(`OK ${rel}: ${items.length} shots embedded`);
}
process.exit(failed ? 1 : 0);
