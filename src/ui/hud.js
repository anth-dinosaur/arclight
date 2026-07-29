// ARCLIGHT — heads-up display.
//
// Contract (CONTRACTS.md):
//   new Hud(root)                          root = <div id="hud">
//   update(state)                          { distance, score, multiplier, charge01,
//                                            overdrive01, odExit, alive, speed01,
//                                            menu, holding }
//   popup(kind, text, screenX, screenY)    kind: 'perfect'|'graze'|'orb'|'combo'
//   reset()
//
// `menu` and `holding` are additive, optional fields. `menu` true hides the whole
// HUD so it never ghosts through the title / game-over screens (the run's numbers
// belong to RUN REPORT there, and printing them twice at two different values is
// worse than not printing them at all). `holding` is the raw input-down flag and
// only drives the first-run HOLD prompt.
//
// Design constraints this file takes seriously:
//   * update() runs 60–120×/s. Every channel is cached and quantised; the
//     no-change path performs ZERO DOM access and ZERO allocation. Reading a
//     layout-inducing property (offsetWidth, getBoundingClientRect) is banned.
//   * Only `transform`, `opacity`, `stroke-dashoffset`, `textContent` and class
//     lists are ever written. No width/top/left animation anywhere.
//   * Popups come from a fixed pool of POOL_SIZE nodes built once in the
//     constructor. Nothing is created or destroyed at runtime — allocating DOM
//     mid-run is the single biggest source of visible jank on iOS.

const POOL_SIZE = 24;

/** localStorage key: has the player ever held the screen? Gates the HOLD prompt. */
const LS_TAUGHT = 'arclight.taught';

/** Backstop for the HOLD prompt, in metres. The prompt is meant to clear on the
 *  first touch-down (`state.holding`); this is the safety net for a caller that
 *  does not pass the flag, so the worst case is "clears a bit late" rather than
 *  "burns in over the whole run". Deliberately well inside the 400m tutorial
 *  zone but far enough out that a genuinely idle player still gets to read it. */
const TEACH_MAX_M = 120;

/** Colour ramp for the multiplier badge, indexed by integer multiplier.
 *  cyan → violet → amber. Deliberately NEVER magenta: #ff2d95 is the hazard hue
 *  (DESIGN.md) and main.js paints a full-screen magenta damage vignette near the
 *  floodline — a magenta badge is unreadable exactly when it matters most.
 *  Constant strings, so assigning one allocates nothing. Index 0 is unused. */
const MULT_COLORS = [
  '#22f0ff', // 0 (unused)
  '#22f0ff', // ×1
  '#22f0ff', // ×2
  '#5fe6ff', // ×3
  '#8fd8ff', // ×4
  '#a78bfa', // ×5
  '#8b5cf6', // ×6
  '#a855f0', // ×7
  '#c084fc', // ×8
  '#ffd166', // ×9
  '#ffc14d', // ×10
  '#ffb020', // ×11
];
/** Last valid ramp index. The ramp is allowed to be SHORTER than the label table:
 *  CFG.COMBO_MAX_MULT is tuned by another owner and has already moved 10 → 12, so
 *  anything past the end simply holds the top colour rather than reading undefined. */
const MULT_COL_TOP = MULT_COLORS.length - 1;

/** Pre-rendered "×N" labels. Avoids string concat in the changed path too.
 *  Runs well past CFG.COMBO_MAX_MULT so a tuning change can never print "undefined". */
const MULT_LABELS = [
  '', '×1', '×2', '×3', '×4', '×5', '×6', '×7', '×8',
  '×9', '×10', '×11', '×12', '×13', '×14', '×15', '×16',
];
const MULT_TOP = MULT_LABELS.length - 1;

/** Circumference of the overdrive ring (r = 24). Must match ui.css. */
const OD_CIRCUMFERENCE = 150.796;

/** Distance meter is redrawn on whole metres; score on whole points. Charge and
 *  overdrive are continuous, so they're quantised to a step finer than a pixel
 *  of bar travel but coarse enough to skip most frames. */
const CHARGE_STEPS = 220;
const OD_STEPS = 160;

