"""Demo catalog: the contours of a jigsawlutioner-cli sample set, in the format the scanner sends.

Usage: python3 tools/make_demo_catalog.py <set_dir> <out.json>
Needs numpy, pillow and scikit-image.
"""

import json
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from skimage import measure

sys.path.insert(0, str(Path(__file__).parent))
from pieceset import largest_component, piece_numbers  # noqa: E402


# the sample sets were scanned at about 20 px/mm (≈ 500 dpi): gives realistic millimetre sizes
SCAN_PX_PER_MM = 20.0


def contour_of(scan_path, threshold):
    gray = np.asarray(Image.open(scan_path).convert("L"), float) / 255
    mask = largest_component(gray <= threshold)
    # a slightly blurred mask gives a sub-pixel iso-line instead of pixel stairs
    soft = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7)), float) / 255
    loop = max(measure.find_contours(soft, 0.5), key=len)
    pts = np.stack([loop[:, 1], loop[:, 0]], axis=1)  # (row, col) -> (x, y)
    x, y = pts[:, 0], pts[:, 1]
    area = 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
    if area < 0:
        pts = pts[::-1]
        area = -area
    pts = pts - pts.mean(axis=0)
    pts = pts / np.sqrt(area) * 1000
    # these scans were made at jigsawlutioner's native resolution, so the true size is known
    scale = float(np.sqrt(area) / 1000)
    size_mm = float(np.sqrt(area) / SCAN_PX_PER_MM)
    # resample evenly to 1000 points like the scanner does
    seg = np.hypot(*np.diff(np.vstack([pts, pts[:1]]), axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    targets = np.linspace(0, cum[-1], 1000, endpoint=False)
    xs = np.interp(targets, cum, np.append(pts[:, 0], pts[0, 0]))
    ys = np.interp(targets, cum, np.append(pts[:, 1], pts[0, 1]))
    return [[round(float(a), 1), round(float(b), 1)] for a, b in zip(xs, ys)], round(scale, 5), round(size_mm, 3)


def main():
    set_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
    meta = json.loads((set_dir / "meta.json").read_text())
    numbers = piece_numbers(meta)
    random.seed(11)
    if not (len(sys.argv) > 3 and sys.argv[3] == "ordered"):
        random.shuffle(numbers)
    pieces = []
    for i, n in enumerate(numbers):
        contour, scale, size_mm = contour_of(set_dir / f"piece{n}.jpg", meta["threshold"])
        pieces.append({"label": str(i + 1), "piece": n, "contour": contour, "scale": scale, "sizeMm": size_mm})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"format": "jigsaw-catalog/1", "name": "Demo: cats (54 pieces)", "pieces": pieces}, separators=(",", ":")))
    print(out, len(pieces), "pieces", out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
