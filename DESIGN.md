# ARCLIGHT — Design Bible

A one-thumb, physics-driven neon traversal game for iPhone Safari. Portrait.

## The fantasy
You are a data courier arcing through the vertical canyons of a rain-soaked megacity,
firing a light-tether at anchor nodes, swinging, releasing, and flying. Speed is
everything. The city is black glass and screaming neon.

## Core loop (30 seconds)
1. Fall / fly forward. World scrolls right, camera follows with lookahead.
2. **HOLD** anywhere on screen → tether fires at the best anchor ahead. Rope goes taut.
3. Swing. While held, the tether **auto-reels** slightly — this pumps energy in, like
   kicking on a playground swing. Hold longer through the arc = more speed.
4. **RELEASE** → detach, momentum is conserved exactly. Release angle decides your
   trajectory. Releasing in the "power window" (moving up-forward, 15°–55° above
   horizontal) scores **PERFECT ARC**: bonus + a small forward impulse + a flash.
5. Repeat. Chain perfect arcs to build a combo multiplier.

That is the entire control scheme: touch down, touch up. No buttons, no swipes, no tilt.

## Skill layers (approachable → deep)
- **L1 — Just hold.** Anything you do produces a swing. You will travel. You cannot
  fail in the first ~15 seconds (tutorial zone has no hazards, wide anchors).
- **L2 — Release timing.** Late release = high arc, early = low and fast. Perfect Arc
  window teaches itself with a visual pulse on the reticle.
- **L3 — Grazing.** Passing within `GRAZE_RADIUS` of neon geometry or a hazard without
  touching it adds to the **CHARGE** meter and bumps the multiplier. Risk = reward.
- **L4 — Line choice.** Anchors are plural. Which one you take shapes the next three
  swings. Optimal lines skip anchors entirely with long flat flights.
- **L5 — Overdrive management.** Bank charge, trigger it on a dense hazard cluster.

## OVERDRIVE
CHARGE fills from grazes, perfect arcs, and orbs. At 100% it **auto-triggers** (keeps
the one-input promise): 6 seconds of ×2 score, invulnerability, time slightly dilated
(0.85×) with the audio filter opening up and the world blooming white-hot. Ending
overdrive with a perfect arc refunds 25% charge.

## Failure
- Contact with a hazard (laser gate, drone, spinner, hard wall face) → crash.
- Falling below the floodline → crash.
- Crash is instant, loud, and readable: hitstop, radial shatter, slow-mo, score tally.
Player hitbox is a small circle (`PLAYER_RADIUS`), deliberately smaller than the
sprite. Forgiveness is invisible and constant.

## Difficulty curve
Distance-driven, continuous, no discrete levels.
- `0–400m` tutorial: dense anchors, no hazards, ghost hints.
- `400–1200m`: first laser gates, sparse drones.
- `1200–2500m`: anchor gaps widen, spinners, moving gates.
- `2500m+`: full mix, scroll speed floor rises, gap chance up. Asymptotic, never
  becomes impossible — anchor availability has a hard floor so a skilled player can
  always find a line.
Rubber-banding: after a crash, the next run's first 200m is slightly softer.

## Scoring
```
score += dt * speed * 0.1 * multiplier
+ PERFECT_ARC   = 250 * multiplier
+ GRAZE         = 40  * multiplier   (rate-limited per object)
+ ORB           = 100 * multiplier
multiplier = 1 + floor(comboChain / 3), capped 10, decays after 4s without an event
```
Distance in meters is the headline number. Score is the secondary flex.

## Aesthetic direction
**Palette** (HDR — values above 1.0 are intentional, they drive bloom):
| Role | Hex | Notes |
|---|---|---|
| void | `#04030c` | background base |
| deep | `#0a0a1f` | fog far |
| cyan | `#22f0ff` | player, tether, safe things |
| magenta | `#ff2d95` | hazards, danger |
| violet | `#8b5cf6` | anchors, structure accents |
| amber | `#ffb020` | orbs, score pops |
| white-hot | `#eaffff` | overdrive, impacts |

**Rules**
- Nothing is flat. Every emissive element has a bloom halo and a dimmer core-to-edge
  falloff. Structure is near-black silhouette; light does the drawing.
- Five parallax depth bands with independent fog attenuation and drift.
- Persistent rain, wind-sheared, faster and more angled with player speed.
- Chromatic aberration + radial motion streaks scale with velocity, not time.
- Camera: critically-damped follow, velocity lookahead, subtle roll into the swing
  direction, trauma-based shake (shake = trauma², decays).
- Everything is animated. Anchors pulse. Neon flickers on a per-object noise seed.
  Signage scrolls. No static frame.

## Audio (fully optional, game is 100% playable silent)
Procedural synthwave, WebAudio, no assets. Layered: sub pulse, arpeggio that
transposes with multiplier, pad that opens with speed, tether-tension whine mapped to
rope force. All gameplay feedback also exists visually + as haptics
(`navigator.vibrate` where supported). Muted by default until first user gesture; a
persistent mute toggle sits top-right, state in `localStorage`.

## Performance budget (iPhone, target 60fps, tolerate 120Hz ProMotion)
- ≤ 1 HDR scene pass + 1 bright-pass + 3 blur ping-pongs + 1 composite.
- ≤ 2500 instanced primitives per frame.
- Zero per-frame allocation in the hot loop. Object pools for particles/entities.
- `devicePixelRatio` clamped to 2.0; auto-downscale render target if frame time
  exceeds budget for 30 consecutive frames.
- No garbage-collected closures in `update`/`render`.
