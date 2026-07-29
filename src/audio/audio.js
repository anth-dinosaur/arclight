// ============================================================================
// ARCLIGHT — audio/audio.js
// Procedural darksynth score + SFX. No assets, everything is WebAudio synthesis.
//
// DESIGN NOTES
// ------------
// The score is a continuous, never-restarting synthwave engine at 132 BPM in A
// minor. It does not "play a track" — four independently gain-automated layers
// (sub, arp, pad, percussion) run forever and the *mix* is what reacts to the
// player. That is why a run never has a musical seam: menu -> gameplay ->
// overdrive -> death -> menu are all crossfades of the same running machine.
//
// TIMING
// ------
// Note timing uses the canonical WebAudio lookahead scheduler (Chris Wilson's
// "A Tale of Two Clocks"): a coarse `setInterval` at 25 ms wakes up, looks
// 120 ms into the future using `ctx.currentTime`, and schedules every 16th note
// that falls inside that window with *sample-accurate absolute times*. The
// render loop never schedules a note and `setTimeout` is never used for musical
// timing — both drift and both stutter under GC / frame hitches. The interval
// timer only has to be accurate to ~100 ms, which it always is.
//
// ALLOCATION
// ----------
// `update()` allocates nothing and creates no nodes — it only calls
// `setTargetAtTime` on params that already exist. Every value it touches is
// funnelled through `num()/c01()` so a NaN from gameplay can never poison an
// AudioParam (a NaN in a param permanently kills that node's output in Safari).
//
// ROBUSTNESS
// ----------
// No AudioContext is created in the constructor (iOS penalises pages that do).
// It is created lazily inside `unlock()`, from a user gesture. Every public
// method short-circuits through `_live()`, so the game is 100% playable — and
// silent, without a single thrown error or console message — when WebAudio is
// missing, suspended, or the player has muted.
// ============================================================================

// ---------------------------------------------------------------------------
// Tunables.
//
// CONTRACT OBJECTION (noted per CONTRACTS.md rules, implemented as written):
// the ground rules say every tunable lives in `core/config.js`, but this agent
// owns only `src/audio/audio.js` and may not edit config.js. These constants
// are therefore module-local. They should be folded into `CFG.AUDIO` by the
// integrator if/when config.js is opened for edits.
// ---------------------------------------------------------------------------
const A = {
  // ---- transport --------------------------------------------------------
  BPM: 132,
  STEPS_PER_BAR: 16,        // 16th-note grid
  CHORD_BARS: 4,            // bars per chord => 16-bar progression
  TICK_MS: 25,              // scheduler wake interval
  LOOKAHEAD: 0.12,          // seconds of notes scheduled ahead of currentTime
  RESYNC_SLIP: 0.25,        // if we fall this far behind, jump the clock forward

  // ---- mix levels (pre-compressor) --------------------------------------
  MASTER: 0.82,
  SUB_GAIN: 0.62,
  SUB_MENU: 0.16,
  ARP_GAIN: 0.30,
  PAD_GAIN: 0.30,
  PAD_MENU: 0.24,
  PERC_GAIN: 0.46,
  SFX_GAIN: 0.75,
  FADE_TC: 0.45,            // time constant for menu <-> gameplay crossfades
  PARAM_TC: 0.10,           // time constant for fast continuous follows

  // ---- filters ----------------------------------------------------------
  PAD_CUT_MIN: 280,         // pad lowpass base; opens with speed01
  DUCK_BASE: 700,           // master "duck" lowpass base
  FILTER_MAX: 18000,

  // ---- delay ------------------------------------------------------------
  DELAY_DAMP: 3200,         // lowpass inside the feedback loop (analog-ish)
  FB_BASE: 0.62,
  FB_OD: 0.16,              // extra feedback at full overdrive
  WET_BASE: 0.22,
  WET_OD: 0.18,
  MUSIC_SEND: 0.34,
  SFX_SEND: 0.22,

  // ---- voice budget -----------------------------------------------------
  MAX_VOICES: 32,           // hard cap on simultaneous one-shot voices
  SFX_RESERVE: 6,           // music may only use MAX_VOICES - SFX_RESERVE

  // ---- sfx --------------------------------------------------------------
  GRAZE_MIN_GAP: 0.125,     // rate limit: max 8 grazes / second
  GRAZE_GAIN: 0.055,        // ~ -25 dB, it fires constantly
  PERFECT_MAX_STEP: 10,     // pentatonic steps => ~2 octaves of rise
  TENSION_GAIN: 0.11,

  // ---- overdrive / death ------------------------------------------------
  OD_BEND_CENTS: 200,       // "up a tone", briefly
  OD_BEND_HOLD: 1.25,       // seconds the one-shot bend stays applied
  CRASH_BEND: -2400,        // two octaves down, near-halt
  CRASH_FADE: 1.2,
  CRASH_SILENCE: 0.40,      // stop scheduling music this long after a crash
  CRASH_HOLD: 1.7,          // never restore before the death fade has finished
  CRASH_RESTORE: 3.0,       // auto-restore if nobody tells us we're alive again
  RESTORE_TIME: 0.9,

  // ---- watchdog ---------------------------------------------------------
  VOICE_STUCK: 5.0,         // seconds pinned at the cap before we assume a leak
};

const SEC_PER_BEAT = 60 / A.BPM;               // 0.4545…
const SEC_PER_STEP = SEC_PER_BEAT / 4;         // 16th note, 0.11364…
const BAR_STEPS = A.STEPS_PER_BAR;
const LOOP_STEPS = BAR_STEPS * A.CHORD_BARS * 4; // 4 chords => 256 steps

const STORAGE_KEY = 'arclight.audio';

// ---------------------------------------------------------------------------
// Harmony. A minor: Am – F – C – G, four bars each.
// MIDI numbers throughout; 69 = A4 = 440 Hz.
//
// `bass`  root in sub territory (43–65 Hz).
// `pad`   a three-note voicing chosen for minimal movement between chords, so
//         the glide between chords is a whisper rather than a lurch.
// `arp`   triad + octave, the 16th-note figure runs through these four.
// ---------------------------------------------------------------------------
const CHORDS = [
  { bass: 33, pad: [57, 60, 64], arp: [57, 60, 64, 69] }, // Am  A1 / A3 C4 E4
  { bass: 29, pad: [53, 57, 60], arp: [53, 57, 60, 65] }, // F   F1 / F3 A3 C4
  { bass: 36, pad: [52, 55, 60], arp: [52, 55, 60, 64] }, // C   C2 / E3 G3 C4
  { bass: 31, pad: [50, 55, 59], arp: [50, 55, 59, 62] }, // G   G1 / D3 G3 B3
];

