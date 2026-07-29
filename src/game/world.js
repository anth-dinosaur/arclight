// ARCLIGHT — game/world.js — the playable layer.
//
// Everything the player physically touches lives here: anchor nodes, hazards, orbs and
// the solid geometry that forms the *near* band of the city (gantries, pylons,
// catwalks, suspended platforms, cable spans). The backdrop module owns everything
// behind this; we own everything that can kill you, carry you, or score you.
//
// ---------------------------------------------------------------------------------
// ARCHITECTURE
// ---------------------------------------------------------------------------------
// The world is streamed in fixed `CFG.CHUNK_WIDTH` chunks, `CFG.CHUNKS_AHEAD` ahead
// and `CFG.CHUNKS_BEHIND` behind the player. Every entity is drawn from a fixed-size
// `Pool` and tagged with the chunk index that spawned it; despawning is a backwards
// sweep that frees anything outside the window. Nothing is allocated after the
// constructor — not in `update`, not in `render`, not in chunk generation.
//
// DETERMINISM
// Chunk `ci` is generated purely from `(seed ^ ci)`. It never reads state left behind
// by chunk `ci-1`. Continuity across the boundary is achieved with *gate anchors*:
// `gateY(ci)` is a pure, band-limited function of `ci`, and every chunk both
//   (a) begins its anchor chain at the gate `(ci*W, gateY(ci))`, and
//   (b) is required to end within ballistic reach of `((ci+1)*W, gateY(ci+1))`.
// Two chunks generated in any order therefore always join up, and regenerating the
// same index twice produces byte-identical output.
//
// REACHABILITY (hard invariant)
// `canReach(from, to, assumedSpeed)` samples the ballistic arcs a player could leave
// `from` on (a fan of release angles spanning the perfect-arc window) and returns true
// if any of them passes within `CFG.TETHER_MAX_RANGE * REACH_FRAC` of `to` before the
// arc sinks past the floodline. Every anchor is committed through `_placeAnchor`,
// which *repairs* an unreachable candidate — first by snapping it onto the arc, then
// by binary-searching the farthest reachable X. It is therefore impossible for this
// generator to emit an unwinnable gap; `this.reachFailures` is a tripwire that should
// always read 0.
//
// The check speed is deliberately conservative (`SPEED_CHECK_*`, well below the speed
// a competent player actually carries) so that the invariant holds for a slow player,
// not just an optimal one.

import { CFG, PAL, tint } from '../core/config.js';
import { LAYER } from '../core/renderer.js';
import {
  clamp, clamp01, lerp, TAU, circleVsOBB, Pool,
} from '../core/math.js';

// ---------------------------------------------------------------------------------
// Tunables. Everything reads from CFG with a local `?? fallback` so the game runs
// against today's config.js; the fallbacks are the values this module was authored
// against and are all listed in the module report.
// ---------------------------------------------------------------------------------

const CHUNK_W      = CFG.CHUNK_WIDTH;
const AHEAD        = CFG.CHUNKS_AHEAD;
const BEHIND       = CFG.CHUNKS_BEHIND;
const FLOODLINE    = CFG.FLOODLINE;
const GRAV         = CFG.GRAVITY;
const HALF_GRAV    = GRAV * 0.5;

// Vertical play band. +Y is down; the floodline at +46 kills.
//
// The band is deliberately biased HIGH. A tether can only usefully grab something
// above you, and a swing sags ~12-18m below the line joining two anchors, so the
// anchor field has to be the *ceiling* of the corridor with the player flying beneath
// it. An anchor field centred on the player's altitude is unplayable — half the nodes
// are underneath them where the targeting cone can never see them.
const Y_MIN        = CFG.WORLD_Y_MIN ?? -54;
const Y_MAX        = CFG.WORLD_Y_MAX ?? 15;
// Gate altitude band (the chunk-boundary anchors). Narrower than the play band so
// archetypes have room to swing above and below it.
const GATE_MID     = CFG.WORLD_GATE_MID ?? -16;
const GATE_AMP     = CFG.WORLD_GATE_AMP ?? 17;

// ---- spawn contract (CFG-owned, see config.js) ----------------------------------
const SPAWN_X      = CFG.SPAWN_X ?? 20;
const SPAWN_Y      = CFG.SPAWN_Y ?? -14;
const SPAWN_CLEAR_R = CFG.SPAWN_CLEAR_R ?? 16;
const SPAWN_ANCHOR_MIN = CFG.SPAWN_ANCHOR_MIN ?? 2;
const SPAWN_ANCHOR_DIST = CFG.SPAWN_ANCHOR_DIST ?? 17;
const SPAWN_CORRIDOR = CFG.SPAWN_CORRIDOR_AHEAD ?? 70;
const SPAWN_CHUNK   = Math.floor(SPAWN_X / CHUNK_W);
const SPAWN_CORR_R  = CFG.WORLD_SPAWN_CORRIDOR_R ?? 7.5;
/** Plausible horizontal speeds out of the spawn; the union of their fall parabolas is
 *  the corridor that must stay clear of structure. */
const SPAWN_VX = new Float64Array([14, 26, 38]);

// ---- flight-path clearance (CFG-owned) ------------------------------------------
// A swing does not follow the chord between two anchors, it follows a parabola that
// sags below it. How far depends entirely on when the player released, so structure is
// cleared against a *band* of sags, not a single curve.
const ARC_SAG      = CFG.ARC_SAG ?? 12;
const ARC_SAMPLES  = CFG.ARC_SAMPLES ?? 9;
// The GUARANTEED-CLEAR inner envelope. Negative entries are the RISE band: a late
// release, or a whip round a long rope, carries the player above the line joining two
// anchors, so the overhead gantries have to be cleared too — not just the floor.
//
// This used to span the whole uncertainty envelope (-1.85..+1.55 of ARC_SAG, roughly
// ±20u after the line-clearance radius) and therefore evacuated every solid from every
// flight path in the game: measured ZERO deflects across 90 runs. Now only the inner
// envelope is protected, so the nominal line is still guaranteed clear but the extremes
// of a badly-timed release meet architecture. See CFG.ARC_SAG_BAND for the full
// argument; the multipliers live there because config.js owns every magic number.
const SAG_BAND = Float64Array.from(
  CFG.ARC_SAG_BAND ?? [-0.85, -0.45, -0.15, 0.30, 0.65, 0.95],
  (m) => m * ARC_SAG);
// The FULL uncertainty envelope. Structure that presents a HARD FACE — a pylon, a
// shaft wall, a support column — is still evacuated from all of it, because a face hit
// square kills and a column can only ever be hit square. Only the flat DECKS
// (catwalks, gantry floors) are allowed into the outer envelope: their exposed faces
// run along the direction of travel, so contact there is a skim, which is a deflect,
// which is the "skimming structure reads as skill" the forgiveness machinery exists
// for. Measured: allowing everything in produced 5 solid deaths and STILL zero
// deflects — every contact was square. This split is what makes architecture a
// texture you brush against rather than a new way to die.
const SAG_BAND_FULL = Float64Array.from(
  CFG.ARC_SAG_BAND_FULL ?? [-1.85, -1.3, -0.75, -0.3, 0.4, 0.8, 1.15, 1.55],
  (m) => m * ARC_SAG);

// ---- catch row ------------------------------------------------------------------
// A secondary row of anchors slung below the main chain. They are never load-bearing —
// the reachability invariant ignores them entirely — they exist so that a player who
// has sunk out of the corridor still has something overhead to grab instead of riding
// the fall all the way to the floodline. This is what makes a bad release recoverable.
// The row alternates between two depths, so it reads as a zigzag ladder rather than a
// second floor: a player only a little low takes the shallow rung, one who has really
// dropped can still reach the deep rung. Combined with TETHER_MAX_RANGE that extends
// the recoverable envelope to roughly 60m below the chain.
// 15, not 24. The catch row exists to make a bad release recoverable, and it had a
// hole exactly where it was needed most: probing the `metronome` bot (a player who
// releases on a rhythm without looking — the tier closest to a real human still
// learning), at the instant of a FLOODLINE death the nearest anchor ABOVE averaged
// 31.9 units against a 26-unit tether, and there was nothing in reach for 60% of the
// final sink. The net had gaps wider than the rope. At 15 an anchor is in range for
// 70% of the sink, drownings fall 22 -> 18 per 60 runs, and the mid tier gains 35m of
// median distance. It costs the top tier nothing — a player who does not sag never
// meets these — so it widens the skill gradient rather than flattening it (measured
// smart/hold score 9.9x -> 13.2x over 60 seeds). Anchor budget stays at 6.5 of 14 per
// chunk with zero pool misses.
const CATCH_SPACING = CFG.WORLD_CATCH_SPACING ?? 15;
const CATCH_DROP    = CFG.WORLD_CATCH_DROP ?? 20;
const CATCH_DROP2   = CFG.WORLD_CATCH_DROP2 ?? 14;
const CATCH_P       = CFG.WORLD_CATCH_P ?? 0.92;
const CATCH_Y_MAX   = CFG.WORLD_CATCH_Y_MAX ?? (FLOODLINE - 13);

// ---- floodline alarm ------------------------------------------------------------
// See `_renderFloodline`. The rate sweeps from HZ0 at the top of FLOOD_WARN_BAND to
// HZ1 at the water; an accelerating beat reads as "closing" in peripheral vision,
// which a brightness ramp does not.
const FLOOD_HZ = CFG.FLOOD_WARN_HZ ?? [1.1, 5.0];
const FLOOD_HZ0 = FLOOD_HZ[0];
const FLOOD_HZ1 = FLOOD_HZ[1];

// Difficulty curve. `diff` is asymptotic: 1 - e^-((x - TUT) / SCALE).
// Both numbers are tuned in config.js against measured distance-vs-time curves for all
// three bots — see the block comment there. The short version: at SCALE 2200 the curve
// only reached diff 0.36 by the end of a median run, so most of it was never played.
const TUT_DIST     = CFG.TUTORIAL_DIST;
const DIFF_SCALE   = CFG.WORLD_DIFF_SCALE ?? 900;

// Anchor spacing. SPACING_MAX is the hard density floor from DESIGN.md — no matter
// how far you run, anchors never get sparser than this.
const SPACING_TUT  = CFG.WORLD_SPACING_TUT ?? 11;
const SPACING_MIN  = CFG.WORLD_SPACING_MIN ?? 13;
const SPACING_MAX  = CFG.WORLD_SPACING_MAX ?? 31;
const MIN_GAP      = CFG.WORLD_MIN_GAP ?? 8;      // never place two anchors closer than this in X

// Asymmetric traversal budget. Gravity is 62 m/s², so a ballistic arc only *rises*
// about 4m before it starts falling: climbing is bought entirely with tether reach and
// costs roughly 2 metres of forward travel per metre gained, while falling is free.
// Every anchor is therefore constrained to stay inside a wedge that funnels the chain
// onto the exit gate — without this the chain sinks to the band floor and strands.
const CLIMB_RATE   = CFG.WORLD_CLIMB_RATE ?? 0.50;  // max metres you may sit *below* the gate, per metre of X remaining
const FALL_RATE    = CFG.WORLD_FALL_RATE ?? 1.00;   // ...and above it
const WEDGE_SLACK  = CFG.WORLD_WEDGE_SLACK ?? 2.5;

// Ballistic model used for reachability.
const REACH_FRAC   = CFG.WORLD_REACH_FRAC ?? 0.85;
const REACH        = CFG.TETHER_MAX_RANGE * REACH_FRAC;
const REACH2       = REACH * REACH;
const REL_R        = CFG.WORLD_RELEASE_R ?? 8.5;  // rope length at the moment of release
const REL_ANG      = CFG.WORLD_RELEASE_ANG ?? 0.75; // release point sits ahead-and-below the anchor
const REL_DX       = REL_R * Math.cos(REL_ANG);
const REL_DY       = REL_R * Math.sin(REL_ANG);
const ARC_STEPS    = CFG.WORLD_ARC_STEPS ?? 40;
const ARC_DT       = CFG.WORLD_ARC_DT ?? 0.045;
const ARC_T_MAX    = ARC_STEPS * ARC_DT;
// Speed the generator *assumes* the player carries out of an anchor. Conservative.
const SPEED_CHECK_MIN = CFG.WORLD_SPEED_MIN ?? 27;
const SPEED_CHECK_MAX = CFG.WORLD_SPEED_MAX ?? 37;
// Release angles sampled by canReach. Negative = up-and-forward (+Y is down).
// Spans the perfect-arc window (0.26–0.96 rad) plus a flat and a slightly-down line.
const LAUNCH_ANGLES = new Float64Array([-0.96, -0.72, -0.50, -0.28, -0.06, 0.16]);
const NOMINAL_ANGLE_I = 2; // -0.50 rad, dead centre of the power window — used for orb arcs

// Hazards.
const HAZ_MAX      = CFG.WORLD_HAZ_MAX ?? 3.4;    // asymptotic hazards per chunk
const HAZ_POW      = CFG.WORLD_HAZ_POW ?? 1.25;   // shapes the early ramp (>1 = gentler start)
/** Hazards keep this far from any anchor. Was 6.5, which — together with the off-lane
 *  push in _placeGenericHazard — evacuated the entire reachable corridor of anything
 *  grazable: only 0.9% of frames were ever within GRAZE_RADIUS of a live hazard. The
 *  graze band cannot find geometry in airspace the generator has cleared of geometry. */
const HAZ_CLEAR    = CFG.WORLD_HAZ_CLEAR ?? 5.0;
/** Beams get extra room: you swing a full rope-length around an anchor, so a beam that
 *  merely misses the node still sweeps the arc you are riding on it. */
const HAZ_CLEAR_LASER = CFG.WORLD_HAZ_CLEAR_LASER ?? 7.5;
/** Minimum X separation between hazards. Threats need to arrive as separate beats — a
 *  cluster with no gap to react in is noise, not difficulty. The gap closes with
 *  difficulty: that tightening *is* the late-game ramp, rather than a fixed spacing
 *  that would silently cap density and flatten the curve.
 *
 *  These are METRES but the thing they are really rationing is SECONDS. At the 25/10
 *  they were, threat arrival scaled inversely with speed, so flying well made the
 *  game arrive 3x faster per second survived while halving the reaction window —
 *  skill was strictly anti-correlated with survival. 34/18 restores roughly constant
 *  arrival time at cruise, which is what makes going fast a choice rather than a tax. */
