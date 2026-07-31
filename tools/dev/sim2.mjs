// ARCLIGHT — the gameplay acceptance test.
//
// Classifies HOW runs end across many seeds and three bots, and measures the whole
// reward economy while it does it. Everything here is deterministic: a seed plus a bot
// plus an input-override schedule is a bit-exact replay, which is what makes the
// avoidable-death audit (--avoid) possible at all.
//
//   node tools/dev/sim2.mjs                  # default: 30 seeds, 3 bots, 60s cap
//   node tools/dev/sim2.mjs --cap 90         # see past the truncation
//   node tools/dev/sim2.mjs --seeds 60
//   node tools/dev/sim2.mjs --avoid          # + unavoidable-death audit (slow)
//
// THE LOAD-BEARING ASSERTION is that `smart` beats `hold` by a wide margin, in BOTH
// score and distance. If it stops doing that, skill has stopped paying and the game is
// broken however good it looks.
//
// NOTE — the `Run` class below MIRRORS the run state + event sink in src/main.js
// (scoring, combo, charge, overdrive, invulnerability, overdrive time dilation).
// It has to: main.js cannot be imported headlessly (it constructs WebGL on import).
// If you change the sink in main.js, change it here. Everything numeric is read from
// CFG so only the *structure* can drift.

// ---- CLI ------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : Number(v);
};
const CAP    = flag('cap', 60);
const SEEDS  = flag('seeds', 30);
const AVOID  = argv.includes('--avoid');
const QUIET  = argv.includes('--quiet');
const TERSE  = argv.includes('--terse');

// `--set KEY=VALUE` overrides a CFG entry before world.js and player.js are loaded, so
// their module-scope constants pick it up. This is why the imports below are dynamic:
// a static import is hoisted above the mutation and the sweep would silently no-op.
// One config point per process; drive parameter sweeps from a shell loop.
const { CFG } = await import('../../src/core/config.js');
const sets = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--set') continue;
  const [k, v] = String(argv[++i]).split('=');
  CFG[k] = v.startsWith('[') ? JSON.parse(v) : Number(v);
  sets.push(`${k}=${v}`);
}
const { World } = await import('../../src/game/world.js');
const { Player } = await import('../../src/game/player.js');
const { circleVsOBB, clamp, clamp01, damp } = await import('../../src/core/math.js');

const DT = 1 / 60;
/** World units within which a lethal object counts as "a threat has arrived". */
const THREAT_R = 26;
/**
 * Percent of `metronome` runs allowed to end in a sub-15s drowning.
 *
 * `hold` cannot drown (it never releases), so it cannot police this. Measured at 720
 * seeds: 13.3% before the floodline work, 12.5% after. 14% is a regression tripwire
 * with roughly a point and a half of headroom, not a target — the number to watch is
 * whether it moves, and it should only ever move DOWN.
 *
 * Note the headline win here is NOT this percentage, which the assist band alone only
 * shifts a little. It is that the drownings that remain are now TELEGRAPHED: the
 * on-screen warning before one goes from 0.20s to 1.20s. Fairness was never the
 * problem (--avoid says every one of these was escapable); readability was.
 */
const EARLY_DROWN_BUDGET = 14;

// ---- combo ladder — MIRROR OF src/main.js. See the block comment there. ----------
// The first CFG.COMBO_EARLY_N steps cost CFG.COMBO_EARLY_STEP events; the rest cost
// CFG.COMBO_PER_STEP. The two functions are exact inverses and must stay so.
const CB_E = () => CFG.COMBO_EARLY_STEP ?? CFG.COMBO_PER_STEP;
const CB_N = () => CFG.COMBO_EARLY_N ?? 0;
function multForCombo(c) {
  const e = CB_E(), n = CB_N(), s = CFG.COMBO_PER_STEP, knee = n * e;
  const m = c < knee ? 1 + Math.floor(c / e) : 1 + n + Math.floor((c - knee) / s);
  return clamp(m, 1, CFG.COMBO_MAX_MULT);
}
function comboForMult(m) {
  const e = CB_E(), n = CB_N(), s = CFG.COMBO_PER_STEP;
  if (m <= 1) return 0;
  return m - 1 <= n ? (m - 1) * e : n * e + (m - 1 - n) * s;
}
const HAZ_KINDS = ['laser', 'drone', 'spinner', 'gate'];

