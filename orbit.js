/* Orbit UI — assignment editor concept demo
   Two primitives per axis: POINTS (define the CC response curve) and
   SPANS (bands of travel where the curve is inactive: dead / freeze /
   note-on). Live regions are the gaps between spans; each live region
   owns a MIDI channel + CC number. */

'use strict';

/* Bump on every feature addition; shown in the header and exports. */
const APP_VERSION = '1.4';

/* ── state ───────────────────────────────────────────────────────── */

const STORE_KEY = 'orbit_ui_state_v1';
let uidn = 1;
const uid = () => 's' + (uidn++) + '_' + Math.random().toString(36).slice(2, 7);

function defaultState() {
  return {
    program: { num: 1, name: 'INIT' },
    axes: {
      yaw: {
        key: 'yaw', label: 'YAW', sub: 'left → right',
        endLabels: ['LEFT', 'RIGHT'], freeze: 'PITCH',
        smooth: false, sim: 0.5,
        points: [
          { x: 0.08, y: 0 }, { x: 0.27, y: 70 }, { x: 0.46, y: 127 },
          { x: 0.54, y: 127 }, { x: 0.73, y: 70 }, { x: 0.92, y: 0 },
        ],
        spans: [
          { id: uid(), lo: 0.00, hi: 0.08, mode: 'dead', ch: 1, note: 60 },
          { id: uid(), lo: 0.46, hi: 0.54, mode: 'dead', ch: 1, note: 60 },
          { id: uid(), lo: 0.92, hi: 1.00, mode: 'dead', ch: 1, note: 60 },
        ],
        regions: [], baseCC: 11,
      },
      pitch: {
        key: 'pitch', label: 'PITCH', sub: 'heel → toe',
        endLabels: ['HEEL', 'TOE'], freeze: 'YAW',
        smooth: false, sim: 0.35,
        points: [{ x: 0.06, y: 0 }, { x: 0.5, y: 50 }, { x: 0.94, y: 127 }],
        spans: [
          { id: uid(), lo: 0.00, hi: 0.06, mode: 'dead', ch: 1, note: 60 },
          { id: uid(), lo: 0.94, hi: 1.00, mode: 'dead', ch: 1, note: 60 },
        ],
        regions: [], baseCC: 1,
      },
    },
    library: [],
    setlist: [],
    loadedId: null,
    globalCh: 16, /* receive channel for incoming MIDI (or 'omni') */
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.axes && s.axes.yaw && s.axes.pitch) {
        s.library = s.library || [];
        s.setlist = s.setlist || [];
        if (s.loadedId === undefined) s.loadedId = null;
        if (s.globalCh === undefined) s.globalCh = 16;
        return s;
      }
    }
  } catch (e) { /* fall through to defaults */ }
  return defaultState();
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ── live regions (gaps between spans) ───────────────────────────── */

const MIN_SPAN = 0.02;
const MIN_REGION = 0.01;

function sortedSpans(axis) {
  return [...axis.spans].sort((a, b) => a.lo - b.lo);
}

/* recompute live regions, carrying CH/CC settings over by best overlap */
function syncRegions(axis) {
  const old = axis.regions || [];
  const gaps = [];
  let t = 0;
  for (const s of sortedSpans(axis)) {
    if (s.lo > t + MIN_REGION) gaps.push({ lo: t, hi: s.lo });
    t = Math.max(t, s.hi);
  }
  if (t < 1 - MIN_REGION) gaps.push({ lo: t, hi: 1 });

  const used = new Set();
  let nextCC = axis.baseCC;
  const takenCC = old.map(r => r.cc);
  axis.regions = gaps.map(g => {
    let best = null, bestOv = 0;
    old.forEach((r, i) => {
      if (used.has(i)) return;
      const ov = Math.min(g.hi, r.hi) - Math.max(g.lo, r.lo);
      if (ov > bestOv) { bestOv = ov; best = i; }
    });
    if (best !== null) {
      used.add(best);
      return { lo: g.lo, hi: g.hi, ch: old[best].ch, cc: old[best].cc };
    }
    while (takenCC.includes(nextCC)) nextCC++;
    takenCC.push(nextCC);
    return { lo: g.lo, hi: g.hi, ch: 1, cc: nextCC };
  });
}

/* Linearly remap points whose x lies in a range's [oldLo,oldHi] to its
   [newLo,newHi] — used so live-zone curves stretch with a moving span
   boundary. Each point is classified once against its original x. */
function remapPoints(axis, ranges) {
  const eps = 1e-6;
  for (const p of axis.points) {
    for (const r of ranges) {
      if (r.oldHi - r.oldLo > eps && p.x >= r.oldLo - eps && p.x <= r.oldHi + eps) {
        const u = (p.x - r.oldLo) / (r.oldHi - r.oldLo);
        p.x = r.newLo + u * (r.newHi - r.newLo);
        break;
      }
    }
  }
}

/* live-zone boundaries adjacent to span s: nearest other span edge (or 0/1) */
function neighborBounds(axis, s) {
  const others = sortedSpans(axis).filter(x => x.id !== s.id);
  return {
    left: others.reduce((b, o) => (o.hi <= s.lo + 1e-9 && o.hi > b ? o.hi : b), 0),
    right: others.reduce((b, o) => (o.lo >= s.hi - 1e-9 && o.lo < b ? o.lo : b), 1),
  };
}

