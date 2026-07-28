// One-off generator: docs/app-docs/user-menu/index.md -> printable HTML.
// Mirrors scripts/gen-admin-user-guide-html.mjs; images sized for phone (PDA) screenshots.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "docs/app-docs/user-menu/index.md";
const OUT = "docs/app-docs/user-menu/user-menu-zh-HK.html";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);
const html = [];
const listStack = []; // "ul" | "ol" per indent level

const closeListsTo = (indent) => {
  while (listStack.length > indent) html.push(`</${listStack.pop()}>`);
};

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (img) {
    closeListsTo(0);
    html.push(`<figure><img alt="${esc(img[1])}" src="${img[2]}"><figcaption>${esc(img[1])}</figcaption></figure>`);
    continue;
  }
  // markdown table: header row, separator row, body rows
  if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
    closeListsTo(0);
    const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const rows = [`<tr>${cells(line).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`];
    i += 2; // skip header + separator
    while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
      rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      i++;
    }
    i--; // loop increments once more
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

const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Warehouse PDA — 用戶指南</title>
<style>
@page { size: A4; margin: 16mm 14mm; }
body {
  font-family: "Segoe UI", "Microsoft JhengHei", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 10.5pt; line-height: 1.55; color: #1a1a1a; max-width: 180mm; margin: 0 auto;
}
h1 { font-size: 20pt; border-bottom: 2px solid #0d9488; padding-bottom: 6px; }
h2 { font-size: 15pt; color: #0d9488; margin-top: 1.4em; page-break-after: avoid; }
h3 { font-size: 12pt; margin-top: 1.2em; page-break-after: avoid; }
figure { margin: 0.8em 0 1.2em; text-align: center; page-break-inside: avoid; }
figure img { max-width: 88mm; max-height: 120mm; border: 1px solid #ccc; border-radius: 4px; }
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
${html.join("\n")}
</body></html>
`;
writeFileSync(OUT, page);
console.log(`wrote ${OUT} (${html.length} blocks)`);
