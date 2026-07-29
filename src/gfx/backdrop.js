// ARCLIGHT — gfx/backdrop.js
//
// The entire sense of place: sky dome, six depth bands of procedural megacity,
// volumetric light shafts, stratified fog, wind-sheared rain and distant traffic.
//
// ───────────────────────────────────────────────────────────────────────────────
// HOW THIS THING IS PUT TOGETHER
//
// 1. LAYER SEMANTICS. The renderer buckets by layer and composites FAR_GLOW
//    (additive) → SOLID (alpha) → NEON (additive) → FOREGROUND (additive). We only
//    own FAR_GLOW, SOLID and (for rain) FOREGROUND. That means *every* emissive we
//    emit is composited before *every* silhouette we emit. We do not fight that —
//    we lean into it. Building silhouettes are drawn with alpha < 1, so the window
//    and signage light behind them bleeds through at (1 - alpha). The result is
//    exactly the target look: neon burning through wet smog rather than neon
//    stuck onto a flat black card. Emissive values are authored against that
//    attenuation — see the note on BAND_EMIT.
//
//    The corollary bites: an emissive's *halo* spills past the silhouette into
//    clear air, where nothing attenuates it. So a light that sits on a facade and
//    a light that sits above the roofline need different gains for the same
//    on-screen result. Every emitter below is commented with which case it is.
//
// 2. PARALLAX + WORLD ANCHORING. The renderer does `rel = world - cam * parallax`.
//    So a band at parallax p is authored in "band space": to put something at
//    screen offset s we emit it at world x = camX*p + s. City geometry is instead
//    anchored to a *constant* world Y (`NOMINAL_CAM_Y * p + screenOffset`), never
//    to camY, so the skyline holds still in world space and genuinely parallaxes
//    vertically as the player dives. Only the sky dome (p = 0.02) and the screen
//    murk are camera-locked, which is correct — they are at infinity.
//
// 3. DETERMINISM. Buildings are keyed off `floor(worldX / columnWidth)` through an
//    integer avalanche hash into a mulberry32 stream. A building is bit-identical
//    every time it scrolls back on screen. Nothing about the geometry may branch on
//    time — only brightness does.
//
// 4. ZERO ALLOCATION. No array/object literals in the hot path except renderer
//    `opts` (explicitly permitted). All scratch colours live at module scope; all
//    pools are typed arrays sized in the constructor. `makeRng` allocates a closure
//    per call, so per-column randomness uses the identical mulberry32 algorithm
//    driven from a module-scope integer (`sr`/`rnd` below) instead. `makeRng` is
//    still used, once, at construction time for the pools.
//
// 5. NO SHAPE.TRI. renderer.js's sdTriangle() measures its base against an
//    infinite line, so the field is wrong out to the sides and any TRI with a
//    large `soft`/`glowRadius` smears into a giant flat sheet. Soft, elongated
//    shapes here are all ELLIPSE, whose SDF is well behaved at any softness.
//
// Primitive budget: 500–650 per frame in portrait at CFG.VIEW_WIDTH; ≤ 780 for any
// viewport, enforced by the BAND_MAX_COLS stride. `this.debugCount` is the exact
// count for the frame just rendered.

import { LAYER } from '../core/renderer.js';
import { CFG, PAL, tint } from '../core/config.js';
import { clamp01, lerp, noise1, fbm1, makeRng, TAU } from '../core/math.js';

// ───────────────────────────────────────────────────────────────────────────────
// Layout constants.
//
// Objection, per CONTRACTS.md §Ground rules: these belong in CFG, but this module
// owns exactly one file and may not edit core/config.js. They are collected here
// at module scope and named as if they were CFG fields so they can be lifted out
// verbatim later.
// ───────────────────────────────────────────────────────────────────────────────

/** Camera Y the skyline is composed around. Bands are anchored to world Y using
 *  this, so at camY == NOMINAL_CAM_Y every band's horizon lands on HORIZON_FRAC. */
const NOMINAL_CAM_Y = 8;
/** Horizon position as a fraction of the half view height, measured downward. */
const HORIZON_FRAC = 0.34;
const SKY_PARALLAX = 0.02;

const BAND_COUNT = 5;
//                                        far ────────────────────────────► near
const BAND_PARALLAX = Float32Array.of(0.06, 0.12, 0.21, 0.35, 0.55);
const BAND_COLW     = Float32Array.of(3.40, 4.40, 6.00, 8.50, 13.00);
/** Probability a column actually contains a tower (gaps read as streets/canyons). */
const BAND_FILL     = Float32Array.of(0.94, 0.88, 0.80, 0.68, 0.55);
/** Aerial perspective: 0 = full contrast near, 1 = dissolved into the fog colour. */
const BAND_FOG      = Float32Array.of(0.90, 0.74, 0.55, 0.33, 0.13);
/** Silhouette alpha. Near-opaque throughout: city light is drawn ON the facade
 *  (SOLID, after the silhouette), not behind it, so structure no longer has to be
 *  translucent to be lit. Only the two furthest bands keep a little transparency,
 *  purely so they dissolve into the horizon glow. */
const BAND_ALPHA    = Float32Array.of(0.86, 0.92, 0.97, 1.00, 1.00);
/** Base line drop below the horizon, × halfH. Nearer bands sit lower — the city
 *  steps down toward the viewer, which is the strongest single depth cue we have. */
const BAND_BASE     = Float32Array.of(0.00, 0.03, 0.07, 0.13, 0.22);
/** Tower height range as a fraction of halfH (biased short by a squared roll). */
const BAND_H_MIN    = Float32Array.of(0.045, 0.065, 0.090, 0.110, 0.100);
const BAND_H_MAX    = Float32Array.of(0.300, 0.460, 0.640, 0.860, 1.050);
/** Lit windows drawn as individual primitives per tower. Far bands get zero and
 *  rely on soft blobs instead — a 3px window at p=0.06 is a waste of a primitive. */
const BAND_WINDOWS  = Int32Array.of(0, 0, 4, 8, 12);
/** Soft "implied window" blobs per tower. */
const BAND_BLOBS    = Int32Array.of(1, 1, 1, 1, 2);
/**
 * Emissive gain per band. City light lands on LAYER.SOLID at alpha 1, so the
 * authored value IS the on-screen value — no transmission arithmetic any more.
 * The useful window is roughly 1.2 (just blooms) to 3.5 (blooms hard but keeps its
 * hue). Past ~4 the ACES curve in post pulls every channel to white and saturated
 * neon turns into grey mush, which is the single easiest way to make this scene
 * look cheap. Far bands are dimmer so aerial perspective survives.
 */
const BAND_EMIT     = Float32Array.of(0.85, 1.00, 1.20, 1.45, 1.70);
/**
 * Per-band column cap, sized so the whole backdrop cannot exceed ~800 primitives
 * however wide the viewport gets. At CFG.VIEW_WIDTH the real counts are roughly
 * 17/14/11/9/7, so this never engages in the shipping configuration — it is a
 * safety net. When it does engage the band strides (draws every Nth column) rather
 * than truncating, so the skyline still spans the frame, just sparser.
 */
