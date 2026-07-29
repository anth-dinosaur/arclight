// ARCLIGHT — particles, ribbons and screen feel. Owned by the integrator.
//
// One flat pool, one update loop, no per-particle classes. Every particle is a
// glowing capsule stretched along its own velocity, which is why sparks read as
// streaks rather than dots — cheap motion blur that costs nothing.

import { CFG, PAL, tint } from '../core/config.js';
import { LAYER } from '../core/renderer.js';
import { clamp01, makeRng, TAU } from '../core/math.js';

const KIND = { SPARK: 0, EMBER: 1, SHOCK: 2, DUST: 3, SHARD: 4 };

const _c = [0, 0, 0, 1];
const rng = makeRng(0xa2c1e5);

class Particle {
  constructor() {
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.life = 0; this.maxLife = 1;
    this.size = 1; this.kind = 0;
    this.drag = 1; this.grav = 0; this.spin = 0; this.rot = 0;
    this.r = 1; this.g = 1; this.b = 1; this.bright = 1;
    // Halo radius as a multiple of the drawn core. 8 is the historic value and is a
    // SMUDGE ratio by this file's own definition (see the ring comment below); it is
    // kept as the default only because the overdrive entry and the perfect-arc burst
    // were tuned against it. Anything authored after the highlight knee landed should
    // be using ~3.
    this.halo = 8;
  }
}

export class Fx {
  constructor() {
    this.parts = new Array(CFG.MAX_PARTICLES);
    for (let i = 0; i < CFG.MAX_PARTICLES; i++) this.parts[i] = new Particle();
    this.count = 0;

    // Expanding shockwave rings — separate because there are few and they draw big.
    this.rings = new Array(24);
    for (let i = 0; i < 24; i++) {
      this.rings[i] = { x: 0, y: 0, life: 0, maxLife: 1, r0: 0, r1: 1, w: 1, r: 1, g: 1, b: 1 };
    }
    this.ringCount = 0;
  }

  clear() { this.count = 0; this.ringCount = 0; }

  /** Grab a slot, or steal the oldest if full — dropping effects looks worse than reusing. */
  _alloc() {
    if (this.count < CFG.MAX_PARTICLES) return this.parts[this.count++];
    let worst = 0, worstT = 1;
    for (let i = 0; i < this.count; i += 7) {   // sparse scan: good enough, O(1)-ish
      const p = this.parts[i];
      const t = p.life / p.maxLife;
      if (t < worstT) { worstT = t; worst = i; }
    }
    return this.parts[worst];
  }

  spawn(kind, x, y, vx, vy, life, size, col, bright, halo = 8) {
    const p = this._alloc();
    p.kind = kind;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life;
    p.size = size;
    p.r = col[0]; p.g = col[1]; p.b = col[2];
    p.bright = bright;
    p.halo = halo;
    p.rot = 0; p.spin = 0;
    switch (kind) {
      case KIND.SPARK:  p.drag = 1.6; p.grav = CFG.GRAVITY * 0.35; break;
      case KIND.EMBER:  p.drag = 0.7; p.grav = CFG.GRAVITY * 0.12; break;
      case KIND.SHOCK:  p.drag = 4.0; p.grav = 0; break;
      case KIND.DUST:   p.drag = 2.2; p.grav = -2; break;      // rises
      case KIND.SHARD:  p.drag = 0.5; p.grav = CFG.GRAVITY * 0.6;
                        p.spin = rng.jitter(14); break;
    }
    return p;
  }

  ring(x, y, r0, r1, life, width, col) {
    const i = this.ringCount < this.rings.length ? this.ringCount++ : 0;
    const s = this.rings[i];
    s.x = x; s.y = y; s.r0 = r0; s.r1 = r1;
    s.life = life; s.maxLife = life; s.w = width;
    s.r = col[0]; s.g = col[1]; s.b = col[2];
  }

  // ---- authored effects -----------------------------------------------------

  burst(x, y, n, speed, col, bright = 2.2, spread = TAU, dir = 0, halo = 8) {
    for (let i = 0; i < n; i++) {
      const a = dir + (spread === TAU ? rng() * TAU : rng.jitter(spread * 0.5));
      const s = speed * (0.35 + rng() * 0.65);
      this.spawn(KIND.SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.28 + rng() * 0.42, 0.16 + rng() * 0.2, col, bright, halo);
    }
  }