export class Hud {
  /** @param {HTMLElement} root the #hud container (pointer-events: none) */
  constructor(root) {
    this.root = root;

    // ---- DOM -------------------------------------------------------------
    // Built entirely here so index.html needs no edits.
    //
    //  #hud
    //   └ .hud-root                      opacity / overdrive / full-charge flags
    //      ├ .hud-fullglow               inset edge glow, pulses at charge 100%
    //      ├ .hud-edges                  4 × .hud-edge streaks (overdrive)
    //      ├ .hud-top                    top-centre stack
    //      │   ├ .hud-dist   → .hud-dist-val + .hud-dist-unit ("M")
    //      │   ├ .hud-rule
    //      │   ├ .hud-score  → label + value
    //      │   └ .hud-mult                appears only when multiplier > 1
    //      ├ .hud-od         → svg ring + label            (overdrive countdown)
    //      ├ .hud-charge     → label + track/ticks/fill    (right edge)
    //      ├ .hud-teach      → .hud-teach-i "HOLD"         (first run only)
    //      └ .hud-pops       → 24 × .pop → .pop-i          (pooled)
    const el = this.el = document.createElement('div');
    el.className = 'hud-root';

    el.appendChild(this.fullglow = div('hud-fullglow'));

    const edges = div('hud-edges');
    edges.appendChild(div('hud-edge hud-edge--l'));
    edges.appendChild(div('hud-edge hud-edge--r'));
    edges.appendChild(div('hud-edge hud-edge--t'));
    edges.appendChild(div('hud-edge hud-edge--b'));
    el.appendChild(edges);

    const top = div('hud-top');
    const dist = div('hud-dist');
    dist.appendChild(this.distEl = div('hud-dist-val', '0'));
    dist.appendChild(div('hud-dist-unit', 'M'));
    top.appendChild(dist);
    top.appendChild(div('hud-rule'));
    const score = div('hud-score');
    score.appendChild(div('hud-score-label', 'SCORE'));
    score.appendChild(this.scoreEl = div('hud-score-val', '0'));
    top.appendChild(score);
    // Seeded EMPTY, not '×2'. The badge is invisible until the multiplier passes
    // ×1, but seeded text is still what a screen reader announces and what any
    // DOM probe reports as the title screen's content.
    top.appendChild(this.multEl = div('hud-mult', ''));
    el.appendChild(top);

    // ---- THE POWER COLUMN ------------------------------------------------
    // CHARGE and OVERDRIVE are two halves of ONE economy — you fill the meter,
    // the meter becomes the ring, the ring drains, the ring refunds into the
    // meter — and they used to be drawn 350px apart, the bar on the right edge
    // and the ring in the top-left corner. Nothing about the layout said they
    // were the same currency, so the hand-off (bar hits 100%, bar vanishes, ring
    // appears somewhere else entirely) read as two unrelated widgets rather than
    // as one state change.
    //
    // They now share one column against the right edge, ring directly above the
    // track it drains out of. The bar fills UPWARD toward the ring, so the
    // geometry itself states the relationship, and the hand-off happens within
    // one eye fixation instead of across the whole screen.
    const power = div('hud-power');

    // Overdrive countdown ring. SVG so the drain is a stroke-dashoffset write,
    // which repaints a 58px box and never touches layout. Built node-by-node
    // rather than via innerHTML — no namespace ambiguity, no querySelector.
    const od = div('hud-od');
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 58 58');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(ring('hud-od-bg'));
    svg.appendChild(this.odArc = ring('hud-od-arc'));
    od.appendChild(svg);
    od.appendChild(this.odLabel = div('hud-od-label', 'O/D'));
    power.appendChild(this.odEl = od);

    // Charge meter. Label goes FIRST — set horizontally above the track, not
    // rotated beside it. A vertical label read top-to-bottom against a meter that
    // fills bottom-to-top is two opposing reading directions on one element.
    const charge = div('hud-charge');
    charge.appendChild(div('hud-charge-label', 'CHARGE'));
    const track = div('hud-charge-track');
    track.appendChild(this.chargeFill = div('hud-charge-fill'));
    track.appendChild(div('hud-charge-ticks'));
    charge.appendChild(track);
    power.appendChild(charge);
    el.appendChild(power);

    // Exit-window rim. The ring cue is a 58px badge, and during the exit window
    // the player is looking at the AVATAR — the collapsing amber cue drawn on the
    // player is the thing they are actually reading. Asking for a 1.2s state read
    // from screen furniture, during the noisiest visual state in the game, loses.
    // This is the half of that fix the HUD can own: a full-bleed amber rim, so the
    // cue exists in peripheral vision NO MATTER where the eye is parked, and it
    // frames the avatar rather than competing with it. Same trick as .hud-fullglow,
    // different hue, and the two can never run at once (charge-full is suppressed
    // for the whole of overdrive).
    el.appendChild(this.exitRim = div('hud-exitrim'));

    // First-run prompt. The entire control scheme is one verb, and nothing on
    // screen says it. Shown until the player's first touch-down, ever.
    const teach = div('hud-teach');
    teach.appendChild(div('hud-teach-i', 'HOLD'));
    el.appendChild(this.teachEl = teach);

    el.appendChild(this.pops = div('hud-pops'));
    root.appendChild(el);

    // ---- popup pool ------------------------------------------------------
    // Two parallel arrays of nodes plus scalar bookkeeping. `_free` is a stack
    // of available indices; `_seq` records spawn order so an overflow can evict
    // the oldest live popup deterministically.
    this._outer = new Array(POOL_SIZE);
    this._inner = new Array(POOL_SIZE);
    this._busy = new Uint8Array(POOL_SIZE);
    this._seq = new Float64Array(POOL_SIZE);
    this._flip = new Uint8Array(POOL_SIZE);   // which keyframe track is running
    this._free = new Array(POOL_SIZE);
    this._freeTop = POOL_SIZE;
    this._seqNext = 1;

    for (let i = 0; i < POOL_SIZE; i++) {
      const outer = div('pop');
      const inner = div('pop-i');
      outer.appendChild(inner);
      // Index carried on the node so the single delegated listener can find it.
      outer._pi = i;
      inner._pi = i;
      this.pops.appendChild(outer);
      this._outer[i] = outer;
      this._inner[i] = inner;
      this._free[i] = POOL_SIZE - 1 - i;      // pop() hands out 0,1,2,…
    }

    // ONE listener for all 24 popups (animationend bubbles). Avoids 24 closures
    // and makes recycling free.
    this._onEnd = (e) => {
      const i = e.target._pi;
      if (i === undefined) return;
      this._release(i);
    };
    this.pops.addEventListener('animationend', this._onEnd);

    // ---- cached channels -------------------------------------------------
    // Sentinels chosen so the first update() always writes every channel.
    this._dist = -1;
    this._score = -1;
    this._mult = -1;
    this._charge = -1;
    this._chargeFull = false;
    this._odExit = false;
    this._od = -1;
    this._odOn = false;
    this._alive = true;
    this._fast = false;
    this._shown = false;
    this._multFlip = 0;
    this._breakFlip = 0;

    // Teaching prompt. `_taught` is sticky across sessions; `_teachOn` is the
    // per-run live flag.
    this._taught = readFlag(LS_TAUGHT);
    this._teachOn = false;

    this.reset();
  }

