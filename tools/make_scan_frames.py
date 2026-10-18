"""Synthetic camera bursts of single pieces, for testing the scanner.

Each piece from a jigsawlutioner-cli sample set (backlit scan = exact silhouette, color scan =
appearance) is composited onto a textured table with a soft shadow, a thin cardboard rim, uneven
light, and per-frame hand shake (small tilt, shift, rotation, scale), defocus, noise and JPEG
compression. The unwarped silhouette is saved as ground truth.

Usage: python3 tools/make_scan_frames.py <set_dir> <out_dir> <piece numbers comma separated> [frames] [backgrounds] [card]
With card = dark|light the piece lies on a printed scan card (see public/card.html).
"""

import json
import math
import os
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).parent))
from pieceset import largest_component  # noqa: E402

OUT = (1280, 960)
PAD = 160  # rendered larger and cropped so the tilt warp never shows empty corners
FRAME = (OUT[0] + 2 * PAD, OUT[1] + 2 * PAD)


def table(rng, kind):
    w, h = FRAME
    yy, xx = np.mgrid[0:h, 0:w]
    base = {"felt": [38, 52, 44], "wood": [92, 64, 40], "slate": [44, 46, 54], "busy": [0, 0, 0]}[kind]
    light = 1.0 + 0.25 * np.cos((xx / w - 0.2) * 2.2) * np.cos((yy / h - 0.3) * 1.8)
    tex = rng.normal(0, 1, (h // 4, w // 4))
    tex = np.asarray(Image.fromarray(((tex + 4) * 30).clip(0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), float) / 30 - 4
    if kind == "wood":
        tex = tex * 0.5 + 3 * np.sin(yy / 7 + 2 * np.sin(xx / 90))
    img = np.array(base)[None, None, :] * light[..., None] + tex[..., None] * 4
    if kind == "busy":
        # a patterned table cloth: colored blobs and stripes, hard for color thresholds
        pattern = np.zeros((h, w, 3))
        for _ in range(60):
            cx, cy, r = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(30, 160)
            color = rng.uniform(40, 230, 3)
            pattern[(xx - cx) ** 2 + (yy - cy) ** 2 < r * r] = color
        stripes = ((xx + yy) // 40 % 2)[..., None] * np.array([30, 20, 10])
        img = (pattern * 0.85 + stripes + 30) * light[..., None]
    return img.clip(0, 255)


def piece_layers(set_dir, n, threshold, size_px):
    scan = Image.open(set_dir / f"piece{n}.jpg").convert("L")
    gt = largest_component(np.asarray(scan, float) / 255 <= threshold)
    ys, xs = np.nonzero(gt)
    x0, x1, y0, y1 = xs.min() - 20, xs.max() + 20, ys.min() - 20, ys.max() + 20
    gt_img = Image.fromarray((gt * 255).astype(np.uint8)).crop((x0, y0, x1, y1))
    color = Image.open(set_dir / f"piece{n}_color.jpg").convert("RGB").crop((x0, y0, x1, y1))
    scale = size_px / math.sqrt(gt.sum())
    return gt_img, color, scale


def render(bg, gt_img, color, scale, angle, center, tilt, rng):
    w, h = FRAME
    if gt_img is None:  # empty table
        frame = Image.fromarray(bg.clip(0, 255).astype(np.uint8))
        frame = frame.transform(FRAME, Image.PERSPECTIVE, tilt_coefficients(*tilt), Image.BICUBIC)
        frame = frame.crop((PAD, PAD, PAD + OUT[0], PAD + OUT[1])).filter(ImageFilter.GaussianBlur(0.8))
        arr = np.asarray(frame, float) + rng.normal(0, 3, (OUT[1], OUT[0], 3))
        return Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    big = (int(gt_img.width * scale), int(gt_img.height * scale))
    alpha = gt_img.resize(big, Image.LANCZOS).rotate(angle, Image.BICUBIC, expand=True)
    col = color.resize(big, Image.LANCZOS).rotate(angle, Image.BICUBIC, expand=True)
    a = np.zeros((h, w))
    c = np.zeros((h, w, 3))
    ox, oy = int(center[0] - alpha.width / 2), int(center[1] - alpha.height / 2)
    a[oy:oy + alpha.height, ox:ox + alpha.width] = np.asarray(alpha, float) / 255
    c[oy:oy + col.height, ox:ox + col.width] = np.asarray(col, float)
    # pieces scanned on blue scanner paper: replace the blue rim pixels by the piece's mean color
    inside = a > 0.98
    mean = c[inside].mean(axis=0)
    c = np.where(a[..., None] > 0.5, c, mean)

    shadow = Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(7))
    sh = np.roll(np.roll(np.asarray(shadow, float) / 255, 6, 0), 4, 1)
    img = bg * (1 - 0.45 * sh[..., None])
    # cardboard rim: a light 1-2 px band along the lower-right outline
    rim = np.clip(np.roll(np.roll(a, 1, 0), 1, 1) - a, 0, 1)
    img = img * (1 - rim[..., None]) + np.array([200, 196, 186]) * rim[..., None] * 0.7 + img * rim[..., None] * 0.3
    img = img * (1 - a[..., None]) + c * a[..., None]

    frame = Image.fromarray(img.clip(0, 255).astype(np.uint8))
    # small camera tilt (hand-held phone): rotation homography H = K R K^-1, focal length ~ 1000 px
    frame = frame.transform(FRAME, Image.PERSPECTIVE, tilt_coefficients(*tilt), Image.BICUBIC)
    frame = frame.crop((PAD, PAD, PAD + OUT[0], PAD + OUT[1]))
    frame = frame.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.1)))
    arr = np.asarray(frame, float) + rng.normal(0, 3, (OUT[1], OUT[0], 3))
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def tilt_coefficients(tilt_x_deg, tilt_y_deg, focal=1000.0):
    w, h = FRAME
    K = np.array([[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1]])
    ax, ay = math.radians(tilt_y_deg), math.radians(tilt_x_deg)
    rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    # PIL maps output pixels to input pixels, so pass the inverse homography
    inv = K @ (ry @ rx).T @ np.linalg.inv(K)
    inv = inv / inv[2, 2]
    return inv.ravel()[:8].tolist()


