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
   trajectory. Releasing in the "power window" (moving up-forward, 11°–65° above
   horizontal) scores **PERFECT ARC**: bonus + a small forward impulse + a flash.
5. Repeat. Chain perfect arcs to build a combo multiplier.

That is the entire control scheme: touch down, touch up. No buttons, no swipes, no tilt.

## Skill layers (approachable → deep)
- **L1 — Just hold.** Anything you do produces a swing. You will travel. You cannot
  fail in the first ~15 seconds. That promise is in SECONDS and it is about the
  worst-case player, so it is asserted against the `hold` bot in wall clock, not
  against a distance. `TUTORIAL_DIST` is merely the lever that delivers it, and it is
  set from the measured distance-vs-time curve of a player who never releases.
  Holding forever is not, however, a strategy: it runs out somewhere past 30 seconds.

  > **`hold` alone cannot enforce this promise, and for a long time it was the only
  > thing asked to.** `hold` never releases, so it cannot release *badly*, so it is
  > structurally incapable of drowning — it records 7 floodline deaths in 720 runs and
  > zero inside 15 seconds. The tripwire was therefore green by construction while the
  > tier closest to an actual human learning the game, `metronome`, was drowning in 23%
  > of its runs with **every single one** of its sub-15s deaths a drowning. The promise
  > was being verified against the one policy immune to the failure mode it exists to
  > rule out. `sim2` now asserts twice: `hold` carries the promise as written (zero
  > early deaths, any cause), and `metronome` carries a budgeted tripwire on early
  > DROWNINGS specifically — the blind spot. It is a budget and not a zero, because a
  > bot that releases on a blind rhythm is *supposed* to be able to fail; the number
  > exists so that it can only ever move down.
- **L2 — Release timing.** Late release = high arc, early = low and fast. Perfect Arc
  window teaches itself with a visual pulse on the reticle.
- **L3 — Risk.** Passing within `GRAZE_RADIUS` of a live hazard, or of the gantry decks
  that hang into the outer edge of the flight envelope, without touching it. Risk =
  reward — so the only things that are grazable are the things that can kill you.
  Anchors are **not** grazable: they are what you are aiming at, and skimming one is a
  line-choice expression (L4), not a risk. A hazard graze is the single biggest CHARGE
  deposit in the game and happens two or three times in a good run.
- **L4 — Line choice.** Anchors are plural. Which one you take shapes the next three
  swings. Optimal lines skip anchors entirely with long flat flights.
- **L5 — Time your exit.** Overdrive lasts six seconds. The arc you take in its last
  `OVERDRIVE_EXIT_WINDOW` is the **exit**, and it refunds charge scaled by how late you
  cut it. Leave it too late and overdrive expires and you get nothing. That window is
  the whole layer.

  > This used to read "bank charge, trigger it on a dense hazard cluster, and time your
  > exit arc", and the banking half of it was fiction. Measured time from meter-full to
  > overdrive firing, against a 3.5s arm timeout: **smart 0.65s median** (max 2.87s),
  > 26 of 26 fills spent manually — the next arc arrives before there is anything to
  > decide. metronome 0.90s. `hold` 2.32s with 3 of 7 fills auto-firing, which is not a
  > decision either, it is a timeout. Nobody banks. The design promised a choice the
  > player never makes, and the honest fix is to stop promising it rather than to invent
  > a new rule (holding the meter across two arcs) in a game that already has enough.
  >
  > The exit window itself is load-bearing, and it is the one claim in this area that
  > gets *stronger* under a wide scan. At 720 seeds, opening `OVERDRIVE_EXIT_WINDOW` back
  > up to 6.0 — i.e. letting any arc end overdrive — costs the skill gradient **9.2x →
  > 6.4x**, easily the largest single-parameter effect measured anywhere in the game.
  > Lived duration is 5.3s of 6, with 4 in 5 overdrives ending on a deliberate exit arc
  > rather than expiring. Zeroing `OVERDRIVE_REFUND` costs only 9.2x → 9.0x, though;
  > that was previously written up as 13.4x → 12.4x off 30 seeds, and at 720 the refund
  > is a nice-to-have riding on the window, not a load-bearing part of it.

