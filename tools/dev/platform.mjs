#!/usr/bin/env node
// ARCLIGHT — iPhone-Safari platform acceptance suite.
//
// Ten independent checks, each in its own iPhone 13 Pro browser: HDR pixel readback,
// WebGL context loss/restore, audio interruption, Home Screen install metadata, silent
// playability, safe-area insets in both orientations, and touch handling.
//
//   node tools/dev/platform.mjs          run everything
//   node tools/dev/platform.mjs t4,t6    run named checks only
//
// HARNESS CONTRACT: this suite must ALWAYS terminate and ALWAYS print a summary.
// It previously did neither. Cleanup (`browser.close()`) sat on each test's success
// path only, so the first test to throw leaked a live Chromium; a leaked browser holds
// an open handle that keeps Node alive indefinitely, so the run hung after the summary
// rather than exiting, and was killed at 34 minutes with no result recorded. Three
// things below make a hang structurally impossible: every browser is tracked and closed
// in a `finally` regardless of outcome, every test races a hard per-test deadline, and
// the process exits explicitly on a code path that cannot be blocked by a stray handle.
import { chromium, devices } from 'playwright';

const URL_ = 'http://localhost:8080';
const only = process.argv[2] || 'all';
const R = [];
const say = (...a) => console.log(...a);
const rec = (id, verdict, ev) => { R.push({ id, verdict, ev }); say(`\n### ${id}: ${verdict}\n` + JSON.stringify(ev, null, 2)); };

/** Every browser ever launched, so cleanup never depends on a test reaching its end. */
const LIVE = new Set();
/** Per-test deadline. The longest legitimate test (t9, ~26ms forced frames for 9.5s)
 *  lands near 20s, so 120s is pure headroom — it only ever fires on a real hang. */
const TEST_TIMEOUT_MS = 120_000;

async function mk(opts = {}) {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
  LIVE.add(browser);
  const context = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    viewport: opts.viewport || { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  // Default is 30s per action. A missing selector then costs 30s of wall clock to
  // report something the suite already knows how to record as a FAILED verdict, and a
  // test that misses several burns minutes producing no extra information.
  context.setDefaultTimeout(8_000);
  context.setDefaultNavigationTimeout(20_000);
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  if (opts.init) await page.addInitScript(opts.init);
  return { browser, context, page, errors, logs };
}

// Instrument the frame: read back the real default-framebuffer pixels INSIDE the
// same task as render(), which is the only moment they are valid with
// preserveDrawingBuffer:false.
const PIXEL_PROBE = () => {
  const g = window.game;
  const P = window.__px = { frames: 0, sims: 0, last: null };
  const origRender = g.render.bind(g);
  const origUpdate = g.update.bind(g);
  g.update = function (dt) { P.sims++; return origUpdate(dt); };
  g.render = function () {
    origRender();
    P.frames++;
    if (!P.want) return;
    P.want = false;
    const gl = g.gl;
    const w = 96, h = 96;
    // Sample a grid across the whole frame by reading 96x96 from the centre AND
    // corners so a black centre with lit edges cannot pass.
    const boxes = [
      [((g.viewW - w) / 2) | 0, ((g.viewH - h) / 2) | 0],
      [10, 10], [g.viewW - w - 10, 10],
      [10, g.viewH - h - 10], [g.viewW - w - 10, g.viewH - h - 10],
      [((g.viewW - w) / 2) | 0, ((g.viewH * 0.75 - h / 2)) | 0],
    ];
    const buf = new Uint8Array(w * h * 4);
    let sum = 0, max = 0, nonBlack = 0, n = 0, distinct = new Set();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const [x, y] of boxes) {
      gl.readPixels(Math.max(0, x), Math.max(0, y), w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let i = 0; i < buf.length; i += 4) {
        const l = (buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722);
        sum += l; if (l > max) max = l; if (l > 8) nonBlack++; n++;
        if (n % 37 === 0) distinct.add((buf[i] >> 3) + ',' + (buf[i + 1] >> 3) + ',' + (buf[i + 2] >> 3));
      }
    }
    P.last = { mean: +(sum / n).toFixed(2), max, nonBlackPct: +(100 * nonBlack / n).toFixed(2), distinctColors: distinct.size, glError: gl.getError() };
  };
};
const grab = async (page) => page.evaluate(() => new Promise((res) => {
  window.__px.want = true;
  const t = setInterval(() => { if (!window.__px.want) { clearInterval(t); res(window.__px.last); } }, 30);
  setTimeout(() => { clearInterval(t); res(window.__px.last); }, 3000);
}));

