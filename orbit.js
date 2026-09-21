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
   together by one program change.
   v1.15: the GROUND CONTROL tab (gc/tab.js) — the unit's own editor, ported.
   Its Library column is the unit's Setup bank; a Set List slot's `gc` entry
   names a slot on the unit (e.g. 'B3') that recalls with the others. */

'use strict';

/* Bump on every feature addition; shown in the header and exports. */
const APP_VERSION = '1.19';   /* also bump the ?v= on the script tags in index.html */

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

/* zone colors — indigo and magenta first (the v1.5 layer colors). No red
   and no green, per David: about 1 in 12 men can't tell them apart. */
const PALETTE = [
  { name: 'indigo',  c: '#818cf8', pt: '#e0e7ff' },
  { name: 'magenta', c: '#e879f9', pt: '#fae8ff' },
  { name: 'cyan',    c: '#22d3ee', pt: '#cffafe' },
  { name: 'amber',   c: '#fbbf24', pt: '#fef3c7' },
  { name: 'blue',    c: '#60a5fa', pt: '#dbeafe' },
  { name: 'orange',  c: '#fb923c', pt: '#ffedd5' },
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
/* the third output has no zones: its Setups live on the Ground Control unit */
OUTPUTS.gc = {
  key: 'gc', label: 'GROUND CONTROL', tag: 'GC', chips: true,
  types: ['ctl', 'dead'],                       /* a Controller = one effect parameter; Dead masks it */
  gridLabel: v => Math.round(v / 127 * 100) + '%', valLabel: v => String(Math.round(v)),
};
const TAB_ORDER = ['midi', 'analog'];          /* the zone-editing outputs */
const SLOT_KEYS = ['midi', 'analog', 'gc'];    /* what a Set List slot can hold */
const isGC = () => state.tab === 'gc';
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
    /* controller (MIDI: channel + CC · analog: the axis's own jack)
       exit: what the output does when the pedal LEAVES the zone —
       'hold' keeps the last value, 'reset' drops it to zero */
    ch: 1, cc: 1, smooth: false, exit: 'hold',
    eff: 0, par: 0,                 /* Ground Control: the effect + parameter this zone drives */
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
  analog: { zones: defaultAnalogZones(key), invert: false },   /* invert: 5→0 V instead of 0→5 V */
  gc:     { zones: [] },                                       /* filled from the unit's loaded Setup */
});
/* the voltage a jack actually puts out for a curve value, honoring polarity */
const jackV = (axis, v) => (axis.outputs.analog.invert ? VOLTS - toV(v) : toV(v));

/* one library file: the zones of both axes for ONE output */
const mkFile = (name, axesZones) => ({ id: uid(), name, axes: JSON.parse(JSON.stringify(axesZones)) });
const emptySlot = () => ({ midi: null, analog: null, gc: null });
/* a Set List: a name, the MIDI bank number that recalls it, and its slots */
const mkSetlist = (name, bank) => ({ id: uid(), name, bank: bank || 0, slots: [] });
const activeSL = () => state.setlists.find(x => x.id === state.activeSetlist) || state.setlists[0];
const slots = () => activeSL().slots;

