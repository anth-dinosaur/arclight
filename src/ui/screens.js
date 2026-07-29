// ARCLIGHT — title and game-over screens.
//
// Contract (CONTRACTS.md):
//   new Screens(root, { onStart, onRetry, onToggleAudio })
//   showTitle(); showGameOver(stats); hide();
//   get visible()
//
// stats: { distance, score, best, bestDistance, multiplierPeak, perfects, isNewBest }
//
// Notes on touch:
//   * The root and the TITLE container are `pointer-events: none`. Gameplay
//     touches must reach main.js's window listener everywhere else on the
//     screen, including over the panels.
//   * The GAME-OVER container is the one exception: it opts in and retries on a
//     tap anywhere. In a game whose entire control scheme is "touch down, touch
//     up", the death screen must not be the only surface you have to aim at.
//     The RETRY button stays as the visual affordance and stops propagation, so
//     the two never double-fire. Nothing is live under the title screen, where
//     LAUNCH doubles as the WebAudio unlock gesture and needs a real target.
//   * The title's primary button fires on a real `pointerdown` so it can serve
//     as the WebAudio unlock gesture; a `click` fallback is deduped by
//     timestamp for browsers without PointerEvent.

/** localStorage keys. Read defensively — private browsing throws on access. */
const LS_BEST = 'arclight.best';
const LS_BEST_DIST = 'arclight.bestDistance';
const LS_AUDIO = 'arclight.audio';

/** Count-up tween length and per-row stagger, ms. */
const TWEEN_MS = 900;
const TWEEN_STAGGER = 110;

/** Exit animation length; must be >= the `.scr` transition in ui.css. */
const OUT_MS = 360;

export class Screens {
  /**
   * @param {HTMLElement} root the #screens container (pointer-events: none)
   * @param {{onStart?:Function,onRetry?:Function,onToggleAudio?:Function}} callbacks
   */
  constructor(root, callbacks) {
    this.root = root;
    this.cb = callbacks || {};
    this._visible = false;
    this._which = '';          // '', 'title' or 'over'
    this._raf = 0;
    this._showRaf = 0;
    this._hideTimer = 0;

    // Best-known personal best, seeded from localStorage and kept current from
    // showGameOver(). showTitle() takes no args in the contract, so this is the
    // only way the title can display a best on a cold load.
    this._best = readNum(LS_BEST, 0);
    this._bestDist = readNum(LS_BEST_DIST, 0);
    this._audioOn = readStr(LS_AUDIO, '1') !== '0';

    // ---- shared: audio toggle (top-right, above both screens) ------------
    const ab = this.audioBtn = document.createElement('button');
    ab.type = 'button';
    ab.className = 'audio-btn';
    ab.setAttribute('aria-label', 'Toggle audio');
    ab.appendChild(el('span', 'ab-ico', '♪'));
    ab.appendChild(this.audioTxt = el('span', 'ab-txt', 'ON'));
    this._applyAudioClass();
    bindTap(ab, () => {
      this._audioOn = !this._audioOn;
      this._applyAudioClass();
      if (this.cb.onToggleAudio) this.cb.onToggleAudio(this._audioOn);
    });
    root.appendChild(ab);

    root.appendChild(this._buildTitle());
    root.appendChild(this._buildOver());
  }

