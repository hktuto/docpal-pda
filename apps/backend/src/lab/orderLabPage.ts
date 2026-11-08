// ---------------------------------------------------------------------------
// Order-driven Dev Lab pages (GET /dev/lab/receiving-cn, /dev/lab/picking):
// same label builder as /dev/lab, but the part picker is driven by a real
// order — pick the order (receiving-cn: batch_no; picking: order id), pick
// one of its items, and the label fields prefill from it (part no / WCL item
// no / qty / lot / coo / drawing no). Qty, date, etc. stay editable, and
// Build randomizes the serial so repeat clicks yield fresh labels.
// Plain JS (no build step), string concat — no template literals.
// ---------------------------------------------------------------------------

import { LAB_BODY_TAIL, LAB_CSS, LAB_HEAD, LAB_SCRIPT_CORE } from "./pageCommon.js";

export interface OrderLabPageConfig {
  mode: "receiving-cn" | "picking";
  title: string;
  orderLabel: string;
}

export function buildOrderLabPage(cfg: OrderLabPageConfig): string {
  const base = `/dev/lab/${cfg.mode}`;
  const boot =
    cfg.mode === "receiving-cn"
      ? [
          "function ordersUrl(){return '" + base + "/orders'}",
          "function itemsUrl(o){return '" + base + "/orders/'+encodeURIComponent(o.batchNo)+'/items'}",
          "function orderText(o){return o.batchNo+' \\u00b7 '+o.status+(o.supplier?' \\u00b7 '+o.supplier:'')+(o.deliveryDate?' \\u00b7 '+String(o.deliveryDate).slice(0,10):'')}",
          "function itemText(it){return it.partNo+' \\u00b7 '+(it.wclItemNo||'')+' \\u00b7 qty '+(it.lineQty==null?'?':it.lineQty)+(it.brand?' \\u00b7 '+it.brand:'')+(it.invoiceNo?' \\u00b7 inv '+it.invoiceNo:'')}",
          "function itemPartNo(it){return sup&&sup.supplierCode==='23'?(it.drawingNo||it.partNo||''):(it.partNo||'')}",
          "function itemQty(it){return it.lineQty}",
        ].join("\n")
      : [
          "function ordersUrl(){return '" + base + "/orders'}",
          "function itemsUrl(o){return '" + base + "/orders/'+encodeURIComponent(o.id)+'/items'}",
          "function orderText(o){return o.orderNo+' \\u00b7 '+o.status+(o.customerCode?' \\u00b7 '+o.customerCode:'')+(o.deliveryDate?' \\u00b7 '+String(o.deliveryDate).slice(0,10):'')}",
          "function itemText(it){return it.partNo+' \\u00b7 '+(it.wclItemNo||'')+' \\u00b7 qty '+(it.qty==null?'?':it.qty)+(it.brand?' \\u00b7 '+it.brand:'')+(it.lineNumber!=null?' \\u00b7 line '+it.lineNumber:'')}",
          "function itemPartNo(it){return it.partNo||''}",
          "function itemQty(it){return it.qty}",
        ].join("\n");

  return [
    LAB_HEAD,
    `<title>${cfg.title}</title>`,
    LAB_CSS,
    `<h1>${cfg.title}</h1>`,
    "<p id=loaderr></p>",
    "<div id=main hidden>",
    `<div class=row><div><label>${cfg.orderLabel}</label><select id=order></select></div>`,
    "<div><label>Item (from the order)</label><select id=item></select></div></div>",
    LAB_BODY_TAIL,
    "<script>",
    "(function(){",
    "var $=function(id){return document.getElementById(id)};",
    LAB_SCRIPT_CORE,
    "var suppliers=[],orders=[],items=[];",
    "window.LAB_SET_SUPPLIER=function(s){sup=s;renderFields();renderHint()};",
    boot,
    "$('order').onchange=function(){",
    " var o=orders[Number(this.value)];var sel=$('item');sel.textContent='';items=[];",
    " if(!o)return;",
    " fetch(itemsUrl(o)).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})}).then(function(d){",
    "  items=d.items||[];",
    "  items.forEach(function(it,i){var op=document.createElement('option');op.value=String(i);op.textContent=itemText(it);sel.appendChild(op)});",
    "  if(items.length){sel.value='0';sel.onchange()}",
    " }).catch(function(e){$('hint').textContent='items load failed: '+e.message})",
    "}",
    "$('item').onchange=function(){",
    " var it=items[Number(this.value)];if(!it)return;",
    " window.LAB_SET_SUPPLIER(it.brand?supFor(it.brand):null);",
    " if(ctrls.partNo)ctrls.partNo.value=itemPartNo(it);",
    " if(ctrls.wclItemNo)ctrls.wclItemNo.value=it.wclItemNo||'';",
    " var q=itemQty(it);if(ctrls.qty&&q!=null)ctrls.qty.value=String(q);",
    " if(ctrls.lotCode&&it.lotCode)ctrls.lotCode.value=it.lotCode;",
    " if(ctrls.coo&&it.coo)ctrls.coo.value=it.coo;",
    " if(!sup||!sup.fields){$('hint').textContent=it.brand?('no supplier label builder covers brand '+it.brand+' \\u2014 use raw-text mode below'):'(no brand matched for this item)'}",
    "}",
    "Promise.all([fetch('/dev/lab/data').then(function(r){return r.json()}),fetch(ordersUrl()).then(function(r){return r.json()})])",
    ".then(function(a){",
    " suppliers=a[0].suppliers;orders=a[1].orders||[];$('main').hidden=false;",
    " var sel=$('order');",
    " if(!orders.length){var o0=document.createElement('option');o0.value='';o0.textContent='(no orders)';sel.appendChild(o0);return}",
    " orders.forEach(function(o,i){var op=document.createElement('option');op.value=String(i);op.textContent=orderText(o);sel.appendChild(op)});",
    " sel.value='0';sel.onchange();",
    "}).catch(function(e){$('loaderr').textContent='dev lab data failed to load: '+e.message});",
    "})();",
    "</script></body></html>",
  ].join("\n");
}
