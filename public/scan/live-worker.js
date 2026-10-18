// Live view support: finds the scan card in a small frame a few times per second. The piece itself
// is only segmented once, after capture (refine-worker.js) – continuous segmentation made phones
// overheat.
import { detectCard } from './vision.js';

let canvas = null;
let ctx = null;

self.onmessage = ({ data: { id, bitmap } }) => {
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const card = detectCard(ctx.getImageData(0, 0, w, h).data, w, h);
    self.postMessage({ id, result: { w, h, corners: card ? card.corners : null } });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
