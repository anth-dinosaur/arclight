// ARCLIGHT — game/player.js
// The whole game lives in this file: one boolean of input, a rope, and momentum.
//
// DESIGN NOTES (read before tuning)
// --------------------------------
// * The simulation runs on a FIXED 1/240 s substep behind an accumulator, so a 60 Hz
//   iPhone and a 120 Hz ProMotion iPhone produce bit-comparable trajectories and the
//   positional rope constraint never goes unstable. Render position is interpolated
//   from the accumulator remainder so motion is smooth rather than stepped.
// * The rope is a HARD POSITIONAL CONSTRAINT (position-based dynamics), not a spring.
//   Springs feel like rubber; ropes feel like ropes. It only ever pulls.
// * Reeling in conserves ANGULAR MOMENTUM (v_t *= L_prev / L). A naive PBD projection
//   does *not* speed you up when the radius shrinks — it preserves tangential *speed*,
//   not L — so the conservation term is applied explicitly. This is the single line
//   that makes "hold longer = faster" true. See `TETHER_REEL_SPIN`.
// * +Y IS DOWN. "Above the horizontal" means vy < 0. Every sign in here depends on it.
//
// Zero allocation in update()/render(). Everything is preallocated at construction or
// module scope. No closures, no array literals, no .map/.forEach in the hot path.

import { CFG, PAL, tint } from '../core/config.js';
import { clamp01, damp, TAU, circleVsOBB } from '../core/math.js';
import { LAYER } from '../core/renderer.js';

// ---------------------------------------------------------------------------
// Tunables. Everything reads from CFG; the `??` fallbacks exist so this module
// runs standalone before the missing keys land in config.js. See report.
// ---------------------------------------------------------------------------
const SUBSTEP        = CFG.PHYS_SUBSTEP        ?? (1 / 240);
// Must satisfy MAX_SUBSTEPS * SUBSTEP >= CFG.MAX_SIM_DT, or the player silently
// receives less sim time per frame than the world does and the game gets harder as
// the framerate drops. See the note on MAX_SIM_DT in config.js.
const MAX_SUBSTEPS   = CFG.PHYS_MAX_SUBSTEPS   ?? 12;
const INV_SUBSTEP    = 1 / SUBSTEP;
const MAX_FRAME_DT   = CFG.PHYS_MAX_FRAME_DT   ?? 0.25;   // tab-switch guard

const GRAVITY        = CFG.GRAVITY;
const AIR_DRAG       = CFG.AIR_DRAG;
const DRAG_QUAD      = CFG.DRAG_QUAD           ?? 3.0;    // quadratic share of drag
const TERMINAL       = CFG.TERMINAL_SPEED;
const OVERSPEED_K    = CFG.OVERSPEED_BRAKE     ?? 9.0;    // hard asymptote at TERMINAL
const RADIUS         = CFG.PLAYER_RADIUS;
const MIN_SPEED      = CFG.MIN_SPEED;
const MIN_SPEED_ASSIST = CFG.MIN_SPEED_ASSIST  ?? 2.6;    // 1/s, recovers a stalled run

const T_MAX_RANGE    = CFG.TETHER_MAX_RANGE;
const T_MIN_RANGE    = CFG.TETHER_MIN_RANGE;
const T_FIRE_SPEED   = CFG.TETHER_FIRE_SPEED;
const T_REEL_RATE    = CFG.TETHER_REEL_RATE;
const T_MIN_LENGTH   = CFG.TETHER_MIN_LENGTH;
const T_DAMPING      = CFG.TETHER_DAMPING;                // reinterpreted as per-SECOND
const T_CONE         = CFG.TETHER_CONE;
const T_CONE_COS     = Math.cos(T_CONE);
const T_MIN_UP       = CFG.TETHER_CONE_MIN_UP;            // sin() above horizontal, "preferred"
const T_BEHIND_TOL   = CFG.TETHER_BEHIND_TOL   ?? 0.18;   // how far behind us an anchor may sit
const T_FWD_BIAS     = CFG.TETHER_FORWARD_BIAS ?? 0.90;   // blend of +X into the travel dir
/**
 * How much of a *downward* velocity counts toward the aiming direction. Critical:
 * a falling player's true travel direction is nearly straight down, and a cone
 * around that rejects every anchor overhead — exactly the ones you want. Discounting
 * vy keeps the search cone pointing where the player is *going to want to be*.
 */
const T_VY_WEIGHT    = CFG.TETHER_VY_WEIGHT    ?? 0.35;
const T_RANGE_SWEET  = CFG.TETHER_RANGE_SWEET  ?? 0.62;   // of max range: the ideal rope
const T_RANGE_WIDTH  = CFG.TETHER_RANGE_WIDTH  ?? 0.55;
const T_REEL_SPIN    = CFG.TETHER_REEL_SPIN    ?? 0.80;   // 0=none, 1=full L conservation
const T_ASSIST_RANGE = CFG.TETHER_ASSIST_RANGE ?? 1.35;   // reticle search overshoot
const T_RADIAL_VETO  = CFG.TETHER_RADIAL_VETO  ?? 0.86;   // reject anchors that eat the run
/**
 * The rope legitimately destroys outward radial velocity. Doing that at 100 % makes
 * every catch feel like hitting a wall, so a fraction of the annihilated momentum is
 * handed back as tangential swing on the catch frame only. This is the "sling".
 */
const T_CATCH_GAIN   = CFG.TETHER_CATCH_GAIN   ?? 0.42;
/**
 * Maximum swing rate, rad/s. THE most important feel constant in the file.
 *
 * A rope of length L carrying tangential speed v sweeps at v/L rad/s. Let that get
 * large and the player whips round the anchor several times per second, ends up
 * travelling backwards, and cannot read what is happening. Capping it turns into a
 * *speed-dependent minimum rope length* (L >= v / omega): the reel simply stops
 * pumping once the arc gets too tight, and short anchors stop being valid targets
 * as you get faster. That single rule kills backward loops, makes the swing legible,
 * and gives the whole game a natural speed plateau (v_cruise ~= omega * L_typical)
 * instead of relying on the terminal-velocity brake.
 *
 * At 3.2 rad/s a half-swing takes ~0.98 s — heavy, deliberate, Bionic Commando.
 * Measured: above ~4.0 the player starts overswinging past the top of the arc and
 * individual swing cycles begin to LOSE ground. 3.0-3.4 is the usable band.
 */
const T_MAX_OMEGA    = CFG.TETHER_MAX_OMEGA    ?? 3.2;
const T_TENSION_REF  = CFG.TETHER_TENSION_REF  ?? 420;    // m/s² that reads as "max tension"
/**
 * DESPERATION ASSIST. Never attaching is strictly worse than attaching to a mediocre
 * anchor, so every targeting gate below is a *preference* that dissolves the longer
 * the player has been reaching for nothing. At desperation 1.0 the only surviving
 * requirement is "in range" — a backwards, downwards, momentum-killing swing that
 * saves the run beats a clean death every time. Scoring order is untouched, so a
 * good anchor is still always preferred when one exists.
 */
const T_DESPERATE_TIME    = CFG.TETHER_DESPERATE_TIME    ?? 0.6;  // s of fruitless seeking
const T_FALL_RANGE_BOOST  = CFG.TETHER_FALL_RANGE_BOOST  ?? 0.35; // max extra reach, fraction
const T_FALL_RANGE_REF    = CFG.TETHER_FALL_RANGE_REF    ?? 70;   // descent for full boost
const T_FLOOD_PANIC       = CFG.TETHER_FLOOD_PANIC       ?? 26;   // m above floodline = panic

/**
 * THE PUMP. DESIGN.md promises "the tether auto-reels — this pumps energy in, like
 * kicking on a playground swing. Hold longer through the arc = more speed."
 *
 * Reeling alone cannot deliver that. A PBD projection preserves tangential *speed*,
 * not angular momentum, and even with the explicit L-conservation term the reel hits
 * its length floor and stops — after which drag and rope friction bleed the swing
 * down to a dead dangle. Holding forever became a silent deadlock.
 *
 * So we pump the way a child on a swing actually does: tangential acceleration that
 * is strongest when the rope is near vertical (bottom of the arc) and vanishes at the
 * extremes, always in the direction the swing is already going. Amplitude grows.
 * It is scaled down as tangential speed approaches PUMP_MAX_SPEED so it asymptotes to
 * a healthy cruise instead of diverging.
 */
const PUMP_ACCEL      = CFG.TETHER_PUMP_ACCEL     ?? 40;   // m/s² at the bottom of the arc
const PUMP_MAX_SPEED  = CFG.TETHER_PUMP_MAX_SPEED ?? 46;   // tangential asymptote, m/s
const PUMP_ESCALATE   = CFG.TETHER_PUMP_ESCALATE  ?? 2.5;  // extra pump per second stalled
const PUMP_SEED_SPEED = CFG.TETHER_PUMP_SEED      ?? 0.5;  // |vt| below this = pick forward

/**
 * AUTO-HOP. DESIGN.md L1: "Just hold. Anything you do produces a swing. You will
 * travel." A held tether that keeps swinging past the top carries the player
 * BACKWARDS, so once the forward arc is spent we release automatically and let the
 * assist grab the next anchor ahead. This is purely a floor, not a ceiling: the
 * Perfect Arc window sits at rope angles 35°-75°, well before the hop at ~14°, so a
 * player who releases deliberately is still strictly better off.
 */
const AUTO_HOP_PHI      = CFG.TETHER_AUTO_HOP_PHI      ?? 0.45; // rad past the bottom
const AUTO_HOP_MIN_TIME = CFG.TETHER_AUTO_HOP_MIN_TIME ?? 0.15; // s attached before hopping
const AUTO_HOP_LOCKOUT  = CFG.TETHER_AUTO_HOP_LOCKOUT  ?? 0.7;  // s of avoiding that anchor
const W_RECENT          = CFG.TETHER_W_RECENT          ?? 2.5;  // score penalty for it

