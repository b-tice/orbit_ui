/* Orbit UI — Setup editor concept demo
   v1.8 model: each axis is a span of travel (0–100%) holding ZONES.
   Every zone has a type — Controller / Note / Switch / Freeze / Dead —
   a travel range [lo,hi], and a color. Zones may OVERLAP: a second CC on
   the same sweep is simply a second Controller zone laid over the first.
   Controller zones own their transmit channel, CC number and their own
   response curve (points; the first/last points are the zone's end points).
   Dead zones are a MASK: they silence any Controller zone they overlap.
   Travel with no zone at all is dead too. */

'use strict';

/* Bump on every feature addition; shown in the header and exports. */
const APP_VERSION = '1.8';

/* ── constants ───────────────────────────────────────────────────── */

const STORE_KEY = 'orbit_ui_state_v1';
let uidn = 1;
const uid = () => 'z' + (uidn++) + '_' + Math.random().toString(36).slice(2, 7);

const MIN_ZONE = 0.02;          /* narrowest zone, as a fraction of travel */
const DEFAULT_SWITCH_SPEED = 250; /* % of travel per second */

const ZONE_TYPES = [
  { id: 'ctl',    icon: '🎚', label: 'Controller' },
  { id: 'note',   icon: '🎵', label: 'Note' },
  { id: 'switch', icon: '⚡', label: 'Switch' },
  { id: 'freeze', icon: '❄️', label: 'Freeze' },
  { id: 'dead',   icon: '🪦', label: 'Dead' },
];
const zoneType = id => ZONE_TYPES.find(t => t.id === id) || ZONE_TYPES[0];

/* zone colors — indigo and magenta first (the v1.5 layer colors) */
const PALETTE = [
  { name: 'indigo',  c: '#818cf8', pt: '#e0e7ff' },
  { name: 'magenta', c: '#e879f9', pt: '#fae8ff' },
  { name: 'cyan',    c: '#22d3ee', pt: '#cffafe' },
  { name: 'amber',   c: '#fbbf24', pt: '#fef3c7' },
  { name: 'green',   c: '#4ade80', pt: '#dcfce7' },
  { name: 'coral',   c: '#fb7185', pt: '#ffe4e6' },
  { name: 'violet',  c: '#a78bfa', pt: '#ede9fe' },
  { name: 'teal',    c: '#2dd4bf', pt: '#ccfbf1' },
];
const colorOf = z => PALETTE[(z.color || 0) % PALETTE.length];

/* ── zone factory ────────────────────────────────────────────────── */

/* Every zone carries the fields of every type, so switching a zone's type
   back and forth never loses what the user typed. */
function mkZone(type, lo, hi, extra) {
  return Object.assign({
    id: uid(), type, lo, hi, color: 0,
    /* controller */
    ch: 1, cc: 1, smooth: false,
    points: [{ x: lo, y: 0 }, { x: hi, y: 127 }],
    /* note + switch */
    note: 60, vel: 100,
    /* switch */
    action: 'note', onVal: 127, offVal: 0, speed: DEFAULT_SWITCH_SPEED,
  }, extra || {});
}

/* the least-used palette color among this axis's colored (non-dead) zones */
function nextColor(axis) {
  const counts = PALETTE.map(() => 0);
  for (const z of axis.zones) if (z.type !== 'dead') counts[(z.color || 0) % PALETTE.length]++;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

/* David's defaults: Yaw = Dead · CTL · Dead · CTL · Dead (bipolar Mid=Hi),
   Pitch = Dead · CTL · Dead. */
function defaultZones(key) {
  if (key === 'yaw') return [
    mkZone('dead', 0.00, 0.08),
    mkZone('ctl', 0.08, 0.46, { color: 0, ch: 1, cc: 11,
      points: [{ x: 0.08, y: 0 }, { x: 0.27, y: 70 }, { x: 0.46, y: 127 }] }),
    mkZone('dead', 0.46, 0.54),
    mkZone('ctl', 0.54, 0.92, { color: 1, ch: 1, cc: 11,
      points: [{ x: 0.54, y: 127 }, { x: 0.73, y: 70 }, { x: 0.92, y: 0 }] }),
    mkZone('dead', 0.92, 1.00),
  ];
  return [
    mkZone('dead', 0.00, 0.06),
    mkZone('ctl', 0.06, 0.94, { color: 0, ch: 1, cc: 1,
      points: [{ x: 0.06, y: 0 }, { x: 0.5, y: 50 }, { x: 0.94, y: 127 }] }),
    mkZone('dead', 0.94, 1.00),
  ];
}

function defaultState() {
  return {
    program: { num: 1, name: 'INIT' },
    axes: {
      yaw: {
        key: 'yaw', label: 'YAW', sub: 'left → right',
        endLabels: ['LEFT', 'RIGHT'], freeze: 'PITCH',
        sim: 0.5, zones: defaultZones('yaw'),
      },
      pitch: {
        key: 'pitch', label: 'PITCH', sub: 'heel → toe',
        endLabels: ['HEEL', 'TOE'], freeze: 'YAW',
        sim: 0.35, zones: defaultZones('pitch'),
      },
    },
    library: [],
    setlist: [],
    loadedId: null,
    globalCh: 16, /* receive channel for incoming MIDI (or 'omni') */
  };
}

/* ── migration: layers (v1.5–v1.7) and pre-v1.5 axes → zones ─────── */

/* gaps between a legacy layer's spans (the old "live regions") */
function legacyRegions(ly) {
  if (ly.regions && ly.regions.length) return ly.regions;
  const gaps = [];
  let t = 0, cc = ly.baseCC || 1;
  for (const s of [...(ly.spans || [])].sort((a, b) => a.lo - b.lo)) {
    if (s.lo > t + 0.01) gaps.push({ lo: t, hi: s.lo, ch: ly.defCh || 1, cc: cc++ });
    t = Math.max(t, s.hi);
  }
  if (t < 0.99) gaps.push({ lo: t, hi: 1, ch: ly.defCh || 1, cc });
  return gaps;
}

function layerToZones(ly, color) {
  const zones = [];
  for (const r of legacyRegions(ly)) {
    const inside = [...(ly.points || [])]
      .filter(p => p.x >= r.lo - 1e-6 && p.x <= r.hi + 1e-6)
      .sort((a, b) => a.x - b.x);
    const pts = inside.map(p => ({ x: p.x, y: p.y }));
    const probe = { points: ly.points || [], smooth: !!ly.smooth };
    if (!pts.length || pts[0].x > r.lo + 1e-6) pts.unshift({ x: r.lo, y: Math.round(curveValue(probe, r.lo)) });
    if (pts[pts.length - 1].x < r.hi - 1e-6) pts.push({ x: r.hi, y: Math.round(curveValue(probe, r.hi)) });
    pts[0].x = r.lo; pts[pts.length - 1].x = r.hi;
    zones.push(mkZone('ctl', r.lo, r.hi, { color, ch: r.ch || 1, cc: r.cc || 1, smooth: !!ly.smooth, points: pts }));
  }
  for (const s of ly.spans || []) {
    zones.push(mkZone(s.mode === 'freeze' ? 'freeze' : s.mode === 'note' ? 'note' : 'dead',
      s.lo, s.hi, { color, ch: s.ch || 1, note: s.note ?? 60 }));
  }
  return zones;
}

/* in place: give every axis a zones[] (idempotent) */
function migrateAxes(axes, layerOn) {
  for (const key of ['yaw', 'pitch']) {
    const a = axes[key];
    if (a.zones) continue;
    let zones = [];
    if (a.layers) {
      a.layers.forEach((ly, li) => {
        if (li > 0 && layerOn && !layerOn[li]) return; /* an OFF layer is dropped */
        zones = zones.concat(layerToZones(ly, li % PALETTE.length));
      });
    } else if (a.points || a.spans) {
      zones = layerToZones({ points: a.points, spans: a.spans, regions: a.regions, smooth: a.smooth, baseCC: a.baseCC }, 0);
    } else {
      zones = defaultZones(key);
    }
    a.zones = zones;
    delete a.layers; delete a.points; delete a.spans; delete a.regions; delete a.smooth; delete a.baseCC;
  }
  return axes;
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
        migrateAxes(s.axes, s.layerOn);
        for (const en of s.library) if (en.axes) migrateAxes(en.axes, en.layerOn);
        delete s.activeLayer; delete s.layerOn;
        return s;
      }
    }
  } catch (e) { /* fall through to defaults */ }
  return defaultState();
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ── zone queries ────────────────────────────────────────────────── */