// ---------------------------------------------------------------------------------
// Run state — mirror of src/main.js. See header note.
// ---------------------------------------------------------------------------------
class Run {
  constructor(player) {
    this.p = player;
    this.score = 0;
    this.combo = 0; this.comboTimer = 0; this.multiplier = 1; this.multiplierPeak = 1;
    this.charge = 0; this.chargeFull = false; this.chargeFullT = 0;
    this.overdrive = 0; this.overdriveActive = false;
    this.timescale = 1;
    // telemetry
    this.perfects = 0; this.orbs = 0; this.deflects = 0; this.attaches = 0;
    this.grazeHaz = 0; this.grazeSolid = 0; this.grazeAnchor = 0;
    this.odTriggers = 0; this.odLived = [];     // seconds each overdrive actually lasted
    this.odActiveTime = 0; this.odStart = 0; this.odAuto = 0;
    this.chargeFrom = { perfect: 0, graze: 0, grazeHaz: 0, orb: 0 };
    this.chargeOffered = 0; this.chargeWasted = 0;
    this.t = 0;
  }

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

  addCharge(amount, bucket) {
    // Charge earned while overdrive is up is DISCARDED — the meter is repurposed as
    // the overdrive countdown. Worth measuring: for a strong player that is ~18% of
    // the run spent earning at peak rate into a bin, which is most of why raw income
    // and realised triggers disagree so badly.
    this.chargeOffered += amount;
    if (this.overdriveActive) { this.chargeWasted += amount; return; }
    const before = this.charge;
    this.charge = clamp01(this.charge + amount);
    if (bucket) this.chargeFrom[bucket] += this.charge - before;
    if (this.charge >= 1 && !this.chargeFull) { this.chargeFull = true; this.chargeFullT = 0; }
  }

  startOverdrive() {
    this.overdriveActive = true;
    this.chargeFull = false;
    this.chargeFullT = 0;
    this.overdrive = CFG.OVERDRIVE_DURATION;
    this.charge = 1;
    this.p.invuln = true;
    this.odTriggers++;
    this.odStart = this.t;
  }

  endOverdrive(refund01) {
    if (!this.overdriveActive) return;
    this.overdriveActive = false;
    this.overdrive = 0;
    this.p.invuln = false;
    this.charge = refund01 > 0 ? CFG.OVERDRIVE_REFUND * refund01 : 0;
    this.chargeFull = false;
    this.chargeFullT = 0;
    this.odLived.push(this.t - this.odStart);
  }

  /** Per-frame, mirrors main.js update(). Returns the simulation dt to advance by. */
  step(rawDt) {
    let target = this.overdriveActive ? CFG.OVERDRIVE_TIMESCALE : 1;
    this.timescale = damp(this.timescale, target, 8, rawDt);
    const dt = rawDt * this.timescale;
    this.t += dt;
    this.addScore(dt * this.p.speed * CFG.SCORE_DIST_RATE);
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        if (this.multiplier > 1) {
          this.multiplier--;
          this.combo = comboForMult(this.multiplier);
          this.comboTimer = CFG.COMBO_WINDOW;
        } else this.combo = 0;
      }
    }
    if (this.overdriveActive) {
      this.odActiveTime += dt;
      this.overdrive -= dt;
      this.charge = clamp01(this.overdrive / CFG.OVERDRIVE_DURATION);
      if (this.overdrive <= 0) this.endOverdrive(0);
    } else if (this.chargeFull) {
      this.chargeFullT += dt;
      if (this.chargeFullT >= (CFG.OVERDRIVE_ARM_TIMEOUT ?? Infinity)) {
        this.startOverdrive();
        this.odAuto++;
      }
    }
    return dt;
  }
}

