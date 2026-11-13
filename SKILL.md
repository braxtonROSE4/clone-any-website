---
name: clone-website
description: Reverse-engineer and pixel-perfect clone any live website, a single landing page or an entire site. Captures DOM, CSS design tokens, assets, fonts, and compiled-JS config data from the live page, reverse-engineers scroll animations and stateful interactions, rebuilds (raw-HTML mirror for static-export sites like Webflow/Framer, Next.js components for JS-framework sites), then proves fidelity with a scored benchmark (same-probe geometry diff, asset/font/animation coverage, screenshot slicing). Use this skill whenever the user wants to clone, replicate, rebuild, or reverse-engineer a website's design or behavior. Triggers include "clone this website", "reverse this landing page", "rebuild this page pixel-perfect", "copy this site's design", "how does this site do that scroll effect", "复刻网站", "复刻落地页", "1:1 复刻", "逆向这个网站". Prefer this skill over ad-hoc screenshot-and-eyeball cloning. Not for general browser automation, scraping, or screenshots (use ego-browser directly), capturing article content into notes, SEO/content audits, or building a new design merely inspired by a site; load it only when the goal is faithful reproduction or understanding a site's implementation. Runs on the ego lite browser via the ego-browser skill; when the ego-browser CLI is not installed, guide the user through installing ego lite first (references/install.md) instead of substituting another automation tool.
metadata:
  version: "2.2.0"
  date: "2026-11-13"
  battle-tested-on: "arc.net, town.com (2026-08-01), wisprflow.ai (2026-08-02, re-verified 2026-11-13)"
  tested-with: "ego lite 0.6.3.12, ego-browser usage guide v2.2.1"
---

# clone-website

Clone any live website 1:1 (layout, typography, assets, scroll animations, stateful interactions) from nothing but its URL, and prove the fidelity with a scored benchmark instead of claiming it.

## Runtime dependency and bootstrap

Every live-page operation runs as `ego-browser nodejs <<'EOF' ... EOF` in Bash. The script runs in ego lite's Node.js runtime, which exposes `taskSpace()` and the TaskSpace/Page API; there are no preloaded `page`, `browser`, or `taskSpaces` globals, and older scripts that assume them fail with `taskSpaces is not defined`.

The runtime is not interchangeable, because the method depends on it three ways. The pixel-level loop needs the identical probe running in the identical runtime on original and clone, or the diff numbers mean nothing. The correction loop needs task spaces: the agent probes in its own isolated spaces while the user simultaneously browses the original and the clone in theirs, takes over any space for a visual check, and hands it back, without either side competing for the browser. And every probe script and caveat in this skill is calibrated against this runtime's measured behavior. This is why a missing runtime routes to installing ego lite rather than to a substitute.