function defaultState() {
  return {
    tab: 'midi',
    names: { midi: 'INIT', analog: 'INIT', gc: '' },   /* SETUP field, per output tab */
    loaded: { midi: null, analog: null, gc: null },     /* library file id per output tab (gc: the unit's slot id) */
    gcSim: false,                                /* show the GROUND CONTROL tab against a simulated unit */
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
      for (const tab of ['midi', 'analog']) for (const z of a.outputs[tab].zones) {
        if (z.speedMs === undefined) z.speedMs = DEFAULT_SWITCH_MS;
        if (z.exit === undefined) z.exit = 'hold';
      }
      if (a.outputs.analog.invert === undefined) a.outputs.analog.invert = false;
      continue;
    }
    if (a.zones) {           /* v1.8: a single zone set = the MIDI tab */
      a.outputs = { midi: { zones: a.zones }, analog: { zones: defaultAnalogZones(key), invert: false } };
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
    a.outputs = { midi: { zones }, analog: { zones: defaultAnalogZones(key), invert: false } };
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
  if (s.loaded.gc === undefined) s.loaded.gc = null;
  for (const k of ['yaw', 'pitch']) if (s.axes[k] && s.axes[k].outputs && !s.axes[k].outputs.gc) s.axes[k].outputs.gc = { zones: [] };
  if (s.names.gc === undefined) s.names.gc = '';
  s.gcSim = !!s.gcSim;
  for (const l of s.setlists) for (const sl of l.slots) if (sl.gc === undefined) sl.gc = null;
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
  && (state.tab === 'analog' || (isGC() ? (a.eff === b.eff && a.par === b.par) : (a.ch === b.ch && a.cc === b.cc)));
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

/* Ground Control zones: the parameter's own units on the value axis */
const gcDef = z => GCTab.paramDef(z.eff, z.par) || { name: '?', min: 0, max: 1, step: 0.01, decimals: 2, unit: '' };
const gcUnits = (z, v) => { const d = gcDef(z); return d.min + (v / 127) * (d.max - d.min); };   /* 0–127 → units */
const gcFromUnits = (z, u) => { const d = gcDef(z); return d.max === d.min ? 0 : (u - d.min) / (d.max - d.min) * 127; };
const gcFormat = (z, v) => GCFX.formatValue(gcDef(z), gcUnits(z, v));
const gcEffName = z => (GCP.EFFECT_NAMES[z.eff] || 'eff ' + z.eff);
const gcLabel = z => `${gcEffName(z)} · ${gcDef(z).name}`.toUpperCase();

function zoneShortLabel(axis, z) {
  const analog = state.tab === 'analog';
  if (z.type === 'dead') return 'DEAD';
  if (isGC()) return gcLabel(z);
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
    if (isGC()) return `${gcDef(z).name} ${gcFormat(z, v)}`;
    return analog ? `${jackV(axis, v).toFixed(2)}V` : `CC${z.cc} ch${z.ch}=${Math.round(v)}`;
  }
  if (z.type === 'freeze') return `FRZ ${axis.freeze}`;
  if (z.type === 'note') return `♪${noteName(z.note)} ch${z.ch} v${z.vel}`;
  if (z.type === 'switch') {
    const on = !!simSwitch[z.id];
    /* analog: the switch IS the jack's voltage while on; off it is silent
       and the Controller underneath shows instead */
    if (analog) return on ? `⚡${jackV(axis, z.onVal).toFixed(2)}V` : null;
    return `⚡${z.action === 'cc' ? 'CC' + z.cc : noteName(z.note)} ${on ? 'ON' : 'off'}`;
  }
  return null;
}

/* runtime-only: per OUTPUT TARGET (a MIDI channel+CC, or an analog jack),
   the last value sent and which zone sent it — one CC has one value, so
   whichever zone sent last decides the hold / reset shown on exit */
const simLast = {};
const targetKey = (axis, z) => (state.tab === 'analog' ? `${state.tab}:${axis.key}`
  : isGC() ? `gc:${z.eff}:${z.par}` : `${state.tab}:${z.ch}:${z.cc}`);
/* runtime-only: the selected zone (tap a zone or its chip). Delete /
   Backspace removes it; Esc or a tap on empty travel clears it. */
let sel = null;   /* { axisKey, id } */
const isSel = (axis, z) => !!sel && sel.axisKey === axis.key && sel.id === z.id;
function selectZone(axis, z) {
  const prev = sel;
  sel = z ? { axisKey: axis.key, id: z.id } : null;
  if (prev && (!sel || prev.axisKey !== sel.axisKey)) render(state.axes[prev.axisKey]);
  render(axis);
  /* Ground Control: the Parameters panel lights the row this zone drives */
  if (isGC()) GCTab.pickParam(z && z.type === 'ctl' ? z.eff : null, z ? z.par : null);
}
/* Ground Control, from the Parameters panel: select the zone that drives a
   parameter (pitch first), or add one for it on the chosen axis */
function gcSelectParam(eff, par) {
  for (const key of ['pitch', 'yaw']) {
    const axis = state.axes[key];
    const z = [...drawOrder(axis)].reverse().find(x => x.type === 'ctl' && x.eff === eff && x.par === par);
    if (z) { selectZone(axis, z); return true; }
  }
  if (sel) selectZone(state.axes[sel.axisKey], null);
  return false;
}
/* take a parameter off the pedal: drop every zone that drives it, on both strips */
function gcUnmapParam(eff, par) {
  for (const key of ['pitch', 'yaw']) {
    const axis = state.axes[key];
    const gone = Z(axis).filter(z => z.type === 'ctl' && z.eff === eff && z.par === par);
    if (!gone.length) continue;
    for (const z of gone) { if (isSel(axis, z)) sel = null; for (const k of Object.keys(simLast)) if (simLast[k].zoneId === z.id) delete simLast[k]; }
    setZ(axis, Z(axis).filter(z => !gone.includes(z)));
    closePopover();
    commit(axis);
  }
  GCTab.pickParam(null, null);
}
function gcAddZoneFor(axisKey, eff, par) {
  const axis = state.axes[axisKey];
  const z = mkZone('ctl', 0.2, 0.8, { color: nextColor(axis), eff, par });
  Z(axis).push(z);
  commit(axis);
  selectZone(axis, z);
  closePopover();
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
  /* the Ground Control tab lists PITCH first, like the unit's own screens */
  for (const key of (isGC() ? ['pitch', 'yaw'] : ['yaw', 'pitch'])) {
    const axis = state.axes[key];
    const panel = document.createElement('section');
    panel.className = 'axis-panel ambient amb-surface amb-chamfer amb-elevation-2 ambx-panel amb-mat-blasted amb-rounded-xl';
    panel.innerHTML = `
      <div class="axis-head">
        <div class="axis-title"><b>${axis.label}</b><small>${axis.sub}</small></div>
        <div class="axis-out"><span class="amb-led"></span><span data-out></span></div>
        <div class="axis-tools">
          ${state.tab === 'analog' ? `<label class="polarity" title="flip the jack's output: 0→5 V or 5→0 V across the same curve">
            <span class="pol-lbl">Polarity</span>
            <input type="checkbox" data-invert ${axis.outputs.analog.invert ? 'checked' : ''}>
            <span class="pol-switch"></span>
            <span class="pol-state" data-polstate>${axis.outputs.analog.invert ? '5→0V' : '0→5V'}</span>
          </label>` : ''}
          <button class="ghostbtn savebtn" data-save type="button" title="${state.tab === 'gc' ? 'write the live state into the loaded slot on the unit (lights up when it has unsaved edits)' : 'save this tab\'s Setup to its Library (lights up when this axis has unsaved changes)'}">save</button>
          <button class="ghostbtn" data-addzone type="button" title="add a zone — pick its type in the popover">+ Zone</button>
        </div>
      </div>
      <div class="editor-well"><svg data-axis="${key}"></svg></div>`;
    main.appendChild(panel);
    const svg = panel.querySelector('svg');
    editors[key] = { svg, outEl: panel.querySelector('[data-out]'), saveBtn: panel.querySelector('[data-save]') };
    editors[key].saveBtn.addEventListener('click', () => {
      if (isGC()) { GCTab.save(); flashProgName(); return; }   /* SAVE_PRESET into the loaded slot */
      saveProgram(false);
      flashProgName();
    });
    panel.querySelector('[data-addzone]').addEventListener('click', e => addZone(axis, e.clientX, e.clientY));
    const inv = panel.querySelector('[data-invert]');
    if (inv) inv.addEventListener('change', () => {
      axis.outputs.analog.invert = inv.checked;
      panel.querySelector('[data-polstate]').textContent = inv.checked ? '5→0V' : '0→5V';
      commit(axis);
    });
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
    const w = label.length * 6.9 + 24;   /* Michroma runs wide; room for the colour dot at the left */
    const cx = (g.tx(z.lo) + g.tx(z.hi)) / 2;
    let row = rows.findIndex(right => right < cx - w / 2 - 4);
    if (row < 0) { row = rows.length; rows.push(0); }
    rows[row] = cx + w / 2;
    return { z, label, w, cx, row };
  });
  return { chips, rows: Math.max(1, rows.length) };
}

/* Ground Control: the Controller zone whose units the value axis reads in —
   the selected one on this axis, else the topmost */
const gcAxisZone = axis => (isGC()
  ? (zoneById(axis, sel && sel.axisKey === axis.key ? sel.id : null) || [...drawOrder(axis)].reverse().find(z => z.type === 'ctl') || null)
  : null);