/** Build the event sink. Mirror of makeEventSink() in src/main.js. */
function makeSink(g, out) {
  return {
    perfectArc(x, y, quality) {
      g.perfects++;
      g.bumpCombo();
      const qq = quality * quality;
      g.addScore(CFG.SCORE_PERFECT * (0.35 + qq * 1.15));
      if (g.overdriveActive) {
        const win = CFG.OVERDRIVE_EXIT_WINDOW;
        if (win === undefined) {
          // legacy behaviour: any arc past the 1.0s floor ends overdrive
          if (g.overdrive < CFG.OVERDRIVE_DURATION - 1.0) g.endOverdrive(1);
        } else if (g.overdrive <= win) {
          out.odExitArcs++;
          const late = clamp01(1 - g.overdrive / win);
          const f = CFG.OVERDRIVE_REFUND_FLOOR;
          g.endOverdrive(f + (1 - f) * late);
        }
      } else if (g.chargeFull) {
        g.startOverdrive();
      } else {
        g.addCharge(CFG.PERFECT_CHARGE * (0.5 + qq * 1.0), 'perfect');
      }
    },
    graze(x, y, obj, isHazard) {
      g.addScore(isHazard ? CFG.SCORE_GRAZE_HAZARD : CFG.SCORE_GRAZE);
      g.addCharge(isHazard ? CFG.GRAZE_CHARGE_HAZARD : CFG.GRAZE_CHARGE,
        isHazard ? 'grazeHaz' : 'graze');
      if (isHazard) g.bumpCombo(); else g.comboTimer = CFG.COMBO_WINDOW;
      if (isHazard) g.grazeHaz++;
      else if (obj && 'isCatch' in obj) g.grazeAnchor++;
      else g.grazeSolid++;
    },
    deflect() { g.deflects++; },
    orb() {
      g.addScore(CFG.SCORE_ORB);
      g.addCharge(CFG.ORB_CHARGE ?? 0.016, 'orb');
      g.bumpCombo();
      g.orbs++;
    },
    attach() { g.attaches++; },
    release() {},
    crash(x, y) { out.crashX = x; out.crashY = y; out.crashed = true; },
    reel() {},
  };
}

// ---------------------------------------------------------------------------------
// The bots. `smart` aims for the perfect-arc window, `metronome` is a fixed rhythm,
// `hold` never releases (the worst-case new player).
// ---------------------------------------------------------------------------------
function makeBot(mode) {
  let phase = 0, timer = 0;
  return function input(t, dt, player) {
    timer += dt;
    if (mode === 'hold') return true;
    if (mode === 'metronome') return (t % 0.9) < 0.65;
    if (phase === 0) { if (player.tethered) { phase = 1; timer = 0; } return true; }
    if (phase === 1) {
      const ang = Math.atan2(-player.vy, player.vx);
      if ((player.vy < -6 && player.vx > 4 && ang > 0.3 && ang < 0.9) || timer > 1.6) {
        phase = 2; timer = 0; return false;
      }
      return true;
    }
    if (timer > 0.14) { phase = 0; timer = 0; }
    return false;
  };
}

// ---------------------------------------------------------------------------------
/**
 * One run. `override` (optional) is `{ at, hold }`: from sim time `at` onward the bot
 * is ignored and the input is forced to `hold`. That is the whole mechanism behind the
 * avoidable-death audit — replays are bit-exact, so a forced input at t is the only
 * difference between two otherwise identical universes.
 */
function overrideInput(o, t, botDown) {
  if (t < o.at) return botDown;
  if (o.until !== undefined && t >= o.until) return botDown;
  return o.hold;
}

