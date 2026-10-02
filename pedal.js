/* The Orbit pedal itself — its settings editor, replacing the pedal's old
   settings page. Talks the pedal's own bridge protocol (orbit/src/bridge.cpp):
   0xAA frames, PING 0x01, GET/SET_SETTINGS 0x10/0x11 (15-byte blob),
   SAVE 0x12, TARE 0x13, GET_INFO 0x14; replies PONG 0x81, AXIS 0x82,
   SETTINGS 0x90, SAVED 0x91, TARED 0x92, INFO 0x93. Served by the pedal the
   link is its WebSocket; elsewhere, Web Serial over the USB cable.
   The live AXIS stream drives the ▲ markers on every tab. window.Pedal */

'use strict';

(function () {
  const G = window.GCP;
  const CMD = { PING: 0x01, GET_SETTINGS: 0x10, SET_SETTINGS: 0x11, SAVE: 0x12, TARE: 0x13, GET_INFO: 0x14, GC_TUNNEL: 0x20, GC_STATUS: 0x21, DIAG: 0x22 };
  const RSP = { PONG: 0x81, AXIS: 0x82, SETTINGS: 0x90, SAVED: 0x91, TARED: 0x92, INFO: 0x93, GC_TUNNEL: 0xa0, GC_STATUS: 0xa1, DIAG: 0xa2 };
  const BLOB_VERSION = 1, BLOB_LEN = 15;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let hooks = {}, ui = {}, link = null, kind = null, info = null, settings = null, dirty = false, lastAxisMs = 0, lastPingAt = 0;
  /* bench readout: the pedal answers DIAG from its network task, so it still speaks when its main loop has stalled */
  let diagTimer = null, diagText = '', diagAt = 0;
  /* Ground Control behind the pedal (protocol v2 HELLO relayed as GC_STATUS) */
  let gc = { present: false, fw: '', caps: 0, protocol: 0 };
  const rawTaps = new Set(), gcTaps = new Set();

  const decodeSettings = p => (p.length < BLOB_LEN ? null : {
    channel: p[1] & 15, ccPitch: p[2] & 127, ccYaw: p[3] & 127, enPitch: !!p[4], enYaw: !!p[5], invPitch: !!p[6], invYaw: !!p[7],
    tapEnable: !!p[8], tapNote: p[9] & 127, outMinPitch: p[10] & 127, outMaxPitch: p[11] & 127, outMinYaw: p[12] & 127, outMaxYaw: p[13] & 127, wifiEnable: !!p[14],
  });
  const encodeSettings = s => new Uint8Array([BLOB_VERSION, s.channel & 15, s.ccPitch & 127, s.ccYaw & 127, s.enPitch ? 1 : 0, s.enYaw ? 1 : 0, s.invPitch ? 1 : 0, s.invYaw ? 1 : 0,
    s.tapEnable ? 1 : 0, s.tapNote & 127, s.outMinPitch & 127, s.outMaxPitch & 127, s.outMinYaw & 127, s.outMaxYaw & 127, s.wifiEnable ? 1 : 0]);
  const decodeInfo = p => (p.length < 13 ? null : {
    fw: `${p[0]}.${p[1]}.${p[2]}`, hwRev: p[3],
    mac: Array.from(p.subarray(4, 10), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    hosted: !!p[10], calib: p[11], imuOk: !!(p[12] & 1), encoderOk: !!(p[12] & 2), dacOk: !!(p[12] & 4),
  });

  const connected = () => !!link && link.isConnected();
  function tx(cmd, payload) { if (!connected()) return; link.send(G.encodeFrame(cmd, payload)).catch(err => setStatus(err.message, 'err')); }
  function setStatus(text, cls) { ui.status.textContent = text; ui.status.className = 'gc-status' + (cls ? ' ' + cls : ''); }

  /* ---- panel ------------------------------------------------------------ */
  const PANEL = 'gc-panel ambient amb-surface amb-chamfer amb-elevation-2 ambx-panel amb-mat-blasted amb-rounded-xl';
  const axisRows = (key, label) => `
    <div class="pd-axis">
      <h4>${label}</h4>
      <label class="polarity"><span class="pol-lbl">send</span><input type="checkbox" data-f="en${key}"><span class="pol-switch"></span></label>
      <label class="field"><span>CC</span><input type="number" min="0" max="127" inputmode="numeric" data-f="cc${key}"></label>
      <label class="polarity"><span class="pol-lbl">invert</span><input type="checkbox" data-f="inv${key}"><span class="pol-switch"></span></label>
      <label class="field"><span>OUT</span><span class="pair"><input type="number" min="0" max="127" inputmode="numeric" data-f="outMin${key}">–<input type="number" min="0" max="127" inputmode="numeric" data-f="outMax${key}"></span></label>
    </div>`;
  function template() {
    return `
    <section class="${PANEL}" id="pd-panel">
      <div class="gc-head"><h3>ORBIT PEDAL</h3><span class="gc-status" id="pd-status">not connected</span></div>
      <div class="gc-row">
        <button class="ghostbtn" id="pd-connect" type="button">connect USB</button>
        <button class="ghostbtn" id="pd-disconnect" type="button" disabled>disconnect</button>
        <button class="ghostbtn" id="pd-tare" type="button" disabled title="take the pedal's current pose as its zero">tare</button>
        <button class="ghostbtn" id="pd-ping" type="button" disabled>ping</button>
        <span class="gc-status" id="pd-info"></span>
      </div>
      <div id="pd-diag" style="font-family:var(--mono);font-size:13px;line-height:1.4;color:var(--ink);white-space:pre-wrap;word-break:break-all;padding:4px 0 2px"></div>
      <div class="pd-settings" id="pd-settings" hidden>
        <div class="gc-help">These apply when the pedal is plugged straight into a computer (DAW mode). Docked on Ground Control it always speaks the fixed link protocol, so nothing here can break that.</div>
        <div class="pd-grid">
          <label class="field"><span>TRANSMIT CH</span><select data-f="channel">${Array.from({ length: 16 }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('')}</select></label>
          <label class="polarity"><span class="pol-lbl">tap note</span><input type="checkbox" data-f="tapEnable"><span class="pol-switch"></span></label>
          <label class="field"><span>NOTE</span><input type="number" min="0" max="127" inputmode="numeric" data-f="tapNote"></label>
          <label class="polarity" title="the pedal's own WiFi access point — applied at the next power-up"><span class="pol-lbl">WiFi</span><input type="checkbox" data-f="wifiEnable"><span class="pol-switch"></span></label>
        </div>
        <div class="pd-axes">${axisRows('Pitch', 'PITCH')}${axisRows('Yaw', 'YAW')}</div>
        <div class="gc-row">
          <button class="ghostbtn savebtn" id="pd-apply" type="button" disabled title="send these settings to the pedal (live, until the next power-up)">apply</button>
          <button class="ghostbtn" id="pd-save" type="button" disabled title="store the pedal's live settings in its flash">save to pedal</button>
          <span class="gc-status" id="pd-note"></span>
        </div>
      </div>
    </section>`;
  }

  function renderInfo() {
    if (!info) { ui.info.textContent = ''; return; }
    const calib = ['uncalibrated', 'calibrating', 'calibrated'][info.calib] || `calib ${info.calib}`;
    const host = gc.present ? `on Ground Control ${gc.fw} (tunnel)` : info.hosted ? 'on Ground Control — its firmware predates the tunnel, update it for the GROUND CONTROL tab' : 'standalone';
    const parts = [`fw ${info.fw}`, `hw ${info.hwRev}`, host, `IMU ${info.imuOk ? calib : 'missing'}`, info.dacOk ? 'EXP ok' : 'EXP missing'];
    ui.info.textContent = parts.join(' · ');
    if (hooks.onInfo) hooks.onInfo(info);
  }
  function renderSettings() {
    ui.settings.hidden = !settings;
    if (!settings) return;
    for (const el of ui.settings.querySelectorAll('[data-f]')) {
      const f = el.dataset.f;
      if (el.type === 'checkbox') el.checked = !!settings[f]; else el.value = settings[f];
    }
    setDirty(false);
  }
  function readSettings() {
    const s = { ...settings };
    for (const el of ui.settings.querySelectorAll('[data-f]')) {
      const f = el.dataset.f;
      s[f] = el.type === 'checkbox' ? el.checked : Math.max(0, Math.min(127, Math.round(parseFloat(el.value) || 0)));
    }
    if (s.outMaxPitch <= s.outMinPitch) s.outMaxPitch = Math.min(127, s.outMinPitch + 1);
    if (s.outMaxYaw <= s.outMinYaw) s.outMaxYaw = Math.min(127, s.outMinYaw + 1);
    return s;
  }
  function renderDiag() {
    if (!ui.diag) return;
    const age = diagAt ? (performance.now() - diagAt) / 1000 : 0;
    ui.diag.textContent = diagText ? (age > 5 ? `${diagText}  (no answer for ${age.toFixed(0)} s)` : diagText) : '';
  }
  function setDirty(d) { dirty = d; ui.apply.classList.toggle('on', d); ui.apply.disabled = !connected() || !d; }
  function setConnectedUi(on) {
    ui.connect.disabled = on || kind === 'websocket'; ui.disconnect.disabled = !on || kind === 'websocket';
    ui.tare.disabled = !on; ui.ping.disabled = !on; ui.save.disabled = !on;
    ui.connect.hidden = kind === 'websocket';
    setDirty(dirty && on);
    if (hooks.onLink) hooks.onLink(on);
  }

  /* ---- frames ------------------------------------------------------------ */
  function onFrame(f) {
    const p = f.payload;
    for (const t of rawTaps) t(f);
    if (f.cmd === RSP.GC_STATUS) {
      if (p.length >= 6) {
        const was = gc.present;
        gc = { present: !!p[0], fw: `${p[1]}.${p[2]}.${p[3]}`, caps: p[4], protocol: p[5] };
        renderInfo();
        if (was !== gc.present) for (const t of gcTaps) t(gc);
      }
      return;
    }
    if (f.cmd === RSP.AXIS) {
      if (p.length < 4) return;
      lastAxisMs = performance.now();
      if (hooks.onAxis) hooks.onAxis(G.bytesToU16(p, 0) / 16383, G.bytesToU16(p, 2) / 16383);
      return;
    }
    if (f.cmd === RSP.DIAG) { diagText = new TextDecoder().decode(p); diagAt = performance.now(); renderDiag(); return; }
    if (f.cmd === RSP.PONG) { if (lastPingAt) { ui.note.textContent = `pong · ${(performance.now() - lastPingAt).toFixed(1)} ms`; lastPingAt = 0; } return; }
    if (f.cmd === RSP.INFO) { info = decodeInfo(p); renderInfo(); return; }
    if (f.cmd === RSP.SETTINGS) { settings = decodeSettings(p); renderSettings(); ui.note.textContent = 'settings from the pedal'; return; }
    if (f.cmd === RSP.SAVED) { ui.note.textContent = p[0] ? 'saved to the pedal' : 'save FAILED'; ui.note.className = 'gc-status ' + (p[0] ? 'ok' : 'err'); return; }
    if (f.cmd === RSP.TARED) { ui.note.textContent = 'tared'; ui.note.className = 'gc-status ok'; return; }
  }
  const events = {
    onConnect: () => {
      setStatus('connected', 'ok'); setConnectedUi(true);
      tx(CMD.GET_INFO); setTimeout(() => tx(CMD.GET_SETTINGS), 80); setTimeout(() => tx(CMD.GC_STATUS), 160);
      clearInterval(diagTimer); diagTimer = setInterval(() => { tx(CMD.DIAG); renderDiag(); }, 2000);
    },
    onDisconnect: reason => {
      setStatus(reason ? `disconnected: ${reason.message}` : 'not connected', reason ? 'err' : '');
      if (reason && kind === 'websocket') hintOpenByIp();
      clearInterval(diagTimer); diagTimer = null;
      info = null; settings = null; renderInfo(); renderSettings(); setConnectedUi(false);
      if (gc.present) { gc = { present: false, fw: '', caps: 0, protocol: 0 }; for (const t of gcTaps) t(gc); }
    },
    onFrame, onRawError: err => setStatus(err.message, 'err'),
  };

  /* ---- public ------------------------------------------------------------ */
  /* the OS's captive-portal window can show the page but refuses its socket:
     point at the pedal by address in a real browser */
  function hintOpenByIp() {
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : '192.168.4.1';
    ui.status.innerHTML = `no socket from this window — open <a href="http://${ip}/" target="_blank" rel="noopener">http://${ip}/</a> in Safari or Chrome`;
    ui.status.className = 'gc-status err';
  }
  async function connect() {
    if (!link) return;
    try { await link.connect(); } catch (err) { setStatus(err.message, 'err'); if (kind === 'websocket') hintOpenByIp(); }
  }
  function init(opts) {
    hooks = opts || {};
    const mount = hooks.mount;
    mount.innerHTML = template();
    const $ = id => mount.querySelector('#' + id);
    ui = { status: $('pd-status'), info: $('pd-info'), diag: $('pd-diag'), note: $('pd-note'), connect: $('pd-connect'), disconnect: $('pd-disconnect'), tare: $('pd-tare'), ping: $('pd-ping'),
      settings: $('pd-settings'), apply: $('pd-apply'), save: $('pd-save') };
    kind = window.GCLink.servedByPedal() ? 'websocket' : ('serial' in navigator ? 'serial' : null);
    if (kind) link = window.GCLink.createLink(kind, events);
    if (!kind) { setStatus('no pedal link here — open this page from the pedal’s WiFi, or use Chrome / Edge with a USB cable'); ui.connect.disabled = true; }
    ui.connect.addEventListener('click', connect);
    ui.disconnect.addEventListener('click', () => link && link.disconnect());
    ui.tare.addEventListener('click', () => tx(CMD.TARE));
    ui.ping.addEventListener('click', () => { lastPingAt = performance.now(); tx(CMD.PING); });
    ui.settings.addEventListener('input', () => setDirty(true));
    ui.settings.addEventListener('change', () => setDirty(true));
    ui.apply.addEventListener('click', () => { if (!settings) return; tx(CMD.SET_SETTINGS, encodeSettings(readSettings())); ui.note.textContent = 'applied'; ui.note.className = 'gc-status'; });
    ui.save.addEventListener('click', () => { if (dirty) tx(CMD.SET_SETTINGS, encodeSettings(readSettings())); setTimeout(() => tx(CMD.SAVE), 60); });
    setConnectedUi(false);
    if (kind === 'websocket') setTimeout(connect, 50);   /* served by the pedal: its socket is right here */
  }
  window.Pedal = {
    init, connect, isConnected: connected, info: () => info, kind: () => kind, live: () => performance.now() - lastAxisMs < 600,
    /* the tunnel's hooks: every raw pedal frame, the Ground Control envelope, presence */
    onRaw: cb => { rawTaps.add(cb); return () => rawTaps.delete(cb); },
    onGc: cb => { gcTaps.add(cb); return () => gcTaps.delete(cb); },
    gc: () => gc,
    sendTunnel: frame => { if (!connected()) return Promise.reject(new Error('the pedal is not connected')); return link.send(G.encodeFrame(CMD.GC_TUNNEL, frame)); },
    /* any pedal command (the program push, program.js) */
    send: (cmd, payload) => { if (!connected()) return Promise.reject(new Error('the pedal is not connected')); return link.send(G.encodeFrame(cmd, payload || new Uint8Array(0))); },
    note: (text, cls) => { ui.note.textContent = text; ui.note.className = 'gc-status' + (cls ? ' ' + cls : ''); },
    askGcStatus: () => tx(CMD.GC_STATUS),
    TUNNEL_REPLY: RSP.GC_TUNNEL,
  };
})();
