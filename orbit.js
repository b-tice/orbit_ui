/* Orbit UI — Setup editor concept demo
   v1.8 model: each axis is a span of travel (0–100%) holding ZONES.
   Every zone has a type — Controller / Note / Switch / Freeze / Dead —
   a travel range [lo,hi], and a color. Zones may OVERLAP: a second CC on
   the same sweep is simply a second Controller zone laid over the first.
   Controller zones own their transmit channel, CC number and their own
   response curve (points; the first/last points are the zone's end points).
   Dead zones are a MASK: they silence any Controller zone they overlap.
   Travel with no zone at all is dead too.
   v1.9: OUTPUT TABS. Each axis carries one zone set per output — MIDI and
   Analog Out — sharing the same editor; only what a zone drives differs.
   The Library is per output too (a MIDI Setup, an Analog Setup; Ground
   Control later), and a Set List slot holds one Setup per output, recalled
   together by one program change. */

'use strict';

/* Bump on every feature addition; shown in the header and exports. */
const APP_VERSION = '1.10';

/* ── constants ───────────────────────────────────────────────────── */

const STORE_KEY = 'orbit_ui_state_v1';
let uidn = 1;
const uid = () => 'z' + (uidn++) + '_' + Math.random().toString(36).slice(2, 7);

const MIN_ZONE = 0.02;          /* narrowest zone, as a fraction of travel */
/* storage caps (the pedal's file system is not the limit; these keep lists sane) */
const MAX_SETUPS = 256;         /* per output library */
const MAX_SETLISTS = 16;
const MAX_SLOTS = 128;          /* = the Program Change range */
/* Switch zones fire on a FAST entry. Speed is in m/s along the pedal's
   travel, taking the full span (0–100 %) as SPAN_M metres of movement —
   about what a foot covers heel-to-toe on an expression pedal. */
const SPAN_M = 0.10;
const DEFAULT_SWITCH_MS = 0.1;  /* m/s: the full span in 1 s */
const SPEED_WINDOW_MS = 100;    /* speed is averaged over the last 100 ms of motion */

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

/* ── output tabs ─────────────────────────────────────────────────── */

const VOLTS = 5;                                  /* EXP jack full scale */
const toV = v => v / 127 * VOLTS;
const fromV = volts => volts / VOLTS * 127;
const OUTPUTS = {
  midi: {
    key: 'midi', label: 'MIDI', tag: 'MIDI', chips: true,
    types: ['ctl', 'note', 'switch', 'dead', 'freeze'],
    gridLabel: v => String(v),
    valLabel: v => String(Math.round(v)),
  },
  analog: {
    key: 'analog', label: 'ANALOG OUT', tag: 'EXP',
    types: ['ctl', 'switch', 'dead'],             /* a voltage has no notes and nothing to freeze */
    chips: false,                                  /* one jack per axis: no CH·CC-style chips */
    gridLabel: v => toV(v).toFixed(1) + 'V',
    valLabel: v => toV(v).toFixed(2) + 'V',
  },
};
const TAB_ORDER = ['midi', 'analog'];
const OUT = () => OUTPUTS[state.tab];
/* the EXP jack an axis drives is fixed by the hardware: pitch → EXP 1, yaw → EXP 2 */
const jackOf = axis => (axis.key === 'pitch' ? 1 : 2);
/* the active tab's zones of an axis */
const Z = axis => axis.outputs[state.tab].zones;
const setZ = (axis, zones) => { axis.outputs[state.tab].zones = zones; };

/* ── zone factory ────────────────────────────────────────────────── */

/* Every zone carries the fields of every type, so switching a zone's type
   back and forth never loses what the user typed. */
function mkZone(type, lo, hi, extra) {
  return Object.assign({
    id: uid(), type, lo, hi, color: 0,
    /* controller (MIDI: channel + CC · analog: the axis's own jack) */
    ch: 1, cc: 1, smooth: false,
    points: [{ x: lo, y: 0 }, { x: hi, y: 127 }],
    /* note + switch */
    note: 60, vel: 100,
    /* switch */
    action: 'note', onVal: 127, offVal: 0, speedMs: DEFAULT_SWITCH_MS,
  }, extra || {});
}