  // ---------------------------------------------------------------- update --
  /**
   * @param {{distance:number,score:number,multiplier:number,charge01:number,
   *          overdrive01:number,odExit:boolean,alive:boolean,speed01:number,
   *          menu?:boolean,holding?:boolean}} s
   * Hot path. Every branch below early-outs on an unchanged quantised value, so
   * a steady frame costs a handful of integer compares and nothing else.
   */
  update(s) {
    // --- visibility -------------------------------------------------------
    // Gated per-frame on `menu`, not latched once. The old one-shot latch meant
    // the HUD was painted over the title screen on the very first frame anyone
    // sees, and printed the run's numbers a second time — at a different value —
    // over the game-over count-up.
    const on = !s.menu;
    if (on !== this._shown) {
      this._shown = on;
      this.el.classList.toggle('is-on', on);
    }

    // --- first-run prompt: dismissed by the first touch-down, forever ------
    if (this._teachOn && (s.holding || s.distance > TEACH_MAX_M)) {
      this._teachOn = false;
      this._taught = true;
      writeFlag(LS_TAUGHT);
      this.el.classList.add('teach-out');
    }

    // --- distance: the headline. Whole metres only. -----------------------
    const d = s.distance | 0;
    if (d !== this._dist) {
      this._dist = d;
      this.distEl.textContent = d;      // number → implicit string, no concat
    }

    // --- score ------------------------------------------------------------
    const sc = s.score | 0;
    if (sc !== this._score) {
      this._score = sc;
      this.scoreEl.textContent = sc;
    }

    // --- multiplier: badge only exists above ×1 ---------------------------
    let m = s.multiplier | 0;
    if (m < 1) m = 1;
    if (m > MULT_TOP) m = MULT_TOP;
    if (m !== this._mult) {
      const prev = this._mult;
      this._mult = m;
      const mEl = this.multEl;
      if (m > 1) {
        mEl.textContent = MULT_LABELS[m];
        mEl.style.setProperty('--mult-col', MULT_COLORS[m > MULT_COL_TOP ? MULT_COL_TOP : m]);
        mEl.classList.remove('break-a', 'break-b');
        if (prev <= 1) mEl.classList.add('is-on');
        if (m > prev) {
          // Restart the spring by swapping between two identical keyframe
          // tracks — no `offsetWidth` reflow hack, no layout thrash.
          if (this._multFlip) { mEl.classList.remove('spring-b'); mEl.classList.add('spring-a'); }
          else                { mEl.classList.remove('spring-a'); mEl.classList.add('spring-b'); }
          this._multFlip ^= 1;
        }
      } else {
        mEl.classList.remove('spring-a', 'spring-b');
        if (prev > 1) {
          // COMBO BREAK. Losing a ×10 is a bigger event than earning a ×2 and it
          // used to happen in zero channels — the badge just evaporated on a
          // 160ms opacity transition. Flash it dead and collapse it. Same
          // two-track trick as the spring so a repeat break restarts cleanly.
          if (this._breakFlip) { mEl.classList.remove('break-b'); mEl.classList.add('break-a'); }
          else                 { mEl.classList.remove('break-a'); mEl.classList.add('break-b'); }
          this._breakFlip ^= 1;
        }
        mEl.classList.remove('is-on');
      }
    }

    // --- charge meter -----------------------------------------------------
    let c = s.charge01;
    if (c < 0) c = 0; else if (c > 1) c = 1;
    const cq = (c * CHARGE_STEPS) | 0;
    if (cq !== this._charge) {
      this._charge = cq;
      // scaleY from the bottom. `width`/`height` untouched → compositor only.
      this.chargeFill.style.transform = 'scale3d(1,' + (cq / CHARGE_STEPS) + ',1)';
      const full = cq >= CHARGE_STEPS;
      if (full !== this._chargeFull) {
        this._chargeFull = full;
        // The full-charge pulse and the overdrive wash fight each other, so the
        // pulse yields while overdrive is running.
        this.el.classList.toggle('is-full', full && !this._odOn);
      }
    }

    // --- overdrive --------------------------------------------------------
    let o = s.overdrive01;
    if (o < 0) o = 0; else if (o > 1) o = 1;
    const oq = (o * OD_STEPS) | 0;
    if (oq !== this._od) {
      this._od = oq;
      const on = oq > 0;
      if (on !== this._odOn) {
        this._odOn = on;
        this.el.classList.toggle('is-od', on);
        // Suppress the charge-full pulse while overdrive is running; the two
        // effects fight each other visually.
        if (on && this._chargeFull) this.el.classList.remove('is-full');
        else if (!on && this._chargeFull) this.el.classList.add('is-full');
      }
      if (on) {
        // Ring drains as overdrive01 falls to 0.
        this.odArc.style.strokeDashoffset = OD_CIRCUMFERENCE * (1 - oq / OD_STEPS);
      }
    }

    // --- overdrive EXIT WINDOW -------------------------------------------
    // The last stretch of overdrive, where a perfect arc becomes a deliberate exit
    // and banks a refund scaled by how late you take it. This is an L5 decision and
    // it needs a cue, or the only way to learn the window exists is to trip over it.
    // main.js owns the boundary (it knows the raw seconds remaining); the HUD just
    // reflects it, so the two can never disagree about where the window starts.
    const exit = !!s.odExit;
    if (exit !== this._odExit) {
      this._odExit = exit;
      this.el.classList.toggle('is-odexit', exit);
      // O/D -> ARC: the label stops naming the state and starts naming the verb.
      this.odLabel.textContent = exit ? 'ARC' : 'O/D';
    }

    // --- speed tier: a single class flip driving a hotter headline glow.
    //     Asymmetric thresholds (0.78 in, 0.68 out) give it hysteresis so it
    //     cannot chatter on and off frame-to-frame around the boundary.
    const fast = this._fast ? s.speed01 > 0.68 : s.speed01 > 0.78;
    if (fast !== this._fast) {
      this._fast = fast;
      this.el.classList.toggle('is-fast', fast);
    }

    // --- alive ------------------------------------------------------------
    const alive = !!s.alive;
    if (alive !== this._alive) {
      this._alive = alive;
      this.el.classList.toggle('is-dead', !alive);
    }
  }

