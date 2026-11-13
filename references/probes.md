# Probe library

Copy-paste ego-browser scripts for each phase of `clone-website`. All run as `ego-browser nodejs <<'EOF' ... EOF` via Bash. Replace `TARGET_URL`, `ROOT`, the tools path, and selectors per task.

Every script starts with the same two lines. `taskSpace('reverse example.com')` creates or reuses the job's space; once a script has printed `task.spaceId`, later scripts may pass that numeric id instead. Both original and clone are probed through the space's first Page, so they share one viewport:

```js
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
```

Write full JSON to files under `reference/` and print only counts and paths. ego's Node.js process does not run in the shell's cwd and does not see its environment variables, so every path in a script is absolute.

The canonical, validated implementations of the recurring probes live in `tools/` (see `tools/manifest.json`); import them instead of re-typing:

```bash
ego-browser nodejs <<'EOF'
const { captureStatic } = await import('/ABSOLUTE/PATH/TO/clone-website/tools/capture-static.js')
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
console.log(JSON.stringify({ taskSpaceId: task.spaceId,
  ...(await captureStatic({ page }, { url: 'TARGET_URL', outDir: '/ABSOLUTE/PATH/TO/project/reference' })) }))
EOF
```

## Phase 1, Static capture

### DOM + section outline

```bash
ego-browser nodejs <<'EOF'
const fs = await import('node:fs')
const ROOT = '/ABSOLUTE/PATH/TO/project'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})

// freeze autoplay videos FIRST or later evaluates time out
await page.evaluate(() => {
  const freeze = () => document.querySelectorAll('video').forEach(v => v.pause())
  freeze(); if (!window.__rwFreeze) window.__rwFreeze = setInterval(freeze, 400)
})

const html = await page.evaluate(() => document.documentElement.outerHTML)
fs.mkdirSync(ROOT + '/reference/dom', { recursive: true })
fs.writeFileSync(ROOT + '/reference/dom/full-page.html', html)

const outline = await page.evaluate(() =>
  Array.from(document.body.children).flatMap(el =>
    Array.from(el.querySelectorAll(':scope > section, :scope > div, :scope > header, :scope > footer, :scope > main, :scope > aside'))
      .concat([el])
  ).map(el => {
    const r = el.getBoundingClientRect()
    return { tag: el.tagName, cls: el.className?.toString().slice(0, 120), y: Math.round(r.top + scrollY), h: Math.round(r.height), w: Math.round(r.width) }
  }).filter(s => s.h > 40).sort((a, b) => a.y - b.y)
)
fs.writeFileSync(ROOT + '/reference/dom/outline.json', JSON.stringify(outline, null, 2))
console.log(JSON.stringify({ taskSpaceId: task.spaceId, htmlKB: Math.round(html.length / 1024), sections: outline.length }))
EOF
```

### CSS files + token grep

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const urls = await page.evaluate(() =>
  performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.css(\?|$)/.test(u))
)
console.log(urls.join('\n'))
EOF
# then: curl each into reference/css/, and:
grep -hoE -- '--[a-z-]+:\s*[^;]+' reference/css/*.css | sort -u > reference/design-tokens.txt
grep -nE 'animation-timeline|view-timeline|scroll-timeline|@keyframes' reference/css/*.css > reference/scroll-animation-hits.txt
```

### Fonts (JS-injected @font-face)

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const fonts = await page.evaluate(() => {
  const files = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.(woff2?|ttf|otf)(\?|$)/.test(u))
  const loaded = Array.from(document.fonts).map(f => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }))
  const faces = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules)
        if (rule instanceof CSSFontFaceRule)
          faces.push({ family: rule.style.getPropertyValue('font-family'), weight: rule.style.getPropertyValue('font-weight'), src: rule.style.getPropertyValue('src').slice(0, 300) })
    } catch (e) { /* cross-origin sheet */ }
  }
  return { files, loaded, faces }
})
console.log(JSON.stringify(fonts, null, 2))
EOF
# Download with --globoff (bracketed filenames break curl globbing):
# curl --globoff -o public/fonts/<name>.woff2 '<url>'
```

### Asset enumeration

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const assets = await page.evaluate(() => {
  const dec = u => { try { const p = new URL(u, location.href); return p.pathname === '/_next/image' ? decodeURIComponent(p.searchParams.get('url')) : u } catch { return u } }
  return {
    imgs: [...new Set(Array.from(document.querySelectorAll('img[src]')).map(i => dec(i.src)))],
    videos: [...new Set(Array.from(document.querySelectorAll('video source, video[src]')).map(v => v.src || v.getAttribute('src')))],
    bgs: [...new Set(Array.from(document.querySelectorAll('*')).map(el => getComputedStyle(el).backgroundImage).filter(b => b.includes('url(')))],
    inlineSvgs: document.querySelectorAll('svg').length,
  }
})
console.log(JSON.stringify(assets, null, 2))
EOF
```