const width = z => z.hi - z.lo;
/* Draw order (bottom → top): Controller zones always sit underneath every
   other zone type; within a type, widest first — so the narrowest ends up
   on top and wins the tap. A Controller hidden under another is always
   reachable through its CH·CC chip. */
const rank = z => (z.type === 'ctl' ? 0 : 1);
const drawOrder = axis => [...axis.zones].sort((a, b) => rank(a) - rank(b) || width(b) - width(a));
const zoneById = (axis, id) => axis.zones.find(z => z.id === id) || null;
const zonesAt = (axis, t) => axis.zones.filter(z => t >= z.lo - 1e-9 && t <= z.hi + 1e-9);
/* Two overlapping Controller zones normally both send. If they share the
   same transmit channel AND CC they would fight over one controller, so
   the topmost (narrowest) one wins in the overlap and the other goes quiet. */
const sameCC = (a, b) => a.type === 'ctl' && b.type === 'ctl' && a.ch === b.ch && a.cc === b.cc;
const overlaps = (a, b) => a.hi > b.lo && a.lo < b.hi;
function isAbove(axis, a, b) {           /* is a drawn on top of b? */
  const o = drawOrder(axis);
  return o.indexOf(a) > o.indexOf(b);
}
/* zones that silence z: every non-Controller zone, plus same-CC Controllers above it */
const blockers = (axis, z) => axis.zones.filter(o =>
  o !== z && overlaps(o, z) && (o.type !== 'ctl' || (sameCC(o, z) && isAbove(axis, o, z))));
/* is Controller zone z actually sending at travel t? */
const ctlActive = (axis, z, t) =>
  t >= z.lo && t <= z.hi && !blockers(axis, z).some(o => t >= o.lo && t <= o.hi);
