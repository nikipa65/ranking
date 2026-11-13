'use strict';

// Erzeugt die PNG-App-Icons (192 und 512 px) ohne externe Abhängigkeiten.
// Motiv wie icons/icon.svg, aber randlos (für "maskable" Icons).
// Aufruf: npm run icons

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function render(size) {
  const s = size / 512; // Motiv ist für 512er-Raster definiert
  const bg = hex('#1e40af');
  const white = [255, 255, 255];
  const gold = hex('#fbbf24');
  const bars = [
    { x: 111, y: 230, w: 90, h: 150, a: 0.85 },
    { x: 211, y: 150, w: 90, h: 230, a: 1 },
    { x: 311, y: 270, w: 90, h: 110, a: 0.7 },
  ];
  const r = 10;
  const raw = Buffer.alloc(size * (size * 4 + 1));

  const inRoundRect = (px, py, b) => {
    if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return false;
    const cx = Math.min(Math.max(px, b.x + r), b.x + b.w - r);
    const cy = Math.min(Math.max(py, b.y + r), b.y + b.h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // Filter: none
    for (let x = 0; x < size; x++) {
      // 4x Supersampling für glatte Kanten
      let acc = [0, 0, 0];
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const px = (x + (sx + 0.5) / 2) / s;
          const py = (y + (sy + 0.5) / 2) / s;
          let col = bg;
          for (const b of bars) {
            if (inRoundRect(px, py, b)) col = bg.map((v, i) => v + (white[i] - v) * b.a);
          }
          if ((px - 256) ** 2 + (py - 104) ** 2 <= 28 * 28) col = gold;
          acc = acc.map((v, i) => v + col[i]);
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(acc[0] / 4);
      raw[o + 1] = Math.round(acc[1] / 4);
      raw[o + 2] = Math.round(acc[2] / 4);
      raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bit-Tiefe
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), render(size));
  console.log(`icons/icon-${size}.png geschrieben`);
}