  /**
   * PERFECT ARC. The most frequent effect in the game by a wide margin — a competent
   * player lands ~30 a run, about one every 0.66s — which inverts the usual budget: the
   * crash can afford to own the frame because it happens once, and this one cannot
   * afford to own anything, because the next one is already coming.
   *
   * It was the last flat plate in the build, and it was the crash's mistake one size
   * down. Measured on a seeded frozen frame (tools/dev/.fxshot.mjs, perfectarc-mid):
   *   - `ring(..., 15, 0.6, ...)` fired on every arc above quality 0.6 — radius 15 is a
   *     30-unit diameter against CFG.VIEW_WIDTH 46, i.e. 65% of the frame width, held
   *     for 0.6s. At 1.5 arcs/second that plate is on screen most of the time.
   *   - 22 burst sparks + 8 embers spawned at ONE point. `burst()`'s 7th positional arg
   *     is `spread`, so `halo` silently kept its default of 8 — 30 haloes of radius
   *     8*size stacked on a single pixel, which is the same summation that made the old
   *     crash resolve to one flat colour. It drew as a white blob filling the ring.
   *   - net: a cyan donut 48% of frame width with a white fill, centred on the player,
   *     with the player invisible inside it. blown-out 4.1%, true black 54.2% against a
   *     56-59% cruise baseline.
   *
   * Rebuilt as a DIRECTIONAL report rather than a symmetric blast. A perfect arc is a
   * thing you did along a heading; the old effect was a bomb going off underneath you.
   * The exhaust cone (already here, and the one good part of the original — `dir + PI`
   * with a 1.5 spread) is now the subject, and the rings are demoted to a thin fast tick
   * that says "scored" and gets out of the way. Nothing crosses more than a fifth of the
   * frame and nothing outlives a third of the gap to the next arc.
   */
  perfectArc(x, y, vx, vy, quality) {
    const dir = Math.atan2(vy, vx);
    const q = quality;

    // The report. Thin, small, fast — and it scales with quality so a centre-window arc
    // still feels bigger than an edge one WITHOUT reaching for a second ring.
    this.ring(x, y, 0.5, 3.4 + q * 2.6, 0.13 + q * 0.05, 0.075, PAL.cyanHot);
    // High-quality arcs get a second hoop, but a HOOP: 7.5 units is 33% of frame width
    // at full expansion versus the old 65%, it is a third the width, and it is gone in
    // 0.11s rather than 0.6s.
    if (q > 0.6) this.ring(x, y, 1.0, 7.5, 0.11, 0.05, PAL.white);

    // Exhaust. Fired BACKWARDS along the heading, so the arc reads as thrust.
    //
    // Deliberately NOT using burst(): burst() hardcodes life at 0.28 + rng()*0.42, i.e.
    // up to 0.70s, which is LONGER THAN THE 0.66s GAP TO THE NEXT ARC — the exhaust from
    // one arc was still on screen when the next one fired, so the effect never actually
    // ended, it just accumulated. Spawning directly is the only way to own the clock.
    // Short life + high speed is also what makes these draw as streaks rather than as
    // round soft blobs, which at this size and halo read as orbs (the amber pickups) and
    // are the wrong noun entirely.
    const ec = q > 0.7 ? PAL.white : PAL.cyanHot;
    for (let i = 0; i < 12; i++) {
      const a = dir + Math.PI + rng.jitter(1.15);
      const s = (62 + q * 40) * (0.45 + rng() * 0.55);
      this.spawn(KIND.SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.10 + rng() * 0.10, 0.10 + rng() * 0.10, ec, 2.2 + q * 1.4, 3);
    }

    // Embers linger fractionally longer than everything else and are the only thing
    // still alive when the eye returns to the player. Halo 3 for the same reason.
    for (let i = 0; i < 5; i++) {
      const a = dir + Math.PI + rng.jitter(1.0), s = 14 + rng() * 22;
      this.spawn(KIND.EMBER, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.22 + rng() * 0.16, 0.09 + rng() * 0.1, PAL.cyanHot, 1.6, 3);
    }
  }

  attach(x, y) {
    this.ring(x, y, 3.2, 0.8, 0.24, 0.3, PAL.violetHot);   // collapsing ring: lock-on
    this.burst(x, y, 8, 12, PAL.violetHot, 1.8);
  }

  graze(x, y, nx, ny) {
    const a = Math.atan2(ny, nx);
    for (let i = 0; i < 4; i++) {
      const s = 8 + rng() * 16;
      const j = a + rng.jitter(0.7);
      this.spawn(KIND.SPARK, x, y, Math.cos(j) * s, Math.sin(j) * s,
        0.16 + rng() * 0.2, 0.1, PAL.amberHot, 1.7);
    }
  }

