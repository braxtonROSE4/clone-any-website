# clone-website

[中文版](README.zh-CN.md)

An agent skill that clones any live website 1:1 (layout, typography, assets, scroll animations, stateful interactions) from nothing but its URL, and proves the fidelity with a scored benchmark instead of claiming it.

The method in one sentence: treat the live site as ground truth you can query, not a picture you eyeball. Pull the real DOM, real CSS tokens, real keyframes, real fonts, and real config data out of the running page, rebuild from those facts, then run the same measurement probe on original and clone and diff the numbers until they converge.

Plain Agent Skills package: a `SKILL.md` plus `references/`, `scripts/`, and `tools/`, with no agent-specific code. It runs on Claude Code, Codex CLI, Cursor, Gemini CLI, opencode, and anything else that reads the standard.

Battle-tested on arc.net, town.com, wisprflow.ai, landonorris.com, creativemarketing.peachweb.io.

## Install

One line, any agent:

```bash
curl -fsSL https://raw.githubusercontent.com/braxtonROSE4/clone-any-website/main/install.sh | sh
```

That installs one copy into `~/.agents/skills/clone-website` (the vendor-neutral location Cursor, Gemini CLI, and opencode read directly) and symlinks it into `~/.claude/skills/` and `~/.codex/skills/` when those exist, so `git pull` updates every agent at once. Re-run the same command to update. `--project [dir]` installs into `<dir>/.agents/skills/` for one project instead of the whole machine.

Manual install works just as well, since the payload is only files:

| Agent | Where to clone it |
|-------|-------------------|
| Claude Code | `~/.claude/skills/clone-website` |
| Codex CLI | `~/.codex/skills/clone-website` (or `$CODEX_HOME/skills/`) |
| Cursor | `~/.cursor/skills/clone-website`, or `~/.agents/skills/clone-website` |
| Gemini CLI | `~/.gemini/skills/clone-website`, or `~/.agents/skills/clone-website` |
| opencode | `~/.config/opencode/skills/clone-website` (it also reads `~/.claude/skills` and `~/.agents/skills`) |
| Anything that can read files and run shell commands | Clone anywhere, point the agent at `SKILL.md` |

```bash
git clone https://github.com/braxtonROSE4/clone-any-website.git ~/.agents/skills/clone-website
```

The destination folder has to be named `clone-website`: agents take the skill name from the folder and require it to match the `name` in the frontmatter. Project-scoped installs use the same layout under a repo, in `.agents/skills/`, `.claude/skills/`, `.codex/skills/`, or `.cursor/skills/`.

Once installed the skill loads on its own when you ask for a clone. Trigger phrases include "clone this website", "rebuild this landing page pixel-perfect", "how does this site do that scroll effect".

## Runtime dependency

Every live-page operation runs as `ego-browser nodejs <<'EOF' ... EOF` against ego lite's TaskSpace/Page API (`taskSpace()`, `task.pages()`, `page.goto()`, `page.evaluate()`, `task.finish()`). Before a job the agent runs `ego-browser skill`, which prints the usage guide for the installed ego lite version. Tested with ego lite 0.6.3.12 and usage guide v2.2.1; an older ego lite that answers `Unknown command: skill` needs `ego-browser upgrade`.

ego lite is at https://lite.ego.app/ for macOS and Windows. On macOS `scripts/install-ego-browser.sh` downloads and installs it; on Windows you run the installer from the site and use Git Bash for this skill's scripts. Then you finish first-run onboarding in the app, which registers the `ego-browser` CLI.

The runtime is not swappable for Playwright or a plain headless Chrome, and the skill is written to refuse the substitution. Three reasons: the pixel-level loop needs the identical probe in the identical runtime on both sides or the diff numbers mean nothing; the correction loop needs task spaces, so the agent probes in its own isolated space while you browse the original and the clone in yours without either side stealing the browser; and every probe script and environment caveat in this skill is calibrated against this runtime's measured behavior.

## What the workflow does