/* the left gutter must fit the widest value label ("14000 Hz", "-12 st") */
let measureCtx = null;
function textWidth(text, px) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${px}px Michroma, sans-serif`;
  return measureCtx.measureText(text).width;
}
function gcGutter(axis) {
  const gz = gcAxisZone(axis);
  if (!gz || gz.type !== 'ctl') return GEO.left;
  let wmax = 0;
  for (const v of [0, 64, 127]) wmax = Math.max(wmax, textWidth(gcFormat(gz, v), 9));
  wmax = Math.max(wmax, textWidth(gcDef(gz).name.toUpperCase(), 8));
  return Math.max(GEO.left, Math.ceil(wmax) + 14);
}

function axisGeom(axis) {
  const svg = editors[axis.key].svg;
  const w = svg.clientWidth || svg.parentElement.clientWidth || 800;
  const x0 = isGC() ? gcGutter(axis) : GEO.left, x1 = w - GEO.right;
  const tx = t => x0 + t * (x1 - x0);
  /* chip rows decide how tall the header band is */
  const probe = chipLayout(axis, { tx });
  const top = 12 + probe.rows * GEO.chipRow + 4 + (isGC() ? 10 : 0);   /* room for the parameter name over the value axis */
  /* the Ground Control strips are half again as tall: the curve IS the sweep there */
  const h = Math.round(GEO.height * (isGC() ? 1.5 : 1)) + (probe.rows - 1) * GEO.chipRow;
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
  /* on an inverted analog axis the graph stays put but the labels read the
     real voltage: 5.0V at the bottom, 0.0V at the top */
  const inv = state.tab === 'analog' && !!axis.outputs.analog.invert;
  /* Ground Control: the value axis reads in the selected (else topmost)
     Controller zone's parameter units — each zone has its own scale */
  const gz = gcAxisZone(axis);
  const gridLabel = gz && gz.type === 'ctl' ? (v => gcFormat(gz, v)) : OUT().gridLabel;
  for (const v of [0, 63.5, 127]) {
    const y = g.ty(v);
    const lv = v === 63.5 ? 64 : v;
    parts.push(`<line x1="${g.x0}" y1="${y}" x2="${g.x1}" y2="${y}" stroke="var(--well-line)" stroke-dasharray="2 5"/>`);
    parts.push(`<text x="${g.x0 - 8}" y="${y + 3}" font-size="9" text-anchor="end">${gridLabel(inv ? 127 - lv : lv)}</text>`);
  }
  if (gz && gz.type === 'ctl') parts.push(`<text x="${g.x0 - 8}" y="${g.y0 - 9}" font-size="8" text-anchor="end" fill="${colorOf(gz).c}">${gcDef(gz).name.toUpperCase()}</text>`);
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
    if (isSel(axis, z)) {
      /* selected: a dashed outline in the sim color (Delete removes it) */
      parts.push(`<rect x="${xa + 1.5}" y="${g.y0 + 1.5}" width="${xb - xa - 3}" height="${g.y1 - g.y0 - 3}" fill="none" stroke="var(--sim)" stroke-width="1.5" stroke-dasharray="4 3" rx="3" pointer-events="none"/>`);
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
    const selected = isSel(axis, c.z);
    parts.push(`<g data-role="chip" data-id="${c.z.id}" style="cursor:pointer">${warn ? `<title>overlaps another Controller on the same channel and CC — the topmost one wins</title>` : ''}
      <rect x="${c.cx - c.w / 2}" y="${y}" width="${c.w}" height="17" rx="8.5" fill="${warn ? 'var(--warn-fill)' : 'var(--chip-fill)'}" stroke="${selected ? 'var(--sim)' : (warn ? 'var(--warn)' : col.c)}" stroke-opacity="${selected || warn ? 1 : 0.7}" stroke-width="${selected ? 2 : 1}"${selected ? ` filter="url(#glow-sim-${axis.key})"` : ''}/>
      <circle cx="${c.cx - c.w / 2 + 9}" cy="${y + 8.5}" r="3" fill="${col.c}"/>
      <text x="${c.cx + 6}" y="${y + 12}" font-size="8" text-anchor="middle" class="chip-label">${c.label}</text>
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

  /* output readout: every active output at the marker; Controllers the
     marker has left show what they are doing meanwhile (hold / reset) */
  const analog = state.tab === 'analog';
  const fmt = v => (analog ? `${jackV(axis, v).toFixed(2)}V` : String(Math.round(v)));
  const outs = [];
  const activeKeys = new Set();
  for (const z of [...Z(axis)].sort((a, b) => (a.type === 'switch') - (b.type === 'switch') || a.lo - b.lo)) {
    const here = axis.sim >= z.lo - 1e-9 && axis.sim <= z.hi + 1e-9;
    if (z.type === 'ctl') {
      if (here && ctlActive(axis, z, axis.sim)) {
        const key = targetKey(axis, z);
        simLast[key] = { zoneId: z.id, v: curveValue(z, axis.sim), label: analog ? '' : isGC() ? `${gcDef(z).name} ` : `CC${z.cc} ch${z.ch}=` };
        activeKeys.add(key);
        outs.push(zoneOutput(axis, z, axis.sim));
      }
    } else if (here) {
      const o = zoneOutput(axis, z, axis.sim);
      if (o) outs.push(o);
    }
  }
  /* targets nobody is driving right now: hold or reset per the zone that sent last */
  const idle = [];
  const prefix = `${state.tab}:`;
  for (const key of Object.keys(simLast)) {
    if (!key.startsWith(prefix) || activeKeys.has(key)) continue;
    if (analog && key !== `${prefix}${axis.key}`) continue;
    const m = simLast[key];
    const z = zoneById(axis, m.zoneId);
    if (!z) continue;                        /* belongs to the other axis, or was deleted */
    if (isGC()) { idle.push(`${m.label}${gcFormat(z, m.v)} hold`); continue; }   /* the unit holds the last value */
    if (z.exit === 'reset') m.v = 0;
    idle.push(`${m.label}${fmt(m.v)} ${z.exit === 'reset' ? 'reset' : 'hold'}`);
  }
  const text = outs.length ? outs.join(' · ') : (idle.length ? idle.join(' · ') : 'DEAD');
  ed.outEl.textContent = text + (analog && axis.outputs.analog.invert ? '  ⇅' : '');
}

function commit(axis) {
  for (const z of Z(axis)) if (z.type === 'ctl') normalizePoints(z);
  render(axis);
  saveState();
  if (isGC()) scheduleGcCompile(axis);
  updateSaveButtons();
}

/* ── Ground Control: zones → frames ──────────────────────────────────
   One entry per (effect, parameter) the axis drives: the sweep range in
   the parameter's units and a 33-point curve over the WHOLE travel — the
   unit stores exactly that (SET_THRESH + SET_CURVE). Where no zone for that
   target is active the curve holds the nearer end; a Dead zone over it
   holds too. Overlapping zones on one target: the topmost sends. */
