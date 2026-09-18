/* The GROUND CONTROL tab — the GC web editor (gc_dsp/web/src/main.ts) ported
   into Orbit UI. Talks to a unit through a Link (link.js) — real over WiFi or
   USB, or the simulator (gc/sim.js). Vocabulary: a stored slot on the unit is
   a Setup (the wire still says PRESET). window.GCTab */

'use strict';

(function () {
  const G = window.GCP, FX = window.GCFX, EFFECTS = FX.EFFECTS, C = window.GCCurve;
  const CMD = G.CMD, R = G.REPLY, MAX_E = G.MAX_EFFECTS;
  const DEFAULT_CHAIN = [11, 3, 6, 7, 13, 1, 4, 14, 8, 0, 9, 2, 5, 10, 12];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const slotKey = (L, D) => (L << 4) | D;
  const idOf = i => G.slotLabel(i.letter, i.digit);
  const parseId = id => (/^[A-Z]\d$/.test(id || '') ? { L: id.charCodeAt(0) - 65, D: +id[1] } : null);
  const lowestBit = m => { for (let e = 0; e < MAX_E; e++) if (m & (1 << e)) return e; return -1; };

  let hooks = {}, ui = {}, link = null, linkKind = 'sim', sim = null;
  const presetCache = new Map();
  let activeSlot = null, activePreset = null, editorDirty = false, listInProgress = false, lastPingAt = 0;
  const rows = [], rowIndex = new Map(), effectCards = new Map();
  const axisRaw01 = [0.5, 0.5]; let axisRawAtMs = 0;

  /* ---- markup ------------------------------------------------------ */
  const PANEL = 'gc-panel ambient amb-surface amb-chamfer amb-elevation-2 ambx-panel amb-mat-blasted amb-rounded-xl';
  const screenSvg = id => `
    <svg id="${id}" class="screen-svg disconnected" viewBox="0 0 240 240">
      <path class="arc-track" d=""></path><path class="arc-fill" d=""></path>
      <text class="effect-name" x="120" y="68"></text>
      <text class="param-name" x="120" y="100"></text>
      <text class="value-text" x="120" y="138"></text>
      <text class="banner" x="120" y="208"></text>
    </svg>`;
  const axisChain = (a, label, sub) => `
    <div class="axis-chain" id="gc-chain-${a}">
      <h4>${label} <small>${sub}</small></h4>
      <div class="effects-list"></div>
      <div class="add-row effect-row">
        <select class="eff-sel" disabled></select>
        <select class="par-sel" disabled></select>
        <div class="row-actions"><button class="ghostbtn add-btn" type="button" disabled>add</button></div>
      </div>
    </div>`;
  function template() {
    return `
    <section class="${PANEL}" id="gc-conn">
      <div class="gc-head"><h3>CONNECTION</h3><span class="gc-status" id="gc-status">not connected</span></div>
      <div class="gc-row">
        <select id="gc-link" class="gc-select" title="how to reach the Ground Control"></select>
        <button class="ghostbtn" id="gc-connect" type="button">connect</button>
        <button class="ghostbtn" id="gc-disconnect" type="button" disabled>disconnect</button>
        <button class="ghostbtn" id="gc-refresh" type="button" disabled title="read the unit's Setup bank into the Library">refresh setups</button>
        <button class="ghostbtn" id="gc-ping" type="button" disabled>ping</button>
        <span class="gc-status" id="gc-bank-status"></span>
      </div>
    </section>
    <section class="${PANEL}" id="gc-active" hidden>
      <div class="gc-head"><h3>ACTIVE SETUP</h3><span class="dirty-pill clean" id="gc-dirty">saved</span></div>
      <div class="active-head">
        <span class="swatch" id="gc-swatch"></span>
        <span class="slot" id="gc-slot"></span>
        <input id="gc-name" type="text" maxlength="10" placeholder="name (10 chars)" spellcheck="false" disabled>
        <span class="gc-spacer"></span>
        <button class="ghostbtn savebtn" id="gc-save" type="button" disabled title="write the live state and name into this slot on the unit">save</button>
        <button class="ghostbtn" id="gc-discard" type="button" disabled title="reload this slot's saved values from the unit">discard</button>
        <button class="ghostbtn" id="gc-delete" type="button" disabled title="delete this Setup from the unit">delete</button>
      </div>
      <div class="chains">
        ${axisChain(0, 'PITCH', 'heel → toe')}
        ${axisChain(1, 'YAW', 'left → right')}
      </div>
      <div class="gc-help">Each row is one parameter the pedal axis drives. <b>Replace</b> makes the row's pick the only one on that axis; <b>add</b> below puts another parameter on the same axis.</div>
    </section>
    <section class="${PANEL}" id="gc-params">
      <div class="gc-head"><h3>PARAMETERS</h3><span class="gc-status" id="gc-params-note"></span></div>
      <div id="gc-param-grid"></div>
      <div class="gc-help">Top slider = current value. Lower track = the pedal's sweep range (yellow low, orange high). The dot lights while the unit streams that parameter. Open <b>curve</b> to shape the sweep.</div>
    </section>
    <section class="${PANEL}" id="gc-chain">
      <div class="gc-head"><h3>EFFECT CHAIN</h3></div>
      <div id="gc-chain-list" class="chain-list"></div>
      <div class="gc-help">Audio order on the DSP. ▲ ▼ reorder; changes apply at once and save with the Setup.</div>
    </section>
    <section class="${PANEL}" id="gc-screens">
      <div class="gc-head"><h3>SCREENS</h3><span class="gc-status">what the unit's two displays show</span></div>
      <div class="screens-row">
        <div class="screen-emu">${screenSvg('gc-screen-pitch')}<span class="label">PITCH</span>
          <label class="pedal" data-pedal="pitch"><span>heel</span><input type="range" min="0" max="1" step="0.001"><span>toe</span></label></div>
        <div class="screen-emu">${screenSvg('gc-screen-yaw')}<span class="label">YAW</span>
          <label class="pedal" data-pedal="yaw"><span>left</span><input type="range" min="0" max="1" step="0.001"><span>right</span></label></div>
      </div>
    </section>
    <section class="${PANEL}" id="gc-fw">
      <div class="gc-head"><h3>FIRMWARE</h3></div>
      <div class="gc-row">
        <input type="file" id="gc-fw-file" accept=".bin">
        <button class="ghostbtn" id="gc-fw-update" type="button" disabled>update Ground Control</button>
        <span class="gc-status" id="gc-fw-status"></span>
      </div>
      <div class="fw-progress" id="gc-fw-wrap" hidden><div class="fw-progress-bar" id="gc-fw-bar"></div></div>
      <div class="gc-help" id="gc-fw-hint"></div>
      <div class="gc-row">
        <button class="ghostbtn" id="gc-dsp-dfu" type="button" disabled>DSP update mode</button>
        <span class="gc-status" id="gc-dfu-status"></span>
      </div>
      <div class="gc-help">Puts the audio (DSP) board into update mode until it is flashed or power-cycled.</div>
    </section>
    <section class="${PANEL}" id="gc-logpanel">
      <div class="gc-head"><h3>LOG</h3><button class="ghostbtn" id="gc-log-toggle" type="button">show</button><button class="ghostbtn" id="gc-log-clear" type="button">clear</button></div>
      <div id="gc-log" hidden></div>
    </section>`;
  }

  /* ---- log / status ----------------------------------------------- */
  function log(kind, msg) {
    const line = document.createElement('div');
    line.className = kind;
    line.textContent = `[${new Date().toLocaleTimeString(undefined, { hour12: false })}] ${msg}`;
    ui.log.appendChild(line);
    while (ui.log.childElementCount > 400) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }
  function setStatus(text, cls) { ui.status.textContent = text; ui.status.className = 'gc-status' + (cls ? ' ' + cls : ''); }
  function setBankStatus(text, cls) { ui.bankStatus.textContent = text; ui.bankStatus.className = 'gc-status' + (cls ? ' ' + cls : ''); }
  function describeFrame(f) { return f.payload.length ? `${G.frameName(f.cmd)} [${G.hexDump(f.payload)}]` : G.frameName(f.cmd); }
  const connected = () => !!link && link.isConnected();
  function tx(frame) { if (!connected()) return; link.send(frame).catch(err => log('err', err.message)); }

  function setConnectedUi(on) {
    ui.connect.disabled = on; ui.disconnect.disabled = !on;
    ui.ping.disabled = !on; ui.refresh.disabled = !on; ui.dspDfu.disabled = !on;
    ui.linkSel.disabled = on;
    ui.paramGrid.querySelectorAll('input').forEach(el => { el.disabled = !on; });
    for (const l of ui.mount.querySelectorAll('.pedal')) l.hidden = !(on && linkKind === 'sim');
    if (activePreset) renderActivePreset();
    renderChainList();
    renderScreens();
    if (hooks.onLink) hooks.onLink(on);
  }

  /* ---- parameter grid --------------------------------------------- */
  function renderParamGrid() {
    ui.paramGrid.innerHTML = '';
    effectCards.clear(); rows.length = 0; rowIndex.clear();
    for (const eff of EFFECTS) {
      const card = document.createElement('div');
      card.className = 'effect-card';
      card.innerHTML = `<div class="effect-head"><h4>${esc(eff.name)}</h4><span class="eff-id">eff ${eff.id}</span></div>`;
      eff.params.forEach((p, parIdx) => {
        const row = buildParamRow(eff.id, parIdx, p);
        rows.push(row); rowIndex.set((eff.id << 8) | parIdx, row);
        card.appendChild(rowDom(row));
      });
      ui.paramGrid.appendChild(card);
      effectCards.set(eff.id, card);
    }
    updateParamGridVisibility();
  }
  function updateParamGridVisibility() {
    const mask = activePreset ? (activePreset.axisEffectsPitch | activePreset.axisEffectsYaw) : 0;
    effectCards.forEach((card, id) => { card.hidden = !!activePreset && !(mask & (1 << id)); });
    ui.paramsNote.textContent = activePreset ? 'the effects this Setup puts on an axis' : 'every effect — load a Setup to narrow the list';
  }
  function mkRange(def, value, cls) {
    const i = document.createElement('input');
    i.type = 'range'; if (cls) i.className = cls;
    i.min = def.min; i.max = def.max; i.step = def.step; i.value = value; i.disabled = true;
    return i;
  }
  function buildParamRow(eff, par, def) {
    const row = {
      eff, par, def, lastLiveAt: 0, curveUserOpen: null,
      valueInput: mkRange(def, def.defaultVal),
      valueReadout: document.createElement('span'),
      thLoInput: mkRange(def, def.min, 'thresh-lo'),
      thHiInput: mkRange(def, def.max, 'thresh-hi'),
      threshReadout: document.createElement('span'),
      nameCell: document.createElement('span'),
    };
    row.valueReadout.className = 'value-readout';
    row.threshReadout.className = 'thresh-readout';
    row.nameCell.className = 'param-name';
    row.nameCell.innerHTML = `<span class="live-dot"></span>${esc(def.name)}`;
    /* curve edits are throttled like the sliders */
    let cLast = 0, cTimer = null, cPend = null;
    const flushCurve = lut => { tx(G.frames.setCurve(row.eff, row.par, lut)); markEditorDirty(); };
    row.curveEditor = new C.CurveEditor({
      onChange: lut => {
        const now = performance.now();
        if (now - cLast >= 25) { cLast = now; flushCurve(lut); }
        else { cPend = lut; if (cTimer == null) cTimer = setTimeout(() => { cTimer = null; cLast = performance.now(); if (cPend) flushCurve(cPend); }, 25 - (now - cLast)); }
      },
    });
    refreshValueReadout(row); refreshThreshReadout(row);
    attachThrottledSend(row.valueInput, () => sendParam(row));
    attachThrottledSend(row.thLoInput, () => sendThresh(row, 'lo'));
    attachThrottledSend(row.thHiInput, () => sendThresh(row, 'hi'));
    return row;
  }
  function rowDom(row) {
    const div = document.createElement('div');
    div.className = 'param-row';
    const track = document.createElement('div'); track.className = 'thresh-track';
    const rail = document.createElement('div'); rail.className = 'thresh-rail'; track.appendChild(rail);
    row.threshSpan = document.createElement('div'); row.threshSpan.className = 'thresh-span'; track.appendChild(row.threshSpan);
    track.appendChild(row.thLoInput); track.appendChild(row.thHiInput);
    makeDualSliderTouch(track, row.thLoInput, row.thHiInput);
    refreshThreshReadout(row);
    div.append(row.nameCell, row.valueInput, row.valueReadout, track, row.threshReadout);

    const wrap = document.createElement('div'); wrap.className = 'curve-wrap';
    const head = document.createElement('div'); head.className = 'curve-head';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'curve-toggle'; toggle.textContent = '▸ curve';
    head.appendChild(toggle); wrap.appendChild(head);
    const body = document.createElement('div'); body.className = 'curve-body collapsed';
    body.appendChild(row.curveEditor.el);
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ghostbtn curve-reset'; reset.textContent = '⟲ linear';
    reset.title = 'back to a straight line (the unit forgets this curve)';
    reset.addEventListener('click', () => row.curveEditor.reset());
    body.appendChild(reset); wrap.appendChild(body);
    row.curveWrap = wrap; row.curveBody = body; row.curveToggle = toggle;
    toggle.addEventListener('click', () => {
      const open = body.classList.contains('collapsed');
      row.curveUserOpen = open;
      body.classList.toggle('collapsed', !open);
      toggle.textContent = (open ? '▾' : '▸') + ' curve';
    });
    div.appendChild(wrap);
    return div;
  }
  function refreshValueReadout(row) { row.valueReadout.textContent = FX.formatValue(row.def, parseFloat(row.valueInput.value)); }
  function refreshThreshReadout(row) {
    const lo = parseFloat(row.thLoInput.value), hi = parseFloat(row.thHiInput.value);
    row.threshReadout.textContent = `${lo.toFixed(row.def.decimals)} → ${hi.toFixed(row.def.decimals)}`;
    if (!row.threshSpan) return;
    const mn = row.def.min, range = row.def.max - mn;
    if (range > 0) {
      const l = Math.max(0, Math.min(1, (Math.min(lo, hi) - mn) / range)), r = Math.max(0, Math.min(1, (Math.max(lo, hi) - mn) / range));
      row.threshSpan.style.left = (l * 100).toFixed(1) + '%';
      row.threshSpan.style.width = ((r - l) * 100).toFixed(1) + '%';
    }
  }
  function sendParam(row) {
    refreshValueReadout(row);
    tx(G.frames.setParam(row.eff, row.par, parseFloat(row.valueInput.value)));
    markEditorDirty();
  }
  function sendThresh(row, edge) {
    let lo = parseFloat(row.thLoInput.value), hi = parseFloat(row.thHiInput.value);
    if (edge === 'lo' && lo > hi) lo = hi;
    if (edge === 'hi' && hi < lo) hi = lo;
    row.thLoInput.value = lo; row.thHiInput.value = hi;
    refreshThreshReadout(row);
    tx(G.frames.setThresh(row.eff, row.par, lo, hi));
    markEditorDirty();
    renderScreens();
  }
  /* the track drives whichever thumb is nearer — the stacked inputs are display-only */
  function makeDualSliderTouch(track, lo, hi) {
    let active = null;
    const norm = i => { const mn = +i.min, mx = +i.max; return mx > mn ? (+i.value - mn) / (mx - mn) : 0; };
    const setFromX = (e, input) => {
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const mn = +input.min, mx = +input.max, step = +input.step || 1;
      let v = mn + frac * (mx - mn);
      v = Math.round(v / step) * step;
      input.value = Math.min(mx, Math.max(mn, v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    track.addEventListener('pointerdown', e => {
      if (lo.disabled) return;
      const r = track.getBoundingClientRect();
      const frac = (e.clientX - r.left) / r.width;
      const dLo = Math.abs(frac - norm(lo)), dHi = Math.abs(frac - norm(hi));
      active = dLo < dHi ? lo : dHi < dLo ? hi : frac >= norm(hi) ? hi : lo;
      setFromX(e, active);
      track.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    track.addEventListener('pointermove', e => { if (active) setFromX(e, active); });
    track.addEventListener('pointerup', () => { active = null; });
    track.addEventListener('pointercancel', () => { active = null; });
  }
  function attachThrottledSend(el, fn, gapMs) {
    gapMs = gapMs || 20;
    let last = 0, pending = null;
    el.addEventListener('input', () => {
      const now = performance.now(), elapsed = now - last;
      if (elapsed >= gapMs) { last = now; fn(); }
      else if (pending == null) pending = setTimeout(() => { pending = null; last = performance.now(); fn(); }, gapMs - elapsed);
    });
  }

  /* ---- live values ------------------------------------------------- */
  function handleLiveVal(p) {
    if (p.length < 6) return;
    const row = rowIndex.get((p[0] << 8) | p[1]);
    if (!row) return;
    row.lastLiveAt = performance.now();
    row.nameCell.classList.add('live');
    if (document.activeElement !== row.valueInput) { row.valueInput.value = G.bytesToF32(p, 2); refreshValueReadout(row); }
    if (activePreset) renderScreens();
  }
  function handleAxisRaw(p) {
    if (p.length < 4) return;
    axisRaw01[0] = G.bytesToU16(p, 0) / 16383; axisRaw01[1] = G.bytesToU16(p, 2) / 16383;
    axisRawAtMs = performance.now();
    for (const row of rows) if (!row.curveBody.classList.contains('collapsed') && paramSensorMapped(row.eff, row.par)) {
      const a = onAxis(row.eff, row.par);
      row.curveEditor.setLive(a < 0 ? -1 : axisRaw01[a]);
    }
    if (activePreset) renderScreens();
  }
  setInterval(() => {
    const now = performance.now();
    for (const row of rows) if (row.lastLiveAt && now - row.lastLiveAt > 250) { row.lastLiveAt = 0; row.nameCell.classList.remove('live'); }
  }, 100);

  /* ---- the bank --------------------------------------------------- */
  function bank() {
    return [...presetCache.values()].sort((a, b) => slotKey(a.letter, a.digit) - slotKey(b.letter, b.digit));
  }
  function bankChanged() { if (hooks.onBank) hooks.onBank(); }
  function handlePresetInfo(p) {
    const info = G.parsePresetInfo(p);
    if (!info) return;
    const old = presetCache.get(slotKey(info.letter, info.digit));
    presetCache.set(slotKey(info.letter, info.digit), info);
    if (activePreset && activePreset.letter === info.letter && activePreset.digit === info.digit) {
      activePreset = info; renderActivePreset();
      if (hooks.onLoaded && (!old || old.name !== info.name)) hooks.onLoaded(idOf(info), info.name);   /* a rename echo */
    }
    if (!listInProgress) bankChanged();
    else if (!old) setBankStatus(`reading… ${presetCache.size}`);
  }
  function handlePresetMasks(p) {
    const m = G.parsePresetMasks(p);
    if (!m) return;
    const cached = presetCache.get(slotKey(m.letter, m.digit));
    if (!cached) return;
    cached.parMasksPitch = m.parMasksPitch; cached.parMasksYaw = m.parMasksYaw;
    if (activePreset && activePreset.letter === m.letter && activePreset.digit === m.digit) {
      activePreset.parMasksPitch = m.parMasksPitch; activePreset.parMasksYaw = m.parMasksYaw;
      renderActivePreset();
    }
    if (!listInProgress) bankChanged();
  }
  function handleListEnd() {
    listInProgress = false;
    setBankStatus(`${presetCache.size} Setups on the unit`, 'ok');
    bankChanged();
  }
  function handleLoaded(p) {
    if (p.length < 2) return;
    activeSlot = { letter: p[0], digit: p[1] };
    const info = presetCache.get(slotKey(p[0], p[1]));
    if (info) setActivePreset(info); else { activePreset = null; clearActivePreset(); }
    bankChanged();
    if (hooks.onLoaded) hooks.onLoaded(G.slotLabel(p[0], p[1]), info ? info.name : '');
    log('rx', `LOADED ${G.slotLabel(p[0], p[1])}`);
  }
  function refreshBank() {
    if (!connected()) return;
    presetCache.clear();
    listInProgress = true;
    setBankStatus('reading…');
    bankChanged();
    tx(G.frames.listPresets());
    log('tx', 'LIST_PRESETS');
  }

  /* ---- active Setup ------------------------------------------------ */
  const onAxis = (eff, par) => {
    const p = activePreset; if (!p) return -1;
    if (((p.axisEffectsPitch >> eff) & 1) && (((p.parMasksPitch[eff] || 0) >> par) & 1)) return 0;
    if (((p.axisEffectsYaw >> eff) & 1) && (((p.parMasksYaw[eff] || 0) >> par) & 1)) return 1;
    return -1;
  };
  const paramSensorMapped = (eff, par) => onAxis(eff, par) >= 0;
  function refreshCurveVisibility(resetOverrides) {
    const p = activePreset, any = p ? (p.axisEffectsPitch | p.axisEffectsYaw) : 0;
    for (const row of rows) {
      if (resetOverrides) row.curveUserOpen = null;
      const assigned = p ? ((any >> row.eff) & 1) !== 0 : false;
      row.curveWrap.hidden = !!p && !assigned;
      const auto = paramSensorMapped(row.eff, row.par);
      const open = row.curveUserOpen !== null ? row.curveUserOpen : auto;
      row.curveBody.classList.toggle('collapsed', !open);
      row.curveToggle.textContent = (open ? '▾' : '▸') + ' curve';
      row.nameCell.classList.toggle('mapped', auto);
      if (!open || !auto) row.curveEditor.setLive(-1);
    }
  }
  function setActivePreset(info) { activePreset = info; editorDirty = false; renderActivePreset(); refreshCurveVisibility(true); }
  function clearActivePreset() {
    activePreset = null; editorDirty = false;
    ui.active.hidden = true;
    renderChainList(); updateParamGridVisibility(); refreshCurveVisibility(true); renderScreens();
  }
  function markEditorDirty() { if (!activePreset || editorDirty) return; editorDirty = true; updateDirtyPill(); }
  function updateDirtyPill() {
    ui.dirty.textContent = editorDirty ? 'edited' : 'saved';
    ui.dirty.classList.toggle('clean', !editorDirty);
    ui.save.classList.toggle('on', editorDirty);
    renderScreens();
  }
  function renderActivePreset() {
    const p = activePreset;
    if (!p) { ui.active.hidden = true; renderScreens(); return; }
    ui.active.hidden = false;
    const pal = G.COLOR_PALETTE[p.colorIdx] || G.COLOR_PALETTE[7];
    ui.swatch.style.background = pal.hex; ui.swatch.title = pal.name;
    ui.slot.textContent = idOf(p);
    if (ui.name.value !== p.name) ui.name.value = p.name;
    const on = connected();
    ui.name.disabled = !on; ui.save.disabled = !on; ui.discard.disabled = !on; ui.delete.disabled = !on;
    renderAxisChain(0); renderAxisChain(1);
    renderChainList(); updateParamGridVisibility(); refreshCurveVisibility();
    updateDirtyPill();
  }
  function getActiveChain() {
    if (!activePreset) return DEFAULT_CHAIN;
    if (activePreset.chain.length) return activePreset.chain;
    const active = activePreset.axisEffectsPitch | activePreset.axisEffectsYaw, d = [];
    for (let e = 0; e < MAX_E; e++) if (active & (1 << e)) d.push(e);
    return d;
  }
  function renderChainList() {
    const list = ui.chainList; list.innerHTML = '';
    const chain = getActiveChain(), on = connected(), editable = !!activePreset;
    if (!chain.length) { list.innerHTML = `<div class="gc-empty">${activePreset ? 'empty chain — put an effect on PITCH or YAW above' : 'no Setup loaded'}</div>`; return; }
    chain.forEach((id, idx) => {
      const row = document.createElement('div'); row.className = 'chain-row';
      row.innerHTML = `<span class="pos">${idx + 1}.</span><span class="nm">${esc(id < MAX_E ? G.EFFECT_NAMES[id] : 'id ' + id)}</span>`;
      const up = document.createElement('button'); up.type = 'button'; up.className = 'rowbtn'; up.textContent = '▲'; up.disabled = !on || !editable || idx === 0;
      const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'rowbtn'; dn.textContent = '▼'; dn.disabled = !on || !editable || idx === chain.length - 1;
      up.addEventListener('click', () => moveChainSlot(idx, -1));
      dn.addEventListener('click', () => moveChainSlot(idx, 1));
      row.append(up, dn); list.appendChild(row);
    });
  }
  function moveChainSlot(idx, delta) {
    if (!activePreset) return;
    const chain = [...getActiveChain()], t = idx + delta;
    if (t < 0 || t >= chain.length) return;
    [chain[idx], chain[t]] = [chain[t], chain[idx]];
    activePreset.chain = chain;
    tx(G.frames.setChainOrder(chain));
    log('tx', `SET_CHAIN_ORDER [${chain.join(',')}]`);
    renderChainList(); markEditorDirty();
  }
  function defaultParamIdxForEffect(id) {
    const ps = (EFFECTS[id] || {}).params || [];
    for (let i = 0; i < ps.length; i++) if (ps[i].name === 'Mix') return i;
    return 0;
  }
  function fillParams(sel, effId, defaultPar) {
    sel.innerHTML = '';
    ((EFFECTS[effId] || {}).params || []).forEach((p, i) => {
      const o = document.createElement('option'); o.value = i; o.textContent = p.name; if (i === defaultPar) o.selected = true; sel.appendChild(o);
    });
    sel.disabled = !connected() || !sel.options.length;
  }
  function fillEffects(sel, selected) {
    sel.innerHTML = '';
    for (const e of EFFECTS) { const o = document.createElement('option'); o.value = e.id; o.textContent = e.name; if (e.id === selected) o.selected = true; sel.appendChild(o); }
    sel.disabled = !connected();
  }
  function renderAxisChain(axis) {
    const p = activePreset, root = ui.chains[axis], list = root.querySelector('.effects-list');
    const mask = axis === 0 ? p.axisEffectsPitch : p.axisEffectsYaw;
    const masks = axis === 0 ? p.parMasksPitch : p.parMasksYaw;
    list.innerHTML = '';
    const tuples = [];
    for (let e = 0; e < EFFECTS.length; e++) {
      if (!(mask & (1 << e))) continue;
      const pm = masks[e] || 0;
      if (!pm) { tuples.push([e, 0]); continue; }
      for (let q = 0; q < 8; q++) if (pm & (1 << q)) tuples.push([e, q]);
    }
    for (const [e, q] of tuples) list.appendChild(buildChainRow(axis, e, q, tuples.length));
    const addSel = root.querySelector('.add-row .eff-sel'), parSel = root.querySelector('.add-row .par-sel');
    fillEffects(addSel, +addSel.value || 0);
    fillParams(parSel, +addSel.value, defaultParamIdxForEffect(+addSel.value));
    root.querySelector('.add-btn').disabled = !connected();
  }
  function buildChainRow(axis, eff, par, count) {
    const row = document.createElement('div'); row.className = 'effect-row';
    const effSel = document.createElement('select'), parSel = document.createElement('select');
    fillEffects(effSel, eff); fillParams(parSel, eff, par);
    effSel.addEventListener('change', () => fillParams(parSel, +effSel.value, defaultParamIdxForEffect(+effSel.value)));
    const rep = document.createElement('button'); rep.type = 'button'; rep.className = 'ghostbtn'; rep.textContent = 'replace';
    rep.title = 'make this pick the only parameter on the axis'; rep.disabled = !connected();
    rep.addEventListener('click', () => { sendAssign(axis, +effSel.value, +parSel.value || 0, false); markEditorDirty(); });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'ghostbtn'; del.textContent = 'delete';
    del.disabled = !connected() || count <= 1;
    del.title = count <= 1 ? 'an axis keeps at least one parameter' : 'take just this parameter off the axis';
    del.addEventListener('click', () => { sendRemoveParam(axis, eff, par); markEditorDirty(); });
    const acts = document.createElement('div'); acts.className = 'row-actions'; acts.append(rep, del);
    row.append(effSel, parSel, acts);
    return row;
  }
  function sendAssign(axis, eff, par, add) { tx(G.frames.setAssign(axis, eff, par, add ? 1 : 0)); localApplyAssign(axis, eff, par, add); }
  function sendRemoveParam(axis, eff, par) { tx(G.frames.removeParam(axis, eff, par)); localApplyRemoveParam(axis, eff, par); }
  function localApplyRemoveParam(axis, eff, par) {
    const p = activePreset; if (!p) return;
    const masks = axis === 0 ? p.parMasksPitch : p.parMasksYaw;
    masks[eff] &= ~(1 << par);
    if (masks[eff] === 0) { if (axis === 0) p.axisEffectsPitch &= ~(1 << eff); else p.axisEffectsYaw &= ~(1 << eff); }
    const repick = (effKey, parKey, axisMask) => {
      if (p[effKey] !== eff || p[parKey] !== par) return;
      if (masks[eff]) { p[parKey] = lowestBit(masks[eff]); return; }
      const next = lowestBit(axisMask);
      p[effKey] = next < 0 ? 0xff : next; p[parKey] = next < 0 ? 0 : Math.max(0, lowestBit(masks[next]));
    };
    if (axis === 0) repick('pitchEff', 'pitchPar', p.axisEffectsPitch); else repick('yawEff', 'yawPar', p.axisEffectsYaw);
    syncChainToAxes(); renderActivePreset();
  }
  function localApplyAssign(axis, eff, par, add) {
    const p = activePreset; if (!p) return;
    const masks = axis === 0 ? p.parMasksPitch : p.parMasksYaw;
    const cur = axis === 0 ? p.axisEffectsPitch : p.axisEffectsYaw;
    let next;
    if (add) { const was = (cur & (1 << eff)) !== 0; next = cur | (1 << eff); masks[eff] = was ? (masks[eff] | (1 << par)) : (1 << par); }
    else { next = 1 << eff; masks.fill(0); masks[eff] = 1 << par; }
    if (axis === 0) { p.axisEffectsPitch = next; p.pitchEff = eff; p.pitchPar = par; }
    else { p.axisEffectsYaw = next; p.yawEff = eff; p.yawPar = par; }
    syncChainToAxes(); renderActivePreset();
  }
  function syncChainToAxes() {
    const p = activePreset; if (!p) return;
    const union = p.axisEffectsPitch | p.axisEffectsYaw, next = [];
    for (const e of p.chain) if (union & (1 << e)) next.push(e);
    for (let e = 0; e < EFFECTS.length; e++) if ((union & (1 << e)) && !next.includes(e)) next.push(e);
    p.chain = next;
  }

  /* ---- screens ----------------------------------------------------- */
  const ARC_START = 225, ARC_SWEEP = 270, ARC_R = 102, CTR = 120;
  function arcPath(cx, cy, r, start, sweep) {
    if (sweep <= 0) return '';
    const xy = d => { const a = (d - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
    const a0 = xy(start), a1 = xy(start + sweep);
    return `M ${a0.x.toFixed(2)} ${a0.y.toFixed(2)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${a1.x.toFixed(2)} ${a1.y.toFixed(2)}`;
  }
  function dimHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = (Math.round(((n >> 16) & 255) * 0.28) << 16) | (Math.round(((n >> 8) & 255) * 0.28) << 8) | Math.round((n & 255) * 0.28);
    return '#' + c.toString(16).padStart(6, '0');
  }
  function setText(svg, sel, text, cls) { const el = svg.querySelector(sel); if (!el) return; el.textContent = text; el.setAttribute('class', sel.slice(1) + (cls && cls.length ? ' ' + cls.filter(Boolean).join(' ') : '')); }
  function setPath(svg, sel, d, stroke) { const el = svg.querySelector(sel); if (!el) return; el.setAttribute('d', d); if (stroke) el.setAttribute('stroke', stroke); }
  function renderScreen(svg, axis) {
    const on = connected(), p = activePreset;
    svg.classList.toggle('disconnected', !on || !p);
    if (!p) {
      setPath(svg, '.arc-track', arcPath(CTR, CTR, ARC_R, ARC_START, ARC_SWEEP), '#202226');
      setPath(svg, '.arc-fill', '');
      setText(svg, '.effect-name', ''); setText(svg, '.param-name', '—'); setText(svg, '.value-text', '');
      setText(svg, '.banner', on ? (axis === 0 ? 'PITCH' : 'YAW') : 'NO LINK', on ? [] : ['disconn']);
      return;
    }
    const colorHex = (G.COLOR_PALETTE[p.colorIdx] || G.COLOR_PALETTE[7]).hex;
    setPath(svg, '.arc-track', arcPath(CTR, CTR, ARC_R, ARC_START, ARC_SWEEP), dimHex(colorHex));
    const eff = axis === 0 ? p.pitchEff : p.yawEff, par = axis === 0 ? p.pitchPar : p.yawPar;
    const row = eff !== 0xff ? rowIndex.get((eff << 8) | par) : null;
    if (!row) {
      setPath(svg, '.arc-fill', ''); setText(svg, '.effect-name', ''); setText(svg, '.param-name', p.name || '—'); setText(svg, '.value-text', '');
      setText(svg, '.banner', `${axis === 0 ? 'PITCH' : 'YAW'} ${idOf(p)}`, [editorDirty ? 'dirty' : '']);
      return;
    }
    const lo = parseFloat(row.thLoInput.value) || 0, hi = parseFloat(row.thHiInput.value) || 0, range = hi - lo;
    let live = parseFloat(row.valueInput.value) || 0;
    let frac = range > 0 ? Math.max(0, Math.min(1, (live - lo) / range)) : 0;
    if (performance.now() - axisRawAtMs < 600) { frac = row.curveEditor.sample(axisRaw01[axis]); live = lo + range * frac; }
    setPath(svg, '.arc-fill', arcPath(CTR, CTR, ARC_R, ARC_START, ARC_SWEEP * frac), colorHex);
    setText(svg, '.effect-name', EFFECTS[eff] ? EFFECTS[eff].name : '');
    setText(svg, '.param-name', row.def.name);
    setText(svg, '.value-text', FX.formatValue(row.def, live));
    setText(svg, '.banner', p.name || idOf(p), [editorDirty ? 'dirty' : '']);
  }
  function renderScreens() { renderScreen(ui.screenPitch, 0); renderScreen(ui.screenYaw, 1); }

  /* ---- frames in ----------------------------------------------------- */
  function onFrame(f) {
    if (f.cmd === R.PONG && lastPingAt) { log('rx', `${describeFrame(f)}  (RTT ${(performance.now() - lastPingAt).toFixed(1)} ms)`); lastPingAt = 0; return; }
    if (f.cmd === R.LIVE_VAL) { handleLiveVal(f.payload); return; }
    if (f.cmd === R.AXIS_RAW) { handleAxisRaw(f.payload); return; }
    if (f.cmd === R.PRESET_INFO) { handlePresetInfo(f.payload); return; }
    if (f.cmd === R.PRESET_MASKS) { handlePresetMasks(f.payload); return; }
    if (f.cmd === R.LIST_END) { handleListEnd(); return; }
    if (f.cmd === R.LOADED) { handleLoaded(f.payload); return; }
    if (f.cmd === CMD.SET_THRESH) {
      if (f.payload.length >= 10) {
        const row = rowIndex.get((f.payload[0] << 8) | f.payload[1]);
        if (row) { row.thLoInput.value = G.bytesToF32(f.payload, 2); row.thHiInput.value = G.bytesToF32(f.payload, 6); refreshThreshReadout(row); renderScreens(); }
      }
      return;
    }
    if (f.cmd === CMD.SET_PARAM) {
      if (f.payload.length >= 6) {
        const row = rowIndex.get((f.payload[0] << 8) | f.payload[1]);
        if (row && document.activeElement !== row.valueInput) { row.valueInput.value = G.bytesToF32(f.payload, 2); refreshValueReadout(row); }
      }
      return;
    }
    if (f.cmd === CMD.SET_CURVE) {
      if (f.payload.length >= 3) { const row = rowIndex.get((f.payload[0] << 8) | f.payload[1]); if (row) row.curveEditor.setFromLut(f.payload.subarray(2)); }
      log('rx', `CURVE sync (eff ${f.payload[0]} par ${f.payload[1]})`);
      return;
    }
    log('rx', describeFrame(f));
  }
  const linkEvents = {
    onConnect: () => {
      setStatus('connected', 'ok');
      setConnectedUi(true);
      log('info', `link up · ${window.GCLink.LINK_LABELS[linkKind]}`);
      /* the unit pushes its curves and live state a beat after connect; the
         bank is read on request (a whole-bank burst browned out the real AP) */
      if (linkKind === 'sim') setTimeout(refreshBank, 200);
      else setTimeout(() => { if (connected()) resendCurves(); }, 800);
    },
    onDisconnect: reason => {
      setStatus(reason ? `disconnected: ${reason.message}` : 'not connected', reason ? 'err' : '');
      setConnectedUi(false);
      presetCache.clear(); activeSlot = null; listInProgress = false;
      clearActivePreset(); setBankStatus(''); bankChanged();
      log(reason ? 'err' : 'info', reason ? `disconnect: ${reason.message}` : 'link down');
    },
    onFrame,
    onRawError: err => log('err', err.message),
  };
  function resendCurves() {
    let n = 0;
    for (const row of rows) if (!row.curveEditor.isIdentity()) { tx(G.frames.setCurve(row.eff, row.par, row.curveEditor.lut())); n++; }
    if (n) log('tx', `re-sent ${n} curve(s)`);
  }

  /* ---- link selection ------------------------------------------------ */
  function availableKinds() {
    const k = ['sim'];
    if (window.GCLink.servedByPedal()) k.unshift('websocket');
    if ('serial' in navigator) k.push('serial');
    return k;
  }
  function setLinkKind(kind) {
    if (link && link.isConnected()) return;
    linkKind = availableKinds().includes(kind) ? kind : availableKinds()[0];
    link = window.GCLink.createLink(linkKind, linkEvents, { getAxes: () => (hooks.getAxes ? hooks.getAxes() : { pitch: 0.5, yaw: 0.5 }) });
    sim = linkKind === 'sim' ? link : null;
    ui.linkSel.value = linkKind;
    ui.fwFile.disabled = linkKind !== 'websocket';
    ui.fwHint.textContent = linkKind === 'websocket'
      ? 'Pick a Ground Control firmware .bin and update. The unit reboots when done (about 20 s): rejoin its WiFi and reload this page. Setups are untouched.'
      : 'Firmware updates run over the unit\'s own WiFi: join the Ground Control network and open this page from there.';
    renderScreens();
  }
  async function connect() {
    try { await link.connect(); }
    catch (err) { setStatus(err.message, 'err'); log('err', err.message); }
  }
  async function disconnect() { if (link) await link.disconnect(); }

  /* ---- firmware panel ------------------------------------------------ */
  function initFirmware() {
    const SLOT_BYTES = 0x1d0000;
    ui.fwFile.addEventListener('change', () => { ui.fwUpdate.disabled = !(ui.fwFile.files && ui.fwFile.files.length); ui.fwStatus.textContent = ''; });
    ui.fwUpdate.addEventListener('click', async () => {
      const f = ui.fwFile.files && ui.fwFile.files[0];
      if (!f) return;
      const head = new Uint8Array(await f.slice(0, 1).arrayBuffer());
      if (head[0] !== 0xe9) { ui.fwStatus.textContent = 'not an ESP32 app image'; ui.fwStatus.className = 'gc-status err'; return; }
      if (f.size < 100000 || f.size > SLOT_BYTES) { ui.fwStatus.textContent = `file size ${f.size} B is outside the app slot`; ui.fwStatus.className = 'gc-status err'; return; }
      ui.fwUpdate.disabled = true; ui.fwFile.disabled = true; ui.fwWrap.hidden = false; ui.fwBar.style.width = '0%';
      ui.fwStatus.className = 'gc-status'; ui.fwStatus.textContent = 'uploading…';
      log('info', `firmware: uploading ${f.name} (${f.size} B)`);
      const form = new FormData(); form.append('f', f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/update');
      xhr.upload.onprogress = ev => { if (ev.lengthComputable) ui.fwBar.style.width = Math.round(ev.loaded / ev.total * 100) + '%'; };
      xhr.onload = () => {
        if (xhr.status === 200) { ui.fwBar.style.width = '100%'; ui.fwStatus.textContent = 'flashed — the unit is rebooting. Rejoin its WiFi and reload in ~20 s.'; ui.fwStatus.className = 'gc-status ok'; }
        else { ui.fwStatus.textContent = `update failed: ${xhr.responseText || 'HTTP ' + xhr.status}`; ui.fwStatus.className = 'gc-status err'; ui.fwUpdate.disabled = false; ui.fwFile.disabled = false; }
      };
      xhr.onerror = () => { ui.fwStatus.textContent = 'connection dropped — if the bar reached 100% the unit is rebooting; reload in ~20 s.'; ui.fwUpdate.disabled = false; ui.fwFile.disabled = false; };
      xhr.send(form);
    });
    ui.dspDfu.addEventListener('click', () => {
      if (!confirm('Put the DSP board into firmware-update mode?\n\nAudio stops until it is flashed or power-cycled.')) return;
      tx(G.frames.dspDfu());
      ui.dfuStatus.textContent = 'DSP is in update mode — flash it over the DSP USB port. Power-cycle to cancel.';
      ui.dfuStatus.className = 'gc-status ok';
      log('tx', 'DSP_DFU');
    });
  }

  /* ---- public: bank actions used by the Library column ---------------- */
  function load(L, D) { tx(G.frames.loadPreset(L, D)); log('tx', `LOAD_PRESET ${G.slotLabel(L, D)}`); }
  function rename(name) {
    if (!activePreset || !connected()) return;
    const n = String(name).slice(0, G.PRESET_NAME_MAX);
    if (n === activePreset.name) return;
    tx(G.frames.setPresetName(activePreset.letter, activePreset.digit, n));
  }
  function renameSlot(L, D, name) { if (!connected()) return; tx(G.frames.setPresetName(L, D, String(name).slice(0, G.PRESET_NAME_MAX))); }
  function save() {
    if (!activePreset || !connected()) return;
    tx(G.frames.savePreset(activePreset.letter, activePreset.digit));
    editorDirty = false; updateDirtyPill();
    log('tx', `SAVE_PRESET ${idOf(activePreset)}`);
  }
  /* "+ new": the live state goes into the first free slot, named UNTITLED */
  function saveNew(name) {
    if (!connected()) return null;
    const used = new Set(presetCache.keys());
    let free = null;
    for (let L = 0; L < 26 && !free; L++) for (let D = 0; D < 10; D++) if (!used.has(slotKey(L, D))) { free = { L, D }; break; }
    if (!free) { alert('The unit has no free Setup slots.'); return null; }
    tx(G.frames.savePreset(free.L, free.D));
    setTimeout(() => tx(G.frames.setPresetName(free.L, free.D, name || 'UNTITLED')), 60);
    log('tx', `SAVE_PRESET ${G.slotLabel(free.L, free.D)} (new)`);
    return G.slotLabel(free.L, free.D);
  }
  function remove(L, D) {
    if (!connected()) return;
    tx(G.frames.deletePreset(L, D));
    presetCache.delete(slotKey(L, D));
    if (activeSlot && activeSlot.letter === L && activeSlot.digit === D) { activeSlot = null; clearActivePreset(); if (hooks.onLoaded) hooks.onLoaded(null, ''); }
    bankChanged();
    log('tx', `DELETE_PRESET ${G.slotLabel(L, D)}`);
  }
  function nameOf(id) { const s = parseId(id); const i = s && presetCache.get(slotKey(s.L, s.D)); return i ? i.name : null; }
  function describe(i) {
    const nm = (e, p) => (e === 0xff ? '—' : `${(EFFECTS[e] || { name: 'eff ' + e }).name} · ${((EFFECTS[e] || {}).params || [])[p] ? EFFECTS[e].params[p].name : 'par ' + p}`);
    return `${nm(i.pitchEff, i.pitchPar)} / ${nm(i.yawEff, i.yawPar)}`;
  }

  /* ---- init ------------------------------------------------------------ */
  function init(opts) {
    hooks = opts || {};
    const mount = hooks.mount;
    mount.innerHTML = template();
    const $ = id => mount.querySelector('#' + id);
    ui = {
      mount, status: $('gc-status'), bankStatus: $('gc-bank-status'), linkSel: $('gc-link'),
      connect: $('gc-connect'), disconnect: $('gc-disconnect'), refresh: $('gc-refresh'), ping: $('gc-ping'),
      active: $('gc-active'), dirty: $('gc-dirty'), swatch: $('gc-swatch'), slot: $('gc-slot'), name: $('gc-name'),
      save: $('gc-save'), discard: $('gc-discard'), delete: $('gc-delete'),
      chains: [$('gc-chain-0'), $('gc-chain-1')],
      paramGrid: $('gc-param-grid'), paramsNote: $('gc-params-note'), chainList: $('gc-chain-list'),
      screenPitch: $('gc-screen-pitch'), screenYaw: $('gc-screen-yaw'),
      fwFile: $('gc-fw-file'), fwUpdate: $('gc-fw-update'), fwStatus: $('gc-fw-status'), fwWrap: $('gc-fw-wrap'), fwBar: $('gc-fw-bar'), fwHint: $('gc-fw-hint'),
      dspDfu: $('gc-dsp-dfu'), dfuStatus: $('gc-dfu-status'),
      log: $('gc-log'), logToggle: $('gc-log-toggle'), logClear: $('gc-log-clear'),
    };
    const labels = window.GCLink.LINK_LABELS;
    ui.linkSel.innerHTML = availableKinds().map(k => `<option value="${k}">${esc(labels[k])}</option>`).join('');
    ui.linkSel.addEventListener('change', () => setLinkKind(ui.linkSel.value));
    ui.connect.addEventListener('click', connect);
    ui.disconnect.addEventListener('click', disconnect);
    ui.refresh.addEventListener('click', refreshBank);
    ui.ping.addEventListener('click', () => { lastPingAt = performance.now(); tx(G.frames.ping()); log('tx', 'PING'); });
    ui.logToggle.addEventListener('click', () => { ui.log.hidden = !ui.log.hidden; ui.logToggle.textContent = ui.log.hidden ? 'show' : 'hide'; });
    ui.logClear.addEventListener('click', () => { ui.log.innerHTML = ''; });
    ui.name.addEventListener('input', () => { if (ui.name.value.length > G.PRESET_NAME_MAX) ui.name.value = ui.name.value.slice(0, G.PRESET_NAME_MAX); rename(ui.name.value); });
    ui.save.addEventListener('click', save);
    ui.discard.addEventListener('click', () => { if (!activePreset) return; load(activePreset.letter, activePreset.digit); editorDirty = false; updateDirtyPill(); });
    ui.delete.addEventListener('click', () => {
      if (!activePreset) return;
      if (!confirm(`Delete Setup ${idOf(activePreset)}${activePreset.name ? ' "' + activePreset.name + '"' : ''} from the unit? This cannot be undone.`)) return;
      remove(activePreset.letter, activePreset.digit);
    });
    for (const a of [0, 1]) {
      const root = ui.chains[a], addSel = root.querySelector('.add-row .eff-sel'), parSel = root.querySelector('.add-row .par-sel');
      addSel.addEventListener('change', () => fillParams(parSel, +addSel.value, defaultParamIdxForEffect(+addSel.value)));
      root.querySelector('.add-btn').addEventListener('click', () => { sendAssign(a, +addSel.value, +parSel.value || 0, true); markEditorDirty(); });
    }
    /* demo pedal: the sliders move the same positions the MIDI / Analog tabs use */
    for (const lab of mount.querySelectorAll('.pedal')) {
      const input = lab.querySelector('input'), key = lab.dataset.pedal;
      input.addEventListener('input', () => { if (hooks.setAxes) hooks.setAxes(key, +input.value); });
      lab.hidden = true;
    }
    renderParamGrid();
    initFirmware();
    setLinkKind(hooks.linkKind || availableKinds()[0]);
    refreshCurveVisibility(); renderScreens(); renderChainList();
    log('info', 'ready — pick a link and connect');
    /* the simulated unit is always there: connect to it without a click */
    if (linkKind === 'sim' && hooks.autoConnect) setTimeout(connect, 50);
  }
  function syncPedals() {
    if (!hooks.getAxes) return;
    const ax = hooks.getAxes();
    for (const lab of ui.mount.querySelectorAll('.pedal')) lab.querySelector('input').value = ax[lab.dataset.pedal];
  }

  window.GCTab = {
    init, setLinkKind, linkKind: () => linkKind, connect, disconnect, isConnected: connected,
    bank, active: () => activePreset, activeId: () => (activeSlot ? G.slotLabel(activeSlot.letter, activeSlot.digit) : null),
    load, rename, renameSlot, save, saveNew, remove, refreshBank, nameOf, describe, idOf, parseId, log, syncPedals,
    simulator: () => sim, listing: () => listInProgress,
  };
})();