/* the least-used palette color among this axis's colored (non-dead) zones */
function nextColor(axis) {
  const counts = PALETTE.map(() => 0);
  for (const z of Z(axis)) if (z.type !== 'dead') counts[(z.color || 0) % PALETTE.length]++;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

/* Defaults: the classic layout — Yaw = two Controller zones (the bipolar
   Mid=Hi example, left 0→127, right 127→0) with padding at the ends and a
   gap at center; Pitch = one Controller with padding at heel and toe. The
   padding is EMPTY travel (dead by absence), not Dead zones. */
function defaultZones(key) {
  if (key === 'yaw') return [
    mkZone('ctl', 0.08, 0.46, { color: 0, ch: 1, cc: 11,
      points: [{ x: 0.08, y: 0 }, { x: 0.27, y: 70 }, { x: 0.46, y: 127 }] }),
    mkZone('ctl', 0.54, 0.92, { color: 1, ch: 1, cc: 11,
      points: [{ x: 0.54, y: 127 }, { x: 0.73, y: 70 }, { x: 0.92, y: 0 }] }),
  ];
  return [
    mkZone('ctl', 0.06, 0.94, { color: 0, ch: 1, cc: 1,
      points: [{ x: 0.06, y: 0 }, { x: 0.5, y: 50 }, { x: 0.94, y: 127 }] }),
  ];
}

/* The Analog tab starts as a MIRROR of the MIDI zones and diverges only
   when edited: Controller curves map 0–127 → 0–5 V unchanged; every other
   zone (Note, Freeze, Switch, Dead) becomes a Dead zone of the same range,
   so the voltage's dead spots line up with the MIDI ones. */
function mirrorToAnalog(zones) {
  return zones.map(z => {
    const c = JSON.parse(JSON.stringify(z));
    c.id = uid();
    if (c.type !== 'ctl') c.type = 'dead';
    return c;
  });
}
const defaultAnalogZones = key => mirrorToAnalog(defaultZones(key));
/* the other direction: every analog zone type is a valid MIDI zone */
function mirrorToMidi(zones) {
  return zones.map(z => { const c = JSON.parse(JSON.stringify(z)); c.id = uid(); return c; });
}
const mirrorZones = (zones, toTab) => (toTab === 'analog' ? mirrorToAnalog(zones) : mirrorToMidi(zones));

/* A Set List slot always holds one Setup per output. Whenever a slot has a
   file for one output and none for another, create the missing one as a
   mirror (same name) so the slot recalls something sensible everywhere.
   Works on a raw state object so migration can use it too. */
function fillSlots(st) {
  for (const sl of st.setlists.flatMap(l => l.slots)) {
    const src = TAB_ORDER.find(t => sl[t] && st.library[t].find(f => f.id === sl[t]));
    if (!src) continue;
    const from = st.library[src].find(f => f.id === sl[src]);
    for (const tab of TAB_ORDER) {
      if (sl[tab] && st.library[tab].find(f => f.id === sl[tab])) continue;
      const nf = mkFile(from.name, { yaw: mirrorZones(from.axes.yaw, tab), pitch: mirrorZones(from.axes.pitch, tab) });
      st.library[tab].push(nf);
      sl[tab] = nf.id;
    }
  }
}
/* the pre-mirror analog default (one full-span 0→5 V ramp) — used to spot
   untouched analog files from earlier builds so they can be re-mirrored */
function isPlainRamp(zones) {
  if (!zones || zones.length !== 1) return false;
  const z = zones[0];
  return z.type === 'ctl' && z.lo === 0 && z.hi === 1 && z.points.length === 2
    && z.points[0].y === 0 && z.points[1].y === 127;
}
const defaultOutputs = key => ({
  midi:   { zones: defaultZones(key) },
  analog: { zones: defaultAnalogZones(key) },
});

/* one library file: the zones of both axes for ONE output */
const mkFile = (name, axesZones) => ({ id: uid(), name, axes: JSON.parse(JSON.stringify(axesZones)) });
const emptySlot = () => ({ midi: null, analog: null });
/* a Set List: a name, the MIDI bank number that recalls it, and its slots */
const mkSetlist = (name, bank) => ({ id: uid(), name, bank: bank || 0, slots: [] });
const activeSL = () => state.setlists.find(x => x.id === state.activeSetlist) || state.setlists[0];
const slots = () => activeSL().slots;

function defaultState() {
  return {
    tab: 'midi',
    names: { midi: 'INIT', analog: 'INIT' },    /* SETUP field, per output tab */
    loaded: { midi: null, analog: null },        /* library file id per output tab */
    axes: {
      yaw: {
        key: 'yaw', label: 'YAW', sub: 'left → right',
        endLabels: ['LEFT', 'RIGHT'], freeze: 'PITCH',
        sim: 0.5, outputs: defaultOutputs('yaw'),
      },
      pitch: {
        key: 'pitch', label: 'PITCH', sub: 'heel → toe',
        endLabels: ['HEEL', 'TOE'], freeze: 'YAW',
        sim: 0.35, outputs: defaultOutputs('pitch'),
      },
    },
    library: { midi: [], analog: [] },
    setlists: [mkSetlist('SET LIST 1', 0)],      /* slots: [{midi: fileId|null, analog: fileId|null}] */
    activeSetlist: null,                         /* id; null = the first */
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

/* in place: give every axis outputs.{midi,analog}.zones (idempotent) */
function migrateAxes(axes, layerOn) {
  for (const key of ['yaw', 'pitch']) {
    const a = axes[key];
    if (a.outputs) {
      for (const tab of ['midi', 'analog']) for (const z of a.outputs[tab].zones) if (z.speedMs === undefined) z.speedMs = DEFAULT_SWITCH_MS;
      continue;
    }
    if (a.zones) {           /* v1.8: a single zone set = the MIDI tab */
      a.outputs = { midi: { zones: a.zones }, analog: { zones: defaultAnalogZones(key) } };
      delete a.zones;
      continue;
    }
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
    a.outputs = { midi: { zones }, analog: { zones: defaultAnalogZones(key) } };
    delete a.layers; delete a.points; delete a.spans; delete a.regions; delete a.smooth; delete a.baseCC;
  }
  return axes;
}

/* v1.2–v1.9 kept ONE library of whole Setups and a Set List of their ids.
   Split each into a MIDI file and an Analog file; the Set List slots keep
   both, so nothing the user arranged is lost. */
function migrateLibrary(s) {
  if (Array.isArray(s.library)) {
    const lib = { midi: [], analog: [] };
    const map = {};
    for (const en of s.library) {
      if (!en.axes) continue;
      migrateAxes(en.axes, en.layerOn);
      const m = mkFile(en.name, { yaw: en.axes.yaw.outputs.midi.zones, pitch: en.axes.pitch.outputs.midi.zones });
      const an = {};
      for (const k of ['yaw', 'pitch']) {
        const az = en.axes[k].outputs.analog.zones;
        an[k] = isPlainRamp(az) ? mirrorToAnalog(en.axes[k].outputs.midi.zones) : az;
      }
      const a = mkFile(en.name, an);
      lib.midi.push(m); lib.analog.push(a);
      map[en.id] = { midi: m.id, analog: a.id };
    }
    s.setlist = (s.setlist || []).map(id => (map[id] ? { ...map[id] } : null)).filter(Boolean);
    s.loaded = s.loadedId && map[s.loadedId] ? { ...map[s.loadedId] } : { midi: null, analog: null };
    const nm = (s.program && s.program.name) || 'INIT';
    s.names = { midi: nm, analog: nm };
    s.library = lib;
    delete s.loadedId; delete s.program;
  }
  s.library = s.library || { midi: [], analog: [] };
  s.library.midi = s.library.midi || [];
  s.library.analog = s.library.analog || [];
  /* v1.9's single Set List → the first of many */
  if (!s.setlists) {
    const first = mkSetlist('SET LIST 1', 0);
    first.slots = (s.setlist || []).map(sl => (typeof sl === 'object' && sl ? { midi: sl.midi || null, analog: sl.analog || null } : null)).filter(Boolean);
    s.setlists = [first];
    delete s.setlist;
  }
  if (!s.setlists.length) s.setlists = [mkSetlist('SET LIST 1', 0)];
  for (const l of s.setlists) { l.slots = l.slots || []; l.bank = l.bank || 0; l.name = l.name || 'SET LIST'; }
  if (!s.setlists.find(x => x.id === s.activeSetlist)) s.activeSetlist = s.setlists[0].id;
  s.loaded = s.loaded || { midi: null, analog: null };
  s.names = s.names || { midi: 'INIT', analog: 'INIT' };
  if (!s.analogMirrored) {
    for (const sl of s.setlists.flatMap(l => l.slots)) {
      const m = sl.midi && s.library.midi.find(f => f.id === sl.midi);
      const a = sl.analog && s.library.analog.find(f => f.id === sl.analog);
      if (!m || !a) continue;
      for (const k of ['yaw', 'pitch']) if (isPlainRamp(a.axes[k])) a.axes[k] = mirrorToAnalog(m.axes[k]);
    }
    for (const k of ['yaw', 'pitch']) {
      const ax = s.axes[k];
      if (isPlainRamp(ax.outputs.analog.zones)) {
        const a = s.loaded.analog && s.library.analog.find(f => f.id === s.loaded.analog);
        ax.outputs.analog.zones = a ? JSON.parse(JSON.stringify(a.axes[k])) : mirrorToAnalog(ax.outputs.midi.zones);
      }
    }
    s.analogMirrored = true;
  }
  fillSlots(s);
  if (!s.switchSpeed01) {          /* one-time reset to the 0.1 m/s default */
    const all = [];
    for (const k of ['yaw', 'pitch']) for (const tab of TAB_ORDER) all.push(...s.axes[k].outputs[tab].zones);
    for (const tab of TAB_ORDER) for (const f of s.library[tab]) for (const k of ['yaw', 'pitch']) all.push(...(f.axes[k] || []));
    for (const z of all) if (z.type === 'switch' || z.speedMs !== undefined) z.speedMs = DEFAULT_SWITCH_MS;
    s.switchSpeed01 = true;
  }
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.axes && s.axes.yaw && s.axes.pitch) {
        if (s.globalCh === undefined) s.globalCh = 16;
        if (!OUTPUTS[s.tab]) s.tab = 'midi';
        migrateAxes(s.axes, s.layerOn);
        migrateLibrary(s);
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
const orderZones = zs => [...zs].sort((a, b) => rank(a) - rank(b) || width(b) - width(a));
const drawOrder = axis => orderZones(Z(axis));
const zoneById = (axis, id) => Z(axis).find(z => z.id === id) || null;
const zonesAt = (axis, t) => Z(axis).filter(z => t >= z.lo - 1e-9 && t <= z.hi + 1e-9);
/* Two overlapping Controller zones normally both send. If they share the
   same transmit channel AND CC they would fight over one controller, so
   the topmost (narrowest) one wins in the overlap and the other goes quiet. */
/* same target: MIDI = same channel + CC · analog = same jack */
const sameCC = (a, b) => a.type === 'ctl' && b.type === 'ctl'
  && (state.tab === 'analog' || (a.ch === b.ch && a.cc === b.cc));
const overlaps = (a, b) => a.hi > b.lo && a.lo < b.hi;
function isAbove(axis, a, b) {           /* is a drawn on top of b? */
  const o = drawOrder(axis);
  return o.indexOf(a) > o.indexOf(b);
}
/* zones that silence z: Note / Freeze / Dead zones, plus same-CC Controllers
   above it. On MIDI a Switch is a separate message and never masks. On
   Analog Out the jack carries ONE voltage, so a Switch that is ON overrides
   the Controller beneath it; off, the Controller's value comes through. */
const switchMasks = o => o.type === 'switch' && state.tab === 'analog' && !!simSwitch[o.id];
const blockers = (axis, z) => Z(axis).filter(o =>
  o !== z && overlaps(o, z)
  && (o.type === 'switch' ? switchMasks(o) : (o.type !== 'ctl' || (sameCC(o, z) && isAbove(axis, o, z)))));
/* is Controller zone z actually sending at travel t? */
const ctlActive = (axis, z, t) =>
  t >= z.lo && t <= z.hi && !blockers(axis, z).some(o => t >= o.lo && t <= o.hi);
/* does z share channel+CC with another Controller it overlaps? (shown amber) */
const ccConflict = (axis, z) => Z(axis).some(o => o !== z && overlaps(o, z) && sameCC(o, z));
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
  const order = orderZones(c);   /* last drawn = on top */
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
  const analog = state.tab === 'analog';
  if (z.type === 'dead') return 'DEAD';
  if (z.type === 'freeze') return 'FRZ ' + axis.freeze;
  if (z.type === 'note') return '♪ ' + noteName(z.note) + ' ch' + z.ch;
  if (z.type === 'switch') {
    const st = simSwitch[z.id] ? ' · ON' : '';
    if (analog) return `⚡ ${toV(z.offVal).toFixed(1)}/${toV(z.onVal).toFixed(1)}V${st}`;
    return '⚡ ' + (z.action === 'cc' ? 'CC' + z.cc : noteName(z.note)) + ' ch' + z.ch + st;
  }
  return analog ? 'CV' : `CH${z.ch} · CC${z.cc}`;
}

/* what a zone does at the sim marker (null = nothing) */
function zoneOutput(axis, z, t) {
  const analog = state.tab === 'analog';
  if (z.type === 'ctl') {
    if (!ctlActive(axis, z, t)) return null;
    const v = curveValue(z, t);
    return analog ? `${toV(v).toFixed(2)}V` : `CC${z.cc} ch${z.ch}=${Math.round(v)}`;
  }
  if (z.type === 'freeze') return `FRZ ${axis.freeze}`;
  if (z.type === 'note') return `♪${noteName(z.note)} ch${z.ch} v${z.vel}`;
  if (z.type === 'switch') {
    const on = !!simSwitch[z.id];
    /* analog: the switch IS the jack's voltage while on; off it is silent
       and the Controller underneath shows instead */
    if (analog) return on ? `⚡${toV(z.onVal).toFixed(2)}V` : null;
    return `⚡${z.action === 'cc' ? 'CC' + z.cc : noteName(z.note)} ${on ? 'ON' : 'off'}`;
  }
  return null;
}

/* runtime-only: which Switch zones the sim marker has toggled on, and when
   each last toggled either way (for the brief glow that marks the toggle) */
const simSwitch = {};
const simFlash = {};
const FLASH_MS = 1500;

/* ── geometry / rendering ────────────────────────────────────────── */

const GEO = { left: 44, right: 14, bottom: 44, height: 240, chipRow: 19 };
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
          <button class="ghostbtn savebtn" data-save type="button" title="save this tab's Setup to its Library (lights up when this axis has unsaved changes)">save</button>
          <button class="ghostbtn" data-addzone type="button" title="add a zone — pick its type in the popover">+ Zone</button>
        </div>
      </div>
      <div class="editor-well"><svg data-axis="${key}"></svg></div>`;
    main.appendChild(panel);
    const svg = panel.querySelector('svg');
    editors[key] = { svg, outEl: panel.querySelector('[data-out]'), saveBtn: panel.querySelector('[data-save]') };
    editors[key].saveBtn.addEventListener('click', () => {
      saveProgram(false);
      flashProgName();
    });
    panel.querySelector('[data-addzone]').addEventListener('click', e => addZone(axis, e.clientX, e.clientY));
    wireEditor(svg, axis);
  }
}

/* chips for Controller zones sit above the strip; overlapping zones get
   their chips on separate rows so nothing collides */
function chipLayout(axis, g) {
  const ctl = OUT().chips ? Z(axis).filter(z => z.type === 'ctl').sort((a, b) => a.lo - b.lo) : [];
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
  for (const v of [0, 63.5, 127]) {
    const y = g.ty(v);
    parts.push(`<line x1="${g.x0}" y1="${y}" x2="${g.x1}" y2="${y}" stroke="var(--well-line)" stroke-dasharray="2 5"/>`);
    parts.push(`<text x="${g.x0 - 8}" y="${y + 3}" font-size="9" text-anchor="end">${OUT().gridLabel(v === 63.5 ? 64 : v)}</text>`);
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
    /* Switch look: ON = bright band with a solid border, OFF = the normal
       band. Either toggle also glows the border for FLASH_MS. */
    const swOn = z.type === 'switch' && !!simSwitch[z.id];
    const flashing = z.type === 'switch' && simFlash[z.id] && (performance.now() - simFlash[z.id]) < FLASH_MS;
    const fillOp = dead ? 1 : (z.type === 'ctl' ? 0.09 : (swOn ? 0.5 : 0.16));
    const edge = dead ? 'var(--dead-edge)' : col.c;
    parts.push(`<rect x="${xa}" y="${g.y0}" width="${xb - xa}" height="${g.y1 - g.y0}" fill="${fill}" fill-opacity="${fillOp}" data-role="zone" data-id="${z.id}" style="cursor:grab"/>`);
    if (swOn || flashing) {
      const ci = (z.color || 0) % PALETTE.length;
      parts.push(`<rect x="${xa + 1}" y="${g.y0 + 1}" width="${xb - xa - 2}" height="${g.y1 - g.y0 - 2}" fill="none" stroke="${col.c}" stroke-width="${flashing ? 2.5 : 1.5}" rx="3" ${flashing ? `filter="url(#glow-${axis.key}-${ci})"` : 'stroke-opacity="0.9"'} pointer-events="none"/>`);
    }
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
  for (const z of Z(axis)) {
    if (z.type === 'switch' && switchMasks(z) && axis.sim >= z.lo && axis.sim <= z.hi) {
      const sy = g.ty(z.onVal);
      parts.push(`<circle cx="${sx}" cy="${sy}" r="3.5" fill="var(--sim)" filter="url(#glow-sim-${axis.key})" pointer-events="none"/>`);
      continue;
    }
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
    .sort((a, b) => (a.type === 'switch') - (b.type === 'switch') || a.lo - b.lo)
    .map(z => zoneOutput(axis, z, axis.sim))
    .filter(Boolean);
  ed.outEl.textContent = outs.length ? outs.join(' · ') : 'DEAD';
}

function commit(axis) {
  for (const z of Z(axis)) if (z.type === 'ctl') normalizePoints(z);
  render(axis);
  saveState();
  updateSaveButtons();
}

/* an axis's Save lights when its zones (or the Setup name) differ from the
   tab's loaded file — or when nothing is loaded yet, so the work gets saved */
function axisDirty(axis) {
  const tab = state.tab;
  const f = state.loaded[tab] ? libFile(state.loaded[tab], tab) : null;
  if (!f) return true;
  const name = (state.names[tab] || 'UNTITLED').toUpperCase().slice(0, 10);
  return name !== f.name || JSON.stringify(Z(axis)) !== JSON.stringify(f.axes[axis.key]);
}
function updateSaveButtons() {
  for (const key of ['yaw', 'pitch']) {
    const ed = editors[key];
    if (ed && ed.saveBtn) ed.saveBtn.classList.toggle('on', axisDirty(state.axes[key]));
  }
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
    if (drag.role === 'sim') simTrack = { t: axis.sim, time: performance.now(), hist: [] };
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
   the marker must leave the zone before it can fire again. Speed is the
   average over the last SPEED_WINDOW_MS so single jittery events don't count. */
function simMove(axis, t, track) {
  const now = performance.now();
  track.hist = (track.hist || []).filter(h => now - h.time <= SPEED_WINDOW_MS);
  track.hist.push({ t, time: now });
  const first = track.hist[0];
  const dt = (now - first.time) / 1000;
  const speed = dt > 0.015 ? Math.abs(t - first.t) * SPAN_M / dt : 0;   /* m/s along the travel */
  for (const z of Z(axis)) {
    if (z.type !== 'switch') continue;
    const wasIn = track.t >= z.lo && track.t <= z.hi;
    const nowIn = t >= z.lo && t <= z.hi;
    if (!wasIn && nowIn && speed >= z.speedMs) {
      simSwitch[z.id] = !simSwitch[z.id];
      simFlash[z.id] = now;                                /* glow marks the toggle, on or off */
      setTimeout(() => render(axis), FLASH_MS + 30);       /* then settle to the on/off look */
    }
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
  Z(axis).push(z);
  commit(axis);
  openZonePopover(axis, z, cx, cy);
}
function nextCC(axis) {
  const used = new Set(Z(axis).filter(z => z.type === 'ctl').map(z => z.cc));
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
  const analog = state.tab === 'analog';
  openPopover(`
    <h3><span class="amb-led" style="--amb-led-color:${col.c}"></span>${end ? 'End point' : 'Point'}
      <span class="pop-note">${state.tab === 'analog' ? 'EXP ' + jackOf(axis) : zoneShortLabel(axis, z)}</span></h3>
    <div class="pop-rows">
      ${numRow('Travel %', 'ppx', (p.x * 100).toFixed(1), 0, 100, end ? 'readonly' : '')}
      ${analog ? numRow('Volts', 'ppy', toV(p.y).toFixed(2), 0, VOLTS, 'step="0.01"') : numRow('Value', 'ppy', Math.round(p.y), 0, 127)}
      ${end ? '<div class="pop-note">end points follow the zone\'s edges — drag the edge to move it</div>'
            : '<button class="dangerbtn" id="pdel" type="button">delete point</button>'}
    </div>`, cx, cy);
  if (!end) wireNum(axis, 'ppx', v => { p.x = Math.max(z.lo, Math.min(z.hi, v / 100)); });
  wireNum(axis, 'ppy', v => { p.y = analog ? Math.max(0, Math.min(127, fromV(v))) : clampi(v, 0, 127); });
  const del = pop.querySelector('#pdel');
  if (del) del.addEventListener('click', () => { z.points.splice(idx, 1); closePopover(); commit(axis); });
}

function openZonePopover(axis, z, cx, cy) {
  const col = colorOf(z);
  const analog = state.tab === 'analog';
  const typeOrder = ['ctl', 'note', 'switch', 'dead', 'freeze'].filter(t => OUT().types.includes(t));   /* Freeze last: full-width button */
  const typeBtns = typeOrder.map(zoneType).map(t => `
    <button class="type-btn ${t.id === 'freeze' ? 'wide' : ''} ${z.type === t.id ? 'on' : ''}" data-type="${t.id}" type="button" title="${t.label}">
      <span class="ico">${t.icon}</span>${t.id === 'freeze' ? 'Freeze ' + axis.freeze + ' value' : t.label}
    </button>`).join('');
  const swatches = PALETTE.map((p, i) => `
    <button class="swatch ${((z.color || 0) % PALETTE.length) === i ? 'on' : ''}" data-color="${i}" type="button"
      style="--sw:${p.c}" title="${p.name}"></button>`).join('');

  let rows = '';
  if (z.type === 'ctl') {
    rows = `${analog ? '' : `${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${numRow('CC #', 'zcc', z.cc, 0, 127)}`}
      <div class="pop-row"><label>Response curve</label>
        <button class="ghostbtn ${z.smooth ? 'on' : ''}" id="zsmooth" type="button" title="linear ↔ smooth (monotone cubic) interpolation between the points">smooth</button></div>
      <div class="pop-note">drag the end points to set the output range · double-click the curve to add points</div>
      ${ccConflict(axis, z) ? `<div class="pop-note warn">overlaps another controller zone${analog ? '' : ' on the same channel + CC'} — where they overlap only the topmost (narrowest) one sends</div>` : ''}`;
  } else if (z.type === 'note') {
    rows = `${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${numRow('Note #', 'znote', z.note, 0, 127)}
      <div class="pop-row"><label>Note</label><span class="pop-note" id="znName">${noteName(z.note)}</span></div>
      ${numRow('Velocity', 'zvel', z.vel, 1, 127)}
      <div class="pop-note">note on when the pedal enters the zone, note off when it leaves</div>`;
  } else if (z.type === 'switch' && analog) {
    rows = `${numRow('On volts', 'zonv', toV(z.onVal).toFixed(2), 0, VOLTS, 'step="0.01"')}
      ${numRow('Off volts', 'zoffv', toV(z.offVal).toFixed(2), 0, VOLTS, 'step="0.01"')}
      ${numRow('Speed m/s', 'zspeed', z.speedMs.toFixed(2), 0.05, 3, 'step="0.05"')}
      <div class="pop-note">a fast entry (faster than Speed) toggles it · while ON the jack holds the on voltage and the controller underneath is silenced · off, the controller's curve is the output</div>`;
  } else if (z.type === 'switch') {
    rows = `<div class="pop-row"><label>Action</label>
        <div class="seg"><button class="${z.action !== 'cc' ? 'on' : ''}" data-action="note" type="button">Note</button><button class="${z.action === 'cc' ? 'on' : ''}" data-action="cc" type="button">CC</button></div></div>
      ${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${z.action === 'cc'
        ? `${numRow('CC #', 'zcc', z.cc, 0, 127)}${numRow('On value', 'zon', z.onVal, 0, 127)}${numRow('Off value', 'zoff', z.offVal, 0, 127)}`
        : `${numRow('Note #', 'znote', z.note, 0, 127)}
           <div class="pop-row"><label>Note</label><span class="pop-note" id="znName">${noteName(z.note)}</span></div>`}
      ${numRow('Speed m/s', 'zspeed', z.speedMs.toFixed(2), 0.05, 3, 'step="0.05"')}
      <div class="pop-note">a fast entry (faster than Speed) toggles on / off · slow entry does nothing · controllers underneath keep sending</div>`;
  } else if (z.type === 'freeze') {
    rows = `<div class="pop-note">while the pedal is in this zone the ${axis.freeze} value is held</div>`;
  } else {
    rows = `<div class="pop-note">travel here is ignored — this zone masks any controller zone underneath it</div>`;
  }

  openPopover(`
    <h3><span class="amb-led" style="--amb-led-color:${z.type === 'dead' ? '#6b7280' : col.c}"></span>${zoneType(z.type).icon} ${zoneType(z.type).label} zone <span class="pop-tag">${OUT().tag}</span></h3>
    <div class="pop-rows">
      <div class="type-list">${typeBtns}</div>
      <div class="pop-row"><label>Range %</label>
        <span class="pair"><input id="zlo" type="number" inputmode="decimal" step="0.5" value="${+(z.lo * 100).toFixed(1)}" min="0" max="100">–<input id="zhi" type="number" inputmode="decimal" step="0.5" value="${+(z.hi * 100).toFixed(1)}" min="0" max="100"></span></div>
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
  wireNum(axis, 'zonv', v => { z.onVal = Math.max(0, Math.min(127, fromV(v))); });
  wireNum(axis, 'zoffv', v => { z.offVal = Math.max(0, Math.min(127, fromV(v))); });
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
  wireNum(axis, 'zspeed', v => { z.speedMs = Math.max(0.05, Math.min(3, Math.round(v * 20) / 20)); });
  wireNum(axis, 'znote', v => {
    z.note = clampi(v, 0, 127);
    const nm = pop.querySelector('#znName');
    if (nm) nm.textContent = noteName(z.note);
  });
  const sm = pop.querySelector('#zsmooth');
  if (sm) sm.addEventListener('click', () => { z.smooth = !z.smooth; sm.classList.toggle('on', z.smooth); commit(axis); });
  pop.querySelector('#zdel').addEventListener('click', () => {
    setZ(axis, Z(axis).filter(x => x.id !== z.id));
    delete simSwitch[z.id];
    closePopover();
    commit(axis);
  });
}

/* ── librarian: per-output Library + Set List of slots ───────────── */

const libListEl = document.getElementById('libList');
const setListEl = document.getElementById('setList');
const libTitleEl = document.getElementById('libTitle');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const lib = tab => state.library[tab || state.tab];
function libFile(id, tab) { return lib(tab).find(x => x.id === id) || null; }
const curName = () => (state.names[state.tab] || 'UNTITLED').toUpperCase().slice(0, 10);
const axesZones = tab => ({ yaw: state.axes.yaw.outputs[tab].zones, pitch: state.axes.pitch.outputs[tab].zones });

/* the current tab's loaded file's 1-based Set List position (its PC number), or null */
function loadedPC() {
  const id = state.loaded[state.tab];
  const i = id ? slots().findIndex(sl => sl[state.tab] === id) : -1;
  return i >= 0 ? i + 1 : null;
}

/* Save the CURRENT tab's zones as a file in that tab's library */
function saveProgram(asNew, tab) {
  tab = tab || state.tab;
  const name = (state.names[tab] || 'UNTITLED').toUpperCase().slice(0, 10);
  let f = !asNew && state.loaded[tab] ? libFile(state.loaded[tab], tab) : null;
  if (f) {
    f.name = name;
    f.axes = JSON.parse(JSON.stringify(axesZones(tab)));
  } else {
    if (lib(tab).length >= MAX_SETUPS) { alert(`The ${OUTPUTS[tab].label} library holds at most ${MAX_SETUPS} Setups.`); return; }
    f = mkFile(name, axesZones(tab));
    lib(tab).push(f);
    state.loaded[tab] = f.id;
  }
  saveState();
  renderLibrarian();
  updateSaveButtons();
}

/* load one file into its output tab (only that tab changes) */
function loadFile(id, tab) {
  const f = libFile(id, tab);
  if (!f) return false;
  for (const key of ['yaw', 'pitch']) state.axes[key].outputs[tab].zones = JSON.parse(JSON.stringify(f.axes[key]));
  state.names[tab] = f.name;
  state.loaded[tab] = id;
  return true;
}
function refreshEditor() {
  progName.value = state.names[state.tab];
  buildPanels();
  for (const key of ['yaw', 'pitch']) commit(state.axes[key]);
  renderLibrarian();
}
/* load a Set List slot: every output that has a file (the pedal's PC behavior) */
function loadSlot(i) {
  const sl = slots()[i];
  if (!sl) return;
  for (const tab of TAB_ORDER) if (sl[tab]) loadFile(sl[tab], tab);
  refreshEditor();
}

function renderLibrarian() {
  const tab = state.tab;
  libTitleEl.textContent = `LIBRARY · ${tab === 'analog' ? 'ANALOG' : 'MIDI'}`;
  libListEl.innerHTML = lib().length
    ? lib().map(f => `
      <li class="lib-row${f.id === state.loaded[tab] ? ' on' : ''}" data-id="${f.id}">
        <span class="lib-name">${esc(f.name)}</span>
        <button class="rowbtn" data-del type="button" title="delete this Setup">×</button>
      </li>`).join('')
    : `<li class="lib-empty">empty — SAVE stores the current ${OUT().label} Setup</li>`;
  renderSetlistTools();
  setListEl.innerHTML = slots().length
    ? slots().map((sl, i) => {
      const mine = sl[tab] ? libFile(sl[tab], tab) : null;
      return `
      <li class="set-row${mine && mine.id === state.loaded[tab] ? ' on' : ''}${mine ? '' : ' none'}" data-idx="${i}">
        <span class="pc">${i + 1}</span>
        <span class="lib-name">${mine ? esc(mine.name) : '— no ' + OUTPUTS[tab].tag + ' setup —'}</span>
        <button class="rowbtn" data-del type="button" title="remove slot">×</button>
      </li>`;
    }).join('')
    : `<li class="lib-empty">drag Setups here — order sets the PC #</li>`;
  progNum.value = loadedPC() ?? '—';
}

/* ── Set List tools: one dropdown, + new, edit (dialog) ──────────── */

const slSelect = document.getElementById('slSelect');
function renderSetlistTools() {
  const l = activeSL();
  slSelect.innerHTML = state.setlists.map(x =>
    `<option value="${x.id}"${x.id === l.id ? ' selected' : ''}>${esc(x.name)} · bank ${x.bank}</option>`).join('');
}
slSelect.addEventListener('change', () => {
  guardUnsaved('switching Set Lists', () => {
    state.activeSetlist = slSelect.value;
    saveState();
    renderLibrarian();
  });
  renderSetlistTools();   /* snap the select back if the guard was cancelled */
});

/* the dialog serves both "new" and "edit" */
const slWrap = document.getElementById('slWrap');
const slName = document.getElementById('slName');
const slBank = document.getElementById('slBank');
const slDel = document.getElementById('slDel');
let slEditing = null;   /* the Set List being edited, or null when creating */
function openSetlistDialog(l) {
  slEditing = l;
  document.getElementById('slTitle').textContent = l ? 'EDIT SET LIST' : 'NEW SET LIST';
  document.querySelector('#slOk .amb-button-cap').textContent = l ? 'Save' : 'Create';
  slDel.hidden = !l;
  if (l) { slName.value = l.name; slBank.value = l.bank; }
  else {
    const used = new Set(state.setlists.map(x => x.bank));
    let bank = 0; while (used.has(bank) && bank < 127) bank++;
    slName.value = `SET LIST ${state.setlists.length + 1}`; slBank.value = bank;
  }
  slWrap.hidden = false;
  slName.focus(); slName.select();
}
function closeSetlistDialog() { slWrap.hidden = true; slEditing = null; }
document.getElementById('slNew').addEventListener('click', () => {
  if (state.setlists.length >= MAX_SETLISTS) { alert(`At most ${MAX_SETLISTS} Set Lists.`); return; }
  openSetlistDialog(null);
});
document.getElementById('slEdit').addEventListener('click', () => openSetlistDialog(activeSL()));
document.getElementById('slCancel').addEventListener('click', closeSetlistDialog);
document.getElementById('slScrim').addEventListener('click', closeSetlistDialog);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !slWrap.hidden) closeSetlistDialog(); });
document.getElementById('slOk').addEventListener('click', () => {
  const name = (slName.value || 'SET LIST').toUpperCase().slice(0, 10).trim() || 'SET LIST';
  const bank = clampi(parseFloat(slBank.value), 0, 127);
  const clash = state.setlists.find(x => x !== slEditing && x.bank === bank);
  if (clash && !confirm(`Bank ${bank} already recalls "${clash.name}". Use it for this one too? (Bank Select will pick whichever comes first.)`)) return;
  if (slEditing) { slEditing.name = name; slEditing.bank = bank; }
  else {
    const l = mkSetlist(name, bank);
    state.setlists.push(l);
    state.activeSetlist = l.id;
  }
  closeSetlistDialog();
  saveState();
  renderLibrarian();
});
slName.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('slOk').click(); });
slBank.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('slOk').click(); });
slDel.addEventListener('click', () => {
  const l = slEditing;
  if (!l) return;
  if (!confirm(`Delete Set List "${l.name}"?${l.slots.length ? ` It has ${l.slots.length} slot${l.slots.length > 1 ? 's' : ''}.` : ''} (Setups stay in the Library.)`)) return;
  state.setlists = state.setlists.filter(x => x !== l);
  if (!state.setlists.length) state.setlists.push(mkSetlist('SET LIST 1', 0));
  state.activeSetlist = state.setlists[0].id;
  closeSetlistDialog();
  saveState();
  renderLibrarian();
});

