/* Per-assignment response-curve editor — port of gc_dsp/web/src/curve.ts.
   X = pedal travel (0 = rest → 1 = full), Y = output 0..1 (scaled to the
   parameter's sweep range on the DSP). Nine evenly spaced handles; a
   Catmull-Rom line through them is sampled to a 33-point 0..255 table for
   the firmware (GC_CURVE_N). Default is the identity diagonal. window.GCCurve */

'use strict';

(function () {
  const LUT_N = 33;            /* MUST match the Daisy's GC_CURVE_N */
  const ANCHORS = 9;
  const NS = 'http://www.w3.org/2000/svg';
  const W = 150, H = 96, PAD = 9, IW = W - 2 * PAD, IH = H - 2 * PAD;
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const px = x => PAD + x * IW;
  const py = y => PAD + (1 - y) * IH;
  const vy = sy => clamp01(1 - (sy - PAD) / IH);

  function sampleAt(ys, x) {
    const seg = (ANCHORS - 1) * clamp01(x);
    const i = Math.min(ANCHORS - 2, Math.floor(seg));
    const t = seg - i;
    const p0 = ys[Math.max(0, i - 1)], p1 = ys[i], p2 = ys[i + 1], p3 = ys[Math.min(ANCHORS - 1, i + 2)];
    const t2 = t * t, t3 = t2 * t;
    return clamp01(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
  }
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  class CurveEditor {
    constructor(opts) {
      this.onChange = opts.onChange;
      this.ys = Array.from({ length: ANCHORS }, (_, i) => i / (ANCHORS - 1));
      const svg = el('svg', { class: 'curve-editor', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
      svg.appendChild(el('rect', { class: 'curve-frame', x: PAD, y: PAD, width: IW, height: IH }));
      svg.appendChild(el('line', { class: 'curve-diag', x1: px(0), y1: py(0), x2: px(1), y2: py(1) }));
      this.curve = el('path', { class: 'curve-line' }); svg.appendChild(this.curve);
      this.dot = el('circle', { class: 'curve-live', r: 3 }); this.dot.style.display = 'none'; svg.appendChild(this.dot);
      this.handles = [];
      for (let i = 0; i < ANCHORS; i++) {
        const h = el('circle', { class: 'curve-handle', r: 5 });
        h.addEventListener('pointerdown', e => this.onDown(e, i));
        svg.appendChild(h); this.handles.push(h);
      }
      this.dragging = -1;
      svg.addEventListener('pointermove', e => this.onMove(e));
      svg.addEventListener('pointerup', () => { this.dragging = -1; });
      svg.addEventListener('pointercancel', () => { this.dragging = -1; });
      this.el = svg;
      this.render();
    }
    lut() {
      const out = new Uint8Array(LUT_N);
      for (let i = 0; i < LUT_N; i++) out[i] = Math.round(sampleAt(this.ys, i / (LUT_N - 1)) * 255);
      return out;
    }
    /* adopt a device-reported table WITHOUT firing onChange */
    setFromLut(lut) {
      if (lut.length < 2) return;
      for (let i = 0; i < ANCHORS; i++) {
        const idx = Math.round((i / (ANCHORS - 1)) * (lut.length - 1));
        this.ys[i] = clamp01(lut[idx] / 255);
      }
      this.render();
    }
    reset() {
      this.ys = Array.from({ length: ANCHORS }, (_, i) => i / (ANCHORS - 1));
      this.render();
      this.onChange(this.lut());
    }
    isIdentity() {
      const lut = this.lut();
      for (let i = 0; i < lut.length; i++) if (Math.abs(lut[i] - Math.round(i * 255 / (lut.length - 1))) > 1) return false;
      return true;
    }
    sample(x) { return sampleAt(this.ys, x); }
    setLive(x) {
      if (!(x >= 0 && x <= 1)) { this.dot.style.display = 'none'; return; }
      this.dot.setAttribute('cx', px(x)); this.dot.setAttribute('cy', py(sampleAt(this.ys, x)));
      this.dot.style.display = '';
    }
    svgXY(e) {
      const r = this.el.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
    }
    onDown(e, i) { e.preventDefault(); this.dragging = i; this.el.setPointerCapture(e.pointerId); }
    onMove(e) {
      if (this.dragging < 0) return;
      this.ys[this.dragging] = vy(this.svgXY(e).y);
      this.render();
      this.onChange(this.lut());
    }
    render() {
      const pts = [];
      for (let i = 0; i <= 48; i++) { const x = i / 48; pts.push(`${px(x).toFixed(1)},${py(sampleAt(this.ys, x)).toFixed(1)}`); }
      this.curve.setAttribute('d', 'M' + pts.join(' L'));
      for (let i = 0; i < ANCHORS; i++) { this.handles[i].setAttribute('cx', px(i / (ANCHORS - 1))); this.handles[i].setAttribute('cy', py(this.ys[i])); }
    }
  }
  /* linear interpolation through a 0..255 table */
  function sampleLut(lut, x) {
    const pos = clamp01(x) * (lut.length - 1);
    const i = Math.min(lut.length - 2, Math.floor(pos));
    return (lut[i] + (lut[i + 1] - lut[i]) * (pos - i)) / 255;
  }
  window.GCCurve = { LUT_N, CurveEditor, sampleLut };
})();
