// ARCLIGHT — input. The entire control scheme is one boolean: is a finger down?
//
// iOS Safari specifics handled here:
//  - Multi-touch: ANY active touch counts as "down". Lifting one of two fingers must
//    not release the tether — that would feel broken.
//  - `touch-action: none` in CSS stops scroll/zoom, but we still preventDefault on
//    touchstart to suppress the 300ms synthetic mouse cascade and double-tap zoom.
//  - Touches that begin on a UI button must not drive gameplay, so we ignore events
//    whose target is inside an interactive element.
//  - Losing the page (backgrounding, incoming call) must release cleanly.

export class Input {
  constructor(target = window) {
    this.down = false;
    this.pressed = false;     // edge: became down this frame
    this.released = false;    // edge: became up this frame
    this._wasDown = false;
    this._pointers = new Set();
    this._enabled = true;

    const isUi = (e) => {
      const t = e.target;
      return t && t.closest && t.closest('button, a, input, [data-ui]');
    };

    const onDown = (e) => {
      if (!this._enabled || isUi(e)) return;
      this._pointers.add(e.pointerId);
      this.down = true;
      if (e.cancelable) e.preventDefault();
    };
    const onUp = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size === 0) this.down = false;
    };

    // Pointer Events cover touch, mouse and pencil uniformly and are well supported
    // on iOS 13+. We never fall back to touch events, which would double-fire.
    target.addEventListener('pointerdown', onDown, { passive: false });
    target.addEventListener('pointerup', onUp, { passive: true });
    target.addEventListener('pointercancel', onUp, { passive: true });
    target.addEventListener('lostpointercapture', onUp, { passive: true });

    // Keyboard for desktop playtesting — space / any arrow / click all act as the thumb.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !this._enabled) return;
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
        this.down = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') this.down = false;
    });

    const release = () => { this._pointers.clear(); this.down = false; };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

    // Belt and braces against iOS pinch-zoom and double-tap zoom.
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('contextmenu', (e) => e.preventDefault(), { passive: false });
  }

  /** Call once per frame, before update, to compute edges. */
  poll() {
    this.pressed = this.down && !this._wasDown;
    this.released = !this.down && this._wasDown;
    this._wasDown = this.down;
  }

  /** Suppress gameplay input (e.g. while a menu is up) without losing listeners. */
  setEnabled(v) {
    this._enabled = v;
    if (!v) { this._pointers.clear(); this.down = false; }
  }
}
