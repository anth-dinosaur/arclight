// ARCLIGHT — integration. Owns the loop, camera, scoring, overdrive and the event sink.

import { CFG, PAL } from './core/config.js';
import { clamp, clamp01, damp, lerp, remap, easeOutCubic } from './core/math.js';
import { createContext, createFullscreenQuad, installContextLoss, queryExtensions } from './core/gl.js';
import { Renderer, LAYER } from './core/renderer.js';
import { Input } from './core/input.js';
import { Post } from './gfx/post.js';
import { Backdrop } from './gfx/backdrop.js';
import { World } from './game/world.js';
import { Player } from './game/player.js';
import { Fx } from './game/fx.js';
import { Audio } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';

const STATE = { TITLE: 0, PLAY: 1, DYING: 2, DEAD: 3 };

// Standard display intervals, ms, fastest first. Quantising measured intervals to
// this list strips vsync jitter and keeps the deadline a number a panel can hit.
//
// Belief-by-vote stops at 60Hz, and that is load-bearing rather than lazy. From rAF
// deltas alone "a 30Hz presentation" and "a 60Hz display where we miss every other
// vsync" are the SAME OBSERVATION — steady 33ms callbacks — and no browser API
// exposes the real refresh rate to disambiguate them. A display slower than 60Hz
// essentially does not exist, while a 60Hz display we are only half keeping up with
// is the single most common way this game runs badly, so votes alone never move the
// belief below 60. The final 30Hz slot exists for the one case that genuinely does
// present that slowly — a rAF cap, e.g. iOS Low Power Mode — and is reachable only
// through the intervention probe described at CFG.PERF_CAP_MISS, never by votes.
// (The slot still collects votes: that is how the doubled beat is recognised going
// in, and how its disappearance is recognised coming out.)
const REFRESH_MS = [1000 / 144, 1000 / 120, 1000 / 90, 1000 / 60, 1000 / 30];
/** Slowest refresh VOTES may believe (60Hz) — see above; the ratchet stops here. */
const REFRESH_SLOWEST = REFRESH_MS.length - 2;
/** The presentation-cap slot (30Hz), reachable only by the cap probe. */
const REFRESH_CAP = REFRESH_MS.length - 1;