function simulate(seed, botMode, cap = CAP, override = null) {
  const world = new World(seed);
  const player = new Player();
  player.reset(CFG.SPAWN_X, CFG.SPAWN_Y);
  const g = new Run(player);
  const out = { crashed: false, crashX: 0, crashY: 0, odExitArcs: 0 };
  const ev = makeSink(g, out);
  const bot = makeBot(botMode);

  let t = 0, frames = 0;
  let seekFrames = 0, fallSeekFrames = 0, tetheredFrames = 0, stuckFrames = 0;
  let maxSpeed = 0;
  let firstThreatT = -1, firstThreatX = -1;
  const kindsSeen = [0, 0, 0, 0];
  let cause = null;
  const nHaz = () => world.hazards.length;

  for (let i = 0; i < cap * 60; i++) {
    const botDown = bot(t, DT, player);
    const down = override ? overrideInput(override, t, botDown) : botDown;
    player.setInput(down);
    const dt = g.step(DT);
    t += DT;
    world.update(dt, player.x, player.y);
    player.update(dt, world, ev);
    frames++;

    // Threat exposure. A hazard only counts once it is close enough to matter, which
    // is what makes "content that ships but is never seen" visible as a number.
    const hz = world.hazards;
    for (let k = 0; k < hz.length; k++) {
      const h = hz[k];
      if (!h) continue;
      const dx = h.x - player.x, dy = h.y - player.y;
      if (dx * dx + dy * dy < THREAT_R * THREAT_R) {
        kindsSeen[h.kind] = 1;
        if (firstThreatT < 0 && h.alive !== false) {
          firstThreatT = t; firstThreatX = (player.x - CFG.SPAWN_X) * 0.5;
        }
      }
    }

    if (player.seeking) { seekFrames++; if (player.vy > 20) fallSeekFrames++; }
    if (player.tethered) tetheredFrames++;
    if (player.speed < 6) stuckFrames++;
    if (player.speed > maxSpeed) maxSpeed = player.speed;

    if (!player.alive) {
      // Classify the kill. The player does not report what hit it, so re-test the
      // crash point against the live world: hazard beats solid beats floodline.
      cause = 'IMPACT';
      if (out.crashY >= CFG.FLOODLINE - 2) cause = 'FLOODLINE';
      else {
        let hit = null;
        for (let k = 0; k < hz.length && !hit; k++) {
          const h = hz[k];
          if (h && h.alive !== false &&
              circleVsOBB(out.crashX, out.crashY, CFG.PLAYER_RADIUS + 0.4, h.x, h.y, h.hw, h.hh, h.rot || 0)) {
            hit = ['LASER', 'DRONE', 'SPINNER', 'GATE'][h.kind] || 'HAZARD';
          }
        }
        if (!hit) {
          const so = world.solids;
          for (let k = 0; k < so.length && !hit; k++) {
            const s = so[k];
            if (s && circleVsOBB(out.crashX, out.crashY, CFG.PLAYER_RADIUS + 0.4, s.x, s.y, s.hw, s.hh, s.rot || 0)) hit = 'SOLID';
          }
        }
        cause = hit || 'IMPACT';
      }
      break;
    }
  }
  if (!cause) cause = 'SURVIVED';
  if (g.overdriveActive) g.endOverdrive(0);   // count the truncated tail honestly

  return {
    cause, t: +t.toFixed(2), dist: +((player.x - CFG.SPAWN_X) * 0.5).toFixed(0),
    score: Math.round(g.score),
    perfects: g.perfects, orbs: g.orbs, attaches: g.attaches, deflects: g.deflects,
    grazeHaz: g.grazeHaz, grazeSolid: g.grazeSolid, grazeAnchor: g.grazeAnchor,
    grazes: g.grazeHaz + g.grazeSolid + g.grazeAnchor,
    odTriggers: g.odTriggers, odAuto: g.odAuto, odLived: g.odLived, odActive: +g.odActiveTime.toFixed(2),
    chargeOffered: g.chargeOffered, chargeWasted: g.chargeWasted,
    odExitArcs: out.odExitArcs,
    chargeFrom: g.chargeFrom,
    multPeak: g.multiplierPeak,
    firstThreatT: firstThreatT < 0 ? Infinity : +firstThreatT.toFixed(1),
    firstThreatX: firstThreatX < 0 ? Infinity : firstThreatX,
    kindsSeen,
    maxSpeed: +maxSpeed.toFixed(0),
    seekPct: +(100 * seekFrames / frames).toFixed(0),
    fallSeekPct: +(100 * fallSeekFrames / frames).toFixed(0),
    tethPct: +(100 * tetheredFrames / frames).toFixed(0),
    stuckPct: +(100 * stuckFrames / frames).toFixed(0),
    reachFailures: world.reachFailures,
  };
}

