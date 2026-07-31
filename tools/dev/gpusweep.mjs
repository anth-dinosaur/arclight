#!/usr/bin/env node
/**
 * Where does the GPU time go, and what resolution buys 120fps?
 * Times the scene pass and the post chain separately via timer queries, then
 * sweeps effective DPR to find the fill-rate budget.
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const W = Number(args.w || 1440), H = Number(args.h || 900);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.goto(args.url || 'http://localhost:8080', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.mouse.click(W / 2, H / 2);
await page.waitForTimeout(400);

// Split the frame: time scene-draw and post-chain independently.
const split = await page.evaluate(async () => {
  const g = window.game, gl = g.gl;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return 'no timer query';
  const rawFlush = g.renderer.flush.bind(g.renderer);
  const rawPost = g.post.render.bind(g.post);
  const S = { scene: [], post: [] };

  async function timed(fn) {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    fn();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const v = gl.getParameter(ext.GPU_DISJOINT_EXT) ? null
          : gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q); return v;
      }
    }
    gl.deleteQuery(q); return null;
  }

  // Sample by swapping in a timed wrapper for a handful of frames each.
  for (let n = 0; n < 8; n++) {
    let sceneT = null, postT = null;
    g.renderer.flush = (glx) => { sceneT = 'pending'; return rawFlush(glx); };
    await new Promise((r) => requestAnimationFrame(r));
    g.renderer.flush = rawFlush;

    // Measure scene-only and post-only by timing each in isolation on a live frame.
    const a = await timed(() => rawFlush(gl));
    const b = await timed(() => rawPost(gl, g.postState));
    if (a != null) S.scene.push(a);
    if (b != null) S.post.push(b);
  }
  const m = (x) => x.length ? +(x.reduce((p, c) => p + c, 0) / x.length).toFixed(2) : null;
  return {
    sceneMs: m(S.scene), postMs: m(S.post),
    target: [g.viewW, g.viewH], mp: +((g.viewW * g.viewH) / 1e6).toFixed(2),
    instances: g.renderer.instanceCount,
  };
});
console.log('=== frame split @ DPR 2 ===');
console.log(JSON.stringify(split, null, 2));

// --- DPR sweep: measure sustained GPU ms/frame at each effective resolution ---
console.log('\n=== DPR sweep (sustained GPU ms/frame) ===');
for (const dpr of [2.0, 1.5, 1.25, 1.0, 0.75]) {
  const res = await page.evaluate(async (targetDpr) => {
    const g = window.game, gl = g.gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    // Force the backing store to the requested effective DPR.
    const rect = g.canvas.getBoundingClientRect();
    const w = Math.round(rect.width * targetDpr), h = Math.round(rect.height * targetDpr);
    g.canvas.width = w; g.canvas.height = h;
    g.viewW = w; g.viewH = h; g.dpr = targetDpr;
    g.post.resize(w, h);
    const aspect = w / h;
    g.baseZoom = aspect < 0.75 ? w / 46 : h / (46 / 0.62);
    await new Promise((r) => setTimeout(r, 400));

    const samples = [];
    for (let n = 0; n < 10; n++) {
      const q = gl.createQuery();
      await new Promise((r) => requestAnimationFrame(r));
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      g.render();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          break;
        }
      }
      gl.deleteQuery(q);
    }
    samples.sort((a, b) => a - b);
    return {
      dpr: targetDpr, px: `${w}x${h}`, mp: +((w * h) / 1e6).toFixed(2),
      gpuMedian: samples.length ? +samples[samples.length >> 1].toFixed(2) : null,
      n: samples.length,
    };
  }, dpr);
  const hz = res.gpuMedian ? (1000 / res.gpuMedian).toFixed(0) : '?';
  console.log(`DPR ${res.dpr.toFixed(2)}  ${res.px.padEnd(11)} ${String(res.mp).padStart(5)}MP  GPU ${String(res.gpuMedian).padStart(6)}ms  -> ~${hz} fps ceiling`);
}
await browser.close();