const gcCompileTimers = {};
function scheduleGcCompile(axis) {
  clearTimeout(gcCompileTimers[axis.key]);
  gcCompileTimers[axis.key] = setTimeout(() => gcCompileAxis(axis), 60);
}
function gcCompileAxis(axis) {
  const N = GCCurve.LUT_N;
  const order = drawOrder(axis).filter(z => z.type === 'ctl');   /* bottom → top */
  const targets = new Map();
  for (const z of order) { const k = z.eff + ',' + z.par; if (!targets.has(k)) targets.set(k, []); targets.get(k).push(z); }
  const list = [];
  for (const [, zs] of targets) {
    const z0 = zs[zs.length - 1], def = gcDef(z0);
    const samples = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      for (let j = zs.length - 1; j >= 0; j--) if (ctlActive(axis, zs[j], t)) { samples[i] = gcUnits(zs[j], curveValue(zs[j], t)); break; }
    }
    if (!samples.some(v => v !== null)) continue;               /* fully masked: not an assignment */
    for (let i = 0; i < N; i++) {                                /* hold the nearer end outside */
      if (samples[i] !== null) continue;
      let l = i - 1, r = i + 1;
      while (l >= 0 && samples[l] === null) l--;
      while (r < N && samples[r] === null) r++;
      const dl = l < 0 ? Infinity : i - l, dr = r >= N ? Infinity : r - i;
      samples[i] = dl <= dr ? samples[l] : samples[r];
    }
    const lo = Math.min(...samples), hi = Math.max(...samples);
    const q = v => Math.round(v / def.step) * def.step;          /* the parameter's own resolution */
    const qlo = +q(lo).toFixed(6), qhi = +q(hi).toFixed(6);
    const lut = samples.map(v => (qhi > qlo ? Math.round((v - qlo) / (qhi - qlo) * 255) : 0)).map(v => Math.max(0, Math.min(255, v)));
    list.push({ eff: z0.eff, par: z0.par, lo: qlo, hi: qhi, lut });
  }
  GCTab.applyAxis(axis.key === 'pitch' ? 0 : 1, list);
}
/* the unit's assignments → zones (after a Setup loads) */
function gcAdoptZones(byAxis) {
  for (const key of ['pitch', 'yaw']) {
    const list = byAxis[key === 'pitch' ? 0 : 1] || [];
    const old = state.axes[key].outputs.gc.zones;
    state.axes[key].outputs.gc.zones = list.map((a, i) => {
      const prev = old.find(z => z.type === 'ctl' && z.eff === a.eff && z.par === a.par);
      return mkZone('ctl', a.lo, a.hi, {
        eff: a.eff, par: a.par, color: prev ? prev.color : i % PALETTE.length,
        points: a.points.map(pt => ({ x: pt.x, y: Math.max(0, Math.min(127, pt.y * 127)) })),
      });
    });
    for (const z of state.axes[key].outputs.gc.zones) normalizePoints(z);
  }
  sel = null;
  if (isGC()) { for (const key of ['yaw', 'pitch']) if (editors[key]) render(state.axes[key]); }
  saveState();
  updateSaveButtons();
}

/* an axis's Save lights when its zones (or the Setup name) differ from the
   tab's loaded file — or when nothing is loaded yet, so the work gets saved */
function axisDirty(axis) {
  const tab = state.tab;
  if (tab === 'gc') return GCTab.dirty();       /* the unit's live state vs its saved slot */
  const f = state.loaded[tab] ? libFile(state.loaded[tab], tab) : null;
  if (!f) return true;
  const name = (state.names[tab] || 'UNTITLED').toUpperCase().slice(0, 10);
  return name !== f.name || JSON.stringify(Z(axis)) !== JSON.stringify(f.axes[axis.key])
    || (tab === 'analog' && !!axis.outputs.analog.invert !== !!fileInv(f)[axis.key]);
}
function updateSaveButtons() {
  for (const key of ['yaw', 'pitch']) {
    const ed = editors[key];
    if (ed && ed.saveBtn) ed.saveBtn.classList.toggle('on', axisDirty(state.axes[key]));
  }
}

/* ── interactions ────────────────────────────────────────────────── */

const TAP_GRACE_MS = 260;   /* a second tap inside this window is a double-tap */
function wireEditor(svg, axis) {
  let drag = null;
  let lastTap = { time: 0, x: 0, y: 0, key: '' };
  let pending = null;         /* the popover a single tap will open once the grace period passes */
  let simTrack = { t: axis.sim, time: 0 };
  const cancelPending = () => { if (pending) { clearTimeout(pending); pending = null; } };

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
    if (Math.hypot(px - drag.startPx, py - drag.startPy) > 4) { drag.moved = true; cancelPending(); }
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

    /* tap (no drag). A second tap within TAP_GRACE_MS on the same thing is
       a double-tap: it adds a curve point and cancels the popover the first
       tap was about to open. */
    const { px, py } = evPos(e);
    const now = Date.now();
    const key = `${d.role}:${d.id || ''}:${d.idx}`;
    const dbl = now - lastTap.time < TAP_GRACE_MS && lastTap.key === key
      && Math.hypot(px - lastTap.x, py - lastTap.y) < 30;
    lastTap = { time: now, x: px, y: py, key };
    if (dbl) {
      cancelPending();
      lastTap = { time: 0, x: 0, y: 0, key: '' };
      if (d.role === 'bg' || d.role === 'zone' || d.role === 'edge') addPointAt(axis, px, py);
      return;
    }

    if (d.role === 'point') {
      cancelPending();
      pending = setTimeout(() => { pending = null; openPointPopover(axis, d.id, d.idx, e.clientX, e.clientY); }, TAP_GRACE_MS);
      return;
    }
    if (d.role === 'zone' || d.role === 'edge' || d.role === 'chip') {
      const z = zoneById(axis, d.id);
      if (!z) return;
      selectZone(axis, z);          /* selection is immediate */
      cancelPending();
      const cx = e.clientX, cy = e.clientY;
      pending = setTimeout(() => { pending = null; openZonePopover(axis, z, cx, cy); }, TAP_GRACE_MS);
      return;
    }
    /* empty travel: clear the selection */
    if (d.role === 'bg' || d.role === 'sim') { cancelPending(); if (sel) selectZone(axis, null); }
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
  const z = mkZone('ctl', 0.33, 0.67, { color: nextColor(axis), ch: 1, cc: nextCC(axis), ...(isGC() ? nextAssign(axis) : {}) });
  Z(axis).push(z);
  commit(axis);
  openZonePopover(axis, z, cx, cy);
}
/* Ground Control: the first (effect, parameter) not already on this axis —
   effects of the loaded Setup first, each at its Mix (or first) parameter */
