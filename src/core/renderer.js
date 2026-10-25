// ARCLIGHT — instanced SDF primitive renderer.
//
// Everything the game draws is one of five signed-distance shapes rendered from a
// single instanced quad. That means the whole scene is ~4 draw calls regardless of
// object count, and every primitive gets a physically-consistent neon halo for free.
//
// Colours are HDR: pass values above 1.0 to make something bloom. That is the only
// mechanism for "brightness" — there is no separate glow colour.

import { createProgram } from './gl.js';

export const SHAPE = {
  RECT: 0,     // rounded rectangle; radius >= min(half extent) gives a capsule/line
  ELLIPSE: 1,
  RING: 2,
  TRI: 3,
  GLOW: 4,     // no core, pure radial falloff — for light haze and fog blobs
};

export const LAYER = {
  FAR_GLOW: 0,   // additive, behind everything — distant city bloom
  SOLID: 1,      // alpha-blended silhouettes and occluders
  NEON: 2,       // additive — the main event
  FOREGROUND: 3, // additive, drawn last — sparks, rain, screen-space flourish
};
const LAYER_COUNT = 4;
const LAYER_ADDITIVE = [true, false, true, true];

const FLOATS_PER_INSTANCE = 16;

// Fragments contributing less than this are discarded; the vertex shader sizes
// each quad to exactly this cutoff, so the two must agree.
const AMOUNT_MIN = '0.0015';