## OVERDRIVE
CHARGE fills from perfect arcs, hazard grazes, orbs and architecture skims. At 100% it
**arms**, and the next perfect arc spends it — you never press anything extra. If no arc
arrives within `OVERDRIVE_ARM_TIMEOUT`, it fires itself.

> Note what this is and is not. It is a *hand-off*, not a decision: measured bank time
> is 0.65s for a skilled player against a 3.5s timeout, so in practice the meter fills
> and the very next arc — which is arriving in well under a second anyway — spends it.
> The decision in overdrive is at the other end, on the way OUT. See L5.

> That timeout is the floor under the mechanic. Waiting on an arc was an absolute wall
> for the players who most need to see the showpiece: an L1 player earns ~1.1 meters a
> run but scores too few arcs to ever cash one, so overdrive was seen in 73% / 22% / 8%
> of runs across the three skill tiers. It is now 84% / 34% / 33%. A skilled player
> never sees the timer at all — they take an arc every ~0.9s — so it costs the top tier
> nothing and it only ever fires for someone who could not have spent it deliberately.

Income is deliberately weighted differently at each end of the skill range. Perfect arcs
are ~70% of an expert's meter; **orbs** are ~47% of a beginner's, and orb income is
*inverted* against skill (a slower flier passes through more of them per metre). That is
what lets the low tier reach overdrive at all without inflating the top tier.

Overdrive is 6 seconds of ×2 score, invulnerability, and time slightly dilated (0.85×)
with the audio filter opening up and the world blooming white-hot.

Arcs taken *during* overdrive are free: they score, doubled, and nothing else. In the
final `OVERDRIVE_EXIT_WINDOW` seconds an arc becomes the **exit**, and refunds charge
scaled by how late you cut it. Land it at the last possible instant for the full
`OVERDRIVE_REFUND`; leave it too late and overdrive simply expires and you get nothing.

> This clause used to read "ending overdrive with a perfect arc refunds 25% charge",
> and it was implemented literally: *any* arc ended it. A skilled player takes one every
> ~0.9s, so the six-second showpiece had a measured median lived duration of **1.4s**,
> and the better you played the less of it you got. The skill expression is meant to be
> "time your exit", not "stop playing well".

## Failure
- Contact with a hazard (laser gate, drone, spinner) → crash.
- A square hit on a hard wall face → crash. A glancing one (shallower than
  `DEFLECT_ANGLE` from the surface tangent) deflects, scrubs some speed, and reads as
  skill. Architecture is not lethal at all until `SOLID_SAFE_DIST`.
- Falling below the floodline → crash.
- Crash is instant, loud, and readable: hitstop, radial shatter, slow-mo, score tally.
Player hitbox is a small circle (`PLAYER_RADIUS`), deliberately smaller than the
sprite. Forgiveness is invisible and constant.

**No death is ever unavoidable.** This is the single most valuable property the game
has and it is a measured one, not an aspiration: `sim2.mjs --avoid` replays every death
across every seed and bot against an exhaustive lattice of alternative inputs in the
2.2s before it, and reports any death that no input could have prevented. That number
must read zero.

> Read that as **probabilistic, not categorical**, and run it wide before believing it.
> The audit is exhaustive over a *coarse* lattice — 2.2s lookback, 0.1s probe step,
> three dwell lengths — and the game is chaotically sensitive: changing the targeting
> assist by three units changes anchor selection, which changes every trajectory, which
> produces an entirely different set of deaths to audit. Scanned at 90 seeds, most
> assist values are clean and a few flag one or two. Scanned at 180, the *shipping*
> configuration before this pass flagged one too. "Zero unavoidable" has been green
> partly because nobody ran the audit past 90 seeds. The current numbers are clean at
> both 90 and 180 across all three bots, which is a stronger claim than the game had
> before — but the honest form of the invariant is "no unavoidable death has been found
> at the widest scan we run", and the scan width is part of the claim.

