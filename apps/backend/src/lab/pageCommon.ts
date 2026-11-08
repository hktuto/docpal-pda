// ---------------------------------------------------------------------------
// Shared page core for the Dev Lab HTML pages (GET /dev/lab,
// /dev/lab/receiving-cn, /dev/lab/picking): CSS + the field/build/render JS
// every page uses. Plain JS (no build step), string concat — no template
// literals (the page strings go through c.html verbatim). Values are injected
// with textContent, never innerHTML.
// Pages supply the <body> selector markup + a mode-specific boot script that
// wires window.LAB_SET_SUPPLIER (auto-picked supplier per part/item) and
// window.LAB_PREFILL (fill the editable fields from the picked part/item).
// ---------------------------------------------------------------------------

export const LAB_HEAD = [
  "<!doctype html><html><head><meta charset=utf-8>",
  "<meta name=viewport content='width=device-width,initial-scale=1'>",
].join("\n");

export const LAB_CSS = [
  "<style>",
  "body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#222;background:#fafafa}",
  "h1{font-size:20px}h2{font-size:16px;margin-top:32px}",
  "select,input,textarea,button{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;background:#fff;box-sizing:border-box;width:100%}",
  "button{cursor:pointer;background:#2563eb;color:#fff;border-color:#2563eb;width:auto}button:disabled{opacity:.5}",
  "label{display:block;margin:10px 0 4px;font-weight:600}",
  ".row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1 1 220px}",
  "#fields input{width:100%}",
  "#hint{color:#666;font-size:12px;margin:4px 0}",
  "#barcode,#rawImg{display:block;max-width:100%;image-rendering:pixelated;border:1px solid #ddd;background:#fff;padding:8px;margin:12px 0;border-radius:6px}",
  "textarea{width:100%;font-family:ui-monospace,monospace;font-size:12px}",
  "pre{background:#fff;border:1px solid #ddd;padding:10px;border-radius:6px;overflow:auto}",
  ".err{color:#b91c1c;white-space:pre-wrap}",
  "</style></head><body>",
].join("\n");

// Builder section + output section + raw-text section. Reusable because every
// page builds labels the same way; only the part/item selector above differs.
// The bcid <select> uses width:auto (the global select width:100% is for the
// picker rows).
export const LAB_BODY_TAIL = [
  "<div id=hint></div>",
  "<div id=fields class=row></div>",
  "<p><button id=gen>Build &amp; render barcode</button></p>",
  "<div id=out hidden>",
  "<label>Symbology (match the supplier's barcode_types so the PDA hardware scanner accepts it)</label>",
  "<select id=bcid style='width:auto'>",
  "<option value=auto>auto (supplier qr_type)</option><option value=qrcode>QR code</option>",
  "<option value=datamatrix>Data Matrix</option><option value=pdf417>PDF417</option>",
  "<option value=interleaved2of5>ITF (2of5 interleaved)</option></select>",
  "<img id=barcode alt=''>",
  "<label>Raw label text (click to select, then copy — paste works with the keyboard-wedge fallback too)</label>",
  "<textarea id=raw rows=3 readonly></textarea>",
  "<label>Decoded back by the real backend parser (POST /scan/decode sees this)</label>",
  "<pre id=decoded></pre></div></div>",
  "<h2>Raw-text barcode (any string, e.g. templates without a builder)</h2>",
  "<textarea id=rawIn rows=3 placeholder='paste raw label text'></textarea>",
  "<p><button id=render>Render</button> ",
  "<select id=bcid2 style='width:auto'><option value=qrcode>QR code</option><option value=datamatrix>Data Matrix</option>",
  "<option value=pdf417>PDF417</option><option value=interleaved2of5>ITF (2of5 interleaved)</option></select></p>",
  "<p id=rawerr class=err></p><img id=rawImg alt=''>",
].join("\n");