// ---------------------------------------------------------------------------------
/**
 * AVOIDABLE-DEATH AUDIT.
 *
 * "No death was unavoidable" is the single most precious property this game has, and it
 * is only meaningful if it is measured. A death at time T is AVOIDABLE if there exists a
 * one-bit input change made at some point in the LOOKBACK seconds before it that both
 * (a) survives past T and (b) is still alive SURVIVE_FOR seconds later. Replays are
 * bit-exact, so this is an exhaustive search over a coarse lattice of interventions,
 * not an estimate.
 *
 * A death that survives every intervention is reported as UNAVOIDABLE and printed with
 * its seed so it can be reproduced and looked at.
 */
// 2.2, not 1.8: a real escape can be a long way upstream of the death it prevents.
// Measured — hold/seed 3 died at 46.95s and the latest input that saves it is at
// 45.00s, 1.95s earlier. A 1.8s lookback reported that death as UNAVOIDABLE, which is
// the most expensive kind of false alarm this tool can raise.
//
// Overridable (--lookback 0.6) because the SHORT form asks a different question. At
// 2.2s the audit measures PLAN-fairness: some line existed. At ~0.6s it measures
// REACTION-fairness: the player standing at the telegraph still has an out. A death
// that passes the long audit and fails the short one is the "it snapped on in my
// path mid-flight" experience — formally avoidable, felt as unfair.
const LOOKBACK = flag('lookback', 2.2);
const SURVIVE_FOR = 1.2;
const PROBE_STEP = 0.1;
/** Dwell lengths for the intervention. `undefined` means "hold the new input forever";
 *  the finite ones model the real escape manoeuvre, which is a pulse — let go, fall
 *  clear, grab again — not a permanent change of policy. */
const DWELLS = [undefined, 0.18, 0.45];
function auditDeath(seed, botMode, deathT) {
  const cap = deathT + SURVIVE_FOR + 0.5;
  for (let at = Math.max(0.2, deathT - LOOKBACK); at < deathT - 0.05; at += PROBE_STEP) {
    for (const hold of [true, false]) {
      for (const d of DWELLS) {
        const o = { at, hold, until: d === undefined ? undefined : at + d };
        const r = simulate(seed, botMode, cap, o);
        if (r.t >= deathT + SURVIVE_FOR) {
          return { avoidable: true, at: +at.toFixed(2), hold, dwell: d };
        }
      }
    }
  }
  return { avoidable: false };
}

// ---------------------------------------------------------------------------------
const med = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[v.length >> 1] : 0; };
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const f1 = (n) => (+n).toFixed(1);

