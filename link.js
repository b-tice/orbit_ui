/* Link layer — how the editor talks to a Ground Control.
   One interface, three transports (window.GCLink):
     WsLink     the pedal's own WebSocket at ws://<host>/ws (page served by the pedal)
     SerialLink Web Serial to the unit's USB-CDC port (Chrome/Edge, localhost or https)
     sim        window.GCSim — a Ground Control simulated in the page (gc/sim.js)
   events: { onConnect(), onDisconnect(err?), onFrame({cmd,payload}), onRawError(err) }
   Ported from gc_dsp/web/src/{link,ws,serial}.ts. */

'use strict';

(function () {
  const G = window.GCP;

  /* how the page was reached decides the default transport:
     served by the pedal (its soft-AP) → WebSocket; anywhere else → USB */
  function servedByPedal() {
    const h = location.hostname;
    if (!h || h === 'localhost' || h === '127.0.0.1') return false;
    if (/github\.io$/.test(h)) return false;
    return true;
  }
  function pickLinkKind() { return servedByPedal() ? 'websocket' : 'serial'; }

  /* ---- WebSocket, with auto-reconnect (the unit reboots on hot-plug) ---- */
  class WsLink {
    constructor(events) { this.ev = events; this.socket = null; this.parser = new G.FrameParser(); this.want = false; this.timer = null; this.tries = 0; }
    isConnected() { return !!this.socket && this.socket.readyState === WebSocket.OPEN; }
    async connect() {
      if (this.socket) throw new Error('already connected');
      this.want = true;
      try { await this.open(); } catch (e) { this.want = false; throw e; }
      this.tries = 0;
      this.ev.onConnect();
    }
    open() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      return new Promise((resolve, reject) => {
        const onOpen = () => {
          ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onErr);
          this.socket = ws; this.parser = new G.FrameParser();
          ws.addEventListener('message', e => {
            if (!(e.data instanceof ArrayBuffer)) return;
            for (const f of this.parser.feed(new Uint8Array(e.data))) this.ev.onFrame(f);
          });
          ws.addEventListener('close', () => { if (this.socket === ws) this.socket = null; this.ev.onDisconnect(); this.reconnect(); });
          ws.addEventListener('error', () => this.ev.onRawError(new Error('websocket error')));
          resolve();
        };
        const onErr = () => { ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onErr); reject(new Error(`failed to open ${url}`)); };
        ws.addEventListener('open', onOpen); ws.addEventListener('error', onErr);
      });
    }
    reconnect() {
      if (!this.want || this.timer !== null) return;
      const delay = Math.min(5000, 1000 * (this.tries + 1)); this.tries++;
      this.timer = setTimeout(async () => {
        this.timer = null;
        if (!this.want) return;
        try { await this.open(); this.tries = 0; this.ev.onConnect(); } catch (e) { this.reconnect(); }
      }, delay);
    }
    async disconnect() {
      this.want = false;
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
      const ws = this.socket; this.socket = null;
      if (ws) { try { ws.close(); } catch (e) {} }
      this.ev.onDisconnect();
    }
    async send(bytes) {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('not connected');
      ws.send(bytes);   /* one frame per message — the unit validates inline */
    }
  }

  /* ---- Web Serial (USB-CDC, 115200) ---------------------------------- */
  class SerialLink {
    constructor(events) { this.ev = events; this.port = null; this.writer = null; this.parser = new G.FrameParser(); this.abort = null; }
    isConnected() { return this.port !== null; }
    async connect(baud) {
      if (this.port) throw new Error('already connected');
      if (!('serial' in navigator)) throw new Error('Web Serial is not available — use Chrome or Edge over https or localhost');
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: baud || 115200 });
      this.port = port;
      if (!port.writable) { await port.close().catch(() => {}); this.port = null; throw new Error('port has no writable stream'); }
      this.writer = port.writable.getWriter();
      this.abort = new AbortController();
      this.readLoop(port, this.abort.signal);
      this.ev.onConnect();
    }
    async disconnect() {
      const port = this.port;
      if (!port) return;
      if (this.abort) this.abort.abort(); this.abort = null;
      try { if (this.writer) this.writer.releaseLock(); } catch (e) {}
      this.writer = null;
      try { await port.close(); } catch (e) { this.ev.onRawError(e); }
      this.port = null;
      this.ev.onDisconnect();
    }
    async send(bytes) {
      if (!this.writer) throw new Error('not connected');
      await this.writer.write(bytes);
    }
    async readLoop(port, signal) {
      if (!port.readable) return;
      const reader = port.readable.getReader();
      const onAbort = () => reader.cancel().catch(() => {});
      signal.addEventListener('abort', onAbort);
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) for (const f of this.parser.feed(value)) this.ev.onFrame(f);
        }
      } catch (e) {
        if (!signal.aborted) { this.ev.onRawError(e); this.ev.onDisconnect(e); }
      } finally {
        signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch (e) {}
      }
    }
  }

  function createLink(kind, events, opts) {
    if (kind === 'websocket') return new WsLink(events);
    if (kind === 'serial') return new SerialLink(events);
    return window.GCSim.create(events, opts || {});
  }
  const LINK_LABELS = { sim: 'simulated Ground Control', websocket: `WiFi · ${location.host}`, serial: 'USB' };

  window.GCLink = { servedByPedal, pickLinkKind, WsLink, SerialLink, createLink, LINK_LABELS };
})();
