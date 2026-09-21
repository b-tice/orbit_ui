/* A Ground Control simulated in the page. Implements the Link interface
   (connect / disconnect / send / isConnected + events) and answers with the
   same bytes gc_ui's bridge.cpp would. Its Setup bank starts as the factory
   bank (gc/factory.js) and persists in localStorage like the unit's NVS.
   opts.getAxes() → { pitch: 0..1, yaw: 0..1 } drives LIVE_VAL / AXIS_RAW.
   window.GCSim */

'use strict';

(function () {
  const G = window.GCP, FX = window.GCFX, EFFECTS = FX.EFFECTS, C = window.GCCurve;
  const STORE = 'orbit_ui_gc_sim_v1';
  const MAX_E = G.MAX_EFFECTS, MAX_P = 8;
  const DEFAULT_CHAIN = [11, 3, 6, 7, 13, 1, 4, 14, 8, 0, 9, 2, 5, 10, 12];
  const LETTERS = 26, DIGITS = 10;
  const key = (L, D) => L * 16 + D;
  const popcount = m => { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; };
  const lowestBit = m => { for (let i = 0; i < 16; i++) if (m & (1 << i)) return i; return -1; };
  const grid = (fill) => Array.from({ length: MAX_E }, () => Array.from({ length: MAX_P }, fill));
  const pmin = (e, p) => (EFFECTS[e] && EFFECTS[e].params[p] ? EFFECTS[e].params[p].min : 0);
  const pmax = (e, p) => (EFFECTS[e] && EFFECTS[e].params[p] ? EFFECTS[e].params[p].max : 1);
  const pdef = (e, p) => (EFFECTS[e] && EFFECTS[e].params[p] ? EFFECTS[e].params[p].defaultVal : 0);

  /* one stored Setup (the firmware's Preset struct) */
  function blankPreset(color) {
    return {
      used: true, name: '', colorIdx: color || 0,
      axisEffects: [0, 0],
      axisEffectPar: [new Array(MAX_E).fill(0), new Array(MAX_E).fill(0)],
      paramVal: grid((_, p, e) => 0),
      threshLo: [grid(() => 0), grid(() => 0)],
      threshHi: [grid(() => 0), grid(() => 0)],
      chain: [],
    };
  }
  function baseFromDefaults(color) {
    const p = blankPreset(color);
    for (let e = 0; e < MAX_E; e++) for (let q = 0; q < MAX_P; q++) {
      p.paramVal[e][q] = pdef(e, q);
      for (let s = 0; s < 2; s++) { p.threshLo[s][e][q] = pmin(e, q); p.threshHi[s][e][q] = pmax(e, q); }
    }
    return p;
  }
  function factoryBank() {
    const bank = new Map();
    for (const f of window.GC_FACTORY || []) {
      const p = baseFromDefaults(f.color);
      p.name = f.name || '';
      p.axisEffects = f.ax.slice();
      for (let a = 0; a < 2; a++) for (const e in f.par[a]) p.axisEffectPar[a][+e] = f.par[a][e];
      for (const k in f.val) { const [e, q] = k.split(',').map(Number); p.paramVal[e][q] = f.val[k]; }
      for (const k in f.th) { const [s, e, q] = k.split(',').map(Number); p.threshLo[s][e][q] = f.th[k][0]; p.threshHi[s][e][q] = f.th[k][1]; }
      /* a factory Setup's chain: the default cascade filtered to its effects */
      const active = p.axisEffects[0] | p.axisEffects[1];
      p.chain = DEFAULT_CHAIN.filter(e => active & (1 << e));
      bank.set(key(f.L, f.D), p);
    }
    return bank;
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  class SimLink {
    constructor(events, opts) {
      this.ev = events; this.opts = opts || {};
      this.connected = false;
      this.timers = new Set();
      this.parser = new G.FrameParser();
      this.loadFlash();
      this.reboot();
    }
    /* ---- "NVS" ------------------------------------------------------- */
    loadFlash() {
      this.bank = null;
      try {
        const raw = localStorage.getItem(STORE);
        if (raw) {
          const s = JSON.parse(raw);
          this.bank = new Map(s.bank.map(([k, v]) => [k, v]));
          this.curves = new Map(s.curves || []);
          this.bootSlot = s.bootSlot || null;
        }
      } catch (e) { this.bank = null; }
      if (!this.bank) { this.bank = factoryBank(); this.curves = new Map(); this.bootSlot = { L: 0, D: 5 }; }
    }
    saveFlash() {
      try {
        localStorage.setItem(STORE, JSON.stringify({ bank: [...this.bank.entries()], curves: [...this.curves.entries()], bootSlot: this.bootSlot }));
      } catch (e) {}
    }
    factoryReset() { try { localStorage.removeItem(STORE); } catch (e) {} this.loadFlash(); this.reboot(); }
    /* ---- power-on state --------------------------------------------- */
    reboot() {
      this.live = baseFromDefaults(0);          /* current values / thresholds */
      this.axisEffects = [0, 0];
      this.axisEffectPar = [new Array(MAX_E).fill(0), new Array(MAX_E).fill(0)];
      this.chain = DEFAULT_CHAIN.slice();
      this.screens = [{ sel: 0xff, par: 0, bypass: false }, { sel: 0xff, par: 0, bypass: false }];  /* [0] = YAW, [1] = PITCH */
      this.loaded = null;                       /* { L, D, color } */
      const b = this.bootSlot;
      if (b && this.bank.has(key(b.L, b.D))) this.applyPreset(b.L, b.D);
    }
    applyPreset(L, D) {
      const p = this.bank.get(key(L, D));
      if (!p) return false;
      this.live.paramVal = clone(p.paramVal);
      this.live.threshLo = clone(p.threshLo);
      this.live.threshHi = clone(p.threshHi);
      this.axisEffects = p.axisEffects.slice();
      this.axisEffectPar = clone(p.axisEffectPar);
      this.chain = p.chain.length ? p.chain.slice() : this.syncedChain(DEFAULT_CHAIN);
      for (let a = 0; a < 2; a++) this.repickScreen(a);
      this.loaded = { L, D, color: p.colorIdx };
      this.bootSlot = { L, D };
      return true;
    }
    /* screen s shows axis a's lowest-bit effect and its lowest-bit param */
    repickScreen(a) {
      const s = a === 0 ? 1 : 0;
      const e = lowestBit(this.axisEffects[a]);
      this.screens[s].sel = e < 0 ? 0xff : e;
      this.screens[s].par = e < 0 ? 0 : Math.max(0, lowestBit(this.axisEffectPar[a][e] || 1));
    }
    syncedChain(from) {
      const active = this.axisEffects[0] | this.axisEffects[1];
      const next = from.filter(e => active & (1 << e));
      for (let e = 0; e < MAX_E; e++) if ((active & (1 << e)) && !next.includes(e)) next.push(e);
      return next;
    }
    captureCurrent(color, name) {
      const p = baseFromDefaults(color);
      p.name = name || '';
      p.paramVal = clone(this.live.paramVal);
      p.threshLo = clone(this.live.threshLo);
      p.threshHi = clone(this.live.threshHi);
      p.axisEffects = this.axisEffects.slice();
      p.axisEffectPar = clone(this.axisEffectPar);
      p.chain = this.chain.slice();
      return p;
    }
    info(L, D, p) {
      const primary = a => {
        const e = lowestBit(p.axisEffects[a]);
        return e < 0 ? [0xff, 0] : [e, Math.max(0, lowestBit(p.axisEffectPar[a][e] || 1))];
      };
      const [pe, pp] = primary(0), [ye, yp] = primary(1);
      return {
        letter: L, digit: D, colorIdx: p.colorIdx,
        axisEffectsPitch: p.axisEffects[0], axisEffectsYaw: p.axisEffects[1],
        pitchEff: pe, pitchPar: pp, yawEff: ye, yawPar: yp,
        name: p.name, chain: p.chain,
        parMasksPitch: p.axisEffectPar[0].slice(), parMasksYaw: p.axisEffectPar[1].slice(),
      };
    }
    /* ---- Link interface --------------------------------------------- */
    isConnected() { return this.connected; }
    async connect() {
      if (this.connected) throw new Error('already connected');
      this.connected = true;
      this.ev.onConnect();
      /* what the unit pushes to a fresh editor: its curves, then the live state */
      this.after(1000, () => this.pushCurves());
      this.after(1300, () => this.pushState());
      this.tick = setInterval(() => this.broadcastLive(), 40);   /* ~25 Hz like the WS relay */
    }
    async disconnect() {
      if (!this.connected) return;
      this.connected = false;
      clearInterval(this.tick); this.tick = null;
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.ev.onDisconnect();
    }
    async send(bytes) {
      if (!this.connected) throw new Error('not connected');
      for (const f of this.parser.feed(bytes)) this.handle(f.cmd, f.payload);
    }
    /* replies leave a beat later, as they would over the radio */
    emit(frame, delay) {
      this.after(delay || 4, () => { if (this.connected) for (const f of new G.FrameParser().feed(frame)) this.ev.onFrame(f); });
    }
    after(ms, fn) {
      const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
      this.timers.add(t);
      return t;
    }
    reply(cmd, payload, delay) { this.emit(G.encodeFrame(cmd, payload), delay); }
    sendPresetInfo(L, D, p, delay) {
      const i = this.info(L, D, p);
      this.emit(G.buildPresetInfo(i), delay);
      this.emit(G.buildPresetMasks(i), (delay || 4) + 2);
    }
    sendLoaded(delay) {
      const l = this.loaded;
      if (l) this.reply(G.REPLY.LOADED, new Uint8Array([l.L, l.D, l.color]), delay);
    }
    pushCurves() {
      let d = 0;
      for (const [k, lut] of this.curves) {
        const [e, p] = k.split(',').map(Number);
        this.emit(G.frames.setCurve(e, p, new Uint8Array(lut)), d += 6);
      }
    }
    pushState() {
      let d = 0;
      for (let a = 0; a < 2; a++) {
        const s = a === 0 ? 1 : 0;
        for (let e = 0; e < MAX_E; e++) {
          if (!(this.axisEffects[a] & (1 << e))) continue;
          const mask = this.axisEffectPar[a][e] || 1;
          for (let p = 0; p < MAX_P; p++) {
            if (!(mask & (1 << p))) continue;
            this.emit(G.frames.setThresh(e, p, this.live.threshLo[s][e][p], this.live.threshHi[s][e][p]), d += 6);
            this.emit(G.frames.setParam(e, p, this.live.paramVal[e][p]), d += 6);
          }
        }
      }
    }
    /* the pedal position, shaped by the curve, becomes each screen's value */
    broadcastLive() {
      const ax = this.opts.getAxes ? this.opts.getAxes() : { pitch: 0.5, yaw: 0.5 };
      const p14 = Math.round(Math.max(0, Math.min(1, ax.pitch)) * 16383);
      const y14 = Math.round(Math.max(0, Math.min(1, ax.yaw)) * 16383);
      this.reply(G.REPLY.AXIS_RAW, new Uint8Array([p14 & 0xff, p14 >> 8, y14 & 0xff, y14 >> 8]), 1);
      for (let a = 0; a < 2; a++) {
        const s = a === 0 ? 1 : 0, sc = this.screens[s];
        if (sc.sel === 0xff) continue;
        const x = a === 0 ? ax.pitch : ax.yaw;
        const lut = this.curves.get(sc.sel + ',' + sc.par);
        const t = lut ? C.sampleLut(lut, x) : x;
        const lo = this.live.threshLo[s][sc.sel][sc.par], hi = this.live.threshHi[s][sc.sel][sc.par];
        const v = lo + (hi - lo) * t;
        this.live.paramVal[sc.sel][sc.par] = v;
        this.reply(G.REPLY.LIVE_VAL, G.frames.setParam(sc.sel, sc.par, v).subarray(3, 9), 2);
      }
    }
    /* ---- the bridge's command handler (bridge.cpp handleHostFrame) --- */
    handle(cmd, p) {
      const CMD = G.CMD, R = G.REPLY;
      switch (cmd) {
        case CMD.PING: this.reply(R.PONG); break;
        case CMD.DSP_DFU: break;
        case CMD.SET_PARAM:
          if (p.length >= 6 && p[0] < MAX_E) this.live.paramVal[p[0]][p[1]] = G.bytesToF32(p, 2);
          break;
        case CMD.SET_THRESH:
          if (p.length >= 10 && p[0] < MAX_E) for (let s = 0; s < 2; s++) {
            this.live.threshLo[s][p[0]][p[1]] = G.bytesToF32(p, 2);
            this.live.threshHi[s][p[0]][p[1]] = G.bytesToF32(p, 6);
          }
          break;
        case CMD.SET_CURVE: {
          if (p.length < 3) break;
          const k = p[0] + ',' + p[1], lut = Array.from(p.subarray(2));
          let ident = true;
          for (let i = 0; i < lut.length; i++) if (Math.abs(lut[i] - Math.round(i * 255 / (lut.length - 1))) > 1) { ident = false; break; }
          if (ident) this.curves.delete(k); else this.curves.set(k, lut);   /* identity = "no curve" */
          this.saveFlash();
          break;
        }
        case CMD.SET_BYPASS: if (p.length >= 2 && p[0] < 2) this.screens[p[0]].bypass = !!p[1]; break;
        case CMD.SET_ASSIGN: {
          if (p.length < 4 || p[0] > 1 || p[1] >= MAX_E) break;
          const [a, e, par, mode] = p;
          if (mode === 1) {                                     /* ADD */
            const was = this.axisEffects[a] & (1 << e);
            this.axisEffects[a] |= (1 << e);
            this.axisEffectPar[a][e] = was ? (this.axisEffectPar[a][e] | (1 << par)) : (1 << par);
          } else {                                              /* REPLACE */
            this.axisEffects[a] = 1 << e;
            this.axisEffectPar[a].fill(0);
            this.axisEffectPar[a][e] = 1 << par;
          }
          this.chain = this.syncedChain(this.chain);
          const s = a === 0 ? 1 : 0;
          this.screens[s].sel = e; this.screens[s].par = par;
          break;
        }
        case CMD.SET_CHAIN_ORDER: {
          if (p.length < 1) break;
          const ids = Array.from(p.subarray(1, 1 + p[0]));
          if (ids.every(i => i < MAX_E)) this.chain = ids;
          break;
        }
        case CMD.LIST_PRESETS: {
          let d = 0;
          for (let L = 0; L < LETTERS; L++) for (let D = 0; D < DIGITS; D++) {
            const q = this.bank.get(key(L, D));
            if (!q) continue;
            this.sendPresetInfo(L, D, q, d += 15);
          }
          this.reply(R.LIST_END, null, d += 15);
          this.sendLoaded(d + 4);
          break;
        }
        case CMD.GET_PRESET: {
          const q = p.length >= 2 && this.bank.get(key(p[0], p[1]));
          if (q) this.sendPresetInfo(p[0], p[1], q);
          break;
        }
        case CMD.SAVE_PRESET: {
          if (p.length < 2) break;
          const [L, D] = p, old = this.bank.get(key(L, D));
          const color = old ? old.colorIdx : (this.loaded ? this.loaded.color : 0);
          const q = this.captureCurrent(color, old ? old.name : '');
          this.bank.set(key(L, D), q);
          this.loaded = { L, D, color }; this.bootSlot = { L, D };
          this.saveFlash();
          this.sendPresetInfo(L, D, q);
          this.sendLoaded(10);
          break;
        }
        case CMD.DELETE_PRESET: {
          if (p.length < 2) break;
          this.bank.delete(key(p[0], p[1]));
          if (this.loaded && this.loaded.L === p[0] && this.loaded.D === p[1]) this.loaded = null;
          this.saveFlash();
          break;
        }
        case CMD.SET_PRESET_NAME: {
          if (p.length < 2) break;
          const q = this.bank.get(key(p[0], p[1]));
          if (!q) break;
          let s = '';
          for (let i = 2; i < Math.min(p.length, 2 + G.PRESET_NAME_MAX); i++) s += String.fromCharCode(p[i]);
          q.name = s;
          this.saveFlash();
          this.sendPresetInfo(p[0], p[1], q);
          break;
        }
        case CMD.REMOVE_PARAM: {
          if (p.length < 3 || p[0] > 1 || p[1] >= MAX_E) break;
          const [a, e, par] = p, am = this.axisEffects[a];
          if (!(am & (1 << e))) break;
          const pm = this.axisEffectPar[a][e];
          if (!(pm & (1 << par))) break;
          const after = pm & ~(1 << par);
          if (after === 0 && popcount(am) <= 1) break;          /* last effect: refused */
          this.axisEffectPar[a][e] = after;
          if (after === 0) this.axisEffects[a] = am & ~(1 << e);
          this.chain = this.syncedChain(this.chain);
          this.repickScreen(a);
          break;
        }
        case CMD.REMOVE_ASSIGN: {
          if (p.length < 2 || p[0] > 1 || p[1] >= MAX_E) break;
          const [a, e] = p, m = this.axisEffects[a];
          if ((m & (1 << e)) && popcount(m) > 1) {
            this.axisEffects[a] = m & ~(1 << e);
            this.axisEffectPar[a][e] = 0;
            this.chain = this.syncedChain(this.chain);
            this.repickScreen(a);
          }
          break;
        }
        case CMD.GET_PRESET_DUMP: {
          if (p.length < 2) break;
          const [L, D] = p, q = this.bank.get(key(L, D));
          if (!q) break;
          let d = 0;
          this.sendPresetInfo(L, D, q, d += 4);
          for (let e = 0; e < MAX_E; e++) {
            const n = (EFFECTS[e] || { params: [] }).params.length;
            if (!n) continue;
            this.emit(G.frames.presetValues(L, D, e, q.paramVal[e].slice(0, n)), d += 4);
          }
          for (let a = 0; a < 2; a++) {
            const s = a === 0 ? 1 : 0;
            for (let e = 0; e < MAX_E; e++) {
              if (!(q.axisEffects[a] & (1 << e))) continue;
              const mask = q.axisEffectPar[a][e] || 1;
              for (let par = 0; par < MAX_P; par++) {
                if (!(mask & (1 << par))) continue;
                this.emit(G.frames.presetThresh(L, D, a, e, par, q.threshLo[s][e][par], q.threshHi[s][e][par]), d += 4);
                const lut = this.curves.get(e + ',' + par);
                if (lut) this.emit(G.frames.presetCurve(L, D, e, par, lut), d += 4);
              }
            }
          }
          this.emit(G.frames.presetDumpEnd(L, D), d += 4);
          break;
        }
        case CMD.SET_PRESET_COLOR: {
          if (p.length < 3) break;
          const q = this.bank.get(key(p[0], p[1]));
          if (!q) break;
          q.colorIdx = p[2] & 7;
          if (this.loaded && this.loaded.L === p[0] && this.loaded.D === p[1]) this.loaded.color = q.colorIdx;
          this.saveFlash();
          this.sendPresetInfo(p[0], p[1], q);
          break;
        }
        case CMD.LOAD_PRESET: {
          if (p.length < 2) break;
          const [L, D] = p;
          if (!this.applyPreset(L, D)) break;
          this.saveFlash();
          this.sendPresetInfo(L, D, this.bank.get(key(L, D)));
          this.sendLoaded(10);
          this.after(300, () => this.pushState());
          break;
        }
        default: break;
      }
    }
    /* the first empty slot, for "+ new" (A0 upward) */
    firstFreeSlot() {
      for (let L = 0; L < LETTERS; L++) for (let D = 0; D < DIGITS; D++) if (!this.bank.has(key(L, D))) return { L, D };
      return null;
    }
  }

  window.GCSim = {
    create: (events, opts) => new SimLink(events, opts),
    STORE,
  };
})();
