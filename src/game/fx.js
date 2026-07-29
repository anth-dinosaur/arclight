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

  spawn(kind, x, y, vx, vy, life, size, col, bright) {
    const p = this._alloc();
    p.kind = kind;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life;
    p.size = size;
    p.r = col[0]; p.g = col[1]; p.b = col[2];
    p.bright = bright;
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

  burst(x, y, n, speed, col, bright = 2.2, spread = TAU, dir = 0) {
    for (let i = 0; i < n; i++) {
      const a = dir + (spread === TAU ? rng() * TAU : rng.jitter(spread * 0.5));
      const s = speed * (0.35 + rng() * 0.65);
      this.spawn(KIND.SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.28 + rng() * 0.42, 0.16 + rng() * 0.2, col, bright);
    }
  }

  perfectArc(x, y, vx, vy, quality) {
    const dir = Math.atan2(vy, vx);
    const c = quality > 0.7 ? PAL.white : PAL.cyanHot;
    this.burst(x, y, 22, 34 + quality * 26, c, 2.4 + quality * 1.6, 1.5, dir + Math.PI);
    this.ring(x, y, 1.2, 9 + quality * 5, 0.42, 0.42, PAL.cyanHot);
    if (quality > 0.6) this.ring(x, y, 0.6, 15, 0.6, 0.22, PAL.white);
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU, s = 6 + rng() * 14;
      this.spawn(KIND.EMBER, x, y, Math.cos(a) * s, Math.sin(a) * s,
        0.7 + rng() * 0.6, 0.1 + rng() * 0.14, PAL.cyanHot, 1.6);
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

  crash(x, y, vx, vy) {
    this.burst(x, y, 60, 46, PAL.magentaHot, 3.0);
    this.burst(x, y, 26, 22, PAL.white, 3.4);
    // Short lives on purpose. The shockwave is the biggest single moment in the game
    // and it should SNAP — at 0.75s/1.1s the ring spent most of its life as a wide,
    // near-transparent arc, i.e. a grey smudge crossing the frame long after the hit
    // had registered. 0.45s/0.6s is over before the eye can start reading it as haze.
    this.ring(x, y, 1, 22, 0.45, 0.6, PAL.magentaHot);
    this.ring(x, y, 1, 34, 0.60, 0.25, PAL.white);
    for (let i = 0; i < 18; i++) {
      const a = rng() * TAU, s = 10 + rng() * 40;
      this.spawn(KIND.SHARD, x, y,
        Math.cos(a) * s + vx * 0.25, Math.sin(a) * s + vy * 0.25,
        0.9 + rng() * 0.9, 0.22 + rng() * 0.3, PAL.magentaHot, 2.2);
    }
  }

  overdrive(x, y) {
    this.ring(x, y, 1, 42, 0.9, 0.8, PAL.white);
    this.ring(x, y, 1, 26, 0.6, 0.5, PAL.cyanHot);
    this.burst(x, y, 48, 40, PAL.white, 3.2);
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
        const w = p.size * (0.4 + t * 0.6);
        r.rect(LAYER.FOREGROUND, p.x, p.y, w * 2.4, w * 0.5, p.rot, _c,
          { glow: 1.4, glowRadius: w * 5, soft });
      } else {
        // Stretch along velocity: length grows with speed, giving free motion blur.
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const stretch = Math.min(sp * 0.022, 2.2);
        const sz = p.size * (0.35 + t * 0.65);
        if (stretch > 0.12) {
          r.line(LAYER.FOREGROUND, p.x, p.y, p.x - p.vx * 0.02, p.y - p.vy * 0.02,
            sz * 2, _c, { glow: 1.8, glowRadius: sz * 8, soft });
        } else {
          r.circle(LAYER.FOREGROUND, p.x, p.y, sz, _c,
            { glow: 1.8, glowRadius: sz * 8, soft });
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
      const k = a * 4.0;
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
