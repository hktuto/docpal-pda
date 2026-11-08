// ---------------------------------------------------------------------------
// Dev Lab page (GET /dev/lab): single self-contained HTML for generating
// supplier-label barcodes for developer testing — pick supplier + part, tweak
// qty / date / lot / coo / serial, get a scannable barcode in the supplier's
// own symbology plus the raw text and what the real decoder reads back.
// Plain JS (no build step); bwip-js rendering happens server-side via
// POST /dev/lab/barcode. Shared CSS/JS core: src/lab/pageCommon.ts.
// ---------------------------------------------------------------------------

import { LAB_BODY_TAIL, LAB_CSS, LAB_HEAD, LAB_SCRIPT_CORE } from "./pageCommon.js";

export const LAB_PAGE = [
  LAB_HEAD,
  "<title>Dev Lab — supplier label generator</title>",
  LAB_CSS,
  "<h1>Dev Lab — supplier label QR generator</h1>",
  "<p id=loaderr></p>",
  "<div id=main hidden>",
  "<div class=row><div><label>Brand</label><select id=brand></select></div>",
  "<div><label>Part (from parts master)</label><select id=part></select></div></div>",
  LAB_BODY_TAIL,
  "<script>",
  "(function(){",
  "var $=function(id){return document.getElementById(id)};",
  LAB_SCRIPT_CORE,
  "var suppliers=[],allBrands=[],parts=[];",
  "window.LAB_SET_SUPPLIER=function(s){sup=s;renderFields();renderHint()};",
  "function loadParts(){",
  " $('part').textContent='';",
  " fetch('/dev/lab/parts?brand='+encodeURIComponent($('brand').value)).then(function(r){return r.json()}).then(function(list){",
  "  parts=list;var o=document.createElement('option');o.value='';o.textContent='\\u2014 custom part no \\u2014';$('part').appendChild(o);",
  "  list.forEach(function(p,i){var op=document.createElement('option');op.value=String(i);",
  "   op.textContent=p.partNo+' \\u00b7 '+(p.wclItemNo||'')+(p.drawnos&&p.drawnos.length?' \\u00b7 drawno '+p.drawnos.join('/'):'')+(p.description?' \\u00b7 '+p.description.slice(0,40):'');",
  "   $('part').appendChild(op)});",
  " }).catch(function(e){$('hint').textContent='parts load failed: '+e.message})",
  "}",
  "$('part').onchange=function(){",
  " var p=parts[Number(this.value)];if(!p||!ctrls.partNo)return;",
  " ctrls.partNo.value=sup.supplierCode==='23'&&p.drawnos&&p.drawnos.length?p.drawnos[0]:(p.partNo||'');",
  " if(ctrls.wclItemNo)ctrls.wclItemNo.value=p.wclItemNo||'';",
  "}",
  "$('brand').onchange=function(){window.LAB_SET_SUPPLIER(supFor(this.value));loadParts()};",
  "fetch('/dev/lab/data').then(function(r){return r.json()}).then(function(d){",
  " suppliers=d.suppliers;allBrands=d.brands||[];",
  " var mb={};suppliers.forEach(function(s){if(s.fields)(s.brands||[]).forEach(function(b){mb[b]=1})});",
  " var m={};allBrands.forEach(function(b){m[b]=1});Object.keys(mb).forEach(function(b){m[b]=1});",
  " Object.keys(m).sort().forEach(function(b){var o=document.createElement('option');o.value=b;",
  "  o.textContent=mb[b]?b:b+' \\u25cb';$('brand').appendChild(o)});",
  " var b0=Object.keys(m).sort().filter(function(b){return mb[b]})[0];",
  " if(b0){$('brand').value=b0;$('brand').onchange()}else{renderFields();renderHint()}$('main').hidden=false;",
  "}).catch(function(e){$('loaderr').textContent='dev lab data failed to load: '+e.message});",
  "})();",
  "</script></body></html>",
].join("\n");
