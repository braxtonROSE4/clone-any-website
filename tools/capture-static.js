import fs from 'node:fs'
import path from 'node:path'
import { fullPageScreenshot } from './full-page-screenshot.js'

function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(n)))
}

function requirePage(ctx, tool) {
  if (!ctx?.page || typeof ctx.page.evaluate !== 'function') {
    throw new Error(tool + ': ctx.page must be an ego-browser Page, e.g. { page: (await task.pages())[0] }')
  }
  return ctx.page
}

async function freezeVideosAndGuardViewport(page) {
  await page.evaluate(() => {
    const freeze = () => document.querySelectorAll('video').forEach((v) => v.pause())
    freeze()
    if (!window.__rwFreeze) window.__rwFreeze = setInterval(freeze, 400)
  })
  const info = await page.info()
  if (!info.w || !info.h) {
    throw new Error('captureStatic: viewport is 0, restore the real tab first: ' + JSON.stringify(info))
  }
  return info
}

export async function captureStatic(ctx, args = {}) {
  const page = requirePage(ctx, 'captureStatic')
  const { url, outDir } = args
  if (!url) throw new Error('captureStatic: url is required')
  if (!outDir) throw new Error('captureStatic: outDir is required')
  // ego's Node.js process does not run in the shell's cwd; a relative outDir lands somewhere unexpected.
  if (!path.isAbsolute(outDir)) throw new Error('captureStatic: outDir must be an absolute path: ' + outDir)
  const minSectionHeight = boundedInteger(args.minSectionHeight, 40, 2000)

  for (const sub of ['dom', 'screenshots']) fs.mkdirSync(path.join(outDir, sub), { recursive: true })

  // domcontentloaded, then a bounded wait for load: heavy pages can hold `load` back far past 30s.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
  const viewport = await freezeVideosAndGuardViewport(page)

  const facts = await page.evaluate((minH) => {
    const res = performance.getEntriesByType('resource').map((e) => e.name)
    return {
      html: document.documentElement.outerHTML,
      outline: Array.from(
        document.querySelectorAll('body section, body header, body footer, body main > div, body > div > section, body > div > div'),
      )
        .map((el) => {
          const r = el.getBoundingClientRect()
          return {
            tag: el.tagName,
            cls: (el.className?.toString() || '').slice(0, 120),
            y: Math.round(r.top + scrollY),
            h: Math.round(r.height),
            w: Math.round(r.width),
          }
        })
        .filter((s) => s.h > minH)
        .sort((a, b) => a.y - b.y),
      cssUrls: res.filter((u) => /\.css(\?|$)/.test(u)),
      fontFiles: res.filter((u) => /\.(woff2?|ttf|otf)(\?|$)/.test(u)),
      jsChunks: res.filter((u) => /\.js(\?|$)/.test(u)),
    }
  }, minSectionHeight)

  if (!facts.html || facts.html.length < 500) {
    throw new Error('captureStatic: DOM capture is implausibly small: ' + (facts.html?.length ?? 0) + ' chars')
  }

  fs.writeFileSync(path.join(outDir, 'dom', 'full-page.html'), facts.html)
  fs.writeFileSync(path.join(outDir, 'dom', 'outline.json'), JSON.stringify(facts.outline, null, 2))
  fs.writeFileSync(
    path.join(outDir, 'urls.json'),
    JSON.stringify({ css: facts.cssUrls, fonts: facts.fontFiles, js: facts.jsChunks }, null, 2),
  )

  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(800)
  const screenshot = path.join(outDir, 'screenshots', 'original-full.png')
  const shot = await fullPageScreenshot({ page }, { path: screenshot })
  if (!fs.existsSync(screenshot)) throw new Error('captureStatic: screenshot was not written: ' + screenshot)

  return {
    viewport: { w: viewport.w, h: viewport.h },
    sections: facts.outline.length,
    cssFiles: facts.cssUrls.length,
    fontFiles: facts.fontFiles.length,
    jsChunks: facts.jsChunks.length,
    htmlKB: Math.round(facts.html.length / 1024),
    screenshot,
    screenshotMethod: shot.method,
    outDir,
  }
}