  // ------------------------------------------------------------ title DOM --
  //  .scr.scr--title
  //   ├ .corner ×4
  //   ├ .scr-body
  //   │   ├ .brand      (h1.brand-title[data-text] + .brand-tag)
  //   │   ├ svg.diagram (pendulum that swings, releases, flies)
  //   │   └ .panel      (HOW: three rows)
  //   └ .scr-foot
  //       ├ .best-line
  //       ├ button.btn  (primary — audio unlock gesture)
  //       └ .btn-hint
  _buildTitle() {
    const scr = this.titleEl = el('div', 'scr scr--title');
    corners(scr);

    const body = el('div', 'scr-body');

    const brand = el('div', 'brand stagger');
    const h1 = el('h1', 'brand-title');
    h1.textContent = 'ARCLIGHT';
    h1.setAttribute('data-text', 'ARCLIGHT');   // fuels the chromatic split
    brand.appendChild(h1);
    brand.appendChild(el('div', 'brand-tag', 'SWING · RELEASE · FLY'));
    body.appendChild(brand);

    // Cheap teaching diagram: a dot on a rope swinging about an anchor, a flash
    // at the release point, then a ballistic trajectory drawing itself in.
    // Pure CSS animation on an inline SVG — no JS, no assets.
    const dg = svg('svg', 'diagram stagger', { viewBox: '0 0 140 78', 'aria-hidden': 'true' });
    dg.appendChild(svg('path', 'dg-arc', { d: 'M28 44 A44 44 0 0 1 112 44' }));
    dg.appendChild(svg('circle', 'dg-halo', { cx: 70, cy: 16, r: 7 }));
    dg.appendChild(svg('circle', 'dg-anchor', { cx: 70, cy: 16, r: 2.6 }));
    dg.appendChild(svg('path', 'dg-traj', { d: 'M30 40 C46 8 92 4 132 26' }));
    dg.appendChild(svg('circle', 'dg-flash', { cx: 30, cy: 40, r: 4 }));
    const swing = svg('g', 'dg-swing');
    swing.appendChild(svg('line', 'dg-rope', { x1: 70, y1: 16, x2: 70, y2: 58 }));
    swing.appendChild(svg('circle', 'dg-dot', { cx: 70, cy: 58, r: 3.4 }));
    dg.appendChild(swing);
    const lbl = svg('text', 'dg-label', { x: 70, y: 9, 'text-anchor': 'middle' });
    lbl.textContent = 'ANCHOR';
    dg.appendChild(lbl);
    body.appendChild(dg);

    const how = el('div', 'panel stagger');
    how.appendChild(el('div', 'panel-hd', 'HOW'));
    how.appendChild(howRow('01', 'HOLD', 'Anywhere. A tether fires at the best anchor ahead and you swing.'));
    how.appendChild(howRow('02', 'RELEASE', 'Let go. You keep every bit of the momentum you built.'));
    how.appendChild(howRow('03', 'RELEASE RISING', 'Let go while climbing 11°–65° for a <b>PERFECT ARC</b>.'));
    body.appendChild(how);

    scr.appendChild(body);

    const foot = el('div', 'scr-foot');
    this.titleBest = el('div', 'best-line stagger');
    foot.appendChild(this.titleBest);

    const btn = this.startBtn = button('LAUNCH');
    // Real pointerdown → valid user gesture for AudioContext.resume().
    bindTap(btn, (e) => {
      if (this._which !== 'title') return;
      this.hide();
      if (this.cb.onStart) this.cb.onStart(e);
    });
    foot.appendChild(btn);

    // The one instruction that matters belongs on the screen you read BEFORE
    // you play. "ONE THUMB. NO BUTTONS." describes the scheme without ever
    // saying what to do with it.
    foot.appendChild(el('div', 'btn-hint stagger', 'TOUCH AND HOLD ANYWHERE'));
    scr.appendChild(foot);
    return scr;
  }

