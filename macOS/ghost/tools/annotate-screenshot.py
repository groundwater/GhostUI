#!/usr/bin/env python3
"""
annotate-screenshot.py

Takes a screenshot, fetches the CRDT accessibility tree from the ghost daemon,
and draws colored dot annotations at each node's click coordinates.
"""

import json
import re
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
RAW_SCREENSHOT = "/tmp/ghost-annotate-raw.png"
OUTPUT_PATH = "/tmp/ghost-annotated.png"
TREE_URL = "http://localhost:7861/cli/live-tree"

DOT_RADIUS = 4
LABEL_FONT_SIZE = 11
LABEL_PAD_X = 3
LABEL_PAD_Y = 1

# Tag -> dot colour
TAG_COLORS = {
    "Button":       "red",
    "CheckBox":     "red",
    "MenuItem":     "blue",
    "MenuBarItem":  "blue",
    "Row":          "green",
    "Cell":         "green",
    "Toolbar":      "yellow",
    "TabGroup":     "yellow",
    "StaticText":   "cyan",
    "Heading":      "cyan",
}
DEFAULT_COLOR = "white"

# Semi-transparent label background (RGBA)
LABEL_BG = (0, 0, 0, 160)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def take_screenshot():
    subprocess.run(["screencapture", "-x", RAW_SCREENSHOT], check=True)


def fetch_tree() -> dict:
    with urllib.request.urlopen(TREE_URL, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_nodes(tree: dict):
    """Yield (tag, display_name, x, y) for every element with click coords."""
    tag = tree.get("_tag", "")
    click = tree.get("click")

    if click and isinstance(click, dict) and "_tuple" in click:
        items = click["_tuple"]
        if len(items) >= 2:
            x, y = int(items[0]), int(items[1])
            name = tree.get("title", "") or tree.get("label", "")
            yield tag, name, x, y
    elif click and isinstance(click, str):
        # Handle string format like "(x,y)"
        m = re.match(r'\((-?\d+),\s*(-?\d+)\)', click)
        if m:
            x, y = int(m.group(1)), int(m.group(2))
            name = tree.get("title", "") or tree.get("label", "")
            yield tag, name, x, y

    for child in tree.get("_children", []):
        yield from parse_nodes(child)


def detect_scale(tree: dict, img_width: int, img_height: int) -> float:
    """Detect the scale factor between logical coords and screenshot pixels.

    The CRDT tree's System element has screenW/screenH in logical points.
    The screenshot is in actual pixels.  scale = pixels / points.
    """
    screen_w = tree.get("screenW")
    screen_h = tree.get("screenH")
    if screen_w and screen_h:
        screen_w = int(screen_w)
        screen_h = int(screen_h)
        if screen_w > 0 and screen_h > 0:
            sx = img_width / screen_w
            sy = img_height / screen_h
            # Use the average; they should be nearly equal
            scale = round((sx + sy) / 2, 2)
            print(f"Detected scale: {scale}x  (logical {screen_w}x{screen_h} -> pixel {img_width}x{img_height})")
            return scale
    # Fallback: assume 1x
    return 1.0


def color_for_tag(tag: str) -> str:
    return TAG_COLORS.get(tag, DEFAULT_COLOR)


def try_load_font(size: int):
    """Try to load a TrueType font; fall back to default bitmap font."""
    paths = [
        "/System/Library/Fonts/SFCompact.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Geneva.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
    ]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # 1. Screenshot
    print("Taking screenshot...")
    take_screenshot()

    # 2. Fetch tree
    print("Fetching CRDT tree...")
    tree = fetch_tree()

    # 3. Open image
    img = Image.open(RAW_SCREENSHOT).convert("RGBA")
    width, height = img.size
    print(f"Screenshot size: {width}x{height}")

    # Detect coordinate scale factor
    scale = detect_scale(tree, width, height)

    # Scale drawing elements if Retina
    dot_r = int(DOT_RADIUS * scale)
    font_size = int(LABEL_FONT_SIZE * scale)
    pad_x = int(LABEL_PAD_X * scale)
    pad_y = int(LABEL_PAD_Y * scale)

    # Create an overlay for semi-transparent drawing
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = try_load_font(font_size)

    # 4. Parse and annotate
    count = 0
    for tag, name, lx, ly in parse_nodes(tree):
        # Skip off-screen or origin nodes
        if (lx <= 0 and ly <= 0) or lx < 0 or ly < 0:
            continue

        # Map logical coords to pixel coords
        px = int(lx * scale)
        py = int(ly * scale)

        if px >= width or py >= height:
            continue

        color = color_for_tag(tag)

        # Draw dot
        draw.ellipse(
            [px - dot_r, py - dot_r, px + dot_r, py + dot_r],
            fill=color,
            outline="black",
        )

        # Build label text
        if name:
            display = name[:30] + ("..." if len(name) > 30 else "")
            label_text = f"{tag}:{display}"
        else:
            label_text = tag

        # Measure text
        bbox = font.getbbox(label_text)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

        # Position label to the right of dot; clamp to image bounds
        tx = px + dot_r + 3
        ty = py - th // 2
        if tx + tw + pad_x * 2 > width:
            tx = px - dot_r - 3 - tw - pad_x * 2
        if ty < 0:
            ty = 0
        if ty + th + pad_y * 2 > height:
            ty = height - th - pad_y * 2

        # Draw label background
        draw.rectangle(
            [tx, ty, tx + tw + pad_x * 2, ty + th + pad_y * 2],
            fill=LABEL_BG,
        )
        # Draw label text
        draw.text(
            (tx + pad_x, ty + pad_y),
            label_text,
            fill=color,
            font=font,
        )

        count += 1

    # 5. Composite and save
    result = Image.alpha_composite(img, overlay)
    result = result.convert("RGB")
    result.save(OUTPUT_PATH)
    print(f"Annotated {count} nodes.")
    print(f"Saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