/* does z share channel+CC with another Controller it overlaps? (shown amber) */
const ccConflict = (axis, z) => axis.zones.some(o => o !== z && overlaps(o, z) && sameCC(o, z));
/* the parts of [z.lo,z.hi] where z is silenced, merged & sorted */
function blockedRanges(axis, z) {
  const iv = blockers(axis, z)
    .map(o => ({ lo: Math.max(z.lo, o.lo), hi: Math.min(z.hi, o.hi) }))
    .sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const r of iv) {
    if (out.length && r.lo <= out[out.length - 1].hi) out[out.length - 1].hi = Math.max(out[out.length - 1].hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}
/* the topmost (narrowest) Controller zone under t, or null */
function ctlAt(axis, t) {
  const c = zonesAt(axis, t).filter(z => z.type === 'ctl');
  if (!c.length) return null;
  const order = drawOrder({ zones: c });   /* last drawn = on top */
  return order[order.length - 1];
}

/* ── curves ──────────────────────────────────────────────────────── */

const sortedPoints = z => [...z.points].sort((a, b) => a.x - b.x);

/* keep the first/last point pinned to the zone's end points */
function normalizePoints(z) {
  if (!z.points || z.points.length < 2) z.points = [{ x: z.lo, y: 0 }, { x: z.hi, y: 127 }];
  const pts = sortedPoints(z);
  pts[0].x = z.lo;
  pts[pts.length - 1].x = z.hi;
  for (let i = 1; i < pts.length - 1; i++) pts[i].x = Math.max(z.lo, Math.min(z.hi, pts[i].x));
}
const isEndPoint = (z, p) => {
  const pts = sortedPoints(z);
  return p === pts[0] || p === pts[pts.length - 1];
};

/* rescale a zone's points from [oldLo,oldHi] to [newLo,newHi] */
function remapPoints(z, oldLo, oldHi, newLo, newHi) {
  const span = oldHi - oldLo;
  for (const p of z.points) {
    const u = span > 1e-6 ? (p.x - oldLo) / span : 0;
    p.x = newLo + Math.max(0, Math.min(1, u)) * (newHi - newLo);
  }
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

/* value of a curve ({points, smooth}) at travel t */
function curveValue(c, t) {
  const pts = sortedPoints(c);
  if (!pts.length) return 0;
  if (t <= pts[0].x) return pts[0].y;
  if (t >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  while (i < pts.length - 2 && t > pts[i + 1].x) i++;
  const p0 = pts[i], p1 = pts[i + 1];
  const h = Math.max(p1.x - p0.x, 1e-6);
  const u = (t - p0.x) / h;
  if (!c.smooth) return p0.y + (p1.y - p0.y) * u;
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
function clampi(v, lo, hi) {
  if (isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/* ── zone labels ─────────────────────────────────────────────────── */

function zoneShortLabel(axis, z) {
  if (z.type === 'dead') return 'DEAD';
  if (z.type === 'freeze') return 'FRZ ' + axis.freeze;
  if (z.type === 'note') return '♪ ' + noteName(z.note) + ' ch' + z.ch;
  if (z.type === 'switch') return '⚡ ' + (z.action === 'cc' ? 'CC' + z.cc : noteName(z.note)) + ' ch' + z.ch;
  return `CH${z.ch} · CC${z.cc}`;
}

/* what a zone does at the sim marker (null = nothing) */
function zoneOutput(axis, z, t) {
  if (z.type === 'ctl') {
    if (!ctlActive(axis, z, t)) return null;
    return `CC${z.cc} ch${z.ch}=${Math.round(curveValue(z, t))}`;
  }
  if (z.type === 'freeze') return `FRZ ${axis.freeze}`;
  if (z.type === 'note') return `♪${noteName(z.note)} ch${z.ch} v${z.vel}`;
  if (z.type === 'switch') {
    const on = !!simSwitch[z.id];
    return `⚡${z.action === 'cc' ? 'CC' + z.cc : noteName(z.note)} ${on ? 'ON' : 'off'}`;
  }
  return null;
}

/* runtime-only: which Switch zones the sim marker has toggled on */
const simSwitch = {};

/* ── geometry / rendering ────────────────────────────────────────── */

const GEO = { left: 40, right: 14, bottom: 44, height: 240, chipRow: 19 };
const editors = {}; // key -> {svg, outEl}

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
          <button class="ghostbtn" data-addzone type="button" title="add a zone — pick its type in the popover">+ Zone</button>
        </div>
      </div>
      <div class="editor-well"><svg data-axis="${key}"></svg></div>`;
    main.appendChild(panel);
    const svg = panel.querySelector('svg');
    editors[key] = { svg, outEl: panel.querySelector('[data-out]') };
    panel.querySelector('[data-addzone]').addEventListener('click', e => addZone(axis, e.clientX, e.clientY));
    wireEditor(svg, axis);
  }
}

/* chips for Controller zones sit above the strip; overlapping zones get
   their chips on separate rows so nothing collides */
function chipLayout(axis, g) {
  const ctl = axis.zones.filter(z => z.type === 'ctl').sort((a, b) => a.lo - b.lo);
  const rows = [];
  const chips = ctl.map(z => {
    const label = zoneShortLabel(axis, z);
    const w = label.length * 6.4 + 16;
    const cx = (g.tx(z.lo) + g.tx(z.hi)) / 2;
    let row = rows.findIndex(right => right < cx - w / 2 - 4);
    if (row < 0) { row = rows.length; rows.push(0); }
    rows[row] = cx + w / 2;
    return { z, label, w, cx, row };
  });
  return { chips, rows: Math.max(1, rows.length) };
}

function axisGeom(axis) {
  const svg = editors[axis.key].svg;
  const w = svg.clientWidth || svg.parentElement.clientWidth || 800;
  const x0 = GEO.left, x1 = w - GEO.right;
  const tx = t => x0 + t * (x1 - x0);
  /* chip rows decide how tall the header band is */
  const probe = chipLayout(axis, { tx });
  const top = 12 + probe.rows * GEO.chipRow + 4;
  const h = GEO.height + (probe.rows - 1) * GEO.chipRow;
  const y0 = top, y1 = h - GEO.bottom;
  return {
    w, h, x0, x1, y0, y1, tx,
    ty: v => y1 - (v / 127) * (y1 - y0),
    it: px => Math.max(0, Math.min(1, (px - x0) / (x1 - x0))),
    iv: py => Math.max(0, Math.min(127, (1 - (py - y0) / (y1 - y0)) * 127)),
  };
}

function render(axis) {
  const ed = editors[axis.key];
  const g = axisGeom(axis);
  const parts = [];

  parts.push(`<defs>
    <filter id="glow-sim-${axis.key}" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="hsl(16 100% 60%)" flood-opacity="0.8"/>
    </filter>
    ${PALETTE.map((p, i) => `<filter id="glow-${axis.key}-${i}" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${p.c}" flood-opacity="0.7"/></filter>`).join('')}
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

  const samplePath = (z, lo, hi) => {
    const n = Math.max(2, Math.round((hi - lo) * 140));
    let dd = '';
    for (let i = 0; i <= n; i++) {
      const t = lo + (hi - lo) * (i / n);
      dd += (i ? 'L' : 'M') + g.tx(t).toFixed(1) + ' ' + g.ty(curveValue(z, t)).toFixed(1);
    }
    return dd;
  };

  /* zone bands — widest first so the narrowest is on top and wins the tap */
  const order = drawOrder(axis);
  const labelCx = [];   /* centers of labels already placed, to stack collisions */
  for (const z of order) {
    const xa = g.tx(z.lo), xb = g.tx(z.hi);
    const col = colorOf(z);
    const dead = z.type === 'dead';
    const fill = dead ? 'var(--dead-fill)' : col.c;
    const fillOp = dead ? 1 : (z.type === 'ctl' ? 0.09 : 0.16);
    const edge = dead ? 'var(--dead-edge)' : col.c;
    parts.push(`<rect x="${xa}" y="${g.y0}" width="${xb - xa}" height="${g.y1 - g.y0}" fill="${fill}" fill-opacity="${fillOp}" data-role="zone" data-id="${z.id}" style="cursor:grab"/>`);
    parts.push(`<line x1="${xa + 1.5}" y1="${g.y0 + 6}" x2="${xa + 1.5}" y2="${g.y1 - 6}" stroke="${edge}" stroke-opacity="${dead ? 1 : 0.8}" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`);
    parts.push(`<line x1="${xb - 1.5}" y1="${g.y0 + 6}" x2="${xb - 1.5}" y2="${g.y1 - 6}" stroke="${edge}" stroke-opacity="${dead ? 1 : 0.8}" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`);
    if (z.type !== 'ctl') {
      const cx = (xa + xb) / 2;
      /* labels of overlapping zones stack downward instead of colliding */
      const stack = labelCx.filter(x => Math.abs(x - cx) < 48).length;
      labelCx.push(cx);
      const cy = (g.y0 + g.y1) / 2 + stack * 14;
      const wide = (xb - xa) > 54;
      parts.push(`<text x="${cx}" y="${cy}" font-size="8" text-anchor="middle" class="zone-label" fill="${dead ? 'var(--dead-edge)' : col.c}" pointer-events="none" transform="${wide ? '' : `rotate(-90 ${cx} ${cy})`}">${zoneShortLabel(axis, z)}</text>`);
    }
  }
  /* edge handles, on top of every band */
  for (const z of order) {
    const xa = g.tx(z.lo), xb = g.tx(z.hi);
    parts.push(`<rect x="${xa - 7}" y="${g.y0}" width="14" height="${g.y1 - g.y0}" fill="transparent" data-role="edge" data-id="${z.id}" data-side="lo" style="cursor:ew-resize"/>`);
    parts.push(`<rect x="${xb - 7}" y="${g.y0}" width="14" height="${g.y1 - g.y0}" fill="transparent" data-role="edge" data-id="${z.id}" data-side="hi" style="cursor:ew-resize"/>`);
  }

  /* response curves + points, per Controller zone (same draw order) */
  for (const z of order) {
    if (z.type !== 'ctl') continue;
    const col = colorOf(z);
    const ci = (z.color || 0) % PALETTE.length;
    /* solid where the zone is active, dotted where another zone type covers it */
    let t0 = z.lo;
    for (const b of blockedRanges(axis, z)) {
      if (b.lo > t0 + 1e-6) parts.push(`<path d="${samplePath(z, t0, b.lo)}" fill="none" stroke="${col.c}" stroke-width="2.5" stroke-linecap="round" filter="url(#glow-${axis.key}-${ci})" pointer-events="none"/>`);
      parts.push(`<path d="${samplePath(z, b.lo, b.hi)}" fill="none" stroke="${col.c}" stroke-opacity="0.55" stroke-width="1.8" stroke-dasharray="2 5" stroke-linecap="round" pointer-events="none"/>`);
      t0 = b.hi;
    }
    if (z.hi > t0 + 1e-6) parts.push(`<path d="${samplePath(z, t0, z.hi)}" fill="none" stroke="${col.c}" stroke-width="2.5" stroke-linecap="round" filter="url(#glow-${axis.key}-${ci})" pointer-events="none"/>`);
    for (const p of sortedPoints(z)) {
      const x = g.tx(p.x), y = g.ty(p.y);
      const idx = z.points.indexOf(p);
      const quiet = !ctlActive(axis, z, p.x);
      parts.push(`<circle cx="${x}" cy="${y}" r="${isEndPoint(z, p) ? 6.5 : 5.5}" fill="${col.pt}" stroke="${col.c}" stroke-width="2" opacity="${quiet ? 0.4 : 1}" filter="url(#glow-${axis.key}-${ci})" pointer-events="none"/>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="16" fill="transparent" data-role="point" data-id="${z.id}" data-idx="${idx}" style="cursor:grab"/>`);
    }
  }

  /* chips */
  const { chips } = chipLayout(axis, g);
  for (const c of chips) {
    const col = colorOf(c.z);
    const y = 6 + c.row * GEO.chipRow;
    const warn = ccConflict(axis, c.z);   /* amber: shares CH+CC with an overlapping Controller */
    parts.push(`<g data-role="chip" data-id="${c.z.id}" style="cursor:pointer">${warn ? `<title>overlaps another Controller on the same channel and CC — the topmost one wins</title>` : ''}
      <rect x="${c.cx - c.w / 2}" y="${y}" width="${c.w}" height="17" rx="8.5" fill="${warn ? 'var(--warn-fill)' : 'var(--chip-fill)'}" stroke="${warn ? 'var(--warn)' : col.c}" stroke-opacity="${warn ? 1 : 0.7}"/>
      <circle cx="${c.cx - c.w / 2 + 9}" cy="${y + 8.5}" r="3" fill="${col.c}"/>
      <text x="${c.cx + 4}" y="${y + 12}" font-size="8" text-anchor="middle" class="chip-label">${c.label}</text>
    </g>`);
  }

  /* sim marker */
  const sx = g.tx(axis.sim);
  parts.push(`<line x1="${sx}" y1="${g.y0}" x2="${sx}" y2="${g.y1 + 8}" stroke="var(--sim)" stroke-width="1" opacity="0.65" pointer-events="none"/>`);
  for (const z of axis.zones) {
    if (z.type !== 'ctl' || !ctlActive(axis, z, axis.sim)) continue;
    const sy = g.ty(curveValue(z, axis.sim));
    parts.push(`<circle cx="${sx}" cy="${sy}" r="3.5" fill="var(--sim)" filter="url(#glow-sim-${axis.key})" pointer-events="none"/>`);
  }
  parts.push(`<path d="M${sx - 7} ${g.y1 + 20} L${sx + 7} ${g.y1 + 20} L${sx} ${g.y1 + 9} Z" fill="var(--sim)" filter="url(#glow-sim-${axis.key})" data-role="sim" style="cursor:ew-resize"/>`);
  parts.push(`<rect x="${sx - 16}" y="${g.y1 + 2}" width="32" height="${GEO.bottom - 4}" fill="transparent" data-role="sim" style="cursor:ew-resize"/>`);

  ed.svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
  ed.svg.setAttribute('width', g.w);
  ed.svg.setAttribute('height', g.h);
  ed.svg.innerHTML = parts.join('');

  /* output readout: every active output at the marker */
  const outs = zonesAt(axis, axis.sim)
    .sort((a, b) => a.lo - b.lo)
    .map(z => zoneOutput(axis, z, axis.sim))
    .filter(Boolean);
  ed.outEl.textContent = outs.length ? outs.join(' · ') : 'DEAD';
}

function commit(axis) {
  for (const z of axis.zones) if (z.type === 'ctl') normalizePoints(z);
  render(axis);
  saveState();
}

/* ── interactions ────────────────────────────────────────────────── */

function wireEditor(svg, axis) {
  let drag = null;
  let lastTap = { time: 0, x: 0, y: 0 };
  let simTrack = { t: axis.sim, time: 0 };

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
      pointerType: e.pointerType,
    };
    if (drag.role === 'zone') {
      const z = zoneById(axis, drag.id);
      if (z) { drag.zLo = z.lo; drag.zHi = z.hi; drag.pts = z.points.map(p => p.x); }
    }
    if (drag.role === 'sim') simTrack = { t: axis.sim, time: performance.now() };
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
      const z = zoneById(axis, drag.id);
      const p = z && z.points[drag.idx];
      if (p) {
        if (!isEndPoint(z, p)) p.x = Math.max(z.lo, Math.min(z.hi, t));
        p.y = Math.round(g.iv(py));
        commit(axis);
      }
    } else if (drag.role === 'edge') {
      const z = zoneById(axis, drag.id);
      if (z) {
        const oldLo = z.lo, oldHi = z.hi;
        if (drag.side === 'lo') z.lo = Math.max(0, Math.min(t, z.hi - MIN_ZONE));
        else z.hi = Math.min(1, Math.max(t, z.lo + MIN_ZONE));
        remapPoints(z, oldLo, oldHi, z.lo, z.hi);
        commit(axis);
      }
    } else if (drag.role === 'zone') {
      const z = zoneById(axis, drag.id);
      if (z) {
        const w = drag.zHi - drag.zLo;
        let lo = drag.zLo + (t - g.it(drag.startPx));
        lo = Math.max(0, Math.min(1 - w, lo));
        z.lo = lo; z.hi = lo + w;
        z.points.forEach((p, i) => { p.x = drag.pts[i] + (lo - drag.zLo); });
        commit(axis);
      }
    } else if (drag.role === 'sim') {
      simMove(axis, t, simTrack);
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
    if (d.role === 'point') { openPointPopover(axis, d.id, d.idx, e.clientX, e.clientY); return; }
    if (d.role === 'zone' || d.role === 'edge' || d.role === 'chip') {
      const z = zoneById(axis, d.id);
      if (z) openZonePopover(axis, z, e.clientX, e.clientY);
      return;
    }

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
    if (role !== 'bg' && role !== 'zone' && role !== 'edge') return;
    const { px, py } = evPos(e);
    addPointAt(axis, px, py);
  });
}

/* the sim marker moving: Switch zones fire on a fast ENTRY, toggling on/off;
   the marker must leave the zone before it can fire again */
function simMove(axis, t, track) {
  const now = performance.now();
  const dt = (now - track.time) / 1000;
  const speed = dt > 0 ? Math.abs(t - track.t) * 100 / dt : 0;   /* % of travel per second */
  for (const z of axis.zones) {
    if (z.type !== 'switch') continue;
    const wasIn = track.t >= z.lo && track.t <= z.hi;
    const nowIn = t >= z.lo && t <= z.hi;
    if (!wasIn && nowIn && speed >= z.speed) simSwitch[z.id] = !simSwitch[z.id];
  }
  track.t = t; track.time = now;
  axis.sim = t;
}

/* add a curve point to the topmost Controller zone under the pointer */
function addPointAt(axis, px, py) {
  const g = axisGeom(axis);
  if (py < g.y0 - 6 || py > g.y1 + 6) return;
  const t = g.it(px);
  const z = ctlAt(axis, t);
  if (!z) return;
  z.points.push({ x: t, y: Math.round(g.iv(py)) });
  commit(axis);
}

/* + Zone: a new Controller zone over the middle third, on top, in the next
   color; its popover opens so the type can be picked right away */
function addZone(axis, cx, cy) {
  const z = mkZone('ctl', 0.33, 0.67, { color: nextColor(axis), ch: 1, cc: nextCC(axis) });
  axis.zones.push(z);
  commit(axis);
  openZonePopover(axis, z, cx, cy);
}
function nextCC(axis) {
  const used = new Set(axis.zones.filter(z => z.type === 'ctl').map(z => z.cc));
  let cc = 1;
  while (used.has(cc)) cc++;
  return Math.min(cc, 127);
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

function numRow(label, id, val, min, max, attrs) {
  return `<div class="pop-row"><label>${label}</label>
    <input id="${id}" type="number" inputmode="numeric" value="${val}" min="${min}" max="${max}" ${attrs || ''}></div>`;
}
/* wire a numeric input: fn(value) then commit */
function wireNum(axis, id, fn) {
  const el = pop.querySelector('#' + id);
  if (el) el.addEventListener('input', () => { const v = parseFloat(el.value); if (!isNaN(v)) { fn(v); commit(axis); } });
}

function openPointPopover(axis, zid, idx, cx, cy) {
  const z = zoneById(axis, zid);
  const p = z && z.points[idx];
  if (!p) return;
  const end = isEndPoint(z, p);
  const col = colorOf(z);
  openPopover(`
    <h3><span class="amb-led" style="--amb-led-color:${col.c}"></span>${end ? 'End point' : 'Point'}
      <span class="pop-note">CH${z.ch} · CC${z.cc}</span></h3>
    <div class="pop-rows">
      ${numRow('Travel %', 'ppx', (p.x * 100).toFixed(1), 0, 100, end ? 'readonly' : '')}
      ${numRow('Value', 'ppy', Math.round(p.y), 0, 127)}
      ${end ? '<div class="pop-note">end points follow the zone\'s edges — drag the edge to move it</div>'
            : '<button class="dangerbtn" id="pdel" type="button">delete point</button>'}
    </div>`, cx, cy);
  if (!end) wireNum(axis, 'ppx', v => { p.x = Math.max(z.lo, Math.min(z.hi, v / 100)); });
  wireNum(axis, 'ppy', v => { p.y = clampi(v, 0, 127); });
  const del = pop.querySelector('#pdel');
  if (del) del.addEventListener('click', () => { z.points.splice(idx, 1); closePopover(); commit(axis); });
}

function openZonePopover(axis, z, cx, cy) {
  const col = colorOf(z);
  const typeOrder = ['ctl', 'note', 'switch', 'dead', 'freeze'];   /* Freeze last: it gets the full-width button */
  const typeBtns = typeOrder.map(zoneType).map(t => `
    <button class="type-btn ${t.id === 'freeze' ? 'wide' : ''} ${z.type === t.id ? 'on' : ''}" data-type="${t.id}" type="button" title="${t.label}">
      <span class="ico">${t.icon}</span>${t.id === 'freeze' ? 'Freeze ' + axis.freeze + ' value' : t.label}
    </button>`).join('');
  const swatches = PALETTE.map((p, i) => `
    <button class="swatch ${((z.color || 0) % PALETTE.length) === i ? 'on' : ''}" data-color="${i}" type="button"
      style="--sw:${p.c}" title="${p.name}"></button>`).join('');

  let rows = '';
  if (z.type === 'ctl') {
    rows = `${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${numRow('CC #', 'zcc', z.cc, 0, 127)}
      <div class="pop-row"><label>Response curve</label>
        <button class="ghostbtn ${z.smooth ? 'on' : ''}" id="zsmooth" type="button" title="linear ↔ smooth (monotone cubic) interpolation between the points">smooth</button></div>
      <div class="pop-note">drag the end points to set the output range · double-click the curve to add points</div>
      ${ccConflict(axis, z) ? '<div class="pop-note warn">overlaps another controller zone on the same channel + CC — where they overlap only the topmost (narrowest) one sends</div>' : ''}`;
  } else if (z.type === 'note') {
    rows = `${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${numRow('Note #', 'znote', z.note, 0, 127)}
      <div class="pop-row"><label>Note</label><span class="pop-note" id="znName">${noteName(z.note)}</span></div>
      ${numRow('Velocity', 'zvel', z.vel, 1, 127)}
      <div class="pop-note">note on when the pedal enters the zone, note off when it leaves</div>`;
  } else if (z.type === 'switch') {
    rows = `<div class="pop-row"><label>Action</label>
        <div class="seg"><button class="${z.action !== 'cc' ? 'on' : ''}" data-action="note" type="button">Note</button><button class="${z.action === 'cc' ? 'on' : ''}" data-action="cc" type="button">CC</button></div></div>
      ${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${z.action === 'cc'
        ? `${numRow('CC #', 'zcc', z.cc, 0, 127)}${numRow('On value', 'zon', z.onVal, 0, 127)}${numRow('Off value', 'zoff', z.offVal, 0, 127)}`
        : `${numRow('Note #', 'znote', z.note, 0, 127)}
           <div class="pop-row"><label>Note</label><span class="pop-note" id="znName">${noteName(z.note)}</span></div>
           ${numRow('Velocity', 'zvel', z.vel, 1, 127)}`}
      ${numRow('Speed %/s', 'zspeed', z.speed, 50, 1000)}
      <div class="pop-note">a fast entry (faster than Speed) toggles on / off · slow entry does nothing</div>`;
  } else if (z.type === 'freeze') {
    rows = `<div class="pop-note">while the pedal is in this zone the ${axis.freeze} value is held</div>`;
  } else {
    rows = `<div class="pop-note">travel here is ignored — this zone masks any controller zone underneath it</div>`;
  }

  openPopover(`
    <h3><span class="amb-led" style="--amb-led-color:${z.type === 'dead' ? '#6b7280' : col.c}"></span>${zoneType(z.type).icon} ${zoneType(z.type).label} zone</h3>
    <div class="pop-rows">
      <div class="type-list">${typeBtns}</div>
      <div class="pop-row"><label>Range %</label>
        <span class="pair"><input id="zlo" type="number" inputmode="numeric" value="${(z.lo * 100).toFixed(1)}" min="0" max="100">–<input id="zhi" type="number" inputmode="numeric" value="${(z.hi * 100).toFixed(1)}" min="0" max="100"></span></div>
      ${z.type === 'dead' ? '' : `<div class="pop-row"><label>Color</label><div class="swatches">${swatches}</div></div>`}
      <hr class="pop-sep">
      ${rows}
      <button class="dangerbtn" id="zdel" type="button">delete zone</button>
    </div>`, cx, cy);

  const reopen = () => { closePopover(); openZonePopover(axis, z, cx, cy); };
  pop.querySelectorAll('.type-btn').forEach(b => b.addEventListener('click', () => {
    z.type = b.dataset.type;
    if (z.type === 'ctl') normalizePoints(z);
    commit(axis); reopen();
  }));
  pop.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
    z.color = +b.dataset.color; commit(axis); reopen();
  }));
  pop.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => {
    z.action = b.dataset.action; commit(axis); reopen();
  }));
  const setRange = (lo, hi) => {
    lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
    if (hi - lo < MIN_ZONE) return;
    remapPoints(z, z.lo, z.hi, lo, hi);
    z.lo = lo; z.hi = hi;
  };
  wireNum(axis, 'zlo', v => setRange(v / 100, z.hi));
  wireNum(axis, 'zhi', v => setRange(z.lo, v / 100));
  wireNum(axis, 'zch', v => { z.ch = clampi(v, 1, 16); });
  wireNum(axis, 'zcc', v => { z.cc = clampi(v, 0, 127); });
  wireNum(axis, 'zvel', v => { z.vel = clampi(v, 1, 127); });
  wireNum(axis, 'zon', v => { z.onVal = clampi(v, 0, 127); });
  wireNum(axis, 'zoff', v => { z.offVal = clampi(v, 0, 127); });
  wireNum(axis, 'zspeed', v => { z.speed = clampi(v, 50, 1000); });
  wireNum(axis, 'znote', v => {
    z.note = clampi(v, 0, 127);
    const nm = pop.querySelector('#znName');
    if (nm) nm.textContent = noteName(z.note);
  });
  const sm = pop.querySelector('#zsmooth');
  if (sm) sm.addEventListener('click', () => { z.smooth = !z.smooth; sm.classList.toggle('on', z.smooth); commit(axis); });
  pop.querySelector('#zdel').addEventListener('click', () => {
    axis.zones = axis.zones.filter(x => x.id !== z.id);
    delete simSwitch[z.id];
    closePopover();
    commit(axis);
  });
}