  // -------------------------------------------------------- game-over DOM --
  //  .scr.scr--over
  //   ├ .corner ×4
  //   ├ .scr-body
  //   │   ├ .over-hd  "SIGNAL LOST"
  //   │   ├ .newbest
  //   │   └ .panel    (hero distance + 4 stat rows, all count-up tweened)
  //   └ .scr-foot     (RETRY — bottom of screen, thumb-reachable)
  _buildOver() {
    const scr = this.overEl = el('div', 'scr scr--over');
    corners(scr);

    const body = el('div', 'scr-body');
    body.appendChild(el('div', 'over-hd stagger', 'SIGNAL LOST'));

    const nbWrap = el('div', 'stagger');
    nbWrap.style.textAlign = 'center';
    nbWrap.appendChild(this.newBest = el('div', 'newbest', 'NEW BEST'));
    body.appendChild(nbWrap);

    const panel = el('div', 'panel stagger');
    panel.appendChild(el('div', 'panel-hd', 'RUN REPORT'));

    // Each row keeps its value node; the tween writes textContent only.
    this.rows = [];
    panel.appendChild(statRow(this, 'DISTANCE', 'dist', true, 'M'));
    panel.appendChild(statRow(this, 'SCORE', 'score', false, ''));
    panel.appendChild(statRow(this, 'PEAK MULT', 'mult', false, ''));
    panel.appendChild(statRow(this, 'PERFECT ARCS', 'perf', false, ''));
    panel.appendChild(statRow(this, 'BEST', 'best', false, ''));
    body.appendChild(panel);
    scr.appendChild(body);

    const foot = el('div', 'scr-foot');
    const btn = this.retryBtn = button('RETRY');
    const retry = (e) => {
      if (this._which !== 'over') return;
      this.hide();
      if (this.cb.onRetry) this.cb.onRetry(e);
    };
    bindTap(btn, retry);
    // Tap anywhere. `bindTap` stops propagation on the button, so a hit on the
    // button never reaches this and never fires `retry` twice.
    bindTap(scr, retry);
    foot.appendChild(btn);
    foot.appendChild(el('div', 'btn-hint stagger', 'ONE TAP TO GO AGAIN'));
    scr.appendChild(foot);
    return scr;
  }

  // ------------------------------------------------------------- lifecycle --
  /** @param {object} [stats] optional — lets a caller seed the displayed best. */
  showTitle(stats) {
    if (stats) this._absorbBest(stats);
    this._cancelTween();
    this._clearHideTimer();
    this.overEl.classList.remove('is-in');
    this.titleBest.innerHTML = this._bestDist > 0
      ? 'BEST <b>' + fmt(this._bestDist) + ' M</b> · <b>' + fmt(this._best) + '</b> PTS'
      : 'FIRST RUN';
    this.audioBtn.classList.add('is-on');
    this._visible = true;
    this._which = 'title';
    // Force a frame between display and class so the transition actually runs.
    this._show(this.titleEl, 'title');
  }

  /** @param {{distance:number,score:number,best:number,bestDistance:number,
   *           multiplierPeak:number,perfects:number,isNewBest:boolean}} stats */
  showGameOver(stats) {
    const s = stats || {};
    this._absorbBest(s);
    this._cancelTween();
    this._clearHideTimer();
    this.titleEl.classList.remove('is-in');
    this.audioBtn.classList.add('is-on');

    const nb = !!s.isNewBest;
    this.newBest.classList.remove('is-on');
    if (nb) {
      // Re-add on the next frame so the flourish keyframes restart.
      requestAnimationFrame(() => { if (this._which === 'over') this.newBest.classList.add('is-on'); });
    }

    this._visible = true;
    this._which = 'over';
    this._show(this.overEl, 'over');

    // Count-up. rAF tween, eased, staggered per row so the readout assembles
    // itself like a terminal printing results.
    this._startTween(
      Math.max(0, s.distance || 0),
      Math.max(0, s.score || 0),
      Math.max(1, s.multiplierPeak || 1),
      Math.max(0, s.perfects || 0),
      Math.max(0, s.best || this._best || 0)
    );
  }

  hide() {
    if (!this._visible && !this._which) return;
    this._cancelTween();
    this._cancelShow();
    this.titleEl.classList.remove('is-in');
    this.overEl.classList.remove('is-in');
    this.newBest.classList.remove('is-on');
    this.audioBtn.classList.remove('is-on');   // fades out with the screen
    // Report hidden immediately so main.js stops treating input as menu input,
    // while the CSS transition plays out.
    this._visible = false;
    this._which = '';
    this._clearHideTimer();
    this._hideTimer = setTimeout(() => {
      this._hideTimer = 0;
      hideNow(this.titleEl);
      hideNow(this.overEl);
    }, OUT_MS);
  }

