// ARCLIGHT — every tunable in one place. Nothing else should hardcode a magic number.
//
// World units are "metres". The camera shows roughly 46m of width in portrait.
// Gravity is 62 m/s² — heavier than Earth, because a real 9.8 feels like syrup at
// this scale and the whole game lives on the feeling of falling fast.

export const CFG = {
  // ---- view ---------------------------------------------------------------
  VIEW_WIDTH: 46,          // world units visible horizontally; drives zoom
  MAX_DPR: 2.0,
  CAMERA_FOLLOW: 7.0,      // damping rate, higher = stiffer
  CAMERA_LOOKAHEAD: 0.38,  // seconds of velocity to lead by
  CAMERA_LOOKAHEAD_MAX: 16,
  CAMERA_ROLL: 0.055,      // radians of roll per unit of normalised lateral velocity
  CAMERA_Y_BIAS: -3.5,     // sit the player slightly below centre

  // ---- physics ------------------------------------------------------------
  GRAVITY: 62,
  AIR_DRAG: 0.055,         // per second, applied to speed
  TERMINAL_SPEED: 120,
  PLAYER_RADIUS: 0.85,     // collision; deliberately smaller than the sprite
  MIN_SPEED: 9,            // gentle forward assist so a stalled player recovers

  // ---- tether -------------------------------------------------------------
  TETHER_MAX_RANGE: 26,
  TETHER_MIN_RANGE: 3.5,
  TETHER_FIRE_SPEED: 260,   // visual travel speed of the hook
  TETHER_REEL_RATE: 5.2,    // m/s the rope shortens while held — this is the "pump"
  TETHER_MIN_LENGTH: 4.5,
  TETHER_STIFFNESS: 1.0,    // 1 = hard positional constraint
  TETHER_DAMPING: 0.015,    // energy bled per constraint solve
  /** Anchor selection cone, radians, measured from the direction of travel. */
  TETHER_CONE: 1.65,
  TETHER_CONE_MIN_UP: 0.15, // prefer anchors above the player

  // ---- swing pump ---------------------------------------------------------
  // A bare position-based reel does NOT speed the player up — shortening the rope
  // lifts them against gravity for nothing (measured: 24.3 m/s vs 37.2 m/s with no
  // reel at all). "Hold longer = faster" is delivered by an explicit pump: tangential
  // acceleration scaled by rope verticality, i.e. a playground kick — strongest at the
  // bottom of the arc, zero at the extremes.
  TETHER_PUMP_ACCEL: 40,
  TETHER_PUMP_MAX_SPEED: 46,   // pump scales by 1 - |vt|/this, so it asymptotes
  TETHER_PUMP_ESCALATE: 2.5,   // stall escalator: forbids any stable low-energy state
  TETHER_PUMP_SEED: 0.5,       // forward kick out of a dead hang

  // Auto-hop. Pumping alone makes the player orbit one anchor forever and travel
  // nowhere. Once the rope bearing falls below this the forward arc is spent and
  // holding on would drag them backwards, so release and let the assist grab the next
  // anchor. Deliberately set OUTSIDE the perfect-arc window (0.61–1.31) so holding
  // travels but deliberate release still owns the skill ceiling — measured, at 0.70
  // the hold bot scored 21.5 perfect arcs/run and collapsed that distinction.
  TETHER_AUTO_HOP_PHI: 0.45,
  TETHER_AUTO_HOP_MIN_TIME: 0.15,
  TETHER_AUTO_HOP_LOCKOUT: 0.7,   // stops ping-ponging back to the anchor just left

  /** Caps swing rate, enforced as a speed-dependent minimum rope length (L >= v/w).
   *  Load-bearing: above ~4.2 the player whips round short anchors and loses ground. */
  TETHER_MAX_OMEGA: 3.2,
  TETHER_REEL_SPIN: 0.8,       // exponent on the (L_prev/L) angular-momentum term
  TETHER_W_RECENT: 2.5,
  SOLID_ESCAPE_SPEED: 9.0,

  // ---- perfect arc --------------------------------------------------------
  PERFECT_ANGLE_MIN: 0.26,  // 15°
  PERFECT_ANGLE_MAX: 0.96,  // 55°
  PERFECT_MIN_SPEED: 26,
  PERFECT_IMPULSE: 9,
  PERFECT_CHARGE: 0.14,

  // ---- grazing ------------------------------------------------------------
  GRAZE_RADIUS: 3.4,
  GRAZE_COOLDOWN: 0.9,      // per object
  GRAZE_CHARGE: 0.055,

  // ---- overdrive ----------------------------------------------------------
  OVERDRIVE_DURATION: 6.0,
  OVERDRIVE_TIMESCALE: 0.85,
  OVERDRIVE_SCORE_MULT: 2,
  OVERDRIVE_REFUND: 0.25,

  // ---- combo / score ------------------------------------------------------
  COMBO_WINDOW: 4.0,
  COMBO_PER_STEP: 3,
  COMBO_MAX_MULT: 10,
  SCORE_PERFECT: 250,
  SCORE_GRAZE: 40,
  SCORE_ORB: 100,
  SCORE_DIST_RATE: 0.1,

  // ---- spawn contract -----------------------------------------------------
  // The player ALWAYS starts here. World generation must guarantee, around this
  // point, that: (1) no solid or hazard intersects a circle of SPAWN_CLEAR_R,
  // (2) at least two anchors sit inside the tether's usable band, forward of the
  // player and ABOVE them, and (3) the first 3 seconds of ballistic fall are clear.
  // Violating any of these kills the player before they touch the screen.
  SPAWN_X: 20,
  SPAWN_Y: -14,
  SPAWN_CLEAR_R: 16,        // no solids/hazards may intersect this circle
  SPAWN_ANCHOR_MIN: 2,      // anchors required in the reachable band at spawn
  SPAWN_ANCHOR_DIST: 17,    // ideal distance to the first anchor
  SPAWN_CORRIDOR_AHEAD: 70, // clear ballistic corridor length from spawn

  // ---- flight-path clearance ----------------------------------------------
  // Solids must be cleared against the SAGGING BALLISTIC ARC between anchors, not
  // the straight chord — a swing dips well below the line joining two anchors.
  ARC_SAG: 12,              // world units the sampled arc dips below the chord
  ARC_SAMPLES: 9,

  // ---- world generation ---------------------------------------------------
  CHUNK_WIDTH: 60,
  CHUNKS_AHEAD: 5,
  CHUNKS_BEHIND: 2,
  FLOODLINE: 46,            // +Y is down; falling past this kills
  TUTORIAL_DIST: 400,

  // ---- collision forgiveness ----------------------------------------------
  // Measured from the surface TANGENT: a hit shallower than this deflects instead
  // of killing. Generous on purpose — skimming structure should read as skill.
  DEFLECT_ANGLE: 0.80,      // ~46°
  DEFLECT_RESTITUTION: 0.35,
  DEFLECT_SCRUB: 0.9,
  DEFLECT_COOLDOWN: 0.18,
  /** Below this distance solids never kill, only deflect. Protects the tutorial. */
  SOLID_SAFE_DIST: 400,

  // ---- feel ---------------------------------------------------------------
  HITSTOP_PERFECT: 0.045,
  HITSTOP_CRASH: 0.22,
  TRAUMA_PERFECT: 0.22,
  TRAUMA_GRAZE: 0.10,
  TRAUMA_CRASH: 1.0,
  TRAUMA_DECAY: 1.6,
  SHAKE_MAX: 2.4,           // world units at trauma == 1

  // ---- budget -------------------------------------------------------------
  MAX_PARTICLES: 900,
  MAX_INSTANCES: 4096,
  TRAIL_POINTS: 44,
};