### Full-page reference screenshot (the only trustworthy way)

`page.screenshot({ fullPage: true })` fails on pages taller than 16384 CSS px, so use the tool: one capture when the page fits, otherwise bands stitched into one PNG. Output is CSS-pixel scale.

```bash
ego-browser nodejs <<'EOF'
const { fullPageScreenshot } = await import('/ABSOLUTE/PATH/TO/clone-website/tools/full-page-screenshot.js')
const ROOT = '/ABSOLUTE/PATH/TO/project'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
await page.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('video').forEach(v => v.pause()) })
await page.waitForTimeout(800)
console.log(JSON.stringify(await fullPageScreenshot({ page }, { path: ROOT + '/reference/screenshots/full-page.png' })))
EOF
# then slice per section using outline.json coordinates:
python3 scripts/slice.py reference/screenshots/full-page.png reference/dom/outline.json reference/screenshots/
```

Never screenshot after a programmatic scroll, compositor animation layers drop from the capture (solid-color frames) even though `scrollY` and computed styles read correctly.

### Stateful-bar reset before any measurement

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })  // so the cleared state takes effect
await page.evaluate(() => scrollTo(0, 0))
await page.waitForTimeout(800)
// confirm the bar state before trusting any y coordinate:
console.log(await page.evaluate(() => document.querySelector('BANNER_SELECTOR')?.getBoundingClientRect().height))
EOF
```

If the bar's state is kept in a cookie instead, clear that one origin and nothing wider (it signs the user out of that site, so tell them first):

```js
await page.cdp('Storage.clearDataForOrigin', { origin: new URL(await page.url()).origin, storageTypes: 'cookies' })
```

### Mock content from compiled JS chunks

```bash
# list chunks
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
console.log((await page.evaluate(() =>
  performance.getEntriesByType('resource').map(e => e.name).filter(u => /\/_next\/static\/chunks\/.*\.js/.test(u))
)).join('\n'))
EOF
# download all into reference/js/, then grep for a visible string from the mock:
grep -l 'Daily Client Summary' reference/js/*.js   # the config object next to the hit has the FULL dataset
```

## Phase 2, Motion & interaction reverse

### Runtime animation inventory (ground truth)

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const anims = await page.evaluate(() =>
  document.getAnimations({ subtree: true }).map(a => ({
    target: a.effect?.target?.tagName + '.' + (a.effect?.target?.className?.toString().slice(0, 80) || ''),
    timeline: a.timeline?.constructor?.name,            // ViewTimeline = scroll-driven, DocumentTimeline = time-driven
    range: [a.rangeStart, a.rangeEnd],
    keyframes: a.effect?.getKeyframes?.(),
    inlineVars: a.effect?.target?.getAttribute?.('style'), // per-element params like --parallax-from
  }))
)
console.log(JSON.stringify({ count: anims.length, anims }, null, 2))
EOF
```

### MutationObserver + real wheel scroll (catch JS-triggered effects)

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
await page.evaluate(() => {
  window.__muts = []
  new MutationObserver(ms => ms.forEach(m =>
    window.__muts.push({ t: m.target.tagName, attr: m.attributeName, cls: m.target.className?.toString().slice(0, 80) })
  )).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src'] })
})
// wheel input lands where the pointer is: move it over the page first, in every script
const { w, h } = await page.info()
await page.mouse.move(w / 2, h / 2, { label: 'point at page' })
const pageH = await page.evaluate(() => document.documentElement.scrollHeight)
for (let y = 0; y < pageH; y += 400) {
  await page.mouse.wheel(0, 400, { label: 'scroll to record mutations' })   // real wheel events, not scrollTo
  await page.waitForTimeout(120)
}
const muts = await page.evaluate(() => window.__muts)
console.log(JSON.stringify({ total: muts.length, sample: muts.slice(0, 40) }, null, 2))
// 0 mutations across the whole scroll = the effects are pure CSS (sticky + backgrounds)
EOF
```

### Multi-position state sampling (fixed/sticky state machines)

`tools/sample-scroll-states.js` does this in both directions; the inline form:

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const snap = sel => page.evaluate(s => {
  const el = document.querySelector(s); if (!el) return null
  const walk = n => ({
    tag: n.tagName, cls: n.className?.toString().slice(0, 60),
    rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(n.getBoundingClientRect()),
    style: (c => ({ opacity: c.opacity, radius: c.borderRadius, bg: c.backgroundColor, shadow: c.boxShadow.slice(0, 60), pos: c.position }))(getComputedStyle(n)),
    kids: Array.from(n.children).map(walk),
  })
  return walk(el)
}, sel)

const depths = [0, 500, 1500, 3300, 7000]
const out = {}
for (const y of depths) {
  await page.evaluate(v => scrollTo(0, v), y)
  await page.evaluate(() => window.dispatchEvent(new Event('scroll'))) // scrollTo dispatches no scroll event here
  await page.waitForTimeout(600)
  out[y] = await snap('FIXED_BAR_SELECTOR')
}
console.log(JSON.stringify(out, null, 2))
// diff the snapshots between depths, the differences ARE the interaction spec
EOF
```

Also sample the **reverse direction** (deep → shallow): interactions are often asymmetric or hysteretic.

## Phase 4, Verification

### Same-probe geometry diff (run against BOTH urls, diff the JSON)

The unquoted heredoc lets the shell write `$URL` into the script; ego's Node.js process cannot read shell variables itself.

```bash
for URL in https://original.example http://localhost:3400; do
ego-browser nodejs <<EOF
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('$URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
await page.evaluate(() => { document.querySelectorAll('video').forEach(v => v.pause()); scrollTo(0, 0) })
const data = await page.evaluate(() => {
  const probe = sel => { const el = document.querySelector(sel); if (!el) return null
    const r = el.getBoundingClientRect(), c = getComputedStyle(el)
    return { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height),
             font: c.fontFamily.split(',')[0] + ' ' + c.fontSize + '/' + c.fontWeight,
             color: c.color, bg: c.backgroundColor, radius: c.borderRadius, pad: c.padding } }
  return { title: document.title, pageH: document.body.scrollHeight,
    hero_h1: probe('SECTION1_SELECTOR'), nav: probe('NAV_SELECTOR') /* ...one line per named element */ }
})
console.log(JSON.stringify(data, null, 2))
EOF
done
```

Converge to ±6px per element and <1% total page height error. Check `title` on the clone side first: a leftover dev server on the same port answers convincingly.

### Scroll-interaction assertion (probe-environment-safe)

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('TARGET_URL', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const state = async () => page.evaluate(() => ({
  scrollY, barVisible: !!document.querySelector('FLOATING_BAR')?.checkVisibility(),
  label: document.querySelector('BAR_LABEL')?.textContent ?? null,
}))
const go = async y => { await page.evaluate(v => scrollTo(0, v), y)
  await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await page.waitForTimeout(600) }

const results = {}
for (const y of [0, 60, 1500, 3300, 7000, 1500, 0]) { await go(y); results[`at_${y}_${Object.keys(results).length}`] = await state() }
console.log(JSON.stringify(results, null, 2))
// assert class/content flips, NOT computed animation values, transitions are frozen in this environment
EOF
```

### Animation assertion on the clone

Re-run the Phase 2 animation inventory against `localhost` and assert: same count, same timeline types, matching keyframes. Screenshots cannot verify animations here.

### Mock-content acceptance sweep

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('reverse example.com')
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('http://localhost:3400', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
const report = await page.evaluate(() =>
  Array.from(document.querySelectorAll('MOCK_CARD_SELECTORS')).map(el => ({
    cls: el.className.toString().slice(0, 60),
    textLen: el.innerText.trim().length,
    imgs: el.querySelectorAll('img, svg').length,
  }))
)
console.log(JSON.stringify(report, null, 2))
// any panel with textLen 0 and imgs 0 is a defect until the live original proves otherwise
EOF
```

## Ending the reply

After the output shows the reply's work is done, close the space in a separate last script (keep the clone's Page only when handing it to the user to look at):

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace(SPACE_ID)  // the taskSpaceId printed earlier
console.log(JSON.stringify(await task.finish({ keep: [] })))
EOF
```
