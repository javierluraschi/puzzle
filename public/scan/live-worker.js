// Fast per-frame piece detection for the live camera overlay and guidance (runs ~10-20 fps on
// small frames). The accurate contour is computed later by refine-worker.js.
import { segmentForeground, pickCenterComponent, isoContours, orient, resampleClosed, polygonArea, detectCard, keepInside } from './vision.js';

let canvas = null;
let ctx = null;

self.onmessage = ({ data: { id, bitmap, options } }) => {
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, w, h).data;

    // on the scan card, look for the piece inside the card only
    const found = detectCard(pixels, w, h);
    const card = found ? { corners: found.corners, side: found.pixelsPerMm * 70 } : null;
    if (found) keepInside(pixels, w, h, found.interior);

    const { mask, contrast } = segmentForeground(pixels, w, h, options);
    const piece = pickCenterComponent(mask, w, h);
    if (!piece) {
      self.postMessage({ id, result: { found: false, w, h, contrast, card } });
      return;
    }
    const loops = isoContours(Float32Array.from(piece.mask), w, h, 0.5);
    const contour = loops.length ? resampleClosed(orient(loops[0]), 160) : [];
    self.postMessage({
      id,
      result: {
        found: true,
        w,
        h,
        contrast,
        contour,
        bbox: piece.bbox,
        centroid: piece.centroid,
        area: Math.abs(polygonArea(contour)),
        touchesBorder: piece.touchesBorder,
        others: piece.others,
        card,
      },
    });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