  orb(x, y) {
    this.burst(x, y, 12, 20, PAL.amberHot, 2.0);
    this.ring(x, y, 0.5, 5, 0.3, 0.2, PAL.amberHot);
  }

  /**
   * CRASH. This ends every single run, so it is the last thing a player sees and the
   * only frame they get to judge the game on at leisure.
   *
   * The previous form was the overdrive-entry mistake (see below) repeated in the
   * bigger moment, and it was worse because nothing follows it. Measured on the death
   * time series, camera showing CFG.VIEW_WIDTH (46) world units:
   *   - the magenta ring reached 88% of frame WIDTH and the white ring 136%. The
   *     overdrive ring that was already condemned for this was 1.83x screen; this was
   *     1.36x, on screen for 0.6s, at the moment the player is trying to read what
   *     happened.
   *   - 86 sparks at glowRadius sz*8, all spawned at one point, summed to >100 linear.
   *     Every pixel inside 130px of the impact therefore resolved to the same three
   *     bytes, (255,144,210), hue pinned at 323 degrees. A flat card.
   *   - and it SWELLED. True black went 48.2% at dt=0.23 monotonically down to 25.0%
   *     at dt=1.13 — it ended 32 points BELOW the 56-59% cruise baseline at triple the
   *     mean luminance, i.e. the frame got flatter the longer you looked at it.
   *   - the 18 shards were magentaHot drawn inside a magentaHot flood, so DESIGN.md's
   *     promised "radial shatter" had zero contrast BY CONSTRUCTION and did not
   *     visually exist.
   *
   * The white-out at dt~0.05 is not this function — it is the pre-tonemap flash path,
   * and it is correct: it whites to bright film (0.1% clipped), not to a card. Kept.
   *
   * ---- THE CLOCK, which is the thing everybody got wrong ------------------------
   * Particle lifetimes are spent in GAME dt, and a death does not run at wall rate:
   * main.js applies hitstop (dt *= 0.06) for HITSTOP_CRASH and then damps timescale to
   * 0.22 for the whole DYING state. Integrated across a real death (tools/dev/
   * .fxclock.mjs):
   *     wall 0.25s -> fx 0.013     wall 0.75s -> fx 0.133
   *     wall 0.50s -> fx 0.079     wall 1.15s -> fx 0.223   <- death ends here
   * The ENTIRE 1.15-second death is 0.223 seconds of fx time. So the old 0.45s / 0.60s
   * ring lives were not "short on purpose", they were 2 to 3 times longer than the
   * death itself: those rings were still expanding when the run report came up, which
   * is precisely why the frame measured as SWELLING rather than snapping. Every number
   * below is therefore authored in fx seconds against a 0.223 budget, and the wall
   * time it lands at is written next to it.
   *
   * Same rule the overdrive entry obeys — fast, small, and gone — with ONE exception,
   * which is the subject:
   *   1. a hard, thin white ring: the impact report. Gone by wall 0.29s.
   *   2. two short rings, 8 and 11 units, gone by wall 0.36s / 0.44s. 11 is already
   *      48% of the frame width at full expansion, but it is a THIN hoop for 0.2s of
   *      wall clock rather than a filled plate for 0.6s, and it occludes nothing.
   *   3. 24 sparks, not 86, fired hard enough to actually clear the impact point
   *      inside their (short) lives, and at halo 3 rather than 8 — 86 sparks at halo 8
   *      all sitting on one point is what summed to >100 linear and made every pixel
   *      inside 130px resolve to the same (255,144,210).
   *   4. the SHARDS are promoted to the subject. 16 of them, WHITE cores inside a
   *      magenta halo (contrast, at last), launched off a ring at r=1.6-4.8 with a bias
   *      back along -v so they read as debris thrown by the impact rather than as a
   *      symmetrical firework. They live 0.15-0.24 fx = out to wall 0.9-1.3s, so they
   *      are the only thing on screen for the whole second half of the death. The
   *      frame empties out into a shatter instead of filling up into a card.
   */
  crash(x, y, vx, vy) {
    const sp = Math.sqrt(vx * vx + vy * vy) || 1;
    const bx = -vx / sp, by = -vy / sp;

    this.ring(x, y, 0.4, 4.5, 0.020, 0.10, PAL.white);        // report,  wall ~0.29s
    this.ring(x, y, 0.8, 8.0, 0.035, 0.22, PAL.magentaHot);   //          wall ~0.36s
    this.ring(x, y, 0.8, 11.0, 0.050, 0.09, PAL.white);       //          wall ~0.44s

    // Sparks. Drag is 1.6/s, so over a 0.05 life a spark travels only v0*0.048 — at
    // the old speed of 46 that is 2.2 world units, i.e. it never leaves the impact
    // point and just stacks its halo on every other spark's. 90-190 puts them 4-9
    // units out and past the streak threshold, so they draw as radial lines.
    for (let i = 0; i < 16; i++) {
      const a = rng() * TAU, s = 90 + rng() * 100;
      this.spawn(KIND.SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.035 + rng() * 0.030, 0.13 + rng() * 0.13, PAL.magentaHot, 2.0, 3);
    }
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU, s = 70 + rng() * 80;
      this.spawn(KIND.SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.030 + rng() * 0.025, 0.10 + rng() * 0.10, PAL.white, 2.4, 3);
    }

