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
  // Seconds of velocity to lead by, and the hard cap on that lead.
  // Load-bearing for whether SKILL PAYS. Difficulty is distance-driven, so flying
  // fast reaches every hazard band sooner in wall-clock while shrinking the reaction
  // window — speed was taxed twice and subsidised never. The old clamp saturated at
  // vx 42 (16 / 0.38), which is below cruise (~55 m/s), so above that going faster
  // bought literally ZERO extra vision. 34 / 0.46 keeps the lead growing to vx 74,
  // past anything the pump can reach, so seeing further is the reward for speed.
  CAMERA_LOOKAHEAD: 0.46,
  CAMERA_LOOKAHEAD_MAX: 34,
  CAMERA_ROLL: 0.055,      // radians of roll per unit of normalised lateral velocity
  CAMERA_Y_BIAS: -3.5,     // sit the player slightly below centre

  // ---- physics ------------------------------------------------------------
  GRAVITY: 62,
  AIR_DRAG: 0.055,         // per second, applied to speed
  // The swing plateau is set by TETHER_MAX_OMEGA * L_median (3.2 * 17 ~= 54 m/s), so
  // 99.2% of frames land under 80 m/s. At 120 the quadratic drag term and the
  // OVERSPEED brake were unreachable dead code and speed01 never left the bottom
  // half of its range. 92 sits just above the fastest measured frame (max ~82), so
  // the brake finally shapes the top end instead of guarding a ceiling nobody hits.
  TERMINAL_SPEED: 92,
  PLAYER_RADIUS: 0.85,     // collision; deliberately smaller than the sprite
  MIN_SPEED: 9,            // gentle forward assist so a stalled player recovers

  // The longest step the game will ever simulate. Below this framerate the game
  // runs in slow motion, which is the correct failure mode — the alternative is
  // teleporting through a wall.
  //
  // MAX_SIM_DT and PHYS_MAX_SUBSTEPS are ONE NUMBER expressed twice and must agree:
  // the player integrates at most PHYS_MAX_SUBSTEPS * PHYS_SUBSTEP seconds per frame,
  // while world.update/hazard motion take the full clamped dt. They did not agree —
  // 8 substeps is 33.3ms against a 50ms clamp, so at 20fps the player received 0.67x
  // the time the hazards flying at them did. The game got measurably HARDER the worse
  // the phone performed, which is precisely backwards. 12 * (1/240) == 1/20 exactly.
  MAX_SIM_DT: 1 / 20,
  PHYS_SUBSTEP: 1 / 240,
  PHYS_MAX_SUBSTEPS: 12,

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
  // anchor. Deliberately set OUTSIDE the perfect-arc window so holding travels but
  // deliberate release still owns the skill ceiling — measured, at 0.70 the hold bot
  // scored 21.5 perfect arcs/run and collapsed that distinction. Widening the window
  // to phi 0.44–1.37 swallowed the old 0.45, which would have handed every held swing
  // a (zero-quality) free arc plus its impulse; 0.38 puts the hop back underneath it,
  // so a held player sweeps THROUGH the window and out the far side without scoring.
  TETHER_AUTO_HOP_PHI: 0.38,
  TETHER_AUTO_HOP_MIN_TIME: 0.15,
  TETHER_AUTO_HOP_LOCKOUT: 0.7,   // stops ping-ponging back to the anchor just left

  /** Caps swing rate, enforced as a speed-dependent minimum rope length (L >= v/w).
   *  Load-bearing: above ~4.2 the player whips round short anchors and loses ground. */
  TETHER_MAX_OMEGA: 3.2,
  TETHER_REEL_SPIN: 0.8,       // exponent on the (L_prev/L) angular-momentum term
  TETHER_W_RECENT: 2.5,
  SOLID_ESCAPE_SPEED: 9.0,
  /**
   * Metres above the floodline at which the targeting assist starts to panic.
   *
   * At 26 the panic term only reached the bailout threshold within 11.4m of the
   * water — 0.19s of runway at the measured 62 m/s descent, i.e. after the crash was
   * already unavoidable. 44 opened it ~30m up, ~0.5s: enough to fire the hook AND
   * load the rope. Still not enough. At 44 the `metronome` bot — the tier closest to
   * a human still learning — drowned in 31% of runs, and 29 of its 32 sub-15s deaths
   * were drownings. The constraint was never REACHABILITY (the nearest anchor above
   * at the death frame is 19.1u, inside the 26u tether); it was TIME.
   *
   * 68, measured at 360 seeds: metronome drownings 111 -> 78 of 360, its sub-15s
   * drownings 51 -> 45, `hold` drownings 6 -> 3, and the top tier pays nothing
   * meaningful (smart median 538 -> 540m, gradient 10.9x -> 11.0x).
   *
   * CALIBRATION WARNING. This system is chaotically sensitive — changing the assist
   * changes anchor selection, which changes the entire trajectory — so it is
   * non-monotonic at low seed counts and 30- or even 90-seed sweeps here are NOISE.
   * A 90-seed sweep reported 70 as halving drownings (33 -> 16); at 360 seeds that
   * "halving" evaporated to 111 -> 92, and 70 cost the top tier 25m. 62/65/68 are a
   * flat plateau (drownings 90/92/78, smart 562/562/540) — anything in it is the same
   * choice. Re-tune at 360+ seeds only.
   *
   * WHY 68 AND NOT 65. Because the value is also load-bearing for `sim2 --avoid`, and
   * that audit is chaotic in the same way for the same reason: each assist value
   * yields a different trajectory set, and some of those land on a death the audit's
   * coarse lattice (2.2s lookback, 0.1s probe step, 3 dwell lengths) cannot escape.
   * Scanning 90 seeds, 60/62/64/68 are clean while 65/66/70 each flag one or two. At
   * 180 seeds only 68 is clean across all three bots — AND SO IS NOTHING ELSE,
   * INCLUDING THE OLD VALUE OF 44, which flags metronome seed 155. "Zero unavoidable
   * deaths" has been green because nobody ran the audit past 90 seeds, not because the
   * property is absolute. 68 is therefore strictly better than what shipped, and the
   * honest statement of the invariant is probabilistic, not categorical.
   *
   * This is HALF the fix. The assist buys the player a wider band in which the game
   * will try to save them; it does not tell them they are in it. See the floodline
   * alarm in world.js `_renderFloodline` and FLOOD_WARN_BAND below.
   */
  TETHER_FLOOD_PANIC: 68,

  /**
   * THE FLOODLINE ALARM — world units above the water at which the tell begins.
   *
   * Drowning was the only lethal thing in the game with no telegraph, and it was the
   * biggest single killer of the mid tier (31% of runs, and 29 of its 32 sub-15s
   * deaths). The mechanic is not unfair; it was UNREADABLE. Measured at the death
   * frame: descent 76 m/s, 0.70s spent inside the old 44u panic band, 0.27s inside
   * the last 20u, and the latest input that still saves the run lands 0.40s before
   * impact. The only visual was the danger vignette, ramped over FLOODLINE-13 and
   * then SQUARED — which at 76 m/s is 0.17 SECONDS of warning. PERFECT_ETA_LEAD
   * already sets this project's standard at 250ms on the grounds that anything under
   * human visual reaction time is a cue that is late BY CONSTRUCTION. The water was
   * a third of that.
   *
   * For contrast, a hazard — the thing that IS supposed to kill you — gets a
   * 0.4-0.45s charge-up tell plus a 0.83s median on-screen presence before contact.
   * 55u at the measured 76 m/s descent is 0.72s, which puts the water on the same
   * clock as a laser. It costs a normally-flying player nothing, because a normally-
   * flying player is never in the band.
   *
   * Deliberately WIDER than the ~46u the backdrop's flood mist already ramps over.
   * That mist is a soft ambient wash and it is also on whenever the player is
   * legitimately flying the catch row, so it is atmosphere, not an alarm, and it
   * cannot be the only signal. The alarm proper is `_renderFloodline` in world.js:
   * the water surface itself lights up and beats, on a rate that accelerates as you
   * sink, which is a different visual channel (rhythm) from anything else on screen.
   */
  FLOOD_WARN_BAND: 55,
  /** Beats per second of the floodline alarm at the top of the band and at the water.
   *  A pulse that ACCELERATES reads as urgency without needing a number attached, and
   *  the rate is legible in peripheral vision, which a brightness ramp is not. */
  FLOOD_WARN_HZ: [1.1, 5.0],

  // ---- perfect arc --------------------------------------------------------
  // While attached and taut the velocity heading is exactly (PI/2 - phi), where phi
  // is the rope bearing, so this angle window IS a phi window: 0.44-1.37 rad. It was
  // 0.61-1.31, open a median 0.22s (p10 0.08s) — shorter than human reaction time,
  // so the window could only ever be hit by luck or by muscle-memory rhythm. Widened
  // to ~0.93 rad it stays open ~0.29s AND, with the predictive cue in player.js
  // (perfectETA/perfectCue), gets 0.35s of lead. Auto-hop at phi 0.45 still sits
  // (just) outside the window, so "hold" never scores an arc and L1/L2 stay distinct.
  PERFECT_ANGLE_MIN: 0.20,  // 11.5°
  PERFECT_ANGLE_MAX: 1.13,  // 65°
  PERFECT_MIN_SPEED: 26,
  PERFECT_IMPULSE: 9,
  /** Seconds of lead time on the predictive perfect-arc cue. Human visual reaction is
   *  ~250ms; anything under that is a cue that is late BY CONSTRUCTION. */
  PERFECT_ETA_LEAD: 0.35,
  // CHARGE INCOME. The meter has to fill inside a run or OVERDRIVE does not exist, and
  // it must not fill twice over or overdrive becomes the default state rather than an
  // event. The target is: one overdrive in a good run with time left to spend it, two
  // in a great one.
  //
  // Rebudgeted upward because the ~17% of income that used to come from ANCHOR grazes
  // was deleted outright (see GRAZE_ANCHORS) and because the run is no longer padded
  // with 400 metres of unloseable warm-up to accrue it in. Measured on the `smart` bot
  // at 0.032/0.042/0.052/0.060: 0.3 / 0.5 / 0.8 / 1.0 triggers per run. 0.052 is the
  // knee — it is where a well-flown run reliably earns one overdrive and a great one
  // earns two, and where the smart/hold score gradient peaks (11.2x).
  //
  // Note this is now the DOMINANT source (measured 57% of income). That is correct and
  // the HUD says so: perfect arcs are the skill the game is about, and the meter should
  // read as "this is what flying well buys you".
  PERFECT_CHARGE: 0.052,

  // ---- grazing ------------------------------------------------------------
  // DESIGN.md L3 is "passing within GRAZE_RADIUS of neon geometry or a hazard without
  // touching it... RISK = REWARD". The risk clause is the whole layer.
  //
  // Anchors were made grazable to rescue a dead mechanic (2.0 grazes/run) and it
  // worked far too well: measured 27.1 of 28.9 grazes per run — 94% — were anchors.
  // The GRAZE popup fired ~30x a run for flying past the things you are actively
  // aiming at, which carries no risk at all, and it buried the ~2 genuinely dangerous
  // hazard grazes in noise. Anchors are TARGETS, not threats; skimming one is L4 line
  // choice, and L4 already pays in the line you get to fly next.
  //
  // Grazing is now exactly two things, both of which can kill you: a LIVE HAZARD, and
  // ARCHITECTURE (which is only reachable at all since the flight-clearance band was
  // narrowed to its inner envelope — see ARC_SAG_BAND).
  GRAZE_ANCHORS: false,
  GRAZE_RADIUS: 3.4,
  GRAZE_COOLDOWN: 0.9,      // per object
  GRAZE_CHARGE: 0.02,
  /** A hazard graze is worth 5.5 architecture grazes and 2x a perfect arc. It is the
   *  only reward in the game you can only collect by being close enough to die. */
  GRAZE_CHARGE_HAZARD: 0.11,
  /**
   * Charge from an orb — and the low tier's honest lever.
   *
   * Orbs reward LINE CHOICE, not precision, so their income is inverted against skill:
   * measured collections per run are hold 18.0, smart 13.9, because a slower flier
   * passes through more of them per metre. Raising this therefore lifts the players who
   * cannot reliably score arcs without inflating the one who can, which is exactly the
   * shape needed — at 0.020 the fraction of runs that ever saw overdrive was
   * smart 73% / metronome 22% / hold 8%, i.e. the centrepiece of the game was
   * effectively invisible below the top tier. At 0.040 it is 85% / 37% / 32% and the
   * smart-vs-hold score gradient still reads 12.2x. Going further (0.050) pulls hold
   * level with metronome, which flattens the middle again.
   */
  ORB_CHARGE: 0.040,

  // ---- overdrive ----------------------------------------------------------
  OVERDRIVE_DURATION: 6.0,
  OVERDRIVE_TIMESCALE: 0.85,
  OVERDRIVE_SCORE_MULT: 2,
  /** Seconds before overdrive expires during which a perfect arc is an EXIT.
   *  Outside this window an arc scores (doubled) and does nothing else.
   *
   *  This number exists because the showpiece used to cancel itself for playing well.
   *  "Ending overdrive with a perfect arc refunds charge" meant ANY arc ended it, and
   *  a skilled player takes one every ~0.9s, so the 6-second reward had a MEDIAN LIVED
   *  DURATION OF 1.4s (n=50) — and the better you were, the less of it you got. The
   *  fix keeps the L5 skill expression but moves it from "don't play well" to "time
   *  your exit": arcs during overdrive are free until the meter is nearly out, and the
   *  refund then scales with how late in the window you land it. Bank it too late and
   *  overdrive simply expires and you get nothing. */
  OVERDRIVE_EXIT_WINDOW: 1.2,
  /**
   * Seconds a FULL meter will wait for a perfect arc to spend it before firing itself.
   *
   * Banking charge and cashing it on an arc is the L5 decision and it stays. But it was
   * an absolute wall for the tier that most needs to see the showpiece: measured, the
   * `hold` bot earns 0.8 of a meter per run and lands 5.5 arcs in 39 seconds, so it
   * routinely died with the meter armed and full, having never scored an arc after
   * filling it. Overdrive triggers per run were 0.9 / 0.2 / 0.0 across smart / metronome
   * / hold — the centrepiece of the game was invisible to a beginner for an entire run.
   *
   * A skilled player never sees this timer: they take an arc every ~0.9s, so they still
   * choose the moment and still get to hold it for a dense hazard cluster. It only ever
   * fires for someone who could not have spent it deliberately anyway, which restores
   * DESIGN.md's original "at 100% it auto-triggers" promise as the floor under the
   * mechanic rather than as a replacement for it. Adds no input.
   */
  OVERDRIVE_ARM_TIMEOUT: 3.5,
  /** Charge refunded by a perfectly-timed exit arc. Raised from 0.25 because it is now
   *  conditional AND scaled — a barely-legal exit pays OVERDRIVE_REFUND_FLOOR of it. */
  OVERDRIVE_REFUND: 0.35,
  OVERDRIVE_REFUND_FLOOR: 0.4,

  // ---- combo / score ------------------------------------------------------
  // The multiplier was a formality: at 1.9 combo events/s against a 4.0s window the
  // decay could never fire, so ×10 was reached in ~10s and held for 33% of all
  // frames. 2.2s is under the widest observed gap between events, 5 steps makes the
  // climb cost something, and 12 gives the ceiling somewhere to go. The decay must
  // step DOWN one level per window (main.js) rather than resetting to ×1 — that is
  // what turns a long flat L4 flight into a priceable risk instead of a wipe.
  COMBO_WINDOW: 2.2,
  COMBO_PER_STEP: 5,
  /**
   * THE FIRST STEP IS CHEAPER. `COMBO_EARLY_N` steps cost `COMBO_EARLY_STEP` events
   * each; every step above them costs the full `COMBO_PER_STEP`. So the ladder is
   * ×2 at 3, ×3 at 6, ×4 at 11, ×5 at 16, +5 thereafter.
   *
   * The combo multiplier is the only mid-run "this is going well" readout the game
   * has, and it was INVISIBLE below expert. Measured share of a run spent at ×1 —
   * where the badge does not render AT ALL, so the signal is not merely low, it is
   * absent: smart 14%, metronome 51%, hold 79%. The same tiers have the worst dead
   * air (median gap between scoring events: smart 0.5s, metronome 0.8s, hold 0.9s
   * with 31% of gaps over 2s and a 13.0s worst case). Feedback was distributed
   * INVERSELY with need — the player who could least tell whether they were doing
   * well got the least help telling.
   *
   * At a flat 5 a beginner needs five combo events inside a rolling 2.2s window to
   * see a ×2 at all. Three is reachable. Measured at 720 seeds, time at ×1 falls to
   * smart 9% / metronome 32% / hold 64%.
   *
   * THIS CHANGES NO TRAJECTORY. Score does not feed back into physics, so every
   * distance, death cause and death time is bit-identical to the flat ladder; the
   * only thing that moves is the number on screen and how often the badge is up.
   *
   * WHY ONLY ONE STEP. Discounting the second step as well (N=2) goes further —
   * metronome 32% -> 26%, hold 64% -> 59% — but the smart/hold score gradient falls
   * 10.2x -> 8.6x against 9.1x for one step. The gradient is the project's
   * load-bearing assertion that skill pays, one step buys ~75% of the readability
   * win for ~65% of the gradient, and the goal was specifically "make ×2 reachable
   * early", not "make the whole early ladder cheap". N=1 is exactly that goal and
   * nothing more.
   */
  COMBO_EARLY_STEP: 3,
  COMBO_EARLY_N: 1,
  COMBO_MAX_MULT: 12,
  SCORE_PERFECT: 250,
  SCORE_GRAZE: 40,
  /** Grazing a live hazard is the only graze that can kill you. Risk = reward, so it
   *  pays 4.5x what skimming architecture does. */
  SCORE_GRAZE_HAZARD: 180,
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
  // the straight chord — a swing dips well below the line joining two anchors. How far
  // it dips depends entirely on when you released, so this is a BAND of sags (negative
  // entries are the RISE band: a late release throws you above the chord).
  ARC_SAG: 12,              // world units the sampled arc dips below the chord
  ARC_SAMPLES: 9,
  /**
   * Multiples of ARC_SAG the generator GUARANTEES clear of structure — the INNER
   * envelope only.
   *
   * SAG_BAND models uncertainty in release timing. It used to run -1.85..+1.55, i.e.
   * the generator evacuated the ENTIRE uncertainty envelope: roughly ±20 units around
   * every chord, wider than the 46-unit view. The consequence was that no solid was
   * ever within reach of any flight path, and so across 30 seeds x 3 bots there were
   * ZERO wall deflects — DEFLECT_ANGLE, DEFLECT_RESTITUTION, DEFLECT_SCRUB,
   * DEFLECT_COOLDOWN, SOLID_SAFE_DIST, SOLID_ESCAPE_SPEED, ~50 lines of player.js, the
   * `deflect` event and its FX and audio were all unreachable dead code, and
   * DESIGN.md's "hard wall face" failure mode did not exist.
   *
   * Clearing only the inner envelope keeps the property that matters — the NOMINAL,
   * well-flown line is always guaranteed clear, so no death is ever unavoidable — while
   * letting the extremes of the envelope meet architecture. A shallow hit out there
   * deflects (and reads as skill); only a square one at speed kills. That is the entire
   * point of the forgiveness machinery below.
   */
  // These are not a model, they are a MEASUREMENT. Sampling every free-flight frame of
  // 90 runs and expressing the player's offset from the anchor chain in units of
  // ARC_SAG gives, on the rise side (negative = above the chord):
  //     smart p1% -1.22   metronome p1% -1.68   hold p1% -2.18
  // and on the sag side: smart p95% +2.46. So -1.22..+2.5 is, empirically, where a
  // well-flown line lives; that is what gets the guarantee. Everything past it is a
  // release that went wide, which is exactly what should be able to find a wall.
  // (The old -1.85..+1.55 was a guess, and on the sag side it did not even cover the
  // median frame — the player is more than 0.95 ARC_SAG below the chord about half the
  // time. It only looked safe because UNDER_DROP holds structure 59 units below.)
  ARC_SAG_BAND: [-1.22, -0.9, -0.55, -0.2, 0.3, 0.8, 1.3, 1.9, 2.5],
  /** The full envelope, still evacuated of anything that presents a HARD FACE. */
  ARC_SAG_BAND_FULL: [-1.85, -1.3, -0.75, -0.3, 0.4, 0.8, 1.15, 1.55],
  /** Clearance radius applied around each sampled arc point. Hard faces get the wide
   *  one because the sampled arc is only an approximation of the flight path. Skim
   *  decks get a tight one — their band is set from measured percentiles, not from a
   *  model, so it does not need a second safety factor stacked on top of it. */
  SKIM_DECK_LINE_CLEAR: 2.0,

  // ---- skim decks ---------------------------------------------------------
  // Narrowing the clearance band alone changed nothing: measured still-zero deflects,
  // because clearance was never what kept structure away from the flight line —
  // PLACEMENT was. Every catwalk was authored 27m+ above the chain or 59m below it, so
  // it sat outside even the old envelope by construction.
  //
  // Skim decks are architecture deliberately authored into the gap between the
  // guaranteed-clear inner envelope and the outer edge of the release-timing envelope.
  // Fly the nominal line and you never touch one. Release late and ride high, or sag
  // deep out of a sloppy swing, and you brush a gantry deck — which deflects, costs a
  // little speed, and reads as skill. They are axis-aligned to the local chord so the
  // face you meet runs ALONG your direction of travel; that is what makes the contact
  // shallow by construction rather than by luck.
  SKIM_DECK_MAX: 3.0,       // decks per chunk at diff 1 (0 in the tutorial)
  SKIM_DECK_NEAR: 1.45,     // × ARC_SAG: inner edge of the skim band
  SKIM_DECK_FAR: 2.15,      // × ARC_SAG: outer edge
  SKIM_DECK_HW: [5, 11],
  SKIM_DECK_HH: [0.5, 1.0],

  // ---- world generation ---------------------------------------------------
  CHUNK_WIDTH: 60,
  CHUNKS_AHEAD: 5,
  CHUNKS_BEHIND: 2,
  FLOODLINE: 46,            // +Y is down; falling past this kills
  // ---- THE DIFFICULTY CURVE -----------------------------------------------
  // Everything below is in WORLD UNITS. Displayed metres are world units / 2.
  //
  // These two numbers were structurally broken, not merely mistuned. The whole shape
  // of the curve sat outside the distance players actually reach:
  //   - TUTORIAL_DIST 800wu expired at 16.5s for the worst-case player but at 8s for a
  //     good one, and — because SOLID_SAFE_DIST tracks it — made architecture
  //     non-lethal for 45% of the MEDIAN RUN (1794wu). DESIGN.md's promise is fifteen
  //     SECONDS for an L1 player, not four hundred metres for everyone; the two had
  //     drifted apart. Measured: the `hold` bot (never releases, never aims) reaches
  //     340wu at ~16.5s, so 340 is the promise, exactly.
  //   - DIFF_SCALE 2200wu put diff at only 0.36 at the END of a median run. Nearly two
  //     thirds of the authored difficulty range was unreachable — content that ships
  //     and is never seen is content that does not exist. 900 puts diff ~0.31 at 15s
  //     and ~0.68 at 30s, so the ramp is felt across the distance actually played while
  //     staying asymptotic and never reaching 1.
  //     RE-MEASURED at 720 seeds: diff where a median run ENDS is smart 0.55 (1064wu),
  //     metronome 0.46 (894wu), hold 0.42 (828wu); smart's p90 run reaches ~0.80. The
  //     "~0.79 where a median run ends" this comment used to claim was the p90 number
  //     stated as a median one. About 40% of the authored range remains unreachable —
  //     deliberately, as headroom for an exceptional run, but it should be counted as
  //     headroom and not as shipped difficulty.
  TUTORIAL_DIST: 340,
  WORLD_DIFF_SCALE: 900,
  // Distance before each hazard kind unlocks. Measured on the old values (1000 / 1900 /
  // 2900): moving gates appeared in 0% of runs and spinners in 30% — two of the four
  // threat types were, in practice, not in the game. Re-anchored to the new curve so
  // the full mix is reachable inside a good run and each kind still arrives as its own
  // distinct beat rather than all at once.
  // Re-measured at 720 seeds against the LIVE run (kinds actually met inside 26u,
  // not kinds generated inside a nominal distance). At 850/1150 the exposure was
  //     smart  laser 100  drone 83  spinner 68  gate 30
  //     metro  laser  84  drone 63  spinner 43  gate 18
  //     hold   laser 100  drone 66  spinner 38  gate  2
  // A beginner met a moving gate in one run in fifty: content that ships and is never
  // seen is content that does not exist.
  //
  // THE BUDGET IS FIXED, SO THESE LEVERS TRADE AGAINST EACH OTHER RATHER THAN ADD.
  // Hazard density per chunk is capped by placement, so unlocking a kind earlier does
  // not create hazards — it re-labels them. Pulling BOTH hard (to 850/650, which a
  // static per-distance harness scored as the cheapest content win available)
  // collapses the drone instead: smart drone 83% -> 60%, hold 66% -> 38%, for a
  // TOTAL variety (summed kind-exposure) of 7.12 against 6.95 — a 2% gain bought with
  // 9% of smart's distance and 12% of hold's. It is not a win, it is a reshuffle.
  //
  // The two levers are separable and only one of them is cheap:
  //   gate 1150 -> 1000 (spinner held): gate 30/18/2 -> 44/26/13, drone UNTOUCHED,
  //     median distance 537/446/414 -> 530/449/413. Nearly free.
  //   spinner 850 -> 750 (gate held): spinner 68/43/38 -> 75/53/49 but drone starts
  //     to erode and `hold` loses 6% of its run.
  // 1000/800 takes the whole of the cheap lever and only the flat part of the dear
  // one: gate 41/29/11, spinner 72/46/44, drone 83/62/70 (preserved), total variety
  // 6.95 -> 7.23. Cost is 5% of smart's median and 10.9x -> 10.2x of gradient; `hold`
  // pays nothing (414 -> 415). The beginner's gate exposure improves 5.5x, which is
  // the actual hole being patched.
  WORLD_HAZ_DRONE_X: 620,
  WORLD_HAZ_SPIN_X: 800,
  WORLD_HAZ_GATE_X: 1000,
  /**
   * No hazard of any kind exists before this — not even a rolled one.
   *
   * Distinct from TUTORIAL_DIST (340), which governs archetypes, anchor spacing and
   * structure margins. Difficulty structure starts at 340; HAZARDS wait a little longer
   * so their introduction can be authored rather than rolled.
   *
   * The number is the L1 promise, measured. Over 200 seeds the `hold` bot — which never
   * releases and therefore cannot route around anything — is at median 297wu at t=15s,
   * p99 421, MAX 439. A beam at 366 (the previous value) sat inside that spread and
   * killed hold inside 15 seconds in 2 runs out of 60. 480 clears the measured worst
   * case with margin, so the first lethal object in the game is unreachable before the
   * grace period expires BY CONSTRUCTION rather than by luck.
   */
  WORLD_FIRST_HAZ_X: 480,
  // ---- the authored first hazard ------------------------------------------
  // The first threat a player ever meets is the one that teaches them what a threat
  // IS, and it was a dice roll: hazard density just past the tutorial is ~0.24 per
  // chunk, so the first encounter landed at a random distance, at a random size, in a
  // random archetype, and 10% of runs never had one at all. A teaching beat cannot be
  // rolled.
  //
  // The first chunk past TUTORIAL_DIST now always contains exactly ONE laser, placed
  // across the flight line so it must be acknowledged, and tuned to be survivable on
  // sight by someone who has never seen one: lethal for only ON of a long period, so
  // it is dark ~78% of the time, behind the standard LASER_TELL charge-up. A first
  // timer almost certainly flies through while it is dark and sees it snap on behind
  // them — which is the lesson (magenta blinks, magenta kills, the blink is a clock)
  // delivered without costing them the run. It is deliberately only half the corridor
  // wide, so there is a line past it as well as a moment.
  // Tuned down from 0.22/8 by measurement: at that strength the teaching beam killed
  // 20% of `smart` runs inside 15 seconds, against 7% before it existed — a first
  // lesson should not be the most lethal object in the opening. 0.14/6 puts that back
  // to 10% and costs nothing below it (0.10 measured identical), while still reading as
  // a real beam across a quarter of the corridor.
  WORLD_FIRST_LASER_PERIOD: 3.6,
  WORLD_FIRST_LASER_ON: 0.14,   // lethal fraction — 0.50s lethal, 3.10s dark
  WORLD_FIRST_LASER_HW: 6,

  // ---- collision forgiveness ----------------------------------------------
  // Measured from the surface TANGENT: a hit shallower than this deflects instead
  // of killing. Generous on purpose — skimming structure should read as skill.
  //
  // Raised from 0.80 (46°) now that architecture is genuinely reachable. To be 20
  // units above the chord at all you have to be climbing or falling steeply, so the
  // approach to a gantry deck is rarely tangential and at 46° almost every contact
  // was a kill: measured 11-12 solid deaths per 30 runs for the mid and low tiers,
  // against a baseline of 6 and 0. At 66° the same contacts mostly bounce (solid
  // deaths 8 and 7) while a genuinely square hit — inside 24° of head-on — still kills,
  // which is DESIGN.md's "hard wall face" failure mode and worth keeping.
  DEFLECT_ANGLE: 1.15,      // ~66°
  DEFLECT_RESTITUTION: 0.35,
  DEFLECT_SCRUB: 0.9,
  DEFLECT_COOLDOWN: 0.18,
  /**
   * Below this distance solids never kill, only deflect.
   *
   * Deliberately LONGER than TUTORIAL_DIST, which is a reversal: threats now arrive in
   * order of how readable they are. A hazard is magenta, it blinks, it has a charge-up
   * tell, and it is the first thing that can kill you (from ~340). Architecture is a
   * near-black silhouette with one neon edge and no tell at all, so it stays a bounce
   * until 560 — measured, this is exactly the band where solid deaths inside the first
   * 15 seconds go to zero for every bot, and it costs the top tier nothing (smart's
   * median distance is identical at 340 and 560) while giving the two lower tiers
   * ~6% more run. The first thing that kills you should be the thing that flashed
   * at you first.
   */
  SOLID_SAFE_DIST: 560,

  // ---- feel ---------------------------------------------------------------
  // 45ms fired 1.5x/second is 5.0% of wall clock spent frozen; it read as dropped
  // frames, not as punch. 22ms is one 60Hz frame of hold — felt, not seen.
  HITSTOP_PERFECT: 0.022,
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
