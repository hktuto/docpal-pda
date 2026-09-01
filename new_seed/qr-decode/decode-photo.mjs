// Decode QR / DataMatrix codes from supplier label photos (one-off tooling).
// Usage: node decode-photo.mjs <image.jpg> [x y w h]   (coords in original pixels)
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DataMatrixReader, QRCodeReader } from "@zxing/library";

const [imgPath, sx, sy, sw, sh] = process.argv.slice(2);
const raw = jpeg.decode(readFileSync(imgPath), { maxResolutionInMP: 4096, format: "RGBA8888" });
let { data, width, height } = raw;
console.log(`image ${width}x${height}`);

if (sx !== undefined) {
  const x = +sx, y = +sy, w = +sw, h = +sh;
  const cropped = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    data.copy(cropped, row * w * 4, (y + row) * width * 4 + x * 4, (y + row) * width * 4 + (x + w) * 4);
  }
  data = cropped; width = w; height = h;
  console.log(`cropped to ${w}x${h} @ ${x},${y}`);
  const out = jpeg.encode({ data: Buffer.from(data.buffer, data.byteOffset, w * h * 4), width: w, height: h }, 95);
  const { writeFileSync } = await import("node:fs");
  writeFileSync("last-crop.jpg", out.data);
  console.log("wrote last-crop.jpg");
}

const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
// preprocess: grayscale + contrast stretch + hard threshold at several levels
function gray() {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return g;
}
function toRgba(g) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < g.length; i++) { out[i*4]=out[i*4+1]=out[i*4+2]=g[i]; out[i*4+3]=255; }
  return out;
}
const g = gray();
let mn = 255, mx = 0; for (const v of g) { if (v < mn) mn = v; if (v > mx) mx = v; }
const stretched = g.map((v) => Math.max(0, Math.min(255, ((v - mn) * 255) / (mx - mn || 1))));

function transform(pix, w, h, mode) {
  // mode: 0=none 1=rot90 2=rot180 3=rot270, then 2x nearest-neighbor upscale
  let W = w, H = h, src = pix;
  if (mode >= 1 && mode <= 3) {
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sx, sy;
      if (mode === 1) { sx = y; sy = w - 1 - x; }       // rot90 cw: out(x,y)=src(y, w-1-x)? dims swap
      else if (mode === 2) { sx = w - 1 - x; sy = h - 1 - y; }
      else { sx = h - 1 - y; sy = x; }
      out[y * (mode === 2 ? w : h) + x] = src[sy * w + sx];
    }
    if (mode !== 2) { W = h; H = w; }
    src = out;
  }
  // 2x upscale
  const up = new Uint8ClampedArray(W * 2 * H * 2);
  for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) up[y * W * 2 + x] = src[(y >> 1) * W + (x >> 1)];
  return { pix: up, w: W * 2, h: H * 2 };
}

for (const t of [100, 128, 160, 190]) {
  const qr = jsQR(toRgba(stretched.map((v) => (v > t ? 255 : 0))), width, height);
  if (qr) console.log(`jsQR(thresh${t}):`, JSON.stringify(qr.data));
}
for (const t of [128, 160, 190]) {
  const bin = stretched.map((v) => (v > t ? 255 : 0));
  for (const mode of [0, 1, 2, 3]) {
    const { pix, w, h } = transform(bin, width, height, mode);
    const rgbaPix = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < pix.length; i++) { rgbaPix[i*4]=rgbaPix[i*4+1]=rgbaPix[i*4+2]=pix[i]; rgbaPix[i*4+3]=255; }
    try {
      const lum = new RGBLuminanceSource(rgbaPix, w, h);
      const bitmap = new BinaryBitmap(new HybridBinarizer(lum));
      console.log(`zxing DM(t${t},rot${mode * 90}):`, JSON.stringify(new DataMatrixReader().decode(bitmap).getText()));
    } catch { /* not found */ }
  }
}
console.log("done");