const HAZ_SEP_EARLY = CFG.WORLD_HAZ_SEP_EARLY ?? 34;
const HAZ_SEP_LATE  = CFG.WORLD_HAZ_SEP_LATE ?? 18;
// World distance before each kind unlocks; tuned in config.js against the difficulty
// curve. Each is a separate beat in the run — a new verb arriving, not a density bump.
const HAZ_DRONE_X  = CFG.WORLD_HAZ_DRONE_X ?? 480;   // world units before drones appear
const HAZ_SPIN_X   = CFG.WORLD_HAZ_SPIN_X ?? 850;    // ... spinners
const HAZ_GATE_X   = CFG.WORLD_HAZ_GATE_X ?? 1150;   // ... moving gates
// Laser duty cycle. The period and the lethal fraction are both eased by difficulty:
// the first beams a player ever meets are off for ~2.4s at a time, the late ones for
// ~1.4s. A beam you cannot wait out is not a hazard, it is a wall.
const LASER_PERIOD = CFG.WORLD_LASER_PERIOD ?? 2.6;
const LASER_PERIOD_EARLY = CFG.WORLD_LASER_PERIOD_EARLY ?? 3.3;
const LASER_ON     = CFG.WORLD_LASER_ON ?? 0.46;  // fraction of the cycle the beam is lethal
const LASER_ON_EARLY = CFG.WORLD_LASER_ON_EARLY ?? 0.26;
const LASER_TELL   = CFG.WORLD_LASER_TELL ?? 0.4; // seconds of charge-up telegraph
// The authored first hazard — see CFG. `FIRST_HAZ_CHUNK` is the first chunk that is not
// tutorial, so this beat always lands the moment the grace period ends, on every seed.
const FIRST_LASER_PERIOD = CFG.WORLD_FIRST_LASER_PERIOD ?? 3.6;
const FIRST_LASER_ON = CFG.WORLD_FIRST_LASER_ON ?? 0.22;
const FIRST_LASER_HW = CFG.WORLD_FIRST_LASER_HW ?? 8;
const FIRST_HAZ_X  = CFG.WORLD_FIRST_HAZ_X ?? 480;
const FIRST_HAZ_CHUNK = Math.ceil(FIRST_HAZ_X / CHUNK_W);
/**
 * DRONE DUTY CYCLE. Drones were 53% of all deaths (31 of 59) and the only hazard in
 * the game with no timing-out: lasers are lethal 26-46% of a cycle behind a 0.4s
 * tell, spinners have gaps, gates have a gap. A drone was a pure POSITION threat with
 * no telegraph, sweeping a corridor a committed half-swing (~0.98s) cannot leave.
 * Giving it the laser's machinery converts it into a timing threat: a swing you have
 * already committed to can now survive one by arriving while it is dormant.
 * 65% of a 2.2s period leaves a 0.77s window, comfortably above the 0.4s tell.
 */
const DRONE_PERIOD = CFG.WORLD_DRONE_PERIOD ?? 2.2;
/** Lethal fraction of the cycle, eased by difficulty exactly as the laser's is.
 *  It used to be a single flat 0.65: a drone met at 480 units was every bit as lethal
 *  as one met at 4800, which is a FLAT SPOT in a curve that is supposed to curve — and
 *  drones are the first kind to unlock, so the flat spot sat right where the player is
 *  meeting their first real threat. 0.40 early leaves a 1.3s dormant window behind a
 *  0.45s tell; 0.70 late leaves 0.66s and demands you read it. */
const DRONE_ON_EARLY = CFG.WORLD_DRONE_ON_EARLY ?? 0.40;
const DRONE_ON     = CFG.WORLD_DRONE_ON ?? 0.70;
const DRONE_TELL   = CFG.WORLD_DRONE_TELL ?? 0.45; // seconds of spool-up telegraph
/** Patrol speed. 6.0 made the sweep faster than a player could read across a corridor
 *  they were already committed to; 4.0 keeps the pocket legible. */
const DRONE_SPEED  = CFG.WORLD_DRONE_SPEED ?? 4.0;
const SPINNER_RATE = CFG.WORLD_SPINNER_RATE ?? 1.5;
const GATE_RATE    = CFG.WORLD_GATE_RATE ?? 0.55;
const GATE_GAP     = CFG.WORLD_GATE_GAP ?? 11;

// Orbs.
const ORB_R        = CFG.WORLD_ORB_R ?? 0.85;
const ORB_MIN      = CFG.WORLD_ORB_MIN ?? 3;
const ORB_MAX      = CFG.WORLD_ORB_MAX ?? 9;
const ORB_ARC_N    = CFG.WORLD_ORB_ARC_N ?? 11;
const ORB_BOB      = CFG.WORLD_ORB_BOB ?? 0.45;
const ORB_BOB_RATE = CFG.WORLD_ORB_BOB_RATE ?? 2.1;

// Anchors.
const A_R          = CFG.WORLD_ANCHOR_R ?? 1.55;
const A_R_HEAVY    = CFG.WORLD_ANCHOR_R_HEAVY ?? 2.45;
const A_R_DECAY    = CFG.WORLD_ANCHOR_R_DECAY ?? 1.3;
const DECAY_TIME   = CFG.WORLD_DECAY_TIME ?? 1.2;
const DECAY_RECHARGE = CFG.WORLD_DECAY_RECHARGE ?? 2.6;
const DECAY_DOTS   = CFG.WORLD_DECAY_DOTS ?? 6;

// Solids.
const SOLID_CLEAR  = CFG.WORLD_SOLID_CLEAR ?? 5.5;   // keep structure off the anchors
const SOLID_LINE_CLEAR = CFG.WORLD_SOLID_LINE_CLEAR ?? 3.6; // ...and off the sagging flight band
const SOLID_TUT_MUL = CFG.WORLD_SOLID_TUT_MUL ?? 1.7;  // extra margin below TUTORIAL_DIST
const SUPPORT_P    = CFG.WORLD_SUPPORT_P ?? 0.72;
/** Structure hung *below* the chain must clear the catch row AND the catch row's own
 *  sag — everything from the chain down to there is live airspace. In practice this
 *  pushes almost all near-layer structure above the chain, which is also the better
 *  read: a black ceiling of gantries with the drowned city far below. */
const UNDER_DROP   = CFG.WORLD_UNDER_DROP ??
  (CATCH_DROP + CATCH_DROP2 + ARC_SAG * 1.55 + SOLID_LINE_CLEAR + 3);

// Skim decks — see CFG. Flat gantry decks authored into the band between the
// guaranteed-clear inner envelope and the outer edge of the release-timing envelope.
const SKIM_MAX     = CFG.SKIM_DECK_MAX ?? 2.2;
const SKIM_NEAR    = (CFG.SKIM_DECK_NEAR ?? 1.22) * ARC_SAG;
const SKIM_FAR     = (CFG.SKIM_DECK_FAR ?? 1.62) * ARC_SAG;
const SKIM_HW      = CFG.SKIM_DECK_HW ?? [5, 11];
const SKIM_HH      = CFG.SKIM_DECK_HH ?? [0.5, 1.0];
const SKIM_LC      = CFG.SKIM_DECK_LINE_CLEAR ?? 2.0;

// Budget / pools.
const PRIM_BUDGET  = CFG.WORLD_PRIM_BUDGET ?? 700;
const CULL_PAD     = CFG.WORLD_CULL_PAD ?? 1.0;   // × viewW on each side
const MAX_ANCHORS  = CFG.WORLD_MAX_ANCHORS ?? 176;
const MAX_HAZARDS  = CFG.WORLD_MAX_HAZARDS ?? 112;
const MAX_ORBS     = CFG.WORLD_MAX_ORBS ?? 224;
const MAX_SOLIDS   = CFG.WORLD_MAX_SOLIDS ?? 208;
const PER_CHUNK_A  = CFG.WORLD_PER_CHUNK_ANCHORS ?? 14;
const PER_CHUNK_H  = CFG.WORLD_PER_CHUNK_HAZARDS ?? 7;
const PER_CHUNK_O  = CFG.WORLD_PER_CHUNK_ORBS ?? 16;
const PER_CHUNK_S  = CFG.WORLD_PER_CHUNK_SOLIDS ?? 15;
const CHUNKS_PER_FRAME = CFG.WORLD_CHUNKS_PER_FRAME ?? 3;
const MAX_LOADED   = AHEAD + BEHIND + 3;

// Animation rates.
const A_PULSE      = CFG.WORLD_ANCHOR_PULSE ?? 1.9;
const A_TICK       = CFG.WORLD_ANCHOR_TICK ?? 0.85;

// ---------------------------------------------------------------------------------
// Archetypes. Hand-authored rhythms; the generator never falls back to pure noise.
// ---------------------------------------------------------------------------------
const AR_OPEN_SPAN = 0;  // one distant anchor — rewards a committed, flat flight
const AR_STAIR_UP  = 1;  // quantised climb then a ramp back to the gate
const AR_STAIR_DN  = 2;  // quantised descent
const AR_GAUNTLET  = 3;  // tight anchors threaded between staggered laser gates
const AR_PENDULUM  = 4;  // evenly spaced, level anchors — a metronome
const AR_ORB_ARC   = 5;  // orbs laid on the exact ideal ballistic line (teaching tool)
const AR_SPINNER   = 6;  // an open court with rotating bars and heavy anchors
const AR_DESCENT   = 7;  // a drop through a flanked shaft
const AR_COUNT     = 8;
// Not part of the weighted set — forced on the chunk containing the spawn point.
const AR_LAUNCH    = 8;

/**
 * The authored opening ladder, relative to (SPAWN_X, SPAWN_Y). These four nodes are
 * the spawn contract: all forward of the player, all above them, all inside
 * [TETHER_MIN_RANGE, TETHER_MAX_RANGE], so the very first tap always connects.
 *
 * They used to be exactly these numbers on every seed, which made the first two swings
 * of every session — the only part of the run a new player is looking at properly —
 * byte-identical forever. `_archLaunch` now jitters them per seed and then RE-IMPOSES
 * the contract on the result rather than trusting the jitter, so the opening varies
 * without the guarantee ever depending on luck.
 */
const LAUNCH_DX = new Float64Array([4, 11, 18, 25]);
const LAUNCH_DY = new Float64Array([-16, -11, -15, -10]);
const LAUNCH_JX = CFG.WORLD_LAUNCH_JITTER_X ?? 3.0;
const LAUNCH_JY = CFG.WORLD_LAUNCH_JITTER_Y ?? 4.5;
/** Hard bounds the jittered ladder is clamped back into. Below the tether's max range
 *  with margin, above its min, and always at least this far overhead. */
const LAUNCH_R_MIN = CFG.TETHER_MIN_RANGE + 6;
const LAUNCH_R_MAX = CFG.TETHER_MAX_RANGE - 4;
const LAUNCH_UP_MIN = CFG.WORLD_LAUNCH_UP_MIN ?? 7;

// Per-archetype weight scratch, filled each selection. Module scope = never allocated.
const ARCH_W = new Float64Array(AR_COUNT);

// Per-chunk anchor scratch (positions + object refs) used by the hazard/orb/solid
// passes and by the reachability self-check.
const CA_X = new Float64Array(PER_CHUNK_A + 4);
const CA_Y = new Float64Array(PER_CHUNK_A + 4);
const CA_K = new Int32Array(PER_CHUNK_A + 4);
const CA_REF = new Array(PER_CHUNK_A + 4);
for (let i = 0; i < CA_REF.length; i++) CA_REF[i] = null;

// Bridge candidate offsets, scanned when stitching a chunk to the next gate.
const BRIDGE_DX = new Float64Array([27, 23, 19, 15, 11]);
const BRIDGE_DY = new Float64Array([-15, -9, -4, 1, 6, 12]);

// Scratch colour registers. Every draw call writes through one of these via `tint`.
const SC0 = [0, 0, 0, 1];
const SC1 = [0, 0, 0, 1];
const SC2 = [0, 0, 0, 1];
const SC3 = [0, 0, 0, 1];
const SC4 = [0, 0, 0, 1];

// ---------------------------------------------------------------------------------
// Pure hashing. Allocation-free (unlike `noise1`, which builds a closure per call).
// ---------------------------------------------------------------------------------

/** Integer avalanche hash → [0,1). */
function hash1(n) {
  let t = Math.imul((n | 0) ^ 0x2545f491, 0x27d4eb2d);
  t ^= t >>> 15;
  t = Math.imul(t, 0x85ebca6b);
  t ^= t >>> 13;
  return (t >>> 0) / 4294967296;
}
function hash2(a, b) {
  return hash1((Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) | 0);
}
/** C1-continuous value noise over an integer lattice. */
function smoothHash(x, s) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash2(i, s), hash2(i + 1, s), u);
}

// ---------------------------------------------------------------------------------
// Difficulty. Distance-driven, continuous, asymptotic — see DESIGN.md.
// All distances are WORLD UNITS; the HUD's metre counter reads world units / 2.
//   0–340   diff 0.00   tutorial: dense anchors, zero hazards, walls only bounce
//   600     diff 0.25
//   800     diff 0.40
//   1200    diff 0.62
//   1800    diff 0.79   (roughly where a good run ends — the curve is now mostly PLAYED)
//   3000    diff 0.94
//   6000    diff 1.00-  (never reaches 1 — the asymptote is the promise)
// The old shape put diff at only 0.36 where a median run ended, so two thirds of the
// authored range was unreachable. See config.js for the calibration.
// ---------------------------------------------------------------------------------
function difficultyAt(x) {
  if (x <= TUT_DIST) return 0;
  return 1 - Math.exp(-(x - TUT_DIST) / DIFF_SCALE);
}

/** Deterministic altitude of the chunk-boundary anchor. Band-limited: consecutive
 *  gates never differ by more than ~17m, so a chunk always has room to converge.
 *  The two gates bracketing the spawn are pinned so the opening is identical on every
 *  seed — the spawn contract cannot be left to chance. */
function gateY(ci, seed) {
  if (ci === SPAWN_CHUNK) return SPAWN_Y - 8;
  if (ci === SPAWN_CHUNK + 1) return SPAWN_Y - 6;
  const a = smoothHash(ci * 0.34, seed ^ 0x51ed) * 2 - 1;
  const b = smoothHash(ci * 0.11, seed ^ 0x9d2b) * 2 - 1;
  return clamp(GATE_MID + GATE_AMP * (a * 0.65 + b * 0.35), Y_MIN + 6, Y_MAX - 6);
}

/** Raw (pre-de-duplication) archetype pick for a chunk. Pure in `ci`. */
function rawArchetype(ci, seed) {
  const x0 = ci * CHUNK_W;
  const d = difficultyAt(x0);
  const tut = x0 < TUT_DIST;

  // Weights ramp with difficulty. In the tutorial only the gentle, teaching shapes
  // are legal, so the player's opening is dense anchors and clean rhythms.
  ARCH_W[AR_OPEN_SPAN] = tut ? 0 : 0.15 + 0.95 * d;
  ARCH_W[AR_STAIR_UP]  = 1.05 - 0.45 * d;
  ARCH_W[AR_STAIR_DN]  = 0.90 - 0.30 * d;
  ARCH_W[AR_GAUNTLET]  = tut ? 0 : d * d * 1.6;
  ARCH_W[AR_PENDULUM]  = 1.30 - 0.55 * d;
  ARCH_W[AR_ORB_ARC]   = tut ? 1.6 : 0.95 - 0.45 * d;
  ARCH_W[AR_SPINNER]   = tut ? 0 : Math.max(0, d - 0.22) * 1.8;
  ARCH_W[AR_DESCENT]   = tut ? 0.35 : 0.25 + 0.85 * d;

  let total = 0;
  for (let i = 0; i < AR_COUNT; i++) total += ARCH_W[i];
  let pick = hash2(ci, seed ^ 0x7f4a) * total;
  for (let i = 0; i < AR_COUNT; i++) {
    pick -= ARCH_W[i];
    if (pick <= 0) return i;
  }
  return AR_PENDULUM;
}

/**
 * Final archetype, with lookback so the same shape never appears twice in a row.
 * The lookback is a *bounded* recursion (depth `ARCH_LOOKBACK`), which keeps the
 * function pure in `ci` — a memo would break regeneration determinism. The recursion
 * only ever deepens when consecutive raw picks collide, so the cost is ~9 hash lookups
 * and the chance of the depth cap biting is (1/5)^8 ≈ 3e-6 per chunk.
 */
const ARCH_LOOKBACK = CFG.WORLD_ARCH_LOOKBACK ?? 8;
function archAt(ci, seed, depth) {
  const a = rawArchetype(ci, seed);
  if (depth <= 0) return a;
  const p = archAt(ci - 1, seed, depth - 1);   // clobbers ARCH_W
  if (a !== p) return a;
  rawArchetype(ci, seed);                      // refill ARCH_W for *this* chunk
  for (let k = 1; k < AR_COUNT; k++) {
    const b = (a + k) % AR_COUNT;
    if (b !== p && ARCH_W[b] > 0.001) return b;
  }
  return a;
}
function archetypeFor(ci, seed) {
  return archAt(ci, seed, ARCH_LOOKBACK);
}

