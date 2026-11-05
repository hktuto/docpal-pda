#!/usr/bin/env node
// Build the UAT tracking workbook from editable JSON sources.
// Sources of truth: docs/uat/{functions,bugs,features}.json  (edit these, or ask the agent to)
// Output:           docs/uat/UAT-Test-Tracking.xlsx          (generated — do not hand-edit; regenerate instead)
// Usage:            node scripts/gen-uat-xlsx.mjs
// Formulas (bug/feature counts per function) and dropdown validations are recreated on every run.

import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs", "uat");
const load = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const functions = load("functions.json");
const bugs = load("bugs.json");
const features = load("features.json");

// sanity: every bug/feature must reference a real function id (blank allowed)
const fnIds = new Set(functions.map((f) => f.id));
for (const [list, kind] of [[bugs, 'bugs.json'], [features, 'features.json']]) {
  for (const row of list) {
    if (row.functionId && !fnIds.has(row.functionId)) {
      throw new Error(`${kind}: ${row.id} references unknown function ${row.functionId}`);
    }
  }
}

const dateOf = (s) => (s ? new Date(`${s}T00:00:00`) : null);
const hdr = (row) => {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
};

const wb = new ExcelJS.Workbook();
wb.creator = 'UAT';

// ---------- Functions ----------
const fs1 = wb.addWorksheet('Functions', { views: [{ state: 'frozen', ySplit: 1 }] });
fs1.columns = [
  { header: 'App', width: 8 },
  { header: 'Module', width: 16 },
  { header: 'Function ID', width: 11 },
  { header: 'Function (one line)', width: 70 },
  { header: 'Tester', width: 10 },
  { header: 'Test date', width: 11 },
  { header: 'Result', width: 12 },
  { header: 'Bugs found', width: 10 },
  { header: 'Open bugs', width: 10 },
  { header: 'New features', width: 10 },
  { header: 'Features done', width: 10 },
  { header: 'Bug IDs', width: 18 },
  { header: 'Remarks', width: 24 },
];
hdr(fs1.getRow(1));
for (const f of functions) {
  const r = fs1.addRow([f.app, f.module, f.id, f.name, f.tester || '', dateOf(f.testDate), f.result || '', '', '', '', '', f.bugIds || '', f.remarks || '']);
  const n = r.number;
  r.getCell(6).numFmt = 'dd/mm/yyyy';
  r.getCell(8).value = { formula: `COUNTIF('Bug Log'!$C:$C,$C${n})` };
  r.getCell(9).value = {
    formula: `COUNTIFS('Bug Log'!$C:$C,$C${n},'Bug Log'!$H:$H,"Open")+COUNTIFS('Bug Log'!$C:$C,$C${n},'Bug Log'!$H:$H,"Fixing")+COUNTIFS('Bug Log'!$C:$C,$C${n},'Bug Log'!$H:$H,"Ready for retest")`,
  };
  r.getCell(10).value = { formula: `COUNTIF('Additional Features'!$E:$E,$C${n})` };
  r.getCell(11).value = { formula: `COUNTIFS('Additional Features'!$E:$E,$C${n},'Additional Features'!$I:$I,"Delivered")` };
}
const lastFn = fs1.rowCount;
fs1.autoFilter = { from: 'A1', to: 'M1' };
fs1.dataValidations.add(`G2:G${lastFn + 50}`, {
  type: 'list', allowBlank: true,
  formulae: ['"Not tested,Pass,Pass with notes,Fail,Blocked,N/A"'],
});