**Avoidable and fair are not the same claim.** The audit's 2.2s lookback measures
PLAN-fairness: some line existed. Run with `--lookback 0.6` it measures REACTION-fairness
— the player standing at the telegraph still has an out — and that number is nowhere
near zero: at 90 seeds roughly a third of all deaths are not reactable inside 0.6s, and
lasers are the largest single cause (11/29 smart, 15/41 metronome, 17/34 hold). Those
deaths pass the long audit because the escape was upstream, at a release made while the
beam was dark and silent. That is the "it snapped on in my path mid-flight" experience:
formally avoidable, felt as unfair. Two changes target it without touching the duty
cycles:

- **Snap-on grace.** Only flying INTO a live beam kills. A beam that fires around a
  player already inside its box holds fire for them until they exit — which also makes
  threading the charge-up tell a deliberate expert line instead of a coin flip on the
  phase hash. Measured at 60 seeds: `smart` is byte-identical (it never coasts inside a
  dark beam — the grace costs the top tier literally nothing), `hold` gains +25m median,
  and the score gradient pays 10.2x → 9.6x. That 0.6x is a real cost, paid knowingly:
  unlike the catch-row trade (distance for gradient) this buys the felt form of the
  page's own "single most valuable property". The 2.2s invariant stays zero with the
  grace in place.
- **The emitter clock** (see the telegraph note in the difficulty section) — the larger
  share of the reactive gap is flying into an *already-live* beam seen too late, which
  is a legibility problem the sims cannot score because bots do not look at the screen.

## Difficulty curve
Distance-driven, continuous, no discrete levels. **All distances below are world units;
the metre counter on the HUD reads world units / 2.**

| band | what arrives |
|---|---|
| `0–340` | tutorial: dense anchors, zero hazards, non-lethal architecture, orb trails |
| `340–480` | archetypes and anchor spacing open up. Still nothing lethal but the water |
| `480` | **the authored first hazard** — one laser, alone, across the lane |
| `480–620` | gantry decks begin reaching into the outer flight envelope |
| `620–800` | drones; architecture turns lethal at 560 |
| `800–1000` | spinners |
| `1000+` | moving gates — the full mix. Hazard duty cycles tighten, spacing closes |

Spinners and gates were at 850 and 1150, which sat past where most runs end. Measured
exposure — hazard kinds a run actually meets, at 720 seeds — was:

| | laser | drone | spinner | gate |
|---|---|---|---|---|
| smart | 100% | 83% | 68% | 30% |
| metronome | 84% | 63% | 43% | 18% |
| hold | 100% | 66% | 38% | **2%** |