// =================================================================================
export class World {
  constructor(seed = 1) {
    // ---- entity pools ---------------------------------------------------------
    // Extra non-contract fields carried on the pooled objects (all internal, all
    // documented in the module report): `chunk` (owning chunk index, for streaming),
    // `hx/hy` (home position for movers/bobbers), `amp/rate/sgn` (motion params),
    // `decayT` (decaying-anchor timer), `nx/ny/hasNext` (cable-span link).
    // `_grazeCd` is owned and decremented by the player's graze band; it lives on the
    // pooled object so the hidden class never changes mid-run.
    this._pAnchor = new Pool(MAX_ANCHORS, () => ({
      x: 0, y: 0, r: A_R, alive: false, kind: 0, phase: 0, used: false,
      chunk: 0, decayT: 0, nx: 0, ny: 0, hasNext: false, isCatch: false, _grazeCd: 0,
    }));
    // `per`/`duty`/`dphase` are the drone's lethality cycle — see _animate case 1.
    this._pHazard = new Pool(MAX_HAZARDS, () => ({
      x: 0, y: 0, hw: 1, hh: 1, rot: 0, kind: 0, alive: false, phase: 0, vx: 0, vy: 0,
      chunk: 0, hx: 0, hy: 0, amp: 0, rate: 0, sgn: 1, tell: 0,
      per: 0, duty: 0, dphase: 0, _grazeCd: 0,
    }));
    this._pOrb = new Pool(MAX_ORBS, () => ({
      x: 0, y: 0, r: ORB_R, alive: false, phase: 0, collected: false,
      chunk: 0, hy: 0,
    }));
    // `_grazeCd` is the player's graze band; `_deflectCd` is the deflect event's own
    // rate limit. These MUST be separate fields: sharing one meant the graze write
    // (0.9s) always landed before the deflect read, because anything you touch you
    // grazed on the way in — which suppressed the `deflect` event 100% of the time.
    this._pSolid = new Pool(MAX_SOLIDS, () => ({
      x: 0, y: 0, hw: 1, hh: 1, rot: 0,
      chunk: 0, style: 0, sign: 0, _grazeCd: 0, _deflectCd: 0,
    }));

    // ---- exported views -------------------------------------------------------
    // The contract's getters must return lists whose `length` is the active count
    // (`Solid` has no `alive` flag, so consumers cannot filter). These arrays are
    // built once at full capacity and only ever re-indexed + length-trimmed, which
    // keeps the backing store alive. Rebuilt on chunk churn only, not per frame.
    this._vAnchor = new Array(MAX_ANCHORS);
    this._vHazard = new Array(MAX_HAZARDS);
    this._vOrb = new Array(MAX_ORBS);
    this._vSolid = new Array(MAX_SOLIDS);
    for (let i = 0; i < MAX_ANCHORS; i++) this._vAnchor[i] = this._pAnchor.items[i];
    for (let i = 0; i < MAX_HAZARDS; i++) this._vHazard[i] = this._pHazard.items[i];
    for (let i = 0; i < MAX_ORBS; i++) this._vOrb[i] = this._pOrb.items[i];
    for (let i = 0; i < MAX_SOLIDS; i++) this._vSolid[i] = this._pSolid.items[i];

    // ---- streaming bookkeeping -----------------------------------------------
    this._loaded = new Int32Array(MAX_LOADED);
    this._loadedN = 0;

    // ---- generation cursor ----------------------------------------------------
    this._lx = 0; this._ly = 0;   // last committed anchor of the chain being built
    this._chunkN = 0;             // all anchors emitted by the chunk in progress
    this._chainN = 0;             // ...of which this many form the load-bearing chain
    this._gx1 = 0; this._gy1 = 0; // this chunk's exit gate (the wedge target)
    this._diff = 0;               // difficulty of the chunk in progress
    this._chunkH = 0;
    this._chunkO = 0;
    this._chunkS = 0;
    this._rs = 0;                 // inline mulberry32 state (see _rnd)

    // ---- floodline alarm ------------------------------------------------------
    // Integrated so the beat can accelerate without the pulse jumping phase — a
    // discontinuity here reads as a dropped frame, which is the opposite of urgency.
    this._floodPhase = 0;
    this._floodTime = 0;

    // ---- diagnostics ----------------------------------------------------------
    this.debugCount = 0;          // primitives submitted last frame
    this.reachFailures = 0;       // must stay 0 — the reachability tripwire
    this.poolMisses = 0;          // pool exhaustion events
    this.chunksGenerated = 0;
    this.lastHazardCount = 0;     // hazards emitted by the most recent chunk
    this.difficulty = 0;

    this.seed = 1;
    this.time = 0;
    this._viewsDirty = true;
    this.reset(seed);
  }

  // -------------------------------------------------------------------------------
  reset(seed = this.seed) {
    this.seed = (seed | 0) >>> 0;
    this.time = 0;
    this.difficulty = 0;
    this.reachFailures = 0;
    this.poolMisses = 0;
    this.chunksGenerated = 0;
    this._pAnchor.clear();
    this._pHazard.clear();
    this._pOrb.clear();
    this._pSolid.clear();
    for (let i = 0; i < MAX_ANCHORS; i++) this._pAnchor.items[i].alive = false;
    for (let i = 0; i < MAX_HAZARDS; i++) this._pHazard.items[i].alive = false;
    for (let i = 0; i < MAX_ORBS; i++) this._pOrb.items[i].alive = false;
    this._loadedN = 0;
    // Fill the whole window immediately so frame 1 is complete.
    this._stream(0, 1e9);
    this._rebuildViews();
  }

  get anchors() { return this._vAnchor; }
  get hazards() { return this._vHazard; }
  get orbs() { return this._vOrb; }
  get solids() { return this._vSolid; }

  // -------------------------------------------------------------------------------
  update(dt, playerX, playerY) {
    this.time += dt;
    this.difficulty = difficultyAt(playerX);
    this._stream(playerX, CHUNKS_PER_FRAME);
    this._animate(dt, playerX, playerY);
    if (this._viewsDirty) this._rebuildViews();
  }

  // ---- streaming ----------------------------------------------------------------
  _stream(playerX, budget) {
    const ci = Math.floor(playerX / CHUNK_W);
    const lo = ci - BEHIND, hi = ci + AHEAD;

    // Despawn: backwards sweep so Pool's swap-remove stays correct.
    for (let i = this._pAnchor.active - 1; i >= 0; i--) {
      const e = this._pAnchor.items[i];
      if (e.chunk < lo || e.chunk > hi) { e.alive = false; e.used = false; this._pAnchor.freeAt(i); this._viewsDirty = true; }
    }
    for (let i = this._pHazard.active - 1; i >= 0; i--) {
      const e = this._pHazard.items[i];
      if (e.chunk < lo || e.chunk > hi) { e.alive = false; this._pHazard.freeAt(i); this._viewsDirty = true; }
    }
    for (let i = this._pOrb.active - 1; i >= 0; i--) {
      const e = this._pOrb.items[i];
      if (e.chunk < lo || e.chunk > hi) { e.alive = false; this._pOrb.freeAt(i); this._viewsDirty = true; }
    }
    for (let i = this._pSolid.active - 1; i >= 0; i--) {
      const e = this._pSolid.items[i];
      if (e.chunk < lo || e.chunk > hi) { this._pSolid.freeAt(i); this._viewsDirty = true; }
    }

    // Drop stale entries from the loaded list.
    for (let i = this._loadedN - 1; i >= 0; i--) {
      const c = this._loaded[i];
      if (c < lo || c > hi) { this._loaded[i] = this._loaded[--this._loadedN]; }
    }

    // Spawn, nearest-first, capped so a teleport cannot stall a frame.
    let made = 0;
    for (let c = lo; c <= hi && made < budget; c++) {
      if (this._isLoaded(c)) continue;
      this._genChunk(c);
      if (this._loadedN < MAX_LOADED) this._loaded[this._loadedN++] = c;
      this._viewsDirty = true;
      made++;
    }
  }

  _isLoaded(c) {
    for (let i = 0; i < this._loadedN; i++) if (this._loaded[i] === c) return true;
    return false;
  }

  _rebuildViews() {
    const pa = this._pAnchor, ph = this._pHazard, po = this._pOrb, ps = this._pSolid;
    for (let i = 0; i < pa.active; i++) this._vAnchor[i] = pa.items[i];
    this._vAnchor.length = pa.active;
    for (let i = 0; i < ph.active; i++) this._vHazard[i] = ph.items[i];
    this._vHazard.length = ph.active;
    for (let i = 0; i < po.active; i++) this._vOrb[i] = po.items[i];
    this._vOrb.length = po.active;
    for (let i = 0; i < ps.active; i++) this._vSolid[i] = ps.items[i];
    this._vSolid.length = ps.active;
    this._viewsDirty = false;
  }

  // ---- per-frame animation ------------------------------------------------------
  _animate(dt, playerX, playerY) {
    const t = this.time;

    // Anchors: decaying nodes burn down while attached, then recharge so backtracking
    // is never a dead end.
    const pa = this._pAnchor;
    for (let i = 0; i < pa.active; i++) {
      const a = pa.items[i];
      if (a.kind !== 2) continue;
      if (a.alive) {
        if (a.used) {
          a.decayT -= dt;
          if (a.decayT <= 0) { a.alive = false; a.used = false; a.decayT = DECAY_RECHARGE; }
        } else if (a.decayT < DECAY_TIME) {
          a.decayT = Math.min(DECAY_TIME, a.decayT + dt * 0.8);
        }
      } else {
        a.decayT -= dt;
        if (a.decayT <= 0) { a.alive = true; a.decayT = DECAY_TIME; }
      }
    }

    // Hazards.
    const ph = this._pHazard;
    for (let i = 0; i < ph.active; i++) {
      const h = ph.items[i];
      switch (h.kind) {
        case 0: { // laser — pulses on a cycle, dead while off so physics ignores it
          let c = (t / h.rate + h.phase) % 1;
          if (c < 0) c += 1;
          h.alive = c < h.amp;
          const tellFrac = LASER_TELL / h.rate;
          h.tell = c >= 1 - tellFrac ? (c - (1 - tellFrac)) / tellFrac : 0;
          break;
        }
        case 1: { // drone — patrols a straight path, reverses at the ends
          const s = Math.sin((t * h.rate + h.phase * TAU));
          const cs = Math.cos((t * h.rate + h.phase * TAU));
          if (h.sgn > 0) { // horizontal patrol
            h.x = h.hx + s * h.amp; h.y = h.hy;
            h.vx = cs * h.amp * h.rate; h.vy = 0;
          } else {         // vertical patrol
            h.x = h.hx; h.y = h.hy + s * h.amp;
            h.vx = 0; h.vy = cs * h.amp * h.rate;
          }
          // Lethality cycle, same shape as the laser's: dormant for the tail of the
          // period, with a spool-up tell in the last DRONE_TELL seconds of that gap.
          // `alive` is the physics switch, so a dormant drone is genuinely passable.
          if (h.per > 0) {
            let c = (t / h.per + h.dphase) % 1;
            if (c < 0) c += 1;
            h.alive = c < h.duty;
            const tellFrac = DRONE_TELL / h.per;
            h.tell = c >= 1 - tellFrac ? (c - (1 - tellFrac)) / tellFrac : 0;
          }
          break;
        }
        case 2: { // spinner — constant angular velocity, direction from sgn
          h.rot = (h.phase * TAU + t * h.rate * h.sgn) % TAU;
          break;
        }
        case 3: { // gate half — rides a moving gap; sgn picks which side it is
          const c = Math.sin(t * h.rate + h.phase * TAU);
          const gap = h.hy + c * h.amp;
          h.y = gap + h.sgn * (GATE_GAP * 0.5 + h.hh);
          h.vy = Math.cos(t * h.rate + h.phase * TAU) * h.amp * h.rate;
          break;
        }
        default: break;
      }
    }

    // Orbs bob. Done in update (not render) so the collision position is the drawn one.
    const po = this._pOrb;
    for (let i = 0; i < po.active; i++) {
      const o = po.items[i];
      o.y = o.hy + Math.sin(t * ORB_BOB_RATE + o.phase * TAU) * ORB_BOB;
    }
  }

  // ===============================================================================
  // GENERATION
  // ===============================================================================

