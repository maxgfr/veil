/**
 * Generates the PWA icons (PNG + SVG) from the Veil mark, with no image
 * dependency: shapes are rasterized with 4×4 supersampling and written by a
 * minimal PNG encoder. Run with `bun scripts/icons.ts`; output is committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = resolve(import.meta.dir, "../public/icons");
const BG: [number, number, number] = [18, 122, 114];
const FG: [number, number, number] = [250, 253, 252];

// Geometry on the 32-unit grid of the in-app logo.
const ARC = { cx: 16, cy: 23.425, r: 12.675, x0: 7, x1: 25, width: 2.2 };
const RING = { cx: 16, cy: 17.5, r: 6.5, width: 2, alpha: 0.55 };

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Coverage of the mark at a point of the 32-grid: [background, foreground alpha]. */
function sample(x: number, y: number, rounded: boolean): [number, number] {
  let bg = 1;
  if (rounded) {
    const r = 9;
    const qx = Math.max(Math.abs(x - 16) - (16 - r), 0);
    const qy = Math.max(Math.abs(y - 16) - (16 - r), 0);
    if (Math.hypot(qx, qy) > r) bg = 0;
  }
  let fg = 0;
  const d = Math.hypot(x - RING.cx, y - RING.cy);
  if (Math.abs(d - RING.r) <= RING.width / 2) fg = RING.alpha;
  // Upper arc between the two end points, with round caps.
  const da = Math.hypot(x - ARC.cx, y - ARC.cy);
  // Clip along the curve: project the point onto the circle before testing the end points.
  const projX = ARC.cx + ((x - ARC.cx) * ARC.r) / (da || 1);
  const onArc =
    projX >= ARC.x0 && projX <= ARC.x1 && y < ARC.cy && Math.abs(da - ARC.r) <= ARC.width / 2;
  const capY = 14.5;
  const cap =
    Math.min(Math.hypot(x - ARC.x0, y - capY), Math.hypot(x - ARC.x1, y - capY)) <= ARC.width / 2;
  if (onArc || cap) fg = 1;
  return [bg, fg];
}

function render(size: number, opts: { rounded: boolean; scale: number }): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgA = 0;
      let fgA = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((px + (sx + 0.5) / ss) / size) * 32;
          const v = ((py + (sy + 0.5) / ss) / size) * 32;
          // The mark is scaled around the center (maskable icons keep it in the safe zone).
          const [, f] = sample(16 + (u - 16) / opts.scale, 16 + (v - 16) / opts.scale, false);
          const [b] = sample(u, v, opts.rounded);
          bgA += b;
          fgA += f * b;
        }
      }
      bgA /= ss * ss;
      fgA /= ss * ss;
      const i = (py * size + px) * 4;
      const t = bgA > 0 ? fgA / bgA : 0;
      for (let c = 0; c < 3; c++)
        rgba[i + c] = Math.round((BG[c] as number) * (1 - t) + (FG[c] as number) * t);
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }
  return png(size, rgba);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img"><title>Veil</title><rect width="32" height="32" rx="9" fill="rgb(${BG.join(",")})"/><circle cx="16" cy="17.5" r="6.5" fill="none" stroke="rgb(${FG.join(",")})" stroke-width="2" opacity="0.55"/><path d="M7 14.5c3.2-5 14.8-5 18 0" fill="none" stroke="rgb(${FG.join(",")})" stroke-width="2.2" stroke-linecap="round"/></svg>\n`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon.svg"), svg);
writeFileSync(join(OUT, "icon-192.png"), render(192, { rounded: true, scale: 1 }));
writeFileSync(join(OUT, "icon-512.png"), render(512, { rounded: true, scale: 1 }));
writeFileSync(join(OUT, "maskable-512.png"), render(512, { rounded: false, scale: 0.72 }));
writeFileSync(join(OUT, "apple-touch-icon.png"), render(180, { rounded: false, scale: 0.86 }));
console.log(`icons written to ${OUT}`);
