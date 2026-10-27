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
  const CMD = { BEGIN: 0x30, DATA: 0x31, END: 0x32, GET: 0x33, CLEAR: 0x34, SLOT_BEGIN: 0x35, SLOT_DATA: 0x36, SLOT_END: 0x37, SLOT_ERASE: 0x38, SLOT_LIST: 0x39, SLOT_RECALL: 0x3a };
  const RSP = { ACK: 0xb0, CHUNK: 0xb1, SLOT_ACK: 0xb2, SLOT_LIST: 0xb3, SLOT_CHANGED: 0xb4, ZONE_STATE: 0xb5 };
  const NO_GC = 0xff;
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
      const flags = (z.smooth ? 1 : 0) | (z.exit === 'reset' ? 2 : 0) | (z.action === 'cc' ? 4 : 0) | (z.action === 'freeze' ? 8 : 0) | (z.mode === 'momentary' ? 16 : 0);
      let pts = (z.points || []).slice().sort((a, b) => a.x - b.x);
      if (type !== 0) pts = [];
      else if (pts.length > MAX_POINTS) pts = [pts[0], ...pts.slice(1, -1).slice(0, MAX_POINTS - 2), pts[pts.length - 1]];
      out.push(type, lo & 255, lo >> 8, hi & 255, hi >> 8, Math.max(1, Math.min(16, z.ch | 0)), c7(z.cc), flags,
        c7(z.note), c7(z.vel), c7(z.onVal), c7(z.offVal), Math.max(0, Math.min(255, Math.round((z.speedMs || 0.1) * 100))), pts.length);
      for (const p of pts) { const x = u16(p.x); out.push(x & 255, x >> 8, c7(p.y)); }
    }
  }
  /* one Set List slot → the blob: the slot's MIDI and ANALOG OUT library files
     (a missing file = no zones on that output) */
  function encodeSlot(state, sl) {
    const file = (tab, id) => (id && state.library[tab].find(f => f.id === id)) || null;
    const m = file('midi', sl.midi), a = file('analog', sl.analog);
    const inv = (a && a.inv) || { yaw: false, pitch: false };
    const route = (m && m.route) || { yaw: 'both', pitch: 'both' };
    const aoff = (a && a.off) || { yaw: false, pitch: false };
    const out = [1, (inv.yaw ? 1 : 0) | (inv.pitch ? 2 : 0) | routeBits(route) | anaBits(aoff)];
    for (const key of ['yaw', 'pitch']) encodeAxis(m ? (m.axes[key] || []) : [], out);
    for (const key of ['yaw', 'pitch']) encodeAxis(a ? (a.axes[key] || []) : [], out);
    return new Uint8Array(out);
  }
  /* per-axis routing (MIDI tab): 'both' (default) · 'midi' = no raw axis to the unit · 'gc' = no MIDI from the program */
  /* header flag bits: 2/3 MIDI off (yaw/pitch) · 4/5 raw axis to the unit off (legacy 'MIDI only' route, no longer set by the UI) · 6/7 analog off */
  const routeBits = r => ((r.yaw === 'gc' ? 4 : 0) | (r.pitch === 'gc' ? 8 : 0) | (r.yaw === 'midi' ? 16 : 0) | (r.pitch === 'midi' ? 32 : 0));
  const anaBits = a => ((a.yaw ? 64 : 0) | (a.pitch ? 128 : 0));
  /* the live state's two outputs → the blob */
  function encode(state) {
    const route = { yaw: state.axes.yaw.outputs.midi.route || 'both', pitch: state.axes.pitch.outputs.midi.route || 'both' };
    const aoff = { yaw: !!state.axes.yaw.outputs.analog.off, pitch: !!state.axes.pitch.outputs.analog.off };
    const out = [1, (state.axes.yaw.outputs.analog.invert ? 1 : 0) | (state.axes.pitch.outputs.analog.invert ? 2 : 0) | routeBits(route) | anaBits(aoff)];
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

  /* ---- Set List slots on the pedal --------------------------------------- */
  let slotAck = null;            /* { resolve, reject, timer } for the slot push in flight */
  let onRecall = () => {};       /* app hook: the pedal recalled (bank, slot, ok, gcId) */
  let onZoneState = () => {};    /* app hook: the pedal's Switch / freeze state changed */
  const pushed = new Map();      /* "bank:slot" → hex of the last blob+gc pushed, to skip unchanged slots */
  let syncTimer = null, syncing = false, syncAgain = false;

  const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
  async function sendSlot(bank, slot, gcL, gcD, blob) {
    const P = window.Pedal;
    if (!P || !P.isConnected()) throw new Error('the pedal is not connected');
    await P.send(CMD.SLOT_BEGIN, new Uint8Array([bank, slot, blob.length & 255, blob.length >> 8, gcL, gcD]));
    for (let off = 0; off < blob.length; off += CHUNK) {
      const part = blob.subarray(off, Math.min(blob.length, off + CHUNK));
      const frame = new Uint8Array(2 + part.length); frame[0] = off & 255; frame[1] = off >> 8; frame.set(part, 2);
      await P.send(CMD.SLOT_DATA, frame);
      await sleep(25);
    }
    const done = new Promise((resolve, reject) => { slotAck = { resolve, reject, timer: setTimeout(() => { slotAck = null; reject(new Error('no answer from the pedal')); }, 2500) }; });
    await P.send(CMD.SLOT_END, new Uint8Array(0));
    return done;
  }
  function gcOf(sl) {
    const m = /^([A-Z])(\d)$/.exec(sl.gc || '');
    return m ? [m[1].charCodeAt(0) - 65, +m[2]] : [NO_GC, NO_GC];
  }
  /* push every Set List slot whose content changed since the last push; erase
     slots the pedal may still hold that no longer exist */
  async function syncSetlists(state) {
    const P = window.Pedal;
    if (!P || !P.isConnected()) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    let sent = 0;
    try {
      const live = new Set();
      for (const l of state.setlists) {
        const bank = l.bank | 0;
        for (let i = 0; i < l.slots.length && i < 128; i++) {
          const sl = l.slots[i];
          if (!sl) continue;
          const [gcL, gcD] = gcOf(sl);
          const blob = encodeSlot(state, sl);
          const key = `${bank}:${i}`, sig = hex(blob) + ':' + gcL + ':' + gcD;
          live.add(key);
          if (pushed.get(key) === sig) continue;
          await sendSlot(bank, i, gcL, gcD, blob);
          pushed.set(key, sig); sent++;
        }
      }
      for (const key of [...pushed.keys()]) {
        if (live.has(key)) continue;
        const [bank, i] = key.split(':').map(Number);
        await P.send(CMD.SLOT_ERASE, new Uint8Array([bank, i]));
        pushed.delete(key);
      }
      if (sent) onStatus(`${sent} Set List slot${sent === 1 ? '' : 's'} on the pedal`, 'ok');
    } catch (err) {
      onStatus(`Set List push failed: ${err.message}`, 'err');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(state); }
    }
  }
  function scheduleSync(state) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncSetlists(state).catch(() => {}), 600); }
  function forgetPushed() { pushed.clear(); }
  function recall(bank, slot) { const P = window.Pedal; return P && P.isConnected() ? P.send(CMD.SLOT_RECALL, new Uint8Array([bank, slot])) : Promise.resolve(); }

  function onFrame(f) {
    if (f.cmd === RSP.SLOT_ACK && slotAck) {
      const a = slotAck; slotAck = null; clearTimeout(a.timer);
      if (f.payload[0]) a.resolve(); else a.reject(new Error(`slot ${f.payload[1]}:${f.payload[2]} rejected`));
      return;
    }
    if (f.cmd === RSP.ZONE_STATE && f.payload.length >= 5) {
      const p = f.payload;
      onZoneState({ midi: { yaw: p[0], pitch: p[1] }, analog: { yaw: p[2], pitch: p[3] }, frozen: { yaw: !!(p[4] & 1), pitch: !!(p[4] & 2) } });
      return;
    }
    if (f.cmd === RSP.SLOT_CHANGED) {
      const p = f.payload;
      const gcId = p[3] === NO_GC ? null : String.fromCharCode(65 + p[3]) + p[4];
      onRecall(p[1], p[2], !!p[0], gcId);
      return;
    }
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
    onRecall = (opts && opts.onRecall) || onRecall;
    onZoneState = (opts && opts.onZoneState) || onZoneState;
    if (window.Pedal) window.Pedal.onRaw(onFrame);
  }

  window.OrbitProgram = { encode, decode, push, schedule, readBack, clear, init, lastPushed: () => lastPushed, CMD, RSP,
    encodeSlot, syncSetlists, scheduleSync, forgetPushed, recall };
})();
