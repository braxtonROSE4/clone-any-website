import fs from 'node:fs'
import path from 'node:path'

function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(n)))
}

export async function inventoryAnimations(ctx, args = {}) {
  const page = ctx?.page
  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('inventoryAnimations: ctx.page must be an ego-browser Page, e.g. { page: (await task.pages())[0] }')
  }
  if (args.outPath && !path.isAbsolute(args.outPath)) {
    throw new Error('inventoryAnimations: outPath must be an absolute path: ' + args.outPath)
  }
  const maxAnimations = boundedInteger(args.maxAnimations, 200, 500)

  const inventory = await page.evaluate((limit) => {
    return document.getAnimations({ subtree: true }).slice(0, limit).map((a) => ({
      target:
        (a.effect?.target?.tagName || '?') +
        '.' +
        (a.effect?.target?.className?.toString().slice(0, 80) || ''),
      kind: a.constructor?.name || 'Animation',
      timeline: a.timeline?.constructor?.name || 'none',
      range: [a.rangeStart, a.rangeEnd],
      keyframes: a.effect?.getKeyframes?.() || [],
      inlineVars: a.effect?.target?.getAttribute?.('style') || null,
    }))
  }, maxAnimations)

  const byTimeline = {}
  for (const a of inventory) byTimeline[a.timeline] = (byTimeline[a.timeline] || 0) + 1
  const summary = { count: inventory.length, byTimeline }

  if (args.outPath) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true })
    fs.writeFileSync(args.outPath, JSON.stringify(inventory, null, 2))
    return { ...summary, outPath: args.outPath }
  }
  return { ...summary, animations: inventory }
}