async function boot(page, { play = true } = {}) {
  await page.goto(URL_, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(900);
  await page.evaluate(PIXEL_PROBE);
  if (play) {
    await page.getByRole('button', { name: /launch/i }).first().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.game.input.down = true; });
    await page.waitForTimeout(900);
  }
}

// ===========================================================================
// 1. WebGL context loss / restore
// ===========================================================================
async function t1() {
  const { browser, page, errors } = await mk();
  await boot(page);
  const before = await grab(page);

  const armed = await page.evaluate(() => {
    const c = document.getElementById('gl');
    window.__loss = { pd: null, restoredPd: null, seenLost: 0, seenRestored: 0 };
    // Registered AFTER the game's handler on the same target, so it observes
    // whether the game called preventDefault().
    c.addEventListener('webglcontextlost', (e) => {
      window.__loss.seenLost++;
      window.__loss.pd = e.defaultPrevented;
    }, false);
    c.addEventListener('webglcontextrestored', () => { window.__loss.seenRestored++; }, false);
    const g = window.game;
    window.__ids = { renderer: g.renderer, post: g.post, quad: g.quad };
    window.__ext = g.gl.getExtension('WEBGL_lose_context');
    return !!window.__ext;
  });

  const pre = await page.evaluate(() => {
    const g = window.game;
    return { x: g.player.x, y: g.player.y, time: g.time, sims: window.__px.sims, frames: window.__px.frames, state: g.state };
  });

  await page.evaluate(() => window.__ext.loseContext());
  await page.waitForTimeout(700);

  const during = await page.evaluate(() => {
    const g = window.game;
    return {
      lost: g.glLost.lost, losses: g.glLost.losses, preventDefaulted: window.__loss.pd,
      x: g.player.x, y: g.player.y, time: g.time,
      sims: window.__px.sims, frames: window.__px.frames,
      isContextLost: g.gl.isContextLost(),
    };
  });

  await page.evaluate(() => window.__ext.restoreContext());
  await page.waitForTimeout(1500);

  const after = await page.evaluate(() => {
    const g = window.game;
    return {
      lost: g.glLost.lost, restores: g.glLost.restores,
      rendererNew: g.renderer !== window.__ids.renderer,
      postNew: g.post !== window.__ids.post,
      quadNew: g.quad !== window.__ids.quad,
      hdr: g.hdrSupported, postW: g.post.w, postH: g.post.h, mip0: [g.post.mipW[0], g.post.mipH[0]],
      isContextLost: g.gl.isContextLost(),
      sims: window.__px.sims, frames: window.__px.frames,
      state: g.state, x: g.player.x,
    };
  });
  await page.evaluate(() => { window.game.input.down = true; });
  await page.waitForTimeout(800);
  const afterPix = await grab(page);

  const simsWhileDark = during.sims - pre.sims;
  const framesWhileDark = during.frames - pre.frames;
  const live = afterPix && afterPix.nonBlackPct > 1 && afterPix.mean > 1 && afterPix.distinctColors > 3;
  const verdict = (during.preventDefaulted === true && simsWhileDark === 0 && framesWhileDark === 0 &&
                   after.lost === false && after.rendererNew && after.postNew && after.quadNew && live && errors.length === 0)
    ? 'VERIFIED' : 'FAILED';
  rec('CLAIM 1 — context loss recovery', verdict, {
    lossEventPreventDefaulted: during.preventDefaulted,
    simulatedFramesWhileDark: simsWhileDark, renderedFramesWhileDark: framesWhileDark,
    playerFrozenWhileDark: pre.x === during.x && pre.y === during.y && pre.time === during.time,
    restores: after.restores, lostFlagCleared: after.lost === false,
    rebuilt: { renderer: after.rendererNew, post: after.postNew, quad: after.quadNew },
    postTargetsAfter: { w: after.postW, h: after.postH, mip0: after.mip0, hdr: after.hdr },
    pixelsBeforeLoss: before, pixelsAfterRestore: afterPix,
    consoleErrors: errors,
  });
  await browser.close();
}