    // HITSTOP means the first 0.22s of wall clock is 0.007s of fx time, i.e. the
    // spawn LAYOUT is a still frame the player looks at for a fifth of a second. 16
    // shards spawned on a 1.5-unit ring is a solid blob for that whole time, so the
    // ring is 1.6-4.8 with the radius correlated to the launch speed — the layout is
    // already a shatter at t=0 and simply keeps expanding once time restarts.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU + rng.jitter(0.16);
      const ca = Math.cos(a), sa = Math.sin(a);
      const s = 35 + rng() * 75;
      const r0 = 1.6 + (s - 35) * 0.042;
      this.spawn(KIND.SHARD, x + ca * r0, y + sa * r0,
        ca * s + bx * 30, sa * s + by * 30,
        0.15 + rng() * 0.09, 0.16 + rng() * 0.22, PAL.magentaHot, 2.4);
    }
  }

  /**
   * OVERDRIVE entry. The camera shows CFG.VIEW_WIDTH (46) world units across, so the
   * old form — a 0.8-wide ring expanding to radius 42 over 0.9s — was a wall of light
   * 84 units wide, 1.83x the screen, sweeping the entire playfield for 0.9 of the 6
   * seconds just banked. You could not see the hazards during the entry to the feature
   * whose entire purpose is flying through hazards.
   *
   * Same energy, inverted geometry. Nothing here crosses more than a third of the
   * frame and nothing lives longer than a third of a second:
   *   - two tight rings, white core and cyan outer, gone in 0.22s / 0.30s. Fast and
   *     small reads as a HARD event; big and slow reads as an obstruction.
   *   - an IMPLOSION: sparks spawned on a ring and fired inward, so they streak
   *     toward the avatar and land on it. Power arriving, not power exploding. It
   *     draws the eye back to the player exactly when the player needs to be looking
   *     at the player, and thin converging streaks occlude nothing.
   *   - a small outward pop so the moment still has a centre.
   *
   * Measured on the entry frame ~0.2s after the trigger: mean luma 69.0 -> 45.8,
   * blown-out pixels 10.5% -> 1.4%, true black 61.5% -> 60.2%. The old ring was
   * washing a tenth of the frame to white while the player was supposed to be reading
   * a hazard field; the new one changes the frame's exposure by almost nothing.
   */
  overdrive(x, y) {
    this.ring(x, y, 0.8, 8.5, 0.22, 0.75, PAL.white);
    this.ring(x, y, 0.8, 14.5, 0.30, 0.26, PAL.cyanHot);
    for (let i = 0; i < 26; i++) {
      const a = rng() * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Spark drag is 1.6/s, so reach over a life L is v0 * (1 - e^-1.6L) / 1.6.
      // Solve for the launch speed that lands the streak on the avatar as it dies.
      const r0 = 12 + rng() * 6;
      const life = 0.24 + rng() * 0.07;
      const v0 = r0 * 1.6 / (1 - Math.exp(-1.6 * life));
      this.spawn(KIND.SPARK, x + ca * r0, y + sa * r0, -ca * v0, -sa * v0,
        life, 0.11, PAL.cyanHot, 2.6);
    }
    this.burst(x, y, 20, 24, PAL.white, 3.0);
  }

  /** Continuous speed dust so fast flight reads as fast even against empty sky. */
  speedDust(x, y, vx, vy, speed01, dt) {
    if (speed01 < 0.28) return;
    if (rng() > speed01 * dt * 34) return;
    const a = Math.atan2(vy, vx) + Math.PI + rng.jitter(0.5);
    const s = 6 + rng() * 20 * speed01;
    this.spawn(KIND.DUST, x + rng.jitter(9), y + rng.jitter(9),
      Math.cos(a) * s, Math.sin(a) * s, 0.3 + rng() * 0.3, 0.07, PAL.cyanHot, 1.0 + speed01);
  }

  // ---- sim ------------------------------------------------------------------

  update(dt) {
    for (let i = this.count - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.count--;
        this.parts[i] = this.parts[this.count];
        this.parts[this.count] = p;
        continue;
      }
      const d = 1 - p.drag * dt;
      p.vx *= d > 0 ? d : 0;
      p.vy *= d > 0 ? d : 0;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (let i = this.ringCount - 1; i >= 0; i--) {
      const s = this.rings[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.ringCount--;
        const tmp = this.rings[i];
        this.rings[i] = this.rings[this.ringCount];
        this.rings[this.ringCount] = tmp;
      }
    }
  }

  render(r, zoom) {
    const soft = 1.4 / zoom;
    for (let i = 0; i < this.count; i++) {
      const p = this.parts[i];
      const t = p.life / p.maxLife;
      // Sparks flare then die; embers fade linearly; dust fades in and out.
      const fade = p.kind === KIND.DUST ? Math.sin(t * Math.PI) : t * t;
      const k = p.bright * fade;
      _c[0] = p.r * k; _c[1] = p.g * k; _c[2] = p.b * k; _c[3] = 1;

      if (p.kind === KIND.SHARD) {
        // TWO primitives, and the second one is the whole point. A shard drawn in the
        // same colour as the flood it is spawned inside is invisible by construction,
        // which is what killed the crash "radial shatter". So: a wide, dim halo in the
        // particle's own colour, and a narrow WHITE core inside it. The core is thin
        // enough (0.22 of the shard width) that it reads as a glint on a spinning
        // fragment rather than as a second sprite.
        const w = p.size * (0.4 + t * 0.6);
        r.rect(LAYER.FOREGROUND, p.x, p.y, w * 2.4, w * 0.5, p.rot, _c,
          { glow: 1.2, glowRadius: w * 2.2, soft });
        _c[0] = 2.60 * k; _c[1] = 2.90 * k; _c[2] = 3.00 * k;   // PAL.white ratio
        r.rect(LAYER.FOREGROUND, p.x, p.y, w * 1.9, w * 0.22, p.rot, _c,
          { glow: 1.0, glowRadius: w * 0.5, soft });
      } else {
        // Stretch along velocity: length grows with speed, giving free motion blur.
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const stretch = Math.min(sp * 0.022, 2.2);
        const sz = p.size * (0.35 + t * 0.65);
        if (stretch > 0.12) {
          r.line(LAYER.FOREGROUND, p.x, p.y, p.x - p.vx * 0.02, p.y - p.vy * 0.02,
            sz * 2, _c, { glow: 1.8, glowRadius: sz * p.halo, soft });
        } else {
          r.circle(LAYER.FOREGROUND, p.x, p.y, sz, _c,
            { glow: 1.8, glowRadius: sz * p.halo, soft });
        }
      }
    }

    for (let i = 0; i < this.ringCount; i++) {
      const s = this.rings[i];
      const t = 1 - s.life / s.maxLife;
      const e = 1 - Math.pow(1 - t, 3);          // ease out: fast expansion, slow settle
      const rad = s.r0 + (s.r1 - s.r0) * e;
      // LINEAR fade, not squared. The radius eases outward on a cubic, so a squared
      // fade put the ring below the bloom threshold while it was still growing — it
      // spent two thirds of its life as a wide desaturated arc. Linear × a higher
      // gain keeps it emissive right up to the point it vanishes.
      const a = 1 - t;
      // 2.2, not 4.0. Ring colours are already the *Hot palette entries at 2.6-3.0, so
      // a 4.0 gain put the ring core at 12 linear — past the tonemap's highlight knee,
      // where it bleaches toward white. That was invisible while the tonemap had no
      // highlight response at all; with one, a 4.0 ring is a WHITE PLATE with the
      // palette colour only in its fringe, which is exactly the failure the crash was
      // condemned for. 2.2 keeps the core at ~6.6 linear: far above the 1.0 bloom
      // threshold, comfortably under the knee, so a magenta ring stays magenta.
      const k = a * 2.2;
      _c[0] = s.r * k; _c[1] = s.g * k; _c[2] = s.b * k; _c[3] = 1;
      // Halo scales with the core it belongs to. A fixed 2.4 against a 0.12-wide core
      // made the halo 20x the shape, which is the definition of a smudge.
      const th = s.w * (1 - t * 0.6) + 0.02;
      r.ring(LAYER.FOREGROUND, s.x, s.y, rad, th, _c,
        { glow: 2.2, glowRadius: th * 3.5, soft });
    }
  }
}

export { KIND };
