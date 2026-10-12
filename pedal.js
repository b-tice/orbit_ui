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
  const BLOB_VERSION = 2, BLOB_LEN = 15;   /* v2 = 16 bytes (adds the receive channel); the pedal still accepts 15-byte v1 */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let hooks = {}, ui = {}, link = null, kind = null, info = null, settings = null, dirty = false, lastAxisMs = 0, lastPingAt = 0;
  /* bench readout: the pedal answers DIAG from its network task, so it still speaks when its main loop has stalled */
  let diagTimer = null, diagText = '', diagText2 = '', diagAt = 0;
  /* Ground Control behind the pedal (protocol v2 HELLO relayed as GC_STATUS) */
  let gc = { present: false, fw: '', caps: 0, protocol: 0 };
  const rawTaps = new Set(), gcTaps = new Set();

  const decodeSettings = p => (p.length < BLOB_LEN ? null : {
    channel: p[1] & 15, ccPitch: p[2] & 127, ccYaw: p[3] & 127, enPitch: !!p[4], enYaw: !!p[5], invPitch: !!p[6], invYaw: !!p[7],
    tapEnable: !!p[8], tapNote: p[9] & 127, outMinPitch: p[10] & 127, outMaxPitch: p[11] & 127, outMinYaw: p[12] & 127, outMaxYaw: p[13] & 127, wifiEnable: !!p[14],
    rxChannel: p.length >= 16 ? p[15] : 0x7f,   /* 0-15, or 0x7f = omni */
  });
  const encodeSettings = s => new Uint8Array([BLOB_VERSION, s.channel & 15, s.ccPitch & 127, s.ccYaw & 127, s.enPitch ? 1 : 0, s.enYaw ? 1 : 0, s.invPitch ? 1 : 0, s.invYaw ? 1 : 0,
    s.tapEnable ? 1 : 0, s.tapNote & 127, s.outMinPitch & 127, s.outMaxPitch & 127, s.outMinYaw & 127, s.outMaxYaw & 127, s.wifiEnable ? 1 : 0, s.rxChannel === undefined ? 0x7f : s.rxChannel]);
  const decodeInfo = p => (p.length < 13 ? null : {
    fw: `${p[0]}.${p[1]}.${p[2]}`, hwRev: p[3],
    mac: Array.from(p.subarray(4, 10), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    hosted: !!p[10], calib: p[11], imuOk: !!(p[12] & 1), encoderOk: !!(p[12] & 2), dacOk: !!(p[12] & 4),
  });

  const connected = () => !!link && link.isConnected();
  function tx(cmd, payload) { if (!connected()) return; link.send(G.encodeFrame(cmd, payload)).catch(err => setStatus(err.message, 'err')); }
  function setStatus(text, cls) { ui.status.textContent = text; ui.status.className = 'gc-status' + (cls ? ' ' + cls : ''); }
  /* the message line shows a confirmation for a few seconds, then clears (errors stay) */
  let noteTimer = null;
  function setNote(text, cls) {
    ui.note.textContent = text; ui.note.className = 'gc-status' + (cls ? ' ' + cls : '');
    clearTimeout(noteTimer);
    if (cls !== 'err' && text) noteTimer = setTimeout(() => { setNote('', ''); }, 4000);
  }

  /* ---- panel ------------------------------------------------------------ */
  const PANEL = 'gc-panel ambient amb-surface amb-chamfer amb-elevation-2 ambx-panel amb-mat-blasted amb-rounded-xl';
  function template() {
    return `
    <section class="${PANEL}" id="pd-panel">
      <div class="gc-head"><h3>ORBIT PEDAL</h3><span class="gc-status" id="pd-status">not connected</span></div>
      <div class="gc-row">
        <button class="ghostbtn" id="pd-connect" type="button">connect USB</button>
        <button class="ghostbtn" id="pd-disconnect" type="button" disabled>disconnect</button>
        <button class="ghostbtn" id="pd-tare" type="button" disabled title="take the pedal's current pose as its zero">tare</button>
        <button class="ghostbtn" id="pd-ping" type="button" disabled>ping</button>
        <button class="ghostbtn" id="pd-restart" type="button" disabled title="bench: restart the pedal (tests the unit's recovery)">restart pedal</button>
      </div>
      <div class="gc-row"><span class="gc-status" id="pd-note"></span></div>
      <div class="pd-folds">
      <details class="pd-diag-box pd-settings" id="pd-settings" hidden>
        <summary class="gc-status" title="the pedal's own settings: tap note, WiFi">settings</summary>
        <div class="pd-grid">
          <label class="polarity" title="a sharp tap on the pedal sends this note (note on, then off)"><span class="pol-lbl">tap note</span><input type="checkbox" data-f="tapEnable"><span class="pol-switch"></span></label>
          <label class="field"><span>NOTE</span><input type="number" min="0" max="127" inputmode="numeric" data-f="tapNote"></label>
          <label class="polarity" title="the pedal's own WiFi access point — applied at the next power-up"><span class="pol-lbl">WiFi</span><input type="checkbox" data-f="wifiEnable"><span class="pol-switch"></span></label>
        </div>
        <div class="gc-row">
          <button class="ghostbtn savebtn" id="pd-apply" type="button" disabled title="send these settings to the pedal (live, until the next power-up)">apply</button>
          <button class="ghostbtn" id="pd-save" type="button" disabled title="store the pedal's live settings in its flash">save to pedal</button>
        </div>
      </details>
      <details class="pd-diag-box" id="pd-diag-box">
        <summary class="gc-status" title="firmware, sensors, and the pedal's health readout (refreshed every 2 s while connected)">diagnostics</summary>
        <div class="gc-status" id="pd-info" style="white-space:normal;padding:4px 0 2px"></div>
        <div id="pd-diag" style="font-family:var(--mono);font-size:12px;line-height:1.4;color:var(--ink);white-space:pre-wrap;word-break:break-all;padding:4px 0 2px"></div>
      </details>
      </div>
    </section>`;
  }

  function renderInfo() {
    if (!info) { ui.info.textContent = ''; return; }
    const calib = ['uncalibrated', 'calibrating', 'calibrated'][info.calib] || `calib ${info.calib}`;
    const host = gc.present ? `on Ground Control ${gc.fw} (tunnel${(gc.caps & 2) ? ' · MIDI pass-through' : ''})` : info.hosted ? 'on Ground Control — its firmware predates the tunnel, update it for the GROUND CONTROL tab' : 'standalone';
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
    if (hooks.rxChannel) s.rxChannel = hooks.rxChannel();   /* the header's RECEIVE CH owns this field */
    if (s.outMaxPitch <= s.outMinPitch) s.outMaxPitch = Math.min(127, s.outMinPitch + 1);
    if (s.outMaxYaw <= s.outMinYaw) s.outMaxYaw = Math.min(127, s.outMinYaw + 1);
    return s;
  }
  function renderDiag() {
    if (!ui.diag) return;
    const age = diagAt ? (performance.now() - diagAt) / 1000 : 0;
    const both = [diagText, diagText2].filter(Boolean).join('\n');
    ui.diag.textContent = both ? (age > 5 ? `${both}  (no answer for ${age.toFixed(0)} s)` : both) : '';
  }
  function setDirty(d) { dirty = d; ui.apply.classList.toggle('on', d); ui.apply.disabled = !connected() || !d; }
  function setConnectedUi(on) {
    ui.connect.disabled = on || kind === 'websocket'; ui.disconnect.disabled = !on || kind === 'websocket';
    ui.tare.disabled = !on; ui.ping.disabled = !on; ui.save.disabled = !on; if (ui.restart) ui.restart.disabled = !on;
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
    if (f.cmd === RSP.DIAG) { const t = new TextDecoder().decode(p); if (t.startsWith('wr ')) diagText2 = t; else diagText = t; diagAt = performance.now(); renderDiag(); return; }
    if (f.cmd === RSP.PONG) { if (lastPingAt) { setNote(`pong · ${(performance.now() - lastPingAt).toFixed(1)} ms`, 'ok'); lastPingAt = 0; } return; }
    if (f.cmd === RSP.INFO) { info = decodeInfo(p); renderInfo(); return; }
    if (f.cmd === RSP.SETTINGS) { settings = decodeSettings(p); renderSettings(); setNote('settings from the pedal', ''); if (hooks.onSettings) hooks.onSettings(settings); return; }
    if (f.cmd === RSP.SAVED) { setNote(p[0] ? 'saved to the pedal' : 'save FAILED', p[0] ? 'ok' : 'err'); return; }
    if (f.cmd === RSP.TARED) { setNote('tared', ''); ui.note.className = 'gc-status ok'; return; }
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
      settings: $('pd-settings'), apply: $('pd-apply'), save: $('pd-save'), restart: $('pd-restart') };
    kind = window.GCLink.servedByPedal() ? 'websocket' : ('serial' in navigator ? 'serial' : null);
    if (kind) link = window.GCLink.createLink(kind, events);
    if (!kind) { setStatus('no pedal link here — open this page from the pedal’s WiFi, or use Chrome / Edge with a USB cable'); ui.connect.disabled = true; }
    ui.connect.addEventListener('click', connect);
    ui.disconnect.addEventListener('click', () => link && link.disconnect());
    ui.tare.addEventListener('click', () => tx(CMD.TARE));
    ui.ping.addEventListener('click', () => { lastPingAt = performance.now(); tx(CMD.PING); });
    ui.restart.addEventListener('click', () => { tx(0x23, new Uint8Array([0x52])); setNote('pedal restarting…', ''); });
    ui.settings.addEventListener('input', () => setDirty(true));
    ui.settings.addEventListener('change', () => setDirty(true));
    ui.apply.addEventListener('click', () => { if (!settings) return; tx(CMD.SET_SETTINGS, encodeSettings(readSettings())); setNote('applied', ''); });
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
    note: (text, cls) => setNote(text, cls),
    askGcStatus: () => tx(CMD.GC_STATUS),
    /* push the header's receive channel to the pedal (settings blob v2), keeping the rest as the pedal has it */
    setRxChannel: rx => { if (!settings) return; settings.rxChannel = rx; tx(CMD.SET_SETTINGS, encodeSettings(settings)); setTimeout(() => tx(CMD.SAVE), 60); },
    TUNNEL_REPLY: RSP.GC_TUNNEL,
  };
})();
