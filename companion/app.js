/* PocketDeck for Android: app logic. Runs inside the Android app, or in a browser when opened from the PC's QR code. */
(function () {
  'use strict';
  const native = window.PocketDeckNative || null;
  const isNative = !!native;
  const A = window.PocketDeckAbout;
  const $ = (id) => document.getElementById(id);
  const nb = (s) => String(s).replace(/(\w)-(\w)/g, '$1‑$2'); // non-breaking hyphens in text we show

  // ------------------------------------------------------------------ storage
  const LS = {
    legacyConn: 'pocketdeck.conn',
    pcs: 'pocketdeck.pcs', // saved PCs: [{ pcId, name, host, token }]
    current: 'pocketdeck.current',
    deviceId: 'pocketdeck.deviceId',
    deck: 'pocketdeck.deck',
    rot: 'pocketdeck.rotlock',
    history: 'pocketdeck.history',
    rating: 'pocketdeck.rating', // { stars } or { never }
    log: 'pocketdeck.log',
  };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const save = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const validPc = (p) => p && typeof p.pcId === 'string' && typeof p.host === 'string' && typeof p.token === 'string' && p.token.length >= 32;
  let pcs = (Array.isArray(load(LS.pcs)) ? load(LS.pcs) : []).filter(validPc);
  const legacy = load(LS.legacyConn);
  if (legacy && legacy.token && !pcs.length) {
    pcs = [{ pcId: 'legacy:' + legacy.host, name: legacy.name || '', host: legacy.host, token: legacy.token }];
    save(LS.pcs, pcs);
    save(LS.current, pcs[0].pcId);
  }
  save(LS.legacyConn, null);
  let conn = pcs.find((p) => p.pcId === load(LS.current)) || null; // the PC in use (a one-time PC lives only in memory)
  const savePcs = () => save(LS.pcs, pcs);
  const isSaved = (pcId) => pcs.some((p) => p.pcId === pcId);
  function rememberPc(pc) {
    pcs = pcs.filter((p) => p.pcId !== pc.pcId && !(p.pcId.startsWith('legacy:') && p.host === pc.host));
    pcs.unshift({ pcId: pc.pcId, name: pc.name || '', host: pc.host, token: pc.token });
    savePcs();
  }
  function forgetPc(pcId) {
    pcs = pcs.filter((p) => p.pcId !== pcId);
    savePcs();
    if (load(LS.current) === pcId) save(LS.current, null);
  }
  /** Random ID for this installation (not linked to the person or the hardware), so a PC lists this device once. */
  function deviceId() {
    let id = load(LS.deviceId);
    if (!/^[0-9a-f]{32}$/.test(id || '')) {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      id = [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
      save(LS.deviceId, id);
    }
    return id;
  }

  // Small local record of what worked and what didn't (no typed text, names or locations), used only in error reports.
  function logEvent(level, event) {
    const list = Array.isArray(load(LS.log)) ? load(LS.log) : [];
    list.push(`${new Date().toISOString()} ${level} ${event}`);
    save(LS.log, list.slice(-150));
  }

  // ------------------------------------------------------------------ state
  let ws = null;
  let connected = false;
  let connectedSince = 0;
  let retry = 0;
  let retryTimer = null;
  let overlayTimer = null;
  let deck = null;
  let triedFullscreen = false;
  let rotLock = load(LS.rot);
  let everConnected = false; // portrait only until the first successful connection
  let askSaveFor = null; // pcId to ask "save this PC?" about once connected
  let session = null; // { pcName, start } for the connection history
  const online = new Map(); // pcId -> host seen on the Wi-Fi

  // ------------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = nb(msg);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function deviceName() {
    if (isNative && native.getDeviceName) { try { return native.getDeviceName(); } catch {} }
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
    return m && m[1] && m[1] !== 'K' ? m[1].trim() : 'Android device';
  }
  function appVersion() {
    if (isNative && native.getAppVersion) { try { return native.getAppVersion(); } catch {} }
    return window.__pdPcVersion || '';
  }
  function normaliseHost(h) {
    h = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/[/#?].*$/, '');
    if (h && !/:\d+$/.test(h)) h += ':8765';
    return /^[a-z0-9.\-:[\]]{3,80}$/i.test(h) ? h : '';
  }
  const fmtDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  function applyTheme(d) {
    const root = document.documentElement;
    root.dataset.theme = d.theme || 'obsidian';
    root.style.setProperty('--accent', d.accent || '#6e8bff');
    root.style.setProperty('--on-accent', window.DeckSafe.onAccent(d.accent || '#6e8bff'));
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
    if (isNative && native.setTheme) { try { native.setTheme(bg, /obsidian|graphite/.test(root.dataset.theme)); } catch {} }
    // Background photo sits behind the theme colour; "overlay" is how much of the theme colour covers it.
    const b = d.background || {};
    const img = b.image && window.DeckSafe.safeImage(b.image);
    $('bg-photo').style.backgroundImage = img ? `url("${img}")` : '';
    $('ambient').style.opacity = img ? String(Math.min(0.95, Math.max(0, Number(b.overlay ?? 0.6)))) : '1';
  }

  // ------------------------------------------------------------------ key press feedback (vibration and/or sound)
  let audioCtx = null;
  function click() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1800, t);
      o.frequency.exponentialRampToValueAtTime(600, t + 0.03);
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.06);
    } catch {}
  }
  function vibrate(ms) {
    if (isNative && native.vibrate) { try { native.vibrate(ms); } catch {} } else if (navigator.vibrate) navigator.vibrate(ms);
  }
  function feedback(kind) {
    const mode = (deck && deck.feedback) || 'vibrate';
    if (kind === 'error') { if (mode !== 'none') vibrate(60); return; }
    if (mode === 'both' || mode === 'vibrate') vibrate(12);
    if (mode === 'both' || mode === 'sound') click();
  }

  // ------------------------------------------------------------------ orientation and rotation lock
  const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const UNLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
  function applyOrientation(phase) {
    if (isNative && native.setOrientation) {
      try {
        if (phase === 'connect') native.setOrientation('portrait', -1);
        else if (rotLock && rotLock.native != null) native.setOrientation('locked', rotLock.native);
        else native.setOrientation('free', -1);
      } catch {}
      return;
    }
    const so = screen.orientation;
    if (!so || !so.lock || !document.fullscreenElement) return;
    if (phase === 'connect') so.lock('portrait').catch(() => {});
    else if (rotLock && rotLock.type) so.lock(rotLock.type).catch(() => {});
    else so.lock('any').catch(() => { try { so.unlock(); } catch {} });
  }
  const lockControl = {
    render(btn) {
      btn.innerHTML = rotLock ? LOCK_SVG : UNLOCK_SVG;
      btn.classList.toggle('on', !!rotLock);
      btn.setAttribute('aria-pressed', rotLock ? 'true' : 'false');
      btn.setAttribute('aria-label', 'Lock rotation');
      btn.title = rotLock ? 'Rotation locked. Tap to unlock.' : 'Lock rotation in this direction';
    },
    toggle(btn) {
      if (rotLock) {
        rotLock = null;
        save(LS.rot, null);
        applyOrientation('deck');
        toast('Rotation unlocked');
      } else if (isNative && native.lockOrientation) {
        try { rotLock = { native: native.lockOrientation() }; } catch { return; }
        save(LS.rot, rotLock);
        toast('Rotation locked');
      } else if (document.fullscreenElement && screen.orientation && screen.orientation.lock) {
        rotLock = { type: screen.orientation.type };
        save(LS.rot, rotLock);
        applyOrientation('deck');
        toast('Rotation locked');
      } else {
        toast('Rotation lock works in the PocketDeck app, or in full screen.');
        return;
      }
      vibrate(10);
      lockControl.render(btn);
    },
  };

  const view = new DeckView($('stage'), {
    mode: 'device',
    fill: 0.97,
    maxCell: 380,
    onDown: () => feedback('press'),
    onPress: (b, page) => press(b, page),
  });
  // Top bar: date and time in the centre, weather on the right.
  const info = new DeckInfo({ now: $('now'), weather: $('weather'), mode: 'device' });

  // ------------------------------------------------------------------ the red Lock key (bottom left, always here)
  const lockBtn = $('lock-pc');
  lockBtn.addEventListener('pointerdown', () => { lockBtn.classList.add('is-pressed'); feedback('press'); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => lockBtn.addEventListener(t, () => lockBtn.classList.remove('is-pressed')));
  lockBtn.onclick = () => press(window.DeckFixed, view.page || { id: null });
  function lockFeedback(ok) {
    lockBtn.classList.remove('is-ok');
    if (!ok) return;
    void lockBtn.offsetWidth;
    lockBtn.classList.add('is-ok');
    setTimeout(() => lockBtn.classList.remove('is-ok'), 300);
  }

  // ------------------------------------------------------------------ sound: speaker mute, volume slider, microphone mute (bottom right)
  // The PC sends its sound state; changes made here go to the PC. Controls stay off until the PC has sent it
  // (PocketDeck for Windows older than this version doesn't send it).
  const IC = window.DeckIcons;
  let audio = null;
  let dragging = false;
  let holdUntil = 0; // ignore the PC's updates just after a change here, so the slider doesn't jump back
  let volTimer = null;
  let volPending = null;
  // ------------------------------------------------------------------ screen size
  // The PC's deck editor draws its preview at this device's size and shape, so it looks exactly like the deck
  // here (upright or sideways, phone or tablet). Sent on connect and whenever the screen turns or changes size.
  let screenSent = '';
  let screenTimer = null;
  function sendScreen(force) {
    if (!ws || ws.readyState !== 1) return;
    const w = Math.round(window.innerWidth);
    const h = Math.round(window.innerHeight);
    if (!w || !h) return;
    const key = w + 'x' + h;
    if (!force && key === screenSent) return;
    screenSent = key;
    try { ws.send(JSON.stringify({ type: 'screen', w, h })); } catch {}
  }
  const queueScreen = () => { clearTimeout(screenTimer); screenTimer = setTimeout(() => sendScreen(false), 250); };
  window.addEventListener('resize', queueScreen);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', queueScreen);

  function sendAudio(change) {
    if (!connected || !ws || ws.readyState !== 1) { toast('Not connected to your PC.'); return false; }
    ws.send(JSON.stringify({ type: 'audio', ...change }));
    holdUntil = Date.now() + 900;
    return true;
  }
  function paintVolume(v) {
    const r = $('volume');
    r.value = String(v);
    r.style.setProperty('--val', v + '%');
    r.setAttribute('aria-valuetext', `${v}%${audio && audio.mute ? ', muted' : ''}`);
  }
  function renderAudio() {
    const a = audio;
    const speakers = !!(a && a.speakers);
    const mic = !!(a && a.mic);
    const snd = $('snd-mute');
    const micBtn = $('mic-mute');
    const vol = $('volume');
    snd.disabled = !speakers || !connected;
    vol.disabled = !speakers || !connected;
    micBtn.disabled = !mic || !connected;
    const muted = speakers && a.mute;
    snd.innerHTML = muted ? IC.volumeOff : IC.volume;
    snd.classList.toggle('is-off', !!muted);
    snd.setAttribute('aria-pressed', String(!!muted));
    snd.title = !a ? 'Sound controls appear once your PC is connected' : !speakers ? 'No speakers found on your PC' : muted ? 'Sound is muted. Tap to unmute.' : 'Tap to mute the sound';
    vol.classList.toggle('is-muted', !!muted);
    if (!dragging && speakers) paintVolume(a.volume);
    const micMuted = mic && a.micMute;
    micBtn.innerHTML = micMuted ? IC.micOff : IC.mic;
    micBtn.classList.toggle('is-off', !!micMuted);
    micBtn.setAttribute('aria-pressed', String(!!micMuted));
    micBtn.title = !a ? 'Microphone control appears once your PC is connected' : !mic ? 'No microphone found on your PC' : micMuted ? 'Microphone is muted. Tap to unmute.' : 'Tap to mute the microphone';
  }
  function setAudio(a) {
    if (a && typeof a === 'object') {
      a = { speakers: !!a.speakers, volume: Math.max(0, Math.min(100, Math.round(Number(a.volume) || 0))), mute: !!a.mute, mic: !!a.mic, micMute: !!a.micMute };
    } else a = null;
    if (a && audio && (dragging || Date.now() < holdUntil)) { a.volume = audio.volume; } // keep what the finger set
    audio = a;
    renderAudio();
  }
  $('snd-mute').onclick = () => {
    if (!audio) return;
    if (sendAudio({ mute: !audio.mute })) { audio.mute = !audio.mute; vibrate(10); renderAudio(); }
  };
  $('mic-mute').onclick = () => {
    if (!audio) return;
    if (sendAudio({ micMute: !audio.micMute })) { audio.micMute = !audio.micMute; vibrate(10); renderAudio(); toast(audio.micMute ? 'Microphone muted' : 'Microphone on'); }
  };
  const volInput = $('volume');
  function flushVolume() {
    volTimer = null;
    if (volPending == null) return;
    const v = volPending;
    volPending = null;
    sendAudio({ volume: v });
  }
  volInput.addEventListener('pointerdown', () => { dragging = true; });
  ['pointerup', 'pointercancel'].forEach((t) => volInput.addEventListener(t, () => { dragging = false; holdUntil = Date.now() + 900; }));
  volInput.addEventListener('input', () => {
    if (!audio) return;
    const v = Number(volInput.value);
    audio.volume = v;
    if (audio.mute && v > 0) audio.mute = false; // moving the slider turns the sound back on, like Windows does
    paintVolume(v);
    renderAudio();
    volPending = v;
    if (!volTimer) volTimer = setTimeout(flushVolume, 90);
  });
  volInput.addEventListener('change', () => { dragging = false; if (volTimer) { clearTimeout(volTimer); flushVolume(); } });
  renderAudio();

  lockControl.render($('rot-lock'));
  $('rot-lock').onclick = () => lockControl.toggle($('rot-lock'));

  // ------------------------------------------------------------------ "Connected for" timer (top right, 10 s after any tap; the weather moves left for it)
  let timerHide = null;
  let timerTick = null;
  function showTimer() {
    if (!connected) return;
    const el = $('session-timer');
    const paint = () => {
      const d = fmtDuration(Date.now() - connectedSince);
      el.querySelector('.long').textContent = 'Connected for ' + d;
      el.querySelector('.short').textContent = d;
      el.setAttribute('aria-label', 'Connected for ' + d);
    };
    paint();
    el.classList.add('show');
    clearInterval(timerTick);
    timerTick = setInterval(paint, 1000);
    clearTimeout(timerHide);
    timerHide = setTimeout(() => { el.classList.remove('show'); setTimeout(() => clearInterval(timerTick), 700); }, 10000);
  }
  $('deck').addEventListener('pointerdown', (e) => { if (!e.target.closest('#status')) showTimer(); });

  // ------------------------------------------------------------------ sheets and dialogs (with focus handling)
  const STICKY = ['save-dialog', 'report-dialog']; // need an answer; tapping outside doesn't close them
  let lastFocus = null;
  function openSheet(id) {
    document.querySelectorAll('.sheet:not([hidden])').forEach((s) => { if (s.id !== id) s.hidden = true; });
    if (!lastFocus || !document.body.contains(lastFocus) || lastFocus.closest('.sheet')) lastFocus = document.activeElement;
    const el = $(id);
    el.hidden = false;
    const first = el.querySelector('button:not([hidden]), a, input');
    if (first) first.focus();
  }
  function closeSheet(id) {
    $(id).hidden = true;
    if (!document.querySelector('.sheet:not([hidden])') && lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
  }
  document.querySelectorAll('.sheet').forEach((s) => {
    s.addEventListener('click', (e) => { if (e.target === s && !STICKY.includes(s.id)) closeSheet(s.id); });
    s.querySelectorAll('.close-sheet').forEach((b) => { b.onclick = () => closeSheet(s.id); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.sheet:not([hidden])')].pop();
    if (open && !STICKY.includes(open.id)) closeSheet(open.id);
  });

  // ------------------------------------------------------------------ screens
  function showConnect(error) {
    $('deck').hidden = true;
    $('connect').hidden = false;
    $('connect-error').textContent = error ? nb(error) : '';
    everConnected = false;
    applyOrientation('connect');
    renderSaved();
    const hostInput = $('host');
    if (!hostInput.value) hostInput.value = (conn && conn.host) || (!isNative && location.protocol.startsWith('http') ? location.host : '');
    if (isNative && native.startDiscovery) { try { native.startDiscovery(); } catch {} }
  }
  function showDeck() {
    $('connect').hidden = true;
    $('deck').hidden = false;
    if (isNative && native.stopDiscovery) { try { native.stopDiscovery(); } catch {} }
    if (!everConnected) applyOrientation('connect');
  }
  function setOnline(on) {
    connected = on;
    $('deck').classList.toggle('is-offline', !on);
    clearTimeout(overlayTimer);
    renderAudio();
    if (on) { $('overlay').hidden = true; return; }
    $('session-timer').classList.remove('show');
    overlayTimer = setTimeout(() => {
      $('overlay-text').textContent = `Reconnecting to ${(conn && conn.name) || 'your PC'}…`;
      $('overlay').hidden = false;
    }, 1500);
  }

  // ------------------------------------------------------------------ pairing (always needs a tap on Connect)
  async function pair(host, pin) {
    host = normaliseHost(host);
    if (!host) throw new Error('Type the PC address shown on your PC.');
    if (!/^\d{6}$/.test(pin)) throw new Error('Type the 6-digit PIN shown on your PC.');
    let res;
    try {
      res = await fetch(`http://${host}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, name: deviceName(), deviceId: deviceId() }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
    } catch {
      logEvent('FAIL', 'pair: PC not reachable');
      throw new Error(`Couldn’t reach ${host}. Check that PocketDeck is running on your PC and both devices are on the same Wi-Fi.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { logEvent('FAIL', 'pair: ' + res.status); throw new Error(data.error || 'Pairing didn’t work. Try again.'); }
    if (typeof data.token !== 'string' || data.token.length < 32) throw new Error('Pairing didn’t work. Try again.');
    logEvent('OK', 'pair');
    conn = { pcId: /^[0-9a-f]{16,64}$/.test(data.pcId || '') ? data.pcId : 'legacy:' + host, host, token: data.token, name: String(data.name || '').slice(0, 60) };
    save(LS.current, conn.pcId);
    if (data.saved && isSaved(conn.pcId)) rememberPc(conn); // saved before on both sides: keep it saved
    else askSaveFor = conn.pcId; // ask once the connection is up
  }

  $('connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('connect-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    $('connect-error').textContent = '';
    try {
      await pair($('host').value, $('pin').value.trim());
      $('pin').value = '';
      start();
    } catch (err) {
      $('connect-error').textContent = nb(err.message);
      $('pin').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
  $('pin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });

  // Saved PCs on the connect screen and in the switcher
  function pcButton(pc, { current = false } = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pc-item' + (current ? ' current' : '');
    const seen = online.has(pc.pcId);
    item.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="text"><b class="t-body"></b><span class="t-small muted"></span></span>';
    item.querySelector('.dot').classList.toggle('off', !seen && !current);
    item.querySelector('b').textContent = pc.name || pc.host;
    const note = current ? 'Connected now' : seen ? 'On your Wi-Fi now. Tap to connect.' : 'Tap to connect';
    item.querySelector('.t-small').textContent = nb(note);
    return item;
  }
  function useSavedPc(pc) {
    leave();
    conn = { ...pc, host: online.get(pc.pcId) || pc.host };
    save(LS.current, pc.pcId);
    start();
  }
  function renderSaved() {
    const box = $('saved-list');
    $('saved').hidden = !pcs.length;
    box.innerHTML = '';
    for (const pc of pcs) {
      const row = document.createElement('div');
      row.className = 'pc-row';
      const item = pcButton(pc);
      item.onclick = () => useSavedPc(pc);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pc-forget';
      x.setAttribute('aria-label', `Forget ${pc.name || pc.host}`);
      x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      x.onclick = () => {
        if (!confirm(`Forget ${pc.name || pc.host}? You’ll need a new PIN to connect again.`)) return;
        forgetPc(pc.pcId);
        renderSaved();
      };
      row.append(item, x);
      box.appendChild(row);
    }
  }

  // Discovery results from the Android app
  const found = new Map();
  window.__pdDiscovered = (json) => {
    let d;
    try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
    if (!d || d.app !== 'pocketdeck' || typeof d.ip !== 'string' || !/^[0-9a-f.:]{3,45}$/i.test(d.ip)) return;
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    d.name = String(d.name || '').slice(0, 60);
    const host = `${d.ip}:${port}`;
    const pcId = /^[0-9a-f]{16,64}$/.test(d.pcId || '') ? d.pcId : null;
    const known = pcId && pcs.find((p) => p.pcId === pcId);
    if (known) {
      const isNew = !online.has(pcId);
      online.set(pcId, host);
      if (known.host !== host) { known.host = host; savePcs(); }
      if (conn && conn.pcId === pcId && conn.host !== host) { conn.host = host; if (!connected && !$('deck').hidden) { retry = 0; connect(); } }
      if (isNew) { if (!$('connect').hidden) renderSaved(); if (!$('pc-sheet').hidden) renderPcSheet(); }
      return;
    }
    if (found.has(host)) return;
    found.set(host, d);
    $('discovered').hidden = false;
    const item = pcButton({ pcId: pcId || host, name: d.name || 'PC', host });
    item.querySelector('.dot').classList.remove('off');
    item.querySelector('.t-small').textContent = host;
    item.onclick = () => {
      document.querySelectorAll('#found-list .pc-item').forEach((x) => x.classList.remove('current'));
      item.classList.add('current');
      $('host').value = host;
      $('pin').focus();
    };
    $('found-list').appendChild(item);
    if (found.size === 1 && !$('host').value) $('host').value = host;
  };

  // ------------------------------------------------------------------ QR code (Android app)
  let scanStream = null;
  let scanRaf = 0;
  if (isNative && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.jsQR) $('scan-btn').hidden = false;
  async function startScan() {
    const msg = $('scan-msg');
    $('scanner').hidden = false;
    $('scan-close').focus();
    msg.textContent = 'Point the camera at the code in Connect device.';
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      msg.textContent = 'PocketDeck needs the camera to scan. Allow camera access, or type the address and PIN instead.';
      return;
    }
    if ($('scanner').hidden) { stopScan(); return; }
    const video = $('scan-video');
    video.srcObject = scanStream;
    await video.play().catch(() => {});
    const canvas = $('scan-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!scanStream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data && useQr(code.data)) return;
      }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
    $('scanner').hidden = true;
  }
  /** The PC's QR code holds http://<address>/app/#pair=<PIN>. It fills the form; the person still taps Connect. */
  function useQr(text) {
    let url;
    try { url = new URL(text); } catch { return false; }
    const pin = new URLSearchParams(url.hash.slice(1)).get('pair');
    if (!/^https?:$/.test(url.protocol) || !/^\d{6}$/.test(pin || '')) return false;
    stopScan();
    $('host').value = normaliseHost(url.host);
    $('pin').value = pin;
    vibrate(20);
    toast('Code scanned. Tap Connect.');
    $('connect-btn').focus();
    return true;
  }
  $('scan-btn').onclick = startScan;
  $('scan-close').onclick = () => { stopScan(); $('scan-btn').focus(); };

  // ------------------------------------------------------------------ connection
  function connect() {
    clearTimeout(retryTimer);
    if (!conn || !conn.token) return showConnect();
    try { ws && ws.close(); } catch {}
    const sock = new WebSocket(`ws://${conn.host}/ws?token=${encodeURIComponent(conn.token)}`);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retry = 0;
      setOnline(true);
      connectedSince = Date.now();
      session = { pcName: conn.name || conn.host, start: Date.now() };
      logEvent('OK', 'connected');
      if (!everConnected) { everConnected = true; applyOrientation('deck'); renderBadge(); }
      sendScreen(true);
      setTimeout(() => sendScreen(false), 600); // after the deck screen has turned to its own orientation
      if (askSaveFor && askSaveFor === conn.pcId) askToSave();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        conn.name = String(msg.name || '').slice(0, 60);
        window.__pdPcVersion = String(msg.version || '');
        const wasSaved = isSaved(conn.pcId);
        if (/^[0-9a-f]{16,64}$/.test(msg.pcId || '') && conn.pcId !== msg.pcId) {
          if (wasSaved) forgetPc(conn.pcId);
          if (askSaveFor === conn.pcId) askSaveFor = msg.pcId;
          conn.pcId = msg.pcId;
          save(LS.current, conn.pcId);
        }
        if (wasSaved) rememberPc(conn);
        if (session) session.pcName = conn.name || conn.host;
        if (!$('save-dialog').hidden) $('save-pc').textContent = conn.name || conn.host;
        renderBadge();
        renderAbout();
      } else if (msg.type === 'deck') {
        setDeck(msg.deck);
        save(LS.deck, msg.deck);
      } else if (msg.type === 'weather') {
        info.setWeather(msg.weather);
      } else if (msg.type === 'audio') {
        setAudio(msg.audio);
      } else if (msg.type === 'result') {
        if (msg.buttonId === window.DeckFixed.id) lockFeedback(!!msg.ok);
        else view.feedback(String(msg.buttonId || ''), !!msg.ok);
        logEvent(msg.ok ? 'OK' : 'FAIL', 'press');
        if (!msg.ok) { feedback('error'); toast(msg.error || 'That action didn’t work.'); }
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      endSession();
      setOnline(false);
      if (ev.code === 4002) return; // replaced by a newer connection from this device
      if (ev.code === 4001) {
        // The PC removed this device, or a one-time connection ended: only a new PIN gets back in.
        logEvent('INFO', 'PC ended the pairing');
        forgetPc(conn.pcId);
        conn = { host: conn.host };
        ws = null;
        $('overlay').hidden = true;
        clearTimeout(overlayTimer);
        closeAllSheets();
        return showConnect('This PC needs a new PIN. On your PC, choose Connect device, then type the PIN here.');
      }
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(connect, Math.min(800 * 2 ** (retry - 1), 8000));
    };
    sock.onerror = () => {};
  }
  function closeAllSheets() { document.querySelectorAll('.sheet:not([hidden])').forEach((s) => { s.hidden = true; }); }

  function endSession() {
    if (!session) return;
    const list = Array.isArray(load(LS.history)) ? load(LS.history) : [];
    list.unshift({ pc: session.pcName, start: session.start, end: Date.now() });
    save(LS.history, list.slice(0, 30));
    session = null;
  }

  function askToSave() {
    askSaveFor = null;
    $('save-pc').textContent = conn.name || conn.host;
    openSheet('save-dialog');
  }
  function answerSave(keep) {
    closeSheet('save-dialog');
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'session', save: keep })); } catch {}
    if (keep) { rememberPc(conn); toast('Saved. Next time, just tap this PC to connect.'); } else { forgetPc(conn.pcId); toast('Connected just this once.'); }
    logEvent('INFO', keep ? 'saved PC' : 'one-time connection');
  }
  $('save-yes').onclick = () => answerSave(true);
  $('save-no').onclick = () => answerSave(false);

  function setDeck(d) {
    if (!d || !Array.isArray(d.pages)) return;
    deck = d;
    applyTheme(d);
    view.setDeck(d);
    info.setDeck(d);
    renderDots();
    renderBadge();
  }

  // Top left: "<b>Name</b>’s PocketDeck" with a small photo once connected, otherwise the PC's name.
  function renderBadge() {
    const p = deck && deck.profile;
    const show = everConnected && p && (p.name || p.photo);
    const av = $('status-avatar');
    const photo = show && p.photo ? window.DeckSafe.safeImage(p.photo) : '';
    av.hidden = !photo;
    av.style.backgroundImage = photo ? `url("${photo}")` : '';
    const nameEl = $('status-name');
    nameEl.textContent = '';
    if (show && p.name) {
      const b = document.createElement('b');
      b.textContent = p.name;
      const suffix = document.createElement('span');
      suffix.className = 'suffix';
      suffix.textContent = '’s PocketDeck';
      nameEl.append(b, suffix);
    } else if (show) {
      nameEl.textContent = 'PocketDeck';
    } else {
      nameEl.textContent = (conn && (conn.name || conn.host)) || 'PocketDeck';
    }
    $('status').setAttribute('aria-label', `${nameEl.textContent}. Your PCs and options`);
  }

  // ------------------------------------------------------------------ pressing keys
  function press(b, page) {
    if (!triedFullscreen && !isNative) {
      triedFullscreen = true;
      const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
      if (!standalone && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => applyOrientation(everConnected ? 'deck' : 'connect')).catch(() => {});
      }
    }
    if (b.action && b.action.type === 'page') return gotoPage(b.action.target);
    if (!connected || !ws || ws.readyState !== 1) { feedback('error'); toast('Not connected to your PC.'); if (!b.fixed) view.feedback(b.id, false); return; }
    ws.send(JSON.stringify({ type: 'press', pageId: b.fixed ? null : page.id, buttonId: b.id }));
  }

  // ------------------------------------------------------------------ pages: dots and swiping
  /** Index of the page a target ('next', 'prev' or a page id) points to. */
  function pageTarget(target) {
    const n = deck.pages.length;
    if (target === 'next') return (view.pageIndex + 1) % n;
    if (target === 'prev') return (view.pageIndex - 1 + n) % n;
    const k = deck.pages.findIndex((p) => p.id === target);
    return k >= 0 ? k : view.pageIndex;
  }
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  /** Changes page. `dir` is -1 when the new page comes in from the right (next), 1 from the left (previous). */
  function gotoPage(target, dir) {
    if (!deck) return;
    const i = pageTarget(target);
    if (i === view.pageIndex) return;
    if (dir == null) dir = target === 'prev' || (target !== 'next' && i < view.pageIndex) ? 1 : -1;
    const g = view.grid;
    const width = $('stage').clientWidth || 400;
    const finish = () => {
      view.setPage(i);
      renderDots();
      showPageName(i);
      vibrate(8);
      if (reduceMotion.matches) { g.style.transition = ''; g.style.transform = ''; g.style.opacity = ''; return; }
      // The new page slides in from the side the finger was moving away from.
      g.style.transition = 'none';
      g.style.transform = `translateX(${-dir * width * 0.6}px)`;
      g.style.opacity = '0.3';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        g.style.transition = `transform 260ms ${EASE}, opacity 220ms`;
        g.style.transform = '';
        g.style.opacity = '';
      }));
    };
    if (reduceMotion.matches) return finish();
    // The current page leaves in the direction of travel, from wherever the finger left it.
    g.style.transition = `transform 170ms ease-in, opacity 170ms`;
    g.style.transform = `translateX(${dir * width * 0.6}px)`;
    g.style.opacity = '0.3';
    setTimeout(finish, 160);
  }
  function showPageName(i) {
    const pn = $('page-name');
    pn.textContent = deck.pages[i].name;
    pn.classList.add('show');
    clearTimeout(pn._t);
    pn._t = setTimeout(() => pn.classList.remove('show'), 1400);
  }
  function renderDots() {
    const dots = $('dots');
    const n = deck ? deck.pages.length : 0;
    dots.hidden = n < 2;
    dots.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === view.pageIndex ? 'on' : '';
      b.setAttribute('aria-label', `Page ${i + 1}: ${deck.pages[i].name}`);
      if (i === view.pageIndex) b.setAttribute('aria-current', 'true');
      b.onclick = () => gotoPage(deck.pages[i].id);
      dots.appendChild(b);
    }
  }
  // Swipe left or right anywhere on the deck: the page follows the finger, then moves on or springs back.
  let sw = null;
  $('stage').addEventListener('pointerdown', (e) => {
    if (sw || !deck) return;
    sw = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, dragging: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (!sw.dragging) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      sw.dragging = true;
      sw.startX = e.clientX;
      view.clearConfirm && view.clearConfirm();
    }
    const g = view.grid;
    const width = $('stage').clientWidth || 400;
    // With one page there is nowhere to go: the page only gives a little.
    const move = deck.pages.length > 1 ? dx : dx * 0.25;
    g.style.transition = 'none';
    g.style.transform = `translateX(${move}px)`;
    g.style.opacity = String(1 - Math.min(0.6, Math.abs(move) / width));
  });
  const endSwipe = (e, cancelled) => {
    if (!sw || e.pointerId !== sw.id) return;
    const s0 = sw;
    sw = null;
    if (!s0.dragging) return;
    const g = view.grid;
    const width = $('stage').clientWidth || 400;
    const dx = e.clientX - s0.x;
    const speed = Math.abs(dx) / Math.max(1, Date.now() - s0.t); // px per ms
    const far = Math.abs(dx) > width * 0.22 || (Math.abs(dx) > 40 && speed > 0.5);
    if (!cancelled && far && deck.pages.length > 1) {
      gotoPage(dx < 0 ? 'next' : 'prev', dx < 0 ? -1 : 1);
    } else {
      g.style.transition = `transform 220ms ${EASE}, opacity 220ms`;
      g.style.transform = '';
      g.style.opacity = '';
    }
  };
  window.addEventListener('pointerup', (e) => endSwipe(e, false));
  window.addEventListener('pointercancel', (e) => endSwipe(e, true));

  // ------------------------------------------------------------------ PC switcher (tap the name at the top left)
  async function probePcs() {
    // Checks which saved PCs answer on the Wi-Fi right now.
    await Promise.all(pcs.map(async (pc) => {
      try {
        const r = await fetch(`http://${online.get(pc.pcId) || pc.host}/api/hello`, { signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined });
        const j = await r.json();
        if (j && j.app === 'pocketdeck' && (!j.pcId || j.pcId === pc.pcId || pc.pcId.startsWith('legacy:'))) online.set(pc.pcId, online.get(pc.pcId) || pc.host);
        else online.delete(pc.pcId);
      } catch { online.delete(pc.pcId); }
    }));
    if (!$('pc-sheet').hidden) renderPcSheet();
  }
  function renderPcSheet() {
    const box = $('pc-list');
    box.innerHTML = '';
    const list = pcs.slice();
    if (conn && conn.token && !list.some((p) => p.pcId === conn.pcId)) list.unshift(conn);
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 't-body muted';
      p.textContent = 'No saved PCs yet.';
      box.appendChild(p);
    }
    for (const pc of list) {
      const current = !!(conn && pc.pcId === conn.pcId && connected);
      const item = pcButton(pc, { current });
      item.onclick = () => { closeSheet('pc-sheet'); if (!current) useSavedPc(pc); };
      box.appendChild(item);
    }
    $('act-fullscreen').hidden = isNative;
    $('act-forget').hidden = !conn || !conn.token;
    $('act-disconnect').hidden = !conn || !conn.token;
  }
  $('status').onclick = () => {
    renderPcSheet();
    openSheet('pc-sheet');
    if (isNative && native.startDiscovery) { try { native.startDiscovery(); } catch {} }
    probePcs();
  };
  $('overlay-switch').onclick = $('status').onclick;

  function leave() {
    const old = ws;
    ws = null;
    try { old && old.close(); } catch {}
    endSession();
    clearTimeout(retryTimer);
    connected = false;
    clearTimeout(overlayTimer);
    $('overlay').hidden = true;
    $('session-timer').classList.remove('show');
    setAudio(null);
    if (isNative && native.stopDiscovery && !$('deck').hidden) { try { native.stopDiscovery(); } catch {} }
  }
  $('act-another').onclick = () => {
    closeSheet('pc-sheet');
    leave();
    conn = null;
    save(LS.current, null);
    $('host').value = '';
    showConnect();
  };
  $('act-reload').onclick = () => { closeSheet('pc-sheet'); retry = 0; connect(); };
  $('act-disconnect').onclick = () => {
    closeSheet('pc-sheet');
    leave();
    if (conn && !isSaved(conn.pcId)) conn = { host: conn.host }; // a one-time PC can't be reused
    save(LS.current, null);
    showConnect();
    maybeAskRating();
  };
  $('act-forget').onclick = () => {
    if (!confirm('Disconnect and forget this PC? You’ll need a new PIN to connect again.')) return;
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'forget' })); } catch {}
    const id = conn && conn.pcId;
    closeSheet('pc-sheet');
    setTimeout(() => {
      leave();
      if (id) forgetPc(id);
      conn = conn ? { host: conn.host } : null;
      save(LS.deck, null);
      showConnect();
      toast('This PC has been forgotten.');
      maybeAskRating();
    }, 150);
  };
  $('act-fullscreen').onclick = () => {
    closeSheet('pc-sheet');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => applyOrientation(everConnected ? 'deck' : 'connect')).catch(() => toast('Full screen isn’t available here.'));
  };
  $('act-more').onclick = () => openSheet('home-menu');
  $('open-menu').onclick = () => openSheet('home-menu');

  // ------------------------------------------------------------------ menu: about, history, updates, rating
  function renderAbout() {
    const v = appVersion();
    document.querySelectorAll('.app-version').forEach((el) => { el.textContent = v ? A.versionLabel(v) : ''; });
    document.querySelectorAll('.about-feedback').forEach((el) => { el.href = A.feedbackUrl; });
  }
  function showInfo(kind) {
    const body = $('info-body');
    body.innerHTML = '';
    const p = (text, cls) => { const el = document.createElement('p'); if (cls) el.className = cls; el.textContent = nb(text); body.appendChild(el); return el; };
    const link = (href, text, cls) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.className = cls; a.textContent = text; return a; };
    if (kind === 'about') {
      $('info-h').textContent = 'About PocketDeck';
      const v = appVersion();
      p(`PocketDeck${v ? ' ' + A.versionLabel(v) : ''}`, 't-heading');
      p('Created by Ganesh Acharya');
      p(`${A.blurb} ${A.momo}`);
      const row = document.createElement('div');
      row.className = 'button-stack';
      row.append(link(A.momoUrl, 'Buy me a plate of momo', 'primary'), link(A.feedbackUrl, 'Contact and feedback', 'secondary'));
      body.appendChild(row);
      p(A.privacy, 't-small muted');
    } else if (kind === 'history') {
      $('info-h').textContent = 'Connection history';
      const list = Array.isArray(load(LS.history)) ? load(LS.history) : [];
      if (!list.length) p('No connections yet. They appear here after you connect to a PC.');
      else {
        const ul = document.createElement('ul');
        ul.className = 'history';
        for (const h of list) {
          const li = document.createElement('li');
          const b = document.createElement('b');
          b.textContent = h.pc;
          const s = document.createElement('span');
          s.className = 't-small muted';
          s.textContent = `${new Date(h.start).toLocaleString()} · ${fmtDuration(h.end - h.start)}`;
          li.append(b, s);
          ul.appendChild(li);
        }
        body.appendChild(ul);
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'secondary';
        clear.textContent = 'Clear history';
        clear.onclick = () => { save(LS.history, null); showInfo('history'); toast('History cleared.'); };
        body.appendChild(clear);
      }
      p('The history stays on this device only.', 't-small muted');
    } else if (kind === 'updates') {
      $('info-h').textContent = 'Check for updates';
      const v = appVersion();
      const status = p(`You have PocketDeck ${v ? A.versionLabel(v) : ''}. Checking for a newer version…`);
      status.setAttribute('role', 'status');
      A.checkForUpdate('android', v).then((r) => {
        status.textContent = nb(r.message);
        if (r.update && r.url && /^https:\/\//.test(r.url)) body.appendChild(link(r.url, 'Open the download page', 'primary'));
      });
    }
    openSheet('info-sheet');
  }
  document.querySelectorAll('[data-info]').forEach((b) => { b.onclick = () => showInfo(b.dataset.info); });

  let afterRating = null;
  function maybeAskRating(then) {
    const r = load(LS.rating) || {};
    if (r.never || r.stars) { if (then) then(); return false; }
    afterRating = then || null;
    document.querySelectorAll('.stars button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
    openSheet('rate-dialog');
    return true;
  }
  function finishRating() { closeSheet('rate-dialog'); const f = afterRating; afterRating = null; if (f) f(); }
  document.querySelectorAll('.stars button').forEach((b) => {
    b.onclick = () => {
      const stars = Number(b.dataset.stars);
      document.querySelectorAll('.stars button').forEach((x) => {
        x.classList.toggle('on', Number(x.dataset.stars) <= stars);
        x.setAttribute('aria-checked', String(Number(x.dataset.stars) === stars));
      });
      save(LS.rating, { stars });
      A.sendRating('android', appVersion(), stars);
      logEvent('INFO', 'rated');
      toast('Thank you for rating PocketDeck.');
      setTimeout(finishRating, 500);
    };
  });
  $('rate-later').onclick = finishRating;
  $('rate-never').onclick = () => { save(LS.rating, { never: true }); finishRating(); };
  $('menu-rate').onclick = () => { save(LS.rating, null); maybeAskRating(); };

  // Android back button: close what's open; otherwise ask for a rating once, then leave.
  window.__pdBack = () => {
    if (!$('scanner').hidden) { stopScan(); return 'stay'; }
    const open = [...document.querySelectorAll('.sheet:not([hidden])')].pop();
    if (open) { if (open.id !== 'save-dialog') { if (open.id === 'rate-dialog') finishRating(); else closeSheet(open.id); } return 'stay'; }
    const asked = maybeAskRating(() => { try { native && native.exitApp && native.exitApp(); } catch {} });
    return asked ? 'stay' : 'exit';
  };

  // ------------------------------------------------------------------ error reports (sent only if the person agrees)
  let pendingReport = null;
  function offerReport(error) {
    if (pendingReport) return;
    pendingReport = String(error || 'Unknown error').slice(0, 4000);
    logEvent('FAIL', 'error: ' + pendingReport.split('\n')[0].slice(0, 120));
    openSheet('report-dialog');
  }
  $('report-send').onclick = async () => {
    closeSheet('report-dialog');
    const report = pendingReport;
    const ok = await A.sendReport({ app: 'android', version: appVersion(), platform: navigator.userAgent.slice(0, 200), error: report, log: (load(LS.log) || []).join('\n') });
    toast(ok ? 'Thank you. The report has been sent.' : 'The report couldn’t be sent. Check the internet connection and try again later.');
    pendingReport = null;
  };
  $('report-skip').onclick = () => { closeSheet('report-dialog'); pendingReport = null; };
  window.addEventListener('error', (e) => { if (e.message) offerReport(`${e.message} at ${e.filename || ''}:${e.lineno || ''}\n${(e.error && e.error.stack) || ''}`); });
  window.addEventListener('unhandledrejection', (e) => offerReport(`Unhandled: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));

  // ------------------------------------------------------------------ keep the screen awake (browser)
  async function keepAwake() {
    if (isNative || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { await navigator.wakeLock.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      if (conn && conn.token && (!ws || ws.readyState > 1) && !$('deck').hidden) { retry = 0; connect(); }
    }
  });

  // ------------------------------------------------------------------ start
  function start() {
    showDeck();
    const cached = load(LS.deck);
    if (cached && !deck) setDeck(cached);
    renderBadge();
    setOnline(false);
    connect();
    keepAwake();
  }

  function boot() {
    renderAbout();
    // Readable text on accent buttons even before a deck (and its accent colour) has arrived.
    const root = document.documentElement;
    root.style.setProperty('--on-accent', window.DeckSafe.onAccent(getComputedStyle(root).getPropertyValue('--accent').trim() || '#6e8bff'));
    const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
    const pin = params.get('pair');
    if (!isNative && location.protocol.startsWith('http')) {
      // Opened in a browser from the PC: use the saved entry for this address, if any.
      const here = pcs.find((p) => p.host === location.host);
      conn = here ? { ...here } : null;
      if (pin) {
        history.replaceState(null, '', location.pathname);
        if (!here) {
          // From the QR code: fill in the form; the person taps Connect.
          const cached = load(LS.deck);
          if (cached) applyTheme(cached);
          $('host').value = location.host;
          $('pin').value = String(pin).replace(/\D/g, '').slice(0, 6);
          showConnect();
          $('connect-btn').focus();
          return;
        }
      }
    }
    if (conn && conn.token) start();
    else {
      const cached = load(LS.deck);
      if (cached) applyTheme(cached);
      showConnect();
    }
    // Did the Android app crash last time? Offer to send a report.
    if (isNative && native.getPendingCrash) {
      try { const crash = native.getPendingCrash(); if (crash) setTimeout(() => offerReport('Android crash:\n' + crash), 800); } catch {}
    }
  }
  window.__pdDeepLink = (query) => {
    const p = new URLSearchParams(query);
    if (p.get('host')) $('host').value = normaliseHost(p.get('host'));
    if (p.get('pair')) { showConnect(); $('pin').value = String(p.get('pair')).replace(/\D/g, '').slice(0, 6); }
  };
  window.__pocketdeck = { view, info, toast, showTimer, offerReport, setAudio };
  boot();
})();