  // ---------------------------------------------------------------- popup ---
  /**
   * Spawn a floating label at a CSS-pixel screen position.
   * @param {'perfect'|'graze'|'orb'|'combo'} kind
   * @param {string|number} text
   * @param {number} screenX CSS px from the left of the viewport
   * @param {number} screenY CSS px from the top of the viewport
   */
  popup(kind, text, screenX, screenY) {
    const i = this._acquire();
    const outer = this._outer[i];
    const inner = this._inner[i];

    // Kind class lives on the outer node; rewriting className is one string
    // assignment and avoids three classList calls.
    outer.className = 'pop is-live pop--' + (kind || 'graze');
    // Position is a transform on the OUTER node; the keyframes drive the INNER
    // node. Separating the two means the animation never needs to know where
    // the popup is, so one pair of keyframes serves every position.
    outer.style.transform = 'translate3d(' + screenX + 'px,' + screenY + 'px,0)';
    inner.textContent = text;

    // Alternate keyframe tracks so a recycled node restarts its animation.
    // Changing animation-name cancels the previous run (no stray animationend).
    if (this._flip[i]) outer.classList.add('run-a');
    else outer.classList.add('run-b');
    this._flip[i] ^= 1;
  }

  /** Grab a pooled index, evicting the oldest live popup if the pool is dry. */
  _acquire() {
    let i;
    if (this._freeTop > 0) {
      i = this._free[--this._freeTop];
    } else {
      // Overflow: evict the longest-lived popup. O(POOL_SIZE) but only reached
      // when 24 popups are alive at once, which is already a visual overload.
      i = 0;
      let oldest = this._seq[0];
      for (let k = 1; k < POOL_SIZE; k++) {
        if (this._seq[k] < oldest) { oldest = this._seq[k]; i = k; }
      }
    }
    this._busy[i] = 1;
    this._seq[i] = this._seqNext++;
    return i;
  }