1. **Before Phase 0, run `ego-browser skill` once and follow its output.** It prints the usage guide for the installed ego lite version. Its browser-mechanics rules (task spaces, Page labels, finishing a reply, user control) win over anything here; this skill's rules win for the cloning workflow. If the output lacks the final `[ego-browser:skill] end of guide` line it was truncated: save it to a file and read it in parts.
2. **`ego-browser: command not found`: do not improvise.** Stop, read `references/install.md`, and walk the user through installing ego lite (macOS: `scripts/install-ego-browser.sh`; Windows: the installer from https://lite.ego.app/), then the user finishes onboarding in the app, which registers the CLI. Wait for their confirmation, verify with `command -v ego-browser`, then resume. Never fall back to Playwright, another browser, WebFetch, or any other automation path; probe results from a different runtime are not comparable and the skill's environment caveats no longer hold.
3. **`Unknown command: skill`: ego lite is older than these scripts.** Ask the user, run `ego-browser upgrade`, then `ego-browser skill` again.
4. On Windows, run everything from Git Bash: the heredocs, `bash scripts/run_eval.sh`, and `python3` assume a POSIX shell.
5. After the first successful command, assume the runtime is ready for the rest of the session; investigate only when a real command errors.

The method in one sentence: treat the live site as ground truth you can query, not a picture you eyeball. Pull the real DOM, real CSS tokens, real keyframes, real fonts, and real config data out of the running page, rebuild from those facts, then run the same measurement probe on original and clone and diff the numbers until they converge.

File map: copy-paste probe scripts in `references/probes.md`; benchmark protocol in `references/eval.md`; ego lite install guide in `references/install.md` (macOS installer vendored at `scripts/install-ego-browser.sh`); tool/function design template in `references/tool-design-template.md`; canonical tool implementations in `tools/` (registered in `tools/manifest.json`, including `full-page-screenshot.js` for pages past Chromium's 16384px capture limit); scorer in `scripts/eval_score.py`; screenshot slicer in `scripts/slice.py`.

## Execution model

- **One task space and one Page for the whole job.** A new job opens its space with `taskSpace('reverse <site>')`; a job continued from an earlier reply finds its space in `listTaskSpaces()` and resumes it by ownership, as the `ego-browser skill` guide's start-of-reply rule says (`taskSpace(id)`, `claimTaskSpace(id)`, or `takeOverTaskSpace(id)`). Print `task.spaceId` and use `taskSpace(<id>)` in every later script. Work in the space's first Page, `(await task.pages())[0]`, for both original and clone: one Page means one viewport. Never open another space to recover from a stuck Page; reload it, or use `task.newPage()` in the same space.
- **End each reply's browser work with one `finish()`**, in its own last script, after earlier output shows the work is done: `await task.finish({ keep: [] })`. Keep a Page only when the user should look at it, such as the clone handed over for the real-browser pass: `finish({ keep: [page.label] })`. If the user takes control of the space, stop, report state, and wait; resume with `takeOverTaskSpace(<id>)` only after they confirm, and do not call `finish()`.
- **Batch by phase, not by action.** One heredoc should finish an entire probe (open, freeze videos, measure at every depth, print). Split invocations only at real boundaries: shell work between browser work (curl downloads, greps, Python), user confirmation, or visual inspection of a saved image.
- **Artifacts to files, summaries to stdout.** Every probe writes its full JSON/HTML into `reference/`, and `console.log`s only counts and paths. Never dump a full DOM, CSS file, or geometry table into the conversation.
- **Every probe script is self-contained.** Space selection and `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })` at the top, every time; task spaces and Page labels persist across heredocs, JavaScript variables do not.
- **Absolute paths only inside heredocs, no shell variables.** ego's Node.js process inherits neither the shell's cwd nor its environment: relative `fs.writeFileSync` paths ENOENT and `process.env` lacks your exports. Define a `ROOT` constant at the top of every script, or use an unquoted heredoc (`<<EOF`) so the shell writes values into the script text.
- **The API is ego-browser's own, not Playwright.** Use the TaskSpace and Page methods the guide lists (`help("page.screenshot")` prints exact options); for anything else use `page.evaluate()` or `page.cdp()`. Real wheel input needs the pointer over the scroll area first in every script: `page.mouse.move(x, y)`, then `page.mouse.wheel(0, dy)`.

## Quick start: recon bootstrap

One invocation captures the ground truth a rebuild starts from. Adapt URL and paths; the composite shape is the point.

```bash
mkdir -p reference/{dom,css,js,screenshots} && ego-browser nodejs <<'EOF'
const fs = await import('node:fs')
const ROOT = '/abs/path/to/project'  // ego's Node.js process does not inherit the shell cwd
const { fullPageScreenshot } = await import('/abs/path/to/clone-website/tools/full-page-screenshot.js')
const task = await taskSpace('reverse example.com')  // later scripts: taskSpace(<the printed spaceId>)
const page = (await task.pages())[0] ?? (await task.newPage())
await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})  // load can fire late or never

// Freeze autoplay videos FIRST: they saturate the render thread and later evaluates time out.
await page.evaluate(() => {
  const freeze = () => document.querySelectorAll('video').forEach(v => v.pause())
  freeze(); setInterval(freeze, 400)
})

// Guard the viewport: w/h of 0 silently produces empty screenshots and rect garbage.
const info = await page.info()
if (!info.w || !info.h) throw new Error('Viewport is 0, restore the real tab before recon: ' + JSON.stringify(info))

const facts = await page.evaluate(() => ({
  html: document.documentElement.outerHTML,
  outline: Array.from(document.querySelectorAll('body section, body header, body footer, body main > div'))
    .map(el => { const r = el.getBoundingClientRect(); return {
      tag: el.tagName, cls: (el.className?.toString() || '').slice(0, 120),
      y: Math.round(r.top + scrollY), h: Math.round(r.height), w: Math.round(r.width) } })
    .filter(s => s.h > 40).sort((a, b) => a.y - b.y),
  cssUrls: performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.css(\?|$)/.test(u)),
  fontFiles: performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.(woff2?|ttf|otf)(\?|$)/.test(u)),
  jsChunks: performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.js(\?|$)/.test(u)),
}))
fs.writeFileSync(ROOT + '/reference/dom/full-page.html', facts.html)
fs.writeFileSync(ROOT + '/reference/dom/outline.json', JSON.stringify(facts.outline, null, 2))
fs.writeFileSync(ROOT + '/reference/urls.json', JSON.stringify({ css: facts.cssUrls, fonts: facts.fontFiles, js: facts.jsChunks }, null, 2))

await page.evaluate(() => scrollTo(0, 0))
await page.waitForTimeout(800)
// One capture up to 16384px tall; longer pages are captured in bands and stitched.
await fullPageScreenshot({ page }, { path: ROOT + '/reference/screenshots/original-full.png' })

console.log(JSON.stringify({ taskSpaceId: task.spaceId, sections: facts.outline.length, cssFiles: facts.cssUrls.length,
  fontFiles: facts.fontFiles.length, jsChunks: facts.jsChunks.length, htmlKB: Math.round(facts.html.length / 1024) }))
EOF
```

Then shell work: curl every CSS/font/JS URL into `reference/`, and slice the screenshot per section with `python3 scripts/slice.py reference/screenshots/original-full.png reference/dom/outline.json reference/screenshots/original/`.

## Workflow

### Phase 0, setup

Project directory with `reference/{dom,css,js,screenshots}/` for recon artifacts (never shipped, excluded from any repo push); dev server on a fixed port in the background so the user can review continuously. Scaffold Next.js manually when `public/` already holds downloaded assets; `create-next-app` overwrites the directory.

Before serving, `lsof -iTCP:<port> -sTCP:LISTEN` (a leftover server from a previous clone job answers convincingly on your port), and before any probe of the clone, assert `document.title` matches; a plausible curl response is not proof the browser tab shows your page.

### Phase 1, static capture

Run the recon bootstrap, then fill the gaps (full scripts in `references/probes.md`):

- **Design tokens**: grep the downloaded CSS for `--brand-*`, `--font-size-*`, `--color-*`, spacing scales. Read sizes and colors from tokens, never estimate them from screenshots. A token you expect but cannot find is usually in a different CSS file; grep all of them before concluding it does not exist.
- **Fonts**: `@font-face` is often injected by JS at runtime, so grepping saved HTML proves nothing. On the live page combine three sources: `performance.getEntriesByType('resource')` filtered to font extensions, `document.fonts` for family/weight/status, and a `document.styleSheets` walk for `CSSFontFaceRule` to map family to weight to src. Download with `curl --globoff` (bracketed filenames break curl globbing). Self-host in `public/fonts/`.
- **Assets**: enumerate `img[src]`, `srcset`, `video src`, background-image URLs, inline SVGs. Decode `/_next/image?url=...` back to original paths. Mirror original paths under `public/`. Extract inline SVGs verbatim, do not redraw them.
- **Mock/product-UI content**: dashboards, editors, and card panels get their content from config objects in compiled JS chunks. Grep the downloaded chunks for a visible string; the config object beside the hit holds the complete dataset (all carousel variants, all rows), far more reliable than screenshots that miss lazy-loaded state.

Reference screenshots follow the Correctness rules below: one fullPage capture at scroll 0 sliced per section with `scripts/slice.py`, videos frozen first, stateful bars reset first.

### Phase 2, motion and interaction reverse

Work cheapest-first; stop as soon as the effect is explained:

1. **CSS static analysis** (free, already downloaded): grep for `animation-timeline|view-timeline|scroll-timeline|@keyframes`. A hit on `animation-timeline: view()` means native CSS scroll-driven animations: copy keyframes and ranges verbatim, no JS needed.
2. **Runtime inventory**: `document.getAnimations({ subtree: true })`, the ground truth. Per animation: `effect.getKeyframes()`, `timeline.constructor.name` (`ViewTimeline` is scroll-driven, `DocumentTimeline` is time-driven), `rangeStart/rangeEnd`, target element. Per-element parameters like `--parallax-from: 6%` live on inline styles.
3. **MutationObserver plus real wheel scroll** for JS-triggered effects: `attributeFilter: ['class','style','src']`, scroll the full page with `page.mouse.wheel`, log mutations. Zero class mutations across a full scroll proves the effects are pure CSS, which massively simplifies the rebuild.
4. **Multi-depth state sampling** for fixed/sticky state machines (floating input bars, collapsing headers): snapshot the element's entire subtree (every child's rect, opacity, radius, background, shadow) at several scroll depths in both directions, then diff snapshots between states. Position-only checks miss shape-shifting; the state transition is the interaction.

### Phase 3, rebuild

**Pick the rebuild route by site type first.** Static-export sites (Webflow, Framer: `data-wf-site` attribute, `website-files.com`/`framerusercontent.com` CDN) clone with highest fidelity as a raw-HTML mirror, not a component rebuild: curl the pre-hydration server HTML as the skeleton (the captured live DOM is already hydrated — carousel clones inserted, SplitText chars split — and double-initializes when scripts re-run), rewrite every CDN URL to self-hosted copies, strip analytics/consent scripts, keep functional runtime (site JS, GSAP, carousel libs) self-hosted. Four rules for that route:

- Assets may span multiple CDN folders (shared media libraries); rewrite any `cdn-host/<folder>/<file>` by basename, not by the site's main folder prefix.
- Strip `integrity`/`crossorigin` from every rewritten resource tag: the SRI hash was computed against the original bytes, and the browser rejects the modified file silently — the symptom is an unstyled page (document height explodes, `document.fonts` empty) with no probe-visible error.
- Tracking-script removal by keyword blocklist kills functional scripts that merely mention an analytics API with graceful fallback (a head script owning the download buttons' OS-detection text swap referenced PostHog); audit the dropped-scripts list and whitelist the functional ones.
- Nondeterministic experiment scripts (`Math.random()` traffic splits, redirect canaries) stay stripped even though they are functional; they make benchmark runs unrepeatable.

For JS-framework sites (Next.js, Remix — hydration mismatch makes a mirror infeasible), rebuild componentwise:

- One component per top-level section, named after the section's business content.
- Tokens from Phase 1 go into `globals.css` as-is; fonts self-hosted with the real weight mapping.
- Mirror the original's DOM mounting strategy, not just what is visible: originals keep all carousel frames, rotation variants, and avatar walls mounted (hidden), while a conditional-render clone shows the same pixels with a fraction of the elements, then fails per-section media counts in the benchmark. Match element counts per section against the original's DOM, not against its screenshot.
- **Replicate the original's container hierarchy, not just its visuals.** `sticky` scopes to its parent: a nav that must survive to the footer needs a page-spanning parent; a curtain-reveal panel needs a parent that starts where the effect starts, or it pins from screen one. When a section breaks after restructuring, suspect a sticky or stacking-context scope change first.
- Viewport-fixed elements (floating chat bars) are body-level fixed containers in well-built originals: use a React portal, never `absolute` inside a section.
- Collapsing headers that change document height fight Chrome scroll anchoring and jitter. Robust architecture: a constant-height placeholder in the flow (document height never changes) with the inner header switching to `fixed` plus a slide-in animation once fully scrolled out. If height must animate, add `overflow-anchor: none` and hysteresis between collapse and expand thresholds.
- Decorative toothed edges (scallop/stamp borders): solid-side SVG flipped toward the gap with 1px overlap into the neighbor block; butt-joined toothed edges leak a row of background pixels that reads as a white seam. SVG masks need `preserveAspectRatio="none"`; the default renders the mask at intrinsic width only and silently crops the sides regardless of `mask-size`.
- Media assets bake in their own margins (videos with white matte, PNGs with transparent padding and shadow), so element rects legitimately disagree with visual positions. Position by visual anchor (negative margins like the original), not rect arithmetic.
- Plain scroll listeners, never `requestAnimationFrame` throttling: in background/agent environments rAF does not run and the state machine never updates.
- Flex children need `min-w-0` for `truncate` to work; the classic cause of mock-card text overflow.

### Phase 4, verify then benchmark

Iterate with the probes until convergence, then run the scored benchmark (`references/eval.md`):

```bash
bash scripts/run_eval.sh https://original.example http://localhost:3400 ./eval-out <taskSpaceId>
```

Pass the job's task space id so both sides are probed through its Page; without it the script opens and finishes a space of its own. The benchmark emits `scorecard.json` and `report.md` with per-dimension scores (geometry, typography, color, assets, fonts, animations, mock content, visual similarity) against fixed thresholds. **Do not declare the clone done below a 90 total or with any failing dimension**; fix and re-run. The scorecard is the deliverable that replaces "looks close".

Acceptance additions the scorer cannot see, verify by probe:
- Every product-UI mock container individually inspected for internal content. A blank panel is a defect until the live original proves it is blank; reference screenshots miss lazy-loaded content, and matching a defective reference means you cloned the bug.
- Nav/header present and correct at maximum scroll depth.
- Stateful bars: full cycle (expand, collapse, re-expand at top), no jitter.
- Fixed/floating elements verified at 4+ scroll depths including both direction reversals.
- Entrance stagger: probe `animation-delay` values and confirm ordering.

Then hand to the user for a real-browser pass. The user watching the real page is the final ground truth; treat every correction as a new sampling task, not a debate.

### Phase 5, whole-site mode

1. Collect internal URLs: crawl nav/footer links plus `/sitemap.xml`, dedupe to a page list.
2. Recon the shared shell once (header, footer, fonts, tokens) into `reference/_shared/`.
3. Per page: capture into `reference/<page-slug>/`, build as a route reusing shared components, benchmark with the same eval, one scorecard per page.
4. Priority order: homepage, then top-nav pages, then the rest. Recon cost collapses after page one.

### Phase 6, publishing

- Exclude all of `reference/` from the repo (scraped DOM/CSS/JS is not yours to publish); README carries attribution ("for learning/study purposes; original design, copy, imagery and fonts belong to <owner>").
- **Warn before any public push**: commercial font files and downloaded imagery/video become redistribution when public; fonts are the realistic DMCA vector. Offer open-source near-matches or gitignore `public/fonts/`. "Non-commercial" is not a shield when the post or repo promotes a product.

## Correctness rules

- Never screenshot after a programmatic scroll. With scroll-driven animations, compositor layers drop from CDP captures (solid-color frames); even without them, post-scroll viewport captures show body-background voids while `scrollY` reads correctly. All layout evidence comes from one fullPage screenshot at scroll position 0, sliced by DOM rect coordinates.
- Pause all videos before any evaluate-heavy work and re-freeze on an interval; React pages restart playback. Need a real frame, set `v.currentTime = 3`.
- Neutralize stateful UI before measuring: clear `localStorage`/`sessionStorage`, reload, return to top, confirm the bar state. A dismissible banner in a different state shifts every y coordinate on the page (495px on arc.net) and invalidates a whole measurement run. When the state lives in a cookie, clear only that origin, `page.cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies' })`, and tell the user first: it signs them out of that site. Never run `Network.clearBrowserCookies`, `Network.clearBrowserCache`, or `Storage.clearCookies`: the task space shares the user's browser profile and those wipe every site's login, with no way back.
- Scroll interactions are asserted by dispatching `window.scrollTo(...)` then `window.dispatchEvent(new Event('scroll'))`, checking class/content flips in both directions. Never assert computed animation values mid-transition; transitions are frozen in the probe environment.
- Animations are asserted with `getAnimations()` counts, timeline types, and keyframes, never with screenshots.
- Duplicate headings in the DOM are usually responsive variants (`md:hidden` / `hidden md:block`), not animation clones; the semantic heading may be `sr-only`.
- Before concluding an interaction does not exist, remember the probe environment may be unable to fire it (see Caveats). Ask the user for a screenshot, or grep compiled JS for hidden-state DOM (opacity-0 or scaled layers).
- `elementFromPoint` and computed styles cannot detect CSS `mask` effects; verify masks by pixel-sampling a screenshot.
- Check `page.info()` for `w: 0` or `h: 0` before any screenshot or coordinate work; stop and restore the real tab first.
- Run the identical probe script on original and clone in the same viewport; numbers from different probes or viewports are not comparable.

## Caveats: probe environment behavior

| Symptom in the probe environment | Cause | What to do |
|---|---|---|
| Scroll-triggered JS never fires, interaction "does not exist" | A programmatic `scrollTo()` in an agent task space dispatches no `scroll` event (measured 0); real wheel input does | Drive the state machine with manual `dispatchEvent(new Event('scroll'))`, or `page.mouse.move` then `page.mouse.wheel`; confirm existence via user screenshot or compiled JS |
| Clone state machine never updates during verification | `requestAnimationFrame` barely runs in an agent space without input (measured 3 callbacks in 1s idle) | Write the clone with plain scroll listeners; assert state flips, not animation values |
| Element styles look mid-transition or stale | CSS transitions are frozen (a 2s transition had not moved after 1s) | Assert classes and content, wait 600ms after dispatch before reading |
| `IntersectionObserver` reveal never fires after scrolling | IO fires on a fresh Page once the element is in view and the page idles ~1.5s, but a Page reloaded or probed many times can stop delivering callbacks | A/B on a fresh Page on both sides (`task.newPage()`, close it after) before calling it a defect; force reveal-pending elements visible via evaluate before screenshots |
| Screenshot is a solid color after scrolling | Compositor animation layers drop from CDP capture | fullPage at scroll 0, slice with `scripts/slice.py` |
| Full-page capture fails with "Unable to capture screenshot" | Chromium caps one capture at 16384 CSS px tall | `tools/full-page-screenshot.js` captures bands and stitches them; a band keeps `fullPage: true` next to `clip`, since a clip-only capture paints nothing below the viewport |
| Screenshot fails with `EGO_PAGE_UNRESPONSIVE` on a WebGL or three.js page | The render loop saturates the GPU | Retry once; set `window.requestAnimationFrame = () => 0` before capture and restore it after; judge a WebGL hero by signals, not pixels: WebGL context non-null, `canvas.width/height` not the 300x150 default, scene resources loaded |
| All evaluates time out on a media-heavy page | Autoplay videos saturate the render thread | Freeze videos immediately after load, re-freeze on interval |

## Extending the skill

- New reusable probes become typed tools in `tools/` with an entry in `tools/manifest.json` (description, callable, args with types and required flags, returns). Follow `references/tool-design-template.md` for the design rules; it is the same schema ego-browser uses for its per-site learnings tools.
- Site-specific discoveries (selectors, quirks, config-object locations) go into `learnings/<site>/notes/overview.md` so the next clone of that site starts warm. `learnings/arc-net/` and `learnings/town-com/` are the reference examples.
