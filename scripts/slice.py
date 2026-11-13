#!/usr/bin/env python3
"""Slice a scroll=0 fullPage screenshot into per-section reference images.

Usage: python3 slice.py <full-page.png> <outline.json> <out-dir> [--scale N]

outline.json is a list of {tag, cls, y, h, w} objects (the Phase 1 DOM outline,
CSS-pixel coordinates). ego-browser's page.screenshot() writes CSS-pixel images
by default, so the default scale is 1. Pass --scale <devicePixelRatio> only for
captures taken with `raw: true` or another tool's device-pixel screenshot.
"""
import argparse
import json
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is missing for this Python. Use a Python that has it (on macOS /usr/bin/python3 often does), or install it in a virtual environment and activate it: python3 -m venv ~/.venvs/clone-website && ~/.venvs/clone-website/bin/pip install Pillow. Homebrew's python3 refuses a plain pip install (PEP 668).")

Image.MAX_IMAGE_PIXELS = None  # fullPage captures of long pages exceed the default safety limit


def main():
    ap = argparse.ArgumentParser(description="Slice a fullPage screenshot by DOM outline rects.")
    ap.add_argument("screenshot")
    ap.add_argument("outline")
    ap.add_argument("out_dir")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="image pixels per CSS pixel; 1 for ego-browser's default screenshots")
    args = ap.parse_args()
    if args.scale <= 0:
        sys.exit("--scale must be positive")

    img = Image.open(args.screenshot)
    with open(args.outline) as f:
        sections = json.load(f)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    written = 0
    for i, s in enumerate(sections):
        top = max(0, int(s["y"] * args.scale))
        bottom = min(img.height, int((s["y"] + s["h"]) * args.scale))
        if bottom - top < 10:
            continue
        label = re.sub(r"[^a-z0-9]+", "-", (s.get("cls") or s.get("tag", "sec")).lower())[:40].strip("-") or "sec"
        name = f"{i:02d}-{label}.png"
        img.crop((0, top, img.width, bottom)).save(out / name)
        written += 1
        print(f"{name}  y={s['y']} h={s['h']}")
    if not written:
        sys.exit(f"no section fell inside the {img.width}x{img.height} image; check the outline or --scale")


if __name__ == "__main__":
    main()
