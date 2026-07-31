#!/usr/bin/env node
/**
 * Governor test. Three cases the old EMA-based adaptQuality got wrong:
 *
 *   heavy    — sustained GPU overload. Must act (pace down, then scale resolution).
 *   hiccups  — a healthy frame rate with rare long frames. Must NOT act; an isolated
 *              GC or chunk generation is not a quality problem.
 *   recovery — overload that stops. Must claw resolution back, then re-probe cadence.
 *
 * Traces the governor's own view (game.perf) so a failure says which input it
 * misread rather than just "quality is wrong".
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const URL_ = args.url || 'http://localhost:8080';
const CASES = (args.case || 'heavy,hiccups,recovery').split(',');
const W = 1440, H = 900;

// Deliberately NOT --disable-frame-rate-limit: the governor's whole job is reasoning
// about a vsync it can only observe indirectly, so it has to be tested against a
// context that actually has one. Unthrottled headless rAF fires at ~0.3ms and is not
// a display; testing there measures the harness, not the governor.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});

async function run(name, setup, seconds) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.mouse.click(W / 2, H / 2);
  await page.waitForTimeout(300);

  await page.evaluate(setup);

  // Trace the governor's decisions and the real presentation cadence together.
  await page.evaluate(() => {
    const g = window.game;
    window.__t = { trace: [], dt: [], rendered: [] };
    let prev = performance.now(), prevRender = performance.now();
    const or = g.render.bind(g);
    g.render = function () { const n = performance.now(); window.__t.rendered.push(n - prevRender); prevRender = n; return or(); };
    const tick = (now) => { window.__t.dt.push(now - prev); prev = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__iv = setInterval(() => window.__t.trace.push({
      t: +(g.time).toFixed(1), q: +g.quality.toFixed(2), cad: g.cadence,
      refresh: g.perf.refreshMs, miss: g.perf.missRatio, fps: g.perf.fps,
      px: g.viewW * g.viewH,
    }), 500);
  });

  const end = Date.now() + seconds * 1000;
  let holding = false;
  while (Date.now() < end) {
    const alive = await page.evaluate(() => window.game.state === 1);
    if (!alive) {
      if (holding) { await page.mouse.up(); holding = false; }
      await page.mouse.click(W / 2, H * 0.75).catch(() => {});
      await page.waitForTimeout(150);
      continue;
    }
    if (!holding) { await page.mouse.down(); holding = true; }
    await page.waitForTimeout(230 + Math.random() * 240);
    await page.mouse.up(); holding = false;
    await page.waitForTimeout(90 + Math.random() * 130);
  }
  if (holding) await page.mouse.up();

  const out = await page.evaluate(() => {
    clearInterval(window.__iv);
    const g = window.game, T = window.__t;
    const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };
    const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
    const r = T.rendered.slice(30);
    // Stutter metric: how variable the RENDERED interval is. A clean cadence — 120
    // or an exact 60 divisor — has a tight spread; landing between them does not.
    const med = pct(r, 0.5);
    const jitter = med ? +((pct(r, 0.95) - pct(r, 0.5)) / med).toFixed(3) : 0;
    return {
      quality: +g.quality.toFixed(2), cadence: g.cadence,
      refreshMs: g.perf.refreshMs, missRatio: g.perf.missRatio,
      renderedMs: { p50: pct(r, 0.5), p95: pct(r, 0.95), p99: pct(r, 0.99) },
      renderedFps: med ? +(1000 / med).toFixed(1) : 0,
      jitter,
      vsyncP50: pct(T.dt.slice(30), 0.5),
      trace: T.trace.filter((_, i) => i % 2 === 0),
    };
  });
  out.errors = errors;
  await context.close();
  return { name, ...out };
}

const SETUPS = {
  // Sustained overload: a hard CPU-side stall on every render, far past any budget.
  heavy: [() => {
    const g = window.game, or = g.render.bind(g);
    g.render = function () { or(); const t = performance.now(); while (performance.now() - t < 26); };
  }, 26],

  // Healthy, with a 40ms stall roughly every 2.5s — the isolated-hiccup case. The
  // old governor would eventually ratchet down on these; the new one must not.
  hiccups: [() => {
    const g = window.game, or = g.render.bind(g);
    let n = 0;
    g.render = function () {
      or();
      if (++n % 150 === 0) { const t = performance.now(); while (performance.now() - t < 40); }
    };
  }, 26],

  // Overload for the first 12s, then it stops. Must claw back.
  recovery: [() => {
    const g = window.game, or = g.render.bind(g);
    const t0 = performance.now();
    g.render = function () {
      or();
      if (performance.now() - t0 < 12000) { const t = performance.now(); while (performance.now() - t < 26); }
    };
  }, 40],

  // Headless cannot present at 120Hz, so pin the believed refresh there and check the
  // DECISION LADDER instead: an overloaded high-refresh panel must spend its cadence
  // first (free, keeps every pixel) and only reach for resolution once that is gone.
  cadence: [() => {
    const g = window.game, or = g.render.bind(g);
    g._refreshIdx = 1; g.refreshMs = 1000 / 120;   // pretend ProMotion
    g.render = function () { or(); const t = performance.now(); while (performance.now() - t < 12); };
  }, 26],
};

for (const c of CASES) {
  const [setup, secs] = SETUPS[c];
  const r = await run(c, setup, secs);
  console.log(`\n===== ${c.toUpperCase()} =====`);
  console.log(`final:  quality=${r.quality}  cadence=${r.cadence}  refresh=${r.refreshMs}ms  miss=${r.missRatio}`);
  console.log(`paced:  ${r.renderedFps} fps  p50=${r.renderedMs.p50}ms p95=${r.renderedMs.p95}ms p99=${r.renderedMs.p99}ms  jitter=${r.jitter}`);
  console.log(`vsync:  p50=${r.vsyncP50}ms`);
  console.log('trace:  ' + r.trace.map((x) => `${x.t}s q${x.q}/c${x.cad}/m${x.miss}`).join('  '));
  if (r.errors.length) console.log('ERRORS: ' + r.errors.slice(0, 3).join(' | '));
}
await browser.close();
