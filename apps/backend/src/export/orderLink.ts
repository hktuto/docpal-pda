// Order-link QR payload shared by the Excel export renderers and consumed by
// the PDA: a QR encoding `warehouse://<kind>/<id>` (spec
// docs/superpowers/specs/2026-10-02-excel-order-barcode-scan-to-open-design.md).
// The id is the order's UUID route key — the same key the PDA pages use
// (/receiving/:id, /picking/:id) — so the PDA can navigate straight to the
// order with no lookup endpoint and no host configuration (the custom scheme
// works identically in the bundled APK, the hosted app, and dev).

import QRCode from "qrcode";

export type OrderLinkKind = "receiving" | "picking";

export function orderLink(kind: OrderLinkKind, id: string): string {
  return `warehouse://${kind}/${id}`;
}

/** Render the link as a QR PNG (Buffer) sized for embedding in an xlsx sheet. */
export async function orderLinkQrPng(link: string): Promise<Buffer> {
  return QRCode.toBuffer(link, { type: "png", width: 240, margin: 1 });
}
