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
    this.charge = 0;
    this.overdrive = 0;
    this.overdriveActive = false;
    this.chargeFull = false;      // meter banked, waiting on an arc to spend it
    this.startX = 0;

    this.best = Number(localStorage.getItem('arclight.best') || 0);
    this.bestDistance = Number(localStorage.getItem('arclight.bestDistance') || 0);

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

    // ---- feel --------------------------------------------------------------
    this.hitstop = 0;
    this.timescale = 1;
    this.flash = 0;
    this.deathTimer = 0;

    // ---- adaptive quality --------------------------------------------------
    this.quality = 1;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.frameMs = 16.7;
    this.frameCount = 0;

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
      overdrive01: 0, alive: true, speed01: 0, menu: true, holding: false,
      chargeFull: false, perfectCue: 0,
    };

    this.events = makeEventSink(this);

    this.dpr = 1;
    this.viewW = 1; this.viewH = 1;
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
      if (!document.hidden) this.lastT = performance.now();
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
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR) * this.quality;
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
    this.post.resize(w, h);
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
    this.lastT = performance.now();   // swallow the dt accumulated while dark
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
    this.charge = 0; this.overdrive = 0; this.overdriveActive = false;
    this.chargeFull = false; this.player.invuln = false;
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
      localStorage.setItem('arclight.best', String(this.best));
    }
    if (dist > this.bestDistance) {
      this.bestDistance = dist;
      localStorage.setItem('arclight.bestDistance', String(dist));
    }
    this.screens.showGameOver({
      distance: dist,
      score: Math.floor(this.score),
      best: Math.floor(this.best),
      bestDistance: this.bestDistance,
      multiplierPeak: this.multiplierPeak,
      perfects: this.perfects,
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
    const m = clamp(1 + Math.floor(this.combo / CFG.COMBO_PER_STEP), 1, CFG.COMBO_MAX_MULT);
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
      this.hud.popup('combo', 'OVERDRIVE READY', this.cssW * 0.5, this.cssH * 0.42);
      vibrate(14);
    }
  }

  startOverdrive() {
    this.overdriveActive = true;
    this.chargeFull = false;
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

  endOverdrive(refund) {
    if (!this.overdriveActive) return;
    this.overdriveActive = false;
    this.overdrive = 0;
    this.player.invuln = false;
    this.charge = refund ? CFG.OVERDRIVE_REFUND : 0;
    this.chargeFull = false;
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
    if (this.glLost && this.glLost.lost) { this.lastT = now; return; }

    let rawDt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (!(rawDt > 0)) rawDt = 1 / 60;
    rawDt = Math.min(rawDt, 1 / 20);        // never simulate more than a 20fps step

    this.frameMs = lerp(this.frameMs, (now - (this._prevNow || now)) || 16.7, 0.08);
    this._prevNow = now;
    this.adaptQuality();

    this.input.poll();
    this.update(rawDt);
    this.render();
  }

  adaptQuality() {
    // Ignore startup: shader compiles and the first chunk generation produce a burst of
    // slow frames that would otherwise pin the game at minimum resolution forever.
    if (++this.frameCount < 150) return;

    // Drop internal resolution before we start dropping frames, then claw it back.
    // Recovery has to be reachable on a 60Hz display — a threshold below the frame
    // interval itself can never be met, so quality would only ever ratchet down.
    if (this.frameMs > 20) { this.slowFrames++; this.fastFrames = 0; }
    else if (this.frameMs < 17.2) { this.fastFrames++; this.slowFrames = 0; }
    if (this.slowFrames > 45 && this.quality > 0.6) {
      this.quality = Math.max(0.6, this.quality - 0.15);
      this.slowFrames = 0;
      // Shrink the bloom chain with the scene. Post already exposes the hook and
      // nothing was calling it, so the blur ping-pongs — the most fill-rate-hungry
      // part of the frame — stayed full size no matter how far quality dropped.
      this.post.setQuality(this.quality);
      this.resize();
    } else if (this.fastFrames > 240 && this.quality < 1) {
      this.quality = Math.min(1, this.quality + 0.1);
      this.fastFrames = 0;
      this.post.setQuality(this.quality);
      this.resize();
    }
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
            this.combo = (this.multiplier - 1) * CFG.COMBO_PER_STEP;
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
        if (this.overdrive <= 0) this.endOverdrive(false);
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
    // Danger vignette. Kept deliberately tight and eased: the player legitimately
    // spends time low in the corridor (the catch row sits ~20-34 below the chain), and
    // a wide linear ramp tinted the whole frame maroon for most of a normal run.
    // Squaring it means it stays invisible until the floodline is genuinely a threat.
    const fall = clamp01(remap(p.y, CFG.FLOODLINE - 13, CFG.FLOODLINE, 0, 1));
    ps.damage01 = this.state === STATE.DYING
      ? clamp01(this.deathTimer * 2)
      : fall * fall * 0.7;
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
    r.begin(camX, camY, this.zoom, this.roll, this.viewW, this.viewH);

    const viewWorldW = this.viewW / this.zoom;
    const viewWorldH = this.viewH / this.zoom;

    this.backdrop.render(r, camX, camY, viewWorldW, viewWorldH, this.zoom);
    this.world.render(r, camX, viewWorldW, this.zoom, this.time);
    if (this.state !== STATE.DEAD || this.player.alive) this.player.render(r, this.time);
    this.fx.render(r, this.zoom);

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
      // THE L5 SPEND. Banked charge is cashed on an arc; an arc taken *during*
      // overdrive is the exit ramp and refunds OVERDRIVE_REFUND. `endOverdrive(true)`
      // was unreachable dead code until this branch existed. The 1.0s floor stops the
      // arc that fired overdrive from cancelling it a moment later.
      if (g.overdriveActive) {
        if (g.overdrive < CFG.OVERDRIVE_DURATION - 1.0) g.endOverdrive(true);
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
      // Risk = reward. A hazard graze is the only one that could have killed you, so
      // it pays 4.5x, charges 6x, and is the only one that BUMPS the combo — skimming
      // architecture merely holds the chain open. Grazes now fire ~26x/run (was 2.0);
      // if every one bumped the combo the multiplier would pin at the cap again.
      g.addScore(isHazard ? CFG.SCORE_GRAZE_HAZARD : CFG.SCORE_GRAZE);
      g.addCharge(isHazard ? CFG.GRAZE_CHARGE_HAZARD : CFG.GRAZE_CHARGE);
      if (isHazard) g.bumpCombo(); else g.comboTimer = CFG.COMBO_WINDOW;
      g.fx.graze(x, y, g.player.x - x, g.player.y - y);
      g.trauma = Math.max(g.trauma, CFG.TRAUMA_GRAZE);
      g.audio.graze();
      vibrate(4);
      g.hud.popup('graze', isHazard ? 'HAZARD GRAZE' : 'GRAZE',
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
      // Rebudgeted with the rest of the charge economy: overdrive was active 45% of
      // the time, closer to a default state than an event. Target is ~1 per 25-30s.
      g.addCharge(0.016);
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
