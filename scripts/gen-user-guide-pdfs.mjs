// One-off: regenerate the printable user-guide PDFs from the generated HTML files.
// Run from the repo root: node scripts/gen-user-guide-pdfs.mjs
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.resolve("apps/web/package.json"));
const { chromium } = require("playwright");

const jobs = [
  ["docs/app-docs/user-menu/user-menu-zh-HK.html", "docs/app-docs/user-menu/user-menu-zh-HK.pdf"],
  ["docs/app-docs/admin-user-menu/admin-user-menu-zh-HK.html", "docs/app-docs/admin-user-menu/admin-user-menu-zh-HK.pdf"],
];

const browser = await chromium.launch();
for (const [src, out] of jobs) {
  const page = await browser.newPage();
  await page.goto("file:///" + path.resolve(src).replace(/\\/g, "/"), { waitUntil: "networkidle" });
  await page.pdf({ path: out, format: "A4", printBackground: true });
  console.log("wrote", out);
  await page.close();
}
await browser.close();
