// ARCLIGHT — post-processing stack.
//
// The scene is drawn into an HDR (RGBA16F) target with emissive values well above 1.0.
// Everything that makes the game look like a photograph of real neon rather than a
// bunch of coloured quads happens here:
//
//   scene(HDR) ──► bright pass + 1/2 downsample (soft knee + Karis average)
//                     │
//                     ├─► 1/4 ─► 1/8 ─► 1/16     (13-tap dual-filter downsample)
//                     │                    │
//                     └──◄── 9-tap tent upsample, additive, per-level weight ──◄──┘
//                     │
//   scene(HDR) ───────┴─► composite: CA ▸ radial streaks ▸ bloom ▸ exposure ▸ ACES
//                          ▸ overdrive grade ▸ flash ▸ damage ▸ grain ▸ scanlines
//                          ▸ vignette ▸ gamma ▸ dither ──► default framebuffer
//
// Why a progressive mip chain instead of one separable gaussian: a single-scale blur
// has a fixed, visible kernel width. It makes bloom look like a Photoshop filter — a
// boxy halo that ends abruptly. Chaining 4 downsamples and tent-upsampling back up
// produces a near-perfect approximation of a very wide gaussian for the cost of ~1.3
// full-res passes, and gives us a *per-octave* weight knob so we can have both a tight
// hot halo on the tether and a wide atmospheric haze across the whole canyon.

import { createProgram, createTarget, FULLSCREEN_VS } from '../core/gl.js';

// ---------------------------------------------------------------------------
// Tunables.
//
// CONTRACT NOTE: the ground rules say all tunables belong in `core/config.js`.
// This module may not edit that file, so post-only tunables live here. None of
// these are read by any other module; if CFG later grows a POST block, this table
// should move wholesale.
// ---------------------------------------------------------------------------
const MIPS = 4;

const TUNE = {
  // Bright pass. Threshold sits at 1.0 in HDR because PAL's "Hot" colours are
  // authored at 2.6–3.0 — they blow past it hard, while the near-black silhouettes
  // (0.02) contribute nothing. KNEE is a *fraction* of threshold: the soft shoulder
  // spans threshold±knee so a pixel drifting across 1.0 fades in instead of popping.
  // A hard cutoff here is the single most common cause of bloom fireflies.
  THRESHOLD_HDR: 1.00,
  THRESHOLD_LDR: 0.52,   // RGBA8 fallback: scene is clamped at 1.0, so aim lower
  KNEE: 0.55,

  // Upsample tent radius, in source texels. >1 widens the glow at the cost of a
  // little "box"-iness; 1.15 is the sweet spot for 4 octaves.
  UP_RADIUS: 1.15,

  // Per-octave weight applied when mip[i] is added into mip[i-1]. Index 0 unused.
  //
  // These are deliberately steep. The wide octaves are the entire reason a bloom
  // reads as "fog over everything" instead of "light around neon": mip3 is a 1/16-res
  // blur, so its energy lands as an almost perfectly flat pedestal across the frame,
  // and a pedestal is exactly what destroys the black point. Cascaded, the surviving
  // fraction of each octave in the final mip0 is:
  //     mip0 1.00   mip1 0.45   mip2 0.126   mip3 0.025
  // i.e. the widest octave contributes 2.5%, enough to feel the haze, not enough to
  // lift the void off black. (Was 1.00 / 0.92 / 0.78 / 0.61 — a 3.3x flatter chain
  // that measured out at meanLum 77 with 14% true black.)
  UP_WEIGHT: [1.0, 0.45, 0.28, 0.20],

  // As overdrive rises we lift the TIGHT halo and actively suppress the wide octaves,
  // so the screen gets hotter without getting milkier. Index 0 unused (mip0 is the
  // bright pass itself and always contributes at weight 1).
  OD_WIDE_SUPPRESS: [0.0, 0.15, 0.40, 0.55],
  OD_BLOOM_LIFT: 0.90,

  BLOOM_HDR: 0.34,
  BLOOM_LDR: 0.52,       // fallback bloom is dimmer (clamped source), so lift it
  SCENE_SCALE_LDR: 1.22, // and push the base image a touch to fake the lost range

  // ---- grade ---------------------------------------------------------------
  // Applied in LINEAR, after bloom, before exposure/tonemap.
  // BLACK is a flat pedestal subtraction: bloom and volumetric fog both deposit an
  // almost uniform offset over the whole frame, and a flat subtract is the exact
  // inverse of that — it restores luminance AND chroma ratio simultaneously, which
  // a gamma or gain adjustment cannot do.
  // NOTE the size of this number. It is a pedestal remover, not a crush. At 0.055 it
  // measured beautifully (70% true black) and looked *wrong*: it annihilated the deep
  // blue void and the sky along with the haze, leaving neon floating on dead black.
  // The target look keeps the shadows at a low but strongly CHROMATIC blue — the
  // title screen's "black" is really about (22,33,46), which is what lets it score
  // 83% true black and 0.62 saturation at the same time.
  BLACK: 0.016,
  GAIN: 1.06,
  CONTRAST: 1.15,        // pow() in linear: crushes haze, expands neon

  // Fraction of the tonemap done hue-preserving rather than per-channel.
  SAT_RECOVER: 0.75,
  VIBRANCE: 1.30,        // post-tonemap chroma expansion around luma

  CA: 0.0075,            // radial chromatic aberration, uv units at the corners
  CA_SPEED: 0.85,        // how much speed01 adds on top of state.aberration
  CA_TRAUMA: 0.60,

  STREAK_LEN: 0.085,     // radial blur reach at speed01 = 1, uv units at the corner
  STREAK_INNER: 0.45,    // start of the smoothstep mask — player stays crisp inside
  STREAK_MIX: 0.70,

  GRAIN: 0.032,          // ~3% luma in the low mids, ~1% in highlights
  SCAN: 0.028,
  VIGNETTE_MIN: 0.28,
};

