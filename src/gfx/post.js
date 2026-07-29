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
  // At 0.90 the "world blooming white-hot" that DESIGN.md promises was a 4% channel
  // skew and a bloom you had to A/B to see. 1.35 lifts the (already wide-suppressed)
  // tight halo half again, so overdrive lands as a real change of state.
  OD_BLOOM_LIFT: 1.35,

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

  // ---- overdrive grade -------------------------------------------------------
  // White-point shift toward the palette's white-hot #eaffff. Applied to the
  // ACHROMATIC part of the pixel only (see the composite), so it warms the frame
  // without rotating a saturated hue. The previous form was a flat channel multiply
  // of (0.70, 1.14, 1.30) which took 30% out of RED — it turned every violet anchor
  // and every magenta hazard toward green-cyan, i.e. it deleted the two colours the
  // player most needs to tell apart, in the exact six seconds they are flying at
  // hazards on purpose.
  OD_TINT: [0.92, 1.01, 1.05],
  OD_SAT: 0.50,          // chroma gain at od = 1
  // Contrast as a GAMMA, not as a pivot-and-slope. The old form,
  // clamp((col - 0.22) * 1.55 + 0.22), has a zero crossing at 0.078 linear — every
  // pixel below sRGB 80 went to absolute black, which is the entire city silhouette
  // band. A gamma has no zero crossing: shadows deepen asymptotically and structure
  // survives. sRGB 80 -> 61 at od = 1 instead of -> 0.
  OD_CONTRAST: 0.26,
  OD_LIFT: 1.10,         // gain that puts the highlights back after the gamma

  // Radial chromatic aberration, uv units at the corners. At 0.0075 the R/B split
  // measured 8.8 device px at the frame edge at cruise and 16.7 px on a crash — full
  // rainbow fringing on every rain streak and every small primitive, which reads as
  // an NTSC tear rather than as a lens. 0.0026 puts cruise at ~3.0 px and a crash at
  // ~5.8 px: still unmistakably a lens, no longer a signal fault.
  CA: 0.0026,
  CA_SPEED: 0.85,        // how much speed01 adds on top of state.aberration
  CA_TRAUMA: 0.60,

  STREAK_LEN: 0.085,     // radial blur reach at speed01 = 1, uv units at the corner
  STREAK_INNER: 0.45,    // start of the smoothstep mask — player stays crisp inside
  STREAK_MIX: 0.70,

  GRAIN: 0.020,          // ~2% luma in the low mids, ~0.6% in highlights
  SCAN: 0.028,
  // Vignette floor. 0.28 crushed the corners to 43% of their value in gamma space —
  // whole towers and half the near band dissolved into mud in the outer frame, which
  // is a bad trade in portrait where a third of the play space lives out there.
  VIGNETTE_MIN: 0.42,
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
float acesScalar(float x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Hue-preserving tonemap. THE HIGHLIGHT HUE POLICY LIVES HERE.
//
// Per-channel ACES desaturates by design: it maps each channel independently, so a
// 3.0-intensity cyan (0.4, 3.0, 3.2) comes out (0.54, 0.95, 0.96) — 44% saturation,
// basically white. For a game whose entire identity is coloured light that is fatal,
// and it is why overdrive measured at 0.13 saturation: everything bright had stopped
// being a colour at all.
//
// So the tonemapper is spent on BRIGHTNESS only and the original chroma ratio is
// re-applied. The load-bearing detail is WHICH brightness. The first version of this
// used luminance — scale c by lPost/lPre, then clamp — and that clamp was silently
// doing all the work at the top end, because it is the one gamut operation that
// CHANGES HUE. violetHot (1.55, 1.00, 2.80) carries its luma in G, which is its
// DARKEST channel: lPre = 1.247, so at lPost ~ 1.0 the "hue-safe" result is
// (1.24, 0.80, 2.25) and the clamp lands it on (1.00, 0.80, 1.00). R == B is hue
// exactly 300°, the magenta primary — and magentaHot clamped onto the same 300°.
// Measured through this shader before the fix (palette swatch rig, peak emission):
// violetHot 300.0°/sat 0.148, magentaHot 300.0°/sat 0.423. Two objects the palette
// places 75° apart arrived 0.0° apart, so at peak brightness "grab this" and "this
// kills you" were the same colour.
//
// Normalising by the MAX CHANNEL is in-gamut by construction (every channel is <= m,
// so every channel lands <= acesScalar(m) <= 1) and therefore never needs a clamp.
// The channel ratios — hue and saturation both — survive exactly, and only VALUE is
// tonemapped. It is also the honest answer to "why can a hot core not be saturated":
// you cannot have a saturated violet at luminance 1.0, so we hold value at 1.0 and
// let luminance be whatever that hue permits. The core reads violet; the bloom halo
// around it, which is a sum over many colours, is what carries the white heat.
//
// Measured after, same rig: violetHot 265.5°/sat 0.329, magentaHot 320.0°/sat 0.532
// — 54.5° apart. And measured where it actually matters, by sampling the most
// CHROMATIC lit pixel of every anchor and hazard on screen across a real run (the
// brightest pixel of a neon object is its white core, which is white on purpose):
//     anchors  hue 276.9° -> 260.0° median, sat 0.27 -> 0.39
//     hazards  hue 300.0° -> 318.0° median, sat 0.75 -> 0.77
//     median separation 23° -> 58°
// The load-bearing number is the anchor p90: it was 300.0°, i.e. the top decile of
// anchors by brightness had collapsed exactly onto the magenta primary. It is now
// 268.2°. Nothing in the frame lands on 300° by accident any more.
//
// u_satRecover is the blend against plain per-channel ACES. It is NOT 1.0 on purpose:
// keeping ~25% of the per-channel roll-off leaves a real path to white for the very
// hottest cores, so a 30.0-emission impact still whites out instead of turning into a
// saturated colour chip.
//
// ---- THE HIGHLIGHT KNEE, and why the normalisation alone is not a tonemap --------
// Max-channel normalisation is hue-exact, but it is also SCALE-INVARIANT at the top.
// hueSafe = c * acesScalar(m)/m, and acesScalar(m) -> 1 as m grows, so hueSafe -> c/m
// — the unit chroma vector. That vector does not depend on how much light there is.
// Measured through this exact expression on violetHot (1.55, 1.00, 2.80):
//     k =  1  ->  0.5249  0.3386  0.9481
//     k =  3  ->  0.5536  0.3571  1.0000
//     k = 40  ->  0.5536  0.3571  1.0000
// From k=3 to k=40 — 13x the light — the output was BYTE-IDENTICAL. The palette is
// authored at 2.6–3.0 and typical draw multipliers are x1–x5, so the entire game was
// living on the flat part of the curve: an anchor, an impact core and a laser at ten
// times the emission all resolved to the same three bytes. That is why the frame read
// as flat coloured discs, and it made DESIGN.md's first rule ("every emissive element
// has a dimmer core-to-edge falloff") mathematically unsatisfiable above emission ~2.
//
// The fix is a second gamut destination reached by VALUE, not by hue: white. White is
// the one place a colour can go without rotating, so blending toward vec3(acesScalar(m))
// adds a highlight response while leaving hue exactly where it was on the way up. The
// knee is a smoothstep on m so it costs nothing below it. Measured after, hue held to
// the degree while luminance ramps and saturation rolls off:
//     violetHot   x1 L182 h266 s0.34 -> x4 L205 h264 s0.23 -> x8 L251 h264 -> x14 white
//     magentaHot  x1 L149 h320 s0.56 -> x4 L195 h325 s0.31 -> x8 L253 h320 -> x14 white
//     cyanHot     x1 L197 h183 s0.91 -> x4 L229 h184 s0.39 -> x8 L254 h180 -> x14 white
// (tools/dev/.tonemap.mjs is the model those came from and reproduces both curves.)
//
// NOTE WHICH m THIS IS. It is measured after the black point, gain, CONTRAST and
// exposure, and after bloom has been added — not on the authored palette value. A bare
// 3.0 palette entry arrives here at ~3.8, comfortably under KNEE0, so nothing that is
// merely "a lit object" bleaches. Things that stack — an emissive drawn at x3 of an
// already-3.0 palette colour, overlapping halos, impact cores — do. That is the
// intent: overlap is supposed to be visible, and before this it was not.
const float KNEE0 = 9.0;    // below this, hue-exact normalisation, unchanged behaviour
const float KNEE1 = 60.0;   // at this, fully bleached to white
vec3 tonemap(vec3 c) {
  vec3 tm = acesFilm(c);
  float m = max(max(c.r, c.g), max(c.b, 0.00001));
  vec3 hueSafe = c * (acesScalar(m) / m);
  hueSafe = mix(hueSafe, vec3(acesScalar(m)), smoothstep(KNEE0, KNEE1, m));
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

  // --- impact flash + exposure + hue-preserving tonemap ---------------------------
  // The flash is applied HERE, in linear, in front of the tonemap — not as a post-
  // tonemap additive. A flat add after ACES is a pedestal: it cannot clip highlights
  // (they are already at 1.0), it can only lift the floor, and the 1/2.2 encode then
  // amplifies exactly that damage. Measured on the old post-tonemap additive form:
  // a perfect-arc flash of 0.18 took a gameplay frame from 79% true black to 20.6%,
  // and a crash (flash 1.0) rendered the entire screen as a flat grey card.
  //
  // In front of the tonemap it behaves like light. Two terms, and the split is the
  // whole fix:
  //
  //   GAIN does all the work for ordinary flashes. It is a multiply, so literal black
  //   stays at zero however hard it is driven and the energy goes into ACES clipping
  //   the *highlights* to white — a flash of light, not a grey card. It is quadratic-
  //   dominant (2*fl + 7*fl*fl) because the game's blacks are deliberately CHROMATIC,
  //   not zero: at a flat 7x even a 0.18 flash multiplied the void from luma ~10 to
  //   ~23 and cost 15 points of measured true black. 1.6x at 0.18 is a clean pop that
  //   the histogram does not notice; 10x at 1.0 is still a total white-out.
  //
  //   BLEACH is additive and therefore does lift the floor, so it is gated off below
  //   fl = 0.35 entirely. A perfect arc (flash 0.18) must not touch the black point:
  //   it fires several times per swing chain. A crash (flash 1.0) must white the
  //   screen out completely. A single curve cannot do both; a knee can.
  //
  // Measured, on a gameplay frame that sits at 71.2% true black at rest:
  //   old post-tonemap additive:  flash 0.18 -> 20.6%,  flash 1.0 -> 0.0% (flat grey)
  //   squared, no knee:           flash 0.18 ->  2.1%,  flash 1.0 -> 0.0%
  //   this:                       flash 0.18 -> 70.9%,  flash 1.0 -> 0.0% (true white)
  // Centre-weighted via rn so even a full bleach keeps some falloff at the edges.
  float fl = clamp(u_flash, 0.0, 1.0) * mix(1.0, 0.35, rn);
  float bleach = max(fl - 0.35, 0.0);
  col *= max(u_exposure, 0.0) * (1.0 + fl * 2.0 + fl * fl * 7.0);
  col += vec3(0.92, 0.98, 1.00) * bleach * bleach * 5.0;

  // --- damage vignette (blood in the lens) ---------------------------------------
  // Also in front of the tonemap, and for exactly the reason written above. This used
  // to sit 40 lines further down as a post-tonemap additive of up to 0.85 — the
  // identical pedestal mistake the flash path was rewritten to avoid. Measured: a
  // death frame went from 64.9% true black to 11.2%, the whole screen became one flat
  // magenta card, and the HUD was unreadable for the full 1.15s of the death.
  //
  // Rebuilt as light, in three parts, only the last of which can add energy:
  //   OCCLUSION is a straight multiply. Blood on glass absorbs; a multiply cannot
  //   lift a black pixel, ever, however hard it is driven.
  //   ARTERIAL SHIFT is also a multiply — it re-weights what light does get through
  //   toward red, so the neon at the frame edge turns blood-coloured instead of being
  //   covered by a pink sheet. This is the part that reads as "in the lens".
  //   RIM is the only additive term. It is quadratic in edge and tiny (0.09), so a
  //   genuinely black corner still shows a faint glow, and it is in front of ACES —
  //   which compresses it 3.5:1 — rather than behind it where it would land raw on
  //   the gamma encode.
  //
  // Measured on the death frame at damage01 = 1.0, against a cruise frame that sits at
  // 58-64% true black:  true black 10.6% -> 57.5%,  mean luma 85.5 -> 49.5. The death
  // no longer moves the black point out of its normal gameplay range at all.
  float dmg = clamp(u_damage01, 0.0, 1.0);
  if (dmg > 0.001) {
    float throb = 0.62 + 0.38 * sin(u_time * 8.5);
    // 0.40, not 0.30: in a portrait frame rn is only 0.71 at the top-centre, so a ramp
    // starting at 0.30 already had the HUD at 56% strength — the readout went maroon
    // before the corners did.
    float edge = smoothstep(0.40, 1.10, rn) * dmg;
    col *= 1.0 - edge * 0.55 * throb;
    col *= mix(vec3(1.0), vec3(2.40, 0.28, 0.62), edge * 0.85);
    col += vec3(1.0, 0.05, 0.22) * (edge * edge * throb * 0.09);
  }

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
  // 0.13-saturation white-out with zero black pixels.
  //
  // The version after THAT swung the other way and deleted the city. Three separate
  // faults, all measured through this shader on a live overdrive frame:
  //   - a (0.70, 1.14, 1.30) channel multiply: -30% red, so violet anchors and
  //     magenta hazards both rotated toward green-cyan;
  //   - clamp((col - 0.22) * 1.55 + 0.22), whose zero crossing sits at 0.078 linear
  //     (~sRGB 80): the whole city silhouette band crushed to absolute black, and
  //     true-black went UP from 68% to 78% — the frame did not get punchier, it lost
  //     its subject;
  //   - a saturation boost applied AFTER that clamp, i.e. to pixels whose chroma the
  //     clamp had already thrown away. Measured whole-frame saturation went
  //     0.752 (cruise) -> 0.275 (overdrive). The comment here used to claim
  //     "saturation goes UP". It went down by 63%.
  //
  // ORDER IS THE FIX, and so is choosing operators that cannot clip:
  //   1. gamma contrast — no zero crossing, so silhouettes deepen instead of dying;
  //   2. chroma gain and white-point tint SECOND, on a signal that still has chroma;
  //   3. a hue-exact gamut scale rather than a clamp, at the end.
  // The tint is applied to the ACHROMATIC component only. A flat channel multiply
  // rotates every hue in the frame; separating luma from chroma warms the white point
  // toward #eaffff while leaving the chroma VECTOR — the hue — untouched.
  //
  // Measured on live overdrive frames, cruise in brackets for reference:
  //   whole-frame saturation  0.275 -> 0.788   [cruise 0.73-0.75]
  //   true black              77.8% -> 54.2%   [cruise 58-64%]   the city is back
  //   mean luma                30.8 -> 47.0    [cruise 34-37]     and it is hotter
  //   violetHot at peak     222°/0.04 -> 264°/0.49
  //   magentaHot at peak    299°/0.35 -> 318°/0.77
  // Violet at saturation 0.04 had no hue to speak of; it does now, and it is violet.
  if (od > 0.001) {
    col = pow(col, vec3(1.0 + ${TUNE.OD_CONTRAST.toFixed(3)} * od))
        * mix(1.0, ${TUNE.OD_LIFT.toFixed(3)}, od);
    float lo = dot(col, LUMA);
    col = lo * mix(vec3(1.0), vec3(${TUNE.OD_TINT[0].toFixed(3)}, ${TUNE.OD_TINT[1].toFixed(3)}, ${TUNE.OD_TINT[2].toFixed(3)}), od)
        + (col - lo) * (1.0 + ${TUNE.OD_SAT.toFixed(3)} * od);
    // A chroma gain overshoots the gamut by construction. Clipping the overshoot is
    // the same hue-destroying mistake the tonemap makes above — measured, a straight
    // clamp here dragged magenta hazards from 331° to 308°, i.e. a third of the way
    // back to the magenta primary, in the exact state where saturation is the point.
    // Scaling by the max channel is hue-exact; it costs a little value on pixels that
    // were going to clip to 1.0 anyway, which OD_LIFT has already over-provided.
    col = max(col, 0.0);
    col /= max(max(max(col.r, col.g), col.b), 1.0);
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
  // Peak 0.85, not 1.25: at 1.25 the grain was the dominant texture on the big flat
  // facade washes and the sky, i.e. visible as dirt on the lens rather than as film.
  float gs = smoothstep(0.0, 0.10, lum) * mix(0.85, 0.30, smoothstep(0.0, 0.70, lum));
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
  // Starts later (0.45, not 0.30) and floors higher, so the falloff is a shaped edge
  // rather than a blanket dimming of the outer half of a portrait frame.
  float vig = mix(1.0, ${TUNE.VIGNETTE_MIN.toFixed(3)}, smoothstep(0.45, 1.20, rn));
  // Under overdrive the falloff goes CHROMATIC instead of just retreating: green is
  // attenuated hardest and blue least, so what survives at the frame edge is the
  // palette's violet-hot rather than a dimmer copy of the centre. Written as an
  // attenuation-of-the-attenuation so it degrades to the neutral vignette at od = 0
  // and can never brighten a pixel.
  vec3 vig3 = mix(vec3(vig), 1.0 - (1.0 - vig) * vec3(0.70, 1.10, 0.45), od);
  col *= mix(vec3(1.0), vig3, clamp(u_vignette, 0.0, 1.0));

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
