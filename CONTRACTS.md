# ARCLIGHT — Module Contracts

**Read `DESIGN.md` first.** This file is the binding interface between modules. If you
own a module, you may change anything *inside* your files. You may **not** change a
signature listed here, and you may **not** edit files you do not own.

If you believe a contract is wrong, implement it as written and note the objection in
your final report.

## Ground rules (all modules)

- ES modules, no build step, no bundler. Import with explicit `.js` extensions.
- No dependencies. No CDN. Everything runs offline from the static server.
- **Zero allocation in `update()`/`render()`.** Preallocate scratch arrays at module
  scope; use `Pool` from `core/math.js` for anything transient. No array literals, no
  object literals, no closures, no `.map/.filter/.forEach` in hot paths.
- All tunables live in `core/config.js` (`CFG`) and all colours in `PAL`. Do not
  hardcode numbers or colours in your module — add a field to `CFG`/`PAL` instead.
- Target iOS Safari 16+. No top-level `await`. No optional-chaining-heavy hot loops.
- Syntax-check your work: `node --check <file>` on every file you write.

## Coordinate system

+X is right (the direction of travel), **+Y is down**. World units are metres.
Angles are radians, `atan2(dy, dx)`, so a velocity pointing up-and-right has a
*negative* angle. Careful: "above the horizontal" means `vy < 0`.

## Core (already written — read, don't edit)

- `core/math.js` — `clamp, clamp01, lerp, damp, dampAngle, angleDelta, remap, TAU,`
  `easeOut*, pulse, makeRng, noise1, fbm1, dist, dist2, distToSegment2,`
  `circleVsRect, circleVsOBB, hexToRgb, setRgba, Pool`
- `core/gl.js` — `createContext, createProgram, createTarget, createFullscreenQuad, FULLSCREEN_VS`
- `core/renderer.js` — `Renderer, SHAPE, LAYER`
- `core/config.js` — `CFG, PAL, tint`

### Renderer API

```js
r.begin(camX, camY, zoom, roll, viewW, viewH)
r.rect(layer, cx, cy, hw, hh, rot, col, opts)
r.circle(layer, cx, cy, radius, col, opts)
r.ellipse(layer, cx, cy, rx, ry, rot, col, opts)
r.ring(layer, cx, cy, radius, thickness, col, opts)
r.tri(layer, cx, cy, hw, hh, rot, col, opts)      // isosceles, points +Y before rot
r.glow(layer, cx, cy, radius, col, opts)          // soft light, no core
r.line(layer, x0, y0, x1, y1, width, col, opts)   // capsule
```
`col` is `[r,g,b,a]`, **rgb is HDR and unbounded** — that is how you make something
bloom. `opts` (all optional): `{ glow, glowRadius, soft, radius, parallax }`.
- `glow` — halo strength multiplier (0 = no halo, 1–4 typical for neon).
- `glowRadius` — halo falloff distance in world units.
- `soft` — edge antialias width, world units. Use ~`1/zoom` for crisp, more for haze.
- `radius` — corner rounding for `rect`.
- `parallax` — 1 = world-locked, <1 = distant (camera moves it less), 0 = screen-locked.

`LAYER` = `FAR_GLOW` (additive) → `SOLID` (alpha) → `NEON` (additive) → `FOREGROUND` (additive).
Draw order within a layer is submission order. Layers always composite in the order above.

**`opts` object literals are fine at call sites for now** — they are the one permitted
exception because V8/JSC reliably stack-allocates them. Everything else: no allocation.

---

## Module: `gfx/post.js` — post-processing (owner: POST agent)

```js
export class Post {
  constructor(gl, quad)                       // quad from createFullscreenQuad
  resize(w, h)                                // internal render resolution, px
  get sceneTarget()                           // the HDR target the game renders into
  render(gl, state)                           // composite sceneTarget -> default framebuffer
}
```
`state` fields it may read (all numbers, provided every frame):
`{ time, speed01, overdrive01, trauma, aberration, vignette, flash, damage01, exposure }`
- `speed01` 0..1 normalised velocity — drive radial streaks/CA with this.
- `overdrive01` 0..1 — drive the white-hot look and a subtle hue push.
- `flash` 0..1 — impulse whiteout for impacts.
- `damage01` 0..1 — red edge pulse when close to death.

