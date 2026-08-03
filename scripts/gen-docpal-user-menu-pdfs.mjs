// One-off generator: docs/docpal-user-menu-zh/{client,admin}/*.md -> printable HTML + PDF.
// One PDF per site (client / admin). Parser mirrors scripts/gen-user-menu-guide-html.mjs,
// adapted: YAML frontmatter stripped, ../assets/ rewritten for the output location,
// desktop-sized screenshots, each page's h1 starts a new PDF page.
// Run from the repo root: node scripts/gen-docpal-user-menu-pdfs.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = "docs/docpal-user-menu-zh";
const jobs = [
  { dir: "client", title: "DocPal 用戶選單導覽 — 客戶端網站（Client Site）", out: "client-user-menu-zh-HK" },
  { dir: "admin", title: "DocPal 用戶選單導覽 — 管理網站（Admin Site）", out: "admin-user-menu-zh-HK" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // wikilink with alias -> alias text
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

function mdToHtml(src) {
  // strip YAML frontmatter
  const text = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = text.split(/\r?\n/);
  const html = [];
  const listStack = [];
  const closeListsTo = (indent) => {
    while (listStack.length > indent) html.push(`</${listStack.pop()}>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      closeListsTo(0);
      const srcAttr = img[2].replace(/^\.\.\/assets\//, "assets/");
      html.push(`<figure><img alt="${esc(img[1])}" src="${srcAttr}"><figcaption>${esc(img[1])}</figcaption></figure>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeListsTo(0);
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const rows = [`<tr>${cells(line).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`];
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
        i++;
      }
      i--;
      html.push(`<table>\n${rows.join("\n")}\n</table>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = Math.floor(li[1].length / 2) + 1;
      const tag = /^\d+\.$/.test(li[2]) ? "ol" : "ul";
      if (listStack.length < indent) {
        while (listStack.length < indent) {
          html.push(`<${tag}>`);
          listStack.push(tag);
        }
      } else {
        closeListsTo(indent);
        if (listStack[listStack.length - 1] !== tag) {
          html.push(`</${listStack.pop()}><${tag}>`);
          listStack.push(tag);
        }
      }
      html.push(`<li>${inline(li[3])}</li>`);
      continue;
    }
    closeListsTo(0);
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      html.push(`<h${level}>${inline(line.replace(/^#+\s+/, ""))}</h${level}>`);
    } else if (/^---+\s*$/.test(line)) {
      html.push("<hr>");
    } else if (line.trim() === "") {
      // skip blank
    } else {
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeListsTo(0);
  return html.join("\n");
}

const page = (title, body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4; margin: 16mm 14mm; }
body {
  font-family: "Segoe UI", "Microsoft JhengHei", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 10.5pt; line-height: 1.55; color: #1a1a1a; max-width: 180mm; margin: 0 auto;
}
h1.doc-title { font-size: 20pt; border-bottom: 2px solid #0d9488; padding-bottom: 6px; }
h1:not(.doc-title) { font-size: 17pt; color: #0d9488; page-break-before: always; page-break-after: avoid; }
h2 { font-size: 14pt; color: #0d9488; margin-top: 1.3em; page-break-after: avoid; }
h3 { font-size: 12pt; margin-top: 1.2em; page-break-after: avoid; }
figure { margin: 0.8em 0 1.2em; text-align: center; page-break-inside: avoid; }
figure img { max-width: 165mm; max-height: 105mm; border: 1px solid #ccc; border-radius: 4px; }
figcaption { font-size: 9pt; color: #666; margin-top: 4px; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; font-size: 10pt; }
th { background: #f0fdfa; }
code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; }
a { color: #0d9488; text-decoration: none; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.6em 0; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.3em 0; }
</style></head><body>
${body}
</body></html>
`;

const require = createRequire(path.resolve("apps/web/package.json"));
const { chromium } = require("playwright");
const browser = await chromium.launch();

for (const { dir, title, out } of jobs) {
  const dirPath = path.join(ROOT, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".md")).sort();
  const body = [`<h1 class="doc-title">${esc(title)}</h1>`];
  for (const f of files) {
    body.push(mdToHtml(readFileSync(path.join(dirPath, f), "utf8")));
  }
  const htmlPath = path.join(ROOT, `${out}.html`);
  writeFileSync(htmlPath, page(title, body.join("\n")));
  console.log(`wrote ${htmlPath} (${files.length} pages)`);

  const pdfPath = path.join(ROOT, `${out}.pdf`);
  const pg = await browser.newPage();
  await pg.goto("file:///" + path.resolve(htmlPath).replace(/\\/g, "/"), { waitUntil: "networkidle" });
  await pg.pdf({ path: pdfPath, format: "A4", printBackground: true });
  console.log(`wrote ${pdfPath}`);
  await pg.close();
}
await browser.close();
