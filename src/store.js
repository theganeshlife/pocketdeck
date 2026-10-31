// Persistent storage for the deck layout, settings and paired devices.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Up to 24 keys a page; they arrange themselves by size (no fixed grid). The time and weather are in the top bar
// and the Lock key in the bottom bar.
const BUTTONS_PER_PAGE = 24;

function uid() { return crypto.randomBytes(6).toString('hex'); }

function btn(icon, caption, action, extra = {}) {
  return {
    id: uid(),
    icon: icon ? { kind: 'lucide', value: icon } : { kind: 'none' },
    size: 'normal',
    caption: { show: !!caption, text: caption || '' },
    color: null,
    action: action || { type: 'none' },
    ...extra,
  };
}

function emptyButton() { return btn(null, '', { type: 'none' }); }

function defaultConfig() {
  return {
    version: 4,
    theme: 'obsidian',
    accent: '#6e8bff',
    iconColours: 'original',
    haptics: true,
    profile: { name: '', photo: null, show: true },
    clock: { hour24: false, showSeconds: false, showDate: true },
    weather: { enabled: true, unit: 'C', location: null },
    pages: [
      {
        id: uid(),
        name: 'Main',
        buttons: [
          btn('folder', 'Files', { type: 'system', op: 'explorer' }),
          btn('calculator', 'Calc', { type: 'system', op: 'calculator' }),
          btn('settings', 'Settings', { type: 'system', op: 'settings' }),
          btn('clipboard-list', 'Clipboard', { type: 'system', op: 'clipboard_history' }),
          btn('activity', 'Tasks', { type: 'system', op: 'task_manager' }),
          btn('skip-back', '', { type: 'system', op: 'media_prev' }),
          btn('play', '', { type: 'system', op: 'media_playpause' }),
          btn('skip-forward', '', { type: 'system', op: 'media_next' }),
          btn('monitor', 'Desktop', { type: 'system', op: 'show_desktop' }),
          btn('scan', 'Snip', { type: 'system', op: 'snip' }),
          btn('layout-grid', 'Windows', { type: 'system', op: 'task_view' }),
          btn('copy', 'Copy', { type: 'system', op: 'copy' }),
          btn('clipboard-paste', 'Paste', { type: 'system', op: 'paste' }),
          btn('smile', 'Emoji', { type: 'system', op: 'emoji_panel' }),
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Config validation: everything saved or sent to a device goes through here, so unexpected
// or malformed values (wrong types, script-like text, huge images) are cleaned or dropped.
const THEMES = ['obsidian', 'graphite', 'porcelain', 'linen'];
const ACTION_TYPES = ['none', 'app', 'url', 'open', 'hotkey', 'text', 'command', 'system', 'page'];
const HEX = /^#[0-9a-f]{6}$/i;
const CAPTION_POS = ['bottom', 'top', 'left', 'right', 'center'];
const FEEDBACK = ['both', 'vibrate', 'sound', 'none'];
const KEY_SIZES = ['featured', 'normal', 'less']; // most used, normal, less used
const BG_IMAGE = /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i;
const MAX_BG = 2 * 1024 * 1024;
const ID = /^[a-z0-9_-]{1,40}$/i;
const IMAGE = /^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|bmp|svg\+xml);base64,[a-z0-9+/=]+$/i;
const MAX_IMAGE = 600 * 1024; // characters of data URL
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const image = (v) => (typeof v === 'string' && v.length <= MAX_IMAGE && IMAGE.test(v) ? v : null);

function cleanIcon(ic) {
  if (!ic || typeof ic !== 'object') return { kind: 'none' };
  const auto = ic.auto === true ? { auto: true } : {};
  if (ic.kind === 'lucide' && /^[a-z0-9-]{1,60}$/.test(ic.value || '')) return { kind: 'lucide', value: ic.value, ...auto };
  if (ic.kind === 'emoji' && typeof ic.value === 'string' && ic.value.trim()) return { kind: 'emoji', value: str(ic.value, 16) };
  if (ic.kind === 'image' && image(ic.value)) return { kind: 'image', value: ic.value, ...auto };
  return { kind: 'none' };
}

function cleanAction(a) {
  if (!a || typeof a !== 'object' || !ACTION_TYPES.includes(a.type)) return { type: 'none' };
  const out = { type: a.type };
  const take = (k, max) => { if (a[k] != null) out[k] = str(a[k], max); };
  switch (a.type) {
    case 'app': take('path', 1024); take('args', 1024); take('cwd', 1024); take('appName', 120);
      if (a.iconSrc && typeof a.iconSrc === 'object') out.iconSrc = { iconSource: a.iconSrc.iconSource ? str(a.iconSrc.iconSource, 1024) : null, logo: a.iconSrc.logo ? str(a.iconSrc.logo, 1024) : null, appId: a.iconSrc.appId ? str(a.iconSrc.appId, 512) : null };
      break;
    case 'url': take('url', 2048); break;
    case 'open': take('path', 1024); break;
    case 'hotkey': take('keys', 80); break;
    case 'text': take('text', 4000); break;
    case 'command': take('command', 2000); break;
    case 'system': if (/^[a-z_]{1,40}$/.test(a.op || '')) out.op = a.op; break;
    case 'page': out.target = a.target === 'next' || a.target === 'prev' || ID.test(a.target || '') ? a.target : 'next'; break;
    default: break;
  }
  return out;
}

function cleanButton(b) {
  if (!b || typeof b !== 'object') b = {};
  const cap = b.caption && typeof b.caption === 'object' ? b.caption : {};
  return {
    id: ID.test(b.id || '') ? b.id : uid(),
    icon: cleanIcon(b.icon),
    size: KEY_SIZES.includes(b.size) ? b.size : 'normal',
    caption: { show: bool(cap.show, false), text: str(cap.text, 24), pos: CAPTION_POS.includes(cap.pos) ? cap.pos : 'bottom', ...(cap.auto === true ? { auto: true } : {}) },
    color: typeof b.color === 'string' && HEX.test(b.color) ? b.color : null,
    action: cleanAction(b.action),
  };
}

function normalise(cfg) {
  if (!cfg || typeof cfg !== 'object') cfg = {};
  const def = defaultConfig();
  const clock = cfg.clock && typeof cfg.clock === 'object' ? cfg.clock : {};
  const weather = cfg.weather && typeof cfg.weather === 'object' ? cfg.weather : {};
  const loc = weather.location && typeof weather.location === 'object' ? weather.location : null;
  const lat = loc ? Number(loc.lat) : NaN;
  const lon = loc ? Number(loc.lon) : NaN;
  const profile = cfg.profile && typeof cfg.profile === 'object' ? cfg.profile : {};
  let pages = Array.isArray(cfg.pages) && cfg.pages.length ? cfg.pages.slice(0, 50) : def.pages;
  // Version 2: every deck has a permanent Lock key, so older "Lock PC" keys are cleared to avoid a duplicate.
  if (!(Number(cfg.version) >= 2) && pages !== def.pages) {
    pages = pages.map((p) => (p && Array.isArray(p.buttons)
      ? { ...p, buttons: p.buttons.map((b) => (b && b.action && b.action.type === 'system' && b.action.op === 'lock' ? { id: b.id } : b)) }
      : p));
  }
  const seen = new Set();
  return {
    version: 4,
    theme: THEMES.includes(cfg.theme) ? cfg.theme : def.theme,
    accent: typeof cfg.accent === 'string' && HEX.test(cfg.accent) ? cfg.accent : def.accent,
    // App pictures and emoji on keys in their own colours, or in grey to match a calm deck.
    iconColours: cfg.iconColours === 'greyscale' ? 'greyscale' : 'original',
    haptics: bool(cfg.haptics, true),
    // What a key press feels/sounds like on the device. Older configs only had `haptics`.
    feedback: FEEDBACK.includes(cfg.feedback) ? cfg.feedback : (cfg.haptics === false ? 'none' : 'vibrate'),
    background: {
      image: cfg.background && typeof cfg.background.image === 'string' && cfg.background.image.length <= MAX_BG && BG_IMAGE.test(cfg.background.image) ? cfg.background.image : null,
      overlay: cfg.background && Number.isFinite(Number(cfg.background.overlay)) ? Math.min(0.95, Math.max(0, Number(cfg.background.overlay))) : 0.6,
    },
    clock: { style: clock.style === 'analog' ? 'analog' : 'digital', hour24: bool(clock.hour24, false), showSeconds: bool(clock.showSeconds, false), showDate: bool(clock.showDate, true) },
    weather: {
      enabled: bool(weather.enabled, true),
      unit: weather.unit === 'F' ? 'F' : 'C',
      location: loc && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { name: str(loc.name, 80), region: str(loc.region, 120), lat, lon } : null,
    },
    profile: { name: str(profile.name, 30).trim(), photo: image(profile.photo), show: bool(profile.show, true) },
    pages: pages.map((p) => {
      p = p && typeof p === 'object' ? p : {};
      let id = ID.test(p.id || '') ? p.id : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      const buttons = (Array.isArray(p.buttons) ? p.buttons.slice(0, BUTTONS_PER_PAGE) : []).map(cleanButton);
      while (buttons.length < BUTTONS_PER_PAGE) buttons.push(emptyButton());
      return { id, name: str(p.name, 24).trim() || 'Page', buttons };
    }),
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'deck.json');
    this.authPath = path.join(dir, 'devices.json');
    this.config = normalise(this._read(this.configPath) || defaultConfig());
    const auth = this._read(this.authPath) || {};
    this.auth = {
      pin: auth.pin || Store.newPin(),
      // Stable random ID for this PC, so Android devices can recognise it even if its address changes.
      pcId: /^[0-9a-f]{16,64}$/.test(auth.pcId || '') ? auth.pcId : crypto.randomBytes(12).toString('hex'),
      devices: Store.mergeDuplicates(Array.isArray(auth.devices) ? auth.devices : []),
    };
    this.saveConfig();
    this.saveAuth();
  }

  static newPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

  _read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  setConfig(cfg) { this.config = normalise(cfg); this.saveConfig(); return this.config; }
  saveConfig() { this._write(this.configPath, this.config); }
  saveAuth() { this._write(this.authPath, this.auth); }

  // Up to 5 recently used deck backgrounds, kept on this PC only.
  get backgroundsPath() { return path.join(this.dir, 'backgrounds.json'); }
  recentBackgrounds() {
    const list = this._read(this.backgroundsPath);
    return Array.isArray(list) ? list.filter((b) => b && ID.test(b.id || '') && typeof b.image === 'string' && BG_IMAGE.test(b.image)).slice(0, 5) : [];
  }
  addBackground(image) {
    if (typeof image !== 'string' || image.length > MAX_BG || !BG_IMAGE.test(image)) throw new Error('That image could not be used');
    const list = this.recentBackgrounds().filter((b) => b.image !== image);
    list.unshift({ id: uid(), image });
    this._write(this.backgroundsPath, list.slice(0, 5));
    return this.recentBackgrounds();
  }
  removeBackground(id) {
    this._write(this.backgroundsPath, this.recentBackgrounds().filter((b) => b.id !== id));
    return this.recentBackgrounds();
  }

  regeneratePin() { this.auth.pin = Store.newPin(); this.saveAuth(); return this.auth.pin; }

  static cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60) || 'Android device';
  }

  /** Older versions added a new entry on every pairing: keep one entry per device (the most recently used). */
  static mergeDuplicates(devices) {
    const byKey = new Map();
    for (const d of devices) {
      if (!d || typeof d !== 'object') continue;
      const key = d.deviceId ? 'id:' + d.deviceId : 'name:' + String(d.name || '').toLowerCase();
      const prev = byKey.get(key);
      if (!prev || (d.lastSeen || 0) > (prev.lastSeen || 0)) byKey.set(key, { ...d, pairedAt: Math.min(d.pairedAt || Date.now(), prev ? prev.pairedAt || Date.now() : Date.now()) });
    }
    return [...byKey.values()].map((d) => ({ trusted: true, ...d }));
  }

  /** Pairs a device. A device that paired before (same deviceId) keeps its single entry and trust setting. */
  addDevice(name, deviceId) {
    const token = crypto.randomBytes(24).toString('hex');
    const cleanId = /^[0-9a-f]{16,64}$/.test(deviceId || '') ? deviceId : null;
    let device = cleanId ? this.auth.devices.find((d) => d.deviceId === cleanId) : null;
    // Paired before this version (no device ID yet): adopt the old entry with the same name.
    if (!device && cleanId) device = this.auth.devices.find((d) => !d.deviceId && d.name === Store.cleanName(name)) || null;
    if (device && cleanId) device.deviceId = cleanId;
    if (device) {
      Object.assign(device, { name: Store.cleanName(name), token, lastSeen: Date.now() });
    } else {
      // New pairings are one-time until the device chooses to save this PC.
      device = { id: uid(), deviceId: cleanId, name: Store.cleanName(name), token, trusted: false, oneTime: true, pairedAt: Date.now(), lastSeen: Date.now() };
      this.auth.devices.push(device);
    }
    this.saveAuth();
    return device;
  }
  setSession(device, save) {
    device.oneTime = !save;
    device.trusted = !!save;
    this.saveAuth();
  }
  setTrusted(id, trusted) {
    const d = this.auth.devices.find((x) => x.id === id);
    if (d) { d.trusted = !!trusted; if (trusted) d.oneTime = false; this.saveAuth(); }
    return d;
  }
  /** Untrusted devices need the PIN again after they disconnect: drop their key but keep them in the history. */
  revokeKey(device) { device.token = null; this.saveAuth(); }
  findDevice(token) { return token ? this.auth.devices.find((d) => d.token === token) : null; }
  touchDevice(device) { device.lastSeen = Date.now(); this.saveAuth(); }
  removeDevice(id) { this.auth.devices = this.auth.devices.filter((d) => d.id !== id); this.saveAuth(); }
}

module.exports = { Store, defaultConfig, emptyButton, BUTTONS_PER_PAGE, uid };
