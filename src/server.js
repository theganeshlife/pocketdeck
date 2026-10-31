// HTTP + WebSocket server: hosts the editor (local only), the companion web app,
// device pairing, live deck sync, button presses and LAN discovery beacons.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { SYSTEM_OPS, OPS_BY_ID } = require('./actions');
const weather = require('./weather');
const { describeAction } = require('./activity-log');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.dirname(require.resolve('lucide-static/package.json')) + '/icons';
const DISCOVERY_PORT = 47800;
const VERSION = require('../package.json').version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal || n.address.startsWith('169.254.')) continue;
      const virtual = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier/i.test(name);
      const ip = n.address.split('.').map(Number);
      const mask = (n.netmask || '255.255.255.0').split('.').map(Number);
      const broadcast = ip.map((b, i) => (b | (~mask[i] & 255))).join('.');
      out.push({ name, ip: n.address, broadcast, virtual });
    }
  }
  const rank = (a) => (a.virtual ? 10 : 0) + (a.ip.startsWith('192.168.') ? 0 : a.ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

let svgCache = new Map();
function iconSvg(name) {
  if (!/^[a-z0-9-]+$/.test(name || '')) return null;
  if (svgCache.has(name)) return svgCache.get(name);
  let svg = null;
  try {
    svg = fs.readFileSync(path.join(ICON_DIR, name + '.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  } catch { /* missing */ }
  svgCache.set(name, svg);
  return svg;
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createServer({ store, runner, port = 8765, log = console.log, activity = null, onDevicesChanged = () => {}, localKey = null, onSound = () => {} }) {
  const act = activity || { ok() {}, fail() {}, info() {}, read: () => '', clear() {} };
  const state = { weather: null, audio: null, port, failures: new Map(), pairingUntil: 0, recentFailures: [], prevPin: null, pinChangedAt: Date.now() };
  const FIXED_LOCK_ID = 'pd-lock'; // the permanent red Lock key, at the bottom left of every deck
  const PIN_LIFETIME_MS = 60 * 1000; // PIN and QR code change every minute
  const PIN_GRACE_MS = 15 * 1000; // the previous PIN still works this long after a routine change, so someone mid-typing isn't cut off
  // New PIN. `grace` keeps the old one briefly (routine rotation only); removals and attacks change it with no grace.
  function rotatePin(grace) {
    state.prevPin = grace ? { pin: store.auth.pin, until: Date.now() + PIN_GRACE_MS } : null;
    store.regeneratePin();
    state.pinChangedAt = Date.now();
  }
  const pinMatches = (pin) => safeEqual(pin, store.auth.pin) || (!!state.prevPin && Date.now() < state.prevPin.until && safeEqual(pin, state.prevPin.pin));
  // Secret for the PC editor's API, new every launch. Web pages in the PC's browser can reach 127.0.0.1 too,
  // so being "local" is not enough: every editor API call must also carry this key.
  const LOCAL_KEY = localKey || crypto.randomBytes(32).toString('hex');
  const PAIRING_WINDOW_MS = 5 * 60 * 1000;
  const MAX_SOCKETS = 16;
  const sockets = new Set(); // { ws, device }

  // ------------------------------------------------------------------ helpers
  const send = (res, code, body, headers = {}) => {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  };
  // CORS only for the two endpoints the Android app calls from its bundled page.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' };
  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: https://gacharya.com; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };

  const safeEqual = (a, b) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  // Blocks DNS-rebinding: the editor must be addressed as localhost/127.0.0.1 on our own port.
  const hostIsLocal = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${state.port}` || h === `localhost:${state.port}` || h === `[::1]:${state.port}`;
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${state.port}` || o === `http://localhost:${state.port}`;
  };
  const editorRequest = (req) => isLocal(req) && hostIsLocal(req) && originOk(req);

  function serveStatic(res, baseDir, rel) {
    const file = path.normalize(path.join(baseDir, rel || 'index.html'));
    if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err) return send(res, 404, 'Not found');
      const target = st.isDirectory() ? path.join(file, 'index.html') : file;
      fs.readFile(target, (err2, data) => {
        if (err2) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
        res.end(data);
      });
    });
  }

  function companionDeck() {
    const c = store.config;
    const icon = (ic) => {
      if (!ic || ic.kind === 'none') return { kind: 'none' };
      if (ic.kind === 'lucide') return { kind: 'svg', svg: iconSvg(ic.value) || iconSvg('square') };
      if (ic.kind === 'emoji') return { kind: 'emoji', value: ic.value };
      if (ic.kind === 'image') return { kind: 'image', value: ic.value };
      return { kind: 'none' };
    };
    return {
      theme: c.theme, accent: c.accent, haptics: c.feedback === 'both' || c.feedback === 'vibrate', feedback: c.feedback, background: c.background, clock: c.clock,
      iconColours: c.iconColours,
      profile: c.profile.show && (c.profile.name || c.profile.photo) ? { name: c.profile.name, photo: c.profile.photo } : null,
      weatherEnabled: c.weather.enabled,
      fixedKey: { id: FIXED_LOCK_ID, fixed: true, icon: icon({ kind: 'lucide', value: 'lock' }), caption: { show: true, text: 'Lock', pos: 'bottom' }, color: '#e5484d', action: { type: 'system' }, confirm: false },
      pages: c.pages.map((p) => ({
        id: p.id, name: p.name,
        buttons: p.buttons.map((b) => {
          const t = b.action?.type || 'none';
          return {
            id: b.id, icon: icon(b.icon), caption: b.caption, color: b.color, size: b.size,
            action: t === 'page' ? { type: 'page', target: b.action.target } : { type: t },
            confirm: t === 'system' && !!OPS_BY_ID[b.action.op]?.confirm,
          };
        }),
      })),
    };
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.ws.readyState === 1) s.ws.send(data);
  }

  async function refreshWeather() {
    const w = store.config.weather;
    if (!w.enabled || !w.location) { state.weather = null; broadcast({ type: 'weather', weather: null }); return; }
    try {
      const cur = await weather.fetchCurrent(w.location, w.unit);
      state.weather = { ...cur, svg: iconSvg(cur.icon) };
      broadcast({ type: 'weather', weather: state.weather });
    } catch (e) {
      log('[weather]', e.message);
      act.fail('weather', e.message);
    }
  }

  // ------------------------------------------------------------------ sound (volume slider and mute buttons on devices)
  // While a device is connected, the PC's volume and mute state are checked every 1.5 s and sent when they change,
  // so the slider follows changes made on the PC too.
  let audioBusy = false;
  let audioErrors = 0;
  async function pollAudio(force = false) {
    if (audioBusy || (!sockets.size && !force)) return;
    audioBusy = true;
    try {
      const a = await runner.audioState();
      audioErrors = 0;
      if (force || JSON.stringify(a) !== JSON.stringify(state.audio)) {
        state.audio = a;
        broadcast({ type: 'audio', audio: a });
      }
    } catch (e) {
      if (audioErrors++ < 3) { log('[audio]', e.message); act.fail('sound', e.message); }
    } finally { audioBusy = false; }
  }
  const audioTimer = setInterval(() => pollAudio(), 1500);
  // Changes from a device: the latest one wins, so dragging the slider never queues up old volumes.
  let audioWanted = null;
  let audioApplying = false;
  async function applyAudio(change) {
    audioWanted = { ...(audioWanted || {}), ...change };
    if (audioApplying) return;
    audioApplying = true;
    try {
      while (audioWanted) {
        const next = audioWanted;
        audioWanted = null;
        try {
          await runner.setAudio(next);
          if (next.mute != null) act.ok('sound', next.mute ? 'sound muted' : 'sound on');
          if (next.micMute != null) act.ok('sound', next.micMute ? 'microphone muted' : 'microphone on');
          // Windows shows its own pop-up for volume and mute; the microphone gets PocketDeck's matching one.
          if (next.micMute != null) { try { onSound({ kind: 'mic', muted: next.micMute }); } catch {} }
        } catch (e) { log('[audio]', e.message); act.fail('sound', e.message); }
      }
    } finally { audioApplying = false; }
    await pollAudio(true);
  }

  function devicesStatus() {
    const online = new Set([...sockets].map((s) => s.device.id));
    // The screen size (CSS px) each connected device last reported, and when it was last used, so the editor
    // can draw its preview at the size and shape of the device in use.
    const screens = {};
    for (const s of sockets) {
      if (s.screen && (!screens[s.device.id] || s.activeAt > screens[s.device.id].at)) screens[s.device.id] = { w: s.screen.w, h: s.screen.h, at: s.activeAt };
    }
    return store.auth.devices.map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, online: online.has(d.id), trusted: d.trusted !== false, hasKey: !!d.token, oneTime: !!d.oneTime, screen: screens[d.id] || null }));
  }

  function findButton(pageId, buttonId) {
    // The permanent Lock key on every deck.
    if (buttonId === FIXED_LOCK_ID) return { id: FIXED_LOCK_ID, action: { type: 'system', op: 'lock' }, caption: { text: 'Lock' } };
    for (const p of store.config.pages) {
      if (pageId && p.id !== pageId) continue;
      const b = p.buttons.find((x) => x.id === buttonId);
      if (b) return b;
    }
    return null;
  }

  // ------------------------------------------------------------------ routes
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const local = editorRequest(req);

    if (req.method === 'OPTIONS') {
      if (p === '/api/hello' || p === '/api/pair') return send(res, 204, '', cors);
      return send(res, 403, '');
    }

    if (p === '/') return send(res, 302, '', { Location: local ? '/editor/' : '/app/' });
    if (p === '/app' || p === '/editor') return send(res, 302, '', { Location: p + '/' });
    if (p.startsWith('/app/')) return serveStatic(res, path.join(ROOT, 'companion'), decodeURIComponent(p.slice(5)));
    if (p.startsWith('/editor/')) {
      if (!local) return send(res, 403, 'The editor is only available on this PC.');
      return serveStatic(res, path.join(ROOT, 'editor'), decodeURIComponent(p.slice(8)));
    }
    if (p.startsWith('/icons/') && p.endsWith('.svg')) {
      const svg = iconSvg(p.slice(7, -4));
      if (!svg) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(svg);
    }

    // ---- public API (Android devices)
    if (p === '/api/hello') return send(res, 200, { app: 'pocketdeck', name: os.hostname(), version: VERSION, pcId: store.auth.pcId }, cors);
    if (p === '/api/pair' && req.method === 'POST') {
      // Pairing only works while "Connect device" is open on the PC (5 minutes), and wrong PINs are rate limited.
      if (Date.now() > state.pairingUntil) {
        return send(res, 403, { error: 'On your PC, open PocketDeck and choose Connect device, then try again.' }, cors);
      }
      const ip = req.socket.remoteAddress;
      if (state.failures.size > 500) state.failures.clear();
      const f = state.failures.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 60000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 5) return send(res, 429, { error: 'Too many attempts. Wait a minute and try again.' }, cors);
      const body = await readBody(req, 10000).catch(() => ({}));
      if (!/^\d{6}$/.test(String(body.pin || '').trim()) || !pinMatches(String(body.pin).trim())) {
        f.n++; state.failures.set(ip, f);
        act.fail('pair', 'wrong PIN');
        // Too many wrong PINs from anywhere: replace the PIN and close pairing, so guessing can't succeed.
        const now = Date.now();
        state.recentFailures = state.recentFailures.filter((t) => now - t < 10 * 60 * 1000);
        state.recentFailures.push(now);
        if (state.recentFailures.length >= 10) {
          rotatePin(false);
          state.pairingUntil = 0;
          state.recentFailures = [];
          act.fail('pair', 'too many wrong PINs; PIN replaced and pairing closed');
        }
        return send(res, 401, { error: 'That PIN is not right. Check the PIN shown in PocketDeck on your PC.' }, cors);
      }
      const device = store.addDevice(body.name, String(body.deviceId || ''));
      for (const s of sockets) if (s.device.id === device.id) s.ws.close(4002, 'Paired again');
      // A PIN works once: change it straight away so it can't be reused.
      rotatePin(false);
      log('[pair] paired', device.name);
      act.ok('pair', device.name);
      onDevicesChanged();
      return send(res, 200, { token: device.token, deviceId: device.id, name: os.hostname(), pcId: store.auth.pcId, saved: !device.oneTime }, cors);
    }

    // ---- local API (editor): this PC only, our own origin, and the per-launch key
    if (p.startsWith('/api/')) {
      if (!local || !safeEqual(req.headers['x-pocketdeck-key'], LOCAL_KEY)) return send(res, 403, { error: 'Forbidden' });
      try {
        if (p === '/api/pairing/open' && req.method === 'POST') {
          state.pairingUntil = Date.now() + PAIRING_WINDOW_MS;
          return send(res, 200, { until: state.pairingUntil });
        }
        if (p === '/api/pairing/close' && req.method === 'POST') { state.pairingUntil = 0; return send(res, 200, { ok: true }); }
        if (p === '/api/meta') {
          const icons = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
          const ops = SYSTEM_OPS.map(({ group, op, label, icon, confirm }) => ({ group, op, label, icon, confirm: !!confirm }));
          return send(res, 200, { icons, systemOps: ops, platform: process.platform, version: VERSION, hostname: os.hostname() });
        }
        if (p === '/api/config' && req.method === 'GET') return send(res, 200, store.config);
        if (p === '/api/config' && req.method === 'PUT') {
          const prev = JSON.stringify(store.config.weather);
          store.setConfig(await readBody(req));
          broadcast({ type: 'deck', deck: companionDeck() });
          if (JSON.stringify(store.config.weather) !== prev) refreshWeather();
          return send(res, 200, { ok: true });
        }
        if (p === '/api/status') {
          const addrs = lanAddresses().map((a) => ({ ...a, url: `http://${a.ip}:${state.port}/app/` }));
          const primary = addrs[0];
          const qrUrl = primary ? `${primary.url}#pair=${store.auth.pin}` : null;
          const qr = qrUrl ? await QRCode.toDataURL(qrUrl, { margin: 1, width: 320, color: { dark: '#0b0d12', light: '#ffffff' } }) : null;
          return send(res, 200, { pairingOpen: Date.now() < state.pairingUntil, pinExpiresIn: Math.max(0, PIN_LIFETIME_MS - (Date.now() - state.pinChangedAt)), pin: store.auth.pin, port: state.port, hostname: os.hostname(), addresses: addrs, qr, qrUrl, devices: devicesStatus(), weather: state.weather });
        }
        if (p === '/api/pin/regenerate' && req.method === 'POST') { rotatePin(false); return send(res, 200, { pin: store.auth.pin }); }
        if (p.startsWith('/api/devices/') && req.method === 'POST') {
          const id = p.split('/').pop();
          const { trusted } = await readBody(req, 1000);
          const d = store.setTrusted(id, trusted);
          if (!d) return send(res, 404, { error: 'Not found' });
          act.info(trusted ? 'device trusted' : 'device untrusted', d.name);
          // Untrusting a device that isn't connected right now means it needs the PIN next time.
          if (!trusted && ![...sockets].some((s) => s.device.id === id)) store.revokeKey(d);
          onDevicesChanged();
          return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/devices/') && req.method === 'DELETE') {
          const id = p.split('/').pop();
          const gone = store.auth.devices.find((d) => d.id === id);
          store.removeDevice(id);
          for (const s of sockets) if (s.device.id === id) s.ws.close(4001, 'Removed');
          // The removed device may have seen the current PIN: replace it at once.
          rotatePin(false);
          if (gone) act.info('device removed by this PC', gone.name);
          onDevicesChanged();
          return send(res, 200, { ok: true });
        }
        if (p === '/api/test' && req.method === 'POST') {
          const { action } = await readBody(req);
          try { await runner.run(action); } catch (e) { act.fail('test', `${describeAction(action)}: ${e.message}`); throw e; }
          act.ok('test', describeAction(action));
          return send(res, 200, { ok: true });
        }
        if (p === '/api/backgrounds' && req.method === 'GET') return send(res, 200, { list: store.recentBackgrounds() });
        if (p === '/api/backgrounds' && req.method === 'POST') { const { image } = await readBody(req, 3 * 1024 * 1024); return send(res, 200, { list: store.addBackground(image) }); }
        if (p.startsWith('/api/backgrounds/') && req.method === 'DELETE') return send(res, 200, { list: store.removeBackground(p.split('/').pop()) });
        if (p === '/api/log' && req.method === 'GET') return send(res, 200, { text: act.read() });
        if (p === '/api/log' && req.method === 'DELETE') { act.clear(); return send(res, 200, { ok: true }); }
        if (p === '/api/geocode') return send(res, 200, { results: await weather.geocode(url.searchParams.get('q') || '') });
        if (p === '/api/favicon') return send(res, 200, { dataUrl: await weather.favicon(url.searchParams.get('url') || '') });
        if (p === '/api/weather/refresh' && req.method === 'POST') { await refreshWeather(); return send(res, 200, { weather: state.weather }); }
        return send(res, 404, { error: 'Not found' });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }
    return send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log('[http]', e); try { send(res, 500, { error: 'Server error' }); } catch {} });
  });

  // ------------------------------------------------------------------ websocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || sockets.size >= MAX_SOCKETS) return socket.destroy();
    const token = url.searchParams.get('token') || '';
    const device = token.length >= 32 ? store.auth.devices.find((d) => d.token && safeEqual(d.token, token)) || null : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!device) { ws.close(4001, 'Not paired'); return; }
      const entry = { ws, device, alive: true, screen: null, activeAt: Date.now() };
      sockets.add(entry);
      store.touchDevice(device);
      onDevicesChanged();
      log('[ws] connected', device.name);
      act.info('device connected', device.name);
      ws.send(JSON.stringify({ type: 'hello', name: os.hostname(), version: VERSION, pcId: store.auth.pcId }));
      ws.send(JSON.stringify({ type: 'deck', deck: companionDeck() }));
      ws.send(JSON.stringify({ type: 'weather', weather: state.weather }));
      if (state.audio) ws.send(JSON.stringify({ type: 'audio', audio: state.audio }));
      pollAudio(true);
      ws.on('pong', () => { entry.alive = true; });
      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'press' || msg.type === 'audio') entry.activeAt = Date.now();
        if (msg.type === 'screen') {
          // The device's screen size in CSS px; the editor's preview follows it.
          const w = Number(msg.w);
          const h = Number(msg.h);
          if (!Number.isInteger(w) || !Number.isInteger(h) || w < 200 || h < 200 || w > 4000 || h > 4000) return;
          const changed = !entry.screen || entry.screen.w !== w || entry.screen.h !== h;
          entry.screen = { w, h };
          entry.activeAt = Date.now();
          if (changed) onDevicesChanged();
        } else if (msg.type === 'press') {
          if (typeof msg.buttonId !== 'string' || msg.buttonId.length > 40 || (msg.pageId != null && typeof msg.pageId !== 'string')) return;
          const b = findButton(msg.pageId, msg.buttonId);
          if (!b) return ws.send(JSON.stringify({ type: 'result', buttonId: msg.buttonId, ok: false, error: 'Button not found' }));
          const label = describeAction(b.action) + (b.caption?.text ? ` "${b.caption.text}"` : '');
          try {
            await runner.run(b.action);
            act.ok('press', label);
            ws.send(JSON.stringify({ type: 'result', buttonId: b.id, ok: true }));
          } catch (e) {
            log('[action]', e.message);
            act.fail('press', `${label}: ${e.message}`);
            ws.send(JSON.stringify({ type: 'result', buttonId: b.id, ok: false, error: e.message }));
          }
        } else if (msg.type === 'session') {
          // After pairing, the device says whether to save this PC (trusted) or use it just this once.
          const d = store.auth.devices.find((x) => x.id === device.id);
          if (d) {
            store.setSession(d, msg.save === true);
            act.info(msg.save === true ? 'device saved for future use' : 'one-time connection', d.name);
            onDevicesChanged();
          }
        } else if (msg.type === 'forget') {
          // The device chose "Forget this PC": remove it here too.
          store.removeDevice(device.id);
          act.info('device forgot this PC', device.name);
          onDevicesChanged();
          ws.close(4001, 'Forgotten');
        } else if (msg.type === 'audio') {
          const change = {};
          if (Number.isInteger(msg.volume) && msg.volume >= 0 && msg.volume <= 100) change.volume = msg.volume;
          if (typeof msg.mute === 'boolean') change.mute = msg.mute;
          if (typeof msg.micMute === 'boolean') change.micMute = msg.micMute;
          if (Object.keys(change).length) applyAudio(change);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        }
      });
      ws.on('close', () => {
        sockets.delete(entry);
        const still = store.auth.devices.find((d) => d.id === device.id);
        if (still) {
          store.touchDevice(still);
          const stillOnline = [...sockets].some((s) => s.device.id === still.id);
          if (!stillOnline && still.oneTime) {
            // One-time connection: gone from the paired list once it ends.
            store.removeDevice(still.id);
            act.info('one-time connection ended; device removed', still.name);
          } else if (!stillOnline && still.trusted === false) store.revokeKey(still);
        }
        onDevicesChanged();
        log('[ws] closed', device.name);
        act.info('device disconnected', device.name);
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const s of sockets) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      try { s.ws.ping(); } catch {}
    }
  }, 15000);

  // ------------------------------------------------------------------ discovery
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let beaconTimer;
  udp.on('error', (e) => log('[udp]', e.message));
  udp.bind(() => {
    try { udp.setBroadcast(true); } catch {}
    const beacon = () => {
      const msg = Buffer.from(JSON.stringify({ app: 'pocketdeck', name: os.hostname(), port: state.port, pcId: store.auth.pcId, v: 2 }));
      const targets = new Set(['255.255.255.255', ...lanAddresses().map((a) => a.broadcast)]);
      for (const t of targets) udp.send(msg, DISCOVERY_PORT, t, () => {});
    };
    beacon();
    beaconTimer = setInterval(beacon, 2000);
  });

  const weatherTimer = setInterval(refreshWeather, 10 * 60 * 1000);
  const pinTimer = setInterval(() => rotatePin(true), PIN_LIFETIME_MS);

  function listen() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryPort = (pt) => {
        const onErr = (e) => {
          if (e.code === 'EADDRINUSE' && attempts++ < 10) return tryPort(pt + 1);
          reject(e);
        };
        server.once('error', onErr);
        server.listen(pt, '0.0.0.0', () => { server.removeListener('error', onErr); state.port = pt; log(`[server] PocketDeck listening on port ${pt}`); act.info('started', `version ${VERSION}, port ${pt}`); refreshWeather(); resolve(pt); });
      };
      tryPort(port);
    });
  }

  function close() {
    clearInterval(heartbeat); clearInterval(beaconTimer); clearInterval(weatherTimer); clearInterval(pinTimer); clearInterval(audioTimer);
    try { udp.close(); } catch {}
    for (const s of sockets) s.ws.terminate();
    server.close();
  }

  return { listen, close, localKey: LOCAL_KEY, get port() { return state.port; }, devicesStatus, broadcastDeck: () => broadcast({ type: 'deck', deck: companionDeck() }) };
}

module.exports = { createServer, lanAddresses };