const summary = {};
const terse = [];
for (const bot of ['smart', 'metronome', 'hold']) {
  const rs = [];
  for (let s = 1; s <= SEEDS; s++) rs.push(simulate(s, bot));
  const causes = {};
  for (const r of rs) causes[r.cause] = (causes[r.cause] || 0) + 1;
  const A = (k) => avg(rs.map(r => r[k]));
  const M = (k) => med(rs.map(r => r[k]));

  const gH = A('grazeHaz'), gS = A('grazeSolid'), gA = A('grazeAnchor');
  const gT = gH + gS + gA || 1;
  const lived = rs.flatMap(r => r.odLived);
  const cf = { perfect: 0, graze: 0, grazeHaz: 0, orb: 0 };
  for (const r of rs) for (const k in cf) cf[k] += r.chargeFrom[k];
  const cTot = cf.perfect + cf.graze + cf.grazeHaz + cf.orb || 1;
  const kindPct = HAZ_KINDS.map((_, i) => 100 * avg(rs.map(r => r.kindsSeen[i])));
  const seenThreat = rs.filter(r => isFinite(r.firstThreatT));
  const reach = rs.reduce((a, r) => a + r.reachFailures, 0);

  summary[bot] = { score: A('score'), dist: M('dist') };
  const hazDeaths = (causes.LASER || 0) + (causes.DRONE || 0) + (causes.SPINNER || 0)
    + (causes.GATE || 0) + (causes.HAZARD || 0);
  terse.push(`${bot[0]}: ${M('dist')}m/${M('t')}s haz${hazDeaths} sol${(causes.SOLID || 0)} fld${(causes.FLOODLINE || 0)} srv${(causes.SURVIVED || 0)} od${f1(A('odTriggers'))} gz${f1(gT)} df${f1(A('deflects'))}`);
  if (TERSE) continue;

  console.log(`\n=== ${bot.toUpperCase()} (${SEEDS} seeds, ${CAP}s cap) ===`);
  console.log('  death causes  :', JSON.stringify(causes), reach ? `  !! reachFailures ${reach}` : '');
  console.log(`  survival      : median ${M('t')}s  avg ${f1(A('t'))}s`);
  console.log(`  distance      : median ${M('dist')}m  avg ${f1(A('dist'))}m`);
  console.log(`  score         : median ${M('score')}  avg ${Math.round(A('score'))}   peak mult avg ${f1(A('multPeak'))}`);
  console.log(`  perfect arcs  : ${f1(A('perfects'))}   orbs ${f1(A('orbs'))}   attaches ${f1(A('attaches'))}   deflects ${f1(A('deflects'))}`);
  console.log(`  grazes/run    : ${f1(gT)}  =  hazard ${f1(gH)} (${(100 * gH / gT).toFixed(0)}%)  solid ${f1(gS)} (${(100 * gS / gT).toFixed(0)}%)  anchor ${f1(gA)} (${(100 * gA / gT).toFixed(0)}%)`);
  console.log(`  charge income : perfect ${(100 * cf.perfect / cTot).toFixed(0)}%  hazGraze ${(100 * cf.grazeHaz / cTot).toFixed(0)}%  graze ${(100 * cf.graze / cTot).toFixed(0)}%  orb ${(100 * cf.orb / cTot).toFixed(0)}%`);
  const odAny = 100 * rs.filter(r => r.odTriggers > 0).length / rs.length;
  console.log(`  charge/run    : offered ${f1(A('chargeOffered'))} meters, wasted-in-OD ${f1(A('chargeWasted'))} (${(100 * A('chargeWasted') / Math.max(1e-6, A('chargeOffered'))).toFixed(0)}%), realised ${f1(A('odTriggers'))} fills`);
  console.log(`  overdrive     : ${f1(A('odTriggers'))} triggers/run (${f1(A('odAuto'))} auto-fired, ${odAny.toFixed(0)}% of runs see one), ${f1(A('odActive'))}s active/run, lived median ${f1(med(lived))}s (n=${lived.length}, nominal ${CFG.OVERDRIVE_DURATION}s), exit-arcs ${f1(A('odExitArcs'))}`);
  console.log(`  1st threat    : ${seenThreat.length}/${rs.length} runs, median t=${f1(med(seenThreat.map(r => r.firstThreatT)))}s  x=${f1(med(seenThreat.map(r => r.firstThreatX)))}m`);
  console.log(`  hazard kinds  : ` + HAZ_KINDS.map((k, i) => `${k} ${kindPct[i].toFixed(0)}%`).join('  '));
  console.log(`  tethered ${f1(A('tethPct'))}%  seeking ${f1(A('seekPct'))}%  falling-seek ${f1(A('fallSeekPct'))}%  stalled ${f1(A('stuckPct'))}%  max ${f1(A('maxSpeed'))} m/s`);
  // DESIGN.md L1: "you cannot fail in the first ~15 seconds". The promise is about
  // SECONDS and about the worst-case player, so it is asserted on the `hold` bot and
  // measured in wall clock — TUTORIAL_DIST is only the lever that delivers it.
  //
  // THE HOLE THIS USED TO HAVE. `hold` never releases, so it cannot release BADLY, so
  // it structurally cannot drown: it recorded 1 floodline death in 30 runs and 0 sub-15s
  // ones, and the promise looked green forever. Meanwhile `metronome` — the tier closest
  // to a human still learning — was drowning in 31% of runs and ALL of its sub-15s
  // deaths were floodline. The promise was being verified against the one policy that is
  // immune to the failure mode the promise exists to rule out.
  //
  // So there are now TWO assertions. `hold` still enforces the promise as written (zero
  // early deaths of any cause), because L1 is literally "just hold". `metronome` carries
  // a second tripwire aimed squarely at the blind spot: early DROWNINGS. It is a budget,
  // not a zero — metronome releases on a blind rhythm and is supposed to be able to
  // fail — but a regression past it means the recovery net or the floodline telegraph
  // has quietly broken again, and `hold` will not tell you.
  const early = rs.filter(r => r.cause !== 'SURVIVED' && r.t < 15);
  const ec = {};
  for (const r of early) ec[r.cause] = (ec[r.cause] || 0) + 1;
  const earlyDrown = early.filter(r => r.cause === 'FLOODLINE').length;
  const drownPct = 100 * earlyDrown / rs.length;
  console.log(`  deaths <15s   : ${early.length}/${rs.length}` +
    (early.length ? `  ${JSON.stringify(ec)}` : '') +
    (bot === 'hold' && early.length ? '   !! L1 PROMISE BROKEN' : ''));
  if (bot === 'metronome') {
    console.log(`  early drown   : ${earlyDrown}/${rs.length} (${drownPct.toFixed(1)}%) — the failure mode \`hold\` cannot exhibit` +
      (drownPct > EARLY_DROWN_BUDGET ? `   !! OVER BUDGET (${EARLY_DROWN_BUDGET}%)` : ''));
  }

  if (AVOID) {
    let checked = 0, bad = [];
    for (let s = 1; s <= SEEDS; s++) {
      const r = rs[s - 1];
      if (r.cause === 'SURVIVED') continue;
      checked++;
      const a = auditDeath(s, bot, r.t);
      if (!a.avoidable) bad.push(`seed ${s} @ ${r.t}s (${r.cause})`);
    }
    console.log(`  AVOIDABILITY  : ${checked - bad.length}/${checked} deaths avoidable` +
      (bad.length ? `   UNAVOIDABLE: ${bad.join(', ')}` : '   (zero unavoidable)'));
  }
}

const ratioS = summary.smart.score / Math.max(1, summary.hold.score);
const ratioD = summary.smart.dist / Math.max(1, summary.hold.dist);
if (TERSE) {
  console.log(`${sets.join(' ').padEnd(46)} | ${terse.join(' | ')} | S/H ${f1(ratioS)}x ${f1(ratioD)}x`);
  process.exit(0);
}
console.log(`\n=== SKILL GRADIENT ===`);
console.log(`  smart/hold score    : ${f1(ratioS)}x  (${Math.round(summary.smart.score)} vs ${Math.round(summary.hold.score)})`);
console.log(`  smart/hold distance : ${f1(ratioD)}x  (${summary.smart.dist} vs ${summary.hold.dist})`);
if (!QUIET && ratioS < 2) console.log('  !! SKILL HAS STOPPED PAYING — smart must beat hold by a wide margin.');