const UP_WEIGHT = new Float32Array(TUNE.UP_WEIGHT);
const OD_WIDE_SUPPRESS = new Float32Array(TUNE.OD_WIDE_SUPPRESS);

// Defaults for every field of `state`. Used when the caller passes a partial object
// (or nothing at all) so the post stack can never NaN out the whole screen.
const DEFAULTS = {
  time: 0, speed01: 0, overdrive01: 0, trauma: 0,
  aberration: 0, vignette: 1, flash: 0, damage01: 0, exposure: 1,
};

/** Read a numeric field with a fallback. Rejects NaN/undefined/non-numbers. */
function num(v, d) {
  return (typeof v === 'number' && v === v) ? v : d;
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

function fragment(defines, body) {
  // #version MUST be the first token in the source; defines go immediately after.
  return '#version 300 es\n' + defines + body;
}

// 13-tap "dual filter" downsample (Jimenez, Next Generation Post Processing in
// Call of Duty: Advanced Warfare). Five overlapping 2x2 boxes — four at the corners
// weighted 0.125 each and one centre box weighted 0.5 — which is a much better
// approximation of a gaussian than a 4-tap bilinear box and, critically, has no
// "stair-step" temporal aliasing when the camera moves sub-pixel amounts.
const DOWNSAMPLE_FS = `
// Default mediump: the colour maths is all fp16-safe (HDR values top out around 30,
// well inside mediump's range) and fp16 ALU is 2x rate on Apple GPUs.
// BUT texture coordinates are explicitly highp. At half res a texel is ~1/850 of the
// uv range while fp16 resolves ~1/2048 near uv=1.0 — mediump uvs would snap taps to
// the wrong texel in the bottom-right of the screen and make the bloom crawl.
precision mediump float;

uniform mediump sampler2D u_tex;
uniform highp vec2 u_texel;   // 1 / source size
uniform vec4 u_knee;          // (threshold-knee, 2*knee, 0.25/knee, threshold)

in highp vec2 v_uv;
out vec4 fragColor;

vec3 prefilter(vec3 c) {
#ifdef THRESHOLD
  // Soft-knee bright pass (the Unity/Bloom curve). Below (threshold-knee) nothing
  // passes; across the 2*knee window the response ramps quadratically; above
  // threshold it becomes a plain subtraction. Evaluated per *tap* rather than after
  // the average so a lone sub-threshold-but-bright texel cannot smuggle energy in.
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_knee.x, 0.0, u_knee.y);
  soft = soft * soft * u_knee.z;
  c *= max(soft, br - u_knee.w) / max(br, 0.00001);
#endif
  return c;
}

vec3 tap(highp vec2 uv) { return prefilter(texture(u_tex, uv).rgb); }

#ifdef KARIS
// Karis average: weight each texel of a 2x2 group by 1/(1+luma) before averaging.
// A 1-pixel-wide neon line that lands on a texel at 30.0 would otherwise dominate
// its whole group; when the camera shifts half a pixel the group changes and the
// bloom *flickers*. Inverse-luma weighting makes the average roughly perceptual and
// kills that shimmer at the cost of slightly dimmer, softer highlights.
float karisW(vec3 c) {
  return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
}
vec3 grp(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = karisW(a), wb = karisW(b), wc = karisW(c), wd = karisW(d);
  return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 0.0001);
}
#else
vec3 grp(vec3 a, vec3 b, vec3 c, vec3 d) { return (a + b + c + d) * 0.25; }
#endif

void main() {
  highp vec2 t = u_texel;

  //  a . b . c
  //  . j . k .
  //  d . e . f
  //  . l . m .
  //  g . h . i
  vec3 a  = tap(v_uv + vec2(-2.0, -2.0) * t);
  vec3 b  = tap(v_uv + vec2( 0.0, -2.0) * t);
  vec3 c  = tap(v_uv + vec2( 2.0, -2.0) * t);
  vec3 dd = tap(v_uv + vec2(-2.0,  0.0) * t);
  vec3 e  = tap(v_uv);
  vec3 f  = tap(v_uv + vec2( 2.0,  0.0) * t);
  vec3 g  = tap(v_uv + vec2(-2.0,  2.0) * t);
  vec3 hh = tap(v_uv + vec2( 0.0,  2.0) * t);
  vec3 i  = tap(v_uv + vec2( 2.0,  2.0) * t);
  vec3 j  = tap(v_uv + vec2(-1.0, -1.0) * t);
  vec3 k  = tap(v_uv + vec2( 1.0, -1.0) * t);
  vec3 l  = tap(v_uv + vec2(-1.0,  1.0) * t);
  vec3 m  = tap(v_uv + vec2( 1.0,  1.0) * t);

  vec3 o = grp(j, k, l, m)     * 0.500
         + grp(a, b, dd, e)    * 0.125
         + grp(b, c, e, f)     * 0.125
         + grp(dd, e, g, hh)   * 0.125
         + grp(e, f, hh, i)    * 0.125;

  fragColor = vec4(max(o, vec3(0.0)), 1.0);
}`;

// 9-tap tent (bilinear 3x3, weights 1-2-1 / 2-4-2 / 1-2-1). Paired with the 13-tap
// downsample this is what turns four discrete octaves into one continuous falloff —
// a plain bilinear upsample leaves visible ring artefacts at each octave boundary.
// Output is additively blended into the destination mip with a per-level weight.
const UPSAMPLE_FS = `
precision mediump float;

uniform mediump sampler2D u_tex;
uniform highp vec2 u_texel;   // (radius / source width, radius / source height)
uniform float u_weight;

in highp vec2 v_uv;
out vec4 fragColor;

void main() {
  // Offsets built as named highp locals so there is no ambiguity about the precision
  // of a mixed literal/highp constructor on any given driver.
  highp vec2 dx = vec2(u_texel.x, 0.0);
  highp vec2 dy = vec2(0.0, u_texel.y);

  vec3 s = texture(u_tex, v_uv - dx - dy).rgb;
  s     += texture(u_tex, v_uv      - dy).rgb * 2.0;
  s     += texture(u_tex, v_uv + dx - dy).rgb;
  s     += texture(u_tex, v_uv - dx     ).rgb * 2.0;
  s     += texture(u_tex, v_uv          ).rgb * 4.0;
  s     += texture(u_tex, v_uv + dx     ).rgb * 2.0;
  s     += texture(u_tex, v_uv - dx + dy).rgb;
  s     += texture(u_tex, v_uv      + dy).rgb * 2.0;
  s     += texture(u_tex, v_uv + dx + dy).rgb;

  fragColor = vec4(s * (u_weight * 0.0625), 1.0);
}`;

// One fragment shader does the entire grade. Every extra fullscreen pass on a
// tiled mobile GPU costs a full framebuffer round-trip, so the composite is
// deliberately monolithic even though it is long.
const COMPOSITE_FS = `
precision highp float;

uniform mediump sampler2D u_scene;
uniform mediump sampler2D u_bloom;

uniform vec2  u_res;          // output resolution, px — scanline/dither lock to this
uniform float u_time;         // wrapped to keep highp sin() phase accurate
uniform float u_grainSeed;    // per-frame, derived from time
uniform float u_speed01;
uniform float u_overdrive01;
uniform float u_aberration;
uniform float u_vignette;
uniform float u_flash;
uniform float u_damage01;
uniform float u_exposure;
uniform float u_trauma;
uniform float u_bloomIntensity;
uniform float u_sceneScale;
uniform float u_black;        // linear pedestal removed after bloom
uniform float u_gain;
uniform float u_contrast;
uniform float u_satRecover;
uniform float u_vibrance;

in vec2 v_uv;
out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Narkowicz 2015 fit of the ACES RRT+ODT.
vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Hue-preserving tonemap.
//
// Per-channel ACES desaturates by design: it maps each channel independently, so a
// 3.0-intensity cyan (0.4, 3.0, 3.2) comes out (0.54, 0.95, 0.96) — 44% saturation,
// basically white. For a game whose entire identity is coloured light that is fatal,
// and it is why overdrive measured at 0.13 saturation: everything bright had stopped
// being a colour at all.
//
// The fix is to spend the tonemapper on LUMINANCE only and re-apply the original
// chroma ratio at the new luminance. That same cyan becomes (0.14, 1.0, 1.0) — still
// a bright core, but unmistakably cyan. Blending the two (u_satRecover) keeps a little
// of the per-channel roll-off so the very hottest cores still bloom toward white
// rather than turning into flat colour chips.
vec3 tonemap(vec3 c) {
  vec3 tm = acesFilm(c);
  float lPre = max(dot(c, LUMA), 0.00001);
  float lPost = dot(tm, LUMA);
  vec3 hueSafe = clamp(c * (lPost / lPre), 0.0, 1.0);
  return mix(tm, hueSafe, u_satRecover);
}

// Jimenez interleaved gradient noise — blue-noise-ish spectrum from three constants.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 uv = v_uv;
  vec2 dc = uv - 0.5;
  float rn = length(dc) * 1.41421356;          // 0 at centre, ~1.0 at the corners
  float od = clamp(u_overdrive01, 0.0, 1.0);

  // --- overdrive scan distortion -------------------------------------------------
  // A single narrow band crawling up the frame that shears x by ~2px. Narrow +
  // fast reads as a signal glitch; wide + slow would read as a wobbly lens.
  float band = fract(uv.y * 0.75 + u_time * 0.31);
  float bandMask = smoothstep(0.0, 0.05, band) * (1.0 - smoothstep(0.05, 0.16, band));
  uv.x += bandMask * od * 0.0055 * sin(u_time * 26.0 + uv.y * 40.0);

  // --- chromatic aberration ------------------------------------------------------
  // Offset grows as r^2 (dc is already linear in r, times rn), so the centre of the
  // screen — where the player is — stays perfectly registered and only the corners
  // fringe. Driven by explicit state.aberration plus speed and camera trauma.
  float ca = (max(u_aberration, 0.0)
            + clamp(u_speed01, 0.0, 1.0) * ${TUNE.CA_SPEED.toFixed(3)}
            + max(u_trauma, 0.0) * ${TUNE.CA_TRAUMA.toFixed(3)}) * ${TUNE.CA.toFixed(5)};
  vec2 caOff = dc * rn * ca;

  vec3 col;
  col.r = texture(u_scene, uv + caOff).r;
  col.g = texture(u_scene, uv).g;
  col.b = texture(u_scene, uv - caOff).b;
  col *= u_sceneScale;

  // --- radial speed streaks ------------------------------------------------------
  // A real radial blur: 8 taps marching back toward the screen centre. Masked by a
  // smoothstep on radius so the inner ~55% (where the player and the tether live)
  // is untouched and stays readable at any speed. Sample positions are computed from
  // the loop index rather than accumulated, so the fetches are independent and the
  // GPU can issue them all at once.
  float sp = clamp(u_speed01, 0.0, 1.0);
  float streak = smoothstep(${TUNE.STREAK_INNER.toFixed(3)}, 1.0, rn) * sp;
  if (streak > 0.004) {
    vec2 stepv = -dc * (${TUNE.STREAK_LEN.toFixed(4)} * streak * 0.25);
    vec3 acc = vec3(0.0);
    // textureLod, not texture: this loop sits inside non-uniform control flow, where
    // implicit-LOD sampling is undefined in GLSL ES 3.00 (the derivatives are bogus).
    // The scene target has no mip chain anyway, so lod 0 is exactly what we want.
    for (int i = 0; i < 8; i++) {
      acc += textureLod(u_scene, uv + stepv * float(i + 1), 0.0).rgb;
    }
    acc *= 0.125 * u_sceneScale;
    col = mix(col, acc, streak * ${TUNE.STREAK_MIX.toFixed(3)});
    col += acc * streak * 0.18;   // put back the highlight energy the average ate
  }

  // --- bloom ---------------------------------------------------------------------
  // Added before exposure so the tonemapper sees scene+bloom as one light field;
  // that is what stops bloom from looking like a decal pasted over the image.
  // The overdrive lift lives in the per-octave upsample weights (set on the CPU), not
  // here, so that overdrive brightens the tight halo without flooding the frame.
  vec3 bloom = texture(u_bloom, uv).rgb;
  col += bloom * u_bloomIntensity;

  // --- black point + contrast (LINEAR, post-bloom) -------------------------------
  // The single highest-impact operation in this shader. Bloom and fog deposit a
  // near-uniform pedestal; without removing it nothing in the frame ever reaches
  // black and the whole image reads as lifted grey-lavender. A flat subtract is the
  // exact inverse of a flat pedestal, so it restores the black point AND the chroma
  // ratio of the dark blues (subtracting equally from R and B leaves the saturated
  // void colour intact instead of washing it toward grey).
  col = max(col - u_black, vec3(0.0)) * u_gain;
  // pow() in linear space: <1 values get crushed toward zero, >1 emissive values get
  // expanded. This is a contrast curve that costs the shadows nothing and gives the
  // neon its punch back. DESIGN.md: "structure is near-black silhouette; light does
  // the drawing" — this is the operator that enforces it.
  col = pow(col, vec3(u_contrast));

  // --- exposure + hue-preserving tonemap -----------------------------------------
  col *= max(u_exposure, 0.0);
  col = tonemap(col);

  // --- vibrance ------------------------------------------------------------------
  // Chroma expansion around luma. Pulls the deep blue void back to a saturated blue
  // rather than a neutral dark grey, which is most of what separates the title screen
  // (sat 0.62) from the old gameplay frame (sat 0.42).
  {
    float lv = dot(col, LUMA);
    col = clamp(mix(vec3(lv), col, u_vibrance), 0.0, 1.0);
  }

  // --- overdrive grade -----------------------------------------------------------
  // A GRADE, not an exposure push. The old version multiplied exposure, lifted bloom
  // 2.1x and then bleached toward white — which is exactly how you get a 141-luma,
  // 0.13-saturation white-out with zero black pixels. Instead: bias the channels
  // toward the palette's white-hot #eaffff, RAISE contrast (so the blacks get blacker
  // while the highlights get hotter), and push saturation UP.
  if (od > 0.001) {
    col *= mix(vec3(1.0), vec3(0.82, 1.06, 1.16), od);
    // Contrast about a LOW pivot (0.22, not 0.40). Pivoting near mid-grey looked
    // right on paper but drove the chromatic blue shadows to literal zero, which is
    // the same mistake as an over-aggressive black point: the frame keeps its blacks
    // but loses all colour in them. Low pivot + gentle slope deepens the silhouettes
    // while leaving the blue in them.
    col = clamp((col - 0.22) * (1.0 + 0.30 * od) + 0.22, 0.0, 1.0);
    // Saturation goes UP in overdrive, not down. Overdrive should read as the city
    // screaming in colour, not as the screen dying.
    float lo = dot(col, LUMA);
    col = clamp(mix(vec3(lo), col, 1.0 + 0.70 * od), 0.0, 1.0);
  }

  // --- impact flash --------------------------------------------------------------
  col += vec3(0.92, 0.98, 1.00) * clamp(u_flash, 0.0, 1.0);

  // --- damage vignette -----------------------------------------------------------
  // Throbbing magenta/red at the edges. Additive glow plus a small multiplicative
  // crush, so it reads as blood in the lens rather than as pink fog.
  float dmg = clamp(u_damage01, 0.0, 1.0);
  if (dmg > 0.001) {
    float throb = 0.55 + 0.45 * sin(u_time * 8.5);
    float edge = smoothstep(0.38, 1.05, rn);
    col += vec3(1.0, 0.07, 0.36) * edge * dmg * (0.30 + 0.55 * throb);
    col *= 1.0 - edge * dmg * 0.18;
  }

  // --- film grain ----------------------------------------------------------------
  // Stronger in shadows, near-zero in highlights: real sensor noise behaves that way,
  // and it doubles as free dithering across the huge dark-blue gradients this game
  // is mostly made of.
  // The shape matters: grain is rolled OFF again below ~10% luma. Once the black
  // point is doing its job the void is genuinely dark, and constant-amplitude noise
  // on a near-black field reads as sensor dirt / dither speckle rather than film.
  // Peak the grain in the low mids where there is actually image to texture.
  float lum = dot(col, LUMA);
  float g = hash13(vec3(gl_FragCoord.xy, u_grainSeed * 137.0)) - 0.5;
  float gs = smoothstep(0.0, 0.10, lum) * mix(1.25, 0.30, smoothstep(0.0, 0.70, lum));
  col += g * ${TUNE.GRAIN.toFixed(4)} * gs;

  // --- scanlines + roll bar ------------------------------------------------------
  // Locked to output pixels (period 3px) so it never moirés with the panel. The roll
  // bar is a very slow, very faint brightening band — the kind of thing you only
  // notice when it is missing.
  float scan = 0.5 + 0.5 * sin(uv.y * u_res.y * 2.0943951);
  col *= 1.0 - ${TUNE.SCAN.toFixed(4)} * scan;
  float rb = fract(uv.y * 0.9 - u_time * 0.055);
  float rbm = smoothstep(0.0, 0.30, rb) * (1.0 - smoothstep(0.30, 0.62, rb));
  col *= 1.0 + rbm * 0.022;

  // --- vignette ------------------------------------------------------------------
  float vig = mix(1.0, ${TUNE.VIGNETTE_MIN.toFixed(3)}, smoothstep(0.30, 1.15, rn));
  col *= mix(1.0, vig, clamp(u_vignette, 0.0, 1.0));

  // --- output --------------------------------------------------------------------
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

  // Triangular-PDF dither, +/-1 LSB, applied in *output* (gamma) space. The dark blue
  // void gradient spans maybe six 8-bit codes across a whole phone screen; without
  // this you get hard contour bands, and OLED makes them impossible to ignore.
  // Two decorrelated IGN samples give a triangular distribution, which removes the
  // noise-modulation artefact a single uniform sample leaves behind.
  float d1 = ign(gl_FragCoord.xy);
  float d2 = ign(gl_FragCoord.xy + vec2(37.13, 17.71));
  col += (d1 + d2 - 1.0) * (1.0 / 255.0);

  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Float-target probe
// ---------------------------------------------------------------------------

/**
 * `createContext` already tries the extensions, but extension presence does not
 * guarantee a *renderable* RGBA16F attachment on every iOS GPU/driver combination.
 * Actually allocate a 4x4 target and ask the driver. Cheap, once, at construction.
 */
function probeFloatTargets(gl) {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let ok = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch (err) {
    ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  gl.getError();   // swallow anything the probe raised
  return ok;
}

// ---------------------------------------------------------------------------

export class Post {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{vao: WebGLVertexArrayObject, draw: () => void}} quad from createFullscreenQuad
   */
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;

    this.w = 0;
    this.h = 0;
    this.quality = 1;
    this.hdr = probeFloatTargets(gl);

    // Bright pass: threshold + Karis. Downsample: neither (Karis is only correct on
    // the first reduction — applying it further up the chain progressively eats the
    // highlights and the bloom goes grey).
    this.bright = createProgram(
      gl, FULLSCREEN_VS,
      fragment('#define THRESHOLD 1\n#define KARIS 1\n', DOWNSAMPLE_FS), 'post:bright');
    this.down = createProgram(
      gl, FULLSCREEN_VS, fragment('', DOWNSAMPLE_FS), 'post:down');
    this.up = createProgram(
      gl, FULLSCREEN_VS, fragment('', UPSAMPLE_FS), 'post:up');
    this.comp = createProgram(
      gl, FULLSCREEN_VS, fragment('', COMPOSITE_FS), 'post:composite');

    // Sampler bindings never change — set them once so `render` never touches them.
    gl.useProgram(this.bright.program);
    gl.uniform1i(this.bright.u.u_tex, 0);
    gl.useProgram(this.down.program);
    gl.uniform1i(this.down.u.u_tex, 0);
    gl.useProgram(this.up.program);
    gl.uniform1i(this.up.u.u_tex, 0);
    gl.useProgram(this.comp.program);
    gl.uniform1i(this.comp.u.u_scene, 0);
    gl.uniform1i(this.comp.u.u_bloom, 1);
    gl.useProgram(null);

    // Targets. Sized for real in `resize`; 2x2 keeps them legal until then.
    this._scene = createTarget(gl, 2, 2, { float: this.hdr, linear: true });
    this.mips = new Array(MIPS);
    this.mipW = new Int32Array(MIPS);
    this.mipH = new Int32Array(MIPS);
    for (let i = 0; i < MIPS; i++) {
      // Bloom mips are always linear-filtered — the tent upsample depends on it.
      this.mips[i] = createTarget(gl, 2, 2, { float: this.hdr, linear: true });
    }

    // Precomputed knee curve, recomputed only if the HDR mode changes (it cannot).
    const thr = this.hdr ? TUNE.THRESHOLD_HDR : TUNE.THRESHOLD_LDR;
    const knee = Math.max(1e-4, thr * TUNE.KNEE);
    this.kneeX = thr - knee;
    this.kneeY = 2 * knee;
    this.kneeZ = 0.25 / knee;
    this.kneeW = thr;

    this.bloomIntensity = this.hdr ? TUNE.BLOOM_HDR : TUNE.BLOOM_LDR;
    this.sceneScale = this.hdr ? 1.0 : TUNE.SCENE_SCALE_LDR;

    this.disposed = false;
  }

  /** The HDR target the game renders its scene into. Bind it, clear it, draw. */
  get sceneTarget() { return this._scene; }

  /** Internal render resolution in device pixels. No-op if unchanged. */
  resize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this._scene.resize(w, h);
    this._resizeMips();
  }

  /**
   * Adaptive quality hook. `scale` in [0.5, 1.0] shrinks every bloom mip, which is
   * where nearly all the post fill cost lives — at 0.5 the chain runs at 1/4 .. 1/32
   * of screen res and costs a quarter as much, for a barely perceptible softening.
   */
  setQuality(scale) {
    const q = Math.min(1, Math.max(0.5, num(scale, 1)));
    if (Math.abs(q - this.quality) < 1e-3) return;
    this.quality = q;
    if (this.w > 0) this._resizeMips();
  }

  _resizeMips() {
    let bw = Math.max(2, Math.round(this.w * 0.5 * this.quality));
    let bh = Math.max(2, Math.round(this.h * 0.5 * this.quality));
    for (let i = 0; i < MIPS; i++) {
      this.mipW[i] = bw;
      this.mipH[i] = bh;
      this.mips[i].resize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
  }

  /**
   * Composite `sceneTarget` to the default framebuffer.
   * Allocates nothing; every uniform location was cached at construction.
   */
  render(gl, state) {
    if (this.disposed || this.w === 0) return;
    const s = state || DEFAULTS;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);

    // Overdrive reshapes the bloom *chain* rather than its intensity: the wide
    // octaves are suppressed while the overall gain rises, so the tight halo around
    // each neon element gets hotter without the low-frequency octaves flooding the
    // frame with grey. Doing it here (uniform values) rather than in the composite
    // is what makes "tight octaves only" actually possible with one bloom texture.
    const od = clamp01(num(s.overdrive01, 0));

    // ---- 1. bright pass: full-res scene -> mip0 (half res) ----------------------
    const bp = this.bright;
    gl.useProgram(bp.program);
    gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
    gl.uniform2f(bp.u.u_texel, 1 / this.w, 1 / this.h);
    gl.uniform4f(bp.u.u_knee, this.kneeX, this.kneeY, this.kneeZ, this.kneeW);
    this.mips[0].bind();
    this.quad.draw();

    // ---- 2. progressive downsample: mip0 -> mip1 -> mip2 -> mip3 ----------------
    const dp = this.down;
    gl.useProgram(dp.program);
    for (let i = 1; i < MIPS; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.mips[i - 1].tex);
      gl.uniform2f(dp.u.u_texel, 1 / this.mipW[i - 1], 1 / this.mipH[i - 1]);
      this.mips[i].bind();
      this.quad.draw();
    }

    // ---- 3. upsample + additive combine: mip3 -> ... -> mip0 --------------------
    const up = this.up;
    gl.useProgram(up.program);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = MIPS - 1; i > 0; i--) {
      gl.bindTexture(gl.TEXTURE_2D, this.mips[i].tex);
      gl.uniform2f(up.u.u_texel,
        TUNE.UP_RADIUS / this.mipW[i], TUNE.UP_RADIUS / this.mipH[i]);
      gl.uniform1f(up.u.u_weight, UP_WEIGHT[i] * (1 - od * OD_WIDE_SUPPRESS[i]));
      this.mips[i - 1].bind();
      this.quad.draw();
    }
    gl.disable(gl.BLEND);

    // ---- 4. composite -> default framebuffer ------------------------------------
    // Output at the drawing-buffer size, not the internal size: when the adaptive
    // system drops internal resolution we still want a full-resolution grade, and
    // the scene target's LINEAR filter gives us the upscale for free.
    const ow = gl.drawingBufferWidth || this.w;
    const oh = gl.drawingBufferHeight || this.h;

    const c = this.comp;
    gl.useProgram(c.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mips[0].tex);
    gl.activeTexture(gl.TEXTURE0);

    // highp float holds ~7 significant digits; wrapping keeps sin() phase accurate
    // for the life of a session. The grain seed is derived on the CPU in doubles.
    const t = num(s.time, 0);
    const tw = t - Math.floor(t / 3600) * 3600;
    let seed = t * 71.317;
    seed = seed - Math.floor(seed);

    gl.uniform2f(c.u.u_res, ow, oh);
    gl.uniform1f(c.u.u_time, tw);
    gl.uniform1f(c.u.u_grainSeed, seed);
    gl.uniform1f(c.u.u_speed01, num(s.speed01, 0));
    gl.uniform1f(c.u.u_overdrive01, num(s.overdrive01, 0));
    gl.uniform1f(c.u.u_aberration, num(s.aberration, 0));
    gl.uniform1f(c.u.u_vignette, num(s.vignette, 1));
    gl.uniform1f(c.u.u_flash, num(s.flash, 0));
    gl.uniform1f(c.u.u_damage01, num(s.damage01, 0));
    gl.uniform1f(c.u.u_exposure, num(s.exposure, 1));
    gl.uniform1f(c.u.u_trauma, num(s.trauma, 0));
    gl.uniform1f(c.u.u_bloomIntensity, this.bloomIntensity * (1 + od * TUNE.OD_BLOOM_LIFT));
    gl.uniform1f(c.u.u_sceneScale, this.sceneScale);
    gl.uniform1f(c.u.u_black, TUNE.BLACK);
    gl.uniform1f(c.u.u_gain, TUNE.GAIN);
    gl.uniform1f(c.u.u_contrast, TUNE.CONTRAST);
    gl.uniform1f(c.u.u_satRecover, TUNE.SAT_RECOVER);
    gl.uniform1f(c.u.u_vibrance, TUNE.VIBRANCE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ow, oh);
    this.quad.draw();

    // Leave the unit-1 binding clear so nothing downstream inherits a stale texture.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this._scene.dispose();
    for (let i = 0; i < MIPS; i++) this.mips[i].dispose();
    gl.deleteProgram(this.bright.program);
    gl.deleteProgram(this.down.program);
    gl.deleteProgram(this.up.program);
    gl.deleteProgram(this.comp.program);
  }
}