const VS = `#version 300 es
precision highp float;
#define AMOUNT_MIN ${AMOUNT_MIN}

// Per-instance
layout(location=0) in vec4 i_xform;   // cx, cy, halfW, halfH
layout(location=1) in vec4 i_shape;   // rot, shapeId, cornerRadius, parallax
layout(location=2) in vec4 i_color;   // rgb (HDR), alpha
layout(location=3) in vec4 i_fx;      // glowStrength, glowRadius, softness, ringThickness

uniform vec2 u_cam;        // camera centre, world units
uniform vec2 u_res;        // render target size, px
uniform float u_zoom;      // px per world unit
uniform float u_roll;      // camera roll, radians
uniform float u_hdrScale;  // 1.0 on float targets; <1 when the scene target is RGBA8

out vec2 v_local;          // position in shape-local space, world units
out vec2 v_half;
flat out float v_shape;
flat out float v_radius;
out vec4 v_color;
flat out vec4 v_fx;

void main() {
  // Unit quad corners from vertex id, expanded to cover the glow halo.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) - 1.0;
  if (gl_VertexID == 3) corner = vec2( 1.0, -1.0);
  if (gl_VertexID == 4) corner = vec2(-1.0,  1.0);
  if (gl_VertexID == 5) corner = vec2( 1.0,  1.0);

  // Size the quad to exactly where the fragment shader stops producing output —
  // the same AMOUNT_MIN cutoff it discards at. Every fragment past that runs the
  // full SDF + exp() only to be thrown away, and at native 3x that was most of the
  // frame: a fixed 3*glowRadius pad on every shape, including the majority with
  // glow 0, shaded ~2.5x the fragments that could ever reach the target.
  vec2 half_ = i_xform.zw;
  float g = i_fx.x;
  vec2 ext;
  if (i_shape.y > 3.5) {
    // GLOW: exp(-rr^2 * 3.2) * g falls under the cutoff at rr = sqrt(ln(g/min)/3.2).
    float c = log(max(g, AMOUNT_MIN) / AMOUNT_MIN);
    ext = half_ * sqrt(c / 3.2) + 1.0;
  } else {
    // Halo: exp(-1.4x^2 - 0.6x) * g falls under the cutoff at the root of
    // 1.4x^2 + 0.6x = ln(g/min), x in glowRadius units. The core needs SOFT
    // past the edge; a ring's band sits THICKNESS outside its radius.
    float c = log(max(g, AMOUNT_MIN) / AMOUNT_MIN);
    float x = (sqrt(0.36 + 5.6 * c) - 0.6) / 2.8;
    ext = half_ + (x * max(i_fx.y, 1e-3) + i_fx.z + i_fx.w + 1.0);
  }

  v_local = corner * ext;
  v_half  = half_;
  v_shape = i_shape.y;
  v_radius = i_shape.z;
  // Scaling emission here (rather than clamping later) is what keeps the RGBA8
  // fallback usable: the scene lands in [0,1] with headroom, and post multiplies
  // the range back via exposure instead of losing everything above 1.0.
  v_color = vec4(i_color.rgb * u_hdrScale, i_color.a);
  v_fx = i_fx;

  // Local -> world (rotate about the instance centre)
  float sr = sin(i_shape.x), cr = cos(i_shape.x);
  vec2 rotated = vec2(v_local.x * cr - v_local.y * sr, v_local.x * sr + v_local.y * cr);
  vec2 world = i_xform.xy + rotated;

  // World -> view. Parallax scales how much the camera translation applies.
  vec2 rel = world - u_cam * i_shape.w;

  // Camera roll
  float sq = sin(u_roll), cq = cos(u_roll);
  rel = vec2(rel.x * cq - rel.y * sq, rel.x * sq + rel.y * cq);

  // World is +Y down; clip space is +Y up. Flip on output so "down" is down.
  // Rotations stay consistent because the flip is applied uniformly after rotation.
  vec2 clip = rel * u_zoom / (u_res * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
#define AMOUNT_MIN ${AMOUNT_MIN}

in vec2 v_local;
in vec2 v_half;
flat in float v_shape;
flat in float v_radius;
in vec4 v_color;
flat in vec4 v_fx;

out vec4 fragColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float sdEllipse(vec2 p, vec2 r) {
  // Cheap gradient-corrected approximation; exact enough at our scales.
  float k1 = length(p / r);
  float k2 = length(p / (r * r));
  return k2 > 0.0 ? (k1 - 1.0) * k1 / k2 : -min(r.x, r.y);
}
float sdTriangle(vec2 p, vec2 b) {
  // Isosceles triangle with apex at (0, +b.y) and base corners (±b.x, -b.y).
  // Mirroring on X lets us treat it as two edges: apex->corner, and the half-base.
  // The base must be measured as a SEGMENT, not an infinite line — measuring against
  // the line makes the field read ~0 far out to the sides, so soft-edged triangles
  // smear into huge flat sheets instead of fading out.
  p.x = abs(p.x);
  vec2 a = vec2(0.0, b.y);
  vec2 c = vec2(b.x, -b.y);

  vec2 e1 = c - a;
  vec2 w1 = p - a;
  vec2 q1 = w1 - e1 * clamp(dot(w1, e1) / max(dot(e1, e1), 1e-8), 0.0, 1.0);

  vec2 c2 = vec2(0.0, -b.y);
  vec2 e2 = c2 - c;
  vec2 w2 = p - c;
  vec2 q2 = w2 - e2 * clamp(dot(w2, e2) / max(dot(e2, e2), 1e-8), 0.0, 1.0);

  float d = sqrt(min(dot(q1, q1), dot(q2, q2)));
  // Inside when we are on the interior side of the slanted edge AND above the base.
  float s = max(e1.x * w1.y - e1.y * w1.x, -(p.y + b.y));
  return s < 0.0 ? -d : d;
}

void main() {
  float d;
  int shape = int(v_shape + 0.5);

  if (shape == 4) {
    // GLOW is pure light with no surface. It must fall off continuously from the
    // centre: an SDF-based halo is flat wherever d <= 0, which turns any large glow
    // into a saturated disc and washes the whole frame to milk. Use a normalised
    // radial gaussian instead — 1.0 at the centre, ~0.04 at the nominal edge.
    float rr = length(v_local / max(v_half, vec2(1e-4)));
    float g = exp(-rr * rr * 3.2);
    float amt = g * v_fx.x;
    if (amt < AMOUNT_MIN) discard;
    fragColor = vec4(v_color.rgb * amt * v_color.a, 0.0);
    return;
  }

  if (shape == 0) {
    d = sdRoundBox(v_local, v_half, min(v_radius, min(v_half.x, v_half.y)));
  } else if (shape == 1) {
    d = sdEllipse(v_local, max(v_half, vec2(1e-4)));
  } else if (shape == 2) {
    d = abs(sdEllipse(v_local, max(v_half, vec2(1e-4)))) - v_fx.w;
  } else {
    d = sdTriangle(v_local, v_half);
  }

  float glowStrength = v_fx.x;
  float glowRadius   = max(v_fx.y, 1e-3);
  float soft         = max(v_fx.z, 1e-3);

  // Solid core, antialiased across "soft" world units.
  float core = smoothstep(soft, -soft, d);

  // Halo: exponential falloff outside the shape. Squared to tighten the shoulder so
  // it reads as light rather than as a blurry sprite.
  float od = max(d, 0.0) / glowRadius;
  float halo = exp(-od * od * 1.4 - od * 0.6);

  float amount = core + halo * glowStrength;
  if (amount < AMOUNT_MIN) discard;

  fragColor = vec4(v_color.rgb * amount * v_color.a, core * v_color.a);
}`;

