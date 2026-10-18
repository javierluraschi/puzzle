# Jigsaw Scanner

Live at **https://jigsawsolver.on.do.cloudish.ai/**

Scan jigsaw pieces one at a time with a phone camera to build a catalog of pieces. Each
piece's exact outline is traced on the device, and only that 2D contour is stored. The server
runs [byWulf/jigsawlutioner](https://github.com/byWulf/jigsawlutioner) on the contours to find
each piece's four sides (tab, blank or flat edge), show the best candidates for every side, and
assemble the catalog into groups.

## Using it

1. **Scan.** Put one piece face up on a plain, contrasting surface and hold the phone flat above
   it. When the outline turns green, hold still and the scanner captures automatically. Labels
   count up from 1. You can change them in the scanner or in the catalog.
2. **Swap.** Write the number on the back of the piece and put the next one down. Scanning
   restarts once the scanner sees an empty view or a different piece.
3. **Match / solve.** Open a piece to see what fits each side, or solve the whole catalog.

For complete solves, print the [scan card](public/card.html), a 70 mm black frame, and scan each
piece in its middle. The card corrects perspective and gives every piece its true size in mm.
Without the card, every piece is scaled to the same size. That still works well for finding
neighbours, but the solver assembles fewer pieces. On the 54-piece demo set it placed all 54 with
known sizes and 49 with normalized sizes.

## How the scanner works (all on the device)

| Stage | Where | What |
|---|---|---|
| Live guidance | `public/scan/live-worker.js` | Runs at ~10 fps on 360 px frames. It models the background color (from the frame border, or from a point you tap), thresholds with Otsu and picks the piece nearest the center. Its output drives the overlay and the guidance text: center the piece, move closer, hold the phone flat (level from the motion sensor), hold steady. |
| Burst | `public/scan/scanner.js` | Captures 5 full-resolution frames once the piece has been steady for 0.7 s. |
| Coarse mask | `public/scan/refine-worker.js` | Color thresholding at half resolution. **MobileSAM** (ONNX Runtime Web, WebGPU or WASM) acts as a referee and takes over when the background is too busy for thresholding. In the default *auto* mode, the 45 MB model downloads only when needed. |
| Sub-pixel edges | `vision.refineContour` | Treats the mask as a trimap. Each boundary pixel is explained against the colors of the nearest sure-piece and sure-background pixels: α = \|I − B\| / \|F − B\|, minus the background's noise level. The contour is the α = 0.5 iso-line (marching squares). |
| Fusion | `vision.fuseContours` | Drops blurred frames. The frame that agrees most with the others (the medoid) becomes the reference; the rest are aligned to it (similarity ICP) and their anti-aliased coverages averaged before taking the 0.5 iso-line. This suppresses noise and one-off glitches. |
| Scan card | `vision.detectCard` | Finds the ring and refines its corners by line fitting. A homography maps every frame's contour into millimetres (perspective-corrected) before fusion. |

On synthetic bursts (real scanned pieces composited onto textured tables with a soft shadow, a
cardboard rim, ±3° hand tilt, blur, noise and JPEG compression), the fused contour is within about
**0.24% of the piece size on average** (p95 ≈ 0.6%), or about 0.05 mm on a 2 cm piece. Run the
tests yourself with `tools/make_scan_frames.py` and `tools/make_scan_video.py`.

The contour is sent as 1000 points, centered and scaled to sqrt(area) = 1000 units, plus the size
in mm when the card was used. The server never receives images.

## Server

| Part | What it does |
|---|---|
| `server/router.php` | JSON API and static files. Sends COOP/COEP headers so the browser can run multi-threaded WASM. |
| `server/lib.php` | Rebuilds the silhouette jigsawlutioner expects from the contour (1000×1060, drawn at 2× for sub-pixel edges) and runs `PieceAnalyzer`. Scale comes from the card, or from a two-pass normalization to ~305 px sides. Also flags probable duplicates, handles labels, and computes per-side matches (`WeightedMatcher`). |
| `server/solve.php` | Background solver: `MatchingMapGenerator` + `ByWulfSolver`. |

### API

```
POST   /api/puzzles                       {name}                         -> catalog
GET    /api/puzzles/:id                                                  -> pieces, next label, solve status
POST   /api/puzzles/:id/pieces            {label, contour, sizeMm?, quality?, replace?} -> analyzed piece
PATCH  /api/puzzles/:id/pieces/:n         {label}
DELETE /api/puzzles/:id/pieces/:n
GET    /api/puzzles/:id/pieces/:n/matches                                -> best candidates per side
POST   /api/puzzles/:id/solve                                            -> starts the solver
GET    /api/puzzles/:id/solution                                         -> status + groups
GET    /api/puzzles/:id/export                                           -> all labels + contours (JSON)
```

## Running locally

```bash
composer install
# ONNX Runtime Web + MobileSAM are downloaded by the Dockerfile; for local use fetch them the same way
php -S 0.0.0.0:8080 -t public server/router.php
```

## Deploying

`./deploy.sh` uploads the build context to [Cloudish](https://cloudish.ai), which builds the image
and rolls it out. It needs `CLOUDISH_API_KEY` in `.env`.

## Tools

- `tools/make_demo_catalog.py`: builds the demo catalog (`public/demo/cats.json`) from a
  [jigsawlutioner-cli](https://github.com/byWulf/jigsawlutioner-cli) sample set.
- `tools/make_scan_frames.py`: synthetic camera bursts with ground truth, optionally on the scan card.
- `tools/make_scan_video.py`: a fake-webcam MJPEG video for Chrome's `--use-file-for-fake-video-capture`.

## Credits

[jigsawlutioner](https://github.com/byWulf/jigsawlutioner) by Michael Wolf (MIT) does the piece
analysis and the solving. [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) (Apache-2.0),
using the ONNX export by [Acly](https://huggingface.co/Acly/MobileSAM) (MIT), runs on
[ONNX Runtime Web](https://onnxruntime.ai) (MIT). The demo pieces come from
[jigsawlutioner-cli](https://github.com/byWulf/jigsawlutioner-cli) (MIT).
