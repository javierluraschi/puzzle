// Renders the 1200×630 social card (public/social-card.png) from the landing page's own art.
// Needs the server running and Playwright with Chrome:
//   PORT=8090 DATA_DIR=/tmp/x node server/index.js &
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/make_social_card.mjs [http://localhost:8090]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const base = process.argv[2] || 'http://localhost:8090';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'social-card.png');

const card = `
<style>
  body { margin: 0; }
  .og { position: relative; width: 1200px; height: 630px; overflow: hidden; display: grid; grid-template-columns: 560px 1fr; align-items: center;
        padding: 0 40px 0 72px; box-sizing: border-box; background:
        radial-gradient(700px 420px at 88% 20%, rgba(255, 128, 64, 0.22), transparent 65%),
        radial-gradient(600px 400px at 0% 100%, rgba(79, 163, 255, 0.14), transparent 60%), #14161b; }
  .og-brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; }
  .og h1 { font-size: 62px; line-height: 1.04; letter-spacing: -0.03em; font-weight: 800; margin: 34px 0 26px; }
  .og p { color: var(--muted); font-size: 26px; line-height: 1.4; margin: 0 0 34px; }
  .og-url { display: inline-block; font-size: 22px; font-weight: 600; color: var(--accent); border: 2px solid rgba(255, 176, 32, 0.5); border-radius: 999px; padding: 8px 22px; }
  .og svg { width: 640px; height: auto; margin-left: -40px; overflow: visible; }
  .og .hp { animation: none !important; }
  .og .hp-label { display: none; }
  .og .hp-last { transform: translate(46px, -40px) rotate(12deg) !important; filter: drop-shadow(0 14px 18px rgba(0, 0, 0, 0.55)); }
</style>
<div class="og">
  <div>
    <div class="og-brand"><img src="/favicon.svg" width="48" height="48" alt=""> Jigsaw Scanner</div>
    <h1>That piece fits somewhere.<br><span class="accent-text">Your phone knows where.</span></h1>
    <p>Print the scan card, scan your pieces one by one, and see exactly which ones fit together.</p>
    <span class="og-url">puzzle.cloudish.app</span>
  </div>
  <svg data-art="hero" viewBox="0 0 640 480"></svg>
</div>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.evaluate((html) => { document.body.innerHTML = html; }, card);
await page.addScriptTag({ url: '/landing.js?card', type: 'module' }); // a fresh URL, so the module runs again
await page.waitForTimeout(500);
await page.locator('.og').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