// Anchor-scoring weights. Sum is arbitrary; only relative magnitude matters.
const W_ALIGN  = CFG.TETHER_W_ALIGN  ?? 1.00;
const W_UP     = CFG.TETHER_W_UP     ?? 1.35;
const W_FWD    = CFG.TETHER_W_FWD    ?? 1.60;
const W_RANGE  = CFG.TETHER_W_RANGE  ?? 0.90;
const W_SWING  = CFG.TETHER_W_SWING  ?? 1.50;
const W_RADIAL = CFG.TETHER_W_RADIAL ?? 1.80;
const W_GROUND = CFG.TETHER_W_GROUND ?? 2.20;
const W_HEAVY  = CFG.TETHER_W_HEAVY  ?? 0.25;
const W_DECAY  = CFG.TETHER_W_DECAY  ?? 0.35;
const W_USED   = CFG.TETHER_W_USED   ?? 0.30;
const GROUND_MARGIN = CFG.TETHER_GROUND_MARGIN ?? 8.0;

const P_ANG_MIN  = CFG.PERFECT_ANGLE_MIN;
const P_ANG_MAX  = CFG.PERFECT_ANGLE_MAX;
const P_ANG_MID  = (P_ANG_MIN + P_ANG_MAX) * 0.5;
const P_ANG_HALF = (P_ANG_MAX - P_ANG_MIN) * 0.5;
const P_MIN_SPEED = CFG.PERFECT_MIN_SPEED;
const P_IMPULSE   = CFG.PERFECT_IMPULSE;
/**
 * THE PERFECT-ARC WINDOW, RESTATED IN ROPE ANGLE.
 *
 * While the rope is taut the velocity is purely tangential, so with n̂ = (cos phi,
 * sin phi) pointing anchor->player and a forward (phi-decreasing) swing:
 *     v = |vt| * (sin phi, -cos phi)   =>   atan2(-vy, vx) = PI/2 - phi
 * The velocity-angle window is therefore EXACTLY a phi window, and phi is a
 * quantity we can extrapolate — which is what makes a predictive cue possible at
 * all. phi sweeps DOWNWARD through the window: it opens at P_PHI_MAX and closes at
 * P_PHI_MIN, roughly 0.29s later at cruise.
 */
const P_PHI_MAX  = Math.PI * 0.5 - P_ANG_MIN;
const P_PHI_MIN  = Math.PI * 0.5 - P_ANG_MAX;
/** Seconds of lead on the cue. Human reaction is ~250ms; a cue that switches on at
 *  the instant the window opens (which is what reading it off CURRENT velocity did)
 *  is late by construction and cannot be acted on. */
const P_ETA_LEAD = CFG.PERFECT_ETA_LEAD ?? 0.35;

const GRAZE_RADIUS   = CFG.GRAZE_RADIUS;
const GRAZE_COOLDOWN = CFG.GRAZE_COOLDOWN;
const FLOODLINE      = CFG.FLOODLINE;
/**
 * OFF by default (`CFG.GRAZE_ANCHORS: false`), and the history is worth keeping because
 * the reasoning that turned it on was locally sound and globally wrong.
 *
 * It was switched on because GRAZE was dead at 2.0 events/run, and anchors — the most
 * numerous neon geometry in the game — took it to ~22/run where widening the radius
 * could not. DESIGN.md L3 does say "neon geometry OR a hazard". But volume is not the
 * same as meaning: measured, 92% of all grazes became anchors, i.e. the meter paid out
 * ~38x per run for flying past the things you were actively AIMING AT. That is not
 * risk, it is a proximity tax on playing correctly, and it buried the ~2 genuinely
 * dangerous hazard grazes in noise.
 *
 * L3's actual promise is "Risk = reward". With this off, every graze in the game is
 * something that could have killed you — hazards, and the skim decks the generator now
 * authors into flight paths. 3.3 events/run, 82% hazard. Fewer, and each one means
 * something. If you turn this back on, re-read that sentence first.
 *
 * When enabled, the anchor currently held and the one just auto-hopped off are still
 * excluded — you cannot graze what you are attached to.
 */
const GRAZE_ANCHORS  = CFG.GRAZE_ANCHORS !== false;

// Glancing blows deflect instead of killing. Measured from the surface TANGENT.
const DEFLECT_ANGLE  = CFG.DEFLECT_ANGLE;                 // ~46°
const DEFLECT_SIN    = Math.sin(DEFLECT_ANGLE);
const DEFLECT_REST   = CFG.DEFLECT_RESTITUTION;
const DEFLECT_SCRUB  = CFG.DEFLECT_SCRUB;
const DEFLECT_CD     = CFG.DEFLECT_COOLDOWN;
/** Below this travelled distance, solids can only ever bounce you — never kill. */
const SOLID_SAFE_DIST = CFG.SOLID_SAFE_DIST;
const SPAWN_X        = CFG.SPAWN_X;
const SPAWN_Y        = CFG.SPAWN_Y;
/** Velocity floor after a deflect, so the player can never grind to a halt in geometry. */
const ESCAPE_SPEED   = CFG.SOLID_ESCAPE_SPEED  ?? 9.0;

const TRAIL_N        = CFG.TRAIL_POINTS;
const TRAIL_INTERVAL = CFG.TRAIL_INTERVAL      ?? (1 / 90);
const CULL_X         = CFG.PLAYER_CULL         ?? 16;     // broad-phase half-window, m
const CAND_MAX       = CFG.PLAYER_CAND_MAX     ?? 96;
/** Anchor re-test cadence, in SUBSTEPS. Sim-time based so 60/120 Hz behave identically. */
const SEL_SUBSTEPS   = CFG.TETHER_ASSIST_STEPS ?? 4;      // 4 * (1/240) = 60 Hz of sim time

// Tether state machine
const T_NONE = 0, T_FIRING = 1, T_ATTACHED = 2;

const HALF_PI = Math.PI * 0.5;

// ---------------------------------------------------------------------------
// Module-scope scratch. `push()` copies colour components immediately, so a small
// pool of reused arrays is safe and allocation-free.
// ---------------------------------------------------------------------------
const CA = new Float32Array(4);
const CB = new Float32Array(4);
const CC = new Float32Array(4);

// Out-params for the OBB probe (avoids returning objects).
let _nx = 0;      // outward surface normal, world space
let _ny = 0;
let _sd = 0;      // signed distance from point to box surface (+ outside, - inside)

/**
 * Closest-feature probe of a point against an oriented box.
 * Writes the outward normal into `_nx/_ny` and the signed surface distance into `_sd`.
 * Allocation-free; used for both collision response and graze proximity.
 */
function obbProbe(px, py, rx, ry, hw, hh, rot) {
  const dx = px - rx, dy = py - ry;
  let lx, ly;
  if (rot !== 0) {
    const c = Math.cos(-rot), s = Math.sin(-rot);
    lx = dx * c - dy * s;
    ly = dx * s + dy * c;
  } else { lx = dx; ly = dy; }

  const qx = lx < -hw ? -hw : (lx > hw ? hw : lx);
  const qy = ly < -hh ? -hh : (ly > hh ? hh : ly);
  const ox = lx - qx, oy = ly - qy;
  const d2 = ox * ox + oy * oy;

  let lnx, lny;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    lnx = ox / d; lny = oy / d;
    _sd = d;
  } else {
    // Point is inside the box: escape along the axis of least penetration.
    const ex = hw - (lx < 0 ? -lx : lx);
    const ey = hh - (ly < 0 ? -ly : ly);
    if (ex < ey) { lnx = lx < 0 ? -1 : 1; lny = 0; _sd = -ex; }
    else         { lnx = 0; lny = ly < 0 ? -1 : 1; _sd = -ey; }
  }

  if (rot !== 0) {
    const c = Math.cos(rot), s = Math.sin(rot);
    _nx = lnx * c - lny * s;
    _ny = lnx * s + lny * c;
  } else { _nx = lnx; _ny = lny; }
}

export class Player {
  constructor() {
    // ---- public, read-only to everyone else -------------------------------
    this.x = 0; this.y = 0;              // INTERPOLATED render position
    this.vx = 0; this.vy = 0;
    this.speed = 0;
    this.speed01 = 0;                    // speed / TERMINAL, for post & audio
    this.alive = true;
    this.tethered = false;
    this.ropeLen = 0;
    this.anchorX = 0; this.anchorY = 0;
    this.angle = 0;                      // velocity heading, radians
    this.seeking = false;                // input held but nothing to grab
    this.seekTime = 0;                   // seconds of fruitless seeking
    this.desperation = 0;                // 0..1 targeting-assist dial
    this.tension01 = 0;                  // rope load, 0..1
    this.anchor = null;                  // current Anchor object (or null)
    this.missAnchor = null;              // best near-miss, for the seeking reticle
    this.distance = 0;                   // metres travelled in +X since reset

    /**
     * Trail ring buffer: [x, y, speed] triples, stride 3, newest at `trailHead`.
     * Walk backwards with `(trailHead - k + TRAIL_N) % TRAIL_N`.
     */
    this.trailPoints = new Float32Array(TRAIL_N * 3);
    this.trailStride = 3;
    this.trailHead = 0;
    this.trailCount = 0;

    // ---- simulation state (authoritative; `x/y` are the interpolated view) --
    this.sx = 0; this.sy = 0;
    this.px = 0; this.py = 0;            // position before the last substep
    this._accSteps = 0;                  // fixed-timestep accumulator, in SUBSTEPS

    // ---- tether internals --------------------------------------------------
    this.tetherState = T_NONE;
    this.hookX = 0; this.hookY = 0;      // travelling hook tip (visual)
    this.hookT = 0;                      // distance the hook has flown
    this.wasTaut = false;
    this.ropeCorrection = 0;             // last constraint correction magnitude

    // ---- input -------------------------------------------------------------
    this.input = false;
    this.inputPrev = false;

    // ---- cosmetic ----------------------------------------------------------
    this.time = 0;
    this.renderAngle = 0;
    this.perfectFlash = 0;
    this.attachFlash = 0;
    this.trailTimer = 0;
    this.inPerfectWindow = false;

    // ---- perfect-arc telegraph (predictive; read by HUD + renderer) --------
    /** Seconds until the perfect window OPENS. 0 = open now, -1 = not coming. */
    this.perfectETA = -1;
    /** 0..1 ramp for the cue: rises over the last PERFECT_ETA_LEAD seconds before
     *  the window opens, holds at 1 while it is open. This is the signal a human can
     *  actually act on; `inPerfectWindow` alone is only ever a confirmation. */
    this.perfectCue = 0;
    /** Quality01 the release would score right now, or -1 if outside the window. */
    this.perfectQuality = -1;

    /** True while OVERDRIVE is inside its final OVERDRIVE_EXIT_WINDOW seconds, i.e.
     *  while the next arc is the EXIT arc. Written by main.js from the same raw-seconds
     *  boundary the HUD reads, so the avatar cue and the HUD rim can never disagree
     *  about when the window is open — deriving it here from a remapped overdrive01
     *  is exactly how those two would drift apart. Render-only; no physics reads it. */
    this.odExit = false;

    /** Set by the game while OVERDRIVE is running. Hazards and lethal solid faces are
     *  skipped entirely — DESIGN.md promises invulnerability and nothing implemented
     *  it. Deflects still happen, so you still bounce off architecture. */
    this.invuln = false;

    // ---- broad-phase candidate lists (preallocated) ------------------------
    this._solidIdx = new Int32Array(CAND_MAX); this._solidN = 0;
    this._hazIdx   = new Int32Array(CAND_MAX); this._hazN = 0;
    this._orbIdx   = new Int32Array(CAND_MAX); this._orbN = 0;
    this._anchIdx  = new Int32Array(CAND_MAX); this._anchN = 0;
    this._solids = null; this._hazards = null; this._orbs = null; this._anchors = null;
    this._selCd = 0;                     // substeps until the next anchor re-test
    this._stallTime = 0;                 // s tethered below MIN_SPEED (drives the pump)
    this._attachTime = 0;                // s since the rope bit (auto-hop debounce)
    this._recentAnchor = null;           // just auto-hopped off this one
    this._recentCd = 0;

    this.reset(0, 0);
  }

