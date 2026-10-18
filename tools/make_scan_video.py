"""A fake-webcam video for end-to-end tests of the scanner: pieces are placed one at a time on a
table (empty table in between), with slow hand-held camera drift. Output is MJPEG, which Chrome
plays as a camera with --use-file-for-fake-video-capture.

Usage: python3 tools/make_scan_video.py <set_dir> <out.mjpeg> <piece numbers> [seconds per piece]
"""

import io
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).parent))
import make_scan_frames as frames  # noqa: E402

FPS = 30


def main():
    set_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
    numbers = [int(v) for v in sys.argv[3].split(",")]
    per_piece = float(sys.argv[4]) if len(sys.argv) > 4 else 5.0
    meta = json.loads((set_dir / "meta.json").read_text())
    rng = np.random.default_rng(5)
    bg = frames.table(rng, "slate")
    t = 0
    with open(out, "wb") as f:
        for n in numbers:
            gt_img, color, scale = frames.piece_layers(set_dir, n, meta["threshold"], 360)
            angle = rng.uniform(0, 360)
            for k in range(int(per_piece * FPS)):
                t += 1 / FPS
                # slow drift of a hand-held phone: a few pixels and a fraction of a degree
                center = (frames.FRAME[0] / 2 + 6 * math.sin(t * 1.3), frames.FRAME[1] / 2 + 5 * math.sin(t * 0.9 + 1))
                tilt = (1.5 * math.sin(t * 0.7), 1.5 * math.sin(t * 0.5 + 2))
                empty = k < FPS * 1.0  # one second of empty table between pieces
                img = frames.render(bg, None if empty else gt_img, color, scale, angle + 0.3 * math.sin(t), center, tilt, rng)
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=85)
                f.write(buf.getvalue())
            print("piece", n, flush=True)


if __name__ == "__main__":
    main()
