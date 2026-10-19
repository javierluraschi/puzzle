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
  .og { position: relative; width: 1200px; height: 630px; overflow: hidden; display: grid; grid-template-columns: 600px 1fr; align-items: center;
        padding: 0 30px 0 76px; box-sizing: border-box; background-color: var(--bg);
        background-image: linear-gradient(rgba(31, 27, 22, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(31, 27, 22, 0.05) 1px, transparent 1px);
        background-size: 36px 36px; }
  .og-brand { display: flex; align-items: center; gap: 14px; font: 650 32px var(--font-display); letter-spacing: -0.01em; }
  .og h1 { font-family: var(--font-display); font-size: 70px; line-height: 0.98; letter-spacing: -0.035em; font-weight: 600; margin: 36px 0 26px; }
  .og p { color: var(--muted); font-size: 25px; line-height: 1.4; margin: 0 0 32px; max-width: 500px; }
  .og-url { display: inline-block; font: 600 21px var(--font-mono); color: var(--accent-ink); background: #fff; border: 2px solid var(--line-strong); border-radius: 999px; padding: 8px 22px; }
  .og .swoosh path { animation: none; stroke-dashoffset: 0; }
  .og .hero-stage { width: 600px; margin-left: -20px; }
  .og .hp, .og .hp-tag, .og .hp-lift, .og .hero-ring { animation: none !important; }
  .og .hp-tag, .og .hero-ring, .og .hp-lift { opacity: 0; }
  .og .hp-last { transform: translate(58px, -70px) rotate(14deg); }
  .og .hp-last .hp-lift { opacity: 1; }
</style>
<div class="og">
  <div>
    <div class="og-brand"><img src="/favicon.svg" width="48" height="48" alt=""> Puzzle Solver</div>
    <h1>That piece fits somewhere. <span class="h1-turn">Your phone knows <em class="swoosh">where<svg viewBox="0 0 200 24" preserveAspectRatio="none"><path d="M4 16C52 6 128 4 196 11" pathLength="1"/></svg></em>.</span></h1>
    <p>Print the scan card, scan your pieces one by one, and see exactly which ones fit together.</p>
    <span class="og-url">puzzle.cloudish.app</span>
  </div>
  <div class="hero-stage" data-art="hero"></div>
</div>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.evaluate((html) => { document.body.innerHTML = html; }, card);
await page.addScriptTag({ url: '/landing.js?card', type: 'module' }); // a fresh URL, so the module runs again
await page.waitForSelector('.og .hp-last', { timeout: 30000 }); // the art is drawn once its data loads
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
await page.locator('.og').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