  /** Inline mulberry32 — bit-identical to `makeRng(s)` from core/math.js, but with
   *  the state on `this` instead of in a closure, so reseeding costs zero allocation. */
  _seedRng(s) { this._rs = s >>> 0; }
  _rnd() {
    this._rs = (this._rs + 0x6d2b79f5) >>> 0;
    let t = this._rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  _rr(lo, hi) { return lo + this._rnd() * (hi - lo); }
  _ri(lo, hi) { return Math.floor(lo + this._rnd() * (hi - lo + 1)); }
  _rc(p) { return this._rnd() < p; }
  _rj(m) { return (this._rnd() * 2 - 1) * m; }

  /**
   * Build one chunk. Pure in `(seed, ci)`.
   * Layout order matters: anchors define the flight line, and hazards/orbs/solids are
   * all placed *relative to that line* so they can be kept clear of it (or deliberately
   * put on it, for gauntlets).
   */
  _genChunk(ci) {
    this._seedRng((this.seed ^ ci) >>> 0);

    const x0 = ci * CHUNK_W, x1 = x0 + CHUNK_W;
    const gy0 = gateY(ci, this.seed);
    const gy1 = gateY(ci + 1, this.seed);
    const diff = difficultyAt(x0);
    const tut = x0 < TUT_DIST;
    const spacing = tut ? SPACING_TUT : lerp(SPACING_MIN, SPACING_MAX, diff);
    const speed = lerp(SPEED_CHECK_MIN, SPEED_CHECK_MAX, diff);
    const arch = ci === SPAWN_CHUNK ? AR_LAUNCH : archetypeFor(ci, this.seed);

    // Exit-gate wedge: every anchor placed in this chunk is funnelled toward
    // (x1, gy1) by `_clampY`, which is what guarantees the seam is always flyable.
    this._gx1 = x1; this._gy1 = gy1; this._diff = diff;
    // Reserve a tail so `_bridgeToGate` always has room to work. Archetypes lay their
    // shapes inside [x0, xE]; the last stretch belongs to the stitcher.
    const tail = clamp(spacing * 0.8, MIN_GAP + 4, 26);
    const xE = x1 - tail;

    this._chunkN = 0; this._chainN = 0;
    this._chunkH = 0; this._chunkO = 0; this._chunkS = 0;

    // The gate anchor. Never decaying, never skipped — it is the contract with the
    // neighbouring chunks. Heavy at difficulty spikes so hard sections open with a
    // forgiving, unmissable node.
    const gateKind = (!tut && diff > 0.45 && (arch === AR_OPEN_SPAN || arch === AR_SPINNER || arch === AR_GAUNTLET)) ? 1 : 0;
    this._lx = x0; this._ly = gy0;
    this._emitAnchor(ci, x0, gy0, gateKind);

    switch (arch) {
      case AR_OPEN_SPAN: this._archOpenSpan(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
      case AR_STAIR_UP:  this._archStair(ci, x0, xE, gy0, gy1, spacing, speed, diff, -1); break;
      case AR_STAIR_DN:  this._archStair(ci, x0, xE, gy0, gy1, spacing, speed, diff, 1); break;
      case AR_GAUNTLET:  this._archGauntlet(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
      case AR_PENDULUM:  this._archPendulum(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
      case AR_ORB_ARC:   this._archOrbArc(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
      case AR_SPINNER:   this._archSpinnerCourt(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
      case AR_LAUNCH:    this._archLaunch(ci, speed); break;
      default:           this._archDescent(ci, x0, xE, gy0, gy1, spacing, speed, diff); break;
    }

    // Stitch to the next chunk's gate. This is what makes chunk boundaries invisible.
    this._bridgeToGate(ci, x1, gy1, speed, spacing);
    // Last-resort valve: if the seam is still unflyable, the final anchor is ours to
    // move, so move it until it is. In practice the wedge means this never fires.
    this._repairTail(x1, gy1, speed);

    // A decaying anchor must never be load-bearing: demote any that the chain cannot
    // route around. Guarantees the world stays solvable even if every timer expires.
    // Everything placed up to here is the load-bearing chain; anything after is extra.
    this._chainN = this._chunkN;
    this._demoteUnskippableDecay(speed);
    this._verifyChunk(ci, x1, gy1, speed);

    // Link anchors for the cable-span visuals (drawn as catenaries in render).
    for (let i = 0; i < this._chainN - 1; i++) {
      const a = CA_REF[i];
      if (!a) continue;
      a.nx = CA_X[i + 1]; a.ny = CA_Y[i + 1]; a.hasNext = true;
    }
    // The last anchor links forward to the next gate so the cable crosses the seam.
    if (this._chainN > 0) {
      const last = CA_REF[this._chainN - 1];
      if (last) { last.nx = x1; last.ny = gy1; last.hasNext = true; }
    }

    this._genCatchRow(ci, x0, x1);
    this._genHazards(ci, arch, x0, x1, diff, tut, spacing);
    this._genOrbs(ci, arch, x0, x1, diff);
    this._genSolids(ci, arch, x0, x1, diff);

    this.chunksGenerated++;
  }

  // ---- archetypes ---------------------------------------------------------------
  // NOTE: every archetype receives `x1` = the *reserved* right edge (`xE`), not the
  // chunk edge. The stretch beyond it belongs to `_bridgeToGate`. Archetypes never
  // need to worry about hitting the exit gate — `_clampY`'s wedge funnels them.

  /** PENDULUM HALL — evenly spaced anchors at a near-constant altitude. A metronome:
   *  swing, release, swing, release. The rhythm is the lesson. */
  _archPendulum(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    const n = clamp(Math.round((x1 - x0) / (sp * 0.85)), 2, PER_CHUNK_A - 2);
    const sway = sp * 0.14;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const y = lerp(gy0, gy1, t) + Math.sin(t * TAU) * sway;
      const x = x0 + (x1 - x0) * t + this._rj(sp * 0.05);
      // Alternating decaying nodes force the player to keep moving on the beat.
      const kind = (diff > 0.38 && (i & 1) === 1 && n >= 4) ? 2 : 0;
      this._placeAnchor(ci, x, y, kind, speed);
    }
  }

  /** STAIR — a quantised climb (dir -1) or descent (dir +1). Climbing stairs may run
   *  most of the chunk because the wedge pulls them home for free (falling is cheap);
   *  descending stairs bottom out early so there is room to buy the height back. */
  _archStair(ci, x0, x1, gy0, gy1, sp, speed, diff, dir) {
    const n = clamp(Math.round((x1 - x0) / sp), 3, PER_CHUNK_A - 2);
    const kTop = Math.max(1, Math.round(n * (dir < 0 ? 0.7 : 0.4)));
    const step = (CFG.WORLD_STAIR_STEP ?? 8.5) * dir * (dir < 0 ? 1 : 0.8);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      // Rise linearly to kTop, then ramp back to zero at the exit.
      const q = i <= kTop ? i : kTop * (1 - (i - kTop) / Math.max(1, n - kTop));
      const y = lerp(gy0, gy1, t) + step * q;
      const x = x0 + (x1 - x0) * t + this._rj(sp * 0.07);
      this._placeAnchor(ci, x, y, 0, speed);
    }
  }

  /** OPEN SPAN — one heavy anchor as far out as the envelope allows. The repair pass
   *  inside `_placeAnchor` will pull it back to exactly the maximum reachable X, so
   *  this always produces a full-commitment flight and never an impossible one. */
  _archOpenSpan(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    const px = this._lx, py = this._ly;
    // Aim deliberately too far: the binary search finds the true edge of the envelope.
    const want = x0 + (x1 - x0) * 0.66 + this._rj(4);
    const y = lerp(gy0, gy1, 0.66) - (CFG.WORLD_SPAN_RISE ?? 6) + this._rj(3);
    this._placeAnchor(ci, want, y, 1, speed);
    // Breadcrumb the flight with orbs so the line is legible before you commit.
    this._layArcOrbs(ci, px, py, speed, CA_X[this._chunkN - 1], CA_Y[this._chunkN - 1], 7);
  }

  /** GAUNTLET — tight, low-amplitude anchors so the player can always grab something,
   *  with staggered laser gates between them. Reads as threading a needle. */
  _archGauntlet(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    const n = clamp(Math.round((x1 - x0) / (sp * 0.62)), 3, PER_CHUNK_A - 2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const y = lerp(gy0, gy1, t) + Math.sin(t * TAU * 1.5) * (sp * 0.22);
      const x = x0 + (x1 - x0) * t;
      this._placeAnchor(ci, x, y, 0, speed);
    }
  }

  /** ORB ARC — the teaching archetype. We compute the *actual* ballistic trajectory a
   *  player leaving the previous anchor would fly, drop the next anchor exactly on its
   *  far end, and thread orbs along it. Collecting the orbs literally means flying the
   *  ideal line; the player learns the shape of a good release by chasing amber. */
  _archOrbArc(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    let px = this._lx, py = this._ly;
    const hops = diff < 0.3 ? 3 : 2;
    for (let h = 0; h < hops; h++) {
      const ang = LAUNCH_ANGLES[NOMINAL_ANGLE_I];
      const flight = clamp((x1 - this._lx) / (hops - h) / (speed * Math.cos(ang)), 0.35, 1.05);
      const rx = px + REL_DX, ry = py + REL_DY;
      let ex = rx + speed * Math.cos(ang) * flight;
      let ey = ry + speed * Math.sin(ang) * flight + HALF_GRAV * flight * flight;
      if (ex > x1 - MIN_GAP) ex = x1 - MIN_GAP;
      ey = clamp(ey, Y_MIN, Y_MAX);
      if (ex <= this._lx + MIN_GAP) break;
      this._placeAnchor(ci, ex, ey, 0, speed);
      const ax = CA_X[this._chunkN - 1], ay = CA_Y[this._chunkN - 1];
      this._layArcOrbs(ci, px, py, speed, ax, ay, ORB_ARC_N);
      px = ax; py = ay;
    }
  }

  /** SPINNER COURT — a wide, open room. Few anchors (heavy, so they are forgiving)
   *  and rotating bars sweeping the space between them. */
  _archSpinnerCourt(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    const n = this._ri(2, 3);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const y = lerp(gy0, gy1, t) + this._rj(sp * 0.35);
      const x = x0 + (x1 - x0) * t + this._rj(sp * 0.12);
      this._placeAnchor(ci, x, y, diff > 0.5 ? 1 : 0, speed);
    }
  }

  /**
   * LAUNCH — the authored opening. This is the only chunk that is not procedural,
   * because the spawn contract in config.js is absolute: if the player's first tap
   * does not connect, the game is over before it starts. Four fixed nodes climb away
   * from (SPAWN_X, SPAWN_Y), the nearest three inside tether range, all forward and
   * all above. `_emitAnchor` is used directly (no MIN_GAP quantisation) so the ladder
   * lands exactly where the contract says it must; `_verifyChunk` still audits it.
   */
  _archLaunch(ci, speed) {
    // Jitter, then re-impose the contract. The clamps are the guarantee; the jitter is
    // only allowed to move a node inside them. Every emitted node is therefore forward
    // of the player, at least LAUNCH_UP_MIN above them, and inside tether range — by
    // construction, on every seed, exactly as when these were four hard-coded numbers.
    let px = SPAWN_X, py = SPAWN_Y;
    for (let i = 0; i < LAUNCH_DX.length; i++) {
      let dx = LAUNCH_DX[i] + this._rj(LAUNCH_JX);
      let dy = LAUNCH_DY[i] + this._rj(LAUNCH_JY);
      if (dy > -LAUNCH_UP_MIN) dy = -LAUNCH_UP_MIN;      // always overhead
      // Distance from the point the player will actually be tethering FROM: the spawn
      // for the first node, the previous node afterwards.
      const ox = SPAWN_X + dx - px, oy = SPAWN_Y + dy - py;
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d > 1e-4) {
        const k = d < LAUNCH_R_MIN ? LAUNCH_R_MIN / d
          : d > LAUNCH_R_MAX ? LAUNCH_R_MAX / d : 1;
        if (k !== 1) { dx = (px + ox * k) - SPAWN_X; dy = (py + oy * k) - SPAWN_Y; }
      }
      if (dy > -LAUNCH_UP_MIN) dy = -LAUNCH_UP_MIN;
      if (dx < 3) dx = 3;                                 // never behind the player
      px = SPAWN_X + dx; py = SPAWN_Y + dy;
      this._emitAnchor(ci, px, py, 0);
    }
  }

  /** DESCENT — a plunge through a shaft. Anchors sink hard through the middle of the
   *  chunk and climb back to the gate; solids flank the drop (see _genSolids). */
  _archDescent(ci, x0, x1, gy0, gy1, sp, speed, diff) {
    const n = clamp(Math.round((x1 - x0) / (sp * 0.8)), 3, PER_CHUNK_A - 2);
    const drop = (CFG.WORLD_DESCENT_DROP ?? 17) * (0.7 + 0.3 * diff);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      // Skewed so the shaft bottoms out around a third of the way in: the drop is
      // instant, the climb back out is the part that needs room.
      const y = lerp(gy0, gy1, t) + Math.sin(Math.pow(t, 0.55) * Math.PI) * drop;
      const x = x0 + (x1 - x0) * t + this._rj(sp * 0.06);
      this._placeAnchor(ci, x, y, 0, speed);
    }
  }

  // ---- anchor placement ---------------------------------------------------------

  /**
   * Commit an anchor, repairing it if it is out of the flight envelope.
   *
   * Repair ladder:
   *   1. Accept the candidate if `canReach` already passes.
   *   2. Snap Y onto the nearest sampled ballistic arc at that X (distance 0 → always
   *      reachable, unless the band clamp pushes it back off).
   *   3. Binary-search the *largest* X that is still reachable with an arc-snapped Y.
   *      This is what turns "aim absurdly far" into "exactly at the envelope edge",
   *      which is how OPEN_SPAN gets its maximal committed flight.
   * Step 3 always terminates: at `lastX + MIN_GAP` the arc has barely left the release
   * point, so the target is inside the tether range by construction.
   */
  _placeAnchor(ci, xIn, yIn, kind, speed) {
    if (this._chunkN >= PER_CHUNK_A) return null;
    const px = this._lx, py = this._ly;
    let x = xIn < px + MIN_GAP ? px + MIN_GAP : xIn;
    let y = this._clampY(x, yIn);

    if (!this._reachXY(px, py, x, y, speed)) {
      const snap = this._bestArcY(px, py, x, speed, y);
      const sy = snap === snap ? this._clampY(x, snap) : y;
      if (snap === snap && this._reachXY(px, py, x, sy, speed)) {
        y = sy;
      } else {
        let lo = px + MIN_GAP, hi = x;
        let by = this._bestArcY(px, py, lo, speed, y);
        by = by === by ? this._clampY(lo, by) : this._clampY(lo, py + REL_DY);
        let bx = lo;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) * 0.5;
          let my = this._bestArcY(px, py, mid, speed, y);
          my = this._clampY(mid, my === my ? my : y);
          if (this._reachXY(px, py, mid, my, speed)) { lo = mid; bx = mid; by = my; }
          else hi = mid;
        }
        x = bx; y = by;
      }
    }
    return this._emitAnchor(ci, x, y, kind);
  }

  /**
   * The exit wedge. Clamps a candidate altitude into the funnel that converges on this
   * chunk's exit gate, then into the global play band.
   *
   * The two rates are wildly asymmetric on purpose. Falling is free — an arc plunges
   * at ~1 metre per metre of travel — but climbing is bought entirely out of tether
   * reach and costs about two metres of travel per metre gained. Without the CLIMB_RATE
   * side of this wedge, any archetype that descends leaves the chain pinned at the band
   * floor with no way back up to the next gate, which is exactly how unwinnable seams
   * used to appear.
   */
  _clampY(x, y) {
    const rem = this._gx1 - x;
    if (rem > 0) {
      const low = this._gy1 + CLIMB_RATE * rem + WEDGE_SLACK;   // deepest allowed (+Y down)
      const high = this._gy1 - FALL_RATE * rem - WEDGE_SLACK;   // highest allowed
      if (y > low) y = low;
      if (y < high) y = high;
    }
    return clamp(y, Y_MIN, Y_MAX);
  }

  /** Raw emit — no reachability repair. Only the gate anchor and the repaired output
   *  of `_placeAnchor` go through here. */
  _emitAnchor(ci, x, y, kind) {
    if (this._chunkN >= PER_CHUNK_A) return null;
    const a = this._pAnchor.alloc();
    if (!a) { this.poolMisses++; return null; }
    a.x = x; a.y = y;
    a.r = kind === 1 ? A_R_HEAVY : kind === 2 ? A_R_DECAY : A_R;
    a.alive = true;
    a.kind = kind;
    a.phase = hash2(Math.round(x * 8), Math.round(y * 8) ^ ci);
    a.used = false;
    a.chunk = ci;
    a.decayT = DECAY_TIME;
    a.nx = 0; a.ny = 0; a.hasNext = false;
    a._grazeCd = 0;             // pooled: never inherit the last tenant's graze cooldown
    a.isCatch = this._chainN > 0 && this._chunkN >= this._chainN;
    const n = this._chunkN;
    CA_X[n] = x; CA_Y[n] = y; CA_K[n] = kind; CA_REF[n] = a;
    this._chunkN = n + 1;
    this._lx = x; this._ly = y;
    return a;
  }

  /**
   * Stitch the chain to the next chunk's gate. The gate position is a pure function of
   * `ci+1`, so this needs no knowledge of the neighbouring chunk's contents.
   * Scans a small fixed table of (dx, dy) offsets behind the gate for a node that is
   * reachable *from* the chain and can reach *to* the gate; falls back to a guaranteed
   * forward step when the table misses. Always converges because every iteration moves
   * the cursor at least MIN_GAP closer to the gate.
   */
  _bridgeToGate(ci, gx, gy, speed, sp) {
    let guard = 0;
    while (!this._reachXY(this._lx, this._ly, gx, gy, speed) && guard < 8) {
      guard++;
      if (this._chunkN >= PER_CHUNK_A) break;
      let bx = 0, by = 0, found = false;
      for (let i = 0; i < BRIDGE_DX.length && !found; i++) {
        const cx = gx - BRIDGE_DX[i];
        if (cx <= this._lx + MIN_GAP) continue;
        for (let j = 0; j < BRIDGE_DY.length; j++) {
          const cy = clamp(gy + BRIDGE_DY[j], Y_MIN, Y_MAX);
          if (!this._reachXY(this._lx, this._ly, cx, cy, speed)) continue;
          if (!this._reachXY(cx, cy, gx, gy, speed)) continue;
          bx = cx; by = cy; found = true; break;
        }
      }
      if (found) {
        this._emitAnchor(ci, bx, by, 0);
      } else {
        // No single hop bridges the remainder: step forward along the envelope,
        // converging vertically toward the gate, and try again.
        const want = Math.min(this._lx + sp * 0.85, gx - MIN_GAP);
        if (want <= this._lx + MIN_GAP * 0.5) break;
        const dy = clamp(gy - this._ly, -12, 12);
        this._placeAnchor(ci, want, this._ly + dy, 0, speed);
      }
    }
  }

  /**
   * Safety valve. If the seam is still unflyable after bridging, the last anchor of the
   * chunk belongs to us and nothing downstream depends on its exact position — so we
   * sweep it (Y first, then X) until it both receives the chain and delivers the gate.
   * With the wedge in place this never fires, but it is the difference between "should
   * be impossible" and "is impossible".
   */
  _repairTail(gx, gy, speed) {
    const i = this._chunkN - 1;
    if (i < 1) return;
    if (this._reachXY(CA_X[i], CA_Y[i], gx, gy, speed)) return;
    const pxp = CA_X[i - 1], pyp = CA_Y[i - 1];
    for (let xs = 0; xs < 5; xs++) {
      const cx = Math.max(pxp + MIN_GAP, Math.min(CA_X[i], gx - MIN_GAP) - xs * 4);
      for (let s = 0; s <= 30; s++) {
        // Sweep outward from the gate altitude in 2m steps, alternating up/down.
        const off = ((s & 1) ? 1 : -1) * Math.ceil(s * 0.5) * 2;
        const cy = clamp(gy + off, Y_MIN, Y_MAX);
        if (!this._reachXY(pxp, pyp, cx, cy, speed)) continue;
        if (!this._reachXY(cx, cy, gx, gy, speed)) continue;
        CA_X[i] = cx; CA_Y[i] = cy;
        const a = CA_REF[i];
        if (a) { a.x = cx; a.y = cy; }
        this._lx = cx; this._ly = cy;
        return;
      }
    }
  }

  /** Decaying anchors are a rhythm device, never a gate. If the chain cannot route
   *  around one (prev → next directly), demote it to a standard node. */
  /**
   * The catch row. Anchors slung ~21m below the chain, off the reachability graph
   * entirely, so a player who has sunk below the corridor still has something above
   * them to grab. Without these, one bad release past the anchor line is a guaranteed
   * drowning — there is simply nothing overhead, and a tether only works upward.
   * They also add the "anchors are plural" line-choice layer from DESIGN.md L4.
   */
  _genCatchRow(ci, x0, x1) {
    if (this._chainN < 2) return;
    // Rungs are keyed off the absolute chunk position so the zigzag phase is continuous
    // across chunk seams rather than restarting every 60 metres.
    let rung = Math.abs(Math.round(x0 / CATCH_SPACING)) & 1;
    for (let x = x0 + CATCH_SPACING * 0.5; x < x1 - 4; x += CATCH_SPACING, rung ^= 1) {
      if (this._chunkN >= PER_CHUNK_A) break;
      if (!this._rc(CATCH_P)) continue;
      const drop = CATCH_DROP + (rung ? CATCH_DROP2 : 0);
      const y = clamp(this._chainYAt(x) + drop + this._rj(2.5), Y_MIN, CATCH_Y_MAX);
      // Never crowd the chain, and never inside the spawn clear circle.
      if (!this._clearOfAnchors(x, y, 10)) continue;
      const sdx = x - SPAWN_X, sdy = y - SPAWN_Y;
      if (sdx * sdx + sdy * sdy < SPAWN_CLEAR_R * SPAWN_CLEAR_R) continue;
      this._emitAnchor(ci, x, y, 0);
    }
  }

  /** Linear interpolation of the chain's altitude at a world X. */
  _chainYAt(x) {
    const n = this._chainN;
    if (n === 0) return GATE_MID;
    if (x <= CA_X[0]) return CA_Y[0];
    for (let i = 0; i < n - 1; i++) {
      if (x <= CA_X[i + 1]) {
        const t = (x - CA_X[i]) / Math.max(1e-4, CA_X[i + 1] - CA_X[i]);
        return lerp(CA_Y[i], CA_Y[i + 1], t);
      }
    }
    // Past the last chain anchor: run on toward the exit gate.
    const t = clamp01((x - CA_X[n - 1]) / Math.max(1e-4, this._gx1 - CA_X[n - 1]));
    return lerp(CA_Y[n - 1], this._gy1, t);
  }

  _demoteUnskippableDecay(speed) {
    for (let i = 1; i < this._chainN - 1; i++) {
      if (CA_K[i] !== 2) continue;
      if (this._reachXY(CA_X[i - 1], CA_Y[i - 1], CA_X[i + 1], CA_Y[i + 1], speed)) continue;
      CA_K[i] = 0;
      const a = CA_REF[i];
      if (a) { a.kind = 0; a.r = A_R; }
    }
    // The final anchor of a chunk is load-bearing for the seam — never let it decay.
    if (this._chainN > 0) {
      const a = CA_REF[this._chainN - 1];
      if (a && a.kind === 2) { a.kind = 0; a.r = A_R; CA_K[this._chainN - 1] = 0; }
    }
  }

  /** Debug tripwire: assert the invariant on everything this chunk just produced. */
  _verifyChunk(ci, gx, gy, speed) {
    for (let i = 1; i < this._chainN; i++) {
      if (!this._reachXY(CA_X[i - 1], CA_Y[i - 1], CA_X[i], CA_Y[i], speed)) this.reachFailures++;
    }
    if (this._chainN > 0) {
      if (!this._reachXY(CA_X[this._chainN - 1], CA_Y[this._chainN - 1], gx, gy, speed)) this.reachFailures++;
    }
  }

  // ---- the flight envelope ------------------------------------------------------

  /**
   * Public reachability test. `fromAnchor` / `toAnchor` are anchor-like `{x, y}`.
   *
   * Model: the player releases at `REL_R` metres from the anchor, ahead of and below
   * it (the bottom-forward quadrant of the swing, which is where a release that scores
   * a Perfect Arc happens), carrying `assumedSpeed`. From there they are pure
   * ballistics. We fan across the plausible release angles and return true if *any*
   * of those arcs passes within `TETHER_MAX_RANGE * 0.85` of the target before the arc
   * sinks past the floodline (an arc that drowns you does not count as reachable).
   */
  canReach(fromAnchor, toAnchor, assumedSpeed) {
    return this._reachXY(fromAnchor.x, fromAnchor.y, toAnchor.x, toAnchor.y,
      assumedSpeed || SPEED_CHECK_MIN);
  }

  _reachXY(px, py, tx, ty, speed) {
    const rx = px + REL_DX, ry = py + REL_DY;
    // Trivial accept: already inside tether range of the release point.
    let dx = tx - rx, dy = ty - ry;
    if (dx * dx + dy * dy <= REACH2) return true;
    for (let k = 0; k < LAUNCH_ANGLES.length; k++) {
      const ang = LAUNCH_ANGLES[k];
      const vx = speed * Math.cos(ang), vy = speed * Math.sin(ang);
      for (let i = 1; i <= ARC_STEPS; i++) {
        const t = i * ARC_DT;
        const x = rx + vx * t;
        const y = ry + vy * t + HALF_GRAV * t * t;
        if (y > FLOODLINE) break;          // arc drowns before it gets there
        dx = tx - x; dy = ty - y;
        if (dx * dx + dy * dy <= REACH2) return true;
        if (x > tx + REACH) break;         // overshot in X, no arc comes back
      }
    }
    return false;
  }

  /** Y of the best sampled arc at world X, choosing the arc closest to `desiredY`.
   *  Returns NaN when no arc reaches that X (too close, or drowned). */
  _bestArcY(px, py, x, speed, desiredY) {
    const rx = px + REL_DX, ry = py + REL_DY;
    let best = NaN, bd = Infinity;
    for (let k = 0; k < LAUNCH_ANGLES.length; k++) {
      const ang = LAUNCH_ANGLES[k];
      const vx = speed * Math.cos(ang);
      if (vx <= 0.01) continue;
      const t = (x - rx) / vx;
      if (t < 0 || t > ARC_T_MAX) continue;
      const y = ry + speed * Math.sin(ang) * t + HALF_GRAV * t * t;
      if (y > FLOODLINE) continue;
      const d = Math.abs(y - desiredY);
      if (d < bd) { bd = d; best = y; }
    }
    return best;
  }

  // ---- hazards ------------------------------------------------------------------

  /**
   * Hazards *requested* per chunk, following DESIGN.md's distance curve:
   *   < 340    0.00   (tutorial: zero hazards, guaranteed)
   *     600     0.55      800    1.10      1200   1.87      1800   2.51  → asymptote 3.4
   * The fractional part is resolved by a deterministic coin flip so the mean is exact
   * but individual chunks still breathe.
   *
   * This is a ceiling, not a quota. Placement then has to find somewhere legal — clear
   * of the anchors, and far enough from the previous threat that they arrive as
   * separate beats — so the *realised* density is lower and its top end is set by that
   * separation rule rather than by this number. REALISED density, measured per chunk:
   *   340-600 0.24 · 600-900 0.94 · 900-1300 1.19 · 1300-1800 1.45 · 1800-2600 1.56
   *   2600-4000 1.64 · 4000+ 1.68
   * which is the shape DESIGN.md asks for — monotone, asymptotic, tutorial empty — and
   * it saturates near 1.7 because PLACEMENT, not this budget, is the binding
   * constraint. Sweeping HAZ_MAX from 2.2 to 3.4 moved measured survival by less than
   * the seed-to-seed noise; if you need to change late-game density, the levers that
   * actually bite are HAZ_CLEAR and the hazard separation rule.
   */
  _hazardBudget(diff, tut) {
    if (tut) return 0;
    const f = HAZ_MAX * Math.pow(diff, HAZ_POW);
    const n = Math.floor(f);
    return n + (this._rc(f - n) ? 1 : 0);
  }

  _genHazards(ci, arch, x0, x1, diff, tut, sp) {
    const budget = this._hazardBudget(diff, tut);
    this.lastHazardCount = 0;
    // Nothing lethal exists before FIRST_HAZ_X, and the chunk that reaches it is owned
    // outright by the authored beam — one hazard, alone and legible, instead of a
    // random first encounter buried in a mix. See CFG.WORLD_FIRST_HAZ_X.
    if (ci < FIRST_HAZ_CHUNK) return;
    if (ci === FIRST_HAZ_CHUNK && this._chainN >= 2) {
      if (this._genFirstLaser(ci)) return;
    }
    if (budget <= 0) return;
    const x = x0 * 1; // chunk world position drives which kinds have unlocked
    const canDrone = x >= HAZ_DRONE_X;
    const canSpin = x >= HAZ_SPIN_X;
    const canGate = x >= HAZ_GATE_X;

    // Archetype-led placement first — these are the authored bits.
    if (arch === AR_GAUNTLET) {
      // Staggered vertical beams between consecutive anchors. Phases march forward so
      // the whole gauntlet reads as a single travelling wave you ride through.
      let placed = 0;
      for (let i = 0; i < this._chainN - 1 && placed < budget + 2; i++) {
        const mx = (CA_X[i] + CA_X[i + 1]) * 0.5;
        const my = (CA_Y[i] + CA_Y[i + 1]) * 0.5;
        if (!this._clearOfAnchors(mx, my, HAZ_CLEAR_LASER * 0.8)) continue;
        const h = this._emitHazard(ci, 0, mx, my, this._rr(7, 11), 0.34,
          Math.PI * 0.5 + this._rj(0.22));
        if (!h) break;
        h.phase = (i * 0.29) % 1;
        placed++;
      }
      if (placed > 0) return;
    }
    if (arch === AR_SPINNER && canSpin) {
      let placed = 0;
      for (let i = 0; i < this._chainN - 1 && placed < Math.max(2, budget); i++) {
        const mx = lerp(CA_X[i], CA_X[i + 1], 0.5) + this._rj(3);
        const my = lerp(CA_Y[i], CA_Y[i + 1], 0.5) + this._rj(4);
        if (!this._clearOfAnchors(mx, my, HAZ_CLEAR + 3)) continue;
        const h = this._emitHazard(ci, 2, mx, my, this._rr(6, 9.5), 0.42, 0);
        if (!h) break;
        h.rate = SPINNER_RATE * this._rr(0.75, 1.3);
        h.sgn = this._rc(0.5) ? 1 : -1;
        placed++;
      }
      if (placed > 0) return;
    }

    // Generic mix. Kinds unlock with distance per DESIGN.md's bands.
    for (let n = 0; n < budget; n++) {
      let kind = 0;
      const roll = this._rnd();
      if (canGate && roll > 0.80) kind = 3;
      else if (canSpin && roll > 0.58) kind = 2;
      else if (canDrone && roll > 0.34) kind = 1;
      this._placeGenericHazard(ci, kind, x0, x1, sp);
    }
  }

  /**
   * The one hazard in the game that is placed rather than rolled.
   *
   * Sits on the mid-span of the longest chain segment in the chunk — the widest, most
   * open piece of airspace available, so the beam is visible from a long way out and
   * there is room either side of it. `_emitHazard` derives the duty cycle from
   * difficulty for normal lasers; this one overrides it afterwards with the far gentler
   * teaching values, and pins the phase so the beam is DARK when the player is most
   * likely to arrive rather than leaving that to the hash.
   *
   * Returns false if it could not place, in which case the chunk falls through to the
   * ordinary generator and the next chunk's beam becomes the first one seen. In
   * practice `_chainN >= 2` is enough for this to always succeed.
   */
  _genFirstLaser(ci) {
    let seg = 0, best = -1;
    for (let i = 0; i < this._chainN - 1; i++) {
      const d = CA_X[i + 1] - CA_X[i];
      if (d > best) { best = d; seg = i; }
    }
    const mx = (CA_X[seg] + CA_X[seg + 1]) * 0.5;
    const my = (CA_Y[seg] + CA_Y[seg + 1]) * 0.5;
    const h = this._emitHazard(ci, 0, mx, my, FIRST_LASER_HW, 0.34, Math.PI * 0.5);
    if (!h) return false;
    h.rate = FIRST_LASER_PERIOD;
    h.amp = FIRST_LASER_ON;
    // Phase 0 puts the lethal window at the START of the cycle. The player cannot reach
    // this beam before ~8s of run time at any speed, which is several full periods, so
    // what this really buys is determinism: the beam's clock is identical on every seed,
    // which is what makes it a teachable beat rather than a coin flip.
    h.phase = 0;
    this.lastHazardCount = 1;
    return true;
  }

  /** Pick a spot near — but never on top of — the flight line, then emit. */
  _placeGenericHazard(ci, kind, x0, x1, sp) {
    if (this._chainN < 2) return;
    for (let attempt = 0; attempt < 18; attempt++) {
      const seg = this._ri(0, this._chainN - 2);
      const t = this._rr(0.25, 0.75);
      const bx = lerp(CA_X[seg], CA_X[seg + 1], t);
      const by = lerp(CA_Y[seg], CA_Y[seg + 1], t);
      // Hazards are pushed deliberately OFF the centre of the lane rather than
      // straddling it. A threat that spans the entire corridor leaves the on/off cycle
      // as the only way past, which is a coin flip once you are committed mid-swing;
      // one that covers a side leaves a line through it as well as a moment.
      const ox = this._rj(sp * 0.18);
      const side = this._rc(0.5) ? 1 : -1;
      // The off-lane push has to leave the hazard inside the GRAZE band, or L3 has
      // nothing to reward. The band's outer edge is PLAYER_RADIUS + GRAZE_RADIUS =
      // 4.25m; a minimum offset of 4.5m therefore placed every hazard just outside
      // it BY CONSTRUCTION, and grazes-per-run sat at 2.0. 3.0-8.0 overlaps the band
      // while still keeping the threat off the centreline, so there is a line
      // through as well as a moment.
      const oy = side * this._rr(3.0, 8.0) + this._rj(1.5);
      const hx = bx + ox, hy = clamp(by + oy, Y_MIN + 4, Y_MAX + 14);
      const relax = attempt >= 8 ? 0.78 : 1;
      const clearNeed = (kind === 0 ? HAZ_CLEAR_LASER : HAZ_CLEAR) * relax;
      if (!this._clearOfAnchors(hx, hy, clearNeed)) continue;
      if (!this._clearOfHazards(ci, hx, lerp(HAZ_SEP_EARLY, HAZ_SEP_LATE, this._diff) * relax)) continue;

      if (kind === 0) {
        // Laser: a long beam crossing the corridor, mostly vertical, sometimes raked.
        // Half-length kept short enough that the beam is a barrier across part of the
        // lane, not a wall across all of it.
        const h = this._emitHazard(ci, 0, hx, hy, this._rr(6, 10.5), 0.34,
          this._rc(0.75) ? Math.PI * 0.5 + this._rj(0.3) : this._rj(0.5));
        if (h) h.phase = this._rnd();
      } else if (kind === 1) {
        // Drone: patrols a straight leg, ALONG the corridor more often than across it.
        // It used to be 65% vertical — sweeping the exact axis a swing arc travels,
        // so the patrol and the player were always closing on each other. Biasing it
        // horizontal makes the drone something you overtake or fall behind, which is
        // a relationship a committed swing can still change.
        const h = this._emitHazard(ci, 1, hx, hy, 1.15, 0.85, 0);
        if (h) {
          h.hx = hx; h.hy = hy;
          h.sgn = this._rc(0.7) ? 1 : -1;
          // Patrol legs stay short: a drone should own a pocket of the lane you can
          // read and route around, not sweep the whole corridor.
          h.amp = this._rr(3.5, 7);
          h.rate = DRONE_SPEED / Math.max(1, h.amp);
          h.phase = this._rnd();
        }
      } else if (kind === 2) {
        const h = this._emitHazard(ci, 2, hx, hy, this._rr(4.5, 7.5), 0.4, 0);
        if (h) {
          h.rate = SPINNER_RATE * this._rr(0.7, 1.35);
          h.sgn = this._rc(0.5) ? 1 : -1;
          h.phase = this._rnd();
        }
      } else {
        // Gate: two blocks either side of a gap that slides up and down.
        const amp = this._rr(3, 7.5);
        const ph = this._rnd();
        const rate = GATE_RATE * this._rr(0.8, 1.25);
        const hh = 10;
        const top = this._emitHazard(ci, 3, hx, hy, 1.7, hh, 0);
        const bot = this._emitHazard(ci, 3, hx, hy, 1.7, hh, 0);
        if (top) { top.hx = hx; top.hy = hy; top.amp = amp; top.rate = rate; top.phase = ph; top.sgn = -1; }
        if (bot) { bot.hx = hx; bot.hy = hy; bot.amp = amp; bot.rate = rate; bot.phase = ph; bot.sgn = 1; }
      }
      this.lastHazardCount++;
      return;
    }
  }

  _emitHazard(ci, kind, x, y, hw, hh, rot) {
    if (this._chunkH >= PER_CHUNK_H) return null;
    // A hazard is lethal on contact, so it obeys the spawn contract too. Drones and
    // gates move, so their swept extent is padded by their amplitude.
    const pad = kind === 1 || kind === 3 ? 10 : 0;
    if (circleVsOBB(SPAWN_X, SPAWN_Y, SPAWN_CLEAR_R + pad, x, y, hw, hh, rot)) return null;
    const h = this._pHazard.alloc();
    if (!h) { this.poolMisses++; return null; }
    h.x = x; h.y = y; h.hx = x; h.hy = y;
    h.hw = hw; h.hh = hh; h.rot = rot;
    h.kind = kind; h.alive = true;
    h.phase = hash2(Math.round(x * 4) ^ kind, Math.round(y * 4) ^ ci);
    h.vx = 0; h.vy = 0;
    h.amp = 0; h.rate = 1; h.sgn = 1; h.tell = 0;
    h.per = 0; h.duty = 0; h.dphase = 0; h._grazeCd = 0;
    if (kind === 0) {
      // `rate` carries the cycle period and `amp` the lethal fraction, both eased so a
      // player's first encounters have a long, obvious, survivable gap.
      h.rate = lerp(LASER_PERIOD_EARLY, LASER_PERIOD, this._diff);
      h.amp = lerp(LASER_ON_EARLY, LASER_ON, this._diff);
    } else if (kind === 1) {
      // Drones carry their lethality cycle separately from their patrol motion
      // (`rate`/`amp`/`phase`), so the dormant window lands at a different point of
      // the sweep for every unit and the field never pulses in lockstep.
      h.per = DRONE_PERIOD;
      h.duty = lerp(DRONE_ON_EARLY, DRONE_ON, this._diff);
      h.dphase = hash2(Math.round(x * 8) ^ 0x5bf0, Math.round(y * 8) ^ ci);
    }
    h.chunk = ci;
    this._chunkH++;
    return h;
  }

  /** Keep hazards from stacking on top of each other along X, within this chunk and
   *  across the seam into the chunks already generated either side of it. */
  _clearOfHazards(ci, x, need) {
    const p = this._pHazard;
    for (let i = 0; i < p.active; i++) {
      const h = p.items[i];
      if (h.chunk < ci - 1 || h.chunk > ci + 1) continue;
      if (Math.abs(h.hx - x) < need) return false;
    }
    return true;
  }

  /**
   * Hazards must leave the anchors approachable. The chain gets the full margin — those
   * are the nodes the run is built on. The catch row gets a reduced one: it is a
   * bail-out you dive for, not a line you plan around, and holding hazards that far off
   * it would starve the late game of density (the catch row roughly doubles the anchor
   * count, so a uniform margin quietly caps the difficulty ramp).
   */
  _clearOfAnchors(x, y, need) {
    const n2 = need * need;
    const c2 = need * need * 0.36;
    for (let i = 0; i < this._chunkN; i++) {
      const dx = x - CA_X[i], dy = y - CA_Y[i];
      if (dx * dx + dy * dy < (i < this._chainN ? n2 : c2)) return false;
    }
    return true;
  }

  // ---- orbs ---------------------------------------------------------------------

  /** Lay orbs along the true ballistic path between two anchors. Picks the sampled
   *  arc that actually gets closest to the destination, so the trail of amber is the
   *  line a good release produces — collect them all and you have flown it perfectly. */
  _layArcOrbs(ci, px, py, speed, tx, ty, count) {
    const rx = px + REL_DX, ry = py + REL_DY;
    // Choose the arc that comes nearest the target.
    let bestK = NOMINAL_ANGLE_I, bestD = Infinity, bestT = 0.6;
    for (let k = 0; k < LAUNCH_ANGLES.length; k++) {
      const ang = LAUNCH_ANGLES[k];
      const vx = speed * Math.cos(ang), vy = speed * Math.sin(ang);
      for (let i = 1; i <= ARC_STEPS; i++) {
        const t = i * ARC_DT;
        const x = rx + vx * t, y = ry + vy * t + HALF_GRAV * t * t;
        if (y > FLOODLINE) break;
        const dx = tx - x, dy = ty - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestK = k; bestT = t; }
        if (x > tx + REACH) break;
      }
    }
    const ang = LAUNCH_ANGLES[bestK];
    const vx = speed * Math.cos(ang), vy = speed * Math.sin(ang);
    for (let i = 1; i <= count; i++) {
      const t = bestT * (i / (count + 1));
      const x = rx + vx * t;
      const y = ry + vy * t + HALF_GRAV * t * t;
      if (y > FLOODLINE - 3 || y < Y_MIN - 6) continue;
      this._emitOrb(ci, x, y);
    }
  }

  _genOrbs(ci, arch, x0, x1, diff) {
    // ORB_ARC / OPEN_SPAN already laid their teaching trails.
    if (arch === AR_ORB_ARC || arch === AR_OPEN_SPAN) return;
    const want = Math.round(lerp(ORB_MAX, ORB_MIN, diff * 0.7));
    if (this._chainN < 2) return;
    // Scatter along the chain, biased above the chord — that is where a well-timed
    // release actually flies, so the orbs still reward good technique.
    for (let n = 0; n < want; n++) {
      const seg = this._ri(0, this._chainN - 2);
      const t = this._rr(0.15, 0.85);
      const x = lerp(CA_X[seg], CA_X[seg + 1], t);
      const y = lerp(CA_Y[seg], CA_Y[seg + 1], t) - this._rr(0.5, 7) + this._rj(1.5);
      if (x < x0 || x > x1) continue;
      this._emitOrb(ci, x, clamp(y, Y_MIN, Y_MAX));
    }
  }

  _emitOrb(ci, x, y) {
    if (this._chunkO >= PER_CHUNK_O) return null;
    const o = this._pOrb.alloc();
    if (!o) { this.poolMisses++; return null; }
    o.x = x; o.y = y; o.hy = y;
    o.r = ORB_R;
    o.alive = true;
    o.collected = false;
    o.phase = hash2(Math.round(x * 16), Math.round(y * 16) ^ ci);
    o.chunk = ci;
    this._chunkO++;
    return o;
  }

  // ---- solids -------------------------------------------------------------------

  /**
   * Structure. These are the visual bones of the near city *and* real collision, so
   * every candidate is clearance-tested by `_blocksFlight` against the sagging arc band
   * between anchors and against the spawn corridor. Nothing gets a pass: the threading
   * challenge is delivered by hazards, which telegraph and can be timed, never by
   * silhouetted geometry the player cannot read in time.
   */
  _genSolids(ci, arch, x0, x1, diff) {
    // Below TUTORIAL_DIST the world must be physically non-lethal: no hazards (already
    // guaranteed) and structure held far enough off the corridor that a new player
    // cannot hit it. Architecture stays a pure bounce well past here, out to
    // SOLID_SAFE_DIST — hazards telegraph and so arrive first; silhouettes do not.
    const tut = x0 < TUT_DIST;
    const clear = tut ? SOLID_CLEAR * SOLID_TUT_MUL : SOLID_CLEAR;

    // 1. Supports. Most hang DOWN from an overhead gantry — that keeps the mass above
    //    the anchor line where nothing ever flies. The minority that rise from below
    //    must start past the deepest sag, not just past the anchor.
    for (let i = 0; i < this._chunkN; i++) {
      if (!this._rc(SUPPORT_P)) continue;
      const ax = CA_X[i], ay = CA_Y[i];
      if (this._rc(0.35) && !tut) {
        const top = ay + UNDER_DROP + this._rr(1, 7);
        const bot = Math.min(FLOODLINE - 1, top + this._rr(9, 24));
        if (bot - top < 4) continue;
        this._trySolid(ci, ax + this._rj(2.2), (top + bot) * 0.5,
          this._rr(0.7, 1.6), (bot - top) * 0.5, 0, clear, 0);
      } else {
        // Overhead gantries have to clear the RISE band, not just the anchor: a late
        // release throws the player a long way above the chain.
        const bot = ay - clear - this._rr(18, 32);
        const top = Math.max(Y_MIN - 30, bot - this._rr(9, 24));
        if (bot - top < 4) continue;
        this._trySolid(ci, ax + this._rj(2.2), (top + bot) * 0.5,
          this._rr(0.7, 1.5), (bot - top) * 0.5, 0, clear, 0);
      }
    }

    // 2. Catwalks: long horizontal slabs capping the corridor above and flooring it
    //    well below. They read as the gantry decks of the near city and give the eye a
    //    horizon to parallax against.
    const cw = this._ri(1, 3);
    for (let i = 0; i < cw; i++) {
      const cx = this._rr(x0 + 6, x1 - 6);
      const above = this._rc(0.62);
      const near = this._nearestAnchorY(cx);
      const cy = above ? near - this._rr(clear + 22, clear + 40)
        : near + UNDER_DROP + this._rr(2, 18);
      this._trySolid(ci, cx, clamp(cy, Y_MIN - 24, FLOODLINE - 2),
        this._rr(6, 15), this._rr(0.5, 1.1), 0, clear, 1);
    }

    // 3. Base structures riding just above the floodline: the drowned city.
    if (this._rc(0.8)) {
      const bx = this._rr(x0 + 4, x1 - 4);
      const top = this._rr(FLOODLINE - 16, FLOODLINE - 7);
      this._trySolid(ci, bx, (top + FLOODLINE + 6) * 0.5, this._rr(5, 13),
        (FLOODLINE + 6 - top) * 0.5, 0, clear, 2);
    }

    // 4. Archetype flourishes.
    if (arch === AR_DESCENT) {
      // Flank the drop with shaft walls — the plunge should feel enclosed. They sit
      // outboard of the corridor; the threading challenge in this game is delivered by
      // hazards you can time, never by walls you cannot see coming.
      const mid = (x0 + x1) * 0.5;
      for (let s = -1; s <= 1; s += 2) {
        const sx = mid + s * this._rr(12, 18);
        const my = this._nearestAnchorY(sx);
        this._trySolid(ci, sx, my - this._rr(12, 22), this._rr(0.8, 1.4),
          this._rr(10, 18), this._rj(0.12), clear, 3);
      }
    } else if (arch === AR_OPEN_SPAN) {
      // A lone pylon far below the span sells the height of the flight.
      const bx = lerp(x0, x1, 0.5);
      this._trySolid(ci, bx, this._rr(FLOODLINE - 24, FLOODLINE - 12),
        this._rr(1.2, 2.2), this._rr(8, 16), 0, clear + 4, 3);
    } else if (arch === AR_SPINNER) {
      // Court ceiling.
      this._trySolid(ci, x0 + this._rr(4, 12), this._nearestAnchorY(x0 + 8) - this._rr(14, 24),
        this._rr(4, 9), this._rr(0.6, 1.2), 0, clear, 1);
    }

    // 5. Skim decks — the architecture you are actually allowed to touch.
    this._genSkimDecks(ci, diff, tut);
  }

  /**
   * Gantry decks laid in the SKIM BAND: outside the guaranteed-clear inner envelope,
   * inside the outer edge of the release-timing envelope. This is the only structure in
   * the game placed *toward* the player rather than away from them.
   *
   * Three properties make this safe to do, and all three are load-bearing:
   *   1. `_trySolid` still runs the inner-envelope test (style 1 → SAG_BAND), so a deck
   *      that would intrude on the nominal line is rejected outright. The well-flown
   *      line stays guaranteed clear — which is what keeps "no death is unavoidable"
   *      true, and that property is worth more than any amount of texture.
   *   2. Decks are placed at mid-span (t 0.35–0.65) where the sag envelope is widest and
   *      the player's velocity is parallel to the chord, and they are ROTATED onto the
   *      chord. The face you meet therefore runs along your direction of travel, so the
   *      angle of incidence is shallow by construction and the contact deflects.
   *   3. Below SOLID_SAFE_DIST they cannot kill at all — a beginner just bounces.
   */
  _genSkimDecks(ci, diff, tut) {
    if (tut || diff <= 0) return;
    const f = SKIM_MAX * diff;
    const n = Math.floor(f) + (this._rc(f - Math.floor(f)) ? 1 : 0);
    for (let k = 0; k < n; k++) {
      if (this._chainN < 2) return;
      const seg = this._ri(0, this._chainN - 2);
      const ax = CA_X[seg], ay = CA_Y[seg];
      const bx = CA_X[seg + 1], by = CA_Y[seg + 1];
      const t = this._rr(0.35, 0.65);
      const bend = Math.sin(t * Math.PI);
      const cx = lerp(ax, bx, t);
      const cy = lerp(ay, by, t);
      // ALWAYS above the chord. Everything below the chain is recovery airspace — the
      // sag of a bad swing, the catch row, the dive back up out of trouble — and the
      // floodline already prices sinking. Putting decks down there punished the
      // mid-skill player hardest (measured: the metronome bot's solid deaths went 6 ->
      // 14 and it started finishing SHORTER than the hold bot, i.e. the middle of the
      // skill gradient inverted). Above the chord is where a deliberately late release
      // throws you, so a deck up there is a consequence of a choice rather than of a
      // mistake you are already paying for.
      const y = cy - this._rr(SKIM_NEAR, SKIM_FAR) * bend;
      const rot = clamp(Math.atan2(by - ay, bx - ax), -0.42, 0.42);
      this._trySolid(ci, cx + this._rj(3), clamp(y, Y_MIN - 10, FLOODLINE - 3),
        this._rr(SKIM_HW[0], SKIM_HW[1]), this._rr(SKIM_HH[0], SKIM_HH[1]),
        rot, SOLID_CLEAR, 1);
    }
  }

  _nearestAnchorY(x) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this._chainN; i++) {
      const d = Math.abs(CA_X[i] - x);
      if (d < bd) { bd = d; best = CA_Y[i]; }
    }
    return this._chainN ? best : GATE_MID;
  }

  /**
   * True if an OBB intrudes on any of the corridors the player is guaranteed to fly
   * through: the sagging arc band between consecutive anchors (including the two
   * virtual spans that cross the chunk seams), and — near the start of the run — the
   * spawn clear circle and the free-fall corridor leading out of it.
   */
  _blocksFlight(x, y, hw, hh, rot, lc, band) {
    // 1. Spawn contract. Only ever relevant for the first ~130 metres.
    if (x - hw - lc < SPAWN_X + SPAWN_CORRIDOR + 12 && x + hw + lc > SPAWN_X - 40) {
      if (circleVsOBB(SPAWN_X, SPAWN_Y, SPAWN_CLEAR_R, x, y, hw, hh, rot)) return true;
      // The player's first seconds are a free fall; we do not know their launch speed,
      // so clear the union of the plausible parabolas.
      for (let k = 0; k < SPAWN_VX.length; k++) {
        const vx = SPAWN_VX[k];
        for (let i = 1; i <= 26; i++) {
          const t = i * 0.055;
          const px = SPAWN_X + vx * t;
          if (px > SPAWN_X + SPAWN_CORRIDOR) break;
          const py = SPAWN_Y + HALF_GRAV * t * t;
          if (py > FLOODLINE) break;
          if (circleVsOBB(px, py, SPAWN_CORR_R, x, y, hw, hh, rot)) return true;
        }
      }
    }
    // 2. The sagging arc band. A swing between two anchors follows a parabola whose
    //    depth depends on release timing, so we clear a *band* of sags rather than one
    //    curve — clearing only the straight chord (as this used to) leaves roughly one
    //    swing in five flying into a wall the generator believed was clear.
    const n = this._chainN, N = this._chunkN;
    if (n === 0) return false;
    // Segment index space:
    //   -1        virtual incoming span from the previous chunk
    //   0..n-2    the load-bearing chain
    //   n-1       virtual outgoing span to the next chunk's gate
    //   n..N-2    the catch row, which is its own x-ordered corridor
    for (let i = -1; i <= N - 2 || i <= n - 1; i++) {
      if (i > n - 1 && i > N - 2) break;
      let ax, ay, bx, by;
      if (i < 0) {
        ax = CA_X[0] - CHUNK_W * 0.42; ay = CA_Y[0] + 2; bx = CA_X[0]; by = CA_Y[0];
      } else if (i === n - 1) {
        ax = CA_X[i]; ay = CA_Y[i]; bx = this._gx1; by = this._gy1;
      } else {
        ax = CA_X[i]; ay = CA_Y[i]; bx = CA_X[i + 1]; by = CA_Y[i + 1];
      }
      if (x + hw + lc < Math.min(ax, bx) || x - hw - lc > Math.max(ax, bx)) continue;
      for (let s = 1; s <= ARC_SAMPLES; s++) {
        const t = s / (ARC_SAMPLES + 1);
        const px = lerp(ax, bx, t);
        const base = lerp(ay, by, t);
        const bend = Math.sin(t * Math.PI);
        for (let g = 0; g < band.length; g++) {
          if (circleVsOBB(px, base + band[g] * bend, lc, x, y, hw, hh, rot)) return true;
        }
      }
    }
    return false;
  }

  /**
   * `style` 1 is a DECK (catwalk / gantry floor): long, flat, horizontal, and therefore
   * only ever meetable at a shallow angle, so it is cleared against the inner envelope
   * and may sit inside the outer one. Every other style is a hard face and is cleared
   * against the whole envelope. See SAG_BAND / SAG_BAND_FULL.
   */
  _trySolid(ci, x, y, hw, hh, rot, clear, style) {
    if (this._chunkS >= PER_CHUNK_S) return null;
    // Clearance vs anchors.
    for (let i = 0; i < this._chunkN; i++) {
      if (circleVsOBB(CA_X[i], CA_Y[i], clear, x, y, hw, hh, rot)) return null;
    }
    const deck = style === 1;
    const lc = deck ? SKIM_LC : Math.max(3, clear * (SOLID_LINE_CLEAR / SOLID_CLEAR));
    const band = deck ? SAG_BAND : SAG_BAND_FULL;
    if (this._blocksFlight(x, y, hw, hh, rot, lc, band)) return null;
    const s = this._pSolid.alloc();
    if (!s) { this.poolMisses++; return null; }
    s.x = x; s.y = y; s.hw = hw; s.hh = hh; s.rot = rot;
    s.chunk = ci; s.style = style;
    s.sign = this._rc(0.22) ? 1 : 0;
    // Pooled: never inherit the last tenant's cooldowns. Anchors and hazards already
    // did this; solids did not, so a recycled slab could spawn with a live graze
    // cooldown and silently swallow the player's first skim of it.
    s._grazeCd = 0; s._deflectCd = 0;
    this._chunkS++;
    return s;
  }

  // ===============================================================================
  // RENDER
  // ===============================================================================
  /**
   * Draw order: structure (near-black silhouettes with neon edges) → cable spans →
   * orbs → hazards → anchors. Anchors last because they must be the most legible
   * thing on screen: the player's eye is hunting for them every single second.
   *
   * EMISSIVE BUDGET. The post chain blooms everything above ~1.0, so "brighter" past
   * that point does not mean "more visible" — it means the shape dissolves into a white
   * ball and legibility goes DOWN. The rule here is: exactly one small element per
   * entity is allowed over 2.0 (the core pip), the structural elements that carry the
   * shape sit at 0.5–1.6 where they still read as coloured, and haloes stay well under
   * 1.0 and physically small. An anchor should read as a crisp violet ring with a hot
   * centre, not as a sun.
   *
   * `r.glow()` is a normalised radial gaussian: its `radius` argument is the entire
   * extent (glowRadius is ignored for that shape), so haloes are sized in world units
   * directly — a couple of anchor radii, never a screenful.
   */
  render(r, camX, viewW, zoom, time, flood01 = 0) {
    const pad = viewW * CULL_PAD;
    const lo = camX - pad, hi = camX + pad;
    const aa = 1.6 / (zoom > 1e-4 ? zoom : 1);
    let pc = 0;

    pc += this._renderSolids(r, lo, hi, aa, time);
    pc += this._renderOrbs(r, lo, hi, aa, time);
    pc += this._renderHazards(r, lo, hi, aa, time);
    pc += this._renderAnchors(r, lo, hi, aa, time, pc);
    pc += this._renderFloodline(r, lo, hi, aa, time, flood01);

    this.debugCount = pc;
  }

  /**
   * THE FLOODLINE ALARM.
   *
   * Drowning was the only lethal thing in the game with nothing that could be called
   * a tell. A hazard announces itself twice — a 0.4s charge-up plus 0.83s of median
   * on-screen presence — while the water announced itself with a vignette ramped over
   * 13 units and squared, i.e. 0.17s at the descent rate people actually drown at.
   * That is not a hard mechanic, it is an invisible one, and it was killing the mid
   * tier in 31% of runs.
   *
   * The vignette in main.js is now the SLOW half of the telegraph (a 55u cubic ramp).
   * This is the fast half, and it is deliberately in a different visual channel:
   *
   *   - It is ON THE OBJECT. The vignette is a screen-edge wash, which reads as "the
   *     game is unhappy"; this draws the actual thing that is about to kill you, at
   *     the actual place it will happen, which is what makes the danger locatable.
   *   - It BEATS, and the beat ACCELERATES from FLOOD_WARN_HZ[0] to [1] as you sink.
   *     Rhythm survives peripheral vision and a noisy frame in a way that a
   *     brightness ramp does not, and an accelerating rhythm communicates "closing"
   *     without a number. It is the same grammar as the laser's blink — the tell the
   *     game has already taught by this point — so it needs no new lesson.
   *   - It is MAGENTA, per DESIGN.md's colour contract: magenta blinks, magenta
   *     kills. The water is the only lethal surface that used to break that rule.
   *
   * Costs a normally-flying player exactly nothing: `k` is gated on flood01, which is
   * zero for anyone who is not already 55 units into the bottom of the corridor, and
   * the cubic on the bar intensity keeps even the top of the band nearly dark. The
   * whole thing is 3 primitives and only while it is audible at all.
   */
  _renderFloodline(r, lo, hi, aa, time, flood01) {
    if (flood01 <= 0.02) return 0;
    const k = flood01;
    const kk = k * k;

    // Accelerating beat. Phase is integrated so the rate can change without the
    // pulse jumping — a discontinuity here would read as a dropped frame, not urgency.
    const hz = FLOOD_HZ0 + (FLOOD_HZ1 - FLOOD_HZ0) * kk;
    // Clamped: the alarm is usually dormant for many seconds at a stretch, so the
    // first frame after it re-arms would otherwise integrate the whole gap.
    const fdt = clamp(time - this._floodTime, 0, 0.1);
    this._floodPhase = (this._floodPhase + hz * fdt) % 1;
    this._floodTime = time;
    // Sharpened sine: a sawtooth-ish attack reads as a STROBE rather than a throb.
    const beat = Math.pow(0.5 + 0.5 * Math.sin(this._floodPhase * TAU), 3);
    const pulse = 0.35 + 0.65 * beat;

    const cx = (lo + hi) * 0.5, hw = (hi - lo) * 0.5;
    const y = FLOODLINE;
    let pc = 0;

    // The surface itself: a hard magenta line the full width of the view. This is the
    // element that says WHERE, and it is the one that was missing entirely.
    tint(SC0, PAL.magentaHot, (0.10 + 0.85 * kk) * pulse, 1);
    r.line(LAYER.NEON, cx - hw, y, cx + hw, y, 0.22 + 0.5 * k, SC0,
      { glow: 0.8 + 1.4 * k, glowRadius: 0.8 + 2.2 * k, soft: aa });
    pc++;

    // Haze lifting off the water. Sits ABOVE the line so it occupies the space the
    // player is falling through, which is where the eye already is.
    tint(SC1, PAL.magentaHot, 0.05 + 0.22 * kk * pulse, 1);
    r.rect(LAYER.FAR_GLOW, cx, y - 5.5 * k, hw, 5.5 * k, 0, SC1,
      { glow: 0.9, glowRadius: 3.0, soft: aa * 6 });
    pc++;

    // Last-ditch: inside the final third the surface throws a wide flare on every
    // beat. By here the vignette is also up, so the two channels agree and the read
    // is unambiguous — this is the frame that should feel like an alarm, not a mood.
    if (k > 0.62) {
      const kf = (k - 0.62) / 0.38;
      tint(SC2, PAL.magentaHot, 0.30 * kf * pulse, 1);
      r.line(LAYER.NEON, cx - hw, y, cx + hw, y, 2.4 + 3.0 * kf, SC2,
        { glow: 1.6, glowRadius: 4.0, soft: aa * 4 });
      pc++;
    }
    return pc;
  }

  // ---- structure ----------------------------------------------------------------
  _renderSolids(r, lo, hi, aa, time) {
    let pc = 0;
    const p = this._pSolid;
    for (let i = 0; i < p.active; i++) {
      const s = p.items[i];
      if (s.x + s.hw < lo || s.x - s.hw > hi) continue;

      // Silhouette. Near-black, alpha-blended: light does the drawing, not paint.
      const h = hash2(Math.round(s.x), Math.round(s.y));
      tint(SC0, h > 0.5 ? PAL.silhouette2 : PAL.silhouette, 1, 1);
      r.rect(LAYER.SOLID, s.x, s.y, s.hw, s.hh, s.rot, SC0, { soft: aa, radius: 0.25 });
      pc++;

      // Neon edge along the top face — the single line that cuts the shape out of
      // the dark. Flickers on a per-object noise seed, like real bad wiring.
      const flick = 0.82 + 0.18 * Math.sin(time * (2.1 + h * 3) + h * 40);
      // COLOUR CONTRACT. DESIGN.md assigns cyan to "player, tether, safe things" and
      // magenta to "hazards, danger". SOLIDs kill on contact, so ~38% of the lethal
      // geometry in the frame used to carry a cyanHot top edge — the same hue and the
      // same glow as the player's own body. Cyan is now reserved for the player, the
      // tether and the heavy (safe) anchor ring; structure reads violet and the faces
      // that will actually kill you read magenta.
      const edgeCol = h > 0.62 ? PAL.violetHot : PAL.magentaHot;
      tint(SC1, edgeCol, (0.34 + 0.20 * h) * flick, 1);
      const c = Math.cos(s.rot), sn = Math.sin(s.rot);
      const ex = s.hw * c, ey = s.hw * sn;
      const ux = s.hh * sn, uy = -s.hh * c;       // "up" in the solid's local frame
      r.line(LAYER.NEON, s.x - ex + ux, s.y - ey + uy, s.x + ex + ux, s.y + ey + uy,
        0.13, SC1, { glow: 1.0, glowRadius: 0.75, soft: aa });
      pc++;

      // Leading vertical face gets a dimmer accent so tall pylons read in depth.
      if (s.hh > 3) {
        tint(SC2, edgeCol, 0.15 * flick, 1);
        r.line(LAYER.NEON, s.x - ex + ux, s.y - ey + uy, s.x - ex - ux, s.y - ey - uy,
          0.09, SC2, { glow: 0.6, glowRadius: 0.6, soft: aa });
        pc++;
      }

      // Occasional signage: an amber slab that scrolls its own brightness.
      if (s.sign) {
        const scroll = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 1.4 + h * 12));
        tint(SC3, PAL.amberHot, 0.30 * scroll, 1);
        const sy = s.y + (s.hh > 3 ? -s.hh * 0.45 : 0);
        r.rect(LAYER.NEON, s.x, sy, Math.min(s.hw * 0.55, 2.4), Math.min(s.hh * 0.28, 0.5),
          s.rot, SC3, { glow: 1.1, glowRadius: 0.9, soft: aa });
        pc++;
      }
    }
    return pc;
  }

  // ---- orbs ---------------------------------------------------------------------
  _renderOrbs(r, lo, hi, aa, time) {
    let pc = 0;
    const p = this._pOrb;
    for (let i = 0; i < p.active; i++) {
      const o = p.items[i];
      if (!o.alive || o.collected) continue;
      if (o.x < lo || o.x > hi) continue;
      const ph = o.phase * TAU;
      const br = 0.75 + 0.25 * Math.sin(time * 3.1 + ph);

      // SHAPE LANGUAGE. An orb is a filled DISC; an anchor is an open RING; a hazard
      // is a bar or a blade. Orbs used to be a thin rotating ring around a small pip,
      // which is the anchor's silhouette in a different colour — at speed, in the
      // periphery, the two were the same object. The disc now carries the read and the
      // only ring left on screen means "you can tether here".
      //
      // Corona at 1.7 radii, not 2.4: orbs spawn in short runs, and at 2.4 adjacent
      // coronas overlapped and bloomed into one continuous amber lozenge, destroying
      // the count (which is the only thing the player needs from an orb line).
      tint(SC0, PAL.amberHot, 0.10 * br, 1);
      r.glow(LAYER.FAR_GLOW, o.x, o.y, o.r * 1.7, SC0);
      pc++;

      tint(SC1, PAL.amberHot, 0.30 + 0.10 * br, 1);
      r.circle(LAYER.NEON, o.x, o.y, o.r * 0.78, SC1,
        { glow: 0.7, glowRadius: o.r * 0.55, soft: aa });
      pc++;

      // Hot centre — the one element allowed to clip to white, kept small so the disc
      // still reads as a disc rather than as a ball of light.
      tint(SC2, PAL.amberHot, 0.55 + 0.20 * br, 1);
      r.circle(LAYER.NEON, o.x, o.y, o.r * 0.34, SC2,
        { glow: 0.75, glowRadius: o.r * 0.5, soft: aa });
      pc++;
    }
    return pc;
  }

  // ---- hazards ------------------------------------------------------------------
  _renderHazards(r, lo, hi, aa, time) {
    let pc = 0;
    const p = this._pHazard;
    for (let i = 0; i < p.active; i++) {
      const h = p.items[i];
      if (h.x + h.hw + 4 < lo || h.x - h.hw - 4 > hi) continue;
      switch (h.kind) {
        case 0: pc += this._drawLaser(r, h, aa, time); break;
        case 1: pc += this._drawDrone(r, h, aa, time); break;
        case 2: pc += this._drawSpinner(r, h, aa, time); break;
        default: pc += this._drawGate(r, h, aa, time); break;
      }
    }
    return pc;
  }

  /** Laser: emitter caps at both ends are always visible so you can read the threat
   *  line before it fires; a charge-up bloom telegraphs the shot ~0.4s early. That
   *  telegraph is the entire fairness contract of this hazard. */
  _drawLaser(r, h, aa, time) {
    let pc = 0;
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    const ax = h.x - h.hw * c, ay = h.y - h.hw * s;
    const bx = h.x + h.hw * c, by = h.y + h.hw * s;
    const tell = h.tell;

    // Emitter housings — dark blocks so the beam looks mounted to something.
    tint(SC0, PAL.silhouette2, 1, 1);
    r.rect(LAYER.SOLID, ax, ay, 0.85, 0.85, h.rot, SC0, { soft: aa, radius: 0.3 });
    r.rect(LAYER.SOLID, bx, by, 0.85, 0.85, h.rot, SC0, { soft: aa, radius: 0.3 });
    pc += 2;

    const capBr = h.alive ? 0.95 : 0.22 + 0.7 * tell * tell;
    tint(SC1, PAL.magentaHot, capBr, 1);
    r.circle(LAYER.NEON, ax, ay, 0.36, SC1, { glow: 1.1, glowRadius: 0.7, soft: aa });
    r.circle(LAYER.NEON, bx, by, 0.36, SC1, { glow: 1.1, glowRadius: 0.7, soft: aa });
    pc += 2;

    if (h.alive) {
      // Wide magenta halo + hot white core. The core is thin: danger reads as a wire.
      // Wide magenta halo + a thin hot core. The core stays narrow so the beam reads
      // as a wire of light; widening it just turns the whole lane white.
      tint(SC2, PAL.magentaHot, 0.42, 1);
      r.line(LAYER.NEON, ax, ay, bx, by, h.hh * 2.0, SC2,
        { glow: 1.3, glowRadius: 1.5, soft: aa });
      pc++;
      tint(SC3, PAL.hot, 1.05, 1);
      r.line(LAYER.NEON, ax, ay, bx, by, h.hh * 0.5, SC3,
        { glow: 0.7, glowRadius: 0.5, soft: aa });
      pc++;
    } else if (tell > 0) {
      // Charge-up: a pilot filament thickens and brightens into the shot.
      const k = tell * tell;
      tint(SC2, PAL.magentaHot, 0.14 + 0.42 * k, 1);
      r.line(LAYER.NEON, ax, ay, bx, by, h.hh * (0.16 + 0.45 * k), SC2,
        { glow: 0.6 + 0.8 * k, glowRadius: 0.5 + 0.8 * k, soft: aa });
      pc++;
      tint(SC3, PAL.magentaHot, 0.16 * k, 1);
      r.glow(LAYER.FAR_GLOW, h.x, h.y, h.hw * 0.55, SC3);
      pc++;
    } else {
      // Dormant: a barely-there tracer so the lane is still readable.
      tint(SC2, PAL.magenta, 0.10, 1);
      r.line(LAYER.NEON, ax, ay, bx, by, 0.05, SC2, { glow: 0.3, glowRadius: 0.3, soft: aa });
      pc++;
    }
    return pc;
  }

  /**
   * Drone: a dark hull with a magenta scanning eye-cone that sweeps as it patrols.
   *
   * BRIGHTNESS IS LOAD-BEARING HERE. The drone was the game's single biggest killer
   * (53% of deaths) and simultaneously the darkest object in it — its ring sat at
   * magentaHot * 0.52 against a laser core at hot * 1.05. The #1 threat must not be
   * the hardest thing to see. The ring is now the brightest magenta in the frame when
   * live, and the halo carries far enough to be findable in peripheral vision.
   *
   * The lethality cycle drives the whole read: live = hot ring, bright eye, wide
   * halo; spooling up = the ring reignites over DRONE_TELL seconds; dormant = dim
   * hull, dark eye, no halo, and genuinely non-lethal.
   */
  _drawDrone(r, h, aa, time) {
    let pc = 0;
    const ph = h.phase * TAU;
    // tell² so the reignition reads as a snap rather than a slow fade — the eye
    // should look like it is *coming back on*, not like it is dimly on the whole time.
    const k = h.tell * h.tell;
    const live = h.alive ? 1 : k;

    tint(SC0, PAL.silhouette2, 1, 1);
    r.ellipse(LAYER.SOLID, h.x, h.y, h.hw * 1.25, h.hh, 0, SC0, { soft: aa });
    pc++;

    tint(SC1, PAL.magentaHot, 0.18 + 0.92 * live, 1);
    r.ring(LAYER.NEON, h.x, h.y, h.hw * 1.3, 0.1 + 0.05 * live, SC1,
      { glow: 1.0 + 0.6 * live, glowRadius: 0.7, soft: aa });
    pc++;

    // Scan cone: points along travel, swinging on a slow oscillation. It retracts
    // with the duty cycle, so "the beam is off" is legible from the silhouette alone.
    if (live > 0.02) {
      const dir = Math.atan2(h.vy, h.vx || 1e-4) + Math.sin(time * 1.6 + ph) * 0.55;
      const cd = 5.5 * (0.35 + 0.65 * live);
      const cx = h.x + Math.cos(dir) * cd * 0.5;
      const cy = h.y + Math.sin(dir) * cd * 0.5;
      tint(SC2, PAL.magenta, 0.16 * live, 1);
      r.tri(LAYER.NEON, cx, cy, 2.0, cd * 0.5, dir - Math.PI * 0.5, SC2,
        { glow: 0.5, glowRadius: 1.1, soft: aa * 3 });
      pc++;
    }

    tint(SC3, PAL.hot, (0.85 + 0.35 * Math.sin(time * 6 + ph)) * (0.12 + 0.88 * live), 1);
    r.circle(LAYER.NEON, h.x, h.y, 0.26, SC3, { glow: 1.0, glowRadius: 0.6, soft: aa });
    pc++;

    tint(SC4, PAL.magentaHot, 0.05 + 0.30 * live, 1);
    r.glow(LAYER.FAR_GLOW, h.x, h.y, 3.6, SC4);
    pc++;
    return pc;
  }

  /** Spinner: a bright bar plus motion-smeared trailing copies behind its rotation. */
  _drawSpinner(r, h, aa, time) {
    let pc = 0;
    // Trailing copies first so the live bar sits on top.
    const back = -h.sgn * 0.16;
    for (let k = 3; k >= 1; k--) {
      tint(SC0, PAL.magentaHot, 0.055 * k, 1);
      r.rect(LAYER.NEON, h.x, h.y, h.hw, h.hh * 0.75, h.rot + back * k, SC0,
        { glow: 0.35, glowRadius: 0.9, soft: aa * 2, radius: h.hh * 0.5 });
      pc++;
    }
    tint(SC1, PAL.magentaHot, 0.62, 1);
    r.rect(LAYER.NEON, h.x, h.y, h.hw, h.hh, h.rot, SC1,
      { glow: 1.1, glowRadius: 1.0, soft: aa, radius: h.hh });
    pc++;

    tint(SC2, PAL.hot, 0.8, 1);
    r.circle(LAYER.NEON, h.x, h.y, h.hh * 1.1, SC2, { glow: 1.0, glowRadius: 0.8, soft: aa });
    pc++;

    tint(SC3, PAL.magentaHot, 0.09, 1);
    r.glow(LAYER.FAR_GLOW, h.x, h.y, h.hw * 0.9, SC3);
    pc++;
    return pc;
  }

  /** Gate half: a heavy block with a lit inner lip marking the edge of the moving gap. */
  _drawGate(r, h, aa, time) {
    let pc = 0;
    tint(SC0, PAL.silhouette, 1, 1);
    r.rect(LAYER.SOLID, h.x, h.y, h.hw, h.hh, h.rot, SC0, { soft: aa, radius: 0.3 });
    pc++;

    const lipY = h.y - h.sgn * h.hh;          // the face bordering the gap
    const br = 0.5 + 0.2 * Math.sin(time * 4 + h.phase * TAU);
    tint(SC1, PAL.magentaHot, br, 1);
    r.line(LAYER.NEON, h.x - h.hw, lipY, h.x + h.hw, lipY, 0.18, SC1,
      { glow: 1.3, glowRadius: 1.0, soft: aa });
    pc++;

    tint(SC2, PAL.magenta, 0.18, 1);
    r.line(LAYER.NEON, h.x, h.y - h.hh, h.x, h.y + h.hh, 0.07, SC2,
      { glow: 0.4, glowRadius: 0.5, soft: aa });
    pc++;
    return pc;
  }

  // ---- anchors ------------------------------------------------------------------
  /**
   * The single most important read on screen. A violet ring you can find in your
   * peripheral vision, a hot core, orbiting tick marks that give it a sense of
   * mechanism, and a broad soft halo underneath so it survives the bloom pass.
   * Heavy anchors get a second cyan ring — the ONE place cyan is allowed outside the
   * player and the tether, because a heavy anchor is precisely a "safe thing" in the
   * DESIGN.md sense. Decaying anchors get a depleting dot arc. A spent anchor is
   * signalled by value, not hue: violet at 0.55x, never cyan.
   */
  _renderAnchors(r, lo, hi, aa, time, already) {
    let pc = 0;
    const p = this._pAnchor;
    const cables = already + pc < PRIM_BUDGET * 0.72;
    for (let i = 0; i < p.active; i++) {
      const a = p.items[i];
      if (a.x < lo || a.x > hi) continue;
      const R = a.r;
      const ph = a.phase * TAU;
      const br = 0.72 + 0.28 * Math.sin(time * A_PULSE + ph);

      // Cable span to the next node in the chain: a slack catenary, drawn faintly.
      // It traces the route without ever being brighter than the anchors themselves.
      if (cables && a.hasNext) {
        const sag = Math.min(6, Math.abs(a.nx - a.x) * 0.16);
        const mx = (a.x + a.nx) * 0.5, my = (a.y + a.ny) * 0.5 + sag;
        tint(SC0, PAL.violet, 0.10, 1);
        let px = a.x, py = a.y;
        for (let s = 1; s <= 3; s++) {
          const t = s / 3, it = 1 - t;
          // Quadratic Bezier through the sagged midpoint.
          const qx = it * it * a.x + 2 * it * t * mx + t * t * a.nx;
          const qy = it * it * a.y + 2 * it * t * my + t * t * a.ny;
          r.line(LAYER.FAR_GLOW, px, py, qx, qy, 0.07, SC0,
            { glow: 0.35, glowRadius: 0.5, soft: aa * 2 });
          px = qx; py = qy;
          pc++;
        }
      }

      if (!a.alive) {
        // A depleted decaying node: a ghost outline so the player knows it will return.
        tint(SC1, PAL.violet, 0.16, 1);
        r.ring(LAYER.NEON, a.x, a.y, R * 0.95, 0.055, SC1,
          { glow: 0.3, glowRadius: R * 0.4, soft: aa });
        pc++;
        continue;
      }

      // Corona. Sized in anchor radii, and kept below the bloom threshold: its job is
      // to say "something is here" in peripheral vision, not to light the scene.
      tint(SC1, PAL.violetHot, 0.13 * br, 1);
      r.glow(LAYER.FAR_GLOW, a.x, a.y, R * 2.8, SC1);
      pc++;

      // Main ring — the shape the eye actually locks onto, so it must stay violet
      // rather than clipping to white.
      //
      // `used` used to shift the ring to cyan. It cannot: cyan is the player's own
      // hue and it also means "safe/heavy anchor" two lines below, so a spent node lit
      // up in the same colour as the thing that is safest to grab. Spent state is now
      // signalled with VALUE on the same hue — 0.55x brightness — which is the correct
      // axis for "this one is used up" anyway, since hue carries the taxonomy.
      tint(SC2, PAL.violetHot, (0.46 + 0.18 * br) * (a.used ? 0.55 : 1), 1);
      r.ring(LAYER.NEON, a.x, a.y, R, 0.16 + 0.04 * br, SC2,
        { glow: 1.0, glowRadius: R * 0.5, soft: aa });
      pc++;

      // Heavy anchors: a second, wider cyan ring. Bigger and unmistakably safer —
      // read as a distinct silhouette, not merely as more light.
      if (a.kind === 1) {
        tint(SC3, PAL.cyanHot, 0.26 * br, 1);
        r.ring(LAYER.NEON, a.x, a.y, R * 1.42, 0.08, SC3,
          { glow: 0.9, glowRadius: R * 0.4, soft: aa });
        pc++;
      }

      // Core pip. The one element per anchor allowed to bloom hot — small enough that
      // it stays a spark inside the ring instead of swallowing it.
      tint(SC3, PAL.white, 0.40 + 0.18 * br, 1);
      r.circle(LAYER.NEON, a.x, a.y, R * 0.2, SC3,
        { glow: 0.8, glowRadius: R * 0.34, soft: aa });
      pc++;

      // Orbiting tick marks — mechanism, and a readable rotation cue.
      const ta = time * A_TICK + ph;
      const tn = a.kind === 1 ? 4 : 3;
      tint(SC4, PAL.violetHot, 0.5 * br * (a.used ? 0.55 : 1), 1);
      for (let k = 0; k < tn; k++) {
        const an = ta + (k * TAU) / tn;
        const rr = R * 1.34;
        r.rect(LAYER.NEON, a.x + Math.cos(an) * rr, a.y + Math.sin(an) * rr,
          R * 0.2, R * 0.05, an, SC4, { glow: 0.7, glowRadius: R * 0.22, soft: aa });
        pc++;
      }

      // Decaying anchors: a depleting arc of dots around the ring.
      if (a.kind === 2) {
        const frac = clamp01(a.decayT / DECAY_TIME);
        const lit = Math.ceil(frac * DECAY_DOTS);
        for (let k = 0; k < DECAY_DOTS; k++) {
          const on = k < lit;
          tint(SC0, on ? PAL.amberHot : PAL.violet, on ? 0.45 * br : 0.10, 1);
          const an = -Math.PI * 0.5 + (k * TAU) / DECAY_DOTS;
          const rr = R * 1.75;
          r.circle(LAYER.NEON, a.x + Math.cos(an) * rr, a.y + Math.sin(an) * rr,
            R * 0.1, SC0, { glow: on ? 0.8 : 0.2, glowRadius: R * 0.25, soft: aa });
          pc++;
        }
      }
    }
    return pc;
  }
}
