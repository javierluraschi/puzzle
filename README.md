# Jigsaw Scanner

Live at **https://jigsawsolver.on.do.cloudish.ai/**

Scan jigsaw pieces one at a time with a phone camera to build a catalog of pieces. Each
piece's exact outline is traced on the device, and only that 2D contour is stored. The server
runs [byWulf/jigsawlutioner](https://github.com/byWulf/jigsawlutioner) on the contours to find
each piece's four sides (tab, blank or flat edge), show the best candidates for every side, and
assemble the catalog into groups.

## Using it

1. **Print the [scan card](public/card.html)**, a 70 mm black frame. It is required: it corrects
   perspective and gives every piece its true size in mm.
2. **Scan.** Put one piece in the middle of the card and hold the phone flat so the card fills the
   view. When the frame turns green and you hold still, the photo is taken automatically. You can
   also tap ●, or use 🖼 to take the photo with the phone's camera app (full resolution, flash).
   Labels count up from 1, and you can edit them.
3. **Review**, write the number on the back of the piece, then tap *Next piece*.
4. **Match / solve.** Open a piece to see what fits each side, or solve the whole catalog.

Optional: **🔦** turns on a continuous light where the browser supports it (fewer shadows). **↻ 2×**
takes two captures with the piece turned 180° in between and keeps only what is in both, which
cancels any remaining shadow.

## How the scanner works (all on the device)

| Stage | Where | What |
|---|---|---|
| Live view | `public/scan/live-worker.js` | Only finds the card, ~3×/s on a 320 px frame. The camera runs at 15 fps and a motion-sensor level shows tilt. The piece is not segmented live: continuous segmentation overheated phones. |
| Capture | `public/scan/scanner.js` | Native photos via `ImageCapture.takePhoto()` where available, otherwise the highest-resolution video frames. The camera is switched off while processing and reviewing. |
| Card | `vision.detectCard` | Ring found in the downscaled photo; corners refined by line fitting; homography to mm. |
| Coarse mask | `vision.segmentOnCard` | On the blanked card interior, with a **shadow-free distance**: the pixel is written as I = s·B + r against the local card color B. Shadows (s < 1, r ≈ 0) score zero; the piece differs in color (r) or is brighter. MobileSAM is an optional fallback for low contrast. |
| Edges | `vision.refineOnCard` | At the photo's native resolution around the piece: α = (D(I) − n) / (D(F) − n), using the shadow-free distance D, the nearest piece color F and the card color averaged over the plain card. The 0.5 iso-line is traced with marching squares, then smoothed by 0.08 mm along the outline. |
| Combine | `refine-worker.js` | Frames of one placement are averaged; turned placements are intersected (a shadow only ever adds area). |

On the six test photos (`tests/test1`), the new pipeline excludes the shadow crescents the old
one included: its outlines were 7–9% too large in sqrt(area). Jitter is about 35% lower, and all
side types (tab / blank) are detected correctly. On synthetic bursts with ground truth, the
outline error is about 0.25% of piece size.

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
- `tools/make_scan_frames.py`: synthetic camera bursts with ground truth on the scan card (`TURN=1` also writes a 180°-turned placement).
- `tools/make_scan_video.py`: a fake-webcam MJPEG video for Chrome's `--use-file-for-fake-video-capture` (`CARD=dark` puts the pieces on the card).

## Credits

[jigsawlutioner](https://github.com/byWulf/jigsawlutioner) by Michael Wolf (MIT) does the piece
analysis and the solving. [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) (Apache-2.0),
using the ONNX export by [Acly](https://huggingface.co/Acly/MobileSAM) (MIT), runs on
[ONNX Runtime Web](https://onnxruntime.ai) (MIT). The demo pieces come from
[jigsawlutioner-cli](https://github.com/byWulf/jigsawlutioner-cli) (MIT).