function regionAt(axis, t) {
  return axis.regions.find(r => t >= r.lo && t <= r.hi) || null;
}
function spanAt(axis, t) {
  return sortedSpans(axis).find(s => t >= s.lo && t <= s.hi) || null;
}

/* ── curve evaluation ────────────────────────────────────────────── */

function sortedPoints(axis) {
  return [...axis.points].sort((a, b) => a.x - b.x);
}

/* monotone cubic hermite tangents (Fritsch–Carlson) */
function monotoneTangents(pts) {
  const n = pts.length;
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = Math.max(pts[i + 1].x - pts[i].x, 1e-6);
    d.push((pts[i + 1].y - pts[i].y) / dx);
  }
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push(d[0]);
    else if (i === n - 1) m.push(d[n - 2]);
    else m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) { m[i] = 3 * d[i] * a / h; m[i + 1] = 3 * d[i] * b / h; }
  }
  return m;
}

function curveValue(axis, t) {
  const pts = sortedPoints(axis);
  if (!pts.length) return 0;
  if (t <= pts[0].x) return pts[0].y;
  if (t >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  while (i < pts.length - 2 && t > pts[i + 1].x) i++;
  const p0 = pts[i], p1 = pts[i + 1];
  const h = Math.max(p1.x - p0.x, 1e-6);
  const u = (t - p0.x) / h;
  if (!axis.smooth) return p0.y + (p1.y - p0.y) * u;
  const m = monotoneTangents(pts);
  const u2 = u * u, u3 = u2 * u;
  const y = (2 * u3 - 3 * u2 + 1) * p0.y + (u3 - 2 * u2 + u) * h * m[i]
          + (-2 * u3 + 3 * u2) * p1.y + (u3 - u2) * h * m[i + 1];
  return Math.max(0, Math.min(127, y));
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n) {
  n = Math.max(0, Math.min(127, Math.round(n)));
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}
const pct = t => (t * 100).toFixed(1) + '%';

/* ── geometry / rendering ────────────────────────────────────────── */

const GEO = { left: 40, right: 14, top: 30, bottom: 44, height: 240, simLane: 16 };
const editors = {}; // key -> {svg, wellDiv, outEl, smoothBtn}

function buildPanels() {
  const main = document.getElementById('axes');
  main.innerHTML = '';
  for (const key of ['yaw', 'pitch']) {
    const axis = state.axes[key];
    const panel = document.createElement('section');
    panel.className = 'axis-panel ambient amb-surface amb-chamfer amb-elevation-2 ambx-panel amb-mat-blasted amb-rounded-xl';
    panel.innerHTML = `
      <div class="axis-head">
        <div class="axis-title"><b>${axis.label}</b><small>${axis.sub}</small></div>
        <div class="axis-out"><span class="amb-led"></span><span data-out></span></div>
        <div class="axis-tools">
          <button class="ghostbtn ${axis.smooth ? 'on' : ''}" data-smooth type="button">smooth</button>
          <button class="ghostbtn" data-addspan type="button">+ span</button>
        </div>
      </div>
      <div class="editor-well"><svg data-axis="${key}"></svg></div>`;
    main.appendChild(panel);
    const svg = panel.querySelector('svg');
    editors[key] = {
      svg,
      outEl: panel.querySelector('[data-out]'),
      smoothBtn: panel.querySelector('[data-smooth]'),
    };
    panel.querySelector('[data-smooth]').addEventListener('click', () => {
      axis.smooth = !axis.smooth;
      editors[key].smoothBtn.classList.toggle('on', axis.smooth);
      commit(axis);
    });
    panel.querySelector('[data-addspan]').addEventListener('click', () => addSpan(axis));
    wireEditor(svg, axis);
  }
}

function axisGeom(axis) {
  const svg = editors[axis.key].svg;
  const w = svg.clientWidth || svg.parentElement.clientWidth || 800;
  const h = GEO.height;
  const x0 = GEO.left, x1 = w - GEO.right;
  const y0 = GEO.top, y1 = h - GEO.bottom;
  return {
    w, h, x0, x1, y0, y1,
    tx: t => x0 + t * (x1 - x0),
    ty: v => y1 - (v / 127) * (y1 - y0),
    it: px => Math.max(0, Math.min(1, (px - x0) / (x1 - x0))),
    iv: py => Math.max(0, Math.min(127, (1 - (py - y0) / (y1 - y0)) * 127)),
  };
}

function spanShortLabel(axis, s) {
  if (s.mode === 'dead') return 'DEAD';
  if (s.mode === 'freeze') return 'FRZ ' + axis.freeze;
  return '♪ ' + noteName(s.note) + ' ch' + s.ch;
}

function render(axis) {
  const ed = editors[axis.key];
  const g = axisGeom(axis);
  const parts = [];

  parts.push(`<defs>
    <filter id="glow-${axis.key}" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#6366f1" flood-opacity="0.75"/>
    </filter>
    <filter id="glow-sim-${axis.key}" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="hsl(16 100% 60%)" flood-opacity="0.8"/>
    </filter>
  </defs>`);

  /* value gridlines + labels */
  for (const v of [0, 64, 127]) {
    const y = g.ty(v);
    parts.push(`<line x1="${g.x0}" y1="${y}" x2="${g.x1}" y2="${y}" stroke="var(--well-line)" stroke-dasharray="2 5"/>`);
    parts.push(`<text x="${g.x0 - 8}" y="${y + 3}" font-size="9" text-anchor="end">${v}</text>`);
  }
  /* travel ticks */
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const x = g.tx(t);
    parts.push(`<line x1="${x}" y1="${g.y1}" x2="${x}" y2="${g.y1 + 4}" stroke="var(--well-line)"/>`);
    parts.push(`<text x="${x}" y="${g.y1 + 15}" font-size="8" text-anchor="middle">${Math.round(t * 100)}</text>`);
  }
  parts.push(`<text x="${g.x0}" y="${g.h - 6}" font-size="9" letter-spacing="2">${axis.endLabels[0]}</text>`);
  parts.push(`<text x="${g.x1}" y="${g.h - 6}" font-size="9" letter-spacing="2" text-anchor="end">${axis.endLabels[1]}</text>`);

  /* spans */
  for (const s of sortedSpans(axis)) {
    const xa = g.tx(s.lo), xb = g.tx(s.hi);
    parts.push(`<rect x="${xa}" y="${g.y0}" width="${xb - xa}" height="${g.y1 - g.y0}" fill="var(--span-fill)" data-role="span" data-id="${s.id}" style="cursor:grab"/>`);
    parts.push(`<line x1="${xa + 1.5}" y1="${g.y0 + 6}" x2="${xa + 1.5}" y2="${g.y1 - 6}" stroke="var(--span-edge)" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`);
    parts.push(`<line x1="${xb - 1.5}" y1="${g.y0 + 6}" x2="${xb - 1.5}" y2="${g.y1 - 6}" stroke="var(--span-edge)" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`);
    const cx = (xa + xb) / 2, cy = (g.y0 + g.y1) / 2;
    const wide = (xb - xa) > 54;
    const lbl = spanShortLabel(axis, s);
    parts.push(`<text x="${cx}" y="${cy}" font-size="8" text-anchor="middle" class="span-label" pointer-events="none" transform="${wide ? '' : `rotate(-90 ${cx} ${cy})`}">${lbl}</text>`);
    /* edge hit zones on top of body */
    parts.push(`<rect x="${xa - 8}" y="${g.y0}" width="16" height="${g.y1 - g.y0}" fill="transparent" data-role="edge" data-id="${s.id}" data-side="lo" style="cursor:ew-resize"/>`);
    parts.push(`<rect x="${xb - 8}" y="${g.y0}" width="16" height="${g.y1 - g.y0}" fill="transparent" data-role="edge" data-id="${s.id}" data-side="hi" style="cursor:ew-resize"/>`);
  }

  /* curve: dim base across full travel, bright overlay per live region */
  const samplePath = (lo, hi) => {
    const n = Math.max(2, Math.round((hi - lo) * 140));
    let dd = '';
    for (let i = 0; i <= n; i++) {
      const t = lo + (hi - lo) * (i / n);
      dd += (i ? 'L' : 'M') + g.tx(t).toFixed(1) + ' ' + g.ty(curveValue(axis, t)).toFixed(1);
    }
    return dd;
  };
  parts.push(`<path d="${samplePath(0, 1)}" fill="none" stroke="var(--trace-dim)" stroke-width="1.5" stroke-dasharray="3 4" pointer-events="none"/>`);
  for (const r of axis.regions) {
    parts.push(`<path d="${samplePath(r.lo, r.hi)}" fill="none" stroke="var(--trace)" stroke-width="2.5" stroke-linecap="round" filter="url(#glow-${axis.key})" pointer-events="none"/>`);
  }

  /* region chips */
  axis.regions.forEach((r, i) => {
    const cx = (g.tx(r.lo) + g.tx(r.hi)) / 2;
    const label = `CH${r.ch} · CC${r.cc}`;
    const wch = label.length * 6.4 + 16;
    parts.push(`<g data-role="region" data-idx="${i}" style="cursor:pointer">
      <rect x="${cx - wch / 2}" y="6" width="${wch}" height="17" rx="8.5" fill="var(--chip-fill)" stroke="var(--chip-line)"/>
      <text x="${cx}" y="18" font-size="8" text-anchor="middle" class="chip-label">${label}</text>
    </g>`);
  });

  /* points */
  const pts = sortedPoints(axis);
  pts.forEach(p => {
    const inSpan = !!spanAt(axis, p.x);
    const x = g.tx(p.x), y = g.ty(p.y);
    const idx = axis.points.indexOf(p);
    parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="var(--pt-fill)" stroke="var(--pt-stroke)" stroke-width="2" opacity="${inSpan ? 0.35 : 1}" filter="url(#glow-${axis.key})" pointer-events="none"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="17" fill="transparent" data-role="point" data-idx="${idx}" style="cursor:grab"/>`);
  });

  /* sim marker */
  const sx = g.tx(axis.sim);
  parts.push(`<line x1="${sx}" y1="${g.y0}" x2="${sx}" y2="${g.y1 + 8}" stroke="var(--sim)" stroke-width="1" opacity="0.65" pointer-events="none"/>`);
  const live = !spanAt(axis, axis.sim);
  if (live) {
    const sy = g.ty(curveValue(axis, axis.sim));
    parts.push(`<circle cx="${sx}" cy="${sy}" r="3.5" fill="var(--sim)" filter="url(#glow-sim-${axis.key})" pointer-events="none"/>`);
  }
  parts.push(`<path d="M${sx - 7} ${g.y1 + 20} L${sx + 7} ${g.y1 + 20} L${sx} ${g.y1 + 9} Z" fill="var(--sim)" filter="url(#glow-sim-${axis.key})" data-role="sim" style="cursor:ew-resize"/>`);
  parts.push(`<rect x="${sx - 16}" y="${g.y1 + 2}" width="32" height="${GEO.bottom - 4}" fill="transparent" data-role="sim" style="cursor:ew-resize"/>`);

  ed.svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
  ed.svg.setAttribute('width', g.w);
  ed.svg.setAttribute('height', g.h);
  ed.svg.innerHTML = parts.join('');

  /* output readout */
  const s = spanAt(axis, axis.sim);
  if (!s) {
    const r = regionAt(axis, axis.sim);
    const v = Math.round(curveValue(axis, axis.sim));
    ed.outEl.textContent = r ? `CH${r.ch} CC${r.cc} → ${v}` : `→ ${v}`;
  } else if (s.mode === 'dead') ed.outEl.textContent = 'DEAD';
  else if (s.mode === 'freeze') ed.outEl.textContent = `FREEZE ${axis.freeze}`;
  else ed.outEl.textContent = `NOTE ${noteName(s.note)} CH${s.ch}`;
}

function commit(axis) {
  syncRegions(axis);
  render(axis);
  saveState();
}

/* ── interactions ────────────────────────────────────────────────── */

function wireEditor(svg, axis) {
  let drag = null;
  let lastTap = { time: 0, x: 0, y: 0 };

  const evPos = e => {
    const rect = svg.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  svg.addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-role]');
    const { px, py } = evPos(e);
    drag = {
      role: el ? el.dataset.role : 'bg',
      id: el ? el.dataset.id : null,
      idx: el ? +el.dataset.idx : -1,
      side: el ? el.dataset.side : null,
      startPx: px, startPy: py, moved: false,
      clientX: e.clientX, clientY: e.clientY,
      pointerType: e.pointerType,
    };
    if (drag.role === 'span') {
      const s = axis.spans.find(x => x.id === drag.id);
      drag.spanLo = s.lo; drag.spanHi = s.hi;
    }
    svg.setPointerCapture(e.pointerId);
    if (drag.role !== 'bg') e.preventDefault();
  });

  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const { px, py } = evPos(e);
    if (Math.hypot(px - drag.startPx, py - drag.startPy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const g = axisGeom(axis);
    const t = g.it(px);

    if (drag.role === 'point') {
      const p = axis.points[drag.idx];
      if (p) { p.x = t; p.y = Math.round(g.iv(py)); commit(axis); }
    } else if (drag.role === 'edge') {
      const s = axis.spans.find(x => x.id === drag.id);
      if (s) {
        const others = sortedSpans(axis).filter(x => x.id !== s.id);
        const nb = neighborBounds(axis, s);
        if (drag.side === 'lo') {
          let lo = Math.min(t, s.hi - MIN_SPAN);
          for (const o of others) if (o.hi <= s.hi && o.hi > lo) lo = o.hi;
          lo = Math.max(0, lo);
          remapPoints(axis, [{ oldLo: nb.left, oldHi: s.lo, newLo: nb.left, newHi: lo }]);
          s.lo = lo;
        } else {
          let hi = Math.max(t, s.lo + MIN_SPAN);
          for (const o of others) if (o.lo >= s.lo && o.lo < hi) hi = o.lo;
          hi = Math.min(1, hi);
          remapPoints(axis, [{ oldLo: s.hi, oldHi: nb.right, newLo: hi, newHi: nb.right }]);
          s.hi = hi;
        }
        commit(axis);
      }
    } else if (drag.role === 'span') {
      const s = axis.spans.find(x => x.id === drag.id);
      if (s) {
        const wSpan = drag.spanHi - drag.spanLo;
        let lo = drag.spanLo + (t - g.it(drag.startPx));
        let hi = lo + wSpan;
        for (const o of sortedSpans(axis)) {
          if (o.id === s.id) continue;
          if (o.hi <= drag.spanLo + 1e-9 && lo < o.hi) { lo = o.hi; hi = lo + wSpan; }
          if (o.lo >= drag.spanHi - 1e-9 && hi > o.lo) { hi = o.lo; lo = hi - wSpan; }
        }
        if (lo < 0) { lo = 0; hi = wSpan; }
        if (hi > 1) { hi = 1; lo = 1 - wSpan; }
        const nb = neighborBounds(axis, s);
        remapPoints(axis, [
          { oldLo: nb.left, oldHi: s.lo, newLo: nb.left, newHi: lo },
          { oldLo: s.hi, oldHi: nb.right, newLo: hi, newHi: nb.right },
        ]);
        s.lo = lo; s.hi = hi;
        commit(axis);
      }
    } else if (drag.role === 'sim') {
      axis.sim = t;
      render(axis);
    }
  });

  svg.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.role === 'sim') saveState();
    if (d.moved) { if (d.role !== 'sim') saveState(); return; }

    /* tap (no drag) */
    const { px, py } = evPos(e);
    if (d.role === 'point') { openPointPopover(axis, d.idx, e.clientX, e.clientY); return; }
    if (d.role === 'span' || d.role === 'edge') {
      const s = axis.spans.find(x => x.id === d.id);
      if (s) openSpanPopover(axis, s, e.clientX, e.clientY);
      return;
    }
    if (d.role === 'region') { openRegionPopover(axis, d.idx, e.clientX, e.clientY); return; }

    /* background tap: double-tap adds a point (touch path) */
    const now = Date.now();
    if (d.pointerType !== 'mouse'
        && now - lastTap.time < 350
        && Math.hypot(px - lastTap.x, py - lastTap.y) < 30) {
      addPointAt(axis, px, py);
      lastTap = { time: 0, x: 0, y: 0 };
    } else {
      lastTap = { time: now, x: px, y: py };
    }
  });

  svg.addEventListener('dblclick', e => {
    const el = e.target.closest('[data-role]');
    const role = el ? el.dataset.role : 'bg';
    if (role !== 'bg') return; /* only add points in open live areas */
    const { px, py } = evPos(e);
    addPointAt(axis, px, py);
  });
}

function addPointAt(axis, px, py) {
  const g = axisGeom(axis);
  if (py < g.y0 - 6 || py > g.y1 + 6) return;
  const t = g.it(px);
  axis.points.push({ x: t, y: Math.round(g.iv(py)) });
  commit(axis);
}

function addSpan(axis) {
  /* drop the new span in the middle of the widest live gap */
  syncRegions(axis);
  let best = null;
  for (const r of axis.regions) {
    if (!best || (r.hi - r.lo) > (best.hi - best.lo)) best = r;
  }
  if (!best || best.hi - best.lo < MIN_SPAN * 3) return;
  const wSpan = Math.min(0.1, (best.hi - best.lo) * 0.34);
  const mid = (best.lo + best.hi) / 2;
  axis.spans.push({ id: uid(), lo: mid - wSpan / 2, hi: mid + wSpan / 2, mode: 'dead', ch: 1, note: 60 });
  commit(axis);
}

/* ── popover ─────────────────────────────────────────────────────── */

const pop = document.getElementById('popover');
let popCleanup = null;

function openPopover(html, cx, cy) {
  pop.innerHTML = html;
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  let x = cx + 12, y = cy + 12 + window.scrollY;
  if (x + r.width > window.innerWidth - 10) x = Math.max(10, cx - r.width - 12);
  const maxY = window.scrollY + window.innerHeight - r.height - 10;
  if (y > maxY) y = Math.max(window.scrollY + 10, maxY);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';

  const onDown = e => { if (!pop.contains(e.target)) closePopover(); };
  const onKey = e => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
  }, 0);
  popCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
  };
}
function closePopover() {
  pop.hidden = true;
  pop.innerHTML = '';
  if (popCleanup) { popCleanup(); popCleanup = null; }
}

function numRow(label, id, val, min, max) {
  return `<div class="pop-row"><label>${label}</label>
    <input id="${id}" type="number" inputmode="numeric" value="${val}" min="${min}" max="${max}"></div>`;
}

function openPointPopover(axis, idx, cx, cy) {
  const p = axis.points[idx];
  if (!p) return;
  const region = regionAt(axis, p.x);
  openPopover(`
    <h3><span class="amb-led"></span>Point</h3>
    <div class="pop-rows">
      ${numRow('Travel %', 'ppx', (p.x * 100).toFixed(1), 0, 100)}
      ${numRow('Value', 'ppy', Math.round(p.y), 0, 127)}
      <hr class="pop-sep">
      ${region
        ? `${numRow('MIDI Chan', 'pch', region.ch, 1, 16)}${numRow('CC #', 'pcc', region.cc, 0, 127)}`
        : `<div class="pop-note">point sits inside a span<br>(curve inactive here)</div>`}
      <button class="dangerbtn" id="pdel" type="button">delete point</button>
    </div>`, cx, cy);

  const wire = (id, fn) => {
    const el = pop.querySelector('#' + id);
    if (el) el.addEventListener('input', () => { fn(parseFloat(el.value)); commit(axis); });
  };
  wire('ppx', v => { if (!isNaN(v)) p.x = Math.max(0, Math.min(1, v / 100)); });
  wire('ppy', v => { if (!isNaN(v)) p.y = Math.max(0, Math.min(127, Math.round(v))); });
  wire('pch', v => { if (region && !isNaN(v)) region.ch = clampi(v, 1, 16); });
  wire('pcc', v => { if (region && !isNaN(v)) region.cc = clampi(v, 0, 127); });
  pop.querySelector('#pdel').addEventListener('click', () => {
    axis.points.splice(idx, 1);
    closePopover();
    commit(axis);
  });
}

function openSpanPopover(axis, s, cx, cy) {
  const modes = [
    { id: 'dead', label: 'Dead' },
    { id: 'freeze', label: `Freeze ${axis.freeze} value` },
    { id: 'note', label: 'Send MIDI note' },
  ];
  const noteRows = s.mode === 'note'
    ? `${numRow('MIDI Chan', 'sch', s.ch, 1, 16)}
       ${numRow('Note #', 'snote', s.note, 0, 127)}
       <div class="pop-row"><label>Note</label><span class="pop-note" id="snName">${noteName(s.note)}</span></div>`
    : '';
  openPopover(`
    <h3><span class="amb-led"></span>Span &nbsp;<span class="pop-note">${pct(s.lo)} – ${pct(s.hi)}</span></h3>
    <div class="pop-rows">
      <div class="mode-list">
        ${modes.map(m => `<button class="mode-btn ${s.mode === m.id ? 'on' : ''}" data-mode="${m.id}" type="button"><span class="dot"></span>${m.label}</button>`).join('')}
      </div>
      ${noteRows}
      <button class="dangerbtn" id="sdel" type="button">delete span</button>
    </div>`, cx, cy);

  pop.querySelectorAll('.mode-btn').forEach(b => {
    b.addEventListener('click', () => {
      s.mode = b.dataset.mode;
      commit(axis);
      closePopover();
      openSpanPopover(axis, s, cx, cy); /* refresh contents */
    });
  });
  const sch = pop.querySelector('#sch');
  if (sch) sch.addEventListener('input', () => { s.ch = clampi(parseFloat(sch.value), 1, 16); commit(axis); });
  const snote = pop.querySelector('#snote');
  if (snote) snote.addEventListener('input', () => {
    s.note = clampi(parseFloat(snote.value), 0, 127);
    const nm = pop.querySelector('#snName');
    if (nm) nm.textContent = noteName(s.note);
    commit(axis);
  });
  pop.querySelector('#sdel').addEventListener('click', () => {
    axis.spans = axis.spans.filter(x => x.id !== s.id);
    closePopover();
    commit(axis);
  });
}

function openRegionPopover(axis, idx, cx, cy) {
  const r = axis.regions[idx];
  if (!r) return;
  openPopover(`
    <h3><span class="amb-led"></span>Live zone &nbsp;<span class="pop-note">${pct(r.lo)} – ${pct(r.hi)}</span></h3>
    <div class="pop-rows">
      ${numRow('MIDI Chan', 'rch', r.ch, 1, 16)}
      ${numRow('CC #', 'rcc', r.cc, 0, 127)}
      <div class="pop-note">sends CC on this channel while the pedal travels this zone</div>
    </div>`, cx, cy);
  const rch = pop.querySelector('#rch');
  rch.addEventListener('input', () => { r.ch = clampi(parseFloat(rch.value), 1, 16); commit(axis); });
  const rcc = pop.querySelector('#rcc');
  rcc.addEventListener('input', () => { r.cc = clampi(parseFloat(rcc.value), 0, 127); commit(axis); });
}

function clampi(v, lo, hi) {
  if (isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/* ── librarian: program library + drag-ordered setlist ───────────── */

const libListEl = document.getElementById('libList');
const setListEl = document.getElementById('setList');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function libEntry(id) { return state.library.find(x => x.id === id) || null; }

/* the loaded program's 1-based setlist position (its PC number), or null */
function loadedPC() {
  const i = state.setlist.indexOf(state.loadedId);
  return i >= 0 ? i + 1 : null;
}
const snapshotAxes = () => JSON.parse(JSON.stringify(state.axes));

function saveProgram(asNew) {
  const name = (state.program.name || 'UNTITLED').toUpperCase().slice(0, 10);
  let entry = !asNew && state.loadedId ? libEntry(state.loadedId) : null;
  if (entry) {
    entry.name = name;
    entry.axes = snapshotAxes();
  } else {
    entry = { id: uid(), name, axes: snapshotAxes() };
    state.library.push(entry);
    state.loadedId = entry.id;
  }
  saveState();
  renderLibrarian();
}

function loadProgram(id) {
  const entry = libEntry(id);
  if (!entry) return;
  state.axes = JSON.parse(JSON.stringify(entry.axes));
  state.program.name = entry.name;
  state.loadedId = id;
  progName.value = entry.name;
  buildPanels();
  for (const key of ['yaw', 'pitch']) commit(state.axes[key]);
  renderLibrarian();
}

function renderLibrarian() {
  libListEl.innerHTML = state.library.length
    ? state.library.map(en => `
      <li class="lib-row${en.id === state.loadedId ? ' on' : ''}" data-id="${en.id}">
        <span class="grip" title="drag into setlist">⠿</span>
        <span class="lib-name">${esc(en.name)}</span>
        <button class="rowbtn" data-add type="button" title="append to setlist">+</button>
        <button class="rowbtn" data-del type="button" title="delete (tap twice)">×</button>
      </li>`).join('')
    : '<li class="lib-empty">empty — SAVE stores the current program</li>';
  setListEl.innerHTML = state.setlist.length
    ? state.setlist.map((id, i) => {
      const en = libEntry(id);
      return `
      <li class="set-row${id === state.loadedId ? ' on' : ''}" data-idx="${i}">
        <span class="pc">${i + 1}</span>
        <span class="lib-name">${en ? esc(en.name) : '?'}</span>
        <span class="grip" title="drag to reorder">⠿</span>
        <button class="rowbtn" data-del type="button" title="remove">×</button>
      </li>`;
    }).join('')
    : '<li class="lib-empty">drag programs here — order sets the PC #</li>';
  progNum.value = loadedPC() ?? '—';
}

/* two-tap delete: first tap arms the button, second within 2.5s fires */
function armDelete(target, fn) {
  const btn = target.closest('button');
  if (btn.dataset.armed) { fn(); return; }
  btn.dataset.armed = '1';
  btn.textContent = '✓';
  setTimeout(() => {
    if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '×'; }
  }, 2500);
}

libListEl.addEventListener('click', e => {
  const row = e.target.closest('.lib-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('[data-del]')) {
    armDelete(e.target, () => {
      state.library = state.library.filter(x => x.id !== id);
      state.setlist = state.setlist.filter(x => x !== id);
      if (state.loadedId === id) state.loadedId = null;
      saveState();
      renderLibrarian();
    });
    return;
  }
  if (e.target.closest('[data-add]')) {
    state.setlist.push(id);
    saveState();
    renderLibrarian();
    return;
  }
  if (e.target.closest('.grip')) return;
  loadProgram(id);
});

setListEl.addEventListener('click', e => {
  const row = e.target.closest('.set-row');
  if (!row) return;
  const idx = +row.dataset.idx;
  if (e.target.closest('[data-del]')) {
    state.setlist.splice(idx, 1);
    saveState();
    renderLibrarian();
    return;
  }
  if (e.target.closest('.grip')) return;
  loadProgram(state.setlist[idx]);
});

/* pointer-based row drag — grab anywhere on a bar (buttons excluded).
   A ~6px movement threshold separates a drag from a tap-to-load.
   library → setlist inserts · setlist ↕ reorders · setlist → library removes. */
let swallowClick = false;
document.addEventListener('click', e => {
  if (swallowClick) {
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

function wireRowDrag(listEl, kind) {
  listEl.addEventListener('pointerdown', e => {
    if (e.button) return;
    if (e.target.closest('button')) return;
    const row = e.target.closest(kind === 'lib' ? '.lib-row' : '.set-row');
    if (!row) return;

    const startX = e.clientX, startY = e.clientY;
    const r = row.getBoundingClientRect();
    const id = row.dataset.id;
    const oldIdx = row.dataset.idx != null ? +row.dataset.idx : -1;
    let ghost = null, ph = null, active = false, overLib = false, dropIdx = 0;

    const place = ev => {
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY - r.height / 2}px)`;
      const lrect = libListEl.getBoundingClientRect();
      overLib = kind === 'set'
             && ev.clientX > lrect.left && ev.clientX < lrect.right
             && ev.clientY > lrect.top && ev.clientY < lrect.bottom;
      libListEl.classList.toggle('drop-remove', overLib);
      const rect = setListEl.getBoundingClientRect();
      const inSet = ev.clientX > rect.left - 24 && ev.clientX < rect.right + 24
                 && ev.clientY > rect.top - 12 && ev.clientY < rect.bottom + 24;
      if (!inSet || overLib) {
        active = false;
        if (ph.parentNode) ph.remove();
        return;
      }
      const rows = [...setListEl.querySelectorAll('.set-row:not(.dragging)')];
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i].getBoundingClientRect();
        if (ev.clientY < m.top + m.height / 2) { idx = i; break; }
      }
      active = true;
      dropIdx = idx;
      if (idx < rows.length) setListEl.insertBefore(ph, rows[idx]);
      else setListEl.appendChild(ph);
    };

    const move = ev => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        ghost = row.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = r.width + 'px';
        document.body.appendChild(ghost);
        ph = document.createElement('li');
        ph.className = 'set-drop';
        if (kind === 'set') row.classList.add('dragging');
      }
      place(ev);
    };

    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!ghost) return; /* never crossed the threshold: it's a tap */
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
      ghost.remove();
      if (ph.parentNode) ph.remove();
      libListEl.classList.remove('drop-remove');
      if (active) {
        if (kind === 'lib') {
          state.setlist.splice(dropIdx, 0, id);
        } else {
          const [moved] = state.setlist.splice(oldIdx, 1);
          state.setlist.splice(dropIdx, 0, moved);
        }
        saveState();
      } else if (overLib) {
        state.setlist.splice(oldIdx, 1);
        saveState();
      }
      renderLibrarian(); /* also clears .dragging */
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
wireRowDrag(libListEl, 'lib');
wireRowDrag(setListEl, 'set');