  // -------------------------------------------------------------------------
  reset(x = SPAWN_X, y = SPAWN_Y) {
    this.x = this.sx = this.px = x;
    this.y = this.sy = this.py = y;
    this._spawnX = x;
    this.vx = MIN_SPEED; this.vy = 0;
    this.speed = MIN_SPEED; this.speed01 = MIN_SPEED / TERMINAL;
    this.alive = true;
    this.tethered = false;
    this.tetherState = T_NONE;
    this.anchor = null; this.missAnchor = null;
    this.ropeLen = 0; this.anchorX = x; this.anchorY = y;
    this.hookX = x; this.hookY = y; this.hookT = 0;
    this.wasTaut = false; this.ropeCorrection = 0; this.tension01 = 0;
    this.angle = 0; this.renderAngle = 0;
    this.seeking = false;
    this.seekTime = 0;
    this.desperation = 0;
    this._accSteps = 0; this.time = 0; this.trailTimer = 0;
    this.perfectFlash = 0; this.attachFlash = 0;
    this.inPerfectWindow = false;
    this.perfectETA = -1; this.perfectCue = 0; this.perfectQuality = -1;
    this.invuln = false;
    this.input = false; this.inputPrev = false;
    this.distance = 0;
    this._selCd = 0;

    const t = this.trailPoints;
    for (let i = 0, o = 0; i < TRAIL_N; i++, o += 3) {
      t[o] = x; t[o + 1] = y; t[o + 2] = MIN_SPEED;
    }
    this.trailHead = 0;
    this.trailCount = 1;
  }

  /** The entire control scheme. */
  setInput(down) { this.input = !!down; }

  // =========================================================================
  // UPDATE
  // =========================================================================
  update(dt, world, events) {
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (dt <= 0) return;
    this.time += dt;

    // Cosmetic timers decay on wall-clock, not sim time.
    if (this.perfectFlash > 0) this.perfectFlash -= dt * 3.2;
    if (this.attachFlash > 0) this.attachFlash -= dt * 4.5;

    if (!this.alive) { this.seeking = false; return; }

    // ---- broad phase: one cull per frame, reused by every substep ----------
    this._gather(world, dt);

    // ---- input edges (press / release) resolved once per frame -------------
    const pressed = this.input && !this.inputPrev;
    const released = !this.input && this.inputPrev;
    this.inputPrev = this.input;

    if (released) this._detach(events);
    if (pressed) this._selCd = 0;        // a fresh press retargets on the next substep
    if (!this.input) { this.seeking = false; this.missAnchor = null; }

    // ---- fixed-timestep integration ---------------------------------------
    // The accumulator is counted in SUBSTEPS, not seconds, and the whole part is
    // removed as an exact integer. Draining it as `acc -= SUBSTEP` in seconds
    // leaves a rounding residue that drifts differently at 60 Hz and 120 Hz, which
    // eventually costs (or gains) a whole substep and bifurcates the run. This
    // form keeps both rates on exactly the same substep schedule.
    this._accSteps += dt * INV_SUBSTEP;
    if (this._accSteps > MAX_SUBSTEPS) this._accSteps = MAX_SUBSTEPS;  // hitch guard

    let want = Math.floor(this._accSteps + 1e-7);
    if (want > MAX_SUBSTEPS) want = MAX_SUBSTEPS;
    if (want > 0) this._accSteps -= want;

    let steps = 0;
    while (steps < want && this.alive) { this._step(SUBSTEP, events); steps++; }
    if (steps === 0) { this.px = this.sx; this.py = this.sy; }

    // ---- interpolate the render transform ---------------------------------
    // Standard "render one substep in the past" lerp: perfectly smooth, no jitter,
    // and at most 4.2 ms of latency.
    const alpha = this._accSteps < 0 ? 0 : (this._accSteps > 1 ? 1 : this._accSteps);
    this.x = this.px + (this.sx - this.px) * alpha;
    this.y = this.py + (this.sy - this.py) * alpha;

    // ---- per-frame (not per-substep) work ---------------------------------
    const s = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    this.speed = s;
    this.speed01 = clamp01(s / TERMINAL);
    if (s > 0.001) this.angle = Math.atan2(this.vy, this.vx);
    this.renderAngle = damp(this.renderAngle, this.renderAngle +
      _wrapPi(this.angle - this.renderAngle), 26, dt);

    // Perfect-window telegraph: pure feedback, teaches L2 without a tutorial.
    this._perfectTelegraph();

    this._grazeScan(world, events, dt);
    this._pushTrail(dt);

    if (this.tetherState === T_ATTACHED && events && events.reel) {
      events.reel(this.tension01);
    }
  }