  /** Return an index to the free stack. Idempotent. */
  _release(i) {
    if (!this._busy[i]) return;
    this._busy[i] = 0;
    const outer = this._outer[i];
    outer.className = 'pop';            // drops is-live + kind + run-* at once
    this._inner[i].textContent = '';
    this._free[this._freeTop++] = i;
  }

  // ---------------------------------------------------------------- reset ---
  /** Clear every popup and force the next update() to rewrite all channels. */
  reset() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this._outer[i].className = 'pop';
      this._inner[i].textContent = '';
      this._busy[i] = 0;
      this._seq[i] = 0;
      this._free[i] = POOL_SIZE - 1 - i;
    }
    this._freeTop = POOL_SIZE;
    this._seqNext = 1;

    this.el.classList.remove('is-od', 'is-full', 'is-dead', 'is-fast', 'teach-out');
    this.multEl.classList.remove('is-on', 'spring-a', 'spring-b', 'break-a', 'break-b');
    this.chargeFill.style.transform = 'scale3d(1,0,1)';

    // The HOLD prompt is armed for every run until the player's first touch-down
    // ever, then never again on this device.
    this._teachOn = !this._taught;
    this.el.classList.toggle('is-teach', this._teachOn);
    this.odArc.style.strokeDashoffset = OD_CIRCUMFERENCE;
    this.distEl.textContent = '0';
    this.scoreEl.textContent = '0';

    this._dist = 0;
    this._score = 0;
    this._mult = 1;
    this._charge = 0;
    this._chargeFull = false;
    this._odExit = false;
    this.el.classList.remove('is-odexit');
    this.odLabel.textContent = 'O/D';
    this._od = 0;
    this._odOn = false;
    this._alive = true;
    this._fast = false;
  }

  /** Fade the whole HUD out. update() drives this from `state.menu`; the method
   *  stays for anything that needs to force it out of band. */
  setVisible(v) {
    this._shown = !!v;
    this.el.classList.toggle('is-on', !!v);
  }
}

/* ---------------------------------------------------------- persistence --- */
/* Private browsing throws on localStorage access, so both are try-wrapped and
   the prompt degrades to "shows every run" rather than to a crash. */

function readFlag(k) {
  try { return localStorage.getItem(k) === '1'; } catch (_) { return false; }
}
function writeFlag(k) {
  try { localStorage.setItem(k, '1'); } catch (_) { /* private mode */ }
}

/* -------------------------------------------------------------- helpers --- */
/* All construction-time only. None of these is reachable from update(). */

const SVG_NS = 'http://www.w3.org/2000/svg';

function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

/** One 24px-radius circle of the overdrive countdown ring. */
function ring(cls) {
  const c = svgEl('circle');
  c.setAttribute('class', cls);   // SVG elements need setAttribute, not .className
  c.setAttribute('cx', '29');
  c.setAttribute('cy', '29');
  c.setAttribute('r', '24');
  return c;
}