  get visible() { return this._visible; }

  /** Reflect external audio state (audio.js owns the truth + persistence). */
  setAudioState(on) {
    this._audioOn = !!on;
    this._applyAudioClass();
  }

  // ----------------------------------------------------------- count-up ----
  _startTween(distance, score, mult, perfects, best) {
    const rows = this.rows;
    const t0 = performance.now();
    const total = TWEEN_MS + TWEEN_STAGGER * (rows.length - 1);

    // Targets in row order: dist, score, mult, perf, best.
    const targets = this._targets || (this._targets = new Float64Array(5));
    targets[0] = distance; targets[1] = score; targets[2] = mult;
    targets[3] = perfects; targets[4] = best;

    rows[2].mult = true;                       // PEAK MULT prints ×N, not N
    // Seed at the floor so the first painted frame is not the final number.
    // The multiplier row counts from ×1, not ×0 — ×0 is not a state the game can
    // ever be in, and printing it makes the whole report look uncalibrated.
    for (let i = 0; i < rows.length; i++) {
      rows[i].last = -1;
      rows[i].node.textContent = rows[i].mult ? '×1' : '0';
    }

    const step = (now) => {
      const t = now - t0;
      let done = true;
      for (let i = 0; i < rows.length; i++) {
        const local = (t - i * TWEEN_STAGGER) / TWEEN_MS;
        let k;
        if (local <= 0) { k = 0; done = false; }
        else if (local >= 1) { k = 1; }
        else { k = 1 - Math.pow(1 - local, 3); done = false; }  // easeOutCubic
        const r = rows[i];
        let v = Math.round(targets[i] * k);
        if (r.mult && v < 1) v = 1;             // the multiplier floor is ×1
        if (v !== r.last) {
          r.last = v;
          r.node.textContent = r.mult ? ('×' + v) : fmt(v);
        }
      }
      if (!done && t < total + 40) {
        this._raf = requestAnimationFrame(step);
      } else {
        // Snap to the exact targets. Covers the case where rAF was throttled
        // (backgrounded tab) and the eased value never quite landed.
        this._raf = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          let v = Math.round(targets[i]);
          if (r.mult && v < 1) v = 1;
          if (v !== r.last) { r.last = v; r.node.textContent = r.mult ? ('×' + v) : fmt(v); }
        }
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  _cancelTween() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  /**
   * Two-step reveal: make the element paintable, then flip the class on the NEXT
   * frame so the CSS transition has a start state to move from.
   *
   * The guard is load-bearing. A retry can land inside the two-frame gap — the
   * measured pointerdown → PLAY path is 65ms and this gap is ~33ms, and making
   * game over tap-anywhere widened the target from one button to the whole
   * screen. Unguarded, the queued callback re-adds `is-in` AFTER hide() removed
   * it: `.scr.is-in` also sets `visibility: visible`, so `hideNow()` cannot take
   * it back and the game-over panel stays pinned at full opacity over live
   * gameplay, frozen on the cancelled count-up's zeros, for the rest of the
   * session. Cancel the pending frame on hide, and re-check on arrival.
   */
  _show(node, which) {
    this._cancelShow();
    node.style.visibility = 'visible';
    this._showRaf = requestAnimationFrame(() => {
      this._showRaf = requestAnimationFrame(() => {
        this._showRaf = 0;
        if (this._which === which) node.classList.add('is-in');
      });
    });
  }

  _cancelShow() {
    if (this._showRaf) { cancelAnimationFrame(this._showRaf); this._showRaf = 0; }
  }

  _clearHideTimer() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = 0; }
  }