  // -------------------------------------------------------------------------
  // One fixed 1/240 s substep. Order matters: forces → reel → integrate →
  // constraint → collide.
  // -------------------------------------------------------------------------
  _step(h, events) {
    this.px = this.sx; this.py = this.sy;

    // ---- targeting / assist ------------------------------------------------
    // Runs on a SIM-TIME cadence (not a frame cadence) so a 120 Hz device makes
    // exactly the same decisions at exactly the same moments as a 60 Hz one.
    // While the finger is down and we have no rope, we keep re-testing and grab
    // the instant something qualifies — that generosity is most of the game feel.
    if (this.input && this.tetherState === T_NONE) {
      this.seekTime += h;                // drives the desperation assist
      if (this._selCd <= 0) {
        this._selCd = SEL_SUBSTEPS;
        const a = this._selectAnchor();
        if (a !== null) {
          this.anchor = a;
          this.anchorX = a.x; this.anchorY = a.y;
          this.tetherState = T_FIRING;
          this.hookT = 0;
          this.hookX = this.sx; this.hookY = this.sy;
          this.seeking = false;
          this.seekTime = 0;
        } else {
          this.seeking = true;           // HUD/renderer shows why nothing happened
        }
      } else this._selCd--;
    }

    let vx = this.vx, vy = this.vy;

    // ---- gravity ----------------------------------------------------------
    vy += GRAVITY * h;

    // ---- air drag: linear + quadratic, asymptotic at TERMINAL_SPEED --------
    const s = Math.sqrt(vx * vx + vy * vy);
    if (s > 1e-4) {
      const q = s / TERMINAL;
      let decel = AIR_DRAG * s * (1 + DRAG_QUAD * q * q);
      // Firm brake past terminal so the reel pump can never run away to infinity.
      if (s > TERMINAL) decel += OVERSPEED_K * (s - TERMINAL);
      let f = 1 - (decel / s) * h;
      if (f < 0) f = 0;
      vx *= f; vy *= f;
      // Gentle forward assist: a stalled player always recovers, never softlocks.
      if (s < MIN_SPEED) vx += (MIN_SPEED - s) * MIN_SPEED_ASSIST * h;
    } else {
      vx += MIN_SPEED * MIN_SPEED_ASSIST * h;
    }

    // ---- hook flight ------------------------------------------------------
    if (this.tetherState === T_FIRING) {
      this.hookT += T_FIRE_SPEED * h;
      const dx = this.anchorX - this.sx, dy = this.anchorY - this.sy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (this.hookT >= d || d < 1e-3) {
        // Arrived. Rope length is the CURRENT separation, so it is taut on the
        // very next solve — attach is instant, no slack windup, no waiting.
        this.tetherState = T_ATTACHED;
        this.tethered = true;
        // Rope length = the separation AT ARRIVAL, so it is taut immediately and
        // the attach is instant. But never shorter than the angular-rate ceiling
        // allows: a fast player can close most of the gap during the hook's flight,
        // and catching at 3 m while doing 40 m/s is an unreadable whip, not a swing.
        // A too-long rope is harmless — it is simply slack until the arc catches it.
        let L = d;
        const sAtt = Math.sqrt(vx * vx + vy * vy);
        let lmin = sAtt / T_MAX_OMEGA;
        if (lmin < T_MIN_LENGTH) lmin = T_MIN_LENGTH;
        if (L < lmin) L = lmin;
        // Deliberately NOT clamped down to TETHER_MAX_RANGE: the desperation assist
        // can catch beyond it, and shortening the rope below the actual separation
        // would teleport the player backwards on the very first solve.
        this.ropeLen = L;
        this.hookX = this.anchorX; this.hookY = this.anchorY;
        this.wasTaut = false;
        this.attachFlash = 1;
        if (this.anchor) this.anchor.used = true;
        if (events && events.attach) events.attach(this.anchorX, this.anchorY);
      } else {
        const t = this.hookT / d;
        this.hookX = this.sx + dx * t;
        this.hookY = this.sy + dy * t;
      }
    }

    // ---- auto-reel: the pump ----------------------------------------------
    // The floor is whichever is longer: the absolute minimum, or the length that
    // keeps the swing under T_MAX_OMEGA at the current speed. The rope can only
    // ever shorten — lengthening it would push, and ropes do not push.
    let lenPrev = this.ropeLen;
    if (this.tetherState === T_ATTACHED && this.input) {
      // Measure against TANGENTIAL speed — that is what actually spins the arc.
      const rdx = this.sx - this.anchorX, rdy = this.sy - this.anchorY;
      const rd = Math.sqrt(rdx * rdx + rdy * rdy);
      let vt = rd > 1e-4 ? Math.abs((vx * -rdy + vy * rdx) / rd)
                         : Math.sqrt(vx * vx + vy * vy);
      let floor = vt / T_MAX_OMEGA;
      if (floor < T_MIN_LENGTH) floor = T_MIN_LENGTH;
      let nl = this.ropeLen - T_REEL_RATE * h;
      if (nl < floor) nl = floor;
      if (nl < this.ropeLen) this.ropeLen = nl;
    }

    // ---- integrate (semi-implicit Euler) ----------------------------------
    this.vx = vx; this.vy = vy;
    this.sx += vx * h;
    this.sy += vy * h;

    // ---- rope: hard positional distance constraint -------------------------
    this.ropeCorrection = 0;
    if (this.tetherState === T_ATTACHED) {
      const dx = this.sx - this.anchorX, dy = this.sy - this.anchorY;
      const d2 = dx * dx + dy * dy;
      const L = this.ropeLen;
      if (d2 > L * L && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;      // unit vector anchor -> player
        const corr = d - L;

        // Project back onto the circle. Ropes PULL ONLY: inside the radius we do
        // nothing at all, which is what lets you fly slack through the top of an arc.
        this.sx -= nx * corr;
        this.sy -= ny * corr;
        this.ropeCorrection = corr;

        // Split velocity into radial / tangential. Kill outward radial (the rope
        // is inextensible), KEEP tangential — this is the momentum conservation
        // that makes the swing feel heavy and real.
        const tx = -ny, ty = nx;
        const vr = this.vx * nx + this.vy * ny;
        let vt = this.vx * tx + this.vy * ty;

        // Catch sling: on the frame the rope first bites, convert part of the
        // radial velocity it is about to annihilate into tangential swing, in
        // whichever direction the swing is already going (forward, if stationary).
        if (!this.wasTaut && vr > 0) {
          const give = vr * T_CATCH_GAIN;
          if (vt > 0.001) vt += give;
          else if (vt < -0.001) vt -= give;
          else vt += tx > 0 ? give : -give;
        }

        // Conservation of angular momentum while reeling in: L = v_t * r, so
        // shrinking r from lenPrev to L multiplies v_t by lenPrev / L.
        // A bare PBD projection does NOT do this (it preserves tangential *speed*),
        // so without this line "hold longer = faster" is simply false.
        if (this.wasTaut && lenPrev > L && L > 1e-4) {
          const ratio = lenPrev / L;
          vt *= 1 + (ratio - 1) * T_REEL_SPIN;
        }

        // ---- THE PUMP ----------------------------------------------------
        // Tangential drive, strongest with the rope vertical, zero at the extremes,
        // always along the way the swing is already going. This is what makes
        // "keep holding" build amplitude instead of decaying into a dead dangle.
        if (this.input) {
          // ny > 0 means the player hangs below the anchor: that is the bottom of
          // the arc, where a kick does the most work.
          const vert = ny > 0 ? ny : 0;
          const vtAbs = vt < 0 ? -vt : vt;
          let dir;
          if (vt > PUMP_SEED_SPEED) dir = 1;
          else if (vt < -PUMP_SEED_SPEED) dir = -1;
          else dir = tx > 0 ? 1 : -1;      // dead hang: seed the swing FORWARD (+X)
          // Fall off toward the asymptote so a held swing cruises, never diverges.
          let scale = 1 - vtAbs / PUMP_MAX_SPEED;
          if (scale < 0) scale = 0;
          // Guarantee: no stable low-energy fixed point can exist anywhere. If we
          // are somehow still crawling after a second, the kick keeps growing.
          const esc = 1 + this._stallTime * PUMP_ESCALATE;
          vt += dir * PUMP_ACCEL * vert * scale * esc * h;
        }

        // Whisper-thin rope friction. CFG.TETHER_DAMPING is treated as per-second.
        vt *= 1 - T_DAMPING * h;

        // Hard rail: the arc can never sweep faster than T_MAX_OMEGA. Targeting,
        // the catch length and the reel floor all respect this already, so this
        // only fires in pathological cases — but it makes the bound a guarantee
        // rather than a hope, and it caps swing speed at omega * TETHER_MAX_RANGE.
        const vtMax = T_MAX_OMEGA * L;
        if (vt > vtMax) vt = vtMax;
        else if (vt < -vtMax) vt = -vtMax;

        const vrKeep = vr < 0 ? vr : 0;      // inward motion is unaffected
        this.vx = nx * vrKeep + tx * vt;
        this.vy = ny * vrKeep + ty * vt;

        // Rope load = centripetal demand + the gravity component along the rope.
        const a = (vt * vt) / (L > 1e-3 ? L : 1e-3) + GRAVITY * ny;
        this.tension01 = clamp01(a / T_TENSION_REF);
        this.wasTaut = true;
      } else {
        this.wasTaut = false;
        this.tension01 *= 0.86;              // slack rope relaxes visually
      }
    } else {
      this.tension01 *= 0.86;
    }

    // Metres travelled from spawn — the headline number, and what gates the
    // "solids cannot kill yet" tutorial rule. Monotonic: backing up does not undo it.
    const travelled = this.sx - this._spawnX;
    if (travelled > this.distance) this.distance = travelled;

    // ---- stall watchdog & auto-hop ----------------------------------------
    if (this._recentCd > 0) this._recentCd -= h;
    if (this.tetherState === T_ATTACHED) {
      const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (sp < MIN_SPEED) this._stallTime += h;
      else this._stallTime = 0;

      this._attachTime += h;
      if (this.input && this._attachTime > AUTO_HOP_MIN_TIME) {
        // phi is the player's bearing around the anchor from +X (+Y is down), so a
        // forward swing runs phi: ~PI (behind and below) down toward 0 (ahead and
        // level). Below AUTO_HOP_PHI the arc is spent and holding on would start
        // dragging the player backwards — so let go and take the next anchor.
        const phi = Math.atan2(this.sy - this.anchorY, this.sx - this.anchorX);
        if (phi < AUTO_HOP_PHI) {
          this._recentAnchor = this.anchor;
          this._recentCd = AUTO_HOP_LOCKOUT;
          this._detach(events);
        }
      }
    } else {
      this._stallTime = 0;
      this._attachTime = 0;
    }

    // ---- collision (substepped, so nothing tunnels at 120 m/s) ------------
    this._collide(events);
  }

  // =========================================================================
  // TETHER TARGETING
  // =========================================================================
  /**
   * Score every anchor in range and return the best, or null. Also records the
   * best near-miss in `this.missAnchor` so the renderer can show a ghost reticle
   * ("here is what you were reaching for, and why it didn't take").
   */
  _selectAnchor() {
    const anchors = this._anchors;
    if (!anchors) { this.missAnchor = null; return null; }

    const x = this.sx, y = this.sy;
    const vx = this.vx, vy = this.vy;
    const spd = Math.sqrt(vx * vx + vy * vy);

    // Reference direction = travel direction blended toward +X. At low speed we
    // just aim forward, which is why a standing start still finds an anchor.
    let rx, ry;
    if (spd > 1.5) {
      ry = vy / spd;
      if (ry > 0) ry *= T_VY_WEIGHT;          // discount falling, keep the cone forward
      rx = vx / spd + T_FWD_BIAS;
    } else { rx = 1; ry = 0; }
    const rl = Math.sqrt(rx * rx + ry * ry);
    rx /= rl; ry /= rl;

    // ---- desperation ------------------------------------------------------
    // Three independent emergencies, all pushing the same dial: how long we have
    // been reaching for nothing, how fast we are dropping, and how close the
    // floodline is. Any one of them alone can open the gates all the way.
    let k = this.seekTime / T_DESPERATE_TIME;
    if (vy > 0) k += clamp01((vy - 20) / 60) * 0.5;
    k += clamp01((this.sy - (FLOODLINE - T_FLOOD_PANIC)) / T_FLOOD_PANIC) * 0.8;
    k = clamp01(k);
    this.desperation = k;

    // A falling player needs a longer reach to catch themselves.
    const fall = vy > 0 ? vy : 0;
    let boost = clamp01((fall - 20) / T_FALL_RANGE_REF);
    if (k > boost) boost = k;
    const maxR = T_MAX_RANGE * (1 + T_FALL_RANGE_BOOST * boost);
    const searchR = maxR * T_ASSIST_RANGE;

    // Gates, each relaxed toward "accept anything" as desperation rises.
    const coneCos   = T_CONE_COS    + (-1  - T_CONE_COS)    * k;
    const upGate    = T_MIN_UP      + (-0.95 - T_MIN_UP)    * k;
    const behindTol = T_BEHIND_TOL  + (1    - T_BEHIND_TOL) * k;
    const veto      = T_RADIAL_VETO + (1    - T_RADIAL_VETO)* k;

    // Minimum usable rope: never tighter than the angular-rate ceiling allows, or
    // the catch turns into an unreadable whip round the anchor. In desperation we
    // will take the whip.
    const invOmega = 1 / T_MAX_OMEGA;

    let best = null, bestScore = -1e9;
    let miss = null, missScore = -1e9;

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!a || a.alive === false) continue;