export class Renderer {
  constructor(gl, capacity = 4096) {
    this.gl = gl;
    this.capacity = capacity;

    const { program, u } = createProgram(gl, VS, FS, 'sdf');
    this.prog = program;
    this.u = u;

    // One CPU-side staging buffer per layer; uploaded once each at flush time.
    this.data = [];
    this.counts = new Int32Array(LAYER_COUNT);
    for (let i = 0; i < LAYER_COUNT; i++) {
      this.data.push(new Float32Array(capacity * FLOATS_PER_INSTANCE));
    }
    this.overflow = 0;

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * FLOATS_PER_INSTANCE * 4, gl.STREAM_DRAW);
    const stride = FLOATS_PER_INSTANCE * 4;
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);

    this.cam = { x: 0, y: 0, zoom: 1, roll: 0 };
    this.viewW = 1;
    this.viewH = 1;
    this.hdrScale = 1;
  }

  /** Reset for a new frame. Camera is captured here and applies to the whole frame. */
  begin(camX, camY, zoom, roll, viewW, viewH) {
    this.cam.x = camX; this.cam.y = camY; this.cam.zoom = zoom; this.cam.roll = roll;
    this.viewW = viewW; this.viewH = viewH;
    this.counts.fill(0);
    this.overflow = 0;
  }

  /**
   * The single primitive entry point. Everything else is a convenience wrapper.
   * `col` is [r,g,b,a] with rgb unbounded (HDR).
   */
  push(layer, shape, cx, cy, hw, hh, rot, col, glow, glowRadius, soft, radius, parallax, ringThickness) {
    const n = this.counts[layer];
    if (n >= this.capacity) { this.overflow++; return; }
    const a = this.data[layer];
    let o = n * FLOATS_PER_INSTANCE;
    a[o++] = cx; a[o++] = cy; a[o++] = hw; a[o++] = hh;
    a[o++] = rot; a[o++] = shape; a[o++] = radius; a[o++] = parallax;
    a[o++] = col[0]; a[o++] = col[1]; a[o++] = col[2]; a[o++] = col[3];
    a[o++] = glow; a[o++] = glowRadius; a[o++] = soft; a[o] = ringThickness;
    this.counts[layer] = n + 1;
  }

  // ---- convenience wrappers (all allocation-free) ---------------------------

  rect(layer, cx, cy, hw, hh, rot, col, o = {}) {
    this.push(layer, SHAPE.RECT, cx, cy, hw, hh, rot, col,
      o.glow ?? 0, o.glowRadius ?? 8, o.soft ?? 1, o.radius ?? 0, o.parallax ?? 1, 0);
  }

  circle(layer, cx, cy, r, col, o = {}) {
    this.push(layer, SHAPE.ELLIPSE, cx, cy, r, r, 0, col,
      o.glow ?? 0, o.glowRadius ?? r * 1.5, o.soft ?? 1, 0, o.parallax ?? 1, 0);
  }

  ellipse(layer, cx, cy, rx, ry, rot, col, o = {}) {
    this.push(layer, SHAPE.ELLIPSE, cx, cy, rx, ry, rot, col,
      o.glow ?? 0, o.glowRadius ?? Math.max(rx, ry), o.soft ?? 1, 0, o.parallax ?? 1, 0);
  }

  ring(layer, cx, cy, r, thickness, col, o = {}) {
    this.push(layer, SHAPE.RING, cx, cy, r, r, o.rot ?? 0, col,
      o.glow ?? 0, o.glowRadius ?? thickness * 4, o.soft ?? 1, 0, o.parallax ?? 1, thickness);
  }

  tri(layer, cx, cy, hw, hh, rot, col, o = {}) {
    this.push(layer, SHAPE.TRI, cx, cy, hw, hh, rot, col,
      o.glow ?? 0, o.glowRadius ?? hw, o.soft ?? 1, 0, o.parallax ?? 1, 0);
  }

  /** Soft radial light. No hard edge — use for haze, fog, bloom seeds. */
  glow(layer, cx, cy, r, col, o = {}) {
    this.push(layer, SHAPE.GLOW, cx, cy, r, r, 0, col,
      o.glow ?? 1, o.glowRadius ?? r, o.soft ?? 1, 0, o.parallax ?? 1, 0);
  }

  /** A capsule from (x0,y0) to (x1,y1). The workhorse for tethers, beams, trails. */
  line(layer, x0, y0, x1, y1, width, col, o = {}) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-5 && width < 1e-5) return;
    const hw = len * 0.5 + width * 0.5;
    const hh = width * 0.5;
    this.push(layer, SHAPE.RECT, (x0 + x1) * 0.5, (y0 + y1) * 0.5, hw, hh,
      Math.atan2(dy, dx), col,
      o.glow ?? 0, o.glowRadius ?? width * 3, o.soft ?? 1, hh, o.parallax ?? 1, 0);
  }

  /** Submit every layer in order. Returns the number of draw calls issued. */
  flush(gl) {
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.u_cam, this.cam.x, this.cam.y);
    gl.uniform2f(this.u.u_res, this.viewW, this.viewH);
    gl.uniform1f(this.u.u_zoom, this.cam.zoom);
    gl.uniform1f(this.u.u_roll, this.cam.roll);
    gl.uniform1f(this.u.u_hdrScale, this.hdrScale);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enable(gl.BLEND);

    let draws = 0;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const n = this.counts[layer];
      if (n === 0) continue;
      if (LAYER_ADDITIVE[layer]) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data[layer], 0, n * FLOATS_PER_INSTANCE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      draws++;
    }
    gl.bindVertexArray(null);
    return draws;
  }

  get instanceCount() {
    let t = 0;
    for (let i = 0; i < LAYER_COUNT; i++) t += this.counts[i];
    return t;
  }
}
