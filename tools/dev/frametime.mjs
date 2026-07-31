#!/usr/bin/env node
/**
 * ARCLIGHT frame-time probe. Instruments the live loop and reports where the
 * milliseconds go: rAF delta distribution, update vs render CPU split, GPU time
 * (timer query when available), GC-visible allocation churn, and every long frame
 * annotated with the state that produced it.
 *
 *   node tools/dev/frametime.mjs [--url ...] [--seconds 20] [--w 1440] [--h 900] [--dsf 2]
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const URL_ = args.url || 'http://localhost:8080';
const SECONDS = Number(args.seconds || 20);
const W = Number(args.w || 1440), H = Number(args.h || 900);
const DSF = Number(args.dsf || 2);

// Pass --unlimited to drop the frame cap and measure raw fill-rate ceiling instead
// of presentation behaviour. Leave it off to see what the player actually feels:
// stutter only exists relative to a vsync, so a context without one cannot show it.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--js-flags=--expose-gc',
         ...(args.unlimited ? ['--disable-frame-rate-limit'] : [])],
});
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: DSF,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(800);

// --- instrument --------------------------------------------------------------
await page.evaluate(() => {
  const g = window.game;
  const P = window.__perf = {
    dt: [], upd: [], ren: [], flushN: [], part: [], q: [],
    long: [], resizes: [], qualityChanges: [], heap: [],
    gpu: [], gpuSupported: false,
  };

  const gl = g.gl;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  P.gpuSupported = !!ext;
  let q = null, qPending = false;

  const rawUpdate = g.update.bind(g);
  const rawRender = g.render.bind(g);
  const rawResize = g.resize.bind(g);
  let lastQ = g.quality;

  g.resize = function () { P.resizes.push(P.dt.length); return rawResize(); };

  g.update = function (dt) {
    const t0 = performance.now();
    rawUpdate(dt);
    P.upd.push(performance.now() - t0);
  };

  g.render = function () {
    const t0 = performance.now();
    if (ext && !qPending) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    rawRender();
    if (ext && !qPending && q) { gl.endQuery(ext.TIME_ELAPSED_EXT); qPending = true; }
    P.ren.push(performance.now() - t0);
    P.flushN.push(g.renderer.instanceCount);
    P.part.push(g.fx.count ?? (g.fx.alive ?? -1));
    if (g.quality !== lastQ) { P.qualityChanges.push([P.dt.length, g.quality]); lastQ = g.quality; }

    if (ext && qPending && q) {
      const done = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (done) {
        if (!disjoint) P.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q); q = null; qPending = false;
      }
    }
  };

  // Raw presentation cadence, independent of the game's own smoothed frameMs.
  let prev = performance.now();
  const tick = (now) => {
    const d = now - prev; prev = now;
    P.dt.push(d);
    if (performance.memory) P.heap.push(performance.memory.usedJSHeapSize / 1048576);
    if (d > 24) {
      const i = P.dt.length - 1;
      P.long.push({
        i, dt: +d.toFixed(2),
        upd: +(P.upd[P.upd.length - 1] || 0).toFixed(2),
        ren: +(P.ren[P.ren.length - 1] || 0).toFixed(2),
        inst: P.flushN[P.flushN.length - 1],
        state: g.state, quality: g.quality,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// --- play --------------------------------------------------------------------
await page.mouse.move(W / 2, H / 2);
await page.mouse.down();
await page.waitForTimeout(120);
await page.mouse.up();
await page.waitForTimeout(300);

// Scripted thumb: hold/release rhythm so the run actually progresses.
const end = Date.now() + SECONDS * 1000;
let holding = false;
while (Date.now() < end) {
  const alive = await page.evaluate(() => window.game.state === 1);
  if (!alive) {
    if (holding) { await page.mouse.up(); holding = false; }
    await page.mouse.click(W / 2, H * 0.75).catch(() => {});
    await page.waitForTimeout(200);
    continue;
  }
  if (!holding) { await page.mouse.down(); holding = true; }
  await page.waitForTimeout(220 + Math.random() * 260);
  await page.mouse.up(); holding = false;
  await page.waitForTimeout(90 + Math.random() * 140);
}
if (holding) await page.mouse.up();

// --- report ------------------------------------------------------------------
const r = await page.evaluate(() => {
  const P = window.__perf;
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };
  const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
  const dt = P.dt.slice(60);   // drop boot
  const buckets = { 'le8.3': 0, 'le12': 0, 'le17': 0, 'le21': 0, 'le34': 0, 'gt34': 0 };
  for (const d of dt) {
    if (d <= 8.4) buckets['le8.3']++; else if (d <= 12) buckets['le12']++;
    else if (d <= 17.2) buckets['le17']++; else if (d <= 21) buckets['le21']++;
    else if (d <= 34) buckets['le34']++; else buckets['gt34']++;
  }
  return {
    frames: dt.length,
    fps: +(1000 / mean(dt)).toFixed(1),
    dt: { mean: mean(dt), p50: pct(dt, 0.5), p95: pct(dt, 0.95), p99: pct(dt, 0.99), max: +Math.max(...dt).toFixed(2) },
    updateMs: { mean: mean(P.upd.slice(60)), p95: pct(P.upd.slice(60), 0.95), max: +Math.max(...P.upd.slice(60)).toFixed(2) },
    renderMs: { mean: mean(P.ren.slice(60)), p95: pct(P.ren.slice(60), 0.95), max: +Math.max(...P.ren.slice(60)).toFixed(2) },
    gpuMs: P.gpuSupported ? { mean: mean(P.gpu), p95: pct(P.gpu, 0.95), max: +Math.max(...P.gpu).toFixed(2), n: P.gpu.length } : 'unsupported',
    instances: { mean: Math.round(mean(P.flushN.slice(60))), max: Math.max(...P.flushN.slice(60)) },
    overflow: window.game.renderer.overflow,
    buckets,
    longFrames: P.long.length,
    worstLong: P.long.sort((a, b) => b.dt - a.dt).slice(0, 12),
    qualityChanges: P.qualityChanges,
    resizeCalls: P.resizes.length,
    quality: window.game.quality,
    governor: { ...window.game.perf, cadence: window.game.cadence },
    heapMB: P.heap.length ? { first: +P.heap[0].toFixed(1), last: +P.heap[P.heap.length - 1].toFixed(1), max: +Math.max(...P.heap).toFixed(1), min: +Math.min(...P.heap).toFixed(1) } : 'n/a',
    canvas: [window.game.canvas.width, window.game.canvas.height],
    dpr: window.game.dpr,
  };
});
console.log(JSON.stringify(r, null, 2));
if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
await browser.close();