libListEl.addEventListener('click', e => {
  const row = e.target.closest('.lib-row');
  if (!row) return;
  const id = row.dataset.id;
  const tab = state.tab;
  if (e.target.closest('[data-del]')) {
    const f = libFile(id, tab);
    const used = state.setlists.flatMap(l => l.slots).filter(sl => sl[tab] === id).length;
    if (!confirm(`Delete "${f ? f.name : '?'}" from the ${OUT().label} library?${used ? ` It is used by ${used} set list slot${used > 1 ? 's' : ''}.` : ''}`)) return;
    state.library[tab] = lib().filter(x => x.id !== id);
    for (const l of state.setlists) {
      for (const sl of l.slots) if (sl[tab] === id) sl[tab] = null;
      l.slots = l.slots.filter(sl => TAB_ORDER.some(t => sl[t]));   /* drop slots left empty */
    }
    fillSlots(state);   /* a slot that still has its other output gets a fresh mirror */
    if (state.loaded[tab] === id) state.loaded[tab] = null;
    saveState();
    renderLibrarian();
    updateSaveButtons();
    return;
  }
  if (e.target.closest('.grip')) return;
  if (id === state.loaded[tab] && !isDirty(tab)) return;   /* already loaded, nothing to revert */
  guardUnsaved('loading another Setup', () => { loadFile(id, tab); refreshEditor(); });
});