// ===========================================================================
// 2. Audio survives an iOS audio-session interruption (no visibilitychange)
// ===========================================================================
async function t2() {
  const { browser, page, errors } = await mk();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /launch/i }).first().click();
  await page.waitForTimeout(900);

  const s0 = await page.evaluate(() => {
    const a = window.game.audio;
    window.__vis = 0;
    document.addEventListener('visibilitychange', () => { window.__vis++; }, false);
    return { hasCtx: !!a._ctx, state: a._ctx && a._ctx.state, unlocked: a._unlocked, timer: !!a._timer, enabled: a._enabled };
  });

  // The phone-call case: the session is pulled, the page never hides.
  const s1 = await page.evaluate(async () => {
    const a = window.game.audio;
    await a._ctx.suspend();
    return { state: a._ctx.state, hidden: document.hidden, visEvents: window.__vis, timer: !!a._timer };
  });
  await page.waitForTimeout(400);
  const s1b = await page.evaluate(() => ({ state: window.game.audio._ctx.state, timer: !!window.game.audio._timer, visEvents: window.__vis }));

  // Synthetic capture-phase pointerdown on the canvas (not the page-level wake).
  await page.evaluate(() => {
    const c = document.getElementById('gl');
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'touch' }));
  });
  await page.waitForTimeout(600);
  const s2 = await page.evaluate(() => {
    const a = window.game.audio;
    return { state: a._ctx.state, timer: !!a._timer, currentTime: a._ctx.currentTime };
  });

  // Second interruption, resolved by a REAL trusted touch instead.
  await page.evaluate(async () => { await window.game.audio._ctx.suspend(); });
  await page.waitForTimeout(300);
  const s3pre = await page.evaluate(() => window.game.audio._ctx.state);
  await page.touchscreen.tap(195, 600);
  await page.waitForTimeout(600);
  const s3 = await page.evaluate(() => ({ state: window.game.audio._ctx.state, timer: !!window.game.audio._timer }));

  const verdict = (s2.state === 'running' && s2.timer && s3.state === 'running' && s1.visEvents === 0) ? 'VERIFIED' : 'FAILED';
  rec('CLAIM 2 — audio survives session interruption', verdict, {
    afterUnlock: s0,
    afterSuspend: s1, after400ms: s1b,
    note_statechangeAutoWake: s1b.state === 'running'
      ? 'the statechange->wake path already resumed it before any pointer arrived'
      : 'still suspended; pointer is doing the work',
    afterSyntheticCapturePointerdown: s2,
    beforeRealTap: s3pre, afterRealTap: s3,
    visibilitychangeEventsFired: s1.visEvents,
    consoleErrors: errors,
  });
  await browser.close();
}

// 2b. Isolate the POINTER wake path: make resume() reject while the "call" is
// active (this is what iOS actually does), so statechange->wake cannot succeed.
async function t2b() {
  const { browser, page, errors } = await mk();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /launch/i }).first().click();
  await page.waitForTimeout(900);

  const r = await page.evaluate(async () => {
    const a = window.game.audio, ctx = a._ctx;
    const real = ctx.resume.bind(ctx);
    window.__resumeCalls = 0;
    window.__interrupted = true;
    ctx.resume = function () {
      window.__resumeCalls++;
      if (window.__interrupted) return Promise.reject(new Error('interrupted'));
      return real();
    };
    await ctx.suspend();
    return { state: ctx.state, calls: window.__resumeCalls };
  });
  await page.waitForTimeout(700);
  const stillDown = await page.evaluate(() => ({ state: game.audio._ctx.state, calls: window.__resumeCalls, timer: !!game.audio._timer }));
  // "Call ends" — resume would now work, but nothing re-fires until a touch.
  await page.evaluate(() => { window.__interrupted = false; });
  await page.waitForTimeout(700);
  const idle = await page.evaluate(() => ({ state: game.audio._ctx.state, calls: window.__resumeCalls, timer: !!game.audio._timer }));
  await page.touchscreen.tap(195, 620);
  await page.waitForTimeout(700);
  const tapped = await page.evaluate(() => ({ state: game.audio._ctx.state, calls: window.__resumeCalls, timer: !!game.audio._timer, ct: game.audio._ctx.currentTime }));
  const verdict = (stillDown.state === 'suspended' && idle.state === 'suspended' && tapped.state === 'running' && tapped.timer) ? 'VERIFIED' : 'FAILED';
  rec('CLAIM 2b — pointer wake in isolation (resume() rejected during interruption)', verdict, {
    afterSuspendWithResumeRejecting: r, after700ms: stillDown,
    afterInterruptionEndsButNoTouch: idle,
    afterRealTouch: tapped, consoleErrors: errors,
  });
  await browser.close();
}

