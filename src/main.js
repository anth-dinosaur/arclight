// ARCLIGHT — integration. Owns the loop, camera, scoring, overdrive and the event sink.

import { CFG, PAL } from './core/config.js';
import { clamp, clamp01, damp, lerp, remap, easeOutCubic } from './core/math.js';
import { createContext, createFullscreenQuad } from './core/gl.js';
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

    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.backdrop = new Backdrop(this.seed);
    this.world = new World(this.seed);
    this.player = new Player();
    this.fx = new Fx();
    this.audio = new Audio();
    this.input = new Input(window);

    this.hud = new Hud(document.getElementById('hud'));
    this.screens = new Screens(document.getElementById('screens'), {
      onStart: () => this.start(),
      onRetry: () => this.start(),
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
      overdrive01: 0, alive: true, speed01: 0,
    };

    this.events = makeEventSink(this);

    this.dpr = 1;
    this.viewW = 1; this.viewH = 1;
    this.cssW = 1; this.cssH = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.resize());
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
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR) * this.quality;
    this.cssW = cssW; this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.viewW = w; this.viewH = h;
    this.post.resize(w, h);
    // Portrait phones get the design width; wide screens keep the same vertical extent
    // so a desktop browser sees more sky rather than a giant player.
    const aspect = w / h;
    this.baseZoom = aspect < 0.75
      ? w / CFG.VIEW_WIDTH
      : h / (CFG.VIEW_WIDTH / 0.62);
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
    this.trauma = 0; this.flash = 0; this.hitstop = 0;
    this.runTime = 0; this.deathTimer = 0;
    this.timescale = 1;
    this.camX = this.player.x; this.camY = this.player.y + CFG.CAMERA_Y_BIAS;
    this.roll = 0;
    if (!silent) this.audio.uiTap();
  }

  start() {
    this.audio.unlock();
    this.resetRun();
    this.screens.hide();
    this.state = STATE.PLAY;
    this.input.setEnabled(true);
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

  addCharge(amount) {
    if (this.overdriveActive) return;
    this.charge = clamp01(this.charge + amount);
    if (this.charge >= 1) this.startOverdrive();
  }

  startOverdrive() {
    this.overdriveActive = true;
    this.overdrive = CFG.OVERDRIVE_DURATION;
    this.charge = 1;
    this.fx.overdrive(this.player.x, this.player.y);
    this.trauma = Math.max(this.trauma, 0.5);
    this.flash = Math.max(this.flash, 0.7);
    this.audio.overdriveStart();
    vibrate(30);
  }

  endOverdrive(refund) {
    if (!this.overdriveActive) return;
    this.overdriveActive = false;
    this.overdrive = 0;
    this.charge = refund ? CFG.OVERDRIVE_REFUND : 0;
    this.audio.overdriveEnd();
  }

  /** World position -> CSS pixel position, for HUD popups. */
  worldToScreenX(wx) { return (wx - this.camX) * this.zoom / this.dpr + this.cssW * 0.5; }
  worldToScreenY(wy) { return (wy - this.camY) * this.zoom / this.dpr + this.cssH * 0.5; }

  // ---- loop ----------------------------------------------------------------

  loop(now) {
    requestAnimationFrame(this.loop);

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
      this.resize();
    } else if (this.fastFrames > 240 && this.quality < 1) {
      this.quality = Math.min(1, this.quality + 0.1);
      this.fastFrames = 0;
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

      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) { this.combo = 0; this.multiplier = 1; }
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
    this.speed01 = clamp01(remap(p.speed, 18, 105, 0, 1));

    this.updateCamera(rawDt, dt);
    this.backdrop.update(dt, this.camX, this.camY, p.speed, this.overdriveActive ? 1 : 0);

    const overdrive01 = this.overdriveActive
      ? clamp01(this.overdrive / CFG.OVERDRIVE_DURATION) * 0.35 + 0.65
      : 0;

    this.trauma = Math.max(0, this.trauma - CFG.TRAUMA_DECAY * rawDt);
    this.flash = Math.max(0, this.flash - rawDt * 3.4);

    // ---- push state out ----------------------------------------------------
    const ps = this.postState;
    ps.time = this.time;
    ps.speed01 = this.speed01;
    ps.overdrive01 = overdrive01;
    ps.trauma = this.trauma;
    ps.aberration = 0.35 + this.speed01 * 0.8 + this.trauma * 1.2;
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
    as.tension01 = p.tethered ? clamp01(p.tension || 0) : 0;
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
    this.hud.update(hs);
  }

  updateCamera(rawDt, dt) {
    const p = this.player;

    // Lead the camera by where the player is going, not where they are. Without this
    // the game is unplayable at speed — you cannot see what you are flying into.
    const leadX = clamp(p.vx * CFG.CAMERA_LOOKAHEAD, -8, CFG.CAMERA_LOOKAHEAD_MAX);
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
    const targetZoom = this.baseZoom * (1 - this.speed01 * 0.13)
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
      g.addScore(CFG.SCORE_PERFECT * (0.6 + quality * 0.7));
      g.addCharge(CFG.PERFECT_CHARGE * (0.7 + quality * 0.6));
      g.fx.perfectArc(x, y, g.player.vx, g.player.vy, quality);
      g.trauma = Math.max(g.trauma, CFG.TRAUMA_PERFECT * (0.6 + quality * 0.6));
      g.hitstop = Math.max(g.hitstop, CFG.HITSTOP_PERFECT * quality);
      g.flash = Math.max(g.flash, 0.18 * quality);
      g.audio.perfect(g.combo);
      g.hud.popup('perfect', quality > 0.75 ? 'PERFECT ARC' : 'ARC',
        g.worldToScreenX(x), g.worldToScreenY(y));
      if (g.multiplier > 1 && g.combo % CFG.COMBO_PER_STEP === 0) {
        g.hud.popup('combo', '×' + g.multiplier,
          g.worldToScreenX(x), g.worldToScreenY(y) - 34);
      }
      vibrate(quality > 0.75 ? 18 : 10);
    },
    graze(x, y, obj) {
      g.addScore(CFG.SCORE_GRAZE);
      g.addCharge(CFG.GRAZE_CHARGE);
      g.comboTimer = CFG.COMBO_WINDOW;
      g.fx.graze(x, y, g.player.x - x, g.player.y - y);
      g.trauma = Math.max(g.trauma, CFG.TRAUMA_GRAZE);
      g.audio.graze();
      g.hud.popup('graze', 'GRAZE', g.worldToScreenX(x), g.worldToScreenY(y));
    },
    orb(x, y) {
      g.addScore(CFG.SCORE_ORB);
      g.addCharge(0.05);
      g.bumpCombo();
      g.fx.orb(x, y);
      g.audio.orb();
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