const BAND_MAX_COLS = Int32Array.of(30, 26, 20, 16, 12);

// Foreground streak band.
const FG_PARALLAX = 1.30;
const FG_COLW     = 30.0;
const FG_FILL     = 0.50;

/** Alpha for the soft facade wash. SOLID blends by src alpha AND premultiplies by
 *  it, so the on-screen contribution is colour × core × FACADE_HAZE_A². */
const FACADE_HAZE_A = 0.42;

const RAIN_COUNT    = 130;
const RAIN_FALL     = 96;    // world units / s at depth 1
const RAIN_WIND     = 13;    // ambient leftward wind
const RAIN_SHEAR    = 0.78;  // how much of the player's speed shears the streaks
const RAIN_LEN_MIN  = 2.0;
const RAIN_LEN_MAX  = 11.5;

const TRAFFIC_COUNT = 8;
const SHAFT_COUNT   = 6;
const CLOUD_COUNT   = 7;

// ───────────────────────────────────────────────────────────────────────────────
// Allocation-free deterministic RNG (mulberry32, identical stream to makeRng).
// ───────────────────────────────────────────────────────────────────────────────
let _s = 1;
function sr(seed) { _s = seed >>> 0; }
function rnd() {
  _s = (_s + 0x6d2b79f5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rr(a, b) { return a + rnd() * (b - a); }

/** Integer avalanche → a stable stream id for (seed, band, column). */
function colKey(seed, band, col) {
  let h = (seed ^ Math.imul(band + 1, 0x85ebca6b) ^ Math.imul(col | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Wrap v into [-half, half). Used to recycle the rain / traffic pools. */
function wrapc(v, half) {
  const span = half * 2;
  let x = v + half;
  x -= Math.floor(x / span) * span;
  return x - half;
}

// ───────────────────────────────────────────────────────────────────────────────
// Module-scope scratch colour registers. Reused every frame via tint()/mix3().
// ───────────────────────────────────────────────────────────────────────────────
const _cSil   = [0, 0, 0, 1];
const _cEmit  = [0, 0, 0, 1];
const _cSky   = [0, 0, 0, 1];
const _cFog   = [0, 0, 0, 1];
const _cRain  = [0, 0, 0, 1];
const _cAux   = [0, 0, 0, 1];

/** Palette references used as sign colours. Module scope: never reallocated. */
const NEON_SET = [PAL.cyan, PAL.magenta, PAL.violet, PAL.cyan, PAL.magenta, PAL.amber, PAL.violet, PAL.cyan];
const NEON_N = NEON_SET.length;

/** out = mix(a, b, t) * k, with alpha. Allocation-free. */
function mix3(out, a, b, t, k, alpha) {
  out[0] = (a[0] + (b[0] - a[0]) * t) * k;
  out[1] = (a[1] + (b[1] - a[1]) * t) * k;
  out[2] = (a[2] + (b[2] - a[2]) * t) * k;
  out[3] = alpha;
  return out;
}

/**
 * Emissive tint with the overdrive grade folded in: as overdrive01 rises the whole
 * backdrop's light pushes toward PAL.hot (white-cyan) and gains intensity, so the
 * city itself blooms out along with the player.
 */
function emissive(out, base, k, alpha, od) {
  const w = od * 0.40;
  const g = k * (1 + od * 0.80);
  out[0] = (base[0] + (PAL.hot[0] - base[0]) * w) * g;
  out[1] = (base[1] + (PAL.hot[1] - base[1]) * w) * g;
  out[2] = (base[2] + (PAL.hot[2] - base[2]) * w) * g;
  out[3] = alpha;
  return out;
}

export class Backdrop {
  constructor(seed = 1) {
    this.seed = (seed | 0) || 0x5eed;

    this.t = 0;          // wall clock for flicker
    this.drift = 0;      // overdrive-accelerated clock for cloud / shaft motion
    this.od = 0;         // overdrive01, smoothed
    this.speed01 = 0;
    this.speed = 0;
    this.debugCount = 0;

    // Cached view extents in world units; update() runs before render() and needs
    // them to wrap the pools, so they persist between frames.
    this.halfW = CFG.VIEW_WIDTH * 0.5;
    this.halfH = CFG.VIEW_WIDTH * 1.08;

    const rng = makeRng(this.seed ^ 0x1f2e3d4c);

    // ── Derived palette. Built once from PAL so nothing is hardcoded. ──────────
    //
    // Everything structural here is authored to survive the ACES curve in post and
    // still land in the bottom histogram bin. ACES *darkens* shadows by roughly 2×
    // (linear 0.02 → 0.010), then gamma lifts them back (0.010 → sRGB 0.12), so the
    // ceiling for "reads as black" is about 0.020 linear per channel. Crucially the
    // blacks must stay *chromatic*: a dark saturated navy scores ~0.55 on the
    // saturation metric while a neutral dark grey scores ~0. Dark and colourful,
    // never dark and grey.

    // Cold smog. Much darker and bluer than a mid violet — this colour multiplies
    // across large areas, so every 0.01 of it is a global black-level lift.
    this.fogCol = mix3([0, 0, 0, 1], PAL.deep, PAL.violet, 0.22, 0.30, 1);
    // Near structure: essentially black, with enough blue in it to stay saturated.
    this.silNear = mix3([0, 0, 0, 1], PAL.void, PAL.violet, 0.035, 0.52, 1);
    // Far structure: what distant towers dissolve toward. Still very dark — the
    // separation between a far tower and the sky comes from the *horizon glow
    // behind it*, not from lifting the tower itself into mid grey.
    this.silFar = mix3([0, 0, 0, 1], PAL.deep, PAL.violet, 0.30, 0.40, 1);
    // Horizon bruise — where the city's light dome hits the underside of the rain
    // cloud. Kept strongly magenta; this is the main chroma source in the frame.
    this.hazeCol = mix3([0, 0, 0, 1], PAL.magenta, PAL.violet, 0.26, 1.0, 1);
    // High sky — cold indigo, barely above black.
    this.skyTop = mix3([0, 0, 0, 1], PAL.void, PAL.deep, 0.45, 1.0, 1);

    // ── Rain pool. Stored in screen-relative world units, so it is trivially
    //    wrap-safe under any camera motion and never drifts. ────────────────────
    this.rnX = new Float32Array(RAIN_COUNT);
    this.rnY = new Float32Array(RAIN_COUNT);
    this.rnD = new Float32Array(RAIN_COUNT);  // depth: <1 far/thin, >1 near/blurry
    this.rnL = new Float32Array(RAIN_COUNT);  // per-drop length jitter
    this.rnB = new Float32Array(RAIN_COUNT);  // per-drop brightness jitter
    this.rnA = new Float32Array(RAIN_COUNT);  // per-drop shear jitter — breaks up
                                              // the hatch pattern a single shared
                                              // wind vector otherwise produces
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.rnX[i] = rng.range(-1, 1) * this.halfW * 1.3;
      this.rnY[i] = rng.range(-1, 1) * this.halfH * 1.2;
      // 12% of the pool sits very close to the lens: fat, fast and out of focus.
      this.rnD[i] = rng() < 0.12 ? rng.range(1.55, 2.25) : rng.range(0.55, 1.15);
      this.rnL[i] = rng.range(0.50, 1.75);
      this.rnB[i] = rng.range(0.22, 1.0);
      this.rnA[i] = rng.range(0.80, 1.26);
    }

    // ── Distant traffic: pairs of running lights sliding across the far bands. ─
    this.tfOff  = new Float32Array(TRAFFIC_COUNT);   // offset in band space
    this.tfY    = new Float32Array(TRAFFIC_COUNT);   // screen-Y fraction of halfH
    this.tfV    = new Float32Array(TRAFFIC_COUNT);   // signed velocity, band units/s
    this.tfBand = new Int32Array(TRAFFIC_COUNT);
    this.tfSize = new Float32Array(TRAFFIC_COUNT);
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      this.tfBand[i] = rng.int(0, 3);
      this.tfOff[i]  = rng.range(-1, 1) * this.halfW * 1.4;
      this.tfY[i]    = rng.range(-0.62, -0.04);
      this.tfV[i]    = (rng.chance(0.5) ? 1 : -1) * rng.range(1.6, 6.0);
      this.tfSize[i] = rng.range(0.22, 0.50);
    }

    // ── Volumetric shafts. Each is anchored in a band and creeps along it, so it
    //    parallaxes with the tower it is nominally falling from. ────────────────
    this.shOff  = new Float32Array(SHAFT_COUNT);
    this.shBand = new Int32Array(SHAFT_COUNT);
    this.shHue  = new Int32Array(SHAFT_COUNT);
    this.shLen  = new Float32Array(SHAFT_COUNT);
    this.shWid  = new Float32Array(SHAFT_COUNT);
    this.shTop  = new Float32Array(SHAFT_COUNT);   // fraction of halfH above horizon
    this.shPh   = new Float32Array(SHAFT_COUNT);
    this.shRate = new Float32Array(SHAFT_COUNT);
    for (let i = 0; i < SHAFT_COUNT; i++) {
      this.shBand[i] = rng.int(2, 4);
      this.shOff[i]  = rng.range(-1, 1) * this.halfW * 1.3;
      this.shHue[i]  = rng.int(0, NEON_N - 1);
      this.shLen[i]  = rng.range(0.30, 0.62);
      this.shWid[i]  = rng.range(0.025, 0.070);
      this.shTop[i]  = rng.range(0.02, 0.30);
      this.shPh[i]   = rng.range(0, TAU);
      this.shRate[i] = rng.range(0.055, 0.17);
    }

    // ── Cloud deck. Long, low, slow. Six of these plus the horizon washes is the
    //    whole sky; overlapping soft gradients are what keeps it from banding. ──
    this.clX  = new Float32Array(CLOUD_COUNT);
    this.clY  = new Float32Array(CLOUD_COUNT);
    this.clW  = new Float32Array(CLOUD_COUNT);
    this.clH  = new Float32Array(CLOUD_COUNT);
    this.clA  = new Float32Array(CLOUD_COUNT);
    this.clV  = new Float32Array(CLOUD_COUNT);
    this.clM  = new Float32Array(CLOUD_COUNT);   // 0 = violet, 1 = magenta bruise
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const hi = i / (CLOUD_COUNT - 1);          // 0 = high sky, 1 = at the horizon
      this.clX[i] = rng.range(-1.2, 1.2);
      this.clY[i] = lerp(-0.62, 0.20, hi) + rng.jitter(0.06);
      this.clW[i] = rng.range(0.55, 1.25);
      this.clH[i] = rng.range(0.035, 0.105);
      this.clA[i] = lerp(0.012, 0.085, hi) * rng.range(0.7, 1.25);
      this.clV[i] = rng.range(0.10, 0.45) * (rng.chance(0.3) ? -1 : 1);
      this.clM[i] = clamp01(hi * 1.3 + rng.jitter(0.15));
    }

    // Slow drift of the megacity glow dome along the horizon.
    this.domePh = rng.range(0, TAU);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // update — advances clocks and recycles the pools. No allocation.
  // ─────────────────────────────────────────────────────────────────────────────
  update(dt, camX, camY, speed, overdrive01) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;                       // survive tab-switch spikes

    const od = clamp01(overdrive01 || 0);
    this.od = od;
    this.speed = speed || 0;
    this.speed01 = clamp01(this.speed / CFG.TERMINAL_SPEED);

    // Flicker runs faster and drift accelerates under overdrive.
    this.t += dt * (1 + od * 1.9);
    this.drift += dt * (1 + od * 1.35);

    const hw = this.halfW, hh = this.halfH;

    // ── Rain ──────────────────────────────────────────────────────────────────
    // Screen-relative motion. The camera chasing forward is what makes rain
    // stream backwards, so the player's speed drives the horizontal component
    // directly; the same vector shears the streaks in render().
    const windX = RAIN_WIND + this.speed * RAIN_SHEAR;
    const rainW = hw * 1.35, rainH = hh * 1.25;
    for (let i = 0; i < RAIN_COUNT; i++) {
      const d = this.rnD[i];
      this.rnX[i] = wrapc(this.rnX[i] - windX * d * dt, rainW);
      this.rnY[i] = wrapc(this.rnY[i] + RAIN_FALL * (0.55 + 0.6 * d) * dt, rainH);
    }

    // ── Traffic ───────────────────────────────────────────────────────────────
    const tfW = hw * 1.45;
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      this.tfOff[i] = wrapc(this.tfOff[i] + this.tfV[i] * dt * (1 + od * 0.5), tfW);
    }

    // ── Shafts ────────────────────────────────────────────────────────────────
    const shW = hw * 1.4;
    for (let i = 0; i < SHAFT_COUNT; i++) {
      this.shOff[i] = wrapc(this.shOff[i] + this.shRate[i] * 2.2 * dt, shW);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // render
  // ─────────────────────────────────────────────────────────────────────────────
  render(r, camX, camY, viewW, viewH, zoom) {
    // The contract does not pin the units of viewW/viewH. Renderer.begin() takes
    // pixels; a world-unit view is ~46 wide. Accept either — a world view will
    // never exceed 160 units and a pixel view will never be under 160.
    let vw = viewW, vh = viewH;
    if (vw > 160) { vw = viewW / zoom; vh = viewH / zoom; }
    if (!(vw > 4)) vw = CFG.VIEW_WIDTH;
    if (!(vh > 4)) vh = CFG.VIEW_WIDTH * 2.16;

    const halfW = this.halfW = vw * 0.5;
    const halfH = this.halfH = vh * 0.5;
    const px = 1 / (zoom > 0 ? zoom : 1);   // one screen pixel, in world units

    this.r = r;
    this.debugCount = 0;

    const od = this.od;

    this._sky(camX, camY, halfW, halfH, px, od);

    // Bands are emitted far → near. SOLID composites in submission order, so this
    // ordering *is* the depth sort; two haze scrims are slotted between bands so
    // distant geometry genuinely sits behind atmosphere rather than beside it.
    for (let b = 0; b < BAND_COUNT; b++) {
      this._band(b, camX, camY, halfW, halfH, px, od);
      if (b === 1) this._scrim(camX, camY, halfW, halfH, px, 0.100, -0.10, 1.35, 0.55);
      if (b === 3) this._scrim(camX, camY, halfW, halfH, px, 0.085, 0.10, 1.15, 0.50);
    }

    this._traffic(camX, camY, halfW, halfH, px, od);
    this._shafts(camX, camY, halfW, halfH, px, od);
    this._foreBand(camX, camY, halfW, halfH, px);
    this._flood(camX, camY, halfW, halfH, px, od);
    this._rain(camX, camY, halfW, halfH, px, od);
  }

  // ─── counting wrappers ───────────────────────────────────────────────────────
  // Thin, monomorphic, no allocation. They exist purely so debugCount is exact.
  _rect(l, x, y, hw, hh, rot, c, o) { this.debugCount++; this.r.rect(l, x, y, hw, hh, rot, c, o); }
  _ell(l, x, y, rx, ry, rot, c, o)  { this.debugCount++; this.r.ellipse(l, x, y, rx, ry, rot, c, o); }
  _glow(l, x, y, rad, c, o)         { this.debugCount++; this.r.glow(l, x, y, rad, c, o); }
  _line(l, x0, y0, x1, y1, w, c, o) { this.debugCount++; this.r.line(l, x0, y0, x1, y1, w, c, o); }
  _ring(l, x, y, rad, th, c, o)     { this.debugCount++; this.r.ring(l, x, y, rad, th, c, o); }

  // ═══════════════════════════════════════════════════════════════════════════
  // SKY  —  ~17 primitives, LAYER.FAR_GLOW, parallax 0.02
  //
  // Built entirely from overlapping soft ellipses. Nothing here has a hard edge:
  // `soft` is set to a large fraction of the shape so smoothstep does the work of
  // a gradient ramp, and every ramp overlaps its neighbours at a different scale
  // and orientation. Combined with the post pass's triangular dither that is
  // enough to keep a 100-unit-tall indigo→magenta wash free of contouring.
  // ═══════════════════════════════════════════════════════════════════════════
  _sky(camX, camY, halfW, halfH, px, od) {
    const P = SKY_PARALLAX;
    const ox = camX * P, oy = camY * P;        // camera-locked: the sky is at infinity
    const hz = oy + halfH * HORIZON_FRAC;      // horizon line, world Y for this layer
    const dt = this.drift;

    // 0. Deep navy floor across the frame.
    //
    //    Not a "veil" — this is the difference between black and *chromatic* black,
    //    and it is worth its one primitive. A pixel at literal zero is black but
    //    colourless; a pixel at sRGB (15,14,30) is equally black to the eye and to
    //    the histogram, but strongly saturated. Since roughly half the frame is
    //    sky, that choice moves overall saturation by ~0.1 on its own. Green is the
    //    expensive channel (0.72 of luminance) so the mix leans on PAL.void, which
    //    has the lowest green-to-blue ratio in the palette.
    mix3(_cSky, PAL.void, PAL.deep, 0.25, 0.35, 1);
    this._rect(LAYER.FAR_GLOW, ox, oy, halfW * 1.4, halfH * 1.4, 0, _cSky,
      { glow: 0, glowRadius: 1, soft: halfH * 0.30, parallax: P });

    // 1. Upper indigo dome. Deliberately does NOT reach the top of the frame — the
    //    sky above the glow stays on the navy floor, so the image keeps a true
    //    black point instead of sitting on grey.
    tint(_cSky, this.skyTop, 0.085, 1);
    this._ell(LAYER.FAR_GLOW, ox, hz - halfH * 0.52, halfW * 2.0, halfH * 0.26, 0, _cSky,
      { glow: 0, glowRadius: 1, soft: halfH * 0.42, parallax: P });

    // 2. Mid violet body — the bulk of the gradient, hugging the horizon.
    mix3(_cSky, PAL.deep, PAL.violet, 0.50, 0.105 + od * 0.04, 1);
    this._ell(LAYER.FAR_GLOW, ox, hz - halfH * 0.26, halfW * 1.85, halfH * 0.26, 0, _cSky,
      { glow: 0, glowRadius: 1, soft: halfH * 0.40, parallax: P });

    // 4. Horizon bruise — three nested magenta/violet washes, each tighter and
    //    hotter than the last. This is the light dome of a city that never sleeps
    //    bouncing off the underside of the rain cloud.
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      const wq = lerp(1.75, 0.85, t);
      const hq = lerp(0.175, 0.055, t);
      const k  = lerp(0.105, 0.30, t) * (1 + od * 0.25);
      emissive(_cSky, this.hazeCol, k, 1, od * 0.55);
      this._ell(LAYER.FAR_GLOW, ox + halfW * lerp(0.0, 0.10, t), hz - halfH * lerp(0.07, 0.015, t),
        halfW * wq, halfH * hq, 0, _cSky,
        { glow: 0.30, glowRadius: halfH * 0.07, soft: halfH * lerp(0.21, 0.075, t), parallax: P });
    }

    // 5. The glow dome: an off-centre hot spot drifting along the horizon, as if
    //    some vast arcology district is burning just out of frame.
    const dome = Math.sin(dt * 0.035 + this.domePh);
    const dx = ox + dome * halfW * 0.72;
    emissive(_cSky, PAL.amber, 0.075 + od * 0.05, 1, od * 0.7);
    this._ell(LAYER.FAR_GLOW, dx, hz - halfH * 0.05, halfW * 0.62, halfH * 0.16, 0, _cSky,
      { glow: 0.5, glowRadius: halfH * 0.12, soft: halfH * 0.20, parallax: P });
    emissive(_cSky, PAL.magenta, 0.145 + od * 0.06, 1, od * 0.7);
    this._ell(LAYER.FAR_GLOW, dx - halfW * 0.06, hz - halfH * 0.015, halfW * 0.26, halfH * 0.055, 0, _cSky,
      { glow: 0.8, glowRadius: halfH * 0.09, soft: halfH * 0.075, parallax: P });

    // 6. Cloud deck — long low slabs, each drifting at its own rate. The high ones
    //    are cold violet, the low ones pick up the magenta bounce off the city.
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const cx = ox + wrapc(this.clX[i] * halfW * 1.4 + dt * this.clV[i] * 2.2, halfW * 1.6);
      const cy = hz + this.clY[i] * halfH;
      // Slow breathe so no frame is static.
      const br = 0.82 + 0.18 * Math.sin(dt * 0.25 + this.clX[i] * 5.1);
      mix3(_cSky, PAL.violet, this.hazeCol, this.clM[i], this.clA[i] * br * (0.9 + od * 0.25), 1);
      this._ell(LAYER.FAR_GLOW, cx, cy, halfW * this.clW[i], halfH * this.clH[i], 0, _cSky,
        { glow: 0.2, glowRadius: halfH * 0.06, soft: halfH * this.clH[i] * 2.4, parallax: P });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOG SCRIM  —  1 primitive, LAYER.SOLID
  //
  // A wide alpha-blended wash of fog colour slotted between two bands. Because it
  // is on SOLID it correctly hides what was submitted before it and is hidden by
  // what comes after — the only mechanism available for inter-band atmosphere.
  //
  // Kept deliberately thin (α ≈ 0.09) and single-primitive: every scrim also dims
  // *all* FAR_GLOW emissive, including the near bands', because layers composite
  // wholesale. Two of these cost ~18% of the city's light; a third would start
  // eating the neon. The heavy lifting of aerial perspective is done by baking
  // BAND_FOG into the silhouette colour instead, which is free.
  // ═══════════════════════════════════════════════════════════════════════════
  _scrim(camX, camY, halfW, halfH, px, alpha, yFrac, hFrac, softFrac) {
    const P = SKY_PARALLAX;
    const ox = camX * P, oy = camY * P;
    tint(_cFog, this.fogCol, 1.0, alpha);
    this._rect(LAYER.SOLID, ox, oy + halfH * yFrac, halfW * 2.2, halfH * hFrac, 0, _cFog,
      { glow: 0, soft: halfH * softFrac, parallax: P });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CITY BAND
  //
  // One procedural column grid per band. Everything derives from a mulberry32
  // stream keyed on floor(worldX / colW), so a tower is bit-identical every time
  // it re-enters the frame. No geometry may branch on this.t — only brightness.
  // ═══════════════════════════════════════════════════════════════════════════
  _band(b, camX, camY, halfW, halfH, px, od) {
    const P    = BAND_PARALLAX[b];
    const colW = BAND_COLW[b];
    const fog  = BAND_FOG[b];
    const emit = BAND_EMIT[b];
    const t    = this.t;

    // Band-space visible window. `camX * P` is where the screen centre lands in
    // this band's own coordinate frame. Two columns of margin each side: a tower
    // can sit 0.68·colW off its column centre and its signage halo reaches ~1.6
    // world units further still, so one column is not quite enough to stop a glow
    // popping in at the screen edge.
    const centre = camX * P;
    let   c0 = Math.floor((centre - halfW - colW * 2) / colW);
    const c1 = Math.floor((centre + halfW + colW * 2) / colW);
    // Budget guard. If the view is so wide that this band would blow its column
    // allowance, stride over columns instead of clipping the range — the skyline
    // stays full-width, just thinner. The stride is derived only from the view
    // size (constant for a session) and the start index is snapped to it, so a
    // given column keeps its identity and the city stays stable.
    let step = 1;
    const cap = BAND_MAX_COLS[b];
    while ((c1 - c0) / step > cap) step++;
    if (step > 1) c0 = Math.floor(c0 / step) * step;

    // World-Y anchor. Constant in world space (NOMINAL_CAM_Y, not camY), so the
    // skyline holds still and parallaxes vertically when the player dives.
    const baseY = NOMINAL_CAM_Y * P + halfH * (HORIZON_FRAC + BAND_BASE[b]);
    // Silhouettes always run this far below their base line so no camera Y can
    // ever reveal a bottom edge. One primitive either way.
    const skirt = halfH * 2.4;

    // Aerial perspective: silhouettes lift and go bluer with distance — but only
    // to silFar, which is itself near-black. Distant towers must still read as
    // silhouettes; it is the horizon glow behind them that separates them.
    mix3(_cSil, this.silNear, this.silFar, fog * fog, 1.0, BAND_ALPHA[b]);

    const nWin  = BAND_WINDOWS[b];
    const nBlob = BAND_BLOBS[b];
    const winH  = Math.min(halfH * 1.5, skirt);   // window band depth on a facade

    for (let c = c0; c <= c1; c += step) {
      sr(colKey(this.seed, b, c));

      if (rnd() >= BAND_FILL[b]) continue;        // a gap in the skyline

      const x    = c * colW + rr(-0.22, 0.22) * colW;
      const wRoll = rnd();
      const hw   = colW * lerp(0.24, 0.46, wRoll * wRoll);
      // Height biased short: rr^2 makes tall towers rare and therefore readable.
      const hRoll = rnd();
      const h    = halfH * lerp(BAND_H_MIN[b], BAND_H_MAX[b], hRoll * hRoll * (0.6 + 0.4 * hRoll));
      const top  = baseY - h;

      // ── Silhouette (LAYER.SOLID) ────────────────────────────────────────────
      const bh = (baseY + skirt - top) * 0.5;
      this._rect(LAYER.SOLID, x, top + bh, hw, bh, 0, _cSil,
        { glow: 0, soft: px * 1.15, radius: hw * 0.05, parallax: P });

      // ── Roof setback (LAYER.SOLID) — a narrower box stacked on top. Cheap
      //    silhouette variety; only worth a primitive from band 2 inward. ──────
      let capTop = top;
      if (b >= 2 && rnd() < 0.55) {
        const cw = hw * rr(0.32, 0.68);
        const ch = h * rr(0.06, 0.20);
        capTop = top - ch;
        this._rect(LAYER.SOLID, x + rr(-0.3, 0.3) * (hw - cw), top - ch * 0.5, cw, ch, 0, _cSil,
          { glow: 0, soft: px * 1.15, parallax: P });
      }

      // ── Implied window mass (LAYER.SOLID, on the facade) ────────────────────
      // Soft vertical smears standing in for hundreds of windows. This is what
      // makes the far bands read as *inhabited* without a primitive per window.
      //
      // Alpha-blended on top of the silhouette, so it lifts the facade toward the
      // light rather than shining through it. Note the double alpha: SOLID writes
      // rgb*core*a and then blends by that same a, so the on-screen contribution
      // is c*core*a².
      for (let i = 0; i < nBlob; i++) {
        const by = top + rr(0.10, 0.80) * Math.min(h, winH);
        const warm = rnd() < 0.28;
        const seedI = (_s ^ (i * 7919)) | 0;
        const fl = 0.68 + 0.32 * noise1(t * (0.45 + 0.55 * fog) + i * 3.7, seedI);
        // Wider than the tower and very soft: this must read as an ambient lift
        // over a whole slab of facade, never as a discrete blob sitting on it.
        const rx = hw * 1.25, ry = hw * rr(1.8, 3.2);
        emissive(_cEmit, warm ? PAL.amber : PAL.cyan,
          emit * rr(0.22, 0.55) * fl * (1 - fog * 0.35), FACADE_HAZE_A, od);
        this._ell(LAYER.SOLID, x + rr(-0.22, 0.22) * hw, by, rx, ry, 0, _cEmit,
          { glow: 0, glowRadius: px * 2, soft: rx * 1.9, parallax: P });
      }

      // ── Individual lit windows (LAYER.SOLID, on the facade) ─────────────────
      // Scattered rather than a full grid: a black tower with a sparse scatter of
      // lit cells reads far better (and costs far less) than a complete matrix.
      if (nWin > 0) {
        const wq = hw * rr(0.045, 0.080);         // window half-width
        const hq = wq * rr(0.55, 0.95);           // squat, like a strip window
        const span = Math.min(h - hq * 4, winH);
        // Snap to a column/row pitch so the scatter still reads as a facade grid
        // rather than as random confetti — the grid is what says "building".
        const pitchX = wq * 2.6, pitchY = hq * 3.4;
        for (let i = 0; i < nWin; i++) {
          const wx = x + Math.round(rr(-0.72, 0.72) * hw / pitchX) * pitchX;
          const wy = top + hq * 2.5 + Math.round(rnd() * (span > 0 ? span : 0) / pitchY) * pitchY;
          const seedI = (_s ^ (i * 26699)) | 0;
          const warm = rnd() < 0.22;
          // Per-window flicker on its own noise seed — some cells are dead, some
          // stutter, most sit at a steady value with a slow wander.
          const n = noise1(t * (0.7 + 1.6 * rnd()) + i * 5.3, seedI);
          let lit = n < 0.14 ? 0.05 : 0.55 + 0.65 * n;
          lit *= 0.75 + 0.5 * noise1(t * 6.0 + i, seedI + 991);
          emissive(_cEmit, warm ? PAL.amber : PAL.cyan, emit * 0.80 * lit * (1 - fog * 0.55), 1, od);
          this._rect(LAYER.SOLID, wx, wy, wq, hq, 0, _cEmit,
            { glow: 0, glowRadius: px * 2, soft: px * 1.1, parallax: P });
        }
      }

      // ── Signage (LAYER.SOLID) ───────────────────────────────────────────────
      if (b >= 1) this._signs(b, x, capTop, top, hw, h, baseY, P, px, emit, fog, od);

      // ── Antenna spire + aircraft warning light ──────────────────────────────
      if (b >= 1 && h > halfH * 0.22 && rnd() < 0.5) {
        const sl = h * rr(0.10, 0.30);
        const sx = x + rr(-0.5, 0.5) * hw;
        this._line(LAYER.SOLID, sx, capTop, sx, capTop - sl, Math.max(px * 1.2, hw * 0.05), _cSil,
          { glow: 0, soft: px, parallax: P });
        // Blink: a hard square wave, phase-offset per spire.
        const blinkPh = rnd() * TAU;
        const blink = Math.sin(t * 1.55 + blinkPh) > 0.55 ? 1 : 0.045;
        const red = rnd() < 0.65;
        emissive(_cAux, red ? PAL.magenta : PAL.amber, emit * 1.15 * blink, 1, od);
        this._rect(LAYER.SOLID, sx, capTop - sl, Math.max(hw * 0.075, px * 1.3),
          Math.max(hw * 0.075, px * 1.3), 0, _cAux,
          { glow: 0, glowRadius: px * 2, soft: px * 1.1, radius: px, parallax: P });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIGNAGE  —  0–4 primitives per tower, LAYER.SOLID
  //
  // Drawn on SOLID immediately after the tower that carries it, at alpha 1. On the
  // alpha layer a fragment writes rgb*core*a and blends by core*a, so an opaque
  // core lands at exactly its authored HDR value and correctly occludes — and
  // correctly gets occluded by the next band in front. The `glow` halo is NOT
  // available here (outside the core the shader's src alpha is 0, so the halo
  // multiplies to nothing), which is why every sign sets glow:0 and a tiny
  // glowRadius — the latter also shrinks the instance quad, which is free fillrate.
  // The halo comes from the post bright-pass instead, which is where it belongs:
  // bloom generated from a genuinely bright pixel behaves like light, whereas a
  // baked halo behind an opaque wall behaves like a sticker.
  //
  // Values are authored in the 1.2–3.5 band. Above ~4 the ACES curve pulls
  // everything to white and the neon goes grey — the desaturation trap.
  //
  // Flicker model: ~80% of signs breathe slowly (a sine plus a low-amplitude noise
  // wander); ~20% are failing tubes that stutter hard on a thresholded noise, with
  // a fast sub-flicker riding on top. Overdrive drives every rate up via this.t.
  // ═══════════════════════════════════════════════════════════════════════════
  _signs(b, x, capTop, top, hw, h, baseY, P, px, emit, fog, od) {
    const t = this.t;
    const seedI = _s | 0;
    // Aerial perspective on emissive: distant signs lose intensity, and lose it
    // faster than they lose chroma, so the far city stays coloured but dim.
    const aer = 1 - fog * 0.55;

    // ---- vertical strip: the kanji column running down a facade edge ----------
    if (rnd() < 0.52) {
      const side = rnd() < 0.5 ? -1 : 1;
      const sx = x + side * hw * rr(0.72, 1.0);
      const y0 = top + h * rr(0.06, 0.30);
      const y1 = y0 + h * rr(0.30, 0.72);
      const col = NEON_SET[(rnd() * NEON_N) | 0];
      const ph = rnd() * TAU;
      const stutter = rnd() < 0.20;
      const k = emit * 1.55 * this._flick(t, seedI + 13, ph, stutter, 1.1) * aer;
      emissive(_cEmit, col, k, 1, od);
      this._line(LAYER.SOLID, sx, y0, sx, y1, Math.max(hw * 0.09, px * 1.5), _cEmit,
        { glow: 0, glowRadius: px * 2, soft: px * 1.1, parallax: P });
    }

    // ---- horizontal bar: a marquee across the upper facade -------------------
    if (rnd() < 0.40) {
      const by = top + h * rr(0.08, 0.45);
      const bw = hw * rr(0.7, 1.02);
      const col = NEON_SET[(rnd() * NEON_N) | 0];
      const ph = rnd() * TAU;
      const stutter = rnd() < 0.16;
      const k = emit * 1.45 * this._flick(t, seedI + 71, ph, stutter, 0.85) * aer;
      emissive(_cEmit, col, k, 1, od);
      this._rect(LAYER.SOLID, x, by, bw, Math.max(hw * 0.070, px * 1.3), 0, _cEmit,
        { glow: 0, glowRadius: px * 2, soft: px * 1.1, parallax: P });
    }

    // ---- halo ring: the corporate logo bolted to the roof --------------------
    if (b >= 2 && rnd() < 0.24) {
      const rad = hw * rr(0.28, 0.58);
      const ry = capTop - rad * rr(0.6, 1.5);
      const col = NEON_SET[(rnd() * NEON_N) | 0];
      const ph = rnd() * TAU;
      const k = emit * 1.30 * this._flick(t, seedI + 131, ph, rnd() < 0.14, 0.7) * aer;
      emissive(_cEmit, col, k, 1, od);
      this._ring(LAYER.SOLID, x + rr(-0.3, 0.3) * hw, ry, rad, Math.max(rad * 0.12, px * 1.1), _cEmit,
        { glow: 0, glowRadius: px * 2, soft: px * 1.1, parallax: P });
    }

    // ---- billboard: a big dim panel, the light source for the shafts ---------
    if (b >= 3 && rnd() < 0.30) {
      const pw = hw * rr(0.55, 1.05);
      const phh = pw * rr(0.5, 1.0);
      const py = top + h * rr(0.10, 0.40) + phh;
      const col = NEON_SET[(rnd() * NEON_N) | 0];
      const ph = rnd() * TAU;
      // Broad and dim: it wants area, not peak. Kept under 1.0 so it reads as a lit
      // panel rather than another blown-out lamp.
      const k = emit * 0.42 * this._flick(t, seedI + 211, ph, rnd() < 0.10, 0.45) * aer;
      emissive(_cEmit, col, k, 1, od);
      this._rect(LAYER.SOLID, x + rr(-0.2, 0.2) * hw, py, pw, phh, 0, _cEmit,
        { glow: 0, glowRadius: px * 2, soft: px * 1.4, radius: pw * 0.12, parallax: P });
    }
  }

  /**
   * Per-sign brightness. `stutter` picks the failing-tube model. Returns ~0..1.4.
   * All inputs are integers/constants derived from the column seed, so two frames
   * with the same `t` produce the same value — no hysteresis, no state.
   */
  _flick(t, seedI, phase, stutter, rate) {
    if (stutter) {
      const gate = noise1(t * (7.5 * rate) + phase, seedI);
      const sub  = noise1(t * 34.0 + phase, seedI + 6151);
      return gate > 0.42 ? 0.70 + 0.55 * sub : 0.05 + 0.10 * sub;
    }
    // Steady tube: a slow breathe plus a gentle ballast wander.
    return 0.80 + 0.16 * Math.sin(t * rate + phase)
                + 0.14 * (fbm1(t * 0.55 * rate + phase, seedI) - 0.5);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISTANT TRAFFIC  —  3 primitives each (24 total), LAYER.FAR_GLOW
  //
  // Pairs of running lights sliding across the far bands. Because they live on
  // FAR_GLOW they are correctly occluded by every nearer band's silhouette, which
  // makes them read as *behind* the city rather than pasted over it.
  // ═══════════════════════════════════════════════════════════════════════════
  _traffic(camX, camY, halfW, halfH, px, od) {
    const t = this.t;
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      const b = this.tfBand[i];
      const P = BAND_PARALLAX[b];
      const fog = BAND_FOG[b];
      const x = camX * P + this.tfOff[i];
      const y = NOMINAL_CAM_Y * P + halfH * (HORIZON_FRAC + this.tfY[i]);
      const sz = this.tfSize[i] * (1 + BAND_PARALLAX[b] * 2.0);
      const dir = this.tfV[i] > 0 ? 1 : -1;
      const k = (1 - fog * 0.55);

      // Headlight — cold and hot.
      emissive(_cAux, PAL.hot, 1.05 * k, 1, od);
      this._glow(LAYER.FAR_GLOW, x + dir * sz * 1.6, y, sz, _cAux,
        { glow: 1.8, glowRadius: sz * 0.9, soft: px * 2, parallax: P });
      // Tail light — magenta, dimmer, with a slow blink.
      const blink = 0.55 + 0.45 * (Math.sin(t * 2.2 + i * 1.9) > 0 ? 1 : 0.35);
      emissive(_cAux, PAL.magenta, 0.70 * k * blink, 1, od);
      this._glow(LAYER.FAR_GLOW, x - dir * sz * 1.6, y, sz * 0.85, _cAux,
        { glow: 1.6, glowRadius: sz * 0.8, soft: px * 2, parallax: P });
      // Faint smear between them so the pair reads as one vehicle at speed.
      emissive(_cAux, PAL.cyan, 0.18 * k, 1, od);
      this._line(LAYER.FAR_GLOW, x - dir * sz * 3.2, y, x + dir * sz * 3.2, y, sz * 0.55, _cAux,
        { glow: 1.0, glowRadius: sz * 2.2, soft: px * 2.5, parallax: P });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VOLUMETRIC SHAFTS  —  3 primitives each (18 total), LAYER.FAR_GLOW
  //
  // Soft beams falling out of the sign layer, drifting slowly.
  //
  // These are ELLIPSES, not triangles, despite a cone being the obvious shape.
  // renderer.js's sdTriangle() computes its base edge as `abs(p.y + b.y)` — the
  // distance to an *infinite line*, not to the base segment. Anywhere out to the
  // side of the triangle that SDF reports ~0, so a TRI with a large `soft` or
  // `glowRadius` smears into a huge flat sheet clipped to its instance quad. It is
  // fine for small crisp arrowheads; it is unusable for haze. sdEllipse is a
  // proper gradient-corrected distance and behaves at any softness.
  //
  // The taper is faked instead by stacking three progressively wider, dimmer
  // ellipses down the beam — which also reads better than a true cone, because a
  // real shaft scatters more the further it travels through the rain.
  // ═══════════════════════════════════════════════════════════════════════════
  _shafts(camX, camY, halfW, halfH, px, od) {
    const dt = this.drift;
    for (let i = 0; i < SHAFT_COUNT; i++) {
      const b = this.shBand[i];
      const P = BAND_PARALLAX[b];
      const x = camX * P + this.shOff[i];
      const topY = NOMINAL_CAM_Y * P + halfH * (HORIZON_FRAC + BAND_BASE[b]) - halfH * this.shTop[i];
      const len = halfH * this.shLen[i];
      const wid = halfH * this.shWid[i];
      // Slow sway, plus a wider swing under overdrive.
      const ang = Math.sin(dt * this.shRate[i] * 2.4 + this.shPh[i]) * (0.30 + od * 0.16);
      // rot = -ang maps the ellipse's local +Y onto (sin ang, cos ang) — down-beam.
      const rot = -ang;
      const sa = Math.sin(ang), ca = Math.cos(ang);
      const col = NEON_SET[this.shHue[i]];
      const br = 0.72 + 0.28 * Math.sin(dt * 0.7 + this.shPh[i] * 2.1);

      for (let k = 0; k < 3; k++) {
        const f = 0.18 + k * 0.30;            // fraction along the beam
        const w = wid * (0.5 + k * 0.55);     // widening with distance
        const seg = len * (0.26 + k * 0.05);  // segment half-length
        const val = (0.085 / (1 + k * 1.35)) * br * (1 + od * 0.8);
        emissive(_cAux, col, val, 1, od);
        this._ell(LAYER.FAR_GLOW, x + sa * len * f, topY + ca * len * f, w, seg, rot, _cAux,
          { glow: 0.25, glowRadius: w * 1.2, soft: w * 1.5, parallax: P });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOREGROUND BAND  —  parallax 1.30, ~8 primitives, LAYER.SOLID
  //
  // Near-black pylons and slabs that streak past faster than the world. Sparse and
  // mostly narrow so they never smother the play space; nothing here is emissive
  // except the occasional dying service light.
  // ═══════════════════════════════════════════════════════════════════════════
  _foreBand(camX, camY, halfW, halfH, px) {
    const P = FG_PARALLAX;
    const centre = camX * P;
    const c0 = Math.floor((centre - halfW - FG_COLW) / FG_COLW);
    const c1 = Math.floor((centre + halfW + FG_COLW) / FG_COLW);
    const baseY = NOMINAL_CAM_Y * P + halfH * 2.0;

    tint(_cSil, this.silNear, 0.55, 1.0);

    for (let c = c0; c <= c1; c++) {
      sr(colKey(this.seed, 9, c));
      if (rnd() >= FG_FILL) continue;

      const x = c * FG_COLW + rr(-0.35, 0.35) * FG_COLW;
      const slab = rnd() < 0.28;
      const hw = slab ? FG_COLW * rr(0.14, 0.30) : rr(0.5, 2.4);
      const top = halfH * rr(0.26, 0.86) + NOMINAL_CAM_Y * P;
      const bh = (baseY - top) * 0.5;
      this._rect(LAYER.SOLID, x, top + bh, hw, bh, 0, _cSil,
        { glow: 0, soft: px * 1.3, parallax: P });

      // A cross-brace or a mast on the pylons — pure silhouette detail.
      if (!slab && rnd() < 0.5) {
        this._rect(LAYER.SOLID, x, top + halfH * rr(0.05, 0.25), hw * rr(2.5, 5.0), hw * 0.5, 0, _cSil,
          { glow: 0, soft: px * 1.3, parallax: P });
      }
      // A single guttering service lamp.
      if (rnd() < 0.45) {
        const blink = Math.sin(this.t * 1.1 + c * 2.3) > 0.2 ? 1 : 0.08;
        emissive(_cAux, rnd() < 0.5 ? PAL.amber : PAL.cyan, 0.9 * blink, 1, this.od);
        this._glow(LAYER.FAR_GLOW, x, top + rr(0.5, 3.5), Math.max(hw * 0.8, px * 2.5), _cAux,
          { glow: 1.6, glowRadius: Math.max(hw * 0.6, px * 2), soft: px * 2, parallax: P });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FLOOD MIST  —  0–4 primitives, LAYER.SOLID
  //
  // Anchored near CFG.FLOODLINE at high parallax, so diving toward the water
  // drowns the frame in mist as you approach death.
  //
  // There used to be a second, camera-locked "screen murk" stack weighting the
  // bottom of every frame. It is gone: a full-width wash that is always on is a
  // global black-level lift and nothing else — it cost ~12 points of true-black
  // and bought no depth information, because it sat at a fixed screen position and
  // therefore never separated two things from each other. Atmosphere has to live
  // *between* depth planes (see _scrim) or be tied to something real (here, the
  // floodline). Anything else is just fog on the lens.
  //
  // Intensity now ramps with proximity to the floodline, so in normal play this
  // costs nothing at all and near death it is unmistakable.
  // ═══════════════════════════════════════════════════════════════════════════
  _flood(camX, camY, halfW, halfH, px, od) {
    const FP = 0.75;
    const fy = CFG.FLOODLINE - 2;
    const fx = camX * FP;
    // 0 when the camera is a full view-height above the water, 1 when level with it.
    const near = clamp01(1 - (fy - camY) / (halfH * 1.35));
    if (near <= 0.01) return;
    const swell = Math.sin(this.drift * 0.35) * halfH * 0.02;
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      mix3(_cFog, this.fogCol, PAL.violet, 0.22 + 0.25 * t,
        lerp(1.5, 0.9, t), lerp(0.42, 0.15, t) * near);
      this._rect(LAYER.SOLID, fx, fy + swell * (1 - t) - halfH * lerp(0.02, 0.34, t),
        halfW * 2.4, halfH * lerp(0.20, 0.40, t), 0, _cFog,
        { glow: 0, soft: halfH * lerp(0.14, 0.34, t), parallax: FP });
    }
    // A cold sheen bouncing off the water, on FAR_GLOW so it actually emits.
    emissive(_cAux, PAL.cyan, (0.10 + od * 0.07) * near, 1, od);
    this._ell(LAYER.FAR_GLOW, fx, fy + halfH * 0.05, halfW * 1.6, halfH * 0.09, 0, _cAux,
      { glow: 0.3, glowRadius: halfH * 0.08, soft: halfH * 0.14, parallax: FP });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RAIN  —  190 primitives, LAYER.FOREGROUND
  //
  // Fixed pool, screen-relative storage, wrapped every frame — never allocates and
  // never drifts out of the view no matter what the camera does. The streak vector
  // is one shared per-frame direction: ambient wind plus RAIN_SHEAR × player speed,
  // so at terminal velocity the rain lies down into near-horizontal tracers.
  // ═══════════════════════════════════════════════════════════════════════════
  _rain(camX, camY, halfW, halfH, px, od) {
    const s01 = this.speed01;

    // Shared streak direction. dx is negative (rain streams backwards past you).
    const dx = -(RAIN_WIND + this.speed * RAIN_SHEAR);
    const dy = RAIN_FALL;
    const inv = 1 / Math.sqrt(dx * dx + dy * dy);
    const ux = dx * inv, uy = dy * inv;

    const baseLen = lerp(RAIN_LEN_MIN, RAIN_LEN_MAX, s01 * s01 * 0.55 + s01 * 0.45);

    for (let i = 0; i < RAIN_COUNT; i++) {
      const d = this.rnD[i];
      const near = d > 1.4;
      const x0 = camX + this.rnX[i];
      const y0 = camY + this.rnY[i];
      const len = baseLen * this.rnL[i] * d;
      // Per-drop shear jitter: without it every streak is exactly parallel and the
      // whole screen reads as a printed hatch rather than as weather.
      const x1 = x0 + ux * len * this.rnA[i];
      const y1 = y0 + uy * len;

      // Close drops are fatter, dimmer per unit area and defocused; far drops are
      // hairline-thin and crisp. That contrast is the whole depth read.
      const w = near ? px * lerp(2.0, 4.0, s01) * d : px * lerp(0.80, 1.3, s01) * d;
      // Energy conservation: a streak stretched by speed gets proportionally fainter.
      const smear = 1 / (0.5 + 0.5 * (len / RAIN_LEN_MIN));
      const a = this.rnB[i] * (near ? 0.13 : 0.42) * smear;

      emissive(_cRain, near ? PAL.cyan : PAL.hot, (near ? 0.24 : 0.34) * a, 1, od * 0.35);
      this._line(LAYER.FOREGROUND, x0, y0, x1, y1, w, _cRain,
        { glow: near ? 1.1 : 0.55, glowRadius: near ? w * 5 : w * 2.6,
          soft: near ? px * 4.5 : px * 0.95, parallax: 1 });
    }

    // Three squall sheets: very wide, very faint, sheared with the rain and
    // drifting across. They give the downpour a sense of gusting mass.
    for (let i = 0; i < 3; i++) {
      const ph = i * 2.399;
      const sxp = camX + Math.sin(this.drift * (0.21 + i * 0.07) + ph) * halfW * 0.9;
      const syp = camY + Math.cos(this.drift * 0.13 + ph) * halfH * 0.35;
      const rot = Math.atan2(uy, ux);
      emissive(_cRain, PAL.cyan, 0.0022 * (0.6 + 0.4 * Math.sin(this.drift * 0.9 + ph)), 1, od * 0.4);
      this._ell(LAYER.FOREGROUND, sxp, syp, halfH * (0.8 + 0.3 * i), halfW * 0.75, rot, _cRain,
        { glow: 0.12, glowRadius: halfW * 0.5, soft: halfW * 1.1, parallax: 1 });
    }
  }
}