A beginner met a moving gate in one run in fifty. At 800/1000 it reads 100/80/70/**43**,
86/64/46/**29**, 100/65/41/**12**.

**These levers trade against each other; they do not add.** Realised hazard density is
capped by placement, not by the budget, so unlocking a kind earlier does not create
hazards — it relabels them. Pulling both hard (to 650/850, which a per-distance harness
scores as the cheapest content win available) collapses the drone instead: smart's drone
exposure falls 83% → 60% and `hold`'s 66% → 38%, for a *total* summed exposure of 7.12
against 6.95 — a 2% gain bought with 9% of smart's distance and 12% of hold's. That is a
reshuffle wearing a win's clothing. The gate lever is the cheap one (moving it alone
costs no distance at all and leaves the drone untouched); the spinner lever is the dear
one. 1000/800 takes all of the first and only the flat part of the second: total exposure
6.95 → 7.23, `hold`'s gate exposure up 5.5×, and the beginner tier pays nothing (414 →
414m). The top tier pays 5% of its median and the gradient goes 10.9x → 10.4x.

**The first hazard is authored, not rolled.** Density just past the tutorial is ~0.24
per chunk, so a rolled first encounter arrived at a random distance, at a random size,
inside a random archetype — and in 10% of runs never arrived at all. A teaching beat
cannot be a dice roll. The first chunk past `WORLD_FIRST_HAZ_X` therefore always
contains exactly one laser, on the mid-span of the widest chain segment in the chunk,
dark ~86% of the time behind the standard charge-up tell. A first-timer almost certainly
flies through while it is dark and sees it snap on behind them — the lesson (magenta
blinks, magenta kills, *the blink is a clock*) delivered without costing them the run.

`WORLD_FIRST_HAZ_X` is the L1 promise expressed as a distance, and it is measured, not
chosen: over 200 seeds the `hold` bot is at median 297 world units at t=15s, p99 421,
max 439. 480 clears the worst case, so the first lethal object in the game is
unreachable inside the grace period **by construction**. At 366 it was not, and it
killed `hold` inside 15 seconds in 2 runs out of 60.

The curve is `1 - e^-((x - TUTORIAL_DIST) / WORLD_DIFF_SCALE)`: asymptotic, never
reaching 1, never becoming impossible. Anchor availability has a hard floor
(`WORLD_SPACING_MAX`) so a skilled player can always find a line, and realised hazard
density saturates around 1.7 per chunk because placement — not the budget — is the
binding constraint.

**Roughly 40% of the authored range is still unreachable, and that is worth saying out
loud.** Measured `diff` where a median run actually ends: **smart 0.55, metronome 0.46,
hold 0.42**; even smart's p90 run only reaches ~0.80. An earlier draft of this document
claimed "~0.79 where a median run ends", which was the p90 figure again. The tail of the
curve is aspiration, not content — it exists so the ramp never flattens for the player
who is having the run of their life, and it should be budgeted as such rather than
counted as difficulty that ships.

Three things make this a curve rather than a step:
- **Hazard density** ramps with `diff` and, past the tutorial, so does the *lethality*
  of each hazard: laser and drone duty cycles both ease from a long, forgiving dormant
  window to a short one. A drone met early is a different object from one met late.
- **Anchor spacing** widens with `diff`, which lengthens the rope, which raises the
  swing plateau (`TETHER_MAX_OMEGA × L`). Speed therefore rises out of the level
  design rather than out of a scripted scroll floor: measured *within a single run*,
  first 5s → last 5s, **smart 43.9 → 50.2 m/s (+14%), metronome 43.8 → 47.1, hold
  30.9 → 36.7**. (This line used to read "47 → 66 m/s across a run". That was a p90
  fact stated as a median one — 66 is roughly the top of the distribution, not where a
  median run ends. The real within-run gain is about a seventh, not a third.)
- **Threats arrive in order of readability.** Hazards blink and telegraph, so they come
  first; architecture is a silhouette with no tell, so it stays a bounce until later.

**The laser's clock is readable at a glance, not only over a cycle.** "The blink is a
clock" was true but expensive to read: a dark beam was informationally silent until the
final 0.4s tell, and a player crossing at 50 m/s gets less than one full cycle between
the beam entering view and the release that commits their line — so the phase they were
betting on was effectively a coin flip. The emitters (and, faintly, the tracer line,
because a lane-crossing beam can have both emitters off-frame) now beat through the
entire dark phase on a rate that accelerates from 1.1Hz to 5Hz across the last
`WORLD_LASER_WARN` (2.5) seconds before firing — the same accelerating-rhythm grammar as
the floodline alarm, for the same reason: rhythm survives peripheral vision, and an
accelerating rhythm says "closing" without a number. The beat's phase is the analytic
integral of the rate curve, so it speeds up smoothly rather than jumping. Duty cycles,
periods and the 0.4s tell are all unchanged — this adds information, not ease.

**The water gets a tell, on the same clock as a laser.** Drowning was the only lethal
thing in the game with no telegraph, and it was the biggest single killer of the tier
closest to a human still learning: at 720 seeds `metronome` drowned in 31% of its runs,
and 96 of its 119 sub-15s deaths were drownings. The mechanic was never unfair —
`sim2 --avoid` says every one of those deaths was escapable — it was **unreadable**,
which is a different bug with a different fix. Measured at the death
frame: descent 76 m/s, 0.70s inside the assist's panic band, 0.27s inside the last 20
units, and the latest input that still saves the run lands 0.40s out. Against that, the
only visual was a danger vignette ramped over 13 units and then *squared*, which at that
descent rate is **0.17 seconds** of warning. `PERFECT_ETA_LEAD` already fixes this
project's reaction floor at 250ms on the grounds that anything shorter is a cue that is
late by construction; the water had a third of it. A hazard, by contrast, gets a 0.4s
charge-up tell *plus* 0.83s of median on-screen presence.

The fix is two channels, because one was not enough:
- The vignette ramp widens from 13 units to `FLOOD_WARN_BAND` (55) and eases *cubically*
  rather than quadratically. Width buys the lead time; the sharper ease keeps the first
  two thirds of the band near-invisible, so legitimately flying the catch row still costs
  nothing.
- The water surface itself becomes an **alarm**: a magenta line across the view that
  beats, on a rate that *accelerates* from 1.1Hz to 5Hz as you sink. Rhythm survives
  peripheral vision and a noisy frame where a brightness ramp does not, an accelerating
  rhythm says "closing" without a number, and it is the same grammar as the laser blink
  the game has already taught. Magenta because magenta kills — the water was the only
  lethal surface breaking that contract.

Measured over every real drowning at 360 seeds × 3 bots: telegraph on screen goes from
**0.20s to 1.20s**, six times the lead and comfortably past the project's own 250ms
floor. Drownings themselves fall 31% → 23% of `metronome` runs and early ones 13.3% →
12.5% — a real but modest gain, and deliberately the *smaller* half of this fix. The
point was never to delete the failure; it was to stop it arriving unannounced. The
backdrop's flood mist already ramped over ~46 units, but it is a soft ambient
wash that is *also* on whenever the player is legitimately low in the corridor — that is
atmosphere, not an alarm, and it could never have been the only signal.

**Recoverability is a mechanic, and it has to be measured like one.** The catch row —
anchors slung below the chain, off the reachability graph — exists so a bad release is
survivable. It was quietly failing exactly where it mattered: probing the mid tier at
the instant of a drowning, the nearest anchor *above* the player averaged 31.9 world
units against a 26-unit tether, and there was nothing in reach for 60% of the final
sink. The net had gaps wider than the rope. Tightening `WORLD_CATCH_SPACING` to 15 puts
something overhead for 70% of a sink. It costs the top tier nothing — a player who does
not sag never meets these anchors — so it *widens* the skill gradient rather than
flattening it: at 720 seeds, 24 → 15 moves metronome 401 → 447m, its drownings 254 → 166,
and the gradient 8.6x → 9.2x.

> **15 is not demonstrably the optimum, and the note that used to say so was wrong.**
> It read "11 collapses the gradient 13.4x → 7.5x by helping `hold` more than anyone",
> off 30 seeds. At 720 that collapse does not exist in either direction: 11 measures
> metronome 470m (+23), drownings 151 (−15), smart 539m (+7) and the gradient 9.3x
> (+0.1) — better than 15 on every axis, not worse.
>
> **Re-measured a third time at 360 seeds, and BOTH of the above overstate their case.**
> Head to head on the shipping config: 15 gives smart 529m / metronome 445m / hold 414m
> at a 9.2x score gradient; 11 gives 535m / 458m / 411m at **8.5x**. So the distance
> differences (+6, +13, −3) sit inside the run-to-run noise this page keeps warning
> about, while the gradient cost is real and one-directional. There is no collapse to
> 7.5x, and there is no free win either. **15 stays**, because score gradient is the
> load-bearing signal (README: "if `smart` stops beating `hold` by a wide margin, skill
> has stopped paying") and 0.7x of it is not worth 13m of median distance.
>
> The meta-lesson is the one worth keeping: three measurements of the same constant at
> 30, 720 and 360 seeds produced three different recommendations, two of them confident
> and wrong. The catch row only acts in the tail where the sinks are, so it needs both
> a wide scan AND a head-to-head on the *same* config — a sweep run against a different
> baseline is not comparable, which is how the 720-seed pass concluded "better on every
> axis" for something that costs 0.7x of gradient.

Reachability is no longer what kills a sinking player, and the numbers say so directly:
at the death frame the nearest anchor above is now 22.2 units, *inside* the 26-unit
tether, and yet nobody is tethered at that frame. The binding constraint moved from
SPACE to TIME, which is why the rest of the fix is the assist band
(`TETHER_FLOOD_PANIC`, opened from 44 to 68) and the telegraph above, not more anchors.

Every number in the table is set against the distance-vs-time curves of all three bots,
because a curve calibrated past the distance players reach is not a curve. The previous
version put the tutorial at 800 (45% of a median run), difficulty at only 0.36 where a
median run ended, and moving gates at 2900 — which appeared in **0%** of measured runs.
Content that ships and is never seen is content that does not exist.

No rubber-banding, and no per-run softening. Every run opens with the same
unconditional tutorial, so a conditional extra grace after a crash would be a no-op.
The mechanic is deliberately absent rather than unimplemented.

## Scoring
```
score += dt * speed * SCORE_DIST_RATE * multiplier
+ PERFECT_ARC   = SCORE_PERFECT       * multiplier   (scaled by arc quality²)
+ HAZARD GRAZE  = SCORE_GRAZE_HAZARD  * multiplier   (4.5× — the only lethal graze)
+ GRAZE         = SCORE_GRAZE         * multiplier   (architecture; rate-limited per object)
+ ORB           = SCORE_ORB           * multiplier
× OVERDRIVE_SCORE_MULT while overdrive is up
multiplier = 1 + floor(combo / COMBO_PER_STEP), capped COMBO_MAX_MULT,
             steps DOWN one level per COMBO_WINDOW without an event
```
Only perfect arcs, hazard grazes and orbs *bump* the combo. An architecture graze holds
the window open but does not advance it — otherwise the multiplier pins at its cap and
stops being a signal.

Distance in metres is the headline number. Score is the secondary flex.

The game-over RUN REPORT names PERFECT ARCS and HAZARD GRAZES side by side, because
those are the two acts the CHARGE economy is actually made of and a popup during a run
goes past too fast to price. It also names **OVERDRIVE**, which it did not for a long
time: the showpiece of the game fires in 84% / 34% / 33% of runs across the three tiers
and the only screen that prices a run after the fact did not mention it once. It reads 0
for a player who never earned one, which is the point — a named zero is an aspiration, an
absent row is nothing at all.

The multiplier ladder is deliberately **not** uniform. The first step costs
`COMBO_EARLY_STEP` (3) events and the rest cost `COMBO_PER_STEP` (5), because the
multiplier badge is the only mid-run "this is going well" readout in the game and it does
not render at all at ×1 — so at a flat 5 the single channel that says the run is working
was absent for 51% of a mid-tier run and 79% of a beginner's, which is precisely inverse
to who needs it. One cheap step takes that to 32% and 64%. It changes no trajectory
(score does not feed back into physics) and costs 10.2x → 9.1x of skill gradient;
discounting the second step as well goes further but costs 8.6x, which is more of the
game's load-bearing assertion than the extra readability is worth.

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