document.getElementById('saveBtn').addEventListener('click', () => saveProgram(false));
document.getElementById('saveNewBtn').addEventListener('click', () => saveProgram(true));

/* ── MIDI receive: global channel + program change → setlist slot ── */

const globalChSel = document.getElementById('globalCh');
globalChSel.innerHTML = '<option value="omni">OMNI</option>'
  + Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
globalChSel.value = String(state.globalCh);
globalChSel.addEventListener('change', () => {
  state.globalCh = globalChSel.value === 'omni' ? 'omni' : +globalChSel.value;
  saveState();
});

/* the device rule: a PC on the global channel selects that setlist slot */
function receiveProgramChange(ch, pc) {
  const gch = state.globalCh;
  if (gch !== 'omni' && ch !== gch) {
    return { ok: false, msg: `PC ${pc} ch${ch} — ignored (global ch ${gch})` };
  }
  const id = state.setlist[pc - 1];
  if (!id || !libEntry(id)) {
    return { ok: false, msg: `PC ${pc} ch${ch} — no setlist slot ${pc}` };
  }
  loadProgram(id);
  const row = setListEl.querySelector(`.set-row[data-idx="${pc - 1}"]`);
  if (row) {
    row.classList.add('rx');
    row.addEventListener('animationend', () => row.classList.remove('rx'), { once: true });
  }
  return { ok: true, msg: `PC ${pc} ch${ch} → loaded ${pc}·"${libEntry(id).name}"` };
}

