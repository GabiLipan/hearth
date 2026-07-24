// Rasterise the brand SVGs into the PWA / app-icon PNGs.
// Run: node scripts/gen-icons.mjs
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rounded = readFileSync(join(root, 'public/logo.svg')) // transparent corners
const square = readFileSync(join(root, 'public/logo-square.svg')) // full-bleed, for masks

const targets = [
  { svg: rounded, size: 192, out: 'public/icons/icon-192.png' },
  { svg: rounded, size: 512, out: 'public/icons/icon-512.png' },
  { svg: square, size: 180, out: 'public/icons/apple-touch-icon.png' },
  { svg: square, size: 512, out: 'public/icons/icon-maskable-512.png' },
  { svg: rounded, size: 32, out: 'public/favicon-32.png' },
]

for (const { svg, size, out } of targets) {
  // High render density so the gradients/blur upscale cleanly from the 180px SVG.
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(join(root, out))
  console.log('wrote', out, `${size}px`)
}