      const dx = a.x - x, dy = a.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > searchR * searchR) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-4) continue;

      const ux = dx / d, uy = dy / d;
      const up = -uy;                          // >0 = anchor is above us
      const align = ux * rx + uy * ry;         // cos(angle to travel direction)

      // How much of our current speed the rope would instantly annihilate.
      // This is THE quality metric. The constraint destroys the OUTWARD radial
      // component (motion away from the anchor); motion *toward* the anchor is
      // untouched because a rope only pulls. So the cost is max(0, -v̂·û).
      let radial = 0;
      let outward = 0;
      if (spd > 1.5) {
        outward = -(vx * ux + vy * uy);
        if (outward < 0) outward = 0;          // closing on the anchor costs nothing
        radial = outward / spd;
      }

      // Predicted tangential speed once the rope bites: what survives the catch,
      // plus the sling. This — not raw speed — is what sets the swing rate, so it
      // is what the minimum rope length has to be measured against. Using raw speed
      // here would make a fast fall unable to grab anything, which is a death spiral.
      const vtAfter = Math.abs(vx * -uy + vy * ux) + outward * T_CATCH_GAIN;
      let minR = vtAfter * invOmega;
      minR += (T_MIN_RANGE - minR) * k;        // desperation accepts a tight catch
      if (minR < T_MIN_RANGE) minR = T_MIN_RANGE;

      // Bottom of the arc this rope would describe. If it dunks the player under
      // the flood line, it is not a swing, it is a suicide.
      const low = a.y + d;

      // ---- gates ---------------------------------------------------------
      const inRange = d2 <= maxR * maxR && d >= minR;
      const inCone  = align >= coneCos;
      // Normally a hard requirement: an anchor level with (or below) the player has
      // no swing in it — the rope yanks the run to a stop or whips it into a
      // backwards loop. Under desperation we take that deal over dying.
      const aboveOk = up >= upGate;
      const fwdOk   = ux >= -behindTol;
      const momOk   = radial <= veto;
      // THE BAILOUT. This gate vetoes exactly the anchors a sinking player needs —
      // the low ones whose arc bottoms out under the water — and it used to hold
      // until desperation cleared 0.45, which floodline proximity alone only reaches
      // within 11.4m of the surface. At the measured 62 m/s descent that is 0.19s of
      // runway: the escape hatch unlocked AFTER the crash was unavoidable. 0.18 opens
      // it ~30m up (~0.5s), enough to fire the hook and load the rope. A wet swing
      // you survive beats a dry one you never take.
      const safeOk  = low < FLOODLINE || k > 0.18;
      const valid = inRange && inCone && aboveOk && fwdOk && momOk && safeOk;

      // ---- score ---------------------------------------------------------
      let sc = 0;
      // NB: scoring always uses the STRICT thresholds, never the relaxed ones, so
      // the preference order is identical however desperate we are.
      sc += W_ALIGN * clamp01((align - T_CONE_COS) / (1 - T_CONE_COS));
      // Higher is better, all the way up to straight overhead.
      sc += W_UP * clamp01((up - T_MIN_UP) / (1 - T_MIN_UP));
      sc += W_FWD * clamp01((ux + T_BEHIND_TOL) / (1 + T_BEHIND_TOL));

      // Rope-length sweet spot: mid-long ropes carry furthest per swing.
      const rn = d / maxR;
      let rs = 1 - Math.abs(rn - T_RANGE_SWEET) / T_RANGE_WIDTH;
      sc += W_RANGE * clamp01(rs);

      // Swing potential. phi is the player's bearing around the anchor measured
      // from +X (remember +Y is down): behind-and-below gives phi near PI, which
      // is a full forward-carrying quarter-to-half arc. Directly ahead-and-level
      // gives phi near 0 — no swing left, you just get yanked.
      const phi = Math.atan2(y - a.y, x - a.x);
      sc += W_SWING * clamp01(phi / Math.PI) * clamp01(rn * 1.25);

      // Momentum tax, squared so only genuinely bad grabs get punished.
      sc -= W_RADIAL * radial * radial;

      // Taper off well before the flood line, not just at it.
      const lowLimit = FLOODLINE - GROUND_MARGIN;
      if (low > lowLimit) sc -= W_GROUND * clamp01((low - lowLimit) / GROUND_MARGIN);

      if (a.kind === 1) sc += W_HEAVY;
      else if (a.kind === 2) sc -= W_DECAY;
      if (a.used) sc -= W_USED;
      // Don't immediately re-grab the anchor we just auto-hopped off, or the
      // player ping-pongs on one node instead of moving down the level.
      if (a === this._recentAnchor && this._recentCd > 0) sc -= W_RECENT;

      if (valid) {
        if (sc > bestScore) { bestScore = sc; best = a; }
      } else if (sc > missScore) { missScore = sc; miss = a; }
    }

    this.missAnchor = best === null ? miss : null;
    return best;
  }

  /** Release: keep velocity exactly, then judge the arc. */
  _detach(events) {
    const wasAttached = this.tetherState === T_ATTACHED;
    this.tetherState = T_NONE;
    this.tethered = false;
    this.anchor = null;
    this.seeking = false;
    this.wasTaut = false;
    this.missAnchor = null;
    this.seekTime = 0;
    this.desperation = 0;
    if (!wasAttached) return;

    const s = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (events && events.release) events.release(this.sx, this.sy, s);

    // ---- PERFECT ARC ------------------------------------------------------
    const q = this._perfectAngle();
    if (q >= 0 && s > 1e-4) {
      const ux = this.vx / s, uy = this.vy / s;
      this.vx += ux * P_IMPULSE;
      this.vy += uy * P_IMPULSE;
      this.perfectFlash = 1;
      if (events && events.perfectArc) events.perfectArc(this.sx, this.sy, q);
    }
  }

  /**
   * PREDICTIVE perfect-arc telegraph. Runs once per frame, writes three signals the
   * HUD and the renderer read: `perfectQuality`, `perfectETA`, `perfectCue`.
   *
   * Reading `inPerfectWindow` off the CURRENT velocity — which is all this used to do
   * — produces a cue that switches on at the instant the window opens and off a
   * median 0.22s later. Human visual reaction is ~250ms, so that cue is late BY
   * CONSTRUCTION and the window can only be hit by rhythm or by luck. (A sim has zero
   * latency, which is the only reason the SMART bot managed 27.5 hits/run.)
   *
   * The fix is that phi is EXTRAPOLATABLE. The rope bearing sweeps at a known rate,
   * so we can say how many seconds remain before it crosses P_PHI_MAX and start the
   * cue P_ETA_LEAD seconds early. This is the difference between "you missed it" and
   * "here it comes".
   */
  _perfectTelegraph() {
    const q = this.tetherState === T_ATTACHED ? this._perfectAngle() : -1;
    this.perfectQuality = q;
    this.inPerfectWindow = q >= 0;
    if (this.inPerfectWindow) { this.perfectETA = 0; this.perfectCue = 1; return; }

    this.perfectETA = -1;
    this.perfectCue = 0;
    if (this.tetherState !== T_ATTACHED) return;

    // The window has a speed floor as well as an angle band, and only the angle is
    // predictable. Suppress the cue when the swing is too slow to score — the pump
    // is still adding energy, so allow a little headroom rather than flickering the
    // cue on and off across the boundary.
    if (this.speed < P_MIN_SPEED * 0.85) return;

    const rdx = this.sx - this.anchorX, rdy = this.sy - this.anchorY;
    const L2 = rdx * rdx + rdy * rdy;
    if (L2 < 1e-6) return;

    // omega = dphi/dt = vt / L. NEGATIVE on a forward swing (phi sweeps down from PI
    // toward 0), which is the only direction that can reach the window from outside.
    const omega = (this.vx * -rdy + this.vy * rdx) / L2;
    if (omega > -1e-3) return;

    const phi = Math.atan2(rdy, rdx);
    if (phi <= P_PHI_MAX) return;         // window already open (handled above) or spent

    const eta = (phi - P_PHI_MAX) / -omega;
    if (eta > P_ETA_LEAD) return;         // real, but too far out to be worth signalling
    this.perfectETA = eta;
    this.perfectCue = 1 - eta / P_ETA_LEAD;
  }

  /**
   * Returns quality01 (1 = dead centre of the window) if the current velocity is
   * inside the Perfect Arc window, or -1 if it is not.
   * +Y IS DOWN: "up and forward" is vx > 0 AND vy < 0.
   */
  _perfectAngle() {
    const vx = this.vx, vy = this.vy;
    if (vx <= 0 || vy >= 0) return -1;
    const s = Math.sqrt(vx * vx + vy * vy);
    if (s < P_MIN_SPEED) return -1;
    const ang = Math.atan2(-vy, vx);          // radians above the horizontal
    if (ang < P_ANG_MIN || ang > P_ANG_MAX) return -1;
    const off = ang - P_ANG_MID;
    return clamp01(1 - (off < 0 ? -off : off) / P_ANG_HALF);
  }

  // =========================================================================
  // COLLISION / GRAZING
  // =========================================================================
  /** One broad-phase cull per frame; the substeps reuse the index lists. */
  _gather(world, dt) {
    const x = this.sx;
    const win = CULL_X;

    // Cache the live arrays; getters are called exactly once per frame.
    const solids = world.solids;
    const hazards = world.hazards;
    const orbs = world.orbs;
    this._solids = solids; this._hazards = hazards; this._orbs = orbs;
    this._anchors = world.anchors;

    this._solidN = 0;
    if (solids) {
      for (let i = 0; i < solids.length && this._solidN < CAND_MAX; i++) {
        const o = solids[i];
        if (!o) continue;
        const ex = o.hw > o.hh ? o.hw : o.hh;
        const dx = o.x - x;
        if (dx > win + ex || dx < -win - ex) continue;
        if (o._grazeCd > 0) o._grazeCd -= dt; else o._grazeCd = 0;
        // Deflect keeps its OWN cooldown. Sharing `_grazeCd` made the deflect event
        // unreachable: any solid you are close enough to hit, you first grazed, and
        // the graze write (0.9s) always beat the deflect read. See the note at the
        // deflect gate in _collide().
        if (o._deflectCd > 0) o._deflectCd -= dt; else o._deflectCd = 0;
        this._solidIdx[this._solidN++] = i;
      }
    }

    this._hazN = 0;
    if (hazards) {
      for (let i = 0; i < hazards.length && this._hazN < CAND_MAX; i++) {
        const o = hazards[i];
        if (!o || o.alive === false) continue;
        const ex = o.hw > o.hh ? o.hw : o.hh;
        const dx = o.x - x;
        if (dx > win + ex || dx < -win - ex) continue;
        if (o._grazeCd > 0) o._grazeCd -= dt; else o._grazeCd = 0;
        this._hazIdx[this._hazN++] = i;
      }
    }

    this._orbN = 0;
    if (orbs) {
      for (let i = 0; i < orbs.length && this._orbN < CAND_MAX; i++) {
        const o = orbs[i];
        if (!o || o.alive === false || o.collected) continue;
        const dx = o.x - x;
        if (dx > win || dx < -win) continue;
        this._orbIdx[this._orbN++] = i;
      }
    }

    // Anchors are grazable geometry (see GRAZE_ANCHORS) but never collide, so they
    // get their own narrow list — the graze band is the only thing that reads it.
    this._anchN = 0;
    const anchors = this._anchors;
    if (GRAZE_ANCHORS && anchors) {
      for (let i = 0; i < anchors.length && this._anchN < CAND_MAX; i++) {
        const a = anchors[i];
        if (!a || a.alive === false) continue;
        const dx = a.x - x;
        if (dx > win || dx < -win) continue;
        if (a._grazeCd > 0) a._grazeCd -= dt; else a._grazeCd = 0;
        this._anchIdx[this._anchN++] = i;
      }
    }
  }

  /** Hard contacts. Runs every substep so nothing tunnels. */
  _collide(events) {
    // `_step` has no world reference, so `_gather` caches the live arrays here
    // alongside the culled index lists.
    const solids = this._solids, hazards = this._hazards, orbs = this._orbs;
    const x = this.sx, y = this.sy;

    // ---- floodline --------------------------------------------------------
    if (y > FLOODLINE) { this._crash(events); return; }

    // ---- hazards: always lethal, unless OVERDRIVE is up -------------------
    // DESIGN.md promises invulnerability during overdrive and nothing implemented it.
    // The whole point of L5 ("bank charge, trigger it on a dense hazard cluster") is
    // that the meter buys you a corridor you could not otherwise take, so this branch
    // is the mechanic. The floodline above still kills — drowning is not a hazard,
    // it is the edge of the world, and making it survivable would delete the failure
    // state a held input can produce.
    if (hazards && !this.invuln) {
      for (let k = 0; k < this._hazN; k++) {
        const o = hazards[this._hazIdx[k]];
        if (!o || o.alive === false) continue;
        if (circleVsOBB(x, y, RADIUS, o.x, o.y, o.hw, o.hh, o.rot || 0)) {
          this._crash(events);
          return;
        }
      }
    }

    // ---- solids: glancing blows deflect, square hits kill ------------------
    if (solids) {
      for (let k = 0; k < this._solidN; k++) {
        const o = solids[this._solidIdx[k]];
        if (!o) continue;
        obbProbe(x, y, o.x, o.y, o.hw, o.hh, o.rot || 0);
        if (_sd >= RADIUS) continue;

        const nx = _nx, ny = _ny;
        const vx = this.vx, vy = this.vy;
        const s = Math.sqrt(vx * vx + vy * vy);
        // sin(incidence from the tangent) = |v̂ · n|
        const sinInc = s > 1e-4 ? Math.abs((vx * nx + vy * ny) / s) : 0;

        // The tutorial stretch is survivable BY CONSTRUCTION: for the first
        // SOLID_SAFE_DIST metres, architecture can only ever bounce you off it.
        // Hazards still kill — the player must still learn that magenta means death.
        const lethalOk = this.distance >= SOLID_SAFE_DIST && !this.invuln;
        if (lethalOk && sinInc > DEFLECT_SIN) { this._crash(events); return; }

        // Glance: reflect the normal component with low restitution, scrub the
        // rest. This forgiveness is what keeps the game approachable — you skim
        // walls constantly and it reads as skill, not as a mistake.
        const pen = RADIUS - _sd;
        this.sx += nx * pen;
        this.sy += ny * pen;
        const vn = vx * nx + vy * ny;
        let rx = vx, ry = vy;
        if (vn < 0) {
          rx = (vx - (1 + DEFLECT_REST) * vn * nx) * DEFLECT_SCRUB;
          ry = (vy - (1 + DEFLECT_REST) * vn * ny) * DEFLECT_SCRUB;
        }
        // Anti-trap: a square hit at low speed leaves almost nothing behind, and
        // the player would grind against the face forever. Guarantee an escape
        // along the normal, biased forward so they are launched back into play.
        const rs = Math.sqrt(rx * rx + ry * ry);
        if (rs < ESCAPE_SPEED) {
          rx += nx * ESCAPE_SPEED + ESCAPE_SPEED * 0.35;
          ry += ny * ESCAPE_SPEED;
        }
        this.vx = rx; this.vy = ry;

        // A deflect is a HIT — you touched the wall. It used to fire `graze`, so
        // bumping into architecture scored and charged identically to threading past
        // it: the L3 skill layer paying out for the exact opposite of the skill.
        // It gets its own event, and no score.
        //
        // The gate reads `_deflectCd`, NOT `_grazeCd`, and the distinction is the whole
        // reason this event exists at all. Sharing one field made the deflect
        // structurally unreachable — 100% suppression, measured: 1.5 deflect *responses*
        // per run producing 0.0 *events*. To hit a solid you must pass within
        // PLAYER_RADIUS of it, which is inside GRAZE_RADIUS, so `_grazeCd` was always
        // set by _grazeScan a frame or two earlier and still had most of its 0.9s left.
        // Two different questions ("did I just score a near-miss?" and "did I just bounce
        // off this?") cannot share one piece of state.
        if (!(o._deflectCd > 0)) {
          o._deflectCd = DEFLECT_CD;
          if (events && events.deflect) events.deflect(this.sx, this.sy, o);
        }
      }
    }

    // ---- orbs -------------------------------------------------------------
    if (orbs) {
      for (let k = 0; k < this._orbN; k++) {
        const o = orbs[this._orbIdx[k]];
        if (!o || o.alive === false || o.collected) continue;
        const dx = o.x - x, dy = o.y - y;
        const rr = RADIUS + (o.r || 1);
        if (dx * dx + dy * dy <= rr * rr) {
          o.collected = true;
          o.alive = false;
          if (events && events.orb) events.orb(o.x, o.y);
        }
      }
    }
  }

  /**
   * Near-misses. Once per frame is plenty — it is cooldown-gated anyway.
   *
   * The fourth argument tells the sink whether the thing skimmed was a LIVE HAZARD.
   * That is the only graze that could have killed you, so it is the only one worth
   * real money (SCORE_GRAZE_HAZARD / GRAZE_CHARGE_HAZARD): risk = reward, per
   * DESIGN.md L3. Architecture and anchors pay the base rate.
   */
  _grazeScan(world, events, dt) {
    if (!events || !events.graze) return;
    const x = this.sx, y = this.sy;
    const outer = RADIUS + GRAZE_RADIUS;

    const hazards = world.hazards;
    if (hazards) {
      for (let k = 0; k < this._hazN; k++) {
        const o = hazards[this._hazIdx[k]];
        if (!o || o.alive === false) continue;
        obbProbe(x, y, o.x, o.y, o.hw, o.hh, o.rot || 0);
        if (_sd >= RADIUS && _sd < outer && !(o._grazeCd > 0)) {
          o._grazeCd = GRAZE_COOLDOWN;
          events.graze(x, y, o, true);
        }
      }
    }

    const solids = world.solids;
    if (solids) {
      for (let k = 0; k < this._solidN; k++) {
        const o = solids[this._solidIdx[k]];
        if (!o) continue;
        obbProbe(x, y, o.x, o.y, o.hw, o.hh, o.rot || 0);
        if (_sd >= RADIUS && _sd < outer && !(o._grazeCd > 0)) {
          o._grazeCd = GRAZE_COOLDOWN;
          events.graze(x, y, o, false);
        }
      }
    }

    // Anchors. Circles, not boxes, and never solid — so the band is measured off the
    // ring surface and a dead-centre fly-through scores nothing. Threading the edge
    // of a node you chose not to take is the graze; taking it is not.
    const anchors = this._anchors;
    if (GRAZE_ANCHORS && anchors) {
      const skipA = this.anchor, skipB = this._recentAnchor;
      for (let k = 0; k < this._anchN; k++) {
        const a = anchors[this._anchIdx[k]];
        if (!a || a.alive === false || a === skipA || a === skipB) continue;
        if (a._grazeCd > 0) continue;
        const dx = x - a.x, dy = y - a.y;
        const sd = Math.sqrt(dx * dx + dy * dy) - a.r;
        if (sd >= RADIUS && sd < outer) {
          a._grazeCd = GRAZE_COOLDOWN;
          events.graze(x, y, a, false);
        }
      }
    }
  }

  _crash(events) {
    if (!this.alive) return;
    this.alive = false;
    this.tethered = false;
    this.tetherState = T_NONE;
    this.seeking = false;
    if (events && events.crash) events.crash(this.sx, this.sy, this.vx, this.vy);
  }

  // -------------------------------------------------------------------------
  _pushTrail(dt) {
    this.trailTimer += dt;
    while (this.trailTimer >= TRAIL_INTERVAL) {
      this.trailTimer -= TRAIL_INTERVAL;
      this.trailHead = (this.trailHead + 1) % TRAIL_N;
      const o = this.trailHead * 3;
      const t = this.trailPoints;
      t[o] = this.x; t[o + 1] = this.y; t[o + 2] = this.speed;
      if (this.trailCount < TRAIL_N) this.trailCount++;
    }
  }

  // =========================================================================
  // RENDER
  // =========================================================================
  render(r, time) {
    const x = this.x, y = this.y;
    const s01 = this.speed01;
    const hot = 1 + s01 * 1.6;                 // speed drives HDR brightness

    // ---- ribbon trail ------------------------------------------------------
    const t = this.trailPoints;
    const n = this.trailCount;
    for (let k = 0; k < n - 1; k++) {
      const i = ((this.trailHead - k) % TRAIL_N + TRAIL_N) % TRAIL_N;
      const j = ((this.trailHead - k - 1) % TRAIL_N + TRAIL_N) % TRAIL_N;
      const o0 = i * 3, o1 = j * 3;
      const x0 = t[o0], y0 = t[o0 + 1];
      const x1 = t[o1], y1 = t[o1 + 1];
      const dx = x1 - x0, dy = y1 - y0;
      if (dx * dx + dy * dy < 1e-6) continue;

      const u = k / TRAIL_N;                    // 0 = head, 1 = tail
      const taper = (1 - u) * (1 - u);
      const sp = clamp01(t[o0 + 2] / TERMINAL);
      // The ribbon has to emerge from BEHIND the avatar, not on top of it. A trail
      // point is laid every TRAIL_INTERVAL (1/90 s), so at cruise a segment is ~0.6
      // world units against a 1.0-unit body: the first four segments were the widest
      // and hottest the ribbon ever gets AND they sat directly on the player. Fading
      // them in costs nothing visually — the ribbon stays continuous because the body
      // covers exactly the part being faded — and it is what lets the avatar have a
      // silhouette at all.
      const emerge = k < 4 ? 0.14 + k * 0.215 : 1;
      const w = (0.10 + RADIUS * 0.95 * taper) * (0.34 + 0.66 * emerge);
      // The ribbon was the single largest flat region in the frame, and it was the
      // HALO doing it, not the core: glowRadius w*3.4 with glow 0.9+sp put a ~4.7-unit
      // wide band across a third of the screen, at 5-8x the bright-pass threshold once
      // the ~4 overlapping segments per pixel are summed — uniformly clipped, with no
      // falloff, and the avatar inside it. The halo now scales at 0.9x the core with
      // roughly half the strength, so the ribbon has a hot centreline and a real edge
      // instead of being one slab of cyan.
      tint(CA, PAL.cyanHot, (0.10 + 0.62 * sp) * taper * hot * emerge, 1);
      r.line(LAYER.NEON, x0, y0, x1, y1, w, CA,
        { glow: 0.35 + 0.45 * sp, glowRadius: w * 0.9, soft: 0.05 });
    }

    // ---- tether ------------------------------------------------------------
    if (this.tetherState === T_FIRING) {
      // Hook in flight: thin, cold, fast. Sells the ~50 ms of travel.
      tint(CA, PAL.cyanHot, 0.55, 1);
      r.line(LAYER.NEON, x, y, this.hookX, this.hookY, 0.10, CA,
        { glow: 1.1, glowRadius: 0.5, soft: 0.05 });
      tint(CB, PAL.white, 1.5, 1);
      r.circle(LAYER.NEON, this.hookX, this.hookY, 0.30, CB, { glow: 2.4, glowRadius: 1.6, soft: 0.05 });
    } else if (this.tetherState === T_ATTACHED) {
      const ax = this.anchorX, ay = this.anchorY;
      const dx = ax - x, dy = ay - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ten = this.tension01;
      const bright = 0.55 + ten * 1.85;         // tension visibly lights the rope
      const w = 0.085 + ten * 0.075;

      // Slack ropes bow. Cheap 4-segment catenary; only when it matters.
      const slack = this.ropeLen - d;
      if (slack > 0.15 && d > 0.001) {
        const sag = slack * 0.55;
        const ux = dx / d, uy = dy / d;
        let pxp = x, pyp = y;
        tint(CA, PAL.cyanHot, bright * 0.8, 1);
        for (let k = 1; k <= 4; k++) {
          const tt = k / 4;
          const bow = Math.sin(tt * Math.PI) * sag;
          const cx = x + ux * d * tt;
          const cy = y + uy * d * tt + bow;
          r.line(LAYER.NEON, pxp, pyp, cx, cy, w, CA, { glow: 1.2, glowRadius: 0.55, soft: 0.05 });
          pxp = cx; pyp = cy;
        }
      } else {
        tint(CA, PAL.cyanHot, bright, 1);
        r.line(LAYER.NEON, x, y, ax, ay, w, CA, { glow: 1.4 + ten * 1.4, glowRadius: 0.7, soft: 0.05 });
      }

      // Travelling energy pulses running up the line toward the anchor.
      tint(CB, PAL.white, 1.4 + ten * 2.2, 1);
      for (let k = 0; k < 4; k++) {
        let tt = (time * 1.55 + k * 0.25) % 1;
        const cx = x + dx * tt, cy = y + dy * tt;
        const fade = 0.35 + 0.65 * Math.sin(tt * Math.PI);
        tint(CC, PAL.white, (1.2 + ten * 2.0) * fade, 1);
        r.circle(LAYER.NEON, cx, cy, 0.14 + 0.05 * fade, CC,
          { glow: 2.0, glowRadius: 0.9, soft: 0.04 });
      }

      // Anchor flare — where the rope bites.
      const fl = 1 + this.attachFlash * 2.5;
      tint(CA, PAL.violetHot, (0.9 + ten * 1.4) * fl, 1);
      r.glow(LAYER.NEON, ax, ay, 2.2 + ten * 2.4 + this.attachFlash * 3, CA,
        { glow: 1.5, glowRadius: 2.6 });
      tint(CB, PAL.white, (1.4 + ten * 1.6) * fl, 1);
      r.ring(LAYER.NEON, ax, ay, 0.85 + this.attachFlash * 1.2, 0.12, CB,
        { glow: 2.2, glowRadius: 0.9, soft: 0.05 });
      r.circle(LAYER.NEON, ax, ay, 0.22, CB, { glow: 2.6, glowRadius: 1.2, soft: 0.04 });
    }

    // ---- seeking reticle ---------------------------------------------------
    if (this.seeking) {
      const m = this.missAnchor;
      const blink = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 11));
      if (m) {
        tint(CA, PAL.magentaHot, 0.55 * blink, 1);
        r.ring(LAYER.NEON, m.x, m.y, 1.9, 0.09, CA, { glow: 1.3, glowRadius: 0.8, soft: 0.06 });
        // four corner ticks, so it reads as a reticle and not as an anchor
        for (let k = 0; k < 4; k++) {
          const a = k * HALF_PI + Math.PI * 0.25;
          const ca = Math.cos(a), sa = Math.sin(a);
          r.line(LAYER.NEON, m.x + ca * 2.5, m.y + sa * 2.5,
            m.x + ca * 3.4, m.y + sa * 3.4, 0.10, CA, { glow: 1.1, glowRadius: 0.5, soft: 0.06 });
        }
      }
      // A pip on the player says "I heard your input, there is nothing to grab".
      tint(CB, PAL.magentaHot, 0.9 * blink, 1);
      r.ring(LAYER.NEON, x, y, 1.6 + 0.12 * Math.sin(time * 11), 0.06, CB,
        { glow: 1.0, glowRadius: 0.6, soft: 0.06 });
    }

    // ---- player body -------------------------------------------------------
    // DESIGN.md's FIRST aesthetic rule is "nothing is flat: every emissive element has
    // a bloom halo and a dimmer core-to-edge falloff". This was the worst violator in
    // the build, and it is the thing the eye is locked on for the whole run.
    //
    // The cause was not the shapes, it was the EMISSION LEVELS. The old body drew a
    // white core at PAL.white * 2.9 = (7.5, 8.4, 8.7) with glow 2.6 over a 1.5-unit
    // halo radius, under a ring at (0.8, 5.7, 6.6) with its own 1.1-unit halo, under a
    // 3.0-unit haze disc, with the trail's hottest segment on top of all of it. Every
    // one of those lands past 5.0, and past ~5.0 the tonemapper cannot tell any two
    // values apart — they all resolve to the same near-white. Four carefully drawn
    // concentric elements arrived as one plate: measured on a cruise frame, 100% of
    // the avatar box above luma 200 with sd/peak of 1.6%.
    //
    // The rebuild is a BUDGET, and the budget is mostly about SUBTRACTION. Measured
    // through a static rig that draws the avatar and nothing else, as a radial
    // luminance profile out from the centre in world units, at cruise:
    //     before   234 234 234 233 231 230 230 228 227 226 224 221 218
    //     after    250 250 226 219 220 208 158 108  78  50  30  21  16
    //              u=0 .25 .5  .75 1.0 1.25 1.5 1.75 2.0 2.25 2.5 2.75 3.0
    // The old avatar was flat to within 16 luma across SIX world units. And on the
    // same rig, mid-build, with a haze disc and an interior fill added back:
    //     247 246 242 231 224 218 166 107  77
    // — same peak, same outer falloff, and the only thing they changed was to fill in
    // the 0.5-0.75 gap that the structure was living in. On a 50-device-pixel object
    // under this much bloom the interior is a scarce resource: an extra emissive
    // element inside the silhouette is subtracted from the read, not added to it.
    //
    // Box statistics over +/-2.2 world units, and the widest run of luma > 200 through
    // the avatar's own row as a fraction of frame width:
    //     sd / peak       1.6%  -> 29.5%
    //     pixels > 200     100% -> 36.4%
    //     hot run          24.1% of frame width -> 6.4%
    //
    // So: four elements, none of them redundant, at s01 = 1:
    //     core 7.2 white -> rim 3.3 cyan -> lance 2.3 white -> wings 1.04 cyan
    // Brightest at the CENTRE and second-brightest at the RIM, with a deliberately
    // empty annulus between them; the falloff outside the rim is left to the post
    // bloom, which is what DESIGN.md means by "light does the drawing". The separate
    // haze disc, body fill and shell ring are gone — the bloom already provides the
    // halo they were duplicating. Footprint drops with them: the old haze alone was
    // 3.0 world units of radius, the whole avatar is now inside 1.6.
    //
    // ---- AND THE REBUILD ABOVE STILL DID NOT LAND, for one reason ------------------
    // Every number above was chosen against a tonemap that had NO HIGHLIGHT RESPONSE
    // (see the knee note in post.js): above ~2 emission the output stopped depending on
    // input at all, so "core 4.6 white, rim 3.7 cyan" was a hue difference and nothing
    // else. Measured live at s01 = 1, on the frozen-frame rig tools/dev/.avshot.mjs,
    // radial luminance and saturation in world units out from the centre:
    //     before  lum 244 244 235 222 219 218 205 174 143 119 103  95  92
    //             sat .11 .12 .26 .48 .52 .54 .64 .68 .65 .62 .59 .55 .56
    //     after   lum 253 250 233 226 252 217 193 164 133 113  99  93  88
    //             sat .00 .05 .28 .38 .02 .51 .61 .63 .61 .59 .57 .54 .54
    //             u = 0  .25 .50 .75 1.0 1.25 1.5 1.75 2.0 2.25 2.5 2.75 3.0
    // Before: a monotone slide, 26 luma of variation across the whole body, and a
    // "white core" at saturation 0.11 — i.e. not white. After: a genuinely white core
    // (sat 0.00-0.05), a dimmer chromatic trough at u = 0.75 (226 / 0.38), and the rim
    // reading as a VALUE SPIKE back to 252 before the halo falls away. Two peaks and a
    // trough where there used to be a ramp. That is the "chroma well with a value
    // gradient" this comment claimed and did not have.
    //
    // Two knock-on adjustments, both forced and both worth writing down:
    //   - the core radius came DOWN (0.24 -> 0.18) as its emission went up. Bloom
    //     energy is area x emission, so 5.6-7.2 at the old radius made the avatar a
    //     3-world-unit ball of white at speed — the same failure, opposite direction.
    //   - the rim's speed term came down (s01 * 1.80 -> 1.40). At full speed the core's
    //     bloom already lands on the rim, and the two together took the rim to white,
    //     which would have eaten the perfect-window step below.
    const a = this.renderAngle;
    const ca = Math.cos(a), sa = Math.sin(a);
    const perp = this.inPerfectWindow ? 1 : 0;
    // THE AVATAR IS ALWAYS CYAN. There used to be an amber skin flip while the perfect
    // window was open, and it was a category error: amber is the ORB colour, so for
    // ~100ms the player object was constructed identically to, and coloured the same
    // as, the four collectibles sharing the frame with it. The cue below already
    // speaks amber for this exact event, so the flip was redundant confirmation spent
    // on the one object in the game whose colour identity is load-bearing. Measured,
    // it was hue-only — the luminance profiles of the two states were identical — so
    // it changed nothing but the weakest channel available.
    //
    // The perfect window is signalled on channels nothing else owns instead: a hard
    // VALUE step on the rim (brightness AND thickness, no ramp — it is a snap), and
    // the lance going white-hot. DESIGN.md assigns white-hot to "overdrive, impacts",
    // i.e. to instantaneous events, and a ~100ms window is one.
    const skin = PAL.cyanHot;

    // 1. WINGS. Heading must be readable in a single glance. Pushed OUT to ±1.02 and
    //    slimmed to 0.19 so they break the circular silhouette instead of hiding
    //    inside it, and kept well under the rim so they never become the brightest
    //    thing — direction is a secondary read, position is the primary one.
    const wingRot = a - HALF_PI;
    tint(CB, skin, (0.42 + s01 * 0.62) * (1 + perp * 0.5), 1);
    for (let k = -1; k <= 1; k += 2) {
      const ox = -sa * k * 1.02 - ca * 0.46;
      const oy =  ca * k * 1.02 - sa * 0.46;
      r.tri(LAYER.NEON, x + ox, y + oy, 0.19, 0.88, wingRot, CB,
        { glow: 0.55, glowRadius: 0.20, soft: 0.05 });
    }

    // 2. RIM. The silhouette. A thin ring at the collision-forgiving edge of the
    //    sprite, saturated cyan — the tonemap's max-channel normalisation is what lets
    //    this stay CYAN at emission 3.3 instead of washing to the same white as the
    //    core. Measured, the rim lands at 9.9 linear and the core at 21.6, and the
    //    tonemap's highlight knee starts at 9 — so the core bleaches and the rim does
    //    not. That is a VALUE difference now, not only a hue one.
    //
    //    The halo is 0.10, not 0.26. A 0.26 halo on a 0.12-thick ring is 2.2x the
    //    shape, and on a ring it does not spread outward, it spreads BOTH ways — so it
    //    flooded inward and filled the deliberately empty annulus between rim and core
    //    solid. Live profile of the finished avatar was 26 luma of variation across the
    //    entire body: the four-element structure existed in the source and nowhere on
    //    the screen. The outward half of that halo is bloom's job anyway.
    //
    //    perp is a STEP, not a ramp: +2.6 emission and +58% thickness, arriving in one
    //    frame. That is the replacement for the deleted amber flip, and unlike a hue
    //    change it survives being seen out of the corner of the eye.
    tint(CB, skin, 1.90 + s01 * 1.40 + perp * 2.60, 1);
    r.ring(LAYER.NEON, x, y, 1.00, 0.12 + perp * 0.07, CB,
      { glow: 1.2, glowRadius: 0.10, soft: 0.04 });

    // 3. CORE. 0.18 units against the old 0.52, with a 0.14 halo instead of 1.5. The
    //    only part of the avatar allowed to reach white, and it is ~3% of the body
    //    area. White at a point that small exists nowhere else in the world, so it is
    //    also the second channel of "this is you".
    //
    //    5.6-7.2, not 2.6-4.6, and the number is chosen against the tonemap's
    //    highlight knee rather than by eye. At 4.6 the core arrived at 13.8 linear —
    //    m = 21.8 after the post grade, barely onto the knee — so it was the same
    //    near-white as the rim and "core" was a hue difference only. At 5.6-7.2 it
    //    lands at 16.8-21.6 linear (m = 28-37, knee weight 0.33-0.58) and genuinely
    //    bleaches, while the rim at 9.9 linear (m = 14.9, weight 0.03) stays saturated
    //    cyan. That is a chroma well WITH a value gradient, which is what the profile
    //    above was supposed to show and did not.
    //    The RADIUS comes down with the emission going up, and it has to: bloom energy
    //    goes as area x emission, so raising 2.6-4.6 to 5.6-7.2 at the old 0.24/0.20
    //    turned the avatar into a 3-world-unit ball of white at speed — a different
    //    failure with the same cause. 0.18/0.14 puts the total energy back at ~0.8x of
    //    the old element while roughly doubling its PEAK, which is the whole point.
    tint(CA, PAL.white, 5.6 + s01 * 1.6, 1);
    r.circle(LAYER.NEON, x, y, 0.18, CA, { glow: 1.4, glowRadius: 0.14, soft: 0.03 });

    // 4. LANCE. A thin forward spike off the core, deliberately OUTSIDE the rim where
    //    there is empty frame to draw into. This is the directional read that survives
    //    at 60fps when the wings have motion-blurred into the silhouette. It is also
    //    the second half of the perfect-window step: white-hot and longer, for the
    //    ~100ms the window is open.
    tint(CB, PAL.white, (1.05 + s01 * 1.25) * (1 + perp * 1.30), 1);
    const lance = 1.52 + perp * 0.34;
    r.line(LAYER.NEON, x + ca * 1.02, y + sa * 1.02, x + ca * lance, y + sa * lance, 0.085, CB,
      { glow: 0.80, glowRadius: 0.14, soft: 0.04 });

    // ---- PREDICTIVE perfect-arc cue ---------------------------------------
    // A collapsing amber ring that starts P_ETA_LEAD seconds BEFORE the window opens
    // and lands on the body exactly as it does. `inPerfectWindow` above is only ever
    // confirmation — this is the part a human can actually act on, because it gives
    // back the ~250ms of reaction time the old instantaneous cue never had. The
    // collapse is the read: "let go when the ring touches you."
    //
    // TICKS, NOT A RING, and this is the part that had to change. The mechanic is
    // right; the drawing swallowed the thing it was pointing at. A continuous annulus
    // at glowRadius 1.0 against a 0.06-0.16 core is a 6-17x halo-to-shape ratio —
    // fx.js names exactly that ratio "the definition of a smudge" — and it measured as
    // a FLAT amber band from r=3.1 to r=5.1 world units, luminance plateau 196-215,
    // outer diameter 20-24% of the frame, firing about once a second. It was the
    // single largest object on screen and it enclosed the avatar in a solid disc of
    // the orb colour.
    //
    // Six radial ticks carry the same information — a radius, collapsing — while
    // occluding almost nothing: 6 x 0.1 units of arc instead of a full circumference,
    // halo 0.13 instead of 1.0, and the collapse radius capped at 1.15 + 2.6 rather
    // than 1.15 + 5.2. Measured on the frame where the cue lands (c = 0.9), the run
    // of luma > 200 through the avatar's own row went 13.2% -> 8.3% of frame width and
    // the lit extent 14.5% -> 10.5%, and the flat amber plateau that used to sit at
    // luma 217-222 all the way out to 3 world units now falls to 92 by u = 2.5.
    // The collapse also reads BETTER as separate marks: converging objects show
    // motion, whereas a shrinking circle mostly shows size.
    if (this.perfectCue > 0 && !perp) {
      const c = this.perfectCue;
      const rr = 1.15 + (1 - c) * 2.6;          // the collapsing radius itself
      // Long and thin, ~9:1. At 4:1 with round caps a tick draws as a lozenge, which
      // in this palette is an ORB — the last thing this cue may be mistaken for.
      const len = 0.45 + 0.95 * (1 - c);        // ticks shorten as they land
      // THE EXIT BEAT. During overdrive's final window the next arc is the exit arc,
      // and that was previously legible only from a 58px ring in the screen corner —
      // a peripheral read, demanded during the noisiest visual state in the game, for
      // a decision worth OVERDRIVE_REFUND. The HUD rim already beats at a 300ms period;
      // beating the avatar's own cue at the SAME period fuses the two into one signal,
      // so the ring the player is already staring at is what says "this one is the
      // exit". Frequency is the carrier, not colour: the cue is amber in both states,
      // and amber-on-amber would say nothing. A beat survives peripheral vision, and
      // it is the grammar the lasers already taught.
      const beat = this.odExit
        ? 0.72 + 0.28 * Math.sin(time * (TAU / 0.30))
        : 1;
      const th = (0.07 + 0.10 * c) * (this.odExit ? 1.55 : 1);
      tint(CC, PAL.amberHot, (0.50 + 1.80 * c * c) * (this.odExit ? 1.85 * beat : 1), 1);
      for (let k = 0; k < 6; k++) {
        const ta = k * (TAU / 6) + 0.26;
        const tc = Math.cos(ta), ts = Math.sin(ta);
        // Centred on rr, not starting at it: the collapse radius is what carries the
        // information, so the mark straddles it and the outer footprint stays capped.
        const i0 = rr - len * 0.5, i1 = rr + len * 0.5;
        r.line(LAYER.FOREGROUND, x + tc * i0, y + ts * i0,
          x + tc * i1, y + ts * i1, th, CC,
          { glow: 1.2 + c * 1.4, glowRadius: 0.13, soft: 0.05 });
      }
    }

    // Perfect-arc burst.
    if (this.perfectFlash > 0) {
      const f = clamp01(this.perfectFlash);
      tint(CC, PAL.white, 2.6 * f, 1);
      r.ring(LAYER.FOREGROUND, x, y, 1.2 + (1 - f) * 7.5, 0.22 * f + 0.05, CC,
        { glow: 2.4, glowRadius: 1.8, soft: 0.06 });
    }
  }
}

/** Wrap to (-PI, PI]. Local copy so the render angle can be damped without allocation. */
function _wrapPi(d) {
  d = d % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
