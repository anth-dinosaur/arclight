// ARCLIGHT — math & utility. Allocation-free helpers for the hot loop.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = Math.sign;

/** Frame-rate independent exponential smoothing. `rate` = how much closes per second. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Shortest signed angular difference, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const dampAngle = (a, b, rate, dt) =>
  a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));

// ---- easing -----------------------------------------------------------------
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t) => {
  if (t === 0 || t === 1) return t;
  const c4 = TAU / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};
/** 0→1→0 pulse. */
export const pulse = (t) => Math.sin(clamp01(t) * Math.PI);

// ---- deterministic random ---------------------------------------------------
/** Mulberry32. Fast, seedable, good enough for level gen. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  /** Symmetric jitter in [-m, m]. */
  next.jitter = (m) => (next() * 2 - 1) * m;
  return next;
}

/** Cheap 1D value noise, C1-continuous. For flicker/drift, not terrain. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => {
    let t = Math.imul(n ^ seed, 0x27d4eb2d);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}
/** Fractal value noise, 3 octaves, returns ~[0,1]. */
export function fbm1(x, seed = 0) {
  return (
    noise1(x, seed) * 0.5 +
    noise1(x * 2.13, seed + 101) * 0.3 +
    noise1(x * 4.31, seed + 977) * 0.2
  );
}

// ---- geometry ---------------------------------------------------------------
export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** Squared distance from point P to segment AB. Allocation-free. */
export function distToSegment2(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t - px, cy = ay + aby * t - py;
  return cx * cx + cy * cy;
}

/** Circle (cx,cy,r) vs axis-aligned rect centred at (rx,ry) with half-extents (hw,hh). */
export function circleVsRect(cx, cy, r, rx, ry, hw, hh) {
  const dx = Math.abs(cx - rx) - hw;
  const dy = Math.abs(cy - ry) - hh;
  if (dx <= 0 && dy <= 0) return true;
  const ox = dx > 0 ? dx : 0, oy = dy > 0 ? dy : 0;
  return ox * ox + oy * oy <= r * r;
}

/** Circle vs rotated rect. `rot` is the rect's rotation in radians. */
export function circleVsOBB(cx, cy, r, rx, ry, hw, hh, rot) {
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const dx = cx - rx, dy = cy - ry;
  return circleVsRect(dx * c - dy * s, dx * s + dy * c, r, 0, 0, hw, hh);
}

// ---- colour -----------------------------------------------------------------
/** '#rrggbb' → packed [r,g,b] floats 0..1. Call at init, never in the loop. */
export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Pack an HDR colour into a single float for instance attributes is lossy, so we
 * instead keep colours as 4-tuples. This helper builds one without allocating in
 * the loop by writing into a caller-supplied array.
 */
export function setRgba(out, r, g, b, a) {
  out[0] = r; out[1] = g; out[2] = b; out[3] = a;
  return out;
}

// ---- pooling ----------------------------------------------------------------
/**
 * Fixed-capacity object pool with a swap-remove free list. `alloc()` returns null
 * when exhausted — callers must handle that rather than growing, so we never
 * allocate mid-frame.
 */
export class Pool {
  constructor(capacity, factory) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = factory(i);
    this.active = 0;
  }
  alloc() {
    if (this.active >= this.capacity) return null;
    return this.items[this.active++];
  }
  /** Free by index. Swaps the last active item into the hole — iterate backwards. */
  freeAt(i) {
    this.active--;
    const tmp = this.items[i];
    this.items[i] = this.items[this.active];
    this.items[this.active] = tmp;
  }
  clear() { this.active = 0; }
}