// ---------- Bug Log ----------
const bs = wb.addWorksheet('Bug Log', { views: [{ state: 'frozen', ySplit: 1 }] });
bs.columns = [
  { header: 'Bug ID', width: 10 },
  { header: 'Date found', width: 11 },
  { header: 'Function ID', width: 11 },
  { header: 'Function (auto)', width: 50 },
  { header: 'Issue description', width: 50 },
  { header: 'Repro steps', width: 40 },
  { header: 'Severity', width: 11 },
  { header: 'Status', width: 14 },
  { header: 'Retest result', width: 12 },
  { header: 'Owner / dev', width: 12 },
  { header: 'Closed date', width: 11 },
  { header: 'Tester', width: 10 },
  { header: 'Remarks', width: 24 },
];
hdr(bs.getRow(1));
for (const b of bugs) {
  bs.addRow([b.id, dateOf(b.dateFound), b.functionId, null, b.description, b.reproSteps || '', b.severity, b.status, b.retestResult || '', b.owner || '', dateOf(b.closedDate), b.tester || '', b.remarks || '']);
}
bs.autoFilter = { from: 'A1', to: 'M1' };
for (let r = 2; r <= 200; r++) {
  bs.getCell(`B${r}`).numFmt = 'dd/mm/yyyy';
  bs.getCell(`K${r}`).numFmt = 'dd/mm/yyyy';
  bs.getCell(`D${r}`).value = { formula: `IFERROR(VLOOKUP($C${r},Functions!$C:$D,2,FALSE),"")` };
}
bs.dataValidations.add('C2:C200', { type: 'list', allowBlank: true, formulae: [`Functions!$C$2:$C$${lastFn}`] });
bs.dataValidations.add('G2:G200', { type: 'list', allowBlank: true, formulae: ['"Critical,Major,Minor,Cosmetic"'] });
bs.dataValidations.add('H2:H200', { type: 'list', allowBlank: true, formulae: ['"Open,Fixing,Ready for retest,Closed,Won\'t fix"'] });
bs.dataValidations.add('I2:I200', { type: 'list', allowBlank: true, formulae: ['"Passed,Failed"'] });

// ---------- Additional Features ----------
const af = wb.addWorksheet('Additional Features', { views: [{ state: 'frozen', ySplit: 1 }] });
af.columns = [
  { header: 'Req ID', width: 9 },
  { header: 'Date raised', width: 11 },
  { header: 'Raised by', width: 11 },
  { header: 'App', width: 8 },
  { header: 'Related function ID', width: 13 },
  { header: 'New feature requested', width: 50 },
  { header: 'Reason / business need', width: 40 },
  { header: 'Priority', width: 11 },
  { header: 'Status', width: 14 },
  { header: 'Owner / dev', width: 12 },
  { header: 'Target date', width: 11 },
  { header: 'Remarks', width: 24 },
];
hdr(af.getRow(1));
for (const c of features) {
  af.addRow([c.id, dateOf(c.dateRaised), c.raisedBy || '', c.app, c.functionId || '', c.feature, c.reason || '', c.priority || '', c.status, c.owner || '', dateOf(c.targetDate), c.remarks || '']);
}
af.autoFilter = { from: 'A1', to: 'L1' };
for (let r = 2; r <= 100; r++) {
  af.getCell(`B${r}`).numFmt = 'dd/mm/yyyy';
  af.getCell(`K${r}`).numFmt = 'dd/mm/yyyy';
}
af.dataValidations.add('D2:D100', { type: 'list', allowBlank: true, formulae: ['"Admin,PDA,Both,Backend"'] });
af.dataValidations.add('E2:E100', { type: 'list', allowBlank: true, formulae: [`Functions!$C$2:$C$${lastFn}`] });
af.dataValidations.add('H2:H100', { type: 'list', allowBlank: true, formulae: ['"Must have,Should have,Could have"'] });
af.dataValidations.add('I2:I100', { type: 'list', allowBlank: true, formulae: ['"New,Agreed,In progress,Delivered,Rejected"'] });

const out = path.join(dir, 'UAT-Test-Tracking.xlsx');
await wb.xlsx.writeFile(out);
console.log(`wrote ${out} — ${functions.length} functions, ${bugs.length} bugs, ${features.length} features`);
