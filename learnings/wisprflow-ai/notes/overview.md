# wisprflow.ai — clone notes (2026-08-02)

Homepage cloned to 99.9/100 (phase-normalized) / 96.4 (canonical).

## Site profile

- Webflow site, single stylesheet `flowsite-dev.webflow.shared.<hash>.min.css` (582KB), assets on `cdn.prod.website-files.com/682f84b3838c89f8ff7667db/` plus TWO other shared Webflow folders (`682fa127...`, `6838259b...`) for app icons — a single-folder URL rewrite misses ~120 images; rewrite any `cdn.prod.website-files.com/<hex>/` by basename.
- Fonts: Figtree (400/500/600/700), EB Garamond (400 + italic), plus Monaspace Neon / Inter / IBM Plex Mono declared in CSS for other pages.
- Desktop layout: 17 sections, docH 11162px at 1470×862 (2026-08-02); 17099px at 1332×800 on 2026-11-13, past the 16384px single-capture limit, so screenshots go through `tools/full-page-screenshot.js` bands.

## Animation stack (all source captured verbatim — no guessing needed)

- GSAP 3.15 + ScrollTrigger/DrawSVG/MotionPath/SplitText/ScrollTo, loaded from `cdn.prod.website-files.com/gsap/3.15.0/`. ALL custom animation code is inline `<script>` in the HTML: nav hide (mobile), button char-wave hover (SplitText), 100 CTA dots on `#curve-cta` motion path, chips scrub, features/testimonials drawSVG scrub, `#heading-underline` draw-once-lock, curved-text marquee on `#curve-flag`, 43 icons circulating `#icon-path-web` (60s loop).
- Splide 4.1 + auto-scroll 0.45 for testimonials; clients logo marquee is pure CSS `logoTicker1` 60s (defined in a w-embed `<style>`).
- 6 `.lottie` (dotlottie) files played by the Webflow runtime via `data-animation-type="lottie"` — self-hosting webflow.schunk.*.js makes them play with zero extra work.
- No CSS scroll-driven animations; only `@keyframes spin` + `logoTicker1`.

## Gotchas hit

1. **SRI kills rewritten CSS silently.** The stylesheet `<link>` carries `integrity="sha384-..."`; after URL-rewriting the CSS the hash mismatches and the browser refuses to apply it — page renders unstyled (docH exploded 9×, `document.fonts` empty) with NO console-visible failure in the probe. Strip `integrity`/`crossorigin` from any rewritten resource tag.
2. **Port check before serving.** 3400 was still held by an old town.com clone's Next dev server; `curl localhost:3400` looked plausible and the probe happily measured the wrong app. Always `lsof -iTCP:<port>` or verify `document.title` before probing a clone.
3. **The head `cta-verb-test` inline script is functional, not tracking.** It mentions PostHog (feature-flag read, 2.5s timeout fallback) so keyword-based tracking sweeps kill it — but it owns the download buttons' OS-detection text/icon swap ("Download for free" → "Download for macOS"). Whitelist it; without it the CTA never matches the original.
4. **Keep stripped: `web_onboarding_canary`** (5% Math.random redirect experiment → nondeterminism) and the `pixel.gif` beacon (costs 0.7 on the assets dimension; accepted).
5. **Moving elements fail canonical geometry by phase, not fidelity.** The icon-path icons (up to 2879px) and Splide avatars (50px) sample at random loop phases per side. Root cause is deeper than phase: animation init hangs off `window load + rAF`, and in background tabs the load event fires at an arbitrary time or never (observed 60s+ without firing on the localhost clone), so one side can have running tweens while the other has none. The fix that survived (canonical probe since 2.1.0): kill GSAP `repeat:-1` tweens + `clearProps:'transform'` on their targets (both sides land on the natural CSS position whether or not init ran; `progress(0)` fails because motion-path tweens start distributed along the path, `revert()` alone fails when init hasn't run), infinite Web Animations → `currentTime=0; pause()`, Splide track → `translateX(-firstRealSlide.offsetLeft)` (NOT 0 — loop mode prepends clones), layout-stability wait (two identical consecutive pageH reads) instead of fixed settle, and re-run the normalization synchronously at the top of the sampling evaluate.
6. **Same tab for both probe sides, and trust in-page `innerWidth`, not `page.info()`.** Per-URL tabs in the same window measured 1470 vs 1454 innerWidth (page.info reported both as 1470×862): every centered element shifts a uniform 8px in x and geometry drowns in false offsets. The probe now navigates one Page for both URLs.
7. **CSSTransitions are census noise.** One probe caught the clone with 22 running transitions vs the original's 4 (sampling-moment style churn) and failed the animations dimension; the probe now excludes `CSSTransition` instances from the animation count.
8. Multiple `@tanay-wispr/webflow-package` versions load simultaneously (6.5.5→6.6.1) plus a dead `localhost:3000/global.js` dev leftover (drop it).