/** Index of the standard display interval nearest a measured one. */
function nearestRefresh(ms) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < REFRESH_MS.length; i++) {
    const d = Math.abs(ms - REFRESH_MS[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------------
// COMBO LADDER
//
// The multiplier used to be a flat division — `1 + floor(combo / COMBO_PER_STEP)` —
// which made every step cost the same. It should not. See CFG.COMBO_EARLY_STEP: the
// multiplier is the only mid-run signal that a run is going well, and at a flat 5 it
// was unreachable for the tier that needs it most (the `hold` bot spends 84% of its
// run at ×1, where the badge does not even render).
//
// The two functions are exact inverses and MUST stay so. The decay path steps the
// multiplier down and then rewrites `combo` to the floor of the new tier; if that
// floor disagreed with the ladder by even one event, a player could sit on a boundary
// and flicker a tier every window.
//
// NOTE: sim2.mjs mirrors both. Change these, change those.
const CB_E = () => CFG.COMBO_EARLY_STEP ?? CFG.COMBO_PER_STEP;
const CB_N = () => CFG.COMBO_EARLY_N ?? 0;

/** Multiplier for a combo count. */
function multForCombo(c) {
  const e = CB_E(), n = CB_N(), s = CFG.COMBO_PER_STEP, knee = n * e;
  const m = c < knee ? 1 + Math.floor(c / e)
                     : 1 + n + Math.floor((c - knee) / s);
  return clamp(m, 1, CFG.COMBO_MAX_MULT);
}

/** Fewest combo events that reach a multiplier — the inverse of multForCombo. */
function comboForMult(m) {
  const e = CB_E(), n = CB_N(), s = CFG.COMBO_PER_STEP;
  if (m <= 1) return 0;
  return m - 1 <= n ? (m - 1) * e : n * e + (m - 1 - n) * s;
}

class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    const ctx = createContext(this.canvas);
    if (!ctx) { showFatal('This device does not support WebGL2.'); return; }
    this.gl = ctx.gl;
    this.hdrSupported = ctx.hdr;

    this.quad = createFullscreenQuad(this.gl);
    this.renderer = new Renderer(this.gl, CFG.MAX_INSTANCES);
    this.post = new Post(this.gl, this.quad);

    // Without float render targets the scene target clamps at 1.0, which would throw
    // away every emissive value the whole look depends on. Compress emission into
    // [0,1] at draw time and hand post the reciprocal as extra exposure.
    this.emissiveScale = this.hdrSupported ? 1 : 1 / 3;
    this.renderer.hdrScale = this.emissiveScale;

    // iOS Safari drops WebGL contexts on lock-screen, backgrounding and memory
    // pressure, and WebKit only ever restores one if the loss event is
    // preventDefault()ed. Without this the loop keeps running against a dead
    // context: a frozen black screen under a live HUD, and no console error.
    this.glLost = installContextLoss(this.canvas, { onRestore: () => this.rebuildGl() });

    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.backdrop = new Backdrop(this.seed);
    this.world = new World(this.seed);
    this.player = new Player();
    this.fx = new Fx();
    this.audio = new Audio();
    this.input = new Input(window);

    this.hud = new Hud(document.getElementById('hud'));
    this.screens = new Screens(document.getElementById('screens'), {
      onStart: (e) => this.start(e),
      onRetry: (e) => this.start(e),
      onToggleAudio: (on) => { this.audio.enabled = on; if (on) this.audio.unlock(); },
    });

    // ---- run state ---------------------------------------------------------
    this.state = STATE.TITLE;
    this.time = 0;
    this.runTime = 0;
    this.distance = 0;
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.multiplier = 1;
    this.multiplierPeak = 1;
    this.perfects = 0;
    this.hazardGrazes = 0;
    /** Overdrives triggered this run — reported by name in the RUN REPORT. */
    this.overdrives = 0;
    this.charge = 0;
    this.overdrive = 0;
    this.overdriveActive = false;
    this.chargeFull = false;      // meter banked, waiting on an arc to spend it
    this.chargeFullT = 0;         // ...and how long it has been waiting
    this.startX = 0;

    // `.s2` is the economy epoch — see the note on LS_BEST in screens.js. Bump both
    // files together whenever a rebalance changes what a point is worth.
    this.best = Number(localStorage.getItem('arclight.best.s2') || 0);
    this.bestDistance = Number(localStorage.getItem('arclight.bestDistance.s2') || 0);

    // ---- camera ------------------------------------------------------------
    this.camX = 0; this.camY = 0;
    this.camTargetX = 0; this.camTargetY = 0;
    this.roll = 0;
    this.trauma = 0;
    this.shakeX = 0; this.shakeY = 0;
    this.zoom = 1;
    this.zoomBoost = 1;
    // Must exist before the first updateCamera() — a NaN here propagates into zoom
    // through damp() and never recovers, which renders the entire scene invisible.
    this.speed01 = 0;
    /** 0..1 proximity to the floodline over FLOOD_WARN_BAND. Drives both the danger
     *  vignette and the water-surface alarm in world.render — one number so the two
     *  halves of the drowning telegraph can never drift apart. */
    this.flood01 = 0;

    // ---- feel --------------------------------------------------------------
    this.hitstop = 0;
    this.timescale = 1;
    this.flash = 0;
    this.deathTimer = 0;

    // ---- adaptive quality --------------------------------------------------
    this.quality = 1;
    this.frameMs = 16.7;        // smoothed, diagnostic only — see adaptQuality
    this.frameCount = 0;
    /** Presentation cadence: render every Nth vsync. See CFG frame-pacing block. */
    this.cadence = 1;
    this._acc = 0;              // accumulated unrendered vsync time
    // Believed display interval. Starts pessimistic (60Hz) and only ever ratchets
    // FASTER, tracked as a high-water mark: a panel does not slow down mid-session,
    // so once we have seen 120Hz vsyncs, later windows that never manage one are
    // evidence we are dropping frames — not evidence the display changed.
    this._refreshIdx = REFRESH_SLOWEST;
    this.refreshMs = REFRESH_MS[REFRESH_SLOWEST];
    this._winT = 0;             // elapsed time in the current verdict window
    this._winN = 0;             // rendered frames in it
    this._winMiss = 0;          // ...of which missed the deadline
    /** Votes per standard refresh rate — how the display's cadence is identified. */
    this._rBins = new Int32Array(REFRESH_MS.length);
    this._rVotes = 0;
    this._cleanT = 0;           // consecutive clean time, for stepping back up
    this._cooldown = 0;
    this._probeBackoff = 1;     // grows after a failed cadence-1 probe
    /** Presentation-capped (e.g. Low Power Mode) — see CFG.PERF_CAP_MISS. */
    this.capped = false;
    this._capProbe = false;     // floor-res probe in flight to confirm a suspected cap
    /** Diagnostics, for tools/dev. Rewritten each verdict, never reallocated. */
    this.perf = { refreshMs: 16.7, cadence: 1, missRatio: 0, quality: 1, fps: 60, capped: false };
    /** Corner perf readout — rendered fps over half-second buckets. */
    this._fpsEl = document.getElementById('perf');
    this._fpsN = 0; this._fpsT = 0; this._fpsStr = '';

    // ---- state handed to subsystems (preallocated, never reallocated) ------
    this.postState = {
      time: 0, speed01: 0, overdrive01: 0, trauma: 0,
      aberration: 0, vignette: 1, flash: 0, damage01: 0, exposure: 1,
    };
    this.audioState = {
      speed01: 0, multiplier: 1, overdrive01: 0, tension01: 0, alive: true, menu: true,
    };
    this.hudState = {
      distance: 0, score: 0, multiplier: 1, charge01: 0,
      overdrive01: 0, odExit: false, alive: true, speed01: 0, menu: true,
      holding: false, chargeFull: false, perfectCue: 0,
    };

    this.events = makeEventSink(this);

    this.dpr = 1;
    this.viewW = 1; this.viewH = 1;       // native canvas px — quality-invariant
    this.renderW = 1; this.renderH = 1;   // internal scene px — viewW×H × quality
    this.cssW = 1; this.cssH = 1;
    this._resizeRaf = 0;
    this.resize();
    // iOS fires visualViewport resize on every frame of a URL-bar animation, and
    // resize() reallocates the scene target and all four bloom mips. Coalescing
    // every source into one rAF makes a toolbar slide cost one reallocation.
    const scheduleResize = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.resize();
      });
    };
    window.addEventListener('resize', scheduleResize);
    // Safari reports pre-rotation dimensions for a beat after the event fires.
    window.addEventListener('orientationchange', () => setTimeout(scheduleResize, 120));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleResize);
    }

    document.addEventListener('visibilitychange', () => {
      // Coming back from a background tab produces one gigantic dt; swallow it.
      // The pacing accumulator and the verdict window have to go with it, or that
      // one frame reads as a missed deadline and can cost a quality step.
      if (!document.hidden) {
        this.lastT = this._prevNow = performance.now();
        this._acc = 0;
        this._resetWindow();
      }
    });

    this.screens.showTitle();
    this.resetRun(true);

    this.lastT = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    // The canvas box, not the window. #gl is `position:fixed; inset:0` with
    // `height:100dvh`, so its rect is the surface actually being composited;
    // window.innerHeight on iOS reports the LARGE viewport (the one behind the
    // URL bar), which makes the backing store a different aspect than the box
    // and stretches the scene through every toolbar transition.
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width) || window.innerWidth);
    const cssH = Math.max(1, Math.round(rect.height) || window.innerHeight);
    // The canvas backing store is NATIVE resolution, always — quality is not in
    // this number. Internal resolution scales in the offscreen scene target and
    // the composite upscales, so a governor step never reallocates the default
    // framebuffer (Safari presents a stretched frame during that swap — it read
    // as a momentary zoom), never softens the grain/scanline/dither grade, and
    // never moves baseZoom, which `zoomBoost` chases over ~300ms: deriving it
    // from a quality-scaled width made every quality change a visible zoom.
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR) * CFG.RENDER_SCALE;
    this.cssW = cssW; this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Deliberately NOT writing canvas.style.{width,height}: pinning the box in
    // px overrides the 100dvh rule and freezes it mid-transition.
    this.viewW = w; this.viewH = h;
    this.applyQuality();
    // Portrait phones get the design width; wide screens keep the same vertical extent
    // so a desktop browser sees more sky rather than a giant player.
    const aspect = w / h;
    this.baseZoom = aspect < 0.75
      ? w / CFG.VIEW_WIDTH
      : h / (CFG.VIEW_WIDTH / 0.62);
  }

  /**
   * Recreate every GL-owned object after a context restore. Programs, buffers,
   * textures and VAOs from before the loss are all gone; nothing is reusable.
   */
  rebuildGl() {
    this.hdrSupported = queryExtensions(this.gl);
    this.emissiveScale = this.hdrSupported ? 1 : 1 / 3;
    this.quad = createFullscreenQuad(this.gl);
    this.renderer = new Renderer(this.gl, CFG.MAX_INSTANCES);
    this.renderer.hdrScale = this.emissiveScale;
    this.post = new Post(this.gl, this.quad);
    this.post.setQuality(this.quality);
    this.resize();
    // Swallow the dt accumulated while dark, and everything derived from it — a
    // restore is a fresh set of shader compiles, not evidence about the GPU.
    this.lastT = this._prevNow = performance.now();
    this._acc = 0;
    this._resetWindow();
    this._cooldown = CFG.PERF_COOLDOWN;
  }

  // ---- run lifecycle -------------------------------------------------------

  resetRun(silent = false) {
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.world.reset(this.seed);
    this.startX = CFG.SPAWN_X;
    this.player.reset(CFG.SPAWN_X, CFG.SPAWN_Y);
    // Let the world generate around the spawn before the first physics step, so the
    // spawn-safety guarantees are in place on frame one.
    this.world.update(0, CFG.SPAWN_X, CFG.SPAWN_Y);
    this.fx.clear();
    this.hud.reset();
    this.distance = 0; this.score = 0;
    this.combo = 0; this.comboTimer = 0;
    this.multiplier = 1; this.multiplierPeak = 1; this.perfects = 0;
    this.hazardGrazes = 0; this.overdrives = 0;
    this.charge = 0; this.overdrive = 0; this.overdriveActive = false;
    this.chargeFull = false; this.chargeFullT = 0; this.player.invuln = false;
    this.trauma = 0; this.flash = 0; this.hitstop = 0;
    this.runTime = 0; this.deathTimer = 0;
    this.timescale = 1;
    this.camX = this.player.x; this.camY = this.player.y + CFG.CAMERA_Y_BIAS;
    this.roll = 0;
    if (!silent) this.audio.uiTap();
  }

  start(e) {
    this.audio.unlock();
    this.resetRun();
    this.screens.hide();
    this.state = STATE.PLAY;
    this.input.setEnabled(true);
    // The same pointerdown that pressed LAUNCH was rejected by Input.isUi(), so
    // a press-and-hold dropped the first input of every single run. Adopt it and
    // the hold flows straight into the first swing.
    this.input.adopt(e && e.pointerId);
  }

  die(x, y, vx, vy) {
    if (this.state !== STATE.PLAY) return;
    this.state = STATE.DYING;
    this.deathTimer = 0;
    this.hitstop = CFG.HITSTOP_CRASH;
    this.trauma = CFG.TRAUMA_CRASH;
    this.flash = 1;
    this.fx.crash(x, y, vx, vy);
    this.audio.crash();
    vibrate(60);
    this.endOverdrive(false);
  }

  finishDeath() {
    this.state = STATE.DEAD;
    const dist = Math.floor(this.distance);
    const isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = this.score;
      localStorage.setItem('arclight.best.s2', String(this.best));
    }
    if (dist > this.bestDistance) {
      this.bestDistance = dist;
      localStorage.setItem('arclight.bestDistance.s2', String(dist));
    }
    this.screens.showGameOver({
      distance: dist,
      score: Math.floor(this.score),
      best: Math.floor(this.best),
      bestDistance: this.bestDistance,
      multiplierPeak: this.multiplierPeak,
      perfects: this.perfects,
      hazardGrazes: this.hazardGrazes,
      overdrives: this.overdrives,
      isNewBest,
    });
  }

  // ---- scoring -------------------------------------------------------------

  addScore(base) {
    this.score += base * this.multiplier * (this.overdriveActive ? CFG.OVERDRIVE_SCORE_MULT : 1);
  }

  bumpCombo() {
    this.combo++;
    this.comboTimer = CFG.COMBO_WINDOW;
    const m = multForCombo(this.combo);
    if (m > this.multiplier) {
      this.multiplier = m;
      if (m > this.multiplierPeak) this.multiplierPeak = m;
    }
  }

  /**
   * Charge BANKS; it does not auto-fire. DESIGN.md L5 is "bank charge, trigger it on
   * a dense hazard cluster", which is impossible if the meter spends itself the
   * instant it fills. A full meter arms `chargeFull` and OVERDRIVE fires on the NEXT
   * PERFECT ARC. That keeps the one-input promise — you never press anything extra —
   * while making *when* you take your next arc a real decision.
   */
  addCharge(amount) {
    if (this.overdriveActive) return;
    this.charge = clamp01(this.charge + amount);
    if (this.charge >= 1 && !this.chargeFull) {
      this.chargeFull = true;
      this.chargeFullT = 0;
      this.hud.popup('combo', 'OVERDRIVE READY', this.cssW * 0.5, this.cssH * 0.42);
      vibrate(14);
    }
  }

  startOverdrive() {
    this.overdriveActive = true;
    this.overdrives++;
    this.chargeFull = false;
    this.chargeFullT = 0;
    this.overdrive = CFG.OVERDRIVE_DURATION;
    this.charge = 1;
    this.player.invuln = true;          // DESIGN.md's promised invulnerability
    this.fx.overdrive(this.player.x, this.player.y);
    this.trauma = Math.max(this.trauma, 0.5);
    // 0.55, not 0.7: the flash now sits in front of the tonemap with a bleach knee
    // at 0.35, so 0.7 whites the frame out. 0.55 is a strong gain pop with only a
    // light centre bleach — a state change, not a crash.
    this.flash = Math.max(this.flash, 0.55);
    this.audio.overdriveStart();
    vibrate(30);
  }

  /** `refund01` is 0 (expired / died) or a fraction of OVERDRIVE_REFUND (exit arc). */
  endOverdrive(refund01) {
    if (!this.overdriveActive) return;
    this.overdriveActive = false;
    this.overdrive = 0;
    this.player.invuln = false;
    this.charge = refund01 > 0 ? CFG.OVERDRIVE_REFUND * refund01 : 0;
    this.chargeFull = false;
    this.chargeFullT = 0;
    this.audio.overdriveEnd();
  }

  /** World position -> CSS pixel position, for HUD popups. */
  worldToScreenX(wx) { return (wx - this.camX) * this.zoom / this.dpr + this.cssW * 0.5; }
  worldToScreenY(wy) { return (wy - this.camY) * this.zoom / this.dpr + this.cssH * 0.5; }

  // ---- loop ----------------------------------------------------------------

  loop(now) {
    requestAnimationFrame(this.loop);

    // Context is gone: keep the rAF alive so we notice the restore, but neither
    // simulate nor draw. Simulating blind would teleport the player while the
    // screen is dark.
    if (this.glLost && this.glLost.lost) {
      this.lastT = now; this._prevNow = now; this._acc = 0; return;
    }

    // The raw vsync delta — the DISPLAY's cadence, not ours. At cadence > 1 several
    // of these fold into one rendered frame, so this is the only signal that can
    // tell us how fast the panel actually is.
    const vsync = now - (this._prevNow ?? now);
    this._prevNow = now;
    if (vsync > 0) {
      this._winT += vsync;
      // Vote for the standard refresh nearest this interval. Anything faster than
      // any real display is a timing glitch and does not get a vote.
      if (vsync >= CFG.PERF_MIN_INTERVAL) {
        this._rBins[nearestRefresh(vsync)]++;
        this._rVotes++;
      }
    }

    // Frame pacing. At cadence 1 every callback passes straight through. Above it,
    // vsync time accumulates and only every Nth callback does work — which converts
    // an unstable "somewhere between 120 and 60" into an exact divisor of the
    // refresh. The 2% slack absorbs vsync jitter so a beat is never missed by a hair.
    if (this.cadence > 1) {
      this._acc += vsync;
      if (this._acc < this.refreshMs * this.cadence * 0.98) return;
      this._acc = 0;
    }

    // Interval between RENDERED frames — at cadence 1 identical to `vsync`, above it
    // the beat we are actually trying to hold. This is what the governor judges.
    const frameMs = now - this.lastT;
    this.frameMs = lerp(this.frameMs, frameMs || 16.7, 0.08);
    this.adaptQuality(frameMs);

    let rawDt = frameMs / 1000;
    this.lastT = now;
    if (!(rawDt > 0)) rawDt = 1 / 60;
    // Never simulate more than a 20fps step. The player's substep budget is sized to
    // exactly this number (config.js: MAX_SIM_DT) — if they diverge, the player and
    // the hazards advance by different amounts of time on slow frames.
    rawDt = Math.min(rawDt, CFG.MAX_SIM_DT);

    this.input.poll();
    this.update(rawDt);
    this.render();

    // Corner readout: rendered fps + what the governor is doing about it. Text is
    // rebuilt twice a second and only touches the DOM when it actually changed.
    this._fpsN++; this._fpsT += frameMs;
    if (this._fpsT >= 500 && this._fpsEl) {
      const fps = Math.round(1000 * this._fpsN / this._fpsT);
      const s = fps + ' fps · q' + this.quality.toFixed(2)
        + (this.capped ? ' · cap' : this.cadence > 1 ? ' · ½rate' : '');
      if (s !== this._fpsStr) { this._fpsStr = s; this._fpsEl.textContent = s; }
      this._fpsN = 0; this._fpsT = 0;
    }
  }

  /**
   * The frame-rate governor.
   *
   * The previous version smoothed frame times into an EMA and compared it against
   * two hardcoded 60Hz constants (slow above 20ms, fast below 17.2ms). That cannot
   * see the failure it exists to catch. Measured on a GPU-bound frame, the deltas
   * were bimodal — 18% at 8.3ms, 64% at 17-21ms, 5% past 34ms — because consecutive
   * frames landed on different sides of a vsync boundary. That IS stutter. But the
   * mean of that distribution is 15.65ms, *under* the 17.2ms "fast" threshold, so
   * the governor scored 18 seconds of visible judder as spare headroom and took no
   * action at all. An average cannot detect a distribution straddling a deadline;
   * only counting the misses can.
   *
   * The hardcoded 60Hz was the second half of the bug. On a 120Hz panel the budget
   * is 8.33ms, so every frame from 8.4 to 17.1ms is a MISSED deadline that the old
   * code scored as fast — it would have raised quality while dropping every other
   * frame.
   *
   * So: measure the refresh rate rather than assume it, count missed deadlines
   * rather than average them, and require the miss rate to be SUSTAINED across a
   * multi-second window. An isolated hiccup — a GC, a chunk, a shader compile — is
   * not a quality problem and must not be paid for with permanent resolution.
   */
  adaptQuality(frameMs) {
    // Startup: shader compiles and the first chunk generation are a burst of slow
    // frames that would otherwise pin the game at minimum resolution forever.
    if (++this.frameCount < 4 || this.time < CFG.PERF_WARMUP) {
      this._resetWindow();
      return;
    }

    const budget = this.capped ? REFRESH_MS[REFRESH_CAP] : this.refreshMs * this.cadence;
    this._winN++;
    if (frameMs > budget * CFG.PERF_MISS_TOLERANCE) this._winMiss++;

    // A change is still settling: its reallocation hitch would read as a miss.
    if (this._cooldown > 0) {
      this._cooldown -= frameMs / 1000;
      if (this._cooldown > 0) { this._resetWindow(); return; }
    }

    if (this._winT < CFG.PERF_WINDOW * 1000 || this._winN < 8) return;
    const miss = this._winMiss / this._winN;

    // Revise the believed refresh: the fastest standard rate that carried a real
    // share of this window, ratcheting the high-water mark. Nothing clearing the
    // threshold leaves the belief alone, which is what stops a non-vsynced context
    // (or one glitched delta) from being read as an impossibly fast display.
    if (this._rVotes > 0) {
      const need = this._rVotes * CFG.PERF_REFRESH_VOTE;
      for (let i = 0; i < this._refreshIdx; i++) {
        if (this._rBins[i] >= need) { this._refreshIdx = i; break; }
      }
      this.refreshMs = REFRESH_MS[this._refreshIdx];
    }

    // How much of the window sat exactly on the doubled beat. This is the signature
    // of a presentation cap — and of nothing else the governor can fix with pixels.
    const capShare = this._rVotes > 0 ? this._rBins[REFRESH_CAP] / this._rVotes : 0;

    const p = this.perf;
    p.refreshMs = +this.refreshMs.toFixed(2);
    p.cadence = this.cadence;
    p.missRatio = +miss.toFixed(3);
    p.quality = this.quality;
    p.fps = Math.round(1000 * this._winN / this._winT);
    p.capped = this.capped;

    // ---- presentation cap (see CFG.PERF_CAP_MISS) --------------------------
    if (this.capped) {
      // The cap lifts (Low Power Mode off, ProMotion back): real vsync intervals
      // reappear and the doubled beat vanishes. Drop the belief and re-measure.
      if (this._rVotes >= 8 && 1 - capShare >= CFG.PERF_CAP_EXIT) {
        this.capped = false;
        this._commit();
        return;
      }
    } else if (miss >= CFG.PERF_CAP_MISS && capShare >= CFG.PERF_CAP_VOTE) {
      // Every frame is late and every interval sits on the doubled beat. Either the
      // GPU takes one-to-two refreshes per frame — which floor resolution would fix,
      // fill rate being linear in pixels — or nothing we draw changes when the
      // callback fires, because the rate is capped. Only intervening can tell them
      // apart: probe at floor resolution, and if the misses do not move, believe the
      // cap and stop paying pixels for a deadline pixels cannot buy.
      if (this._capProbe || this.quality <= CFG.QUALITY_FLOOR) {
        this._capProbe = false;
        this.capped = true;
        this.cadence = 1;       // pacing on top of a cap would halve the rate again
        this._acc = 0;
        this.quality = 1;       // every step down was taken on a false premise
        this.applyQuality();
        this._commit();
        return;
      }
      this._capProbe = true;
      this.quality = CFG.QUALITY_FLOOR;
      this.applyQuality();
      this._commit();
      return;
    } else if (this._capProbe) {
      // Floor resolution moved the misses after all: real fill-rate load, not a cap.
      // Keep the cheap frame and let the up path climb back to what sustains.
      this._capProbe = false;
    }

    if (miss > CFG.PERF_DOWN_RATIO) {
      this._cleanT = 0;
      // Pace down BEFORE turning anything down. Halving the rate costs no pixels,
      // and on a high-refresh panel an exact divisor of the refresh is smoother
      // than an in-between frame rate at higher resolution.
      if (!this.capped && this.cadence === 1 && this.refreshMs * 2 <= CFG.PERF_CADENCE_MAX_MS) {
        this.cadence = 2;
        this._acc = 0;
        this._commit();
      } else if (this.quality > CFG.QUALITY_FLOOR) {
        this.quality = Math.max(CFG.QUALITY_FLOOR, this.quality - 0.15);
        this.applyQuality();
        this._commit();
      } else {
        this._resetWindow();   // nothing left to give; stop churning on it
      }
      return;
    }

    if (miss < CFG.PERF_UP_RATIO) {
      this._cleanT += this._winT / 1000;
      if (this._cleanT >= CFG.PERF_UP_HOLD * this._probeBackoff) {
        this._cleanT = 0;
        if (this.quality < 1) {
          // Pixels back first: full resolution is worth more than the extra frames.
          this.quality = Math.min(1, this.quality + 0.1);
          this.applyQuality();
          this._commit();
          return;
        }
        if (this.cadence > 1) {
          // Probe the full refresh again in case conditions changed. If it does not
          // hold we end up back here, so back the retry off to bound how often that
          // probe costs a window of stutter.
          this.cadence = 1;
          this._acc = 0;
          this._probeBackoff = Math.min(8, this._probeBackoff * 2);
          this._commit();
          return;
        }
        this._probeBackoff = 1;   // fully healthy — forget past failures
      }
    } else {
      this._cleanT = 0;
    }
    this._resetWindow();
  }

  /**
   * Push the current quality into the scene target and the bloom chain. The canvas
   * is untouched: only offscreen targets reallocate, so a quality step costs a
   * texture realloc (covered by the governor cooldown) and no visible artifact.
   */
  applyQuality() {
    // Shrink the bloom chain with the scene. Post exposes the hook and nothing was
    // calling it, so the blur ping-pongs — the most fill-rate-hungry part of the
    // frame — stayed full size no matter how far quality dropped.
    this.post.setQuality(this.quality);
    this.renderW = Math.max(1, Math.round(this.viewW * this.quality));
    this.renderH = Math.max(1, Math.round(this.viewH * this.quality));
    this.post.resize(this.renderW, this.renderH);
  }

  /** Commit a pacing/quality change: swallow the settling hitch, then re-measure. */
  _commit() {
    this._cooldown = CFG.PERF_COOLDOWN;
    this._resetWindow();
  }

  _resetWindow() {
    this._winT = 0; this._winN = 0; this._winMiss = 0;
    this._rBins.fill(0); this._rVotes = 0;
  }

  update(rawDt) {
    this.time += rawDt;

    // Hitstop freezes simulation but not the clock, so impacts read as a punch.
    let dt = rawDt;
    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      dt = rawDt * 0.06;
    }

    // Time dilation: overdrive slows the world slightly; death slows it a lot.
    let targetScale = 1;
    if (this.overdriveActive) targetScale = CFG.OVERDRIVE_TIMESCALE;
    if (this.state === STATE.DYING) targetScale = 0.22;
    if (this.state === STATE.TITLE || this.state === STATE.DEAD) targetScale = 0.65;
    this.timescale = damp(this.timescale, targetScale, 8, rawDt);
    dt *= this.timescale;

    const p = this.player;

    if (this.state === STATE.PLAY) {
      this.runTime += dt;
      p.setInput(this.input.down);
      p.update(dt, this.world, this.events);

      const d = (p.x - this.startX) * 0.5;   // 2 world units per displayed metre
      if (d > this.distance) this.distance = d;

      this.addScore(dt * p.speed * CFG.SCORE_DIST_RATE);

      // Combo decay steps DOWN one level per window instead of wiping to ×1. At 1.9
      // combo events/s against the old 4.0s window the decay could never fire at all,
      // so ×10 was reached in ~10s and held for a third of every run. A 2.2s window
      // makes it live — but a cliff-edge reset would make any long flat L4 flight
      // unpriceable. Stepping down means a quiet stretch costs you a level, not the run.
      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) {
          if (this.multiplier > 1) {
            this.multiplier--;
            this.combo = comboForMult(this.multiplier);
            this.comboTimer = CFG.COMBO_WINDOW;   // one more window at the lower tier
            // Losing a tier was previously silent in all three channels. The HUD
            // collapse fires off the multiplier drop; these are the other two.
            vibrate(12);
            this.audio.uiTap();
          } else {
            this.combo = 0;
          }
        }
      }
      if (this.overdriveActive) {
        this.overdrive -= dt;
        this.charge = clamp01(this.overdrive / CFG.OVERDRIVE_DURATION);
        if (this.overdrive <= 0) this.endOverdrive(0);
      } else if (this.chargeFull) {
        // A full meter waits for you to spend it on an arc — but only for so long.
        // Without this floor a player who cannot reliably score arcs never sees
        // overdrive at all, however much charge they earn. See OVERDRIVE_ARM_TIMEOUT.
        this.chargeFullT += dt;
        if (this.chargeFullT >= CFG.OVERDRIVE_ARM_TIMEOUT) this.startOverdrive();
      }
      this.fx.speedDust(p.x, p.y, p.vx, p.vy, this.speed01, dt);
    } else if (this.state === STATE.DYING) {
      this.deathTimer += rawDt;
      if (this.deathTimer > 1.15) this.finishDeath();
    } else if (this.state === STATE.TITLE || this.state === STATE.DEAD) {
      // Idle camera drift so the menu sits over a living scene rather than a freeze-frame.
      this.camX += 5.5 * rawDt;
    }

    // Stream around the camera, not the player: on the menus the camera drifts away
    // from the (frozen) player, and streaming around the player would leave it looking
    // at ungenerated space.
    if (this.state === STATE.TITLE || this.state === STATE.DEAD) {
      this.world.update(dt, this.camX, this.camY);
    } else {
      this.world.update(dt, p.x, p.y);
    }
    this.fx.update(dt);

    // Derived signals first: updateCamera reads speed01 for zoom-out and lookahead.
    // 99.2% of frames sit under 80 m/s (median ~55) because the swing plateau is
    // TETHER_MAX_OMEGA * L_median ~= 54. Against an 18-105 range speed01 peaked at
    // 0.71 and sat at 0.43, so the zoom-out, aberration, streaks, trail and audio pad
    // all ran at 40% forever. 20-80 makes the whole feedback range reachable.
    this.speed01 = clamp01(remap(p.speed, 20, 80, 0, 1));

    this.updateCamera(rawDt, dt);
    this.backdrop.update(dt, this.camX, this.camY, p.speed, this.overdriveActive ? 1 : 0);

    const overdrive01 = this.overdriveActive
      ? clamp01(this.overdrive / CFG.OVERDRIVE_DURATION) * 0.35 + 0.65
      : 0;

    this.trauma = Math.max(0, this.trauma - CFG.TRAUMA_DECAY * rawDt);
    // 4.6/s, not 3.4: a crash-scale flash now carries real energy through the
    // pre-tonemap path, and 3.4 left a ~0.29s bleach that outlasted the hitstop.
    this.flash = Math.max(0, this.flash - rawDt * 4.6);

    // ---- push state out ----------------------------------------------------
    const ps = this.postState;
    ps.time = this.time;
    ps.speed01 = this.speed01;
    ps.overdrive01 = overdrive01;
    ps.trauma = this.trauma;
    // TUNE.CA was cut 2.9x in post.js, so the driver goes up ~1.4x to keep dynamic
    // range between cruise and dying. Lands at ~4.2px of R/B split at speed and
    // ~8.5px on a crash, against 8.8/16.7 before — which read as NTSC tearing.
    ps.aberration = 0.55 + this.speed01 * 1.1 + this.trauma * 1.6;
    ps.vignette = 1 - overdrive01 * 0.35;
    ps.flash = this.flash;
    // Danger vignette — the drowning telegraph.
    //
    // This used to ramp over 13 world units and then SQUARE the result, on the
    // reasoning that the player legitimately spends time low in the corridor (the
    // catch row sits ~20-34 below the chain) and a wide linear ramp would tint the
    // whole frame maroon for most of a normal run. That reasoning was right about the
    // problem and wrong about the fix: at the measured 76 m/s descent of a real
    // drowning, 13 units squared is 0.17 SECONDS of warning, against the 250ms
    // reaction floor this project sets for itself in PERFECT_ETA_LEAD. The one lethal
    // thing with no telegraph was also the mid tier's biggest killer.
    //
    // The band is now FLOOD_WARN_BAND (55u ~= 0.72s, the same lead a laser gets), and
    // the "don't paint the whole frame" requirement is met by SHAPE instead of by
    // width: a cubic ease keeps the first two thirds of the band near-invisible, so
    // cruising the catch row still costs nothing, while the last stretch comes up far
    // harder and far earlier than the old squared 13u ever did. Measured at the
    // fatal descent rate: first perceptible tint (0.05) at 0.42s to impact where it
    // used to be 0.14s, and full intensity 3x further out.
    const fall = clamp01(remap(p.y, CFG.FLOODLINE - CFG.FLOOD_WARN_BAND, CFG.FLOODLINE, 0, 1));
    this.flood01 = fall;
    ps.damage01 = this.state === STATE.DYING
      ? clamp01(this.deathTimer * 2)
      : fall * fall * fall * 0.8;
    ps.exposure = (1 + overdrive01 * 0.28) / this.emissiveScale;

    const as = this.audioState;
    as.speed01 = this.speed01;
    as.multiplier = this.multiplier;
    as.overdrive01 = overdrive01;
    // p.tension does not exist — the property is tension01. Reading the wrong name
    // resolved undefined -> 0 every frame, pinning the tether whine at -80dB for the
    // entire life of the project. One of DESIGN.md's four named audio layers.
    as.tension01 = p.tethered ? clamp01(p.tension01 || 0) : 0;
    as.alive = this.state === STATE.PLAY;
    as.menu = this.state === STATE.TITLE || this.state === STATE.DEAD;
    this.audio.update(rawDt, as);

    const hs = this.hudState;
    hs.distance = this.distance;
    hs.score = this.score;
    hs.multiplier = this.multiplier;
    hs.charge01 = this.charge;
    hs.overdrive01 = overdrive01;
    // The exit window, in RAW seconds — the HUD must not have to reverse-engineer it
    // out of the remapped overdrive01, or the cue and the mechanic can drift apart.
    hs.odExit = this.overdriveActive && this.overdrive <= CFG.OVERDRIVE_EXIT_WINDOW;
    // The avatar's arc cue beats on this same boolean, from this same line, so the
    // on-body signal and the HUD rim are the same fact rather than two derivations of
    // it. Render-only: nothing in player physics reads it.
    this.player.odExit = hs.odExit;
    hs.alive = this.state === STATE.PLAY;
    hs.speed01 = this.speed01;
    hs.menu = as.menu;                 // TITLE | DEAD — hides the HUD on menus
    hs.holding = this.input.down;      // dismisses the first-run HOLD prompt
    hs.chargeFull = this.chargeFull;   // pulse the meter when it is ready to spend
    hs.perfectCue = p.perfectCue;      // 0..1 predictive arc telegraph
    this.hud.update(hs);
  }

  updateCamera(rawDt, dt) {
    const p = this.player;

    // Lead the camera by where the player is going, not where they are. Without this
    // the game is unplayable at speed — you cannot see what you are flying into.
    //
    // The cap MUST be relative to what is actually on screen. VIEW_WIDTH is 46, so a
    // flat 34-unit lead exceeds the 23-unit half-view and walks the player clean off
    // the left edge. Half the half-view puts them ~25% in from the left — a leading
    // composition — and guarantees they are always framed regardless of zoom.
    const halfViewWorld = (this.viewW / Math.max(this.zoom, 1e-6)) * 0.5;
    const leadCap = Math.min(CFG.CAMERA_LOOKAHEAD_MAX, halfViewWorld * 0.5);
    const leadX = clamp(p.vx * CFG.CAMERA_LOOKAHEAD, -8, leadCap);
    const leadY = clamp(p.vy * CFG.CAMERA_LOOKAHEAD * 0.55, -14, 14);

    this.camTargetX = p.x + leadX;
    this.camTargetY = p.y + leadY + CFG.CAMERA_Y_BIAS;

    if (this.state === STATE.PLAY || this.state === STATE.DYING) {
      this.camX = damp(this.camX, this.camTargetX, CFG.CAMERA_FOLLOW, rawDt);
      this.camY = damp(this.camY, this.camTargetY, CFG.CAMERA_FOLLOW * 0.8, rawDt);
    }

    // Roll into the direction of travel — a small amount reads as speed and grace.
    const targetRoll = clamp(-p.vy / 140, -1, 1) * CFG.CAMERA_ROLL
                     + clamp(p.vx / 220, -1, 1) * CFG.CAMERA_ROLL * 0.5;
    this.roll = damp(this.roll, this.state === STATE.PLAY ? targetRoll : 0, 4, rawDt);

    // Pull the camera back as speed rises so fast flight shows more of the world.
    // 0.32, not 0.13: pulling back harder at speed is what actually buys forward
    // vision. Widening the lookahead alone just pushes the player off frame — the
    // zoom is what makes room for the lead to sit in.
    const targetZoom = this.baseZoom * (1 - this.speed01 * 0.32)
      * (this.overdriveActive ? 0.95 : 1);
    this.zoomBoost = damp(this.zoomBoost, targetZoom, 3.2, rawDt);
    this.zoom = this.zoomBoost;

    // trauma² shake: stays subtle for small events, violent for big ones.
    const t2 = this.trauma * this.trauma;
    const s = CFG.SHAKE_MAX * t2;
    const f = this.time * 47;
    this.shakeX = Math.sin(f * 1.7) * Math.sin(f * 0.61) * s;
    this.shakeY = Math.sin(f * 1.3 + 2.1) * Math.sin(f * 0.83) * s;
  }

  render() {
    const gl = this.gl;
    const camX = this.camX + this.shakeX;
    const camY = this.camY + this.shakeY;

    const r = this.renderer;
    // The scene pass runs at internal resolution: same world framing, fewer pixels.
    // zoom stays in NATIVE px per world unit everywhere else (worldToScreen, culling)
    // and is scaled down only here, so a quality change never moves the camera.
    const rs = this.renderW / this.viewW;
    const zoomEff = this.zoom * rs;   // internal px per world unit, for the scene pass
    r.begin(camX, camY, zoomEff, this.roll, this.renderW, this.renderH);

    const viewWorldW = this.viewW / this.zoom;
    const viewWorldH = this.viewH / this.zoom;

    // Subsystems get zoomEff: they use zoom to size anti-aliasing feather in "one
    // screen pixel" terms, and their screen is the internal target.
    this.backdrop.render(r, camX, camY, viewWorldW, viewWorldH, zoomEff);
    // flood01 is passed in rather than recomputed: the water alarm and the danger
    // vignette are one telegraph in two channels and must share one input.
    this.world.render(r, camX, viewWorldW, zoomEff, this.time,
      this.state === STATE.PLAY ? this.flood01 : 0);
    if (this.state !== STATE.DEAD || this.player.alive) this.player.render(r, this.time);
    this.fx.render(r, zoomEff);

    // Scene -> HDR target
    const scene = this.post.sceneTarget;
    scene.bind();
    gl.clearColor(PAL.void[0], PAL.void[1], PAL.void[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    r.flush(gl);

    // HDR target -> screen, through the post chain
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.disable(gl.BLEND);
    this.post.render(gl, this.postState);
  }
}

/**
 * The event sink the player calls into. Built once; every method is a bound closure
 * over the game, so no allocation happens at call time.
 */
function makeEventSink(g) {
  return {
    perfectArc(x, y, quality) {
      g.perfects++;
      g.bumpCombo();
      // Quality gradient, steepened. The window is now ~0.93 rad wide, so a linear
      // ramp made the edges nearly as good as the middle; squaring it makes the
      // CENTRE worth 4x the edge and gives L2 somewhere to go.
      const qq = quality * quality;
      g.addScore(CFG.SCORE_PERFECT * (0.35 + qq * 1.15));
      // THE L5 SPEND. Banked charge is cashed on an arc. An arc taken *during*
      // overdrive used to end it outright, which made the showpiece cancel itself for
      // playing well: measured median lived duration 1.4s against a nominal 6s, and
      // WORSE the better the player. Arcs inside overdrive are now free — they score
      // (doubled) and nothing else — until the last OVERDRIVE_EXIT_WINDOW seconds,
      // where an arc becomes the deliberate exit and banks a refund that scales with
      // how late you cut it. Miss the window and overdrive just expires, unrefunded.
      // The skill moved from "don't play well" to "time your exit", which is what L5
      // was supposed to be.
      if (g.overdriveActive) {
        const win = CFG.OVERDRIVE_EXIT_WINDOW;
        if (g.overdrive <= win) {
          const late = clamp01(1 - g.overdrive / win);
          const f = CFG.OVERDRIVE_REFUND_FLOOR;
          g.endOverdrive(f + (1 - f) * late);
          g.hud.popup('combo', 'CLEAN EXIT',
            g.worldToScreenX(x), g.worldToScreenY(y) - 158);
        }
      } else if (g.chargeFull) {
        g.startOverdrive();
      } else {
        g.addCharge(CFG.PERFECT_CHARGE * (0.5 + qq * 1.0));
      }
      g.fx.perfectArc(x, y, g.player.vx, g.player.vy, quality);
      g.trauma = Math.max(g.trauma, CFG.TRAUMA_PERFECT * (0.6 + quality * 0.6));
      g.hitstop = Math.max(g.hitstop, CFG.HITSTOP_PERFECT * quality);
      // 0.30, not 0.18: the pre-tonemap flash path has ~7x the headroom the old
      // formula saturated at, and stays under the 0.35 bleach knee at every quality.
      g.flash = Math.max(g.flash, 0.30 * quality);
      g.audio.perfect(g.combo);
      // Lifted clear of the player: the popup used to spawn dead centre of the
      // white-hot player blob, drawing the word "ARC" inside it.
      g.hud.popup('perfect', quality > 0.75 ? 'PERFECT ARC' : 'ARC',
        g.worldToScreenX(x), g.worldToScreenY(y) - 90);
      if (g.multiplier > 1 && g.combo % CFG.COMBO_PER_STEP === 0) {
        g.hud.popup('combo', '×' + g.multiplier,
          g.worldToScreenX(x), g.worldToScreenY(y) - 124);
      }
      vibrate(quality > 0.75 ? 18 : 10);
    },
    graze(x, y, obj, isHazard) {
      // RISK = REWARD, and the feedback has to say so.
      //
      // Grazing used to fire ~30x a run, of which 94% were ANCHORS — the things you are
      // actively aiming at, which carry no risk whatever. The two genuinely dangerous
      // grazes per run were buried in that noise, and because each popup moved the
      // charge bar by an invisible 1.3%, the HUD's frequency implied an importance the
      // magnitude never delivered. Anchors are no longer grazable at all (see
      // CFG.GRAZE_ANCHORS), so this now fires ~3x a run and ~80% of those are hazards:
      // frequency and magnitude finally agree.
      //
      // A hazard graze is the only reward in the game you can only collect by being
      // close enough to die, so it is the loudest non-arc event on screen: 4.5x the
      // score, 5.5x the charge (a visible 11% of the bar in one deposit), a combo bump,
      // a flash, and the large amber popup. Architecture grazes are real risk too — the
      // deck you skimmed could have killed you — but they are the quiet cousin.
      g.addScore(isHazard ? CFG.SCORE_GRAZE_HAZARD : CFG.SCORE_GRAZE);
      g.addCharge(isHazard ? CFG.GRAZE_CHARGE_HAZARD : CFG.GRAZE_CHARGE);
      if (isHazard) { g.bumpCombo(); g.hazardGrazes++; }
      else g.comboTimer = CFG.COMBO_WINDOW;
      g.fx.graze(x, y, g.player.x - x, g.player.y - y);
      g.trauma = Math.max(g.trauma, isHazard ? CFG.TRAUMA_GRAZE * 1.8 : CFG.TRAUMA_GRAZE);
      if (isHazard) g.flash = Math.max(g.flash, 0.16);
      g.audio.graze();
      vibrate(isHazard ? 14 : 4);
      // 'combo' is the big amber popup kind; 'graze' is the small one. Reusing the
      // existing kinds keeps this a pure gameplay change — ui.css is untouched.
      g.hud.popup(isHazard ? 'combo' : 'graze', isHazard ? 'HAZARD GRAZE' : 'GRAZE',
        g.worldToScreenX(x), g.worldToScreenY(y));
    },
    deflect(x, y, obj) {
      // You HIT the wall. This used to fire `graze` — the L3 skill layer paying out
      // for the exact opposite of the skill. Feedback only: no score, no charge, and
      // it does not hold the combo window open.
      g.fx.graze(x, y, g.player.x - x, g.player.y - y);
      g.trauma = Math.max(g.trauma, CFG.TRAUMA_GRAZE * 0.6);
      g.audio.graze();
    },
    orb(x, y) {
      g.addScore(CFG.SCORE_ORB);
      g.addCharge(CFG.ORB_CHARGE);
      g.bumpCombo();
      g.fx.orb(x, y);
      g.audio.orb();
      vibrate(12);
      g.hud.popup('orb', '+' + Math.round(CFG.SCORE_ORB * g.multiplier),
        g.worldToScreenX(x), g.worldToScreenY(y));
    },
    attach(x, y) {
      g.fx.attach(x, y);
      g.audio.attach();
      vibrate(6);
    },
    release(x, y, speed) {
      g.audio.release(clamp01(speed / 100));
    },
    crash(x, y, vx, vy) { g.die(x, y, vx, vy); },
    reel(tension) { /* tension is consumed via player.tension in update */ },
  };
}

function vibrate(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
}

function showFatal(msg) {
  const d = document.createElement('div');
  d.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:2rem;color:#ff2d95;background:#04030c;font:600 15px/1.6 ui-monospace,monospace;' +
    'text-align:center;letter-spacing:.08em;z-index:999';
  d.textContent = msg;
  document.body.appendChild(d);
}

try {
  window.game = new Game();
} catch (err) {
  console.error(err);
  showFatal('ARCLIGHT failed to start\n\n' + (err && err.message ? err.message : String(err)));
}