  _absorbBest(s) {
    if (typeof s.best === 'number' && s.best > this._best) this._best = s.best;
    if (typeof s.bestDistance === 'number' && s.bestDistance > this._bestDist) {
      this._bestDist = s.bestDistance;
    }
    writeNum(LS_BEST, this._best);
    writeNum(LS_BEST_DIST, this._bestDist);
  }

  _applyAudioClass() {
    this.audioBtn.classList.toggle('is-off', !this._audioOn);
    this.audioTxt.textContent = this._audioOn ? 'ON' : 'OFF';
    this.audioBtn.setAttribute('aria-pressed', this._audioOn ? 'true' : 'false');
  }
}

/* ------------------------------------------------------------- helpers ---- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Primary CTA. The label lives in its own span so ui.css can stack a 1px rim
 *  pseudo under a separate gradient-fill pseudo and still keep the text on top —
 *  a plain inset box-shadow gets cut away by the notched clip-path. */
function button(label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn--pulse stagger';
  b.appendChild(el('span', 'btn-l', label));
  return b;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** SVG nodes need createElementNS and setAttribute('class', …). */
function svg(tag, cls, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute('class', cls);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/** Framing brackets. No top-right one — the audio toggle occupies that corner
 *  and its own notched silhouette does the same job. */
function corners(scr) {
  scr.appendChild(el('div', 'corner corner--tl'));
  scr.appendChild(el('div', 'corner corner--bl'));
  scr.appendChild(el('div', 'corner corner--br'));
}

function howRow(n, key, html) {
  const row = el('div', 'how-row');
  row.appendChild(el('span', 'how-n', n));
  row.appendChild(el('span', 'how-k', key));
  const t = el('span', 'how-t');
  t.innerHTML = html;          // static author-controlled strings only
  row.appendChild(t);
  return row;
}

/** Build a stat row and register its value node with the tween. */
function statRow(self, label, key, hero, unit) {
  const row = el('div', hero ? 'stat stat--hero' : 'stat');
  row.appendChild(el('span', 'stat-k', label));
  const wrap = el('span', 'stat-v');
  const v = el('span', '', '0');
  wrap.appendChild(v);
  if (unit) wrap.appendChild(el('span', 'stat-u', unit));
  row.appendChild(wrap);
  self.rows.push({ key: key, node: v, last: -1, mult: false });
  return row;
}

function hideNow(node) { node.style.visibility = ''; }

/** Thousands separators without toLocaleString (consistent across locales). */
function fmt(n) {
  n = Math.round(n);
  if (n < 1000) return '' + n;
  let s = '' + n;
  let out = '';
  let c = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    out = s[i] + out;
    if (++c % 3 === 0 && i > 0) out = ',' + out;
  }
  return out;
}

/**
 * Bind a tap to a button. `pointerdown` keeps the callback inside a real user
 * gesture (required for AudioContext unlock on iOS); `click` is the fallback
 * for non-pointer browsers and is deduped by timestamp.
 */
function bindTap(node, fn) {
  let last = -1e9;                           // per-button, not shared
  const fire = (e) => {
    const now = performance.now();
    if (now - last < 500) return;            // already handled by pointerdown
    last = now;
    e.preventDefault();
    e.stopPropagation();                     // never leaks into gameplay input
    fn(e);                                   // forwarded so main.js can Input.adopt()
  };
  if (typeof window.PointerEvent === 'function') {
    node.addEventListener('pointerdown', fire, { passive: false });
  } else {
    node.addEventListener('touchstart', fire, { passive: false });
  }
  node.addEventListener('click', fire, { passive: false });
}

function readNum(k, dflt) {
  try {
    const v = parseFloat(localStorage.getItem(k));
    return isFinite(v) ? v : dflt;
  } catch (_) { return dflt; }
}
function readStr(k, dflt) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v;
  } catch (_) { return dflt; }
}
function writeNum(k, v) {
  try { localStorage.setItem(k, '' + v); } catch (_) { /* private mode */ }
}
