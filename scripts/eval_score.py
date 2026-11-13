#!/usr/bin/env python3
"""Score a website clone against its original from two eval-probe JSON files.

Usage:
  python3 eval_score.py <original.json> <clone.json> \
      [--shots original-full.png clone-full.png] [--out <dir>]

Writes scorecard.json and report.md to --out (default: alongside clone.json).
Both probe files must come from tools/eval-probe.js runs in the same viewport.

Dimensions and weights (total 100):
  geometry 25, typography 15, color 10, assets 10, fonts 10,
  animations 15, content density 5, visual similarity 10.
Pass bar: total >= 90 and no dimension below its threshold.
No letter grades anywhere: numbers, pass/fail, and named offenders only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

WEIGHTS = {
    "geometry": 25, "typography": 15, "color": 10, "assets": 10,
    "fonts": 10, "animations": 15, "content": 5, "visual": 10,
}
THRESHOLDS = {  # minimum per-dimension score (0-100) to pass
    "geometry": 85, "typography": 85, "color": 80, "assets": 90,
    "fonts": 90, "animations": 80, "content": 85, "visual": 75,
}
GEOMETRY_TOLERANCE_PX = 6
PAGE_HEIGHT_TOLERANCE = 0.01  # 1%


def index_elements(sections):
    """Uniquify element keys by occurrence order down the page: 'A|Pricing#0' (header) vs
    'A|Pricing#1' (footer). Same-order occurrences pair with each other across sides."""
    elems = [e for s in sections for e in s["samples"]]
    elems.sort(key=lambda e: (e["rect"]["y"], e["rect"]["x"]))
    seen, out = {}, {}
    for e in elems:
        n = seen.get(e["key"], 0)
        seen[e["key"]] = n + 1
        out[f"{e['key']}#{n}"] = e
    return out


def match_elements(orig_sections, clone_sections):
    orig_map = index_elements(orig_sections)
    clone_map = index_elements(clone_sections)
    pairs = [({**v, "key": k}, {**clone_map[k], "key": k}) for k, v in orig_map.items() if k in clone_map]
    missing = [k for k in orig_map if k not in clone_map]
    return pairs, missing


def match_sections(orig, clone):
    """Pair section bands by y-center proximity (within 12% of page height), one-to-one."""
    page_h = max(orig["pageH"], 1)
    used = set()
    pairs = []
    for s in orig["sections"]:
        yc = s["y"] + s["h"] / 2
        best, best_d = None, page_h * 0.12
        for c in clone["sections"]:
            if c["index"] in used:
                continue
            d = abs(yc - (c["y"] + c["h"] / 2))
            if d < best_d:
                best, best_d = c, d
        if best is not None:
            used.add(best["index"])
        pairs.append((s, best))
    return pairs


def score_geometry(orig, clone, pairs):
    rows = []
    for o, c in pairs:
        err = max(abs(o["rect"][k] - c["rect"][k]) for k in ("x", "y", "w", "h"))
        rows.append((o["key"], err))
    within = [r for r in rows if r[1] <= GEOMETRY_TOLERANCE_PX]
    elem_score = 100 * len(within) / len(rows) if rows else 0
    h_err = abs(orig["pageH"] - clone["pageH"]) / max(orig["pageH"], 1)
    h_score = 100 if h_err <= PAGE_HEIGHT_TOLERANCE else max(0, 100 - (h_err - PAGE_HEIGHT_TOLERANCE) * 2000)
    offenders = sorted((r for r in rows if r[1] > GEOMETRY_TOLERANCE_PX), key=lambda r: -r[1])[:10]
    return 0.8 * elem_score + 0.2 * h_score, {
        "elements_compared": len(rows),
        "within_tolerance_px": len(within),
        "tolerance_px": GEOMETRY_TOLERANCE_PX,
        "page_height": {"original": orig["pageH"], "clone": clone["pageH"], "error_pct": round(h_err * 100, 2)},
        "worst_offenders": [{"element": k, "max_axis_error_px": e} for k, e in offenders],
    }


def _parse_color(s):
    m = re.match(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", s or "")
    if not m:
        return None
    r, g, b = (float(m.group(i)) for i in (1, 2, 3))
    return (r, g, b, float(m.group(4)) if m.group(4) is not None else 1.0)


def colors_equal(a, b):
    """Perceptual-enough equality: channel diff <= 8, alpha diff <= 0.06."""
    ca, cb = _parse_color(a), _parse_color(b)
    if ca is None or cb is None:
        return a == b
    return all(abs(x - y) <= 8 for x, y in zip(ca[:3], cb[:3])) and abs(ca[3] - cb[3]) <= 0.06


def score_color(pairs):
    rows = []
    for o, c in pairs:
        ok = colors_equal(o["color"], c["color"]) and colors_equal(o["bg"], c["bg"])
        diff = {f: (o[f], c[f]) for f in ("color", "bg") if not colors_equal(o[f], c[f])}
        rows.append((o["key"], ok, diff))
    good = [r for r in rows if r[1]]
    score = 100 * len(good) / len(rows) if rows else 0
    return score, {"color_compared": len(rows), "color_matching": len(good),
                   "worst_offenders": [{"element": k, "diff": d} for k, ok, d in rows if not ok][:10]}


def score_typography(pairs):
    """Per-field partial credit: family 0.4, size 0.3, weight 0.3. A family alias mismatch
    should cost 40% of one element, not 100% of every element sharing the alias."""
    def norm_family(f):
        return (f or "").lower().strip().strip('"\'')

    def px(v):
        try:
            return float((v or "").replace("px", ""))
        except ValueError:
            return None

    rows = []
    for o, c in pairs:
        of, cf = o["font"], c["font"]
        fam = norm_family(of["family"]) == norm_family(cf["family"])
        so, sc_ = px(of["size"]), px(cf["size"])
        size = so is not None and sc_ is not None and abs(so - sc_) <= 0.6
        weight = of["weight"] == cf["weight"]
        pts = 0.4 * fam + 0.3 * size + 0.3 * weight
        diff = {}
        if not fam:
            diff["family"] = (of["family"], cf["family"])
        if not size:
            diff["size"] = (of["size"], cf["size"])
        if not weight:
            diff["weight"] = (of["weight"], cf["weight"])
        rows.append((o["key"], pts, diff))
    score = 100 * sum(r[1] for r in rows) / len(rows) if rows else 0
    offenders = sorted((r for r in rows if r[1] < 1), key=lambda r: r[1])[:10]
    return score, {"typography_compared": len(rows),
                   "typography_fully_matching": len([r for r in rows if r[1] == 1]),
                   "worst_offenders": [{"element": k, "diff": d} for k, _, d in offenders]}


def _get(e, dotted):
    v = e
    for part in dotted.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    return v


def score_coverage(orig_list, clone_list, label):
    o, c = set(orig_list), set(clone_list)
    if not o:
        return 100, {f"{label}_in_original": 0, "note": "original has none; trivially covered"}
    covered = o & c
    return 100 * len(covered) / len(o), {
        f"{label}_in_original": len(o),
        f"{label}_covered": len(covered),
        "missing": sorted(o - c)[:15],
    }


def score_animations(orig, clone):
    oa, ca = orig["animations"], clone["animations"]
    count_score = 100 * min(oa["count"], ca["count"]) / max(oa["count"], ca["count"], 1) if (oa["count"] or ca["count"]) else 100
    keys = set(oa["byTimeline"]) | set(ca["byTimeline"])
    tl_overlap = sum(min(oa["byTimeline"].get(k, 0), ca["byTimeline"].get(k, 0)) for k in keys)
    tl_total = sum(max(oa["byTimeline"].get(k, 0), ca["byTimeline"].get(k, 0)) for k in keys)
    tl_score = 100 * tl_overlap / tl_total if tl_total else 100
    o_props, c_props = sorted(oa["propSets"]), sorted(ca["propSets"])
    matched = 0
    ci = list(c_props)
    for p in o_props:
        if p in ci:
            ci.remove(p)
            matched += 1
    prop_score = 100 * matched / max(len(o_props), 1) if o_props else 100
    return 0.3 * count_score + 0.4 * tl_score + 0.3 * prop_score, {
        "count": {"original": oa["count"], "clone": ca["count"]},
        "by_timeline": {"original": oa["byTimeline"], "clone": ca["byTimeline"]},
        "keyframe_property_sets_matched": f"{matched}/{len(o_props)}",
    }


def score_content(section_pairs):
    rows = []
    for s, c in section_pairs:
        if not c:
            rows.append((s["index"], False, f"no clone section near y={s['y']}"))
            continue
        od, cd = s["density"], c["density"]
        text_ok = cd["textLen"] >= 0.7 * od["textLen"]
        media_ok = (cd["imgs"] + cd["svgs"]) >= 0.7 * (od["imgs"] + od["svgs"])
        why = None if (text_ok and media_ok) else (
            f"text {cd['textLen']}/{od['textLen']}, media {cd['imgs']+cd['svgs']}/{od['imgs']+od['svgs']}")
        rows.append((s["index"], text_ok and media_ok, why))
    good = [r for r in rows if r[1]]
    score = 100 * len(good) / len(rows) if rows else 0
    return score, {
        "sections_compared": len(rows),
        "sections_with_full_density": len(good),
        "thin_sections": [{"section_index": i, "shortfall": w} for i, ok, w in rows if not ok][:10],
        "note": "a thin section usually means an empty mock panel; inspect it on the live original before accepting",
    }


def score_visual(orig_png, clone_png, orig_pageh, clone_pageh, bands=24):
    try:
        from PIL import Image
    except ImportError:
        return None, {"skipped": "Pillow is missing for this Python. Use a Python that has it (on macOS /usr/bin/python3 often does), or install it in a virtual environment and activate it: python3 -m venv ~/.venvs/clone-website && ~/.venvs/clone-website/bin/pip install Pillow. Homebrew's python3 refuses a plain pip install (PEP 668)."}
    Image.MAX_IMAGE_PIXELS = None
    a = Image.open(orig_png).convert("L")
    b = Image.open(clone_png).convert("L")
    w = 320
    a = a.resize((w, max(1, int(a.height * w / a.width))))
    b = b.resize((w, max(1, int(b.height * w / b.width))))
    diffs = []
    for i in range(bands):
        ba = a.crop((0, a.height * i // bands, w, a.height * (i + 1) // bands))
        bb = b.crop((0, b.height * i // bands, w, b.height * (i + 1) // bands))
        if ba.size != bb.size:
            bb = bb.resize(ba.size)
        pa, pb = ba.tobytes(), bb.tobytes()
        mad = sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)
        diffs.append(round(mad, 2))
    ok_bands = [d for d in diffs if d <= 12.0]  # mean abs gray diff per band, 0-255 scale
    score = 100 * len(ok_bands) / len(diffs)
    return score, {
        "bands": bands,
        "bands_within_diff_12": len(ok_bands),
        "band_mean_abs_diff": diffs,
        "note": "band order is top to bottom; a high-diff band names the region to fix",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("original")
    ap.add_argument("clone")
    ap.add_argument("--shots", nargs=2, metavar=("ORIG_PNG", "CLONE_PNG"))
    ap.add_argument("--out")
    args = ap.parse_args()

    orig = json.load(open(args.original))
    clone = json.load(open(args.clone))
    out_dir = Path(args.out or Path(args.clone).parent)
    out_dir.mkdir(parents=True, exist_ok=True)

    warnings = []
    vw_o, vw_c = orig["viewport"]["w"], clone["viewport"]["w"]
    if abs(vw_o - vw_c) / max(vw_o, 1) > 0.02:
        warnings.append(f"viewport widths differ ({vw_o} vs {vw_c}); geometry numbers are not comparable, re-probe in the same viewport")

    pairs, unmatched = match_elements(orig["sections"], clone["sections"])
    scores, details = {}, {}

    scores["geometry"], details["geometry"] = score_geometry(orig, clone, pairs)
    text_pairs = [(o, c) for o, c in pairs if not o["key"].startswith("IMG|")]
    scores["typography"], details["typography"] = score_typography(text_pairs)
    scores["color"], details["color"] = score_color(text_pairs)
    scores["assets"], details["assets"] = score_coverage(
        orig["assets"]["imgs"] + orig["assets"]["videos"], clone["assets"]["imgs"] + clone["assets"]["videos"], "assets")
    scores["fonts"], details["fonts"] = score_coverage(orig["fonts"], clone["fonts"], "fonts")
    scores["animations"], details["animations"] = score_animations(orig, clone)
    scores["content"], details["content"] = score_content(match_sections(orig, clone))

    if args.shots:
        v, d = score_visual(args.shots[0], args.shots[1], orig["pageH"], clone["pageH"])
    else:
        v, d = None, {"skipped": "no screenshots supplied"}
    if v is None:
        weights = {k: w for k, w in WEIGHTS.items() if k != "visual"}
        warnings.append("visual dimension skipped; total rescaled to remaining weights")
    else:
        scores["visual"] = v
        weights = WEIGHTS
    details["visual"] = d

    total = sum(scores[k] * weights[k] for k in scores) / sum(weights[k] for k in scores)
    failing = [k for k in scores if scores[k] < THRESHOLDS[k]]
    passed = total >= 90 and not failing

    if unmatched:
        details["unmatched_elements"] = {"count": len(unmatched), "sample": unmatched[:10]}

    scorecard = {
        "original": orig["url"], "clone": clone["url"],
        "total": round(total, 1), "pass": passed,
        "pass_bar": "total >= 90 and every dimension at or above its threshold",
        "scores": {k: round(v_, 1) for k, v_ in scores.items()},
        "thresholds": THRESHOLDS, "weights": weights,
        "failing_dimensions": failing, "warnings": warnings, "details": details,
    }
    (out_dir / "scorecard.json").write_text(json.dumps(scorecard, indent=2))

    lines = [
        "# Clone benchmark report", "",
        f"Original: {orig['url']}", f"Clone: {clone['url']}", "",
        f"**Total: {scorecard['total']} / 100, {'PASS' if passed else 'FAIL'}** (bar: total >= 90, no dimension below threshold)", "",
        "| Dimension | Score | Threshold | Status |", "|---|---|---|---|",
    ]
    for k in scores:
        lines.append(f"| {k} | {round(scores[k], 1)} | {THRESHOLDS[k]} | {'ok' if scores[k] >= THRESHOLDS[k] else 'FAIL'} |")
    for w in warnings:
        lines.append(f"\n> warning: {w}")
    lines.append("\n## What to fix first\n")
    for k in sorted(scores, key=lambda k: scores[k] - THRESHOLDS[k]):
        det = details[k]
        off = det.get("worst_offenders") or det.get("thin_sections") or det.get("missing")
        if scores[k] < THRESHOLDS[k] and off:
            lines.append(f"- **{k}**: {json.dumps(off[:5], ensure_ascii=False)}")
    (out_dir / "report.md").write_text("\n".join(lines) + "\n")

    print(json.dumps({"total": scorecard["total"], "pass": passed, "failing": failing,
                      "scorecard": str(out_dir / 'scorecard.json'), "report": str(out_dir / 'report.md')}))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