CARD_OUTER, CARD_RING, CARD_GAP, CARD_MARGIN = 70, 6, 2, 8  # mm, as in public/card.html
SCAN_PX_PER_MM = 15.0  # assumed resolution of the sample set scans (only used for card tests)


def draw_card(bg, interior, px_per_mm, angle, center):
    """Draws the scan card onto the table (anti-aliased, rotated) and returns the image."""
    size_mm = CARD_OUTER + 2 * CARD_MARGIN
    ss = 4
    side = int(size_mm * px_per_mm * ss)
    card = Image.new("RGB", (side, side), (238, 238, 232))
    from PIL import ImageDraw
    d = ImageDraw.Draw(card)
    k = px_per_mm * ss
    def sq(a, b, fill):
        d.rectangle([a * k, a * k, b * k, b * k], fill=fill)
    m = CARD_MARGIN
    sq(m, m + CARD_OUTER, (18, 18, 20))
    sq(m + CARD_RING, m + CARD_OUTER - CARD_RING, (238, 238, 232))
    sq(m + CARD_RING + CARD_GAP, m + CARD_OUTER - CARD_RING - CARD_GAP, interior)
    card = card.resize((side // ss, side // ss), Image.LANCZOS)
    mask = Image.new("L", card.size, 255)
    card = card.rotate(angle, Image.BICUBIC, expand=True, fillcolor=(0, 0, 0))
    mask = mask.rotate(angle, Image.BICUBIC, expand=True)
    img = Image.fromarray(bg.clip(0, 255).astype(np.uint8))
    img.paste(card, (int(center[0] - card.width / 2), int(center[1] - card.height / 2)), mask)
    return np.asarray(img, float)


def main():
    set_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    numbers = [int(v) for v in sys.argv[3].split(",")]
    frames = int(sys.argv[4]) if len(sys.argv) > 4 else 5
    meta = json.loads((set_dir / "meta.json").read_text())
    rng = np.random.default_rng(3)
    random.seed(3)
    out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for i, n in enumerate(numbers):
        kinds = sys.argv[5].split(",") if len(sys.argv) > 5 else ["felt", "wood", "slate"]
        kind = kinds[i % len(kinds)]
        bg = table(rng, kind)
        card = sys.argv[6] if len(sys.argv) > 6 else None
        size_mm = None
        if card:
            # the card fills ~70% of the view; the piece keeps its true size relative to the card
            px_per_mm = OUT[1] * 0.70 / (CARD_OUTER + 2 * CARD_MARGIN)
            bg = draw_card(bg, (52, 56, 64) if card == "dark" else (238, 238, 232), px_per_mm, random.uniform(-30, 30), (FRAME[0] / 2, FRAME[1] / 2))
            scan_area = largest_component(np.asarray(Image.open(set_dir / f"piece{n}.jpg").convert("L"), float) / 255 <= meta["threshold"]).sum()
            size_mm = math.sqrt(scan_area) / SCAN_PX_PER_MM
            gt_img, color, scale = piece_layers(set_dir, n, meta["threshold"], size_mm * px_per_mm)
        else:
            gt_img, color, scale = piece_layers(set_dir, n, meta["threshold"], rng.uniform(300, 420))
        gt_img.save(out_dir / f"p{n}_gt.png")
        angle = random.uniform(0, 360)
        files = []
        for f in range(frames):
            center = (FRAME[0] / 2 + rng.normal(0, 8), FRAME[1] / 2 + rng.normal(0, 8))
            jitter = 1.0 if card else rng.uniform(0.98, 1.02)  # on the card the size must stay true
            tilt_sd = 4 if card else 3
            img = render(bg, gt_img, color, scale * jitter, angle + rng.normal(0, 0.8), center,
                         (rng.normal(0, tilt_sd), rng.normal(0, tilt_sd)), rng)
            name = f"p{n}_f{f}.jpg"
            img.save(out_dir / name, quality=88)
            files.append(name)
        turned = []
        if os.environ.get("TURN"):
            # the same piece turned by 180° on the card; the lamp (shadow direction) stays put
            for f in range(frames):
                center = (FRAME[0] / 2 + rng.normal(0, 8), FRAME[1] / 2 + rng.normal(0, 8))
                img = render(bg, gt_img, color, scale, angle + 180 + rng.normal(0, 3), center,
                             (rng.normal(0, 4), rng.normal(0, 4)), rng)
                name = f"p{n}_t{f}.jpg"
                img.save(out_dir / name, quality=88)
                turned.append(name)
        index.append({"piece": n, "background": kind, "frames": files, "turned": turned, "gt": f"p{n}_gt.png", "sizeMm": size_mm})
        print("piece", n, kind)
    (out_dir / "index.json").write_text(json.dumps(index))


if __name__ == "__main__":
    main()
