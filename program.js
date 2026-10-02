/* The pedal's program: the MIDI and ANALOG OUT tabs, pushed to the pedal so
   it runs the zones and curves itself (orbit/src/program.h). One little-endian
   blob — version, analog invert flags, then MIDI yaw / MIDI pitch / ANALOG
   yaw / ANALOG pitch, each a zone count and the zones:
     [type][lo u16][hi u16][ch 1-16][cc][flags][note][vel][onVal][offVal][speed][nPts] + nPts × [x u16][y]
   type 0 ctl · 1 note · 2 switch · 3 freeze · 4 dead; flags bit0 smooth,
   bit1 exit=reset, bit2 switch action=CC; travel as 0..65535; speed m/s × 100.
   Sent in ≤150-byte chunks: PROG_BEGIN, PROG_DATA…, PROG_END → PROG_ACK.
   window.OrbitProgram */

'use strict';

(function () {
  const CMD = { BEGIN: 0x30, DATA: 0x31, END: 0x32, GET: 0x33, CLEAR: 0x34 };
  const RSP = { ACK: 0xb0, CHUNK: 0xb1 };
  const TYPES = ['ctl', 'note', 'switch', 'freeze', 'dead'];
  const MAX_ZONES = 8, MAX_POINTS = 8, CHUNK = 150;

  const u16 = v => Math.max(0, Math.min(65535, Math.round(v * 65535)));
  const c7 = v => Math.max(0, Math.min(127, Math.round(+v || 0)));

  /* zones of one axis for one output → bytes. Over the caps: the widest
     zones and the end points are kept, so a cut is visible but never wrong. */
  function encodeAxis(zones, out) {
    const zs = zones.slice(0, MAX_ZONES);
    out.push(zs.length);
    for (const z of zs) {
      const type = Math.max(0, TYPES.indexOf(z.type));
      const lo = u16(z.lo), hi = u16(z.hi);
      const flags = (z.smooth ? 1 : 0) | (z.exit === 'reset' ? 2 : 0) | (z.action === 'cc' ? 4 : 0);
      let pts = (z.points || []).slice().sort((a, b) => a.x - b.x);
      if (type !== 0) pts = [];
      else if (pts.length > MAX_POINTS) pts = [pts[0], ...pts.slice(1, -1).slice(0, MAX_POINTS - 2), pts[pts.length - 1]];
      out.push(type, lo & 255, lo >> 8, hi & 255, hi >> 8, Math.max(1, Math.min(16, z.ch | 0)), c7(z.cc), flags,
        c7(z.note), c7(z.vel), c7(z.onVal), c7(z.offVal), Math.max(0, Math.min(255, Math.round((z.speedMs || 0.1) * 100))), pts.length);
      for (const p of pts) { const x = u16(p.x); out.push(x & 255, x >> 8, c7(p.y)); }
    }
  }
  /* the live state's two outputs → the blob */
  function encode(state) {
    const out = [1, (state.axes.yaw.outputs.analog.invert ? 1 : 0) | (state.axes.pitch.outputs.analog.invert ? 2 : 0)];
    for (const tab of ['midi', 'analog']) for (const key of ['yaw', 'pitch']) encodeAxis(state.axes[key].outputs[tab].zones, out);
    return new Uint8Array(out);
  }
  /* blob → plain object (verification / read-back) */
  function decode(b) {
    if (b.length < 2 || b[0] !== 1) return null;
    let i = 2;
    const axis = () => {
      const n = b[i++], zones = [];
      for (let k = 0; k < n; k++) {
        const z = { type: TYPES[b[i]] || 'dead', lo: (b[i + 1] | (b[i + 2] << 8)) / 65535, hi: (b[i + 3] | (b[i + 4] << 8)) / 65535,
          ch: b[i + 5], cc: b[i + 6], smooth: !!(b[i + 7] & 1), exit: (b[i + 7] & 2) ? 'reset' : 'hold', action: (b[i + 7] & 4) ? 'cc' : 'note',
          note: b[i + 8], vel: b[i + 9], onVal: b[i + 10], offVal: b[i + 11], speedMs: b[i + 12] / 100, points: [] };
        const np = b[i + 13]; i += 14;
        for (let p = 0; p < np; p++) { z.points.push({ x: (b[i] | (b[i + 1] << 8)) / 65535, y: b[i + 2] }); i += 3; }
        zones.push(z);
      }
      return zones;
    };
    const o = { invert: { yaw: !!(b[1] & 1), pitch: !!(b[1] & 2) }, midi: {}, analog: {} };
    o.midi.yaw = axis(); o.midi.pitch = axis(); o.analog.yaw = axis(); o.analog.pitch = axis();
    return i === b.length ? o : null;
  }

  /* ---- transport ----------------------------------------------------------- */
  let pending = null;      /* { resolve, reject, timer } for the push in flight */
  let chunks = null, total = 0;   /* read-back assembly */
  let onStatus = () => {};
  let timer = null, lastPushed = null, wantPersist = false;

  function onFrame(f) {
    if (f.cmd === RSP.ACK && pending) {
      const p = pending; pending = null; clearTimeout(p.timer);
      const ok = !!f.payload[0], n = f.payload[1] | (f.payload[2] << 8);
      if (ok) p.resolve(n); else p.reject(new Error(`the pedal rejected the program (${n} bytes)`));
      return;
    }
    if (f.cmd === RSP.CHUNK && chunks) {
      const p = f.payload, off = p[0] | (p[1] << 8); total = p[2] | (p[3] << 8);
      chunks.set(p.subarray(4), off);
      if (off + p.length - 4 >= total) { const done = chunks.subarray(0, total); const r = chunks.resolve; chunks = null; r(done); }
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function send(blob, persist) {
    const P = window.Pedal;
    if (!P || !P.isConnected()) throw new Error('the pedal is not connected');
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('superseded')); pending = null; }
    await P.send(CMD.BEGIN, new Uint8Array([blob.length & 255, blob.length >> 8, persist ? 1 : 0]));
    for (let off = 0; off < blob.length; off += CHUNK) {
      const part = blob.subarray(off, Math.min(blob.length, off + CHUNK));
      const frame = new Uint8Array(2 + part.length); frame[0] = off & 255; frame[1] = off >> 8; frame.set(part, 2);
      await P.send(CMD.DATA, frame);
      await sleep(25);   /* the pedal handles bridge frames from its main loop: don't flood its queue */
    }
    const done = new Promise((resolve, reject) => { pending = { resolve, reject, timer: setTimeout(() => { pending = null; reject(new Error('no answer from the pedal')); }, 2500) }; });
    await P.send(CMD.END, new Uint8Array(0));
    return done;
  }

  /* push the live state; persist = also save it in the pedal's flash */
  async function push(state, persist) {
    const blob = encode(state);
    try {
      const n = await send(blob, persist);
      lastPushed = blob;
      onStatus(`program on the pedal · ${n} B${persist ? ' · saved' : ''}`, 'ok');
    } catch (err) {
      if (err.message !== 'superseded') onStatus(`program push failed: ${err.message}`, 'err');
      throw err;
    }
  }
  /* debounced: edits push the RAM copy; a save / load of a Setup persists */
  function schedule(state, persist) {
    wantPersist = wantPersist || !!persist;
    clearTimeout(timer);
    timer = setTimeout(() => { const p = wantPersist; wantPersist = false; push(state, p).catch(() => {}); }, 150);
  }
  function readBack() {
    const P = window.Pedal;
    if (!P || !P.isConnected()) return Promise.reject(new Error('the pedal is not connected'));
    return new Promise((resolve, reject) => {
      chunks = new Uint8Array(2048); chunks.resolve = resolve;
      setTimeout(() => { if (chunks) { chunks = null; reject(new Error('no answer')); } }, 2500);
      P.send(CMD.GET, new Uint8Array(0)).catch(reject);
    });
  }
  function clear() { const P = window.Pedal; return P && P.isConnected() ? P.send(CMD.CLEAR, new Uint8Array(0)) : Promise.resolve(); }

  function init(opts) {
    onStatus = (opts && opts.onStatus) || onStatus;
    if (window.Pedal) window.Pedal.onRaw(onFrame);
  }

  window.OrbitProgram = { encode, decode, push, schedule, readBack, clear, init, lastPushed: () => lastPushed, CMD, RSP };
})();