// 16-step patterns. 0 = rest, otherwise velocity.
// Bass: a driving 16th pulse with off-beat pushes — the "engine" of the track.
const BASS_VEL = [1.0, 0, 0.55, 0, 0.85, 0, 0.55, 0.38,
                  1.0, 0, 0.55, 0, 0.85, 0.38, 0.62, 0.45];
// Arp: index into CHORDS[i].arp, plus a per-step octave lift for contour.
const ARP_IDX = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 2];
const ARP_OCT = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1];
// Four-on-the-floor with a ghost pickup on the last 16th.
const KICK_VEL = [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0, 0, 0.5];
// Backbeat clap on 2 and 4.
const CLAP_VEL = [0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 1.0, 0, 0, 0];
// Closed hats on every 16th, accented on the off-beats; step 14 opens up.
const HAT_VEL = [0.50, 0.22, 0.70, 0.22, 0.50, 0.22, 0.70, 0.28,
                 0.50, 0.22, 0.70, 0.22, 0.50, 0.28, 0.75, 0.40];

// A minor pentatonic, semitones from the root: A C D E G. `perfect()` walks up
// this so a combo chain reads as a rising melody rather than a repeated bleep.
const PENTATONIC = [0, 3, 5, 7, 10];
const PERFECT_BASE_MIDI = 81; // A5

const EMPTY_STATE = {}; // shared default so update() never allocates