| Phase | What it does |
|-------|--------------|
| Phase 0, setup | Create `reference/{dom,css,js,screenshots}/` for recon artifacts, run the dev server on a fixed port in the background. Before probing the clone, assert `document.title` matches: a plausible curl response is not proof the browser tab shows your page |
| Phase 1, static capture | One invocation grabs the DOM, the section outline, the CSS/font/JS resource lists, and a scroll-0 fullPage screenshot. Design tokens come from grepping the downloaded CSS, never from estimating off screenshots. `@font-face` is often injected by JS at runtime, so fonts have to be read off the live page via `document.fonts` plus a `document.styleSheets` walk. Product-UI mock content comes from config objects inside the compiled JS chunks |
| Phase 2, motion reverse | Cheapest first: grep the CSS for `animation-timeline`, then `getAnimations({subtree:true})` for keyframes and timeline types, then MutationObserver with a real wheel scroll, and finally multi-depth two-direction sampling for sticky state machines |
| Phase 3, rebuild | Route chosen by site type. Static-export sites (Webflow, Framer) clone as a raw-HTML mirror built on the pre-hydration server HTML; JS-framework sites (Next.js, Remix) get rebuilt section by section as components |
| Phase 4, verify and benchmark | Iterate with the probes until convergence, then run the scored eval. Eight dimensions against fixed thresholds; below 90 total or with any failing dimension, the clone is not done |
| Phase 5, whole-site mode | Crawl nav/footer links plus the sitemap for a page list, recon the shared shell once, then clone and score page by page |
| Phase 6, publishing | Everything under `reference/` stays out of the repo, the README carries attribution, and any public push gets a warning about redistributing commercial fonts and downloaded media |

## The benchmark

```bash
bash scripts/run_eval.sh https://original.example http://localhost:3400 ./eval-out [taskSpaceId]
```

The same probe runs against the original and the clone, producing `scorecard.json` and `report.md` scored on eight dimensions: geometry, typography, color, assets, fonts, animations, mock content, visual similarity. Exit code 0 means pass. Requires `ego-browser` on PATH, `python3`, the clone's dev server running, and Pillow installed (without it the visual dimension is skipped and the total rescales). Pages taller than Chromium's 16384px capture limit are screenshotted in bands and stitched, so long landing pages score on the visual dimension too.

Two measurement rules are baked into the protocol. Live originals drift, so a score is only meaningful against the `original.json` probed that same day; when a regression score drops, check whether the original moved before blaming the clone. And infinite time-driven animations (GSAP `repeat:-1`, marquees, auto-scrolling carousels) must be phase-normalized before sampling, or each side lands on a random loop phase and probe-timing jitter gets reported as position error (measured at 50-2879px on wisprflow.ai).

## Repo layout

| Path | What's in it |
|------|--------------|
| `SKILL.md` | The main workflow: execution-model discipline, the six phases, falsifiable correctness rules, and a caveats table for probe-environment behavior |
| `install.sh` | Cross-agent installer: one copy in `~/.agents/skills/`, symlinked into the agents present on the machine |
| `references/probes.md` | Copy-paste ego-browser probe scripts for each phase; swap the URL and run |
| `references/eval.md` | Benchmark protocol: the eight dimensions, their algorithms, thresholds, and measurement conditions |
| `references/install.md` | ego lite install guide |
| `references/tool-design-template.md` | Design template for adding new tools to `tools/` |
| `tools/` | Typed tool layer; `manifest.json` registers capture_static, full_page_screenshot, inventory_animations, sample_scroll_states, eval_probe |
| `scripts/` | `run_eval.sh` benchmark entry point, `eval_score.py` scorer, `slice.py` fullPage screenshot slicer, `install-ego-browser.sh` |
| `learnings/<site>/` | Per-site clone notes (selectors, quirks, where the config objects live) so the next clone of that site starts warm |
| `agents/openai.yaml` | Optional Codex display metadata; every other agent ignores it |

## Before you use this

The design, copy, imagery, and fonts of anything you clone still belong to the original site's owner. This skill is for studying implementations, technical research, and rebuilding pages you already have rights to. Before publishing a clone: keep the scraped DOM/CSS/JS under `reference/` out of the repo, put attribution in the README, and either swap commercial fonts for open-source near-matches or gitignore them along with the original's imagery and video. Fonts are the realistic DMCA vector, and "non-commercial" is not a shield when the repo or post promotes a product.
