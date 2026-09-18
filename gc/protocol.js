/* Ground Control bridge protocol — a plain-JS port of gc_dsp/web/src/protocol.ts
   + types.ts. Frames: [0xAA][cmd][len][payload…][xor of cmd,len,payload].
   Everything is exposed on window.GCP so the other gc/ modules (and orbit.js)
   can use it without a build step. */

'use strict';

(function () {
  const FRAME_START = 0xaa;
  const MAX_PAYLOAD = 64;

  /* ---- command / reply ids (must match gc_ui bridge.cpp) ------------- */
  const CMD = {
    PING: 0x01, SET_PARAM: 0x02, SET_THRESH: 0x03, SET_BYPASS: 0x04,
    SET_ASSIGN: 0x05, SET_MODE: 0x06, SET_LED_RGB: 0x07, SET_CHAIN_ORDER: 0x08,
    SET_CURVE: 0x0b,
    LIST_PRESETS: 0x10, GET_PRESET: 0x11, LOAD_PRESET: 0x12, SAVE_PRESET: 0x13,
    DELETE_PRESET: 0x14, SET_PRESET_NAME: 0x15, REMOVE_ASSIGN: 0x16, REMOVE_PARAM: 0x17,
    DSP_DFU: 0x18,
  };
  const REPLY = {
    PONG: 0x81, LIVE_VAL: 0x82, ASSIGN_STATE: 0x83, MODE: 0x84, ENCODER_VAL: 0x85,
    MARKER_HIT: 0x86, AXIS_RAW: 0x87,
    PRESET_INFO: 0x90, LIST_END: 0x91, LOADED: 0x92, PRESET_MASKS: 0x93,
  };
  const nameOf = (table, v) => { for (const k in table) if (table[k] === v) return k; return null; };
  const frameName = cmd => nameOf(REPLY, cmd) || nameOf(CMD, cmd) || ('0x' + cmd.toString(16).padStart(2, '0'));

  const MAX_EFFECTS = 16;
  const PRESET_NAME_MAX = 10;
  const EFFECT_NAMES = [
    'Shimmer Reverb', 'Vox Wah', 'Pong Delay', 'Big Muff', 'Whammy', 'Chorus',
    'Fuzz Face', 'Octavia', 'Carbon Copy', 'Hall', 'Flange', 'Tube Screamer',
    'Tremolo', 'Ring Mod', 'Harmonizer', 'Volume',
  ];
  /* the pedal's LED / screen colours, by index (matches gc_ui menu.cpp) */
  const COLOR_PALETTE = [
    { name: 'Green',  hex: '#00C000' },
    { name: 'Purple', hex: '#C000C0' },
    { name: 'Red',    hex: '#C00000' },
    { name: 'Cyan',   hex: '#00C0C0' },
    { name: 'Yellow', hex: '#C0C000' },
    { name: 'Blue',   hex: '#0000C0' },
    { name: 'White',  hex: '#E8E8E8' },
    { name: 'Off',    hex: '#404040' },
  ];

  /* ---- framing ------------------------------------------------------- */
  function xorChecksum(bytes, from, to) {
    let x = 0;
    for (let i = from; i < to; i++) x ^= bytes[i];
    return x & 0xff;
  }
  function encodeFrame(cmd, payload) {
    payload = payload || new Uint8Array(0);
    if (payload.length > MAX_PAYLOAD) throw new Error(`payload too long (${payload.length} > ${MAX_PAYLOAD})`);
    const out = new Uint8Array(4 + payload.length);
    out[0] = FRAME_START; out[1] = cmd & 0xff; out[2] = payload.length;
    out.set(payload, 3);
    out[out.length - 1] = xorChecksum(out, 1, out.length - 1);
    return out;
  }
  /* streaming parser: feed() bytes in any chunking, get whole frames out */
  class FrameParser {
    constructor() { this.reset(); }
    reset() { this.st = 0; this.cmd = 0; this.len = 0; this.buf = null; this.n = 0; this.dropped = 0; }
    feed(bytes) {
      const frames = [];
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        switch (this.st) {
          case 0: if (b === FRAME_START) this.st = 1; else this.dropped++; break;
          case 1: this.cmd = b; this.st = 2; break;
          case 2:
            if (b > MAX_PAYLOAD) { this.dropped++; this.st = 0; break; }
            this.len = b; this.buf = new Uint8Array(b); this.n = 0;
            this.st = b ? 3 : 4; break;
          case 3: this.buf[this.n++] = b; if (this.n === this.len) this.st = 4; break;
          case 4: {
            let x = this.cmd ^ this.len;
            for (let k = 0; k < this.len; k++) x ^= this.buf[k];
            if ((x & 0xff) === b) frames.push({ cmd: this.cmd, payload: this.buf });
            else this.dropped++;
            this.st = 0; break;
          }
        }
      }
      return frames;
    }
  }

  /* ---- little-endian helpers ---------------------------------------- */
  const f32ToBytes = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };
  const bytesToF32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
  const bytesToU16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u16ToBytes = v => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);

  /* ---- frame builders ----------------------------------------------- */
  const cat = (...parts) => {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const b = (...xs) => new Uint8Array(xs);
  const frames = {
    ping: () => encodeFrame(CMD.PING),
    setParam: (eff, par, v) => encodeFrame(CMD.SET_PARAM, cat(b(eff, par), f32ToBytes(v))),
    setThresh: (eff, par, lo, hi) => encodeFrame(CMD.SET_THRESH, cat(b(eff, par), f32ToBytes(lo), f32ToBytes(hi))),
    setCurve: (eff, par, lut) => encodeFrame(CMD.SET_CURVE, cat(b(eff, par), lut)),
    setBypass: (screen, byp) => encodeFrame(CMD.SET_BYPASS, b(screen, byp ? 1 : 0)),
    setAssign: (axis, eff, par, mode) => encodeFrame(CMD.SET_ASSIGN, b(axis, eff, par, mode)),
    setChainOrder: ids => encodeFrame(CMD.SET_CHAIN_ORDER, cat(b(ids.length), new Uint8Array(ids))),
    listPresets: () => encodeFrame(CMD.LIST_PRESETS),
    getPreset: (L, D) => encodeFrame(CMD.GET_PRESET, b(L, D)),
    loadPreset: (L, D) => encodeFrame(CMD.LOAD_PRESET, b(L, D)),
    savePreset: (L, D) => encodeFrame(CMD.SAVE_PRESET, b(L, D)),
    deletePreset: (L, D) => encodeFrame(CMD.DELETE_PRESET, b(L, D)),
    setPresetName: (L, D, name) => {
      const s = String(name).slice(0, PRESET_NAME_MAX);
      const a = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0x7f;
      return encodeFrame(CMD.SET_PRESET_NAME, cat(b(L, D), a));
    },
    removeAssign: (axis, eff) => encodeFrame(CMD.REMOVE_ASSIGN, b(axis, eff)),
    removeParam: (axis, eff, par) => encodeFrame(CMD.REMOVE_PARAM, b(axis, eff, par)),
    dspDfu: () => encodeFrame(CMD.DSP_DFU),
  };

  /* ---- replies ------------------------------------------------------- */
  /* PRESET_INFO: [L][D][colorIdx][axisEffPitch u16][axisEffYaw u16]
                  [pitchEff][pitchPar][yawEff][yawPar][nameLen][name…][chainLen][chain…] */
  function parsePresetInfo(p) {
    if (p.length < 11) return null;
    const info = {
      letter: p[0], digit: p[1], colorIdx: p[2],
      axisEffectsPitch: bytesToU16(p, 3), axisEffectsYaw: bytesToU16(p, 5),
      pitchEff: p[7], pitchPar: p[8], yawEff: p[9], yawPar: p[10],
      name: '', chain: [],
      parMasksPitch: new Array(MAX_EFFECTS).fill(0),
      parMasksYaw: new Array(MAX_EFFECTS).fill(0),
    };
    let o = 11;
    if (p.length > o) {
      const n = Math.min(p[o], PRESET_NAME_MAX); o++;
      let s = '';
      for (let i = 0; i < n && o + i < p.length; i++) s += String.fromCharCode(p[o + i]);
      info.name = s; o += n;
    }
    if (p.length > o) {
      const n = Math.min(p[o], MAX_EFFECTS); o++;
      for (let i = 0; i < n && o + i < p.length; i++) info.chain.push(p[o + i]);
    }
    /* until a PRESET_MASKS frame arrives, assume each axis drives its primary param */
    for (let e = 0; e < MAX_EFFECTS; e++) {
      if (info.axisEffectsPitch & (1 << e)) info.parMasksPitch[e] = 1 << (info.pitchEff === e ? info.pitchPar : 0);
      if (info.axisEffectsYaw & (1 << e)) info.parMasksYaw[e] = 1 << (info.yawEff === e ? info.yawPar : 0);
    }
    return info;
  }
  /* PRESET_MASKS: [L][D][16 pitch masks][16 yaw masks] */
  function parsePresetMasks(p) {
    if (p.length < 2 + 2 * MAX_EFFECTS) return null;
    return {
      letter: p[0], digit: p[1],
      parMasksPitch: Array.from(p.subarray(2, 2 + MAX_EFFECTS)),
      parMasksYaw: Array.from(p.subarray(2 + MAX_EFFECTS, 2 + 2 * MAX_EFFECTS)),
    };
  }
  /* builders for the replies too — the simulator speaks the same bytes */
  function buildPresetInfo(info) {
    const name = String(info.name || '').slice(0, PRESET_NAME_MAX);
    const nb = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) nb[i] = name.charCodeAt(i) & 0x7f;
    const chain = (info.chain || []).slice(0, MAX_EFFECTS);
    return encodeFrame(REPLY.PRESET_INFO, cat(
      b(info.letter, info.digit, info.colorIdx),
      u16ToBytes(info.axisEffectsPitch), u16ToBytes(info.axisEffectsYaw),
      b(info.pitchEff, info.pitchPar, info.yawEff, info.yawPar),
      b(nb.length), nb, b(chain.length), new Uint8Array(chain)));
  }
  function buildPresetMasks(info) {
    return encodeFrame(REPLY.PRESET_MASKS, cat(b(info.letter, info.digit),
      new Uint8Array(info.parMasksPitch), new Uint8Array(info.parMasksYaw)));
  }
  const slotLabel = (L, D) => String.fromCharCode(65 + L) + D;
  const hexDump = p => Array.from(p, x => x.toString(16).padStart(2, '0')).join(' ');

  window.GCP = {
    FRAME_START, MAX_PAYLOAD, CMD, REPLY, frameName, MAX_EFFECTS, PRESET_NAME_MAX,
    EFFECT_NAMES, COLOR_PALETTE, encodeFrame, FrameParser,
    f32ToBytes, bytesToF32, bytesToU16, u16ToBytes, frames,
    parsePresetInfo, parsePresetMasks, buildPresetInfo, buildPresetMasks, slotLabel, hexDump,
  };
})();
