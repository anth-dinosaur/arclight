# ARCLIGHT

A one-thumb, physics-driven neon traversal game for iPhone Safari. No install, no
dependencies, no build step, no assets — every pixel and every sound is generated at
runtime.

```
npm start          # serves on 0.0.0.0:8080, prints the LAN address
```

Then open the printed `network` URL on your phone. Add to Home Screen for fullscreen.

## How to play

**Hold anywhere.** A light-tether fires at the best anchor ahead and you swing.
**Let go.** You keep every bit of the momentum you built.
**Let go while climbing** (15°–55° above horizontal) for a **PERFECT ARC** — bonus score,
a forward impulse, and a combo step.

That is the entire control scheme: one finger, down and up. Nothing else.

Graze hazards without touching them and chain perfect arcs to fill **CHARGE**. At 100%
it auto-triggers **OVERDRIVE**: six seconds of double score, invulnerability, and time
dilation.

## Design notes

See `DESIGN.md` for the full design bible and `CONTRACTS.md` for the module interfaces.

A few things that matter more than they look:

- **The rope is a hard positional constraint**, not a spring. On the catch it kills
  outward radial velocity and keeps tangential, which is what makes momentum feel
  conserved rather than mushy.
- **Holding pumps the swing.** A bare position-based reel actually *costs* speed —
  shortening the rope lifts you against gravity for nothing (measured: 24.3 m/s vs
  37.2 m/s with no reel at all). "Hold longer = faster" is delivered by explicit
  tangential pumping scaled by rope verticality, exactly like kicking on a swing.
- **Auto-hop.** Pumping alone makes you orbit one anchor forever, so once the forward
  arc is spent the tether releases itself and the assist grabs the next anchor. This is
  what lets a first-time player who just holds the screen actually travel.
- **Colours are HDR and unbounded.** There is no "brightness" parameter in the renderer;
  emission above 1.0 is what drives the bloom. Structure is near-black silhouette and
  light does all the drawing.
- **Everything is one draw call per layer.** Every object in the game is one of five
  signed-distance shapes rendered from a single instanced quad.

## Architecture

```
src/core/     renderer (instanced SDF), GL helpers, math/pooling, config, input
src/gfx/      post-processing chain, parallax city backdrop
src/game/     player physics + tether, world generation, particles
src/audio/    procedural synthwave, no samples
src/ui/       HUD and screens (DOM), styling
```

`src/core/config.js` holds every tunable and the whole palette. Nothing else should
contain a magic number or a colour.

## Development tools

```
node tools/probe.mjs --out shots/x       # headless iPhone playthrough + screenshots
node tools/dev/sim2.mjs                  # headless gameplay sim, 30 seeds, 3 bots
node tools/dev/analyze.mjs <png...>      # luminance/saturation/black-point analysis
node tools/dev/audio.mjs                 # WebAudio graph + signal verification
```

`probe.mjs` captures only clean live-gameplay frames and asserts on non-finite state
every frame — a `NaN` in the camera silently blanks the screen rather than throwing, so
it is checked explicitly.

`sim2.mjs` is the gameplay acceptance test. It runs three bots — `smart` (aims for the
perfect-arc window), `metronome` (fixed rhythm), and `hold` (never releases, the
worst-case new player) — and classifies how every run ends.

## Browser support

WebGL2 required (iOS 15+). Falls back to RGBA8 render targets where half-float render
targets are unavailable, compressing emission at draw time so the HDR look survives.
Renders at up to 2× DPR with automatic resolution scaling if frame time slips.
