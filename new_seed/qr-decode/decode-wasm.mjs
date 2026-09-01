// Decode via zxing-wasm (zxing-cpp WASM — much stronger DataMatrix support).
// Usage: node decode-wasm.mjs <image.jpg> x y w h
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { readBarcodes } from "zxing-wasm/reader";

const [imgPath, x, y, w, h] = process.argv.slice(2);
const raw = jpeg.decode(readFileSync(imgPath), { maxResolutionInMP: 4096, format: "RGBA8888" });
let { data, width, height } = raw;
if (x !== undefined) {
  const cx = +x, cy = +y, cw = +w, ch = +h;
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    data.copy(cropped, row * cw * 4, (cy + row) * width * 4 + cx * 4, (cy + row) * width * 4 + (cx + cw) * 4);
  }
  data = cropped; width = cw; height = ch;
}
// zxing-wasm accepts raw pixel data via ImageData-like object in node? It wants
// a Blob/ImageData. Simplest: pass raw RGBA via its `readBarcodes` with ImageData polyfill.
const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
const imageData = { data: rgba, width, height };
try {
  const results = await readBarcodes(imageData, { tryHarder: true });
  for (const r of results) console.log(r.format, JSON.stringify(r.text));
  if (results.length === 0) console.log("no barcode found");
} catch (e) {
  console.log("error:", e.message);
}