// ===========================================================================
// 3. Press-and-hold LAUNCH -> tether, no lift
// ===========================================================================
async function t3() {
  const { browser, page, errors } = await mk();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    window.__trace = [];
    const g = window.game;
    const oa = g.input.adopt.bind(g.input);
    g.input.adopt = function (id) { window.__trace.push(['adopt', id === undefined ? 'undefined' : id]); return oa(id); };
    window.addEventListener('pointerdown', (e) => window.__trace.push(['win-pointerdown', e.pointerId, e.target.tagName + '.' + e.target.className]), true);
    window.addEventListener('pointerup', (e) => window.__trace.push(['win-pointerup', e.pointerId]), true);
  });

  const box = await page.locator('button.btn').first().boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 12, radiusY: 12, force: 1, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });

  const samples = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(150);
    samples.push(await page.evaluate(() => {
      const g = window.game;
      return { t: +performance.now().toFixed(0), state: g.state, down: g.input.down, ptrs: g.input._pointers.size, tethered: g.player.tethered, x: +g.player.x.toFixed(1), dist: +g.distance.toFixed(1) };
    }));
  }
  const held = await page.evaluate(() => {
    const g = window.game;
    return { down: g.input.down, ptrs: [...g.input._pointers], tethered: g.player.tethered, state: g.state, dist: g.distance, trace: window.__trace };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  const released = await page.evaluate(() => ({ down: window.game.input.down, ptrs: [...window.game.input._pointers] }));

  const everDropped = samples.some((s) => s.state === 1 && !s.down);
  const tetheredWhileHeld = samples.some((s) => s.tethered);
  const verdict = (held.down && tetheredWhileHeld && !everDropped && released.down === false) ? 'VERIFIED' : 'FAILED';
  rec('CLAIM 3 — hold LAUNCH flows into tether', verdict, {
    everDroppedInputWhilePlaying: everDropped,
    tetheredWithoutLifting: tetheredWhileHeld,
    stillDownAfter2s: held.down, pointerIdsHeld: held.ptrs,
    distanceTravelledWhileHeld: +held.dist.toFixed(1),
    releaseClearsDown: released.down === false, pointersAfterRelease: released.ptrs,
    samples, adoptTrace: held.trace,
    consoleErrors: errors,
  });
  await browser.close();
}

// ===========================================================================
// 4. Home Screen install sanity
// ===========================================================================
async function t4() {
  const { browser, page, errors } = await mk();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  const head = await page.evaluate(() => {
    const abs = (h) => new URL(h, location.href).href;
    return {
      appleTouchIcons: [...document.querySelectorAll('link[rel~="apple-touch-icon"]')].map((l) => ({ href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes'), rel: l.rel })),
      icons: [...document.querySelectorAll('link[rel~="icon"]')].map((l) => ({ href: abs(l.getAttribute('href')), type: l.type, sizes: l.getAttribute('sizes') })),
      manifest: (document.querySelector('link[rel="manifest"]') || {}).href,
      themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content,
      viewport: (document.querySelector('meta[name="viewport"]') || {}).content,
      appleCapable: (document.querySelector('meta[name="apple-mobile-web-app-capable"]') || {}).content,
      statusBar: (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content,
      appleTitle: (document.querySelector('meta[name="apple-mobile-web-app-title"]') || {}).content,
    };
  });
  const fetchAll = async (urls) => {
    const out = [];
    for (const u of urls) {
      const r = await page.request.get(u);
      const body = await r.body().catch(() => Buffer.alloc(0));
      const isPng = body.length > 8 && body[0] === 0x89 && body[1] === 0x50;
      let dims = null;
      if (isPng) dims = `${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`;
      out.push({ url: u.replace(URL_, ''), status: r.status(), ct: r.headers()['content-type'], bytes: body.length, realPng: isPng, pixelDims: dims });
    }
    return out;
  };
  const mf = await (await page.request.get(head.manifest)).json();
  const iconChecks = await fetchAll([
    ...head.appleTouchIcons.map((i) => i.href),
    ...head.icons.map((i) => i.href),
    ...mf.icons.map((i) => new URL(i.src, head.manifest).href),
  ]);
  const svgOnly = mf.icons.every((i) => /svg/.test(i.type || '') || /\.svg$/.test(i.src));
  const allOk = iconChecks.every((c) => c.status === 200);
  const pngIcons = iconChecks.filter((c) => c.realPng);
  const badDims = iconChecks.filter((c) => c.realPng && c.pixelDims && !c.url.includes(c.pixelDims.split('x')[0]));
  const verdict = (head.appleTouchIcons.length > 0 && allOk && !svgOnly && head.themeColor &&
                   /viewport-fit=cover/.test(head.viewport) && pngIcons.length >= 4) ? 'VERIFIED' : 'FAILED';
  rec('CLAIM 4 — Home Screen install', verdict, {
    head, manifestIcons: mf.icons, manifestDisplay: mf.display, manifestOrientation: mf.orientation,
    manifestThemeColor: mf.theme_color, manifestStartUrl: mf.start_url, manifestId: mf.id,
    resourceChecks: iconChecks, svgOnlyIconSet: svgOnly, mismatchedDeclaredSizes: badDims,
    consoleErrors: errors,
  });
  await browser.close();
}

// ===========================================================================
// 5. Fully playable SILENT — no AudioContext ever constructed, zero errors
// ===========================================================================
async function t5() {
  const results = {};
  for (const mode of ['muted-pref', 'no-webaudio']) {
    const init = mode === 'muted-pref'
      ? () => {
          try { localStorage.setItem('arclight.audio', '0'); } catch (e) {}
          window.__ac = [];
          for (const k of ['AudioContext', 'webkitAudioContext']) {
            const Orig = window[k];
            if (!Orig) continue;
            const W = function (...a) { window.__ac.push(k); return new Orig(...a); };
            W.prototype = Orig.prototype;
            Object.defineProperty(window, k, { value: W, writable: true, configurable: true });
          }
        }
      : () => {
          window.__ac = [];
          delete window.AudioContext; delete window.webkitAudioContext;
          Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
          Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
        };
    const { browser, page, errors } = await mk({ init });
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.evaluate(PIXEL_PROBE);
    await page.getByRole('button', { name: /launch/i }).first().click();
    await page.waitForTimeout(400);
    // Play for a while with a real bot.
    await page.evaluate(() => {
      const g = window.game; g.__on = true;
      const step = () => { if (!g.__on) return; if (g.state === 3) g.start(); g.input.down = (performance.now() % 900) < 620; setTimeout(step, 16); };
      step();
    });
    await page.waitForTimeout(9000);
    const st = await page.evaluate(() => {
      const g = window.game; g.__on = false;
      return {
        acConstructions: window.__ac.length, acKinds: window.__ac,
        audioCtx: g.audio._ctx === null ? null : 'EXISTS', dead: g.audio._dead, built: g.audio._built,
        enabled: g.audio._enabled, timer: !!g.audio._timer,
        distance: Math.round(g.distance), score: Math.round(g.score), state: g.state,
        frames: window.__px.frames, quality: g.quality,
        nan: [g.player.x, g.player.y, g.zoom, g.score].some((v) => !Number.isFinite(v)),
      };
    });
    const pix = await grab(page);
    results[mode] = { ...st, pixels: pix, consoleErrors: errors };
    await browser.close();
  }
  const ok = results['muted-pref'].acConstructions === 0 && results['muted-pref'].consoleErrors.length === 0 &&
             results['muted-pref'].distance > 20 &&
             results['no-webaudio'].consoleErrors.length === 0 && results['no-webaudio'].distance > 20;
  rec('CLAIM 5 — playable silent', ok ? 'VERIFIED' : 'FAILED', results);
}

// ===========================================================================
// 6. Safe areas, portrait + landscape
// ===========================================================================
const SAFE_CSS = (t, r, b, l) => `:root{--sat:${t}px !important;--sar:${r}px !important;--sab:${b}px !important;--sal:${l}px !important;}`;
async function t6() {
  const out = {};
  const cases = [
    { name: 'portrait', vp: { width: 393, height: 852 }, ins: [59, 0, 34, 0] },
    { name: 'landscape', vp: { width: 852, height: 393 }, ins: [0, 59, 21, 59] },
  ];
  for (const c of cases) {
    const { browser, page, errors } = await mk({ viewport: c.vp });
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: SAFE_CSS(...c.ins) });
    await page.waitForTimeout(900);
    const measure = async (label) => page.evaluate(([ins, label]) => {
      const [T, Rt, B, L] = ins;
      const W = innerWidth, H = innerHeight;
      const sel = {
        'distance readout': '.hud-dist-val',
        'score': '.hud-score',
        'multiplier': '.hud-mult',
        'charge meter': '.hud-charge',
        'charge label': '.hud-charge-label',
        'O/D ring': '.hud-od',
        'audio button': '.audio-btn',
        'primary button (LAUNCH/RETRY)': '.scr.is-in .btn',
        'button hint': '.scr.is-in .btn-hint',
        'brand': '.scr.is-in .brand-title',
        'HOW panel': '.scr--title.is-in .panel',
      };
      const res = {};
      for (const k in sel) {
        const e = document.querySelector(sel[k]);
        if (!e) { res[k] = 'absent'; continue; }
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        res[k] = {
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          opacity: +cs.opacity, visibility: cs.visibility,
          intoTopInset: Math.max(0, Math.round(T - r.top)),
          intoBottomInset: Math.max(0, Math.round(r.bottom - (H - B))),
          intoLeftInset: Math.max(0, Math.round(L - r.left)),
          intoRightInset: Math.max(0, Math.round(r.right - (W - Rt))),
          offscreen: r.left < 0 || r.top < 0 || r.right > W + 0.5 || r.bottom > H + 0.5,
        };
      }
      res.__viewport = [W, H];
      res.__envResolved = getComputedStyle(document.documentElement).getPropertyValue('--sat').trim();
      res.__screen = label;
      return res;
    }, [c.ins, label]);

    out[c.name] = { title: await measure('title') };
    // Now play + die so the HUD and the game-over screen can be measured.
    await page.getByRole('button', { name: /launch/i }).first().click();
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.game.input.down = true; window.game.multiplier = 12; window.game.charge = 1; window.game.chargeFull = true; window.game.overdriveActive = true; window.game.overdrive = 6; window.game.distance = 8888; });
    await page.waitForTimeout(700);
    out[c.name].hud = await measure('hud+overdrive');
    await page.evaluate(() => { window.game.input.down = false; window.game.die(window.game.player.x, window.game.player.y, 0, 0); });
    await page.waitForTimeout(2200);
    out[c.name].gameover = await measure('game over');
    out[c.name].consoleErrors = errors;
    await browser.close();
  }
  const bad = [];
  for (const k in out) for (const sc of ['title', 'hud', 'gameover']) {
    for (const el in out[k][sc]) {
      const v = out[k][sc][el];
      if (!v || typeof v !== 'object') continue;
      if (v.opacity < 0.02 || v.visibility === 'hidden') continue;
      if (v.intoTopInset || v.intoBottomInset || v.intoLeftInset || v.intoRightInset || v.offscreen) {
        bad.push(`${k}/${sc}/${el}: top+${v.intoTopInset} bottom+${v.intoBottomInset} left+${v.intoLeftInset} right+${v.intoRightInset} offscreen=${v.offscreen} rect=${v.rect}`);
      }
    }
  }
  rec('CLAIM 6 — safe areas', bad.length ? 'FAILED' : 'VERIFIED', { violations: bad, detail: out });
}

// ===========================================================================
// 7. No layout overflow / document scroll
// ===========================================================================
async function t7() {
  const sizes = [[390, 844], [375, 667], [360, 780], [320, 568]];
  const out = {};
  for (const [w, h] of sizes) {
    const { browser, page, errors } = await mk({ viewport: { width: w, height: h } });
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const snap = async (label) => page.evaluate((label) => {
      const de = document.documentElement, b = document.body;
      window.scrollTo(0, 999); window.scrollTo(999, 0);
      const overflowing = [];
      for (const e of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.02) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const dx = Math.max(0, Math.round(r.right - innerWidth), Math.round(-r.left));
        const dy = Math.max(0, Math.round(r.bottom - innerHeight), Math.round(-r.top));
        if (dx > 1 || dy > 1) overflowing.push(`${e.tagName.toLowerCase()}.${(e.className || '').toString().slice(0, 40)} dx=${dx} dy=${dy}`);
      }
      return {
        screen: label,
        innerWH: [innerWidth, innerHeight],
        docScroll: [de.scrollWidth, de.scrollHeight, de.clientWidth, de.clientHeight],
        bodyScroll: [b.scrollWidth, b.scrollHeight, b.clientWidth, b.clientHeight],
        scrolled: [scrollX, scrollY],
        docOverflowX: de.scrollWidth > de.clientWidth, docOverflowY: de.scrollHeight > de.clientHeight,
        bodyOverflowX: b.scrollWidth > b.clientWidth, bodyOverflowY: b.scrollHeight > b.clientHeight,
        htmlTouchAction: getComputedStyle(de).touchAction,
        bodyTouchAction: getComputedStyle(b).touchAction,
        overscroll: getComputedStyle(b).overscrollBehavior,
        overflowing,
      };
    }, label);
    const title = await snap('title');
    await page.getByRole('button', { name: /launch/i }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.game.input.down = true; window.game.distance = 99999; window.game.multiplier = 12; window.game.score = 9999999; });
    await page.waitForTimeout(700);
    const hud = await snap('hud');
    await page.evaluate(() => { window.game.die(window.game.player.x, window.game.player.y, 0, 0); });
    await page.waitForTimeout(2200);
    const over = await snap('gameover');
    out[`${w}x${h}`] = { title, hud, over, consoleErrors: errors };
    await browser.close();
  }
  const bad = [];
  for (const k in out) for (const sc of ['title', 'hud', 'over']) {
    const s = out[k][sc];
    if (s.docOverflowX || s.docOverflowY || s.bodyOverflowX || s.bodyOverflowY) bad.push(`${k}/${sc}: doc=${s.docScroll} body=${s.bodyScroll}`);
    if (s.scrolled[0] || s.scrolled[1]) bad.push(`${k}/${sc}: page scrolled to ${s.scrolled}`);
    if (s.overflowing.length) bad.push(`${k}/${sc}: ${s.overflowing.join(' | ')}`);
  }
  rec('CLAIM 7 — no overflow / scroll', bad.length ? 'FAILED' : 'VERIFIED', { violations: bad, detail: out });
}

