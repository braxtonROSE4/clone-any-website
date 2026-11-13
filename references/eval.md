# Benchmark protocol

The scored eval that replaces "looks close". One command probes both pages with the identical instrument and scores the clone on eight dimensions. The scorecard always measures this skill's output against the original, never the website itself.

Use it as a convergence loop: benchmark, fix the named offenders, re-run, until the pass bar. The score is a completion gate; a clone is not done without a passing scorecard.

## Run it

```bash
bash scripts/run_eval.sh https://original.example http://localhost:3400 ./eval-out <taskSpaceId>
```

The fourth argument is the clone job's task space (numeric id or name); both sides are probed through its first Page. Without it the script opens a space named `clone-website eval` and finishes it after a successful run.

Produces in `./eval-out/`: `original.json` and `clone.json` (probe outputs), `original-full.png` and `clone-full.png` (scroll-0 full-page screenshots, CSS-pixel scale; pages taller than 16384px are captured in bands and stitched), `scorecard.json`, `report.md`. Exit code 0 means pass, 1 fail, 2 a missing prerequisite.

Requirements: `ego-browser` on PATH, `python3`, the clone's dev server running, Pillow installed for the visual dimension (`python3 -m pip install Pillow` for the same `python3` the script finds; without it the visual dimension is skipped and the total rescales). On Windows, run it from Git Bash.

## Measurement conditions, non-negotiable

- **Live originals drift.** Production sites ship new banners, copy, and styles at any time (town.com grew an announcement banner overnight and shifted every y coordinate below it). A score is only meaningful against the original as it was probed that day: keep the `original.json` probe with the run, and never compare a clone against an original probed on a different day. When a regression score drops, first check whether the original moved before blaming the skill or the clone.
- Both probes run through the SAME Page (the probe navigates the one Page it is given rather than opening a per-URL tab): two tabs in one window can have content areas differing by ~16px, which shifts every centered element 8px while `page.info()` still reports equal window sizes. Viewport is recorded from in-page `innerWidth`; the scorer warns and disqualifies geometry when widths differ over 2%.
- The probe resets `localStorage`/`sessionStorage` and reloads, so stateful announcement bars measure in a deterministic state on both sides.
- Videos are frozen and both screenshots are taken at scroll position 0; no post-scroll captures anywhere in the eval.
- Infinite time-driven animations are phase-normalized by the probe on both sides before sampling: GSAP `repeat:-1` tweens are killed and their targets' transforms cleared (`clearProps: 'transform'` lands both sides on the natural CSS position whether or not animation init ran — JS animation setup hangs off `window load + rAF`, which in background tabs fires at an arbitrary time or never, differently per side; `progress(0)` fails because motion-path tweens start distributed along the path), infinite Web Animations set to `currentTime = 0`, looped carousel tracks anchored at their first real slide (not `translateX(0)` — loop mode prepends clone slides). Without this, marquee/motion-path/autoscroll elements sample at a random loop phase per side and geometry reports probe-timing jitter as position error (measured 50-2879px on wisprflow.ai). The probe waits for two consecutive identical pageH readings instead of a fixed settle, and the normalization re-runs synchronously at the top of the sampling evaluate so setup firing after page load cannot slip in between. CSSTransitions are excluded from the animation census; their count is sampling-moment noise.
- Never hand-edit probe JSON. If a number looks wrong, re-run the probe.

## Dimensions

| Dimension | Weight | Threshold | What it measures |
|---|---|---|---|
| geometry | 25 | 85 | Sampled elements (matched by section index + tag + text/asset key) within 6px on every axis, plus total page height within 1% |
| typography | 15 | 85 | Font family, size, and weight exact-match rate on matched elements |
| color | 10 | 80 | Text color and background exact-match rate on matched elements |
| assets | 10 | 90 | Original's image/video filenames present in the clone |
| fonts | 10 | 90 | Original's loaded font families loaded in the clone (`document.fonts`, loaded status only) |
| animations | 15 | 80 | Animation count ratio, timeline-type distribution overlap (ViewTimeline vs DocumentTimeline), and keyframe property-set matching |
| content | 5 | 85 | Per-section text length and media count at 70%+ of the original's density; catches empty mock panels |
| visual | 10 | 75 | 24 horizontal bands of the grayscale fullPage screenshots, mean absolute pixel difference within 12 per band |

**Pass bar: total at or above 90 with no dimension below its threshold.** Report numbers and named offenders only; no tier labels.

## Reading the report

`report.md` lists the dimensions sorted by how far below threshold they are, with the top offenders per dimension: element keys for geometry/typography/color, filenames for assets/fonts, section indexes for content, band indexes (top to bottom) for visual. Each offender names the exact thing to fix; fix, hot-reload, re-run.

## What the scorer cannot see

The eval is necessary but not sufficient. These stay manual, verified by probe before declaring done:

- Scroll-interaction state machines (floating bars, collapsing headers): assert with `tools/sample-scroll-states.js` at 4+ depths in both directions against the recorded original behavior.
- Entrance stagger ordering (`animation-delay` values).
- Hover/click states, form behavior, carousel timing.
- Anything the user reports from a real browser pass; the user watching the real page outranks every number here.