/* ── librarian: Setup library + drag-ordered Set List ────────────── */

const libListEl = document.getElementById('libList');
const setListEl = document.getElementById('setList');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function libEntry(id) { return state.library.find(x => x.id === id) || null; }

/* the loaded Setup's 1-based Set List position (its PC number), or null */
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
    delete entry.layerOn;
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
  state.axes = migrateAxes(JSON.parse(JSON.stringify(entry.axes)), entry.layerOn);
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
        <span class="lib-name">${esc(en.name)}</span>
        <button class="rowbtn" data-add type="button" title="append to the set list">+</button>
        <button class="rowbtn" data-del type="button" title="delete (tap twice)">×</button>
      </li>`).join('')
    : '<li class="lib-empty">empty — SAVE stores the current Setup</li>';
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
    : '<li class="lib-empty">drag Setups here — order sets the PC #</li>';
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
  if (id === state.loadedId && !isDirty()) return;   /* already loaded, nothing to revert */
  guardUnsaved('loading another Setup', () => loadProgram(id));
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
  guardUnsaved('loading another Setup', () => loadProgram(state.setlist[idx]));
});

/* pointer-based row drag — grab anywhere on a bar (buttons excluded).
   A ~6px movement threshold separates a drag from a tap-to-load.
   library → set list inserts · set list ↕ reorders · set list → library removes. */
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

/* v1.6: Save and + new open the review modal first; the modal's Save commits. */
document.getElementById('saveBtn').addEventListener('click', () => showSaveModal(false));
document.getElementById('saveNewBtn').addEventListener('click', () => guardUnsaved('creating a new Setup', () => showSaveModal(true)));

/* ── v1.7: unsaved-changes guard ──────────────────────────────────
   The loaded Setup is "dirty" when the editor differs from its Library
   copy. Anything that would replace the editor contents goes through
   guardUnsaved(): clean → proceed; dirty → Save / Discard / Cancel. */
function isDirty() {
  const en = state.loadedId ? libEntry(state.loadedId) : null;
  if (!en) return false;
  const name = (state.program.name || 'UNTITLED').toUpperCase().slice(0, 10);
  return name !== en.name || JSON.stringify(state.axes) !== JSON.stringify(en.axes);
}
const askWrap = document.getElementById('askWrap');
let askThen = null;
function guardUnsaved(what, then) {
  if (!isDirty()) { then(); return; }
  const en = libEntry(state.loadedId);
  document.getElementById('askText').textContent = `"${en.name}" has unsaved changes. Save them before ${what}?`;
  askThen = then;
  askWrap.hidden = false;
  document.getElementById('askSave').focus();
}
function askClose() { askWrap.hidden = true; askThen = null; }
document.getElementById('askCancel').addEventListener('click', askClose);
document.getElementById('askScrim').addEventListener('click', askClose);
document.getElementById('askDiscard').addEventListener('click', () => { const t = askThen; askClose(); if (t) t(); });
document.getElementById('askSave').addEventListener('click', () => {
  const t = askThen; askClose();
  saveProgram(false);
  flashProgName();
  if (t) t();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !askWrap.hidden) askClose(); });

/* ── MIDI receive: receive channel + program change → set list slot ── */

const globalChSel = document.getElementById('globalCh');
globalChSel.innerHTML = '<option value="omni">OMNI</option>'
  + Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
globalChSel.value = String(state.globalCh);
globalChSel.addEventListener('change', () => {
  state.globalCh = globalChSel.value === 'omni' ? 'omni' : +globalChSel.value;
  saveState();
});

/* the device rule: a PC on the receive channel selects that set list slot */
function receiveProgramChange(ch, pc, force) {
  const gch = state.globalCh;
  if (gch !== 'omni' && ch !== gch) {
    return { ok: false, msg: `PC ${pc} ch${ch} — ignored (receive ch ${gch})` };
  }
  const id = state.setlist[pc - 1];
  if (!id || !libEntry(id)) {
    return { ok: false, msg: `PC ${pc} ch${ch} — no set list slot ${pc}` };
  }
  if (!force && isDirty()) {
    /* ask first; on Save/Discard re-run with force so we don't ask twice */
    guardUnsaved(`switching to set list slot ${pc}`, () => showMiLog(receiveProgramChange(ch, pc, true)));
    return { ok: false, msg: `PC ${pc} ch${ch} — waiting: unsaved changes` };
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
function showMiLog(res) {
  miLog.textContent = res.msg;
  miLog.classList.toggle('ok', res.ok);
}
document.getElementById('miSend').addEventListener('click', () => {
  const pc = clampi(parseFloat(document.getElementById('miPc').value), 1, 128);
  showMiLog(receiveProgramChange(+miCh.value, pc));
});

/* ── save review ─────────────────────────────────────────────────── */

function zoneDetailText(axis, z) {
  if (z.type === 'ctl') return `CTL     CH ${z.ch} · CC ${z.cc} · ${z.smooth ? 'smooth' : 'linear'}`;
  if (z.type === 'note') return `NOTE    CH ${z.ch} · #${z.note} (${noteName(z.note)}) · vel ${z.vel} · on at entry, off at exit`;
  if (z.type === 'switch') {
    const what = z.action === 'cc' ? `CC ${z.cc} on ${z.onVal} / off ${z.offVal}` : `note #${z.note} (${noteName(z.note)}) vel ${z.vel}`;
    return `SWITCH  CH ${z.ch} · ${what} · fast entry ≥ ${z.speed}%/s toggles`;
  }
  if (z.type === 'freeze') return `FREEZE  holds the ${axis.freeze} value`;
  return 'DEAD    masks controller zones it overlaps';
}