// ===========================================================================
// 8. Backgrounding
// ===========================================================================
async function t8() {
  const { browser, page, errors } = await mk();
  await boot(page);
  await page.evaluate(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
  });
  const pre = await page.evaluate(() => {
    const g = window.game;
    return { x: g.player.x, y: g.player.y, dist: g.distance, audio: g.audio._ctx && g.audio._ctx.state, timer: !!g.audio._timer, down: g.input.down };
  });
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(800);
  const hidden = await page.evaluate(() => {
    const g = window.game;
    return { audio: g.audio._ctx && g.audio._ctx.state, timer: !!g.audio._timer, down: g.input.down, ptrs: g.input._pointers.size, x: g.player.x };
  });
  // Simulate the huge stalled dt a real background produces.
  const jump = await page.evaluate(() => new Promise((res) => {
    const g = window.game;
    const x0 = g.player.x, y0 = g.player.y;
    g.lastT = performance.now() - 8000;          // 8s of un-simulated wall clock
    window.__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      res({ x0, y0, x1: g.player.x, y1: g.player.y, dx: +(g.player.x - x0).toFixed(2), dy: +(g.player.y - y0).toFixed(2), lastTPatched: true });
    }));
  }));
  // Control: what would an unswallowed 8s dt do? (loop clamps rawDt to 1/20 s.)
  const clampCheck = await page.evaluate(() => new Promise((res) => {
    const g = window.game;
    const x0 = g.player.x;
    g.lastT = performance.now() - 8000;          // NO visibilitychange this time
    requestAnimationFrame(() => requestAnimationFrame(() => res({ dxWithoutSwallow: +(g.player.x - x0).toFixed(2) })));
  }));
  await page.waitForTimeout(900);
  const back = await page.evaluate(() => {
    const g = window.game;
    return { audio: g.audio._ctx && g.audio._ctx.state, timer: !!g.audio._timer, state: g.state, x: g.player.x };
  });
  const ok = hidden.audio === 'suspended' && back.audio === 'running' && Math.abs(jump.dx) < 30 && hidden.down === false;
  rec('CLAIM 8 — backgrounding', ok ? 'VERIFIED' : 'FAILED', {
    pre, whileHidden: hidden, onReturn: jump, controlNoSwallow: clampCheck, after: back,
    inputReleasedOnHide: hidden.down === false, pointersCleared: hidden.ptrs,
    consoleErrors: errors,
  });
  await browser.close();
}

