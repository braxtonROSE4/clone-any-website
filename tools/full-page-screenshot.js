import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// Chromium refuses a single capture taller than 16384 CSS px ("Unable to capture
// screenshot"); render-heavy pages (WebGL, rAF loops) can also time out on one tall
// capture while shorter clips succeed. Both cases fall back to clip bands stitched here.
const MAX_SINGLE_SHOT_PX = 16384

function boundedInteger(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function shotWithRetry(page, opts) {
  try {
    return await page.screenshot(opts)
  } catch (first) {
    await page.waitForTimeout(1500)
    try {
      return await page.screenshot(opts)
    } catch (second) {
      throw new Error('screenshot failed twice: ' + (second?.message || second) + ' (first: ' + (first?.message || first) + ')')
    }
  }
}

// ---- minimal PNG codec: 8-bit, non-interlaced gray / gray+alpha / RGB / RGBA ----

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function decodePng(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file)
  let pos = 8
  let ihdr = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!ihdr) throw new Error('PNG without IHDR: ' + file)
  const channels = CHANNELS[ihdr.colorType]
  if (ihdr.depth !== 8 || !channels || ihdr.interlace !== 0) {
    throw new Error('unsupported PNG layout (need 8-bit non-interlaced gray/RGB/RGBA): ' + JSON.stringify(ihdr))
  }
  const bpp = channels
  const stride = ihdr.width * bpp
  const src = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(stride * ihdr.height)
  for (let y = 0; y < ihdr.height; y++) {
    const filter = src[y * (stride + 1)]
    const s = y * (stride + 1) + 1
    const o = y * stride
    const p = o - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0
      const b = y > 0 ? out[p + x] : 0
      const c = x >= bpp && y > 0 ? out[p + x - bpp] : 0
      let v = src[s + x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + x] = v & 0xff
    }
  }
  return { width: ihdr.width, height: ihdr.height, channels, pixels: out }
}

function toRgba(img) {
  if (img.channels === 4) return img
  const n = img.width * img.height
  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const s = i * img.channels
    if (img.channels === 3) { out[i * 4] = img.pixels[s]; out[i * 4 + 1] = img.pixels[s + 1]; out[i * 4 + 2] = img.pixels[s + 2]; out[i * 4 + 3] = 255 }
    else if (img.channels === 1) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = img.pixels[s]; out[i * 4 + 3] = 255 }
    else { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = img.pixels[s]; out[i * 4 + 3] = img.pixels[s + 1] }
  }
  return { ...img, channels: 4, pixels: out }
}

function encodePng(file, { width, height, channels, pixels }) {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const r = y * (stride + 1)
    const o = y * stride
    raw[r] = 2 // "Up" filter: screenshots are vertically repetitive, so this compresses well
    for (let x = 0; x < stride; x++) raw[r + 1 + x] = (pixels[o + x] - (y > 0 ? pixels[o - stride + x] : 0)) & 0xff
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

function stitch(bands) {
  const sameLayout = bands.every((b) => b.channels === bands[0].channels)
  const imgs = sameLayout ? bands : bands.map(toRgba)
  const width = Math.min(...imgs.map((b) => b.width))
  const channels = imgs[0].channels
  const stride = width * channels
  const height = imgs.reduce((n, b) => n + b.height, 0)
  const pixels = Buffer.alloc(stride * height)
  let row = 0
  for (const b of imgs) {
    const bStride = b.width * channels
    for (let y = 0; y < b.height; y++, row++) b.pixels.copy(pixels, row * stride, y * bStride, y * bStride + stride)
  }
  return { width, height, channels, pixels }
}

/**
 * Full-page PNG at the current scroll position's document, CSS-pixel scale.
 * One capture when the page fits Chromium's limit; otherwise (or when that capture
 * fails) clip bands of `bandHeight` CSS px stitched into one file.
 */
export async function fullPageScreenshot(ctx, args = {}) {
  const page = ctx?.page
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('fullPageScreenshot: ctx.page must be an ego-browser Page, e.g. { page: (await task.pages())[0] }')
  }
  const out = args.path
  if (!out) throw new Error('fullPageScreenshot: path is required')
  if (!path.isAbsolute(out)) throw new Error('fullPageScreenshot: path must be absolute: ' + out)
  const bandHeight = boundedInteger(args.bandHeight, 4096, 256, MAX_SINGLE_SHOT_PX)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const doc = await page.evaluate(() => ({
    w: Math.max(document.documentElement.scrollWidth, innerWidth),
    h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  }))
  if (!doc.w || !doc.h) throw new Error('fullPageScreenshot: document has no size: ' + JSON.stringify(doc))

  let singleShotError = null
  if (doc.h <= MAX_SINGLE_SHOT_PX && !args.forceBands) {
    try {
      await page.screenshot({ path: out, fullPage: true })
      if (fs.existsSync(out)) return { path: out, method: 'single', bands: 1, cssWidth: doc.w, cssHeight: doc.h }
    } catch (e) {
      singleShotError = e?.message || String(e)
    }
  }

  const bands = []
  const tmpBase = out.replace(/\.png$/i, '') + '.band-'
  try {
    for (let y = 0, i = 0; y < doc.h; y += bandHeight, i++) {
      const file = tmpBase + i + '.png'
      // fullPage must stay on with clip: a clip-only capture does not paint below the
      // viewport and comes back as flat background.
      await shotWithRetry(page, { path: file, fullPage: true, clip: { x: 0, y, width: doc.w, height: Math.min(bandHeight, doc.h - y) } })
      bands.push(decodePng(file))
      fs.rmSync(file, { force: true })
    }
  } finally {
    for (let i = 0; i <= bands.length; i++) fs.rmSync(tmpBase + i + '.png', { force: true })
  }
  const img = stitch(bands)
  encodePng(out, img)
  if (!fs.existsSync(out)) throw new Error('fullPageScreenshot: stitched file was not written: ' + out)
  return {
    path: out,
    method: 'bands',
    bands: bands.length,
    cssWidth: doc.w,
    cssHeight: doc.h,
    imageWidth: img.width,
    imageHeight: img.height,
    ...(singleShotError ? { singleShotError } : {}),
  }
}