function exportText() {
  const p = state.program;
  const lines = [];
  const rule = '─'.repeat(52);
  const pc = loadedPC();
  lines.push(`ORBIT SETUP ${pc ? String(pc).padStart(3, '0') : '---'} · "${p.name}"`);
  lines.push(`orbit ui v${APP_VERSION} · exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push(`receive channel: ${state.globalCh === 'omni' ? 'OMNI' : 'CH ' + state.globalCh}  (program changes → set list)`);
  lines.push('');
  for (const key of ['yaw', 'pitch']) {
    const a = state.axes[key];
    lines.push(`${a.label}  (${a.endLabels[0]} → ${a.endLabels[1]})`);
    lines.push(rule);
    for (const z of [...a.zones].sort((x, y) => x.lo - y.lo)) {
      const range = `${pct(z.lo).padStart(6)} – ${pct(z.hi).padStart(6)}`;
      const colr = z.type === 'dead' ? '' : ` [${colorOf(z).name}]`;
      lines.push(`  ${range}  ${zoneDetailText(a, z)}${colr}`);
      if (z.type === 'ctl') {
        lines.push(`${' '.repeat(19)}curve  ${sortedPoints(z).map(pt => `${pct(pt.x)}→${Math.round(pt.y)}`).join(',  ')}`);
      }
    }
    lines.push('');
  }
  if (state.setlist.length) {
    lines.push('SET LIST  (1:1 program change map)');
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
    receiveChannel: state.globalCh,
    setup: { num: loadedPC(), name: state.program.name },
    setlist: state.setlist.map((id, i) => {
      const en = libEntry(id);
      return { pc: i + 1, name: en ? en.name : '?' };
    }),
    axes: {},
  };
  for (const key of ['yaw', 'pitch']) {
    const a = state.axes[key];
    out.axes[key] = {
      zones: [...a.zones].sort((x, y) => x.lo - y.lo).map(z => {
        const base = { type: z.type, lo: +(z.lo.toFixed(4)), hi: +(z.hi.toFixed(4)) };
        if (z.type !== 'dead') base.color = colorOf(z).name;
        if (z.type === 'ctl') Object.assign(base, {
          channel: z.ch, cc: z.cc, curveMode: z.smooth ? 'smooth' : 'linear',
          points: sortedPoints(z).map(pt => ({ travel: +(pt.x.toFixed(4)), value: Math.round(pt.y) })),
        });
        if (z.type === 'note') Object.assign(base, { channel: z.ch, note: z.note, velocity: z.vel });
        if (z.type === 'switch') Object.assign(base, {
          channel: z.ch, action: z.action, speedPctPerSec: z.speed,
          ...(z.action === 'cc' ? { cc: z.cc, onValue: z.onVal, offValue: z.offVal } : { note: z.note, velocity: z.vel }),
        });
        if (z.type === 'freeze') base.holds = key === 'yaw' ? 'pitch' : 'yaw';
        return base;
      }),
    };
  }
  return JSON.stringify(out, null, 2);
}

const modalWrap = document.getElementById('modalWrap');
const modalPre = document.getElementById('modalPre');
const modalTitle = document.getElementById('modalTitle');
let modalFmt = 'text';
let modalAsNew = false;   // which save the modal's Save button performs

/* Open the review window for the current Setup. Nothing is stored until
   the modal's Save button is pressed; Cancel / scrim / Esc close it. */
function showSaveModal(asNew) {
  modalAsNew = asNew;
  modalFmt = 'text';
  document.querySelectorAll('.modal-tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.fmt === 'text'));
  modalPre.textContent = exportText();
  const updating = !asNew && state.loadedId && libEntry(state.loadedId);
  modalTitle.textContent = asNew ? 'SAVE AS NEW SETUP' : (updating ? 'SAVE SETUP' : 'SAVE TO LIBRARY');
  modalWrap.hidden = false;
  document.getElementById('confirmSaveBtn').focus();
}
function hideModal() { modalWrap.hidden = true; }
/* brief confirmation on the SETUP field after a save (same glow as a MIDI-in load) */
function flashProgName() {
  const el = document.getElementById('progName');
  el.classList.remove('saved');
  void el.offsetWidth;   // restart the animation if it's still running
  el.classList.add('saved');
  el.addEventListener('animationend', () => el.classList.remove('saved'), { once: true });
}
document.getElementById('confirmSaveBtn').addEventListener('click', () => {
  saveProgram(modalAsNew);
  hideModal();
  flashProgName();
});
document.getElementById('cancelBtn').addEventListener('click', hideModal);
document.getElementById('modalScrim').addEventListener('click', hideModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modalWrap.hidden) hideModal(); });
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

/* ── Setup fields / reset / boot ─────────────────────────────────── */

const progNum = document.getElementById('progNum');
const progName = document.getElementById('progName');
progName.value = state.program.name;
progName.addEventListener('input', () => { state.program.name = progName.value.toUpperCase().slice(0, 10); saveState(); });

document.getElementById('resetBtn').addEventListener('click', () => guardUnsaved('resetting the demo', () => {
  if (!confirm('Reset the demo? This also clears the Library and Set List.')) return;
  state = defaultState();
  progName.value = state.program.name;
  buildPanels();
  for (const key of ['yaw', 'pitch']) commit(state.axes[key]);
  renderLibrarian();
}));

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
