import fs from 'node:fs'
import path from 'node:path'
import { fullPageScreenshot } from './full-page-screenshot.js'

function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(n)))
}

/**
 * Standardized benchmark probe. Run the IDENTICAL probe on original and clone;
 * scripts/eval_score.py diffs the two JSON outputs. Never compare numbers from
 * different probes or viewports.
 *
 * ctx.page is an ego-browser Page. Pass the SAME Page for both sides.
 */
export async function evalProbe(ctx, args = {}) {
  const page = ctx?.page
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('evalProbe: ctx.page must be an ego-browser Page, e.g. { page: (await task.pages())[0] }')
  }
  const { url, outPath, screenshotPath } = args
  if (!url) throw new Error('evalProbe: url is required')
  if (!outPath) throw new Error('evalProbe: outPath is required')
  if (!screenshotPath) throw new Error('evalProbe: screenshotPath is required')
  // ego's Node.js process does not run in the shell's cwd; relative paths land somewhere unexpected.
  for (const p of [outPath, screenshotPath]) {
    if (!path.isAbsolute(p)) throw new Error('evalProbe: output paths must be absolute: ' + p)
  }
  const maxPerSection = boundedInteger(args.maxPerSection, 8, 20)

  // Navigate the one Page the caller passes for both sides rather than a
  // per-URL tab: separate tabs can have content areas differing by ~16px
  // (measured 1470 vs 1454 in the same window), which shifts every centered
  // element 8px and poisons geometry while page.info() still reports equal
  // window sizes. Probing original and clone through the same Page guarantees
  // one viewport.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // Deterministic measurement state: stateful bars reset, videos frozen, top of page.
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear() } catch (e) { /* sandboxed page */ }
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  // Bounded wait for `load`: on some pages it fires late or never in an agent space.
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
  await page.evaluate(() => {
    const freeze = () => document.querySelectorAll('video').forEach((v) => v.pause())
    freeze()
    if (!window.__rwFreeze) window.__rwFreeze = setInterval(freeze, 400)
    scrollTo(0, 0)
  })
  // Wait for layout to stabilize instead of a fixed delay: JS animation setup
  // hangs off `window load + rAF`, and in background tabs that fires at an
  // arbitrary time (or not at all), differently for a network original and a
  // localhost clone. Two consecutive identical pageH readings = settled.
  {
    let prev = -1
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000)
      const h = await page.evaluate(() => document.body.scrollHeight)
      if (h === prev) break
      prev = h
    }
  }

  // Phase-normalize infinite time-driven animations, identically on both sides.
  // Marquee/motion-path/autoscroll elements otherwise sample at a random loop
  // phase per side and report position error that is probe-timing jitter, not
  // clone infidelity (measured 50-2879px on wisprflow.ai). Same class of
  // determinism the probe already enforces for videos and localStorage banners.
  await page.evaluate(() => {
    const norm = () => {
      if (window.gsap) {
        try {
          // Kill infinite tweens and clear their targets' transforms. Not
          // progress(0) (motion-path tweens start distributed along the path,
          // no shared reference state) and not revert() alone (whether the
          // tweens exist yet depends on load timing). kill + clearProps lands
          // both sides on the natural CSS position whether or not init ran.
          const infinite = window.gsap.globalTimeline.getChildren(true, true, true)
            .filter((t) => { try { return t.repeat && t.repeat() === -1 } catch (e) { return false } })
          const targets = []
          infinite.forEach((t) => {
            const tweens = t.getChildren ? t.getChildren(true, true, false) : [t]
            tweens.forEach((tw) => { try { targets.push(...tw.targets()) } catch (e) {} })
            try { t.kill() } catch (e) {}
          })
          targets.forEach((el) => { try { if (el instanceof Element) window.gsap.set(el, { clearProps: 'transform' }) } catch (e) {} })
        } catch (e) {}
      }
      document.getAnimations({ subtree: true }).forEach((a) => {
        try {
          const t = a.effect?.getTiming?.()
          if (t && t.iterations === Infinity) { a.currentTime = 0; a.pause() }
        } catch (e) {}
      })
      // anchor looped carousels at their first REAL slide (loop mode prepends
      // clones, so translateX(0) would show clones and diverge per side)
      document.querySelectorAll('.splide__list').forEach((l) => {
        const firstReal = l.querySelector('.splide__slide:not(.splide__slide--clone)')
        if (firstReal) l.style.transform = 'translateX(' + (-firstReal.offsetLeft) + 'px)'
      })
    }
    window.__rwNormFn = norm
    norm()
    if (!window.__rwNorm) window.__rwNorm = setInterval(norm, 300)
  })
  await page.waitForTimeout(800)

  const info = await page.info()
  if (!info.w || !info.h) throw new Error('evalProbe: viewport is 0: ' + JSON.stringify(info))

  const probe = await page.evaluate((maxPer) => {
    // re-apply phase normalization synchronously in the same task as sampling,
    // so rAF-driven writers (e.g. Splide autoScroll) cannot interject between them
    if (window.__rwNormFn) window.__rwNormFn()
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const base = (u) => {
      try {
        const p = new URL(u, location.href)
        const q = p.searchParams.get('url')
        const path = p.pathname === '/_next/image' && q ? decodeURIComponent(q) : p.pathname
        return path.split('/').pop()
      } catch { return u }
    }

    // Section bands: drop giant wrappers (> half the page) and overlapping duplicates from
    // different nesting depths, so both sides yield comparable non-overlapping top-level bands.
    const pageH = document.body.scrollHeight
    const candidates = Array.from(
      document.querySelectorAll('body section, body header, body footer, body main > div, body > div > section, body > div > div'),
    )
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((s) => s.r.height > 40 && s.r.height < pageH * 0.5)
      .sort((a, b) => b.r.height * b.r.width - a.r.height * a.r.width)
    const sectionEls = []
    for (const s of candidates) {
      const y1 = s.r.top + scrollY
      const overlaps = sectionEls.some((k) => {
        const ky1 = k.r.top + scrollY
        const inter = Math.min(ky1 + k.r.height, y1 + s.r.height) - Math.max(ky1, y1)
        return inter > 0.5 * Math.min(k.r.height, s.r.height)
      })
      if (!overlaps) sectionEls.push(s)
    }
    sectionEls.sort((a, b) => a.r.top - b.r.top)

    const sections = sectionEls.map(({ el, r }, si) => {
      const samples = Array.from(el.querySelectorAll('h1,h2,h3,h4,a,button,img,p,li'))
        .filter((n) => { const b = n.getBoundingClientRect(); return b.width > 4 && b.height > 4 })
        .slice(0, maxPer)
        .map((n) => {
          const b = n.getBoundingClientRect()
          const c = getComputedStyle(n)
          return {
            key: n.tagName + '|' + (n.tagName === 'IMG' ? base(n.src) : clean(n.textContent).slice(0, 40)),
            rect: { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) },
            font: { family: c.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: c.fontSize, weight: c.fontWeight },
            color: c.color,
            bg: c.backgroundColor,
            radius: c.borderRadius,
          }
        })
      return {
        index: si,
        tag: el.tagName,
        y: Math.round(r.top + scrollY),
        h: Math.round(r.height),
        density: { textLen: clean(el.innerText).length, imgs: el.querySelectorAll('img').length, svgs: el.querySelectorAll('svg').length },
        samples,
      }
    })

    const animations = document.getAnimations({ subtree: true })
      // CSSTransitions are transient: they only exist if something changed style
      // in the last few hundred ms, so their count is sampling-moment noise
      .filter((a) => a.constructor.name !== 'CSSTransition')
      .map((a) => ({
        timeline: a.timeline?.constructor?.name || 'none',
        props: [...new Set((a.effect?.getKeyframes?.() || []).flatMap((k) => Object.keys(k)))].filter(
          (p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p),
        ).sort(),
      }))

    return {
      url: location.href,
      pageH: document.body.scrollHeight,
      sections,
      innerViewport: { w: innerWidth, h: innerHeight },
      fonts: [...new Set(Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].sort(),
      assets: {
        imgs: [...new Set(Array.from(document.querySelectorAll('img[src]')).map((i) => base(i.src)))].sort(),
        videos: [...new Set(Array.from(document.querySelectorAll('video source, video[src]')).map((v) => base(v.src || v.getAttribute('src') || '')))].filter(Boolean).sort(),
      },
      animations: {
        count: animations.length,
        byTimeline: animations.reduce((m, a) => ((m[a.timeline] = (m[a.timeline] || 0) + 1), m), {}),
        propSets: animations.map((a) => a.props.join(',')).sort(),
      },
    }
  }, maxPerSection)

  // in-page innerWidth is the layout-relevant width; page.info() reports window
  // bounds, which can be equal while the two tabs' content areas differ
  probe.viewport = probe.innerViewport
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(probe, null, 2))

  const shot = await fullPageScreenshot({ page }, { path: screenshotPath })
  if (!fs.existsSync(screenshotPath)) throw new Error('evalProbe: screenshot was not written: ' + screenshotPath)

  return {
    url: probe.url,
    viewport: probe.viewport,
    pageH: probe.pageH,
    sections: probe.sections.length,
    sampledElements: probe.sections.reduce((n, s) => n + s.samples.length, 0),
    fonts: probe.fonts.length,
    assets: probe.assets.imgs.length + probe.assets.videos.length,
    animations: probe.animations.count,
    outPath,
    screenshotPath,
    screenshotMethod: shot.method,
  }
}
