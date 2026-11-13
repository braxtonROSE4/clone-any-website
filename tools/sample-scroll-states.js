function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(n)))
}

const DEFAULT_DEPTHS = [0, 500, 1500, 3300, 7000]

export async function sampleScrollStates(ctx, args = {}) {
  const page = ctx?.page
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('sampleScrollStates: ctx.page must be an ego-browser Page, e.g. { page: (await task.pages())[0] }')
  }
  const { selector } = args
  if (!selector) throw new Error('sampleScrollStates: selector is required')
  const settleMs = boundedInteger(args.settleMs, 600, 2000)
  const depths = Array.isArray(args.depths) && args.depths.length
    ? args.depths.map(Number).filter((y) => Number.isFinite(y) && y >= 0)
    : DEFAULT_DEPTHS
  if (!depths.length) throw new Error('sampleScrollStates: depths has no valid scroll positions: ' + JSON.stringify(args.depths))

  const snapshotAt = async (y) => {
    await page.evaluate((v) => scrollTo(0, v), y)
    // A programmatic scrollTo dispatches no scroll event in an agent task space; drive the state machine manually.
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
    await page.waitForTimeout(settleMs)
    return page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const walk = (n, depth) => {
        const r = n.getBoundingClientRect()
        const c = getComputedStyle(n)
        return {
          tag: n.tagName,
          cls: (n.className?.toString() || '').slice(0, 60),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          style: {
            opacity: c.opacity,
            radius: c.borderRadius,
            bg: c.backgroundColor,
            shadow: c.boxShadow.slice(0, 60),
            pos: c.position,
            display: c.display,
          },
          kids: depth < 6 ? Array.from(n.children).map((k) => walk(k, depth + 1)) : [],
        }
      }
      return { scrollY: window.scrollY, subtree: walk(el, 0) }
    }, selector)
  }

  const out = {}
  for (const y of depths) out['down_' + y] = await snapshotAt(y)
  for (const y of [...depths].reverse()) out['up_' + y] = await snapshotAt(y)

  const sampled = Object.values(out).filter(Boolean).length
  if (!sampled) {
    throw new Error('sampleScrollStates: selector matched nothing at any depth: ' + selector)
  }
  return out
}
