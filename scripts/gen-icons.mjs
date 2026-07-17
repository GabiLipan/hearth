// Generates the PWA icon set as PNGs with no image dependencies:
// renders a rounded-square gradient tile with three rounded chart bars
// via signed-distance functions, then encodes raw RGBA as PNG (zlib).
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// SDF for a rounded rectangle centred at (cx, cy)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r
  const qy = Math.abs(py - cy) - hh + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

const smooth = (d, aa) => Math.min(1, Math.max(0, 0.5 - d / aa))
const mix = (a, b, t) => a + (b - a) * t

function render(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4)
  const aa = Math.max(1.25, size / 256)
  // Maskable icons must fill the full square (the OS applies its own mask);
  // regular icons get a rounded tile with transparent corners.
  const pad = maskable ? 0 : 0
  const tileR = maskable ? 0 : size * 0.22
  // Content is inset further on maskable so the safe zone (80%) holds the art.
  const s = maskable ? size * 0.78 : size
  const off = (size - s) / 2
  // Gradient: deep blue -> teal, diagonal
  const c0 = [26, 88, 178] // #1a58b2
  const c1 = [27, 175, 122] // #1baf7a
  // Bars: x-centre fractions, half-width, height fraction of s
  const bars = [
    [0.32, 0.34],
    [0.5, 0.52],
    [0.68, 0.44],
  ]
  const barHW = s * 0.062
  const barR = barHW
  const baseY = off + s * 0.74
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dTile = sdRoundRect(x + 0.5, y + 0.5, size / 2, size / 2, size / 2 - pad, size / 2 - pad, tileR)
      const tileA = smooth(dTile, aa)
      if (tileA <= 0) continue
      const t = (x / size + y / size) / 2
      let r = mix(c0[0], c1[0], t)
      let g = mix(c0[1], c1[1], t)
      let b = mix(c0[2], c1[2], t)
      // subtle vertical sheen
      const sheen = 1 + 0.08 * (1 - y / size)
      r *= sheen; g *= sheen; b *= sheen
      // bars (white, slightly translucent stack from back to front)
      let barA = 0
      for (const [cxF, hF] of bars) {
        const hh = (s * hF) / 2
        const d = sdRoundRect(x + 0.5, y + 0.5, off + s * cxF, baseY - hh, barHW, hh, barR)
        barA = Math.max(barA, smooth(d, aa))
      }
      r = mix(r, 255, barA * 0.96)
      g = mix(g, 255, barA * 0.96)
      b = mix(b, 255, barA * 0.96)
      rgba[i] = Math.min(255, Math.round(r))
      rgba[i + 1] = Math.min(255, Math.round(g))
      rgba[i + 2] = Math.min(255, Math.round(b))
      rgba[i + 3] = Math.round(tileA * 255)
    }
  }
  return encodePNG(size, size, rgba)
}

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/icon-192.png', render(192))
writeFileSync('public/icons/icon-512.png', render(512))
writeFileSync('public/icons/icon-maskable-512.png', render(512, { maskable: true }))
writeFileSync('public/icons/apple-touch-icon.png', render(180, { maskable: true }))
console.log('icons written')