// Field metadata + supplier/symbology helpers + the Build click handler.
// Expects the page boot script to define: `suppliers` (from /dev/lab/data),
// `sup` (current supplier), and to call renderFields()/renderHint() whenever
// `sup` changes. Build randomizes the serial field on every click so repeat
// clicks with unchanged settings still produce a fresh label.
export const LAB_SCRIPT_CORE = [
  "var META={partNo:['Part no (MPN)','text'],wclItemNo:['WCL item no','text'],qty:['Qty','number'],",
  "date:['Date (encoded to the label\\u2019s own date-code format)','date'],lotCode:['Lot code','text'],",
  "coo:['COO','text'],serialNo:['Serial no (randomized on every Build)','text']};",
  "var SYM={pdf417:'pdf417',datamatrix:'datamatrix',itf:'interleaved2of5',qr:'qrcode'};",
  "var sup=null,ctrls={};",
  "function today(){var d=new Date();return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}",
  "function randomSerial(){var r=Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'');",
  " return ('LAB'+Date.now().toString(36).toUpperCase()+r+'XXXX').slice(0,12)}",
  "function postJSON(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})",
  ".then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})})}",
  "function supFor(b){var hit=null;for(var i=0;i<suppliers.length;i++){var s=suppliers[i];if(s.brands&&s.brands.indexOf(b)>=0){if(s.fields)return s;if(!hit)hit=s}}return hit}",
  "function renderHint(){$('hint').textContent=sup?((sup.supplierName||'')+' \\u00b7 '+sup.supplierCode)+(sup.barcodeTypes&&sup.barcodeTypes.length?' \\u00b7 scanner whitelist: '+sup.barcodeTypes.join('/'):'')+' \\u00b7 qr_type: '+(sup.qrType||'(none)'):''}",
  "function renderFields(){",
  " $('fields').textContent='';ctrls={};",
  " var fl=(sup&&sup.fields)||[];",
  " if(!fl.length){var d=document.createElement('div');d.textContent='No label builder for this brand \\u2014 use raw-text mode below.';$('fields').appendChild(d);return}",
  " fl.forEach(function(f){",
  "  var div=document.createElement('div');var lab=document.createElement('label');",
  "  lab.textContent=f==='partNo'&&sup.supplierCode==='23'?'Drawing no (6 or 10 digits)':META[f][0];",
  "  var inp=document.createElement('input');inp.type=META[f][1];",
  "  if(f==='qty')inp.value='1000';if(f==='date')inp.value=today();",
  "  lab.htmlFor=inp.id='f_'+f;div.appendChild(lab);div.appendChild(inp);$('fields').appendChild(div);ctrls[f]=inp});",
  "}",
  "function collect(){",
  " var body={supplierCode:sup.supplierCode};",
  " for(var f in ctrls){var v=ctrls[f].value.trim();if(!v)continue;body[f]=f==='qty'?Number(v):v}",
  " return body}",
  "function renderBarcode(bcid,text,img){",
  " postJSON('/dev/lab/barcode',{bcid:bcid,text:text}).then(function(j){",
  "  img.src='data:image/png;base64,'+j.image}).catch(function(e){$('decoded').textContent='barcode render failed: '+e.message})",
  "}",
  "$('gen').onclick=function(){",
  " $('out').hidden=false;$('decoded').textContent='';$('barcode').removeAttribute('src');",
  " if(!sup||!sup.fields){$('decoded').textContent='no label builder for this brand \\u2014 use raw-text mode below';return}",
  " if(ctrls.serialNo)ctrls.serialNo.value=randomSerial();",
  " postJSON('/dev/lab/label',collect()).then(function(j){",
  "  $('raw').value=j.raw;var s=$('barcode').style;s.display='block';",
  "  $('decoded').textContent=JSON.stringify(j.decoded,null,2);",
  "  var bcid=$('bcid').value==='auto'?(SYM[sup.qrType]||'qrcode'):$('bcid').value;",
  "  renderBarcode(bcid,j.raw,$('barcode'));",
  "  if(j.warning)$('decoded').textContent+='\\n\\n'+j.warning;",
  " }).catch(function(e){$('decoded').textContent=e.message})",
  "}",
  "$('raw').onclick=function(){this.select()};",
  "$('render').onclick=function(){",
  " $('rawerr').textContent='';var t=$('rawIn').value;if(!t)return;",
  " postJSON('/dev/lab/barcode',{bcid:$('bcid2').value,text:t}).then(function(j){$('rawImg').src='data:image/png;base64,'+j.image})",
  "  .catch(function(e){$('rawerr').textContent=e.message})",
  "}",
].join("\n");