// ---------------------------------------------------------------------------
// Small numeric guards. Every value that reaches an AudioParam goes through
// one of these — a single NaN can silently and permanently mute a node.
// ---------------------------------------------------------------------------
function num(v, d) {
  return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : d;
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function c01(v) { return clamp(num(v, 0), 0, 1); }
function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export class Audio {
  constructor() {
    // Nothing here may throw and nothing here may touch WebAudio: constructing
    // an AudioContext outside a gesture is penalised on iOS and burns the
    // page's one free unlock.
    this._ctx = null;
    this._dead = false;      // true => WebAudio unusable, all methods no-op
    this._built = false;
    this._unlocked = false;
    this._enabled = true;

    // transport
    this._timer = 0;
    this._step = 0;
    this._nextTime = 0;
    this._chord = -1;

    // continuous state mirrored from update(), read by the scheduler
    this._menu = true;
    this._energy = 0;
    this._arpOct = 0;
    this._voices = 0;

    // one-shot pitch offset in cents (overdrive lift); persistent voices use
    // the `_bend` ConstantSourceNode instead so they can glide.
    this._bendCents = 0;
    this._bendUntil = 0;

    this._tetherOn = false;
    this._lastGraze = -1;
    this._crashing = false;
    this._crashSilence = 0;
    this._crashHold = 0;
    this._crashRestore = 0;
    this._voiceFullSince = 0;

    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === '0') this._enabled = false;
    } catch (e) { /* private mode / disabled storage — keep the default */ }

    this._onVis = null;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** True when it is safe to touch the graph at all. */
  _live() {
    return !this._dead && this._built && this._enabled &&
           this._ctx !== null && this._ctx.state === 'running';
  }

  /**
   * Must be called from inside a user gesture (touchend / click). Creates the
   * context lazily, resumes it, and plays a zero-length silent buffer — iOS
   * Safari will report `running` without that buffer but stay inaudible.
   */
  async unlock() {
    if (this._dead) return;
    try {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this._dead = true; return; }
        try { this._ctx = new AC({ latencyHint: 'interactive' }); }
        catch (e) { this._ctx = new AC(); }
        this._build();
        this._installVisibility();
      }
      if (this._ctx.state !== 'running') {
        try { await this._ctx.resume(); } catch (e) { /* keep going */ }
      }
      // The silent-buffer handshake. One sample, started now, stopped now.
      const s = this._ctx.createBufferSource();
      s.buffer = this._ctx.createBuffer(1, 1, this._ctx.sampleRate);
      s.connect(this._ctx.destination);
      s.start(0);
      try { s.stop(this._ctx.currentTime + 0.001); } catch (e) { /* older impls */ }
      s.onended = function () { try { s.disconnect(); } catch (e) {} };

      this._unlocked = true;
      if (this._enabled) this._startClock();
    } catch (e) {
      this._dead = true;
    }
  }

  get enabled() { return this._enabled; }

  set enabled(v) {
    const on = !!v;
    if (on === this._enabled) return;
    this._enabled = on;
    try { window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) {}

    // Never tear the graph down — just fade the master and park the scheduler.
    if (this._dead || !this._built || !this._ctx) return;
    const t = this._ctx.currentTime;
    if (on) {
      if (this._ctx.state !== 'running') {
        const p = this._ctx.resume();
        if (p && p.then) p.then(() => { this._startClock(); }, () => {});
      }
      this._ramp(this._master.gain, A.MASTER, 0.25);
      this._startClock();
    } else {
      this._ramp(this._master.gain, 0.0001, 0.20);
      this._stopClock(); // notes already in the 120 ms window play out under the fade
    }
  }

  /** Suspend on hide / resume on show, or iOS reclaims the context outright. */
  _installVisibility() {
    if (this._onVis) return;
    const self = this;
    this._onVis = function () {
      if (self._dead || !self._ctx) return;
      try {
        if (document.hidden) {
          self._stopClock();
          const p = self._ctx.suspend();
          if (p && p.catch) p.catch(function () {});
        } else if (self._enabled && self._unlocked) {
          const p = self._ctx.resume();
          if (p && p.then) p.then(function () { self._startClock(); }, function () {});
          else self._startClock();
        }
      } catch (e) { /* never let a visibility change break the game */ }
    };
    try { document.addEventListener('visibilitychange', this._onVis, false); }
    catch (e) { this._onVis = null; }
  }

  // =========================================================================
  // Graph construction (once, inside unlock)
  //
  //  MUSIC LAYERS                     MASTER CHAIN
  //  ------------                     ------------
  //  busSub  ─┐                        mixBus
  //  busArp  ─┤                          │
  //  padFilt ─┼──> mixBus ──> drivePre ──> shaper ──> postDrive ─┬─> dry ──┐
  //  busPerc ─┘                                                  │        │
  //                                                              │        v
  //                        delayIn <──── musicSend ──────────────┘   duckFilter
  //                           │                                           │
  //                           v                                           │
  //   ┌──> delayL ──> fbL ──> fbLpL ──> delayR ──> fbR ──> fbLpR ──┐       │
  //   └───────────────────────────────────────────────────────────┘       │
  //        delayL ──> merger[0]                                           │
  //        delayR ──> merger[1] ──> wetGain ─────────────────────────────>┤
  //                                                                       │
  //   busSfx ──> sfxSend ──> delayIn                                      │
  //   busSfx ──────────────────────────────> master <────────────────────-┘
  //                                            │
  //                                            v
  //                                        compressor ──> destination
  //
  // SFX are summed *after* the duck filter so a crash sweep or a closed menu
  // filter never swallows gameplay feedback; only their delay tails duck.
  // =========================================================================
  _build() {
    if (this._built) return;
    const ctx = this._ctx;

    // ---- master tail ----------------------------------------------------
    this._comp = ctx.createDynamicsCompressor();
    this._comp.threshold.value = -12;
    this._comp.knee.value = 8;
    this._comp.ratio.value = 5;
    this._comp.attack.value = 0.004;
    this._comp.release.value = 0.18;
    this._comp.connect(ctx.destination);

    this._master = ctx.createGain();
    this._master.gain.value = this._enabled ? A.MASTER : 0.0001;
    this._master.connect(this._comp);

    // The "duck" — one lowpass that everything musical passes through. This is
    // the single biggest expressive control in the file: it closes in menus,
    // opens with speed, slams open in overdrive, and slams shut on death.
    this._duck = ctx.createBiquadFilter();
    this._duck.type = 'lowpass';
    this._duck.frequency.value = 900;
    this._duck.Q.value = 0.9;
    this._duck.connect(this._master);

    // ---- ping-pong delay -------------------------------------------------
    // Two delay lines cross-fed through damping lowpasses, hard-panned by a
    // channel merger. No convolver: reverb IRs cost memory and a decode we
    // cannot afford on a phone, and a dotted-eighth ping-pong is more
    // synthwave anyway.
    const dt = SEC_PER_BEAT / 2;               // straight 8th
    this._delayIn = ctx.createGain();
    this._delayIn.gain.value = 1;

    this._delayL = ctx.createDelay(1.5);
    this._delayR = ctx.createDelay(1.5);
    this._delayL.delayTime.value = dt;
    this._delayR.delayTime.value = dt;

    this._fbL = ctx.createGain(); this._fbL.gain.value = A.FB_BASE;
    this._fbR = ctx.createGain(); this._fbR.gain.value = A.FB_BASE;
    const lpL = ctx.createBiquadFilter(); lpL.type = 'lowpass'; lpL.frequency.value = A.DELAY_DAMP;
    const lpR = ctx.createBiquadFilter(); lpR.type = 'lowpass'; lpR.frequency.value = A.DELAY_DAMP;

    this._delayIn.connect(this._delayL);
    this._delayL.connect(this._fbL); this._fbL.connect(lpL); lpL.connect(this._delayR);
    this._delayR.connect(this._fbR); this._fbR.connect(lpR); lpR.connect(this._delayL);
    // Loop gain is fbL*fbR (<= 0.61), so the tail always decays.

    this._merger = ctx.createChannelMerger(2);
    this._delayL.connect(this._merger, 0, 0);
    this._delayR.connect(this._merger, 0, 1);

    this._wet = ctx.createGain();
    this._wet.gain.value = A.WET_BASE;
    this._merger.connect(this._wet);
    this._wet.connect(this._duck);

    // ---- drive ----------------------------------------------------------
    this._shaper = ctx.createWaveShaper();
    this._shaper.curve = this._makeDriveCurve(2048, 1.8);
    try { this._shaper.oversample = '2x'; } catch (e) {}

    this._drivePre = ctx.createGain();
    this._drivePre.gain.value = 1.25;         // push into the knee a little
    this._postDrive = ctx.createGain();
    this._postDrive.gain.value = 0.8;         // make up for the added density

    this._drivePre.connect(this._shaper);
    this._shaper.connect(this._postDrive);

    this._dry = ctx.createGain(); this._dry.gain.value = 1;
    this._postDrive.connect(this._dry);
    this._dry.connect(this._duck);

    this._musicSend = ctx.createGain();
    this._musicSend.gain.value = A.MUSIC_SEND;
    this._postDrive.connect(this._musicSend);
    this._musicSend.connect(this._delayIn);

    this._mix = ctx.createGain();
    this._mix.gain.value = 0.9;
    this._mix.connect(this._drivePre);

    // ---- layer buses ----------------------------------------------------
    this._busSub = ctx.createGain(); this._busSub.gain.value = A.SUB_MENU;
    this._busArp = ctx.createGain(); this._busArp.gain.value = 0.0001;
    this._busPad = ctx.createGain(); this._busPad.gain.value = A.PAD_MENU;
    this._busPerc = ctx.createGain(); this._busPerc.gain.value = 0.0001;
    this._busSub.connect(this._mix);
    this._busArp.connect(this._mix);
    this._busPad.connect(this._mix);
    this._busPerc.connect(this._mix);

    // Shared per-layer tone shaping. These live for the lifetime of the page,
    // so a one-shot voice is only ever {source, gain} — two nodes, not five.
    this._subLp = ctx.createBiquadFilter();
    this._subLp.type = 'lowpass'; this._subLp.frequency.value = 340; this._subLp.Q.value = 0.7;
    this._subLp.connect(this._busSub);

    this._arpLp = ctx.createBiquadFilter();
    this._arpLp.type = 'lowpass'; this._arpLp.frequency.value = 2400; this._arpLp.Q.value = 3.2;
    this._arpLp.connect(this._busArp);

    this._clapBp = ctx.createBiquadFilter();
    this._clapBp.type = 'bandpass'; this._clapBp.frequency.value = 1750; this._clapBp.Q.value = 1.1;
    this._clapBp.connect(this._busPerc);

    this._hatHp = ctx.createBiquadFilter();
    this._hatHp.type = 'highpass'; this._hatHp.frequency.value = 7200; this._hatHp.Q.value = 0.8;
    this._hatHp.connect(this._busPerc);

    // ---- SFX bus (post-duck, so feedback is always audible) --------------
    this._busSfx = ctx.createGain();
    this._busSfx.gain.value = A.SFX_GAIN;
    this._busSfx.connect(this._master);
    this._sfxSend = ctx.createGain();
    this._sfxSend.gain.value = A.SFX_SEND;
    this._busSfx.connect(this._sfxSend);
    this._sfxSend.connect(this._delayIn);

    // ---- shared white noise ---------------------------------------------
    // One 2-second buffer, reused by every noise voice at a random offset.
    // Allocating a buffer per snare/hat/whoosh would be a GC disaster.
    const n = Math.max(1, Math.floor(ctx.sampleRate * 2));
    this._noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const nd = this._noise.getChannelData(0);
    for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;

    // ---- global pitch bend ----------------------------------------------
    // A ConstantSourceNode wired into the `detune` param of every *persistent*
    // oscillator. Fan-out is fixed (pad x6, octave x2, tension x1) so it can
    // never leak; one-shots read `_bendCents` at schedule time instead, which
    // avoids having to disconnect the bend when each voice dies.
    this._bend = null;
    if (typeof ctx.createConstantSource === 'function') {
      this._bend = ctx.createConstantSource();
      this._bend.offset.value = 0;
    }

    this._buildPad();
    this._buildTension();

    if (this._bend) { try { this._bend.start(); } catch (e) { this._bend = null; } }

    this._built = true;
  }

  /** tanh soft-clip, normalised so unity in == unity out. Gentle, not fuzz. */
  _makeDriveCurve(n, k) {
    const curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  /**
   * PAD — six detuned saws (3 chord tones x 2) plus a 2-osc octave layer that
   * only appears in overdrive. These oscillators are started once and never
   * stopped: chord changes are a `setTargetAtTime` glide on frequency, so the
   * pad is a single unbroken drone for the entire session. Zero voice cost.
   */
  _buildPad() {
    const ctx = this._ctx;
    const DET = [-9, 9, -6, 6, -13, 13]; // cents, wide enough to shimmer

    this._padFilter = ctx.createBiquadFilter();
    this._padFilter.type = 'lowpass';
    this._padFilter.frequency.value = A.PAD_CUT_MIN;
    this._padFilter.Q.value = 3.0;                 // a little resonance = synth
    this._padFilter.connect(this._busPad);

    // Slow cutoff wobble so a stationary pad still breathes.
    this._padLfo = ctx.createOscillator();
    this._padLfo.type = 'sine';
    this._padLfo.frequency.value = 0.11;
    this._padLfoAmt = ctx.createGain();
    this._padLfoAmt.gain.value = 140;
    this._padLfo.connect(this._padLfoAmt);
    this._padLfoAmt.connect(this._padFilter.frequency);
    try { this._padLfo.start(); } catch (e) {}

    this._padGain = ctx.createGain();
    this._padGain.gain.value = 0.16;               // 6 saws need headroom
    this._padGain.connect(this._padFilter);

    this._padOscs = [];
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(CHORDS[0].pad[i >> 1]);
      o.detune.value = DET[i];
      if (this._bend) this._bend.connect(o.detune);
      o.connect(this._padGain);
      try { o.start(); } catch (e) {}
      this._padOscs.push(o);
    }

    // Octave-up layer: silent normally, opened by overdrive for the euphoria.
    this._padOctGain = ctx.createGain();
    this._padOctGain.gain.value = 0.0001;
    this._padOctGain.connect(this._padFilter);
    this._padOct = [];
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(CHORDS[0].pad[i * 2] + 12);
      o.detune.value = i === 0 ? -5 : 7;
      if (this._bend) this._bend.connect(o.detune);
      o.connect(this._padOctGain);
      try { o.start(); } catch (e) {}
      this._padOct.push(o);
    }
  }

  /**
   * TETHER TENSION — one persistent graph, modulated forever. A looping noise
   * source and a saw both feed a high-Q bandpass; `update()` only moves the
   * bandpass frequency and the output gain. Nothing is ever created or
   * destroyed here, which is the only way to make a per-frame-modulated sound
   * safe in a 60 fps loop.
   */
  _buildTension() {
    const ctx = this._ctx;

    this._tenBp = ctx.createBiquadFilter();
    this._tenBp.type = 'bandpass';
    this._tenBp.frequency.value = 400;
    this._tenBp.Q.value = 7.5;

    this._tenGain = ctx.createGain();
    this._tenGain.gain.value = 0.0001;
    this._tenBp.connect(this._tenGain);
    this._tenGain.connect(this._busSfx);

    this._tenNoise = ctx.createBufferSource();
    this._tenNoise.buffer = this._noise;
    this._tenNoise.loop = true;
    const nGain = ctx.createGain(); nGain.gain.value = 0.6;
    this._tenNoise.connect(nGain);
    nGain.connect(this._tenBp);
    try { this._tenNoise.start(); } catch (e) {}

    this._tenOsc = ctx.createOscillator();
    this._tenOsc.type = 'sawtooth';
    this._tenOsc.frequency.value = 180;
    if (this._bend) this._bend.connect(this._tenOsc.detune);
    const oGain = ctx.createGain(); oGain.gain.value = 0.35;
    this._tenOsc.connect(oGain);
    oGain.connect(this._tenBp);
    try { this._tenOsc.start(); } catch (e) {}
  }

  // =========================================================================
  // Param helpers.
  //
  // Rule enforced throughout: params owned by `update()` are ONLY ever touched
  // with `setTargetAtTime` (`_to`), params owned by one-shot events are touched
  // with cancel+setValue+linearRamp (`_ramp`). Mixing exponential ramps with
  // running setTarget curves on the same param is what produces Safari's
  // "cannot schedule" exceptions and pops.
  // =========================================================================

  /** Smoothed follow. `v` is guarded; a bad value is simply ignored. */
  _to(param, v, t, tc) {
    if (!param) return;
    const x = num(v, NaN);
    if (x !== x) return;
    try { param.setTargetAtTime(x, t, tc); } catch (e) {}
  }

  /** Hard scheduled move, safe to call over an in-flight setTarget curve. */
  _ramp(param, v, dur) {
    if (!param || !this._ctx) return;
    const x = num(v, NaN);
    if (x !== x) return;
    const t = this._ctx.currentTime;
    try {
      const cur = num(param.value, 0);
      param.cancelScheduledValues(t);
      param.setValueAtTime(cur, t);
      param.linearRampToValueAtTime(x, t + Math.max(0.005, dur));
    } catch (e) {}
  }

  // =========================================================================
  // Voice bookkeeping.
  //
  // Every one-shot registers exactly one "voice" and disconnects its whole
  // sub-chain from `onended`. A ten-minute run schedules on the order of
  // 30,000 notes; without this the graph would grow without bound and the
  // audio thread would fall over long before the renderer did.
  // =========================================================================

  _canVoice(isSfx) {
    return this._voices < (isSfx ? A.MAX_VOICES : A.MAX_VOICES - A.SFX_RESERVE);
  }

  /**
   * `src` is the node whose `onended` drives cleanup (always a source that has
   * a scheduled `stop()`); a..e are the rest of that voice's nodes.
   */
  _hold(src, a, b, c, d, e) {
    this._voices++;
    const self = this;
    src.onended = function () {
      self._voices--;
      if (self._voices < 0) self._voices = 0;
      try { src.disconnect(); } catch (err) {}
      if (a) { try { a.disconnect(); } catch (err) {} }
      if (b) { try { b.disconnect(); } catch (err) {} }
      if (c) { try { c.disconnect(); } catch (err) {} }
      if (d) { try { d.disconnect(); } catch (err) {} }
      if (e) { try { e.disconnect(); } catch (err) {} }
      src.onended = null;
    };
  }

  /** Percussive AD envelope. Exponentials never touch zero — 1e-4 is -80 dB. */
  _env(g, t, peak, atk, dur) {
    const p = Math.max(0.0002, num(peak, 0.2));
    const a = Math.max(0.001, atk);
    try {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(p, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    } catch (e) {}
  }

  /** Shared noise source factory; random offset stops it sounding like a loop. */
  _noiseSrc(t, dur, rate) {
    const s = this._ctx.createBufferSource();
    s.buffer = this._noise;
    s.playbackRate.value = clamp(num(rate, 1), 0.25, 4);
    const off = Math.random() * 1.5;
    try { s.start(t, off); } catch (e) { try { s.start(t); } catch (e2) {} }
    try { s.stop(t + dur); } catch (e) {}
    return s;
  }

  // =========================================================================
  // Scheduler
  // =========================================================================

  _startClock() {
    if (this._dead || !this._built || !this._enabled) return;
    if (this._timer) return;
    if (!this._ctx || this._ctx.state !== 'running') return;
    this._nextTime = this._ctx.currentTime + 0.06;
    const self = this;
    this._timer = setInterval(function () { self._tick(); }, A.TICK_MS);
  }

  _stopClock() {
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
  }

  /**
   * The lookahead pump. Wakes every 25 ms, drains every 16th note that starts
   * inside the next 120 ms. `_nextTime` is absolute AudioContext time, so the
   * grid is sample-accurate no matter how badly the main thread stalls; if the
   * stall was long enough that we fell behind, we resync forward rather than
   * dumping a burst of late notes.
   */
  _tick() {
    const ctx = this._ctx;
    if (!ctx || this._dead) { this._stopClock(); return; }
    if (ctx.state !== 'running') return;   // hidden tab / interrupted; wait it out

    const now = ctx.currentTime;
    if (this._nextTime < now - A.RESYNC_SLIP) this._nextTime = now + 0.03;

    // Voice watchdog. `onended` is the only thing that decrements `_voices`, so
    // an implementation that silently refuses a `start()` could strand the
    // counter at the cap and mute the game forever. If we sit at the ceiling
    // for five straight seconds — impossible in normal play, where the longest
    // voice is ~1 s — assume a leak and reset. Costs one compare per tick.
    if (this._voices >= A.MAX_VOICES) {
      if (this._voiceFullSince === 0) this._voiceFullSince = now;
      else if (now - this._voiceFullSince > A.VOICE_STUCK) {
        this._voices = 0;
        this._voiceFullSince = 0;
      }
    } else {
      this._voiceFullSince = 0;
    }

    let guard = 0;
    while (this._nextTime < now + A.LOOKAHEAD && guard++ < 64) {
      this._schedule(this._step, this._nextTime);
      this._step = (this._step + 1) % LOOP_STEPS;
      this._nextTime += SEC_PER_STEP;
    }
  }

  /** Schedule everything that happens on one 16th note. */
  _schedule(step, t) {
    const ci = ((step / (BAR_STEPS * A.CHORD_BARS)) | 0) % CHORDS.length;
    const chord = CHORDS[ci];
    const s = step % BAR_STEPS;

    // Chord change: glide the persistent pad rather than retriggering it.
    if (ci !== this._chord) {
      this._chord = ci;
      for (let i = 0; i < 6; i++) {
        this._to(this._padOscs[i].frequency, mtof(chord.pad[i >> 1]), t, 0.09);
      }
      this._to(this._padOct[0].frequency, mtof(chord.pad[0] + 12), t, 0.09);
      this._to(this._padOct[1].frequency, mtof(chord.pad[2] + 12), t, 0.09);
    }

    // After a crash the pad keeps sagging but the rhythm section stops dead.
    if (this._crashing && t > this._crashSilence) return;

    const menu = this._menu;
    const energy = this._energy;

    // ---- SUB -------------------------------------------------------------
    if (menu) {
      // Menu: a sparse half-note heartbeat under the pad. Just enough pulse to
      // promise that something is about to start.
      if (s === 0 || s === 8) this._bass(t, chord.bass, 0.75, 0.55);
    } else {
      const v = BASS_VEL[s];
      if (v > 0) this._bass(t, chord.bass, v, s % 4 === 0 ? 0.30 : 0.16);
    }

    if (menu) return;  // arp + percussion are gameplay-only

    // ---- ARP -------------------------------------------------------------
    // Register rises with the combo multiplier: the same figure, two octaves
    // up, is how the track tells you you are on a run.
    if (energy > 0.02) {
      const midi = chord.arp[ARP_IDX[s]] + 12 * (ARP_OCT[s] + this._arpOct);
      const accent = (s % 4 === 0) ? 1 : (s % 2 === 0 ? 0.72 : 0.5);
      this._arp(t, midi, accent * (0.35 + 0.65 * energy));
    }

    // ---- PERCUSSION ------------------------------------------------------
    const kv = KICK_VEL[s];
    if (kv > 0 && (kv > 0.9 || energy > 0.45)) this._kick(t, kv);
    if (CLAP_VEL[s] > 0 && energy > 0.20) this._clap(t, 0.85);
    if (energy > 0.12) {
      const hv = HAT_VEL[s];
      // Thin the hats out at low energy so the mix breathes when you're slow.
      if (hv > 0.45 || energy > 0.5) {
        this._hat(t, hv * (0.5 + 0.5 * energy), s === 14 ? 0.16 : 0.042);
      }
    }
  }

  // =========================================================================
  // Music voices — each is {source(s) + one gain} into a shared filter.
  // =========================================================================

  /**
   * SUB/BASS. A sine for the body plus a quieter saw for the bite, both with a
   * fast downward pitch envelope on the attack (start ~1.9x, settle in 35 ms).
   * That envelope is the entire difference between "a bass note" and "a punch"
   * — it fakes the transient of a plucked string on a phone speaker that
   * physically cannot reproduce 55 Hz.
   */
  _bass(t, midi, vel, dur) {
    if (!this._canVoice(false)) return;
    const ctx = this._ctx;
    const f = mtof(midi);
    const g = ctx.createGain();
    g.connect(this._subLp);

    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.detune.value = this._bendCents;
    try {
      o1.frequency.setValueAtTime(f * 1.9, t);
      o1.frequency.exponentialRampToValueAtTime(f, t + 0.035);
    } catch (e) { o1.frequency.value = f; }
    o1.connect(g);

    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.detune.value = this._bendCents + 6;
    o2.frequency.value = f;
    const sg = ctx.createGain();
    sg.gain.value = 0.30;                      // saw sits well under the sine
    o2.connect(sg); sg.connect(g);

    this._env(g, t, 0.9 * clamp(num(vel, 0.5), 0, 1), 0.004, dur);
    const end = t + dur + 0.05;
    try { o1.start(t); o1.stop(end); } catch (e) {}
    try { o2.start(t); o2.stop(end); } catch (e) {}
    this._hold(o1, o2, sg, g);
  }

  /** ARP. Single square through a resonant shared lowpass; short pluck. */
  _arp(t, midi, vel) {
    if (!this._canVoice(false)) return;
    const ctx = this._ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = mtof(clamp(midi, 24, 108));
    o.detune.value = this._bendCents + (Math.random() * 6 - 3); // human-ish
    const g = ctx.createGain();
    o.connect(g); g.connect(this._arpLp);
    this._env(g, t, 0.34 * clamp(num(vel, 0.5), 0, 1), 0.003, 0.115);
    try { o.start(t); o.stop(t + 0.19); } catch (e) {}
    this._hold(o, g);
  }

  /** KICK. Sine swept 155 -> 44 Hz in 90 ms — the classic 909 recipe. */
  _kick(t, vel) {
    if (!this._canVoice(false)) return;
    const ctx = this._ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    try {
      o.frequency.setValueAtTime(155, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
    } catch (e) { o.frequency.value = 60; }
    const g = ctx.createGain();
    o.connect(g); g.connect(this._busPerc);
    this._env(g, t, 1.0 * clamp(num(vel, 1), 0, 1), 0.002, 0.34);
    try { o.start(t); o.stop(t + 0.42); } catch (e) {}
    this._hold(o, g);
  }

  /**
   * CLAP. Filtered noise with three 10 ms slap-back spikes before the body —
   * that stutter is what separates a clap from a hiss, and it costs nothing
   * because it is pure gain automation on one node.
   */
  _clap(t, vel) {
    if (!this._canVoice(false)) return;
    const ctx = this._ctx;
    const v = 0.5 * clamp(num(vel, 1), 0, 1);
    const g = ctx.createGain();
    const src = this._noiseSrc(t, 0.24, 1);
    src.connect(g); g.connect(this._clapBp);
    try {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.002);
      g.gain.exponentialRampToValueAtTime(v * 0.35, t + 0.010);
      g.gain.exponentialRampToValueAtTime(v, t + 0.014);
      g.gain.exponentialRampToValueAtTime(v * 0.35, t + 0.022);
      g.gain.exponentialRampToValueAtTime(v * 0.95, t + 0.026);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
    } catch (e) {}
    this._hold(src, g);
  }

  /** HAT. Highpassed noise, played fast so it reads as metal not wind. */
  _hat(t, vel, dur) {
    if (!this._canVoice(false)) return;
    const g = this._ctx.createGain();
    const src = this._noiseSrc(t, dur + 0.03, 1.6);
    src.connect(g); g.connect(this._hatHp);
    this._env(g, t, 0.3 * clamp(num(vel, 0.5), 0, 1), 0.001, dur);
    this._hold(src, g);
  }

  // =========================================================================
  // Per-frame state follow. Allocates nothing, creates nothing.
  // =========================================================================
  update(dt, state) {
    const ctx = this._ctx;
    if (this._dead || !this._built || !ctx) return;
    if (!this._enabled || ctx.state !== 'running') return;

    const s = state || EMPTY_STATE;
    const speed = c01(s.speed01);
    const od = c01(s.overdrive01);
    const ten = c01(s.tension01);
    const mult = clamp(num(s.multiplier, 1), 1, 10);
    const menu = s.menu === true;
    const alive = s.alive !== false;
    const t = ctx.currentTime;

    // Expire the brief overdrive pitch lift applied to one-shot voices.
    if (this._bendUntil !== 0 && t > this._bendUntil) {
      this._bendUntil = 0;
      this._bendCents = 0;
    }

    // Death recovery. Gated behind `_crashHold` so it can never be undone by
    // the same frame that triggered it — main.js may well call update() with
    // `alive` still true immediately after the crash event fires. After the
    // fade has fully run we restore as soon as the game says we're alive or
    // back in a menu, and unconditionally on a timeout so the game-over screen
    // never sits in silence.
    if (this._crashing && t > this._crashHold && (alive || menu || t > this._crashRestore)) {
      this._restoreAfterCrash();
    }

    // Values the scheduler reads. Plain numbers, no automation.
    this._menu = menu;
    this._energy = menu ? 0 : (0.32 + 0.68 * speed);
    this._arpOct = mult >= 7 ? 2 : (mult >= 4 ? 1 : 0);

    const energy = this._energy;
    const fade = A.FADE_TC;

    // ---- layer balance ---------------------------------------------------
    this._to(this._busSub.gain, menu ? A.SUB_MENU : A.SUB_GAIN * (0.66 + 0.34 * energy), t, fade);
    this._to(this._busArp.gain, menu ? 0.0001 : A.ARP_GAIN * (0.42 + 0.58 * energy), t, fade);
    this._to(this._busPad.gain, menu ? A.PAD_MENU : A.PAD_GAIN * (0.72 + 0.28 * energy), t, fade);
    this._to(this._busPerc.gain, menu ? 0.0001 : A.PERC_GAIN * (0.5 + 0.5 * energy), t, fade);

    // ---- pad cutoff: the "you are going fast" cue ------------------------
    // Exponential in octaves so it feels linear to the ear: ~340 Hz parked in
    // the menu, ~10 kHz flat out.
    const padOct = menu ? 0.25 : (1.0 + 4.2 * speed + 1.6 * od);
    this._to(this._padFilter.frequency,
             clamp(A.PAD_CUT_MIN * Math.pow(2, padOct), 100, A.FILTER_MAX), t, 0.22);
    this._to(this._padOctGain.gain, 0.0001 + 0.55 * od, t, 0.18);

    // ---- master duck -----------------------------------------------------
    if (!this._crashing) {
      const duckOct = menu ? 0.42 : (1.2 + 2.6 * speed + 2.2 * od);
      this._to(this._duck.frequency,
               clamp(A.DUCK_BASE * Math.pow(2, duckOct), 220, A.FILTER_MAX), t, 0.15);
      this._to(this._master.gain, A.MASTER * (1 + 0.12 * od), t, A.PARAM_TC);
    }

    // ---- delay widens and hangs on in overdrive --------------------------
    const fb = A.FB_BASE + A.FB_OD * od;
    this._to(this._fbL.gain, fb, t, 0.25);
    this._to(this._fbR.gain, fb, t, 0.25);
    this._to(this._wet.gain, A.WET_BASE + A.WET_OD * od, t, 0.25);

    // ---- tether tension whine -------------------------------------------
    // Gain is quadratic so light rope load is nearly inaudible and a hard swing
    // screams. Release is near-instant (10 ms) — a lingering whine after
    // letting go feels like a bug.
    const on = (this._tetherOn && !menu) ? ten : 0;
    this._to(this._tenGain.gain, 0.0001 + A.TENSION_GAIN * on * on, t, on > 0.001 ? 0.05 : 0.010);
    this._to(this._tenBp.frequency, 320 + 2600 * on, t, 0.06);
    this._to(this._tenOsc.frequency, 150 + 420 * on, t, 0.06);
  }

  // =========================================================================
  // One-shot SFX
  // =========================================================================

  /**
   * ATTACH — a tight upward "chk" (square swept 210 -> 900 Hz in 30 ms) plus a
   * short resonant ping an octave and a half up. The two together read as
   * mechanical latch + energised tether.
   */
  attach() {
    this._tetherOn = true;
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = 'square';
    try {
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.030);
    } catch (e) { o.frequency.value = 600; }
    const g = ctx.createGain();
    o.connect(g); g.connect(this._busSfx);
    this._env(g, t, 0.30, 0.002, 0.055);

    const p = ctx.createOscillator();
    p.type = 'sine';
    p.frequency.value = 1318.5;                    // E6
    try { p.frequency.exponentialRampToValueAtTime(1180, t + 0.22); } catch (e) {}
    const pf = ctx.createBiquadFilter();
    pf.type = 'bandpass'; pf.frequency.value = 1400; pf.Q.value = 6;
    const pg = ctx.createGain();
    p.connect(pf); pf.connect(pg); pg.connect(this._busSfx);
    this._env(pg, t, 0.22, 0.002, 0.24);

    try { o.start(t); o.stop(t + 0.09); } catch (e) {}
    try { p.start(t); p.stop(t + 0.28); } catch (e) {}
    this._hold(p, o, g, pf, pg);
  }

  /**
   * RELEASE — a whoosh. Noise through a bandpass swept upward; the top of the
   * sweep and the overall brightness scale with speed, so a slow let-go is a
   * soft "pff" and a fast one is a jet.
   */
  release(speed01) {
    this._tetherOn = false;
    if (this._built && this._tenGain && this._ctx) {
      // Kill the whine immediately, even if update() is not running.
      this._ramp(this._tenGain.gain, 0.0001, 0.03);
    }
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;
    const sp = c01(speed01);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.4;
    const top = 900 + 3600 * sp;
    try {
      bp.frequency.setValueAtTime(320, t);
      bp.frequency.exponentialRampToValueAtTime(top, t + 0.16);
      bp.frequency.exponentialRampToValueAtTime(top * 0.45, t + 0.34);
    } catch (e) { bp.frequency.value = top; }

    const g = ctx.createGain();
    const src = this._noiseSrc(t, 0.38, 1);
    src.connect(bp); bp.connect(g); g.connect(this._busSfx);
    this._env(g, t, 0.14 + 0.22 * sp, 0.012, 0.33);
    this._hold(src, bp, g);
  }

  /**
   * PERFECT ARC — the payoff sound.
   *
   * Two-operator FM bell: carrier sine, modulator at 2.76x (the classic
   * inharmonic bell ratio), modulation index decaying fast so the strike is
   * metallic and the tail is pure. A quiet octave-up sine on top adds the
   * "sparkle" that survives a phone speaker.
   *
   * `n` is the combo count and transposes UP the A-minor pentatonic, one step
   * per consecutive perfect arc, capped at ~2 octaves. Chaining arcs therefore
   * plays an ascending melody — the sound of a run going well, generated by
   * the run itself.
   */
  perfect(n) {
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;

    const stepIdx = clamp(Math.floor(num(n, 1)) - 1, 0, A.PERFECT_MAX_STEP);
    const midi = PERFECT_BASE_MIDI +
                 12 * Math.floor(stepIdx / PENTATONIC.length) +
                 PENTATONIC[stepIdx % PENTATONIC.length];
    const f = mtof(midi);
    // Later notes ring longer — the melody opens out as the chain grows.
    const dur = 0.85 + 0.05 * stepIdx;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = f;
    carrier.detune.value = this._bendCents;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * 2.76;
    const modAmt = ctx.createGain();
    try {
      modAmt.gain.setValueAtTime(f * 2.4, t);
      modAmt.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.30);
    } catch (e) { modAmt.gain.value = f * 0.5; }
    mod.connect(modAmt);
    modAmt.connect(carrier.frequency);

    const vca = ctx.createGain();
    carrier.connect(vca);
    vca.connect(this._busSfx);
    vca.connect(this._sfxSend);       // extra send: the bell tail is the shimmer
    try {
      vca.gain.setValueAtTime(0.0001, t);
      vca.gain.exponentialRampToValueAtTime(0.34, t + 0.004);
      vca.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } catch (e) {}

    const shine = ctx.createOscillator();
    shine.type = 'sine';
    shine.frequency.value = f * 2;
    shine.detune.value = this._bendCents + 4;
    const shineG = ctx.createGain();
    shine.connect(shineG); shineG.connect(this._busSfx);
    this._env(shineG, t, 0.075, 0.003, dur * 0.45);

    const end = t + dur + 0.05;
    try { carrier.start(t); carrier.stop(end); } catch (e) {}
    try { mod.start(t); mod.stop(end); } catch (e) {}
    try { shine.start(t); shine.stop(t + dur * 0.5 + 0.05); } catch (e) {}
    this._hold(carrier, mod, modAmt, vca, shine, shineG);
  }

  /**
   * GRAZE — fires many times a second at high speed, so it is rate-limited to
   * 8/s internally and mixed at roughly -25 dB with a 25 ms decay. Anything
   * louder or longer turns a skill expression into an irritant.
   */
  graze() {
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;
    if (this._lastGraze > 0 && t - this._lastGraze < A.GRAZE_MIN_GAP) return;
    this._lastGraze = t;

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 4800 + Math.random() * 1400;   // slight scatter
    const g = ctx.createGain();
    o.connect(g); g.connect(this._busSfx);
    this._env(g, t, A.GRAZE_GAIN, 0.001, 0.028);
    try { o.start(t); o.stop(t + 0.05); } catch (e) {}
    this._hold(o, g);
  }

  /** ORB — a small warm blip: triangle rising a fifth, with a sine underneath. */
  orb() {
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = 'triangle';
    try {
      o.frequency.setValueAtTime(660, t);
      o.frequency.exponentialRampToValueAtTime(990, t + 0.07);
    } catch (e) { o.frequency.value = 880; }
    const g = ctx.createGain();
    o.connect(g); g.connect(this._busSfx);
    this._env(g, t, 0.24, 0.004, 0.20);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 330;
    const sg = ctx.createGain();
    sub.connect(sg); sg.connect(this._busSfx);
    this._env(sg, t, 0.12, 0.004, 0.13);

    try { o.start(t); o.stop(t + 0.26); } catch (e) {}
    try { sub.start(t); sub.stop(t + 0.18); } catch (e) {}
    this._hold(o, g, sub, sg);
  }

  /** UI TAP — soft, short, unobtrusive. Deliberately duller than gameplay SFX. */
  uiTap() {
    if (!this._live() || !this._canVoice(true)) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    try {
      o.frequency.setValueAtTime(900, t);
      o.frequency.exponentialRampToValueAtTime(320, t + 0.04);
    } catch (e) { o.frequency.value = 520; }
    const g = ctx.createGain();
    o.connect(g); g.connect(this._busSfx);
    this._env(g, t, 0.13, 0.002, 0.05);
    try { o.start(t); o.stop(t + 0.08); } catch (e) {}
    this._hold(o, g);
  }

  // =========================================================================
  // Overdrive
  // =========================================================================

  /**
   * The filter opening, the octave layer and the delay feedback are all driven
   * continuously from `state.overdrive01` in `update()` — that keeps the ramp
   * in and out perfectly smooth and stops two owners fighting over one param.
   * What this method adds is the *transient*: an immediate kick to the delay
   * and a whole-mix lift of a tone that falls back over ~1.4 s. That momentary
   * key change is what makes it read as euphoria rather than "a filter opened".
   */
  overdriveStart() {
    if (!this._live()) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;

    this._to(this._fbL.gain, A.FB_BASE + A.FB_OD, t, 0.05);
    this._to(this._fbR.gain, A.FB_BASE + A.FB_OD, t, 0.05);
    this._to(this._wet.gain, A.WET_BASE + A.WET_OD, t, 0.05);

    // One-shot voices read this number at schedule time.
    this._bendCents = A.OD_BEND_CENTS;
    this._bendUntil = t + A.OD_BEND_HOLD;

    // Persistent voices glide via the shared ConstantSource.
    if (this._bend) {
      try {
        const p = this._bend.offset;
        p.cancelScheduledValues(t);
        p.setValueAtTime(num(p.value, 0), t);
        p.linearRampToValueAtTime(A.OD_BEND_CENTS, t + 0.18);
        p.linearRampToValueAtTime(0, t + A.OD_BEND_HOLD + 0.2);
      } catch (e) {}
    }
  }

  /** Reverse the transient; the continuous half unwinds itself via update(). */
  overdriveEnd() {
    if (!this._live()) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;
    this._bendCents = 0;
    this._bendUntil = 0;
    if (this._bend) {
      try {
        const p = this._bend.offset;
        p.cancelScheduledValues(t);
        p.setValueAtTime(num(p.value, 0), t);
        p.linearRampToValueAtTime(0, t + 0.35);
      } catch (e) {}
    }
    this._to(this._fbL.gain, A.FB_BASE, t, 0.4);
    this._to(this._fbR.gain, A.FB_BASE, t, 0.4);
    this._to(this._wet.gain, A.WET_BASE, t, 0.4);
  }

  // =========================================================================
  // Death
  // =========================================================================

  /**
   * CRASH — impact SFX plus a full "power cut" of the music: everything pitches
   * down two octaves, the master filter slams from wherever it is to 160 Hz,
   * the rhythm section stops scheduling after 400 ms, and the whole thing fades
   * over 1.2 s. The pad is the only thing left, sagging. `update()` puts it all
   * back the moment the next run starts.
   */
  crash() {
    this._tetherOn = false;
    if (!this._live()) return;
    const ctx = this._ctx;
    const t = ctx.currentTime;

    if (this._tenGain) this._ramp(this._tenGain.gain, 0.0001, 0.03);

    // ---- music: sweep down, pitch down, fade out -------------------------
    this._crashing = true;
    this._crashSilence = t + A.CRASH_SILENCE;
    this._crashHold = t + A.CRASH_HOLD;
    this._crashRestore = t + A.CRASH_RESTORE;

    try {
      const p = this._duck.frequency;
      p.cancelScheduledValues(t);
      p.setValueAtTime(clamp(num(p.value, 2000), 220, A.FILTER_MAX), t);
      p.exponentialRampToValueAtTime(160, t + 0.55);
    } catch (e) {}

    if (this._bend) {
      try {
        const p = this._bend.offset;
        p.cancelScheduledValues(t);
        p.setValueAtTime(num(p.value, 0), t);
        p.linearRampToValueAtTime(A.CRASH_BEND, t + 0.9);
      } catch (e) {}
    }

    try {
      const p = this._master.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(num(p.value, A.MASTER), t);
      p.setValueAtTime(num(p.value, A.MASTER), t + 0.30);   // hold, then fall
      p.linearRampToValueAtTime(0.0001, t + 0.30 + A.CRASH_FADE);
    } catch (e) {}

    // ---- impact SFX (post-duck bus, so it stays bright through the sweep) --
    if (this._canVoice(true)) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      try {
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(26, t + 0.55);
      } catch (e) { o.frequency.value = 60; }
      const g = ctx.createGain();
      o.connect(g); g.connect(this._busSfx);
      this._env(g, t, 0.95, 0.003, 0.70);
      try { o.start(t); o.stop(t + 0.78); } catch (e) {}
      this._hold(o, g);
    }

    if (this._canVoice(true)) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 1.2;
      try {
        lp.frequency.setValueAtTime(7000, t);
        lp.frequency.exponentialRampToValueAtTime(220, t + 0.60);
      } catch (e) { lp.frequency.value = 1200; }
      const g = ctx.createGain();
      const src = this._noiseSrc(t, 0.70, 1);
      src.connect(lp); lp.connect(g); g.connect(this._busSfx);
      this._env(g, t, 0.55, 0.004, 0.62);
      this._hold(src, lp, g);
    }

    if (this._canVoice(true)) {
      const d = ctx.createOscillator();
      d.type = 'sawtooth';
      try {
        d.frequency.setValueAtTime(420, t);
        d.frequency.exponentialRampToValueAtTime(38, t + 0.70);
      } catch (e) { d.frequency.value = 120; }
      const df = ctx.createBiquadFilter();
      df.type = 'lowpass'; df.frequency.value = 1800; df.Q.value = 4;
      const dg = ctx.createGain();
      d.connect(df); df.connect(dg); dg.connect(this._busSfx);
      this._env(dg, t, 0.34, 0.006, 0.72);
      try { d.start(t); d.stop(t + 0.80); } catch (e) {}
      this._hold(d, df, dg);
    }
  }

  /** Undo `crash()`. Called from update(), never externally. */
  _restoreAfterCrash() {
    this._crashing = false;
    if (!this._ctx || !this._built) return;
    const t = this._ctx.currentTime;

    if (this._bend) {
      try {
        const p = this._bend.offset;
        p.cancelScheduledValues(t);
        p.setValueAtTime(num(p.value, 0), t);
        p.linearRampToValueAtTime(0, t + A.RESTORE_TIME * 0.6);
      } catch (e) {}
    }
    // Hand the duck filter and master back to update()'s setTarget follow by
    // clearing the crash ramps first, otherwise the old linear ramp keeps
    // dragging them down.
    try {
      this._duck.frequency.cancelScheduledValues(t);
      this._duck.frequency.setValueAtTime(clamp(num(this._duck.frequency.value, 400), 100, A.FILTER_MAX), t);
    } catch (e) {}
    try {
      this._master.gain.cancelScheduledValues(t);
      this._master.gain.setValueAtTime(Math.max(0.0001, num(this._master.gain.value, 0.0001)), t);
      this._master.gain.linearRampToValueAtTime(A.MASTER, t + A.RESTORE_TIME);
    } catch (e) {}
  }
}