function nextAssign(axis) {
  const used = new Set(Z(axis).filter(z => z.type === 'ctl').map(z => z.eff + ',' + z.par));
  const cands = [];
  const p = GCTab.active();
  const chain = p ? (p.chain.length ? p.chain : []) : [];
  const effs = [...chain, ...GCFX.EFFECTS.map(e => e.id).filter(e => !chain.includes(e))];
  for (const e of effs) {
    const ps = GCFX.EFFECTS[e].params;
    const mix = ps.findIndex(q => q.name === 'Mix');
    const order = mix >= 0 ? [mix, ...ps.map((_, i) => i).filter(i => i !== mix)] : ps.map((_, i) => i);
    for (const q of order) cands.push({ eff: e, par: q });
  }
  return cands.find(c => !used.has(c.eff + ',' + c.par)) || { eff: 0, par: 0 };
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
      ${analog ? numRow('Volts', 'ppy', toV(p.y).toFixed(2), 0, VOLTS, 'step="0.01"')
        : isGC() ? numRow(gcDef(z).name + (gcDef(z).unit ? ' ' + gcDef(z).unit : ''), 'ppy', gcUnits(z, p.y).toFixed(gcDef(z).decimals), gcDef(z).min, gcDef(z).max, `step="${gcDef(z).step}"`)
        : numRow('Value', 'ppy', Math.round(p.y), 0, 127)}
      ${end ? '<div class="pop-note">end points follow the zone\'s edges — drag the edge to move it</div>'
            : '<button class="dangerbtn" id="pdel" type="button">delete point</button>'}
    </div>`, cx, cy);
  if (!end) wireNum(axis, 'ppx', v => { p.x = Math.max(z.lo, Math.min(z.hi, v / 100)); });
  wireNum(axis, 'ppy', v => { p.y = analog ? Math.max(0, Math.min(127, fromV(v))) : isGC() ? Math.max(0, Math.min(127, gcFromUnits(z, v))) : clampi(v, 0, 127); });
  const del = pop.querySelector('#pdel');
  if (del) del.addEventListener('click', () => { z.points.splice(idx, 1); closePopover(); commit(axis); });
}

function openZonePopover(axis, z, cx, cy) {
  const col = colorOf(z);
  const analog = state.tab === 'analog';
  const typeOrder = ['ctl', 'note', 'switch', 'dead', 'freeze'].filter(t => OUT().types.includes(t));
  const typeBtns = typeOrder.map(zoneType).map(t => `
    <button class="type-btn ${z.type === t.id ? 'on' : ''}" data-type="${t.id}" type="button" title="${t.id === 'freeze' ? 'Freeze: hold the ' + axis.freeze + ' value while the pedal is in this zone' : t.label}">
      <span class="ico">${t.icon}</span>${t.id === 'freeze' ? 'Freeze ' + axis.freeze : t.label}
    </button>`).join('');
  const swatches = PALETTE.map((p, i) => `
    <button class="swatch ${((z.color || 0) % PALETTE.length) === i ? 'on' : ''}" data-color="${i}" type="button"
      style="--sw:${p.c}" title="${p.name}"></button>`).join('');

  let rows = '';
  if (z.type === 'ctl' && isGC()) {
    const d = gcDef(z);
    const effOpts = GCFX.EFFECTS.map(e => `<option value="${e.id}"${e.id === z.eff ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
    const parOpts = (GCFX.EFFECTS[z.eff] || { params: [] }).params.map((q, i) => `<option value="${i}"${i === z.par ? ' selected' : ''}>${esc(q.name)}${q.unit ? ' (' + q.unit + ')' : ''}</option>`).join('');
    rows = `<div class="pop-row"><label>Effect</label><select id="zeff" class="pop-select">${effOpts}</select></div>
      <div class="pop-row"><label>Parameter</label><select id="zpar" class="pop-select">${parOpts}</select></div>
      <div class="pop-row"><label>Sweep</label><span class="pop-note">${GCFX.formatValue(d, gcUnits(z, Math.min(...z.points.map(q => q.y))))} → ${GCFX.formatValue(d, gcUnits(z, Math.max(...z.points.map(q => q.y))))}</span></div>
      <div class="pop-row"><label>Response curve</label>
        <button class="ghostbtn ${z.smooth ? 'on' : ''}" id="zsmooth" type="button" title="linear ↔ smooth (monotone cubic) interpolation between the points">smooth</button></div>
      <div class="pop-note">drag the end points to set the sweep range in ${d.name}'s own units · double-click the curve to add points · outside the zone the unit holds the nearer end</div>
      ${ccConflict(axis, z) ? `<div class="pop-note warn">overlaps another zone on the same parameter — where they overlap only the topmost (narrowest) one drives it</div>` : ''}`;
  } else if (z.type === 'ctl') {
    rows = `${analog ? '' : `${numRow('Transmit ch', 'zch', z.ch, 1, 16)}
      ${numRow('CC #', 'zcc', z.cc, 0, 127)}`}
      <div class="pop-row"><label>Response curve</label>
        <button class="ghostbtn ${z.smooth ? 'on' : ''}" id="zsmooth" type="button" title="linear ↔ smooth (monotone cubic) interpolation between the points">smooth</button></div>
      <div class="pop-row"><label>On exit</label>
        <div class="seg" title="what the output does when the pedal leaves this zone"><button class="${z.exit !== 'reset' ? 'on' : ''}" data-exit="hold" type="button">Hold</button><button class="${z.exit === 'reset' ? 'on' : ''}" data-exit="reset" type="button">Reset</button></div></div>
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
  pop.querySelectorAll('[data-exit]').forEach(b => b.addEventListener('click', () => {
    z.exit = b.dataset.exit; commit(axis); reopen();
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
  const zeff = pop.querySelector('#zeff'), zpar = pop.querySelector('#zpar');
  if (zeff) zeff.addEventListener('change', () => {
    z.eff = +zeff.value;
    const ps = GCFX.EFFECTS[z.eff].params, mix = ps.findIndex(q => q.name === 'Mix');
    z.par = mix >= 0 ? mix : 0;
    commit(axis); reopen();
  });
  if (zpar) zpar.addEventListener('change', () => { z.par = +zpar.value; commit(axis); reopen(); });
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
  pop.querySelector('#zdel').addEventListener('click', () => { closePopover(); deleteZone(axis, z); });
}

function deleteZone(axis, z) {
  setZ(axis, Z(axis).filter(x => x.id !== z.id));
  delete simSwitch[z.id];
  for (const k of Object.keys(simLast)) if (simLast[k].zoneId === z.id) delete simLast[k];
  if (isSel(axis, z)) sel = null;
  commit(axis);
}

/* Delete / Backspace removes the selected zone; Esc clears the selection.
   Ignored while typing in a field. */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!sel) return;
  const axis = state.axes[sel.axisKey];
  const z = zoneById(axis, sel.id);
  if (!z) { sel = null; return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    closePopover();
    deleteZone(axis, z);
  } else if (e.key === 'Escape' && pop.hidden) {
    selectZone(axis, null);
  }
});

/* ── librarian: per-output Library + Set List of slots ───────────── */

const libListEl = document.getElementById('libList');
const setListEl = document.getElementById('setList');
const libTitleEl = document.getElementById('libTitle');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const lib = tab => state.library[tab || state.tab];
function libFile(id, tab) { return lib(tab).find(x => x.id === id) || null; }
const curName = () => (state.names[state.tab] || 'UNTITLED').toUpperCase().slice(0, 10);
const axesZones = tab => ({ yaw: state.axes.yaw.outputs[tab].zones, pitch: state.axes.pitch.outputs[tab].zones });
/* analog files also carry each axis's polarity */
const axesInv = () => ({ yaw: !!state.axes.yaw.outputs.analog.invert, pitch: !!state.axes.pitch.outputs.analog.invert });
const fileInv = f => (f && f.inv) || { yaw: false, pitch: false };

/* the current tab's loaded file's 1-based Set List position (its PC number), or null */
function loadedPC() {
  const id = state.loaded[state.tab];
  const i = id ? slots().findIndex(sl => sl[state.tab] === id) : -1;
  return i >= 0 ? i + 1 : null;
}

/* UNTITLED, UNTITLED2, UNTITLED3 … — first name not already in the library */
function uniqueUntitled(tab) {
  const used = new Set(lib(tab).map(f => f.name));
  if (!used.has('UNTITLED')) return 'UNTITLED';
  for (let n = 2; n < 100; n++) if (!used.has('UNTITLED' + n)) return 'UNTITLED' + n;
  return 'UNTITLED';
}

/* Save the CURRENT tab's zones as a file in that tab's library.
   asNew: a fresh file named UNTITLED / UNTITLED2 … (the caller then opens
   the inline rename so it gets a real name straight away). */
function saveProgram(asNew, tab) {
  tab = tab || state.tab;
  if (asNew) { state.names[tab] = uniqueUntitled(tab); if (tab === state.tab) progName.value = state.names[tab]; }
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
  if (tab === 'analog') f.inv = axesInv();
  saveState();
  renderLibrarian();
  updateSaveButtons();
  return f;
}

/* ── inline rename of a Library row (double-click / double-tap) ──── */
function startRename(id) {
  const row = libListEl.querySelector(`.lib-row[data-id="${id}"]`);
  const f = isGC() ? { name: GCTab.nameOf(id) || '' } : libFile(id);
  if (!row || !f) return;
  const nameEl = row.querySelector('.lib-name');
  const input = document.createElement('input');
  input.className = 'lib-rename';
  input.type = 'text'; input.maxLength = 10; input.value = f.name;
  input.setAttribute('autocapitalize', 'characters'); input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    if (commit && isGC()) {
      const s = GCTab.parseId(id);
      if (s) GCTab.renameSlot(s.L, s.D, input.value.trim().slice(0, 10));
    } else if (commit) {
      const name = input.value.toUpperCase().trim().slice(0, 10) || f.name;
      f.name = name;
      if (state.loaded[state.tab] === f.id) { state.names[state.tab] = name; progName.value = name; }
      saveState();
    }
    renderLibrarian();
    updateSaveButtons();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', e => e.stopPropagation());
}

/* load one file into its output tab (only that tab changes) */
function loadFile(id, tab) {
  const f = libFile(id, tab);
  if (!f) return false;
  for (const key of ['yaw', 'pitch']) {
    state.axes[key].outputs[tab].zones = JSON.parse(JSON.stringify(f.axes[key]));
    if (tab === 'analog') state.axes[key].outputs.analog.invert = !!fileInv(f)[key];
  }
  state.names[tab] = f.name;
  state.loaded[tab] = id;
  return true;
}
function refreshEditor() {
  sel = null;
  const axesEl = document.getElementById('axes'), gcEl = document.getElementById('gcTab'), gcTop = document.getElementById('gcTop');
  document.body.classList.toggle('gc-tab', isGC());
  progName.value = isGC() ? (state.names.gc || '') : state.names[state.tab];
  gcEl.hidden = !isGC(); gcTop.hidden = !isGC(); axesEl.hidden = false;
  buildPanels();
  for (const key of ['yaw', 'pitch']) {
    if (isGC()) { for (const z of Z(state.axes[key])) if (z.type === 'ctl') normalizePoints(z); render(state.axes[key]); }
    else commit(state.axes[key]);
  }
  updateSaveButtons();
  renderLibrarian();
}
/* load a Set List slot: every output that has a file (the pedal's PC behavior) */
function loadSlot(i) {
  const sl = slots()[i];
  if (!sl) return;
  for (const tab of TAB_ORDER) if (sl[tab]) loadFile(sl[tab], tab);
  if (sl.gc && GCTab.isConnected()) { const s = GCTab.parseId(sl.gc); if (s) GCTab.load(s.L, s.D); }
  refreshEditor();
}

/* the Library column on the GROUND CONTROL tab: the unit's Setup bank */
function renderGcLibrarian() {
  const on = GCTab.isConnected(), bank = GCTab.bank(), active = GCTab.activeId();
  libTitleEl.textContent = 'LIBRARY OF SETUPS · GROUND CONTROL';
  libListEl.classList.toggle('gc-bank', bank.length > 0);   /* two columns: the bank is long */
  libListEl.innerHTML = bank.length
    ? bank.map(i => {
      const id = GCTab.idOf(i), pal = GCP.COLOR_PALETTE[i.colorIdx] || GCP.COLOR_PALETTE[7];
      /* the loaded row glows in a see-through version of the Setup's own colour */
      return `
      <li class="lib-row${id === active ? ' on' : ''}" data-id="${id}" style="--row-c:${pal.hex}" title="${esc(GCTab.describe(i))}">
        <span class="gc-dot" style="background:${pal.hex}"></span>
        <span class="lib-id">${id}</span>
        <span class="lib-name">${i.name ? esc(i.name) : '<span class="unnamed">unnamed</span>'}</span>
        <button class="rowbtn" data-del type="button" title="delete this Setup from the unit">×</button>
      </li>`;
    }).join('')
    : `<li class="lib-empty">${on ? (GCTab.listing() ? 'reading the unit\u2019s Setups\u2026' : 'no Setups on the unit \u2014 REFRESH SETUPS reads them') : 'connect to the Ground Control to see its Setups'}</li>`;
  renderSetlistTools();
  setListEl.innerHTML = slots().length
    ? slots().map((sl, i) => {
      const nm = sl.gc ? GCTab.nameOf(sl.gc) : null;
      return `
      <li class="set-row${sl.gc && sl.gc === active ? ' on' : ''}${sl.gc ? '' : ' none'}" data-idx="${i}">
        <span class="pc">${i + 1}</span>
        ${sl.gc ? `<span class="lib-id">${esc(sl.gc)}</span>` : ''}
        <span class="lib-name">${sl.gc ? (nm ? esc(nm) : (nm === '' ? '<span class="unnamed">unnamed</span>' : '<span class="unnamed">not on this unit</span>')) : '\u2014 no GC setup \u2014'}</span>
        <button class="rowbtn" data-del type="button" title="remove slot">×</button>
      </li>`;
    }).join('')
    : `<li class="lib-empty">drag Setups here — order sets the PC #</li>`;
  progNum.value = loadedPC() ?? '—';
}

function renderLibrarian() {
  if (isGC()) { renderGcLibrarian(); return; }
  libListEl.classList.remove('gc-bank');
  const tab = state.tab;
  libTitleEl.textContent = `LIBRARY OF SETUPS · ${tab === 'analog' ? 'ANALOG' : 'MIDI'}`;
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

let lastLibTap = { id: null, time: 0 };
libListEl.addEventListener('dblclick', e => {
  const row = e.target.closest('.lib-row');
  if (row && !e.target.closest('button, input')) startRename(row.dataset.id);
});
libListEl.addEventListener('click', e => {
  const row = e.target.closest('.lib-row');
  if (!row) return;
  if (e.target.closest('input')) return;
  const id = row.dataset.id;
  const tab = state.tab;
  /* touch double-tap → rename (mouse gets the dblclick event) */
  const now = Date.now();
  if (lastLibTap.id === id && now - lastLibTap.time < 350 && !e.target.closest('button')) {
    lastLibTap = { id: null, time: 0 };
    startRename(id);
    return;
  }
  lastLibTap = { id, time: now };
  if (isGC()) {
    const s = GCTab.parseId(id);
    if (!s) return;
    if (e.target.closest('[data-del]')) {
      const nm = GCTab.nameOf(id);
      const used = state.setlists.flatMap(l => l.slots).filter(sl => sl.gc === id).length;
      if (!confirm(`Delete Setup ${id}${nm ? ` "${nm}"` : ''} from the Ground Control? This cannot be undone.${used ? ` It is used by ${used} set list slot${used > 1 ? 's' : ''}.` : ''}`)) return;
      GCTab.remove(s.L, s.D);
      return;
    }
    GCTab.load(s.L, s.D);
    return;
  }
  if (e.target.closest('[data-del]')) {
    const f = libFile(id, tab);
    const used = state.setlists.flatMap(l => l.slots).filter(sl => sl[tab] === id).length;
    if (!confirm(`Delete "${f ? f.name : '?'}" from the ${OUT().label} library?${used ? ` It is used by ${used} set list slot${used > 1 ? 's' : ''}.` : ''}`)) return;
    state.library[tab] = lib().filter(x => x.id !== id);
    for (const l of state.setlists) {
      for (const sl of l.slots) if (sl[tab] === id) sl[tab] = null;
      l.slots = l.slots.filter(sl => SLOT_KEYS.some(t => sl[t]));   /* drop slots left empty */
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
   Mouse: a ~6px movement threshold separates a drag from a tap-to-load.
   Touch: the lists scroll with a swipe, so a drag starts with a short
   press-and-hold (the row lights up), then moves; a swipe before the hold
   completes just scrolls.
   library → set list: drop BETWEEN slots to insert a new slot holding this
   Setup, drop ONTO a slot to put this Setup into that slot's tab.
   set list ↕ reorders · set list → library removes the slot. */
const HOLD_MS = 320;
let dragArmed = false;   /* a touch drag is in progress: block the page from scrolling */
document.addEventListener('touchmove', e => { if (dragArmed) e.preventDefault(); }, { passive: false });
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
    if (e.target.closest('button, input')) return;
    const row = e.target.closest(kind === 'lib' ? '.lib-row' : '.set-row');
    if (!row) return;

    const startX = e.clientX, startY = e.clientY;
    const r = row.getBoundingClientRect();
    const id = row.dataset.id;
    const oldIdx = row.dataset.idx != null ? +row.dataset.idx : -1;
    let ghost = null, ph = null, active = false, overLib = false, dropIdx = 0, ontoIdx = -1;
    const touch = e.pointerType === 'touch';
    let held = !touch;            /* mouse drags start at once; touch after a hold */
    let holdTimer = null;
    if (touch) {
      holdTimer = setTimeout(() => { held = true; dragArmed = true; row.classList.add('lifting'); }, HOLD_MS);
    }

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
      if (!held) {
        /* moved before the hold completed: it's a scroll, not a drag */
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) cleanup();
        return;
      }
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

    const cleanup = () => {
      clearTimeout(holdTimer);
      dragArmed = false;
      row.classList.remove('lifting');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    const up = () => {
      cleanup();
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
    document.addEventListener('pointercancel', up);
  });
}
wireRowDrag(libListEl, 'lib');
wireRowDrag(setListEl, 'set');

/* + new: save the current tab's zones as a NEW Setup under the SETUP name */
document.getElementById('saveNewBtn').addEventListener('click', () => {
  if (isGC()) {   /* the unit's own bank: nothing here touches the MIDI / Analog editors */
    if (!GCTab.isConnected()) { alert('Connect to the Ground Control first.'); return; }
    const id = GCTab.saveNew('UNTITLED');
    if (id) setTimeout(() => startRename(id), 700);   /* after the unit echoes the new slot */
    return;
  }
  guardUnsaved('creating a new Setup', () => {
  const f = saveProgram(true);
  flashProgName();
  if (f) startRename(f.id);   /* name it right away */
  });
});

/* ── v1.7: unsaved-changes guard (per output tab) ─────────────────
   A tab is "dirty" when its editor differs from its loaded file. Anything
   that would replace editor contents goes through guardUnsaved(): clean →
   proceed; dirty → Save (every dirty tab) / Discard / Cancel. */
function isDirty(tab) {
  tab = tab || state.tab;
  const f = state.loaded[tab] ? libFile(state.loaded[tab], tab) : null;
  if (!f) return false;
  const name = (state.names[tab] || 'UNTITLED').toUpperCase().slice(0, 10);
  return name !== f.name || JSON.stringify(axesZones(tab)) !== JSON.stringify(f.axes)
    || (tab === 'analog' && JSON.stringify(axesInv()) !== JSON.stringify(fileInv(f)));
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
  const names = TAB_ORDER.map(t => sl[t] ? `${OUTPUTS[t].tag}:"${libFile(sl[t], t).name}"` : `${OUTPUTS[t].tag}:—`)
    .concat(sl.gc ? [`GC:${sl.gc}`] : []).join(' ');
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
progName.addEventListener('input', () => {
  if (isGC()) { GCTab.rename(progName.value.slice(0, 10)); return; }
  state.names[state.tab] = progName.value.toUpperCase().slice(0, 10); saveState(); updateSaveButtons();
});

document.getElementById('resetBtn').addEventListener('click', () => guardUnsaved('resetting the demo', () => {
  if (!confirm('Reset the demo? This also clears the Library and Set List, and the simulated Ground Control goes back to its factory Setups.')) return;
  const sim = GCTab.simulator();
  if (GCTab.isConnected()) GCTab.disconnect();
  if (sim) sim.factoryReset();
  state = defaultState();
  gcSimToggle.checked = false;
  updateOutTabs();
  refreshEditor();
}));

/* ── export / import: the whole librarian as one .json file ─────── */

async function exportFile() {
  const doc = {
    format: 'orbit-ui-library',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    receiveChannel: state.globalCh,
    library: state.library,      /* { midi: [files], analog: [files] } */
    setlists: state.setlists,    /* [{ id, name, bank, slots: [{ midi: id, analog: id, gc: 'B3' }] }] */
    activeSetlist: state.activeSetlist,
  };
  /* a connected Ground Control: back up its whole Setup bank into the file */
  if (GCTab.isConnected()) {
    const btn = document.getElementById('exportBtn');
    btn.disabled = true;
    const setups = await GCTab.dumpBank((i, n) => { btn.textContent = `backing up ${i}/${n}`; GCTab.setBankStatus(`backing up Setup ${i} of ${n}…`); });
    btn.disabled = false; btn.textContent = 'export file';
    GCTab.setBankStatus(setups ? `${setups.length} Setups on the unit · backed up` : 'this unit cannot be backed up (no GET_PRESET_DUMP) — file has the libraries only', setups ? 'ok' : 'err');
    if (setups) {
      doc.groundControl = {
        unit: GCTab.unitLabel(), exportedAt: new Date().toISOString(),
        effects: GCFX.EFFECTS.map(e => ({ id: e.id, name: e.name, params: e.params.map(p => p.name) })),   /* so the ids read */
        setups,
      };
    }
  }
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
  state.loaded = { midi: null, analog: null, gc: state.loaded.gc };
  migrateLibrary(state);          /* validates shapes, fills any half-empty slots */
  for (const f of state.library.midi.concat(state.library.analog)) for (const k of ['yaw', 'pitch']) f.axes[k] = f.axes[k] || [];
  if (slots().length) loadSlot(0); else refreshEditor();
  saveState();
  flashProgName();
  /* the file's Ground Control Setups: write them to the connected unit */
  const gcs = doc.groundControl && Array.isArray(doc.groundControl.setups) ? doc.groundControl.setups : null;
  if (gcs && gcs.length) {
    if (!GCTab.isConnected()) { alert(`The file also holds ${gcs.length} Ground Control Setups. Connect a Ground Control and import again to write them to it.`); return; }
    if (!confirm(`Also write the file's ${gcs.length} Ground Control Setups (${gcs.map(s => s.slot).join(', ')}) to the connected unit? Those slots are overwritten.`)) return;
    const btn = document.getElementById('importBtn');
    btn.disabled = true;
    GCTab.restoreBank(gcs, (i, n, slot) => { btn.textContent = `writing ${i}/${n}`; GCTab.setBankStatus(slot ? `writing Setup ${slot} (${i + 1} of ${n})…` : `${n} Setups written`, slot ? '' : 'ok'); })
      .then(() => { btn.disabled = false; btn.textContent = 'import file'; if (isGC()) renderLibrarian(); });
  }
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
/* the GROUND CONTROL tab appears when a unit can be reached: the page is
   served by the pedal, or the footer switch stands in a simulated one */
const gcAvailable = () => state.gcSim || GCLink.servedByPedal();
function updateOutTabs() {
  outTabs.forEach(t => {
    if (t.dataset.tab === 'gc') t.hidden = !gcAvailable();
    t.classList.toggle('on', t.dataset.tab === state.tab);
  });
}
const gcSimToggle = document.getElementById('gcSimToggle');
gcSimToggle.checked = !!state.gcSim;
gcSimToggle.addEventListener('change', () => {
  state.gcSim = gcSimToggle.checked;
  if (state.gcSim) { GCTab.setLinkKind('sim'); if (!GCTab.isConnected()) GCTab.connect(); }
  else if (GCTab.linkKind() === 'sim' && GCTab.isConnected()) GCTab.disconnect();
  if (!gcAvailable() && isGC()) state.tab = 'midi';
  saveState();
  updateOutTabs();
  refreshEditor();
});
GCTab.init({
  mount: document.getElementById('gcTab'),
  linkKind: state.gcSim ? 'sim' : undefined,
  autoConnect: state.gcSim,
  getAxes: () => ({ pitch: state.axes.pitch.sim, yaw: state.axes.yaw.sim }),
  onSetupZones: gcAdoptZones,
  onParamPick: gcSelectParam,
  onAddZone: gcAddZoneFor,
  onUnmap: gcUnmapParam,
  onDirty: () => updateSaveButtons(),
  onBank: () => { if (isGC()) renderLibrarian(); },
  onLoaded: (id, name) => {
    state.loaded.gc = id; state.names.gc = name || '';
    if (isGC()) { progName.value = state.names.gc; renderLibrarian(); }
    saveState();
  },
  onLink: on => { if (!on) { state.loaded.gc = null; state.names.gc = ''; } if (isGC()) { progName.value = state.names.gc; renderLibrarian(); } },
});
/* the Screens panel sits right under the strips, above the Library */
document.getElementById('gcTop').appendChild(document.getElementById('gc-screens'));
if (isGC() && !gcAvailable()) state.tab = 'midi';
outTabs.forEach(t => t.addEventListener('click', () => {
  if (state.tab === t.dataset.tab) return;
  closePopover();
  state.tab = t.dataset.tab;
  saveState();
  updateOutTabs();
  refreshEditor();
}));
updateOutTabs();
refreshEditor();

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const key of ['yaw', 'pitch']) render(state.axes[key]);
  }, 80);
});