Required chain: bright-pass → 3 progressive downsample+blur ping-pongs → upsample
combine → tonemap (ACES-ish) → chromatic aberration → radial speed streaks → grain →
scanline → vignette. Must degrade gracefully when `hdr === false` (RGBA8 fallback).

## Module: `gfx/backdrop.js` — parallax city, sky, weather (owner: BACKDROP agent)

```js
export class Backdrop {
  constructor(seed)
  update(dt, camX, camY, speed, overdrive01)
  render(r, camX, camY, viewW, viewH, zoom)   // r = Renderer
}
```
Owns: sky gradient, 5 parallax bands of city silhouette + windows + signage, volumetric
light shafts, rain, fog, distant traffic. Draws only to `FAR_GLOW` and `SOLID` layers
plus rain to `FOREGROUND`. Must be infinite and seamless in +X and stable under
camera Y movement. Must not allocate per frame.

## Module: `game/world.js` — level generation (owner: WORLD agent)

```js
export class World {
  constructor(seed)
  reset(seed)
  update(dt, playerX, playerY)                // streams chunks in/out
  render(r, camX, viewW, zoom, time)
  get anchors()                               // active Anchor list (see below)
  get hazards()                               // active Hazard list
  get orbs()                                  // active Orb list
  get solids()                                // active Solid list (walls/platforms)
}
```
Entity shapes (plain objects, pooled, never reallocated):
```js
Anchor  { x, y, r, alive, kind, phase, used }        // kind: 0 node, 1 heavy, 2 decaying
Hazard  { x, y, hw, hh, rot, kind, alive, phase, vx, vy }  // kind: 0 laser, 1 drone, 2 spinner, 3 gate
Orb     { x, y, r, alive, phase, collected }
Solid   { x, y, hw, hh, rot }                        // static collision geometry
```
Generation must guarantee **reachability**: from any anchor, at least one further
anchor exists within `CFG.TETHER_MAX_RANGE * 0.85` of the ballistic arc a player would
travel. Never generate an unwinnable gap. Respect the difficulty curve in `DESIGN.md`.

## Module: `game/player.js` — physics, tether, collision (owner: PHYSICS agent)

```js
export class Player {
  constructor()
  reset(x, y)
  setInput(down)                              // single boolean, the entire control scheme
  update(dt, world, events)                   // events = EventSink, see below
  render(r, time)
  // read-only state consumed by others:
  x, y, vx, vy, speed, alive, tethered, ropeLen, anchorX, anchorY, angle, trailPoints
}
```
`EventSink` is a plain object with methods the player calls; `main.js` supplies it:
```js
events.perfectArc(x, y, quality01)
events.graze(x, y, objRef)
events.orb(x, y)
events.attach(x, y)
events.release(x, y, speed)
events.crash(x, y, vx, vy)
events.reel(tension01)
```

## Module: `audio/audio.js` — procedural sound (owner: AUDIO agent)

```js
export class Audio {
  constructor()
  async unlock()                              // call from a user gesture
  get enabled()   set enabled(v)              // persists to localStorage
  update(dt, state)                           // state: { speed01, multiplier, overdrive01, tension01, alive, menu }
  // one-shots:
  attach(); release(speed01); perfect(n); graze(); orb(); crash(); overdriveStart(); overdriveEnd(); uiTap();
}
```
No audio files. Everything synthesised. Must never throw if WebAudio is unavailable or
locked — every method is a no-op in that case. Must not create nodes per frame in
`update` (only in one-shots, and those must disconnect on completion).

## Module: `ui/hud.js` + `ui/screens.js` — interface (owner: UI agent)

```js
// hud.js
export class Hud {
  constructor(root)                           // root = <div id="hud">
  update(state)                               // { distance, score, multiplier, charge01, overdrive01, alive, speed01 }
  popup(kind, text, screenX, screenY)         // kind: 'perfect'|'graze'|'orb'|'combo'
  reset()
}
// screens.js
export class Screens {
  constructor(root, callbacks)                // callbacks: { onStart, onRetry, onToggleAudio }
  showTitle(); showGameOver(stats); hide();
  get visible()
}
```
DOM-based, styled in `ui/ui.css`. Must respect `env(safe-area-inset-*)`. Must be
touch-friendly (44px minimum targets) and never intercept gameplay touches outside of
actual buttons (`pointer-events: none` on containers).

---

## Integration owner

`src/main.js` is owned by the integrator (the lead). Do not edit it. It wires
everything, owns the game loop, camera, scoring, overdrive, particles and the event
sink, and passes the state objects described above.