const miCh = document.getElementById('miCh');
miCh.innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
miCh.value = '16';
const miLog = document.getElementById('miLog');
document.getElementById('miSend').addEventListener('click', () => {
  const pc = clampi(parseFloat(document.getElementById('miPc').value), 1, 128);
  const res = receiveProgramChange(+miCh.value, pc);
  miLog.textContent = res.msg;
  miLog.classList.toggle('ok', res.ok);
});

/* ── publish ─────────────────────────────────────────────────────── */

function exportText() {
  const p = state.program;
  const lines = [];
  const rule = '─'.repeat(52);
  const pc = loadedPC();
  lines.push(`ORBIT PROGRAM ${pc ? String(pc).padStart(3, '0') : '---'} · "${p.name}"`);
  lines.push(`orbit ui v${APP_VERSION} · exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push(`global channel: ${state.globalCh === 'omni' ? 'OMNI' : 'CH ' + state.globalCh}  (receives program changes → setlist)`);
  lines.push('');
  for (const key of ['yaw', 'pitch']) {
    const a = state.axes[key];
    lines.push(`${a.label}  (${a.endLabels[0]} → ${a.endLabels[1]})   curve: ${a.smooth ? 'smooth' : 'linear'}`);
    lines.push(rule);
    /* interleave spans and regions in travel order */
    const segs = [
      ...sortedSpans(a).map(s => ({ lo: s.lo, hi: s.hi, span: s })),
      ...a.regions.map(r => ({ lo: r.lo, hi: r.hi, region: r })),
    ].sort((x, y) => x.lo - y.lo);
    for (const seg of segs) {
      const range = `${pct(seg.lo).padStart(6)} – ${pct(seg.hi).padStart(6)}`;
      if (seg.span) {
        const s = seg.span;
        let detail = 'dead';
        if (s.mode === 'freeze') detail = `freeze ${a.freeze} value`;
        if (s.mode === 'note') detail = `note on · CH ${s.ch} · #${s.note} (${noteName(s.note)})`;
        lines.push(`  [${range}]  SPAN   ${detail}`);
      } else {
        const r = seg.region;
        lines.push(`  (${range})  LIVE   CH ${r.ch} · CC ${r.cc}`);
        const pts = sortedPoints(a).filter(pt => pt.x >= seg.lo - 1e-6 && pt.x <= seg.hi + 1e-6);
        if (pts.length) {
          lines.push(`${' '.repeat(21)}curve  ${pts.map(pt => `${pct(pt.x)}→${Math.round(pt.y)}`).join(',  ')}`);
        }
      }
    }
    lines.push('');
  }
  if (state.setlist.length) {
    lines.push('SETLIST  (1:1 program change map)');
    lines.push(rule);
    state.setlist.forEach((id, i) => {
      const en = libEntry(id);
      lines.push(`  PC ${String(i + 1).padStart(3)}  →  "${en ? en.name : '?'}"`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function exportJSON() {
  const out = {
    version: APP_VERSION,
    globalChannel: state.globalCh,
    program: { num: loadedPC(), name: state.program.name },
    setlist: state.setlist.map((id, i) => {
      const en = libEntry(id);
      return { pc: i + 1, name: en ? en.name : '?' };
    }),
    axes: {},
  };
  for (const key of ['yaw', 'pitch']) {
    const a = state.axes[key];
    out.axes[key] = {
      curveMode: a.smooth ? 'smooth' : 'linear',
      points: sortedPoints(a).map(p => ({ travel: +(p.x.toFixed(4)), value: Math.round(p.y) })),
      spans: sortedSpans(a).map(s => ({
        lo: +(s.lo.toFixed(4)), hi: +(s.hi.toFixed(4)), mode: s.mode,
        ...(s.mode === 'note' ? { channel: s.ch, note: s.note } : {}),
      })),
      liveZones: a.regions.map(r => ({
        lo: +(r.lo.toFixed(4)), hi: +(r.hi.toFixed(4)), channel: r.ch, cc: r.cc,
      })),
    };
  }
  return JSON.stringify(out, null, 2);
}

const modalWrap = document.getElementById('modalWrap');
const modalPre = document.getElementById('modalPre');
let modalFmt = 'text';

function showModal() {
  modalFmt = 'text';
  document.querySelectorAll('.modal-tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.fmt === 'text'));
  modalPre.textContent = exportText();
  modalWrap.hidden = false;
}
document.getElementById('publishBtn').addEventListener('click', showModal);
document.getElementById('closeBtn').addEventListener('click', () => { modalWrap.hidden = true; });
document.getElementById('modalScrim').addEventListener('click', () => { modalWrap.hidden = true; });
document.querySelectorAll('.modal-tabs .tab').forEach(b => {
  b.addEventListener('click', () => {
    modalFmt = b.dataset.fmt;
    document.querySelectorAll('.modal-tabs .tab').forEach(x => x.classList.toggle('on', x === b));
    modalPre.textContent = modalFmt === 'json' ? exportJSON() : exportText();
  });
});
document.getElementById('copyBtn').addEventListener('click', async () => {
  const txt = modalPre.textContent;
  try {
    await navigator.clipboard.writeText(txt);
  } catch (e) {
    const range = document.createRange();
    range.selectNodeContents(modalPre);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  const cap = document.querySelector('#copyBtn .amb-button-cap');
  const old = cap.textContent;
  cap.textContent = 'Copied';
  setTimeout(() => { cap.textContent = old; }, 900);
});

/* ── program fields / reset / boot ───────────────────────────────── */

const progNum = document.getElementById('progNum');
const progName = document.getElementById('progName');
progName.value = state.program.name;
progName.addEventListener('input', () => { state.program.name = progName.value.toUpperCase().slice(0, 10); saveState(); });

document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset the demo? This also clears the library and setlist.')) return;
  state = defaultState();
  progName.value = state.program.name;
  buildPanels();
  for (const key of ['yaw', 'pitch']) commit(state.axes[key]);
  renderLibrarian();
});

document.getElementById('appVersion').textContent = 'v' + APP_VERSION;

buildPanels();
for (const key of ['yaw', 'pitch']) commit(state.axes[key]);
renderLibrarian();

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const key of ['yaw', 'pitch']) render(state.axes[key]);
  }, 80);
});