/**
 * HDR palette. Values above 1.0 are what make something bloom — that is the only
 * brightness control in the renderer. Treat these as light emission, not paint.
 */
export const PAL = {
  void:      [0.012, 0.010, 0.035, 1],
  deep:      [0.035, 0.035, 0.105, 1],
  silhouette:[0.020, 0.022, 0.060, 1],
  silhouette2:[0.042, 0.040, 0.098, 1],

  cyan:      [0.13, 0.94, 1.00, 1],
  magenta:   [1.00, 0.18, 0.58, 1],
  violet:    [0.55, 0.36, 0.96, 1],
  amber:     [1.00, 0.69, 0.13, 1],
  lime:      [0.45, 1.00, 0.45, 1],
  hot:       [0.92, 1.00, 1.00, 1],

  // Pre-scaled emissive variants used constantly; avoids per-frame math.
  cyanHot:   [0.35, 2.60, 3.00, 1],
  magentaHot:[3.00, 0.45, 1.60, 1],
  violetHot: [1.55, 1.00, 2.80, 1],
  amberHot:  [3.00, 1.95, 0.35, 1],
  white:     [2.60, 2.90, 3.00, 1],
};

/** Multiply an HDR colour into a scratch array. Never allocates if `out` is given. */
export function tint(out, c, k, alpha = 1) {
  out[0] = c[0] * k; out[1] = c[1] * k; out[2] = c[2] * k; out[3] = alpha;
  return out;
}