setListEl.addEventListener('click', e => {
  const row = e.target.closest('.set-row');
  if (!row) return;
  const idx = +row.dataset.idx;
  if (e.target.closest('[data-del]')) {
    slots().splice(idx, 1);
    saveState();
    renderLibrarian();
    return;
  }
  if (e.target.closest('.grip')) return;
  guardUnsaved('loading another slot', () => loadSlot(idx));
});

/* pointer-based row drag — grab anywhere on a bar (buttons excluded).
   A ~6px movement threshold separates a drag from a tap-to-load.
   library → set list: drop BETWEEN slots to insert a new slot holding this
   Setup, drop ONTO a slot to put this Setup into that slot's tab.
   set list ↕ reorders · set list → library removes the slot. */
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
    let ghost = null, ph = null, active = false, overLib = false, dropIdx = 0, ontoIdx = -1;

    const clearOnto = () => setListEl.querySelectorAll('.set-row.onto').forEach(x => x.classList.remove('onto'));

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
      clearOnto(); ontoIdx = -1;
      if (!inSet || overLib) {
        active = false;
        if (ph.parentNode) ph.remove();
        return;
      }
      const rows = [...setListEl.querySelectorAll('.set-row:not(.dragging)')];
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i].getBoundingClientRect();
        /* a library file dropped on the middle half of a slot goes INTO that slot */
        if (kind === 'lib' && ev.clientY > m.top + m.height * 0.25 && ev.clientY < m.bottom - m.height * 0.25) {
          ontoIdx = +rows[i].dataset.idx;
          rows[i].classList.add('onto');
          active = true;
          if (ph.parentNode) ph.remove();
          return;
        }
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
      clearOnto();
      libListEl.classList.remove('drop-remove');
      if (active) {
        if (kind === 'lib') {
          if (ontoIdx >= 0) {
            slots()[ontoIdx][state.tab] = id;
          } else if (slots().length >= MAX_SLOTS) {
            alert(`A Set List holds at most ${MAX_SLOTS} slots (the Program Change range).`);
          } else {
            const sl = emptySlot(); sl[state.tab] = id;
            slots().splice(dropIdx, 0, sl);
          }
          fillSlots(state);
        } else {
          const [moved] = slots().splice(oldIdx, 1);
          slots().splice(dropIdx, 0, moved);
        }
        saveState();
      } else if (overLib) {
        slots().splice(oldIdx, 1);
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

/* + new: save the current tab's zones as a NEW Setup under the SETUP name */
document.getElementById('saveNewBtn').addEventListener('click', () => guardUnsaved('creating a new Setup', () => {
  saveProgram(true);
  flashProgName();
}));

/* ── v1.7: unsaved-changes guard (per output tab) ─────────────────
   A tab is "dirty" when its editor differs from its loaded file. Anything
   that would replace editor contents goes through guardUnsaved(): clean →
   proceed; dirty → Save (every dirty tab) / Discard / Cancel. */
function isDirty(tab) {
  tab = tab || state.tab;
  const f = state.loaded[tab] ? libFile(state.loaded[tab], tab) : null;
  if (!f) return false;
  const name = (state.names[tab] || 'UNTITLED').toUpperCase().slice(0, 10);
  return name !== f.name || JSON.stringify(axesZones(tab)) !== JSON.stringify(f.axes);
}
const dirtyTabs = () => TAB_ORDER.filter(t => isDirty(t));
const askWrap = document.getElementById('askWrap');
let askThen = null;
function guardUnsaved(what, then) {
  const d = dirtyTabs();
  if (!d.length) { then(); return; }
  const list = d.map(t => `${OUTPUTS[t].label} "${libFile(state.loaded[t], t).name}"`).join(' and ');
  document.getElementById('askText').textContent = `${list} ${d.length > 1 ? 'have' : 'has'} unsaved changes. Save before ${what}?`;
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
  for (const tab of dirtyTabs()) saveProgram(false, tab);
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

/* Bank Select (CC 0) on the receive channel picks the Set List with that
   bank number; the next Program Change recalls a slot within it. */
function receiveBankSelect(ch, bank) {
  const gch = state.globalCh;
  if (gch !== 'omni' && ch !== gch) return { ok: false, msg: `bank ${bank} ch${ch} — ignored (receive ch ${gch})` };
  const l = state.setlists.find(x => x.bank === bank);
  if (!l) return { ok: false, msg: `bank ${bank} ch${ch} — no Set List has that bank` };
  state.activeSetlist = l.id;
  saveState();
  renderLibrarian();
  return { ok: true, msg: `bank ${bank} ch${ch} → Set List "${l.name}"` };
}

/* the device rule: a PC on the receive channel recalls that slot of the
   current Set List — every output at once */
function receiveProgramChange(ch, pc, force) {
  const gch = state.globalCh;
  if (gch !== 'omni' && ch !== gch) {
    return { ok: false, msg: `PC ${pc} ch${ch} — ignored (receive ch ${gch})` };
  }
  const sl = slots()[pc - 1];
  if (!sl) {
    return { ok: false, msg: `PC ${pc} ch${ch} — "${activeSL().name}" has no slot ${pc}` };
  }
  if (!force && dirtyTabs().length) {
    /* ask first; on Save/Discard re-run with force so we don't ask twice */
    guardUnsaved(`switching to set list slot ${pc}`, () => showMiLog(receiveProgramChange(ch, pc, true)));
    return { ok: false, msg: `PC ${pc} ch${ch} — waiting: unsaved changes` };
  }
  loadSlot(pc - 1);
  const row = setListEl.querySelector(`.set-row[data-idx="${pc - 1}"]`);
  if (row) {
    row.classList.add('rx');
    row.addEventListener('animationend', () => row.classList.remove('rx'), { once: true });
  }
  const names = TAB_ORDER.map(t => sl[t] ? `${OUTPUTS[t].tag}:"${libFile(sl[t], t).name}"` : `${OUTPUTS[t].tag}:—`).join(' ');
  return { ok: true, msg: `PC ${pc} ch${ch} → slot ${pc} · ${names}` };
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
  const ch = +miCh.value;
  const bankRaw = document.getElementById('miBank').value.trim();
  const pc = clampi(parseFloat(document.getElementById('miPc').value), 1, 128);
  if (bankRaw !== '') {
    const b = receiveBankSelect(ch, clampi(parseFloat(bankRaw), 0, 127));
    if (!b.ok) { showMiLog(b); return; }
    const r = receiveProgramChange(ch, pc);
    showMiLog({ ok: r.ok, msg: `${b.msg} · ${r.msg}` });
    return;
  }
  showMiLog(receiveProgramChange(ch, pc));
});

/* brief confirmation on the SETUP field after a save (same glow as a MIDI-in load) */
function flashProgName() {
  const el = document.getElementById('progName');
  el.classList.remove('saved');
  void el.offsetWidth;   // restart the animation if it's still running
  el.classList.add('saved');
  el.addEventListener('animationend', () => el.classList.remove('saved'), { once: true });
}

/* ── Setup fields / reset / boot ─────────────────────────────────── */

const progNum = document.getElementById('progNum');
const progName = document.getElementById('progName');
progName.value = state.names[state.tab];
progName.addEventListener('input', () => { state.names[state.tab] = progName.value.toUpperCase().slice(0, 10); saveState(); updateSaveButtons(); });

document.getElementById('resetBtn').addEventListener('click', () => guardUnsaved('resetting the demo', () => {
  if (!confirm('Reset the demo? This also clears the Library and Set List.')) return;
  state = defaultState();
  updateOutTabs();
  refreshEditor();
}));

/* ── export / import: the whole librarian as one .json file ─────── */

function exportFile() {
  const doc = {
    format: 'orbit-ui-library',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    receiveChannel: state.globalCh,
    library: state.library,      /* { midi: [files], analog: [files] } */
    setlists: state.setlists,    /* [{ id, name, bank, slots: [{ midi: id, analog: id }] }] */
    activeSetlist: state.activeSetlist,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `orbit-setups-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importFile(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { alert('That file is not valid JSON.'); return; }
  if (!doc || doc.format !== 'orbit-ui-library' || !doc.library || !doc.library.midi || !doc.library.analog) {
    alert('That file is not an Orbit UI library export.'); return;
  }
  const lists = doc.setlists || (doc.setlist ? [{ name: 'SET LIST 1', bank: 0, slots: doc.setlist }] : []);
  const nSlots = lists.reduce((n, l) => n + (l.slots || []).length, 0);
  if (!confirm(`Replace your Library and Set Lists with this file? (${doc.library.midi.length} MIDI + ${doc.library.analog.length} Analog Setups, ${lists.length} Set List${lists.length === 1 ? '' : 's'}, ${nSlots} slots)`)) return;
  state.library = { midi: doc.library.midi, analog: doc.library.analog };
  state.setlists = lists.map(l => ({ id: l.id || uid(), name: l.name, bank: l.bank || 0, slots: l.slots || [] }));
  state.activeSetlist = doc.activeSetlist || null;
  delete state.setlist;
  if (doc.receiveChannel !== undefined) { state.globalCh = doc.receiveChannel; globalChSel.value = String(state.globalCh); }
  state.loaded = { midi: null, analog: null };
  migrateLibrary(state);          /* validates shapes, fills any half-empty slots */
  for (const f of state.library.midi.concat(state.library.analog)) for (const k of ['yaw', 'pitch']) f.axes[k] = f.axes[k] || [];
  if (slots().length) loadSlot(0); else refreshEditor();
  saveState();
  flashProgName();
}

document.getElementById('exportBtn').addEventListener('click', exportFile);
const importInput = document.getElementById('importFile');
document.getElementById('importBtn').addEventListener('click', () => guardUnsaved('importing a file', () => { importInput.value = ''; importInput.click(); }));
importInput.addEventListener('change', () => {
  const file = importInput.files && importInput.files[0];
  if (!file) return;
  file.text().then(importFile);
});

document.getElementById('appVersion').textContent = 'v' + APP_VERSION;

/* ── output tabs: MIDI · Analog Out ──────────────────────────────── */

const outTabs = [...document.querySelectorAll('.out-tab')];
function updateOutTabs() {
  outTabs.forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
}
outTabs.forEach(t => t.addEventListener('click', () => {
  if (state.tab === t.dataset.tab) return;
  closePopover();
  state.tab = t.dataset.tab;
  saveState();
  updateOutTabs();
  refreshEditor();
}));
updateOutTabs();

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
