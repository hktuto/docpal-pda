// Shipper HCC variant (supplier_code = "23") — spec
// docs/superpowers/specs/2026-09-21-shipper-hcc-drawing-no-variant-design.md:
// first column shows the item's drawing number (additional_data.drawing_no)
// instead of the invoice number. Config-style variant over the default
// layout; self-registers scoped to supplier "23" at module load.

import { registerRenderer } from "../../registry.js";
import { makeShipperRenderer } from "./default.js";

registerRenderer(
  "shipper",
  makeShipperRenderer({ firstColumnHeader: "Drawing No / CTN", firstColumnField: "drawingNo" }),
  { supplierCode: "23" }
);
