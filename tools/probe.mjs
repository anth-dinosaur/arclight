#!/usr/bin/env node
/**
 * ARCLIGHT probe — headless playthrough capture.
 *
 * Loads the game at iPhone dimensions, plays it with a scripted thumb, records
 * console errors, frame times and primitive counts, and writes screenshots.
 *
 *   node tools/probe.mjs [--url http://localhost:8080] [--out shots] [--seconds 22]
 *                        [--bot smart|metronome] [--shots 8]
 */
import { chromium, devices } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const URL_ = args.url || 'http://localhost:8080';
const OUT = resolve(args.out || 'shots');
const SECONDS = Number(args.seconds || 22);
const SHOTS = Number(args.shots || 8);
const BOT = args.bot || 'smart';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
// iPhone 14 Pro logical viewport.
const context = await browser.newContext({
  ...devices['iPhone 13 Pro'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL_, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(1200);

// --- boot health -------------------------------------------------------------
const boot = await page.evaluate(() => {
  const g = window.game;
  const c = document.getElementById('gl');
  const gl = c && c.getContext('webgl2');
  return {
    gameExists: !!g,
    hdr: g ? g.hdrSupported : null,
    canvas: c ? { w: c.width, h: c.height } : null,
    glError: gl ? gl.getError() : 'no-context',
    fatal: !!document.querySelector('div[style*="ff2d95"]'),
    fatalText: (document.body.innerText || '').slice(0, 400),
  };
});

await page.screenshot({ path: `${OUT}/00-title.png` });

// --- install an instrumentation probe ---------------------------------------
await page.evaluate(() => {
  const g = window.game;
  if (!g) return;
  const P = { frames: 0, times: [], instances: [], worst: 0, states: [], deaths: 0,
              maxDist: 0, maxCombo: 0, overdrives: 0, sawOverdrive: false };
  window.__probe = P;
  let last = performance.now();
  const origRender = g.render.bind(g);
  g.render = function () {
    const t0 = performance.now();
    origRender();
    const t1 = performance.now();
    P.frames++;
    P.times.push(t1 - last);
    last = t1;
    P.instances.push(g.renderer.instanceCount);
    if (g.renderer.overflow > P.worst) P.worst = g.renderer.overflow;
    if (g.distance > P.maxDist) P.maxDist = g.distance;
    if (g.multiplier > P.maxCombo) P.maxCombo = g.multiplier;
    if (g.overdriveActive && !P.sawOverdrive) { P.overdrives++; P.sawOverdrive = true; }
    if (!g.overdriveActive) P.sawOverdrive = false;
    if (P.times.length > 6000) { P.times.shift(); P.instances.shift(); }

    // NaN anywhere in the camera or player silently blanks the screen instead of
    // throwing, so assert on it every frame — this class of bug must fail loudly.
    if (!P.nan) {
      const bad = [['zoom', g.zoom], ['camX', g.camX], ['camY', g.camY], ['roll', g.roll],
                   ['px', g.player.x], ['py', g.player.y],
                   ['vx', g.player.vx], ['vy', g.player.vy], ['score', g.score]]
        .filter(([, v]) => !Number.isFinite(v));
      if (bad.length) {
        P.nan = bad.map(([k, v]) => `${k}=${v}`).join(',');
        console.error('NON-FINITE STATE: ' + P.nan);
      }
    }
  };
  const origDie = g.die.bind(g);
  g.die = function (...a) { if (g.state === 1) P.deaths++; return origDie(...a); };
});

// --- start the game ----------------------------------------------------------
// Click the real primary button by its label — NOT `button` first-match, which is the
// audio toggle and silently leaves the game sitting on the title screen.
const startBtn = page.getByRole('button', { name: /launch|start|retry|run/i }).first();
let started = false;
if (await startBtn.count()) {
  await startBtn.click({ timeout: 5000 }).then(() => { started = true; }).catch(() => {});
}
await page.waitForTimeout(400);
const stateAfterClick = await page.evaluate(() => window.game && window.game.state);
if (stateAfterClick !== 1) {
  errors.push(`START BUTTON DID NOT START THE GAME (clicked=${started}, state=${stateAfterClick})`);
  await page.evaluate(() => window.game && window.game.start());
}
await page.waitForTimeout(300);

// --- the bot -----------------------------------------------------------------
// Drives window.game.input.down directly. `smart` aims for the perfect-arc window:
// hold until the swing carries it up-and-forward, then let go.
await page.evaluate((bot) => {
  const g = window.game;
  if (!g) return;
  g.__botOn = true;
  const p = g.player;
  let t = 0, holdFor = 0.55, restFor = 0.12, phase = 0, timer = 0;
  const step = () => {
    if (!g.__botOn) return;
    const dt = 1 / 60;
    t += dt; timer += dt;
    if (g.state === 3) { g.start(); }        // auto-retry on death
    if (bot === 'metronome') {
      g.input.down = (t % 0.9) < 0.6;
    } else {
      if (phase === 0) {                      // waiting to tether
        g.input.down = true;
        if (p.tethered) { phase = 1; timer = 0; }
        else if (timer > 1.2) { timer = 0; }
      } else {                                 // tethered: release when rising+forward
        const rising = p.vy < -6 && p.vx > 4;
        const ang = Math.atan2(-p.vy, p.vx);
        const inWindow = rising && ang > 0.3 && ang < 0.9;
        if (inWindow || timer > 1.6) {
          g.input.down = false;
          phase = 2; timer = 0;
        }
      }
      if (phase === 2 && timer > 0.14) { phase = 0; timer = 0; }
      if (!p.tethered && phase === 1) { phase = 0; timer = 0; }
    }
    setTimeout(step, 16);
  };
  step();
}, BOT);

// --- capture -----------------------------------------------------------------
// Only capture frames that are genuinely live gameplay: state === PLAY, no menu on
// screen, and enough distance travelled to be past the spawn. Otherwise a shot lands
// on a game-over fade and tells us nothing about how the game looks.
const interval = (SECONDS * 1000) / SHOTS;
const isClean = () => page.evaluate(() => {
  const g = window.game;
  if (!g || g.state !== 1) return false;
  const s = document.getElementById('screens');
  for (const el of s.querySelectorAll('.scr')) {
    if (parseFloat(getComputedStyle(el).opacity) > 0.01) return false;
  }
  return g.distance > 15;
});
for (let i = 1; i <= SHOTS; i++) {
  await page.waitForTimeout(interval);
  for (let tries = 0; tries < 90 && !(await isClean()); tries++) {
    await page.waitForTimeout(100);
  }
  await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-play.png` });
}

// --- force a death screen shot ----------------------------------------------
await page.evaluate(() => {
  const g = window.game;
  if (!g) return;
  g.__botOn = false;
  g.input.down = false;
  if (g.state === 1) g.die(g.player.x, g.player.y, g.player.vx, g.player.vy);
});
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/99-gameover.png` });

// --- results -----------------------------------------------------------------
const stats = await page.evaluate(() => {
  const P = window.__probe;
  const g = window.game;
  if (!P) return null;
  const ts = P.times.slice(10).sort((a, b) => a - b);
  const pct = (q) => ts.length ? ts[Math.floor(ts.length * q)] : 0;
  const inst = P.instances.slice(10);
  return {
    frames: P.frames,
    medianFrameMs: +pct(0.5).toFixed(2),
    p95FrameMs: +pct(0.95).toFixed(2),
    p99FrameMs: +pct(0.99).toFixed(2),
    estFps: +(1000 / (pct(0.5) || 16.7)).toFixed(1),
    avgInstances: Math.round(inst.reduce((a, b) => a + b, 0) / (inst.length || 1)),
    maxInstances: Math.max(0, ...inst),
    instanceOverflow: P.worst,
    deaths: P.deaths,
    maxDistance: Math.round(P.maxDist),
    maxMultiplier: P.maxCombo,
    overdriveTriggers: P.overdrives,
    finalScore: g ? Math.floor(g.score) : 0,
    quality: g ? g.quality : 0,
    gameOverVisible: !!document.querySelector("#screens")?.textContent.trim(),
    nan: P.nan || null,
  };
});

const report = { url: URL_, boot, stats, errors, sampleLogs: logs.slice(0, 40) };
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));

console.log('\n=== ARCLIGHT PROBE ===');
console.log('boot :', JSON.stringify(boot));
console.log('stats:', JSON.stringify(stats, null, 2));
if (errors.length) {
  console.log(`\n!!! ${errors.length} ERROR(S):`);
  for (const e of errors.slice(0, 25)) console.log('  ' + e);
} else {
  console.log('\nno console errors');
}
console.log(`\nshots -> ${OUT}`);

await browser.close();
process.exit(errors.length ? 1 : 0);