// ===========================================================================
// 9. Extra hunting
// ===========================================================================
async function t9() {
  const { browser, page, errors } = await mk();
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const styles = await page.evaluate(() => {
    const out = [];
    const walk = (e) => {
      const cs = getComputedStyle(e);
      out.push({
        sel: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : ''),
        touchAction: cs.touchAction, userSelect: cs.webkitUserSelect || cs.userSelect,
        callout: cs.webkitTouchCallout, pointerEvents: cs.pointerEvents,
        tapHighlight: cs.webkitTapHighlightColor, overscroll: cs.overscrollBehavior,
      });
      for (const c of e.children) walk(c);
    };
    walk(document.documentElement);
    return out.filter((s) => s.touchAction !== 'none' || s.pointerEvents === 'auto');
  });

  // Multi-touch behaviour.
  const cdp = await page.context().newCDPSession(page);
  await page.getByRole('button', { name: /launch/i }).first().click();
  await page.waitForTimeout(500);
  const P = (id, x, y) => ({ x, y, radiusX: 10, radiusY: 10, force: 1, id });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(1, 120, 500)] });
  await page.waitForTimeout(120);
  const one = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(1, 120, 500), P(2, 280, 620)] });
  await page.waitForTimeout(120);
  const two = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [P(2, 280, 620)] });
  await page.waitForTimeout(120);
  const liftedSecond = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
  const liftedAll = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));

  // pointercancel leak
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(5, 200, 500)] });
  await page.waitForTimeout(100);
  // CDP rejects a touchCancel that carries touch points ("TouchCancel must not have
  // any touch points") — the cancel applies to whatever is currently down, so the list
  // is always empty. Passing the point being cancelled threw and took the whole check
  // out as a HARNESS ERROR, which read like a product failure in the summary.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(150);
  const afterCancel = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));

  // A UI touch that never registers, released while a gameplay finger is held.
  await page.evaluate(() => { game.input.down = false; game.input._pointers.clear(); });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(7, 200, 500)] });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    // A pointerup for a pointer id the Input never adopted (e.g. a UI-targeted touch).
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 999 }));
  });
  await page.waitForTimeout(80);
  const strayUp = await page.evaluate(() => ({ down: game.input.down, n: game.input._pointers.size }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // Memory footprint at DPR3 / resolution scaling
  const gpu = await page.evaluate(() => {
    const g = window.game;
    const bpp = g.post.hdr ? 8 : 4;
    let bytes = g.post.w * g.post.h * bpp;
    const mips = [];
    for (let i = 0; i < g.post.mipW.length; i++) { mips.push([g.post.mipW[i], g.post.mipH[i]]); bytes += g.post.mipW[i] * g.post.mipH[i] * bpp; }
    return {
      devicePixelRatio, cappedDpr: g.dpr, quality: g.quality,
      cssSize: [g.cssW, g.cssH], backingStore: [g.canvas.width, g.canvas.height],
      hdr: g.post.hdr, sceneTarget: [g.post.w, g.post.h], mips,
      renderTargetMB: +(bytes / 1048576).toFixed(2),
      defaultFbMB: +(g.canvas.width * g.canvas.height * 4 * 2 / 1048576).toFixed(2),
      instanceBufferMB: +((g.renderer.data ? g.renderer.data.byteLength : 0) / 1048576).toFixed(2),
    };
  });

  // Does resolution scaling actually engage under load?
  await page.evaluate(() => {
    const g = window.game;
    window.__q = [];
    const or = g.render.bind(g);
    g.render = function () { or(); const t = performance.now(); while (performance.now() - t < 26); };  // force ~26ms frames
    const iv = setInterval(() => window.__q.push({ q: g.quality, postQ: g.post.quality, w: g.post.w, mip0: g.post.mipW[0], frameMs: +g.frameMs.toFixed(1), cadence: g.cadence, miss: g.perf.missRatio, refresh: g.perf.refreshMs }), 250);
    setTimeout(() => clearInterval(iv), 14000);
  });
  // The governor now judges over multi-second windows by design, so a degradation
  // test has to run longer than one window to observe anything at all.
  await page.waitForTimeout(14500);
  const qTrace = await page.evaluate(() => window.__q);

  rec('EXTRA — hunting', 'INFO', {
    elementsWithoutTouchActionNoneOrInteractive: styles,
    multiTouch: { oneFinger: one, twoFingers: two, liftedSecond, liftedAll },
    pointercancel: afterCancel,
    strayPointerupForUnknownId: strayUp,
    gpuFootprint: gpu,
    resolutionScalingUnderLoad: { first: qTrace[0], last: qTrace[qTrace.length - 1], trace: qTrace },
    consoleErrors: errors,
  });
  await browser.close();
}

const tests = { t1, t2, t2b, t3, t4, t5, t6, t7, t8, t9 };
const run = only === 'all' ? Object.keys(tests) : only.split(',');

/** Close everything still open. Runs after every test, pass or fail. */
async function reap() {
  for (const b of LIVE) {
    try { await b.close(); } catch { /* already gone; nothing to salvage */ }
    LIVE.delete(b);
  }
}

for (const k of run) {
  if (!tests[k]) { say(`\n### ${k}: NO SUCH TEST`); continue; }
  const t0 = Date.now();
  let timer;
  try {
    // A timed-out test is recorded as a HANG and the suite moves on. Losing one
    // result is a strictly better outcome than losing the whole run, which is what
    // happened before: one stuck await took all ten checks down with it.
    await Promise.race([
      tests[k](),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    const hung = /timed out after/.test(e.message || '');
    rec(k, hung ? 'HANG' : 'HARNESS ERROR', { error: e.stack || e.message, elapsedMs: Date.now() - t0 });
  } finally {
    clearTimeout(timer);
    await reap();
  }
  say(`--- ${k} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

say('\n=== SUMMARY ===');
for (const r of R) say(`${r.verdict.padEnd(14)} ${r.id}`);
const failed = R.filter((r) => r.verdict !== 'VERIFIED' && r.verdict !== 'INFO');
say(`\n${R.length - failed.length}/${R.length} verified` + (failed.length ? `, ${failed.length} need attention` : ''));

// Explicit exit. Anything still holding the event loop open at this point (a stray
// Chromium pipe, a pending page listener) would otherwise hang the process AFTER the
// summary — which is indistinguishable, from the outside, from the suite itself hanging.
await reap();
process.exit(failed.length ? 1 : 0);
