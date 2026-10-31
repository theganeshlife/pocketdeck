/* PocketDeck desktop editor */
(function () {
  const host = window.deckHost || null; // desktop-only features (file pickers, app icons)
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Math.random()).slice(2)).slice(0, 12);
  if (host) document.body.classList.add('desktop');

  // ------------------------------------------------------------------ data
  const THEMES = [
    { id: 'obsidian', name: 'Obsidian', note: 'Dark' },
    { id: 'graphite', name: 'Graphite', note: 'Dark, neutral' },
    { id: 'porcelain', name: 'Porcelain', note: 'Light' },
    { id: 'linen', name: 'Linen', note: 'Light, warm' },
  ];
  const DARK = new Set(['obsidian', 'graphite']);
  const KEY_COLORS = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#6e8bff', '#8e4ec6', '#d6409f', '#5b6170'];
  const ACCENTS = ['#6e8bff', '#0090ff', '#12a594', '#30a46c', '#ffb224', '#f76b15', '#e5484d', '#d6409f', '#8e4ec6'];
  const ACTION_TYPES = [
    { type: 'none', label: 'Nothing', icon: 'circle-off' },
    { type: 'app', label: 'Open app', icon: 'app-window' },
    { type: 'url', label: 'Website', icon: 'globe' },
    { type: 'system', label: 'Windows', icon: 'monitor-cog' },
    { type: 'hotkey', label: 'Shortcut', icon: 'keyboard' },
    { type: 'text', label: 'Type text', icon: 'type' },
    { type: 'open', label: 'File / folder', icon: 'folder-open' },
    { type: 'command', label: 'Command', icon: 'square-terminal' },
    { type: 'page', label: 'Switch page', icon: 'layers' },
  ];
  const EMOJI = '🎮 🎧 🎵 🎬 📺 🎙️ 📷 🖥️ 💻 ⌨️ 🖱️ 🖨️ 📁 📂 📝 📊 📈 📅 📧 💬 📞 🔔 🔒 🔓 🔑 ⚙️ 🛠️ 🧰 🔍 🌐 🏠 💡 🔆 🌙 ☀️ ⛅ 🌧️ ❄️ ⚡ 🔥 ⭐ ❤️ ✅ ❌ ⚠️ ⏯️ ⏭️ ⏮️ 🔊 🔇 🔉 🚀 🎯 🧠 📌 📎 ✂️ 🗑️ ☕ 🍕 🎨 🧩 🕹️ 👾 🎲 🏆 💰 🛒 ✈️ 🚗 📚 🧘 💤 👋 😀 😎 🤖'.split(' ');

  const POPULAR = ('globe mail message-circle music headphones mic mic-off video camera monitor laptop smartphone gamepad-2 '
    + 'folder folder-open file-text image film tv play pause skip-forward skip-back volume-2 volume-1 volume-x '
    + 'sun moon lock unlock power rotate-ccw settings wrench terminal code github git-branch database cloud '
    + 'calendar clock timer alarm-clock bell star heart bookmark home search zap rocket coffee shopping-cart '
    + 'calculator clipboard copy scissors keyboard mouse-pointer-click layout-grid app-window maximize-2 minimize-2 '
    + 'scan printer wifi bluetooth battery-charging lightbulb flame bot brain sparkles message-square-text phone users').split(' ');
  let cfg = null;
  let meta = { icons: [], systemOps: [] };
  let pageIndex = 0;
  let selected = null; // index of selected key on current page
  let iconTab = 'lucide';
  let iconQuery = '';
  let status = null;
  const undoStack = [];
  const redoStack = [];
  let lastPush = { key: null, t: 0 };

  // ------------------------------------------------------------------ helpers
  function paintIcons(root = document) {
    $$('.ico[data-icon]', root).forEach((el) => el.style.setProperty('--src', `url(/icons/${el.dataset.icon}.svg)`));
  }
  const icoHtml = (name) => `<i class="ico" style="--src:url(/icons/${esc(name)}.svg)"></i>`;

  let toastTimer;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', err);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), err ? 3800 : 2000);
  }

  // Per-launch key for the local API: from the desktop app, or from #key=… when run with `npm run server`.
  const API_KEY = (() => {
    if (host && host.localKey) return host.localKey;
    const m = /(?:^|[#&])key=([0-9a-f]{64})/.exec(location.hash);
    if (m) { try { sessionStorage.setItem('pd.key', m[1]); } catch {} history.replaceState(null, '', location.pathname); return m[1]; }
    try { return sessionStorage.getItem('pd.key') || ''; } catch { return ''; }
  })();

  async function api(path, opts = {}) {
    const headers = { 'X-PocketDeck-Key': API_KEY };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      ...opts,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const svgCache = new Map();
  let rerenderQueued = false;
  function lucide(name) {
    if (!name) return '';
    if (svgCache.has(name)) return svgCache.get(name);
    svgCache.set(name, '');
    fetch(`/icons/${name}.svg`).then((r) => (r.ok ? r.text() : '')).then((t) => {
      svgCache.set(name, t);
      if (!rerenderQueued) { rerenderQueued = true; requestAnimationFrame(() => { rerenderQueued = false; view.render(); view.setSelected(selectedId()); }); }
    });
    return '';
  }

  const page = () => cfg.pages[pageIndex];
  const btn = () => (selected == null ? null : page().buttons[selected]);
  const selectedId = () => btn()?.id || null;

  // ------------------------------------------------------------------ saving & history
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await api('/api/config', { method: 'PUT', body: cfg }); }
      catch (e) { toast('Could not save: ' + e.message, true); }
    }, 250);
  }
  function snapshot(key) {
    const now = Date.now();
    if (key && lastPush.key === key && now - lastPush.t < 1200) { lastPush.t = now; return; }
    lastPush = { key, t: now };
    undoStack.push(JSON.stringify(cfg));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(cfg));
    cfg = JSON.parse(from.pop());
    lastPush = { key: null, t: 0 };
    if (pageIndex >= cfg.pages.length) pageIndex = 0;
    applyTheme();
    renderAll();
    save();
  }
  /** Change the selected key. `key` groups rapid edits (typing) into one undo step. */
  function editKey(fn, { key = null, inspector = false } = {}) {
    const b = btn();
    if (!b) return;
    snapshot(key);
    fn(b);
    view.setDeck(cfg);
    view.setPage(pageIndex);
    view.setSelected(b.id);
    if (inspector) renderInspector(); else updateHeader();
    paintKeyCount();
    save();
  }
  function editCfg(fn, { key = null } = {}) {
    snapshot(key);
    fn(cfg);
    applyTheme();
    view.setDeck(cfg);
    view.setPage(pageIndex);
    view.setSelected(selectedId());
    refreshBars();
    save();
  }
  function refreshBars() {
    info.setDeck({ ...cfg, weatherEnabled: cfg.weather?.enabled !== false });
    renderPreviewBars();
    paintKeyCount();
  }
  function paintKeyCount() {
    const used = page().buttons.slice(0, window.DeckGrids.MAX_KEYS).filter((b) => !window.DeckGrids.isEmptyKey(b)).length;
    $('#key-count').textContent = `${used} of ${window.DeckGrids.MAX_KEYS} keys on this page`;
  }

  // ------------------------------------------------------------------ theme
  function cssColorToHex(css) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    x.fillStyle = '#000';
    x.fillStyle = css;
    x.fillRect(0, 0, 1, 1);
    const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = cfg.theme;
    root.style.setProperty('--accent', cfg.accent);
    root.style.setProperty('--on-accent', window.DeckSafe.onAccent(cfg.accent));
    const bg = cfg.background || {};
    const img = bg.image && window.DeckSafe ? window.DeckSafe.safeImage(bg.image) : '';
    const pb = document.getElementById('preview-bg');
    if (pb) pb.style.backgroundImage = img ? `url("${img}")` : '';
    const amb = document.querySelector('.device-screen .ambient');
    if (amb) amb.style.opacity = img ? String(bg.overlay ?? 0.6) : '1';
    if (host && host.setTitlebar) {
      requestAnimationFrame(() => {
        const cs = getComputedStyle($('.topbar'));
        host.setTitlebar({ color: cssColorToHex(cs.backgroundColor), symbolColor: cssColorToHex(cs.color) });
      });
    }
  }

  // ------------------------------------------------------------------ deck preview
  const view = new DeckView($('#stage'), {
    mode: 'editor',
    fill: 0.97, // the same as on the device, so the keys come out the same
    maxCell: 380,
    lucide,
    onSelect: (id, index) => select(index),
  });
  // The bars above and below the keys, as the device shows them.
  const info = new DeckInfo({ now: $('#pv-now'), weather: $('#pv-weather'), mode: 'editor', lucide });
  $('#pv-now').onclick = () => openSettings('clock');
  $('#pv-weather').onclick = () => openSettings('weather');
  $('#pv-lock').innerHTML = window.DeckIcons.lock;
  $('#pv-lock').onclick = () => toast('The red Lock key locks your PC. It is always at the bottom left of the deck and can’t be changed or moved.');
  $('#pv-snd').innerHTML = window.DeckIcons.volume;
  $('#pv-mic').innerHTML = window.DeckIcons.mic;
  $('#pv-rot').innerHTML = window.DeckIcons.lock;
  // The preview is drawn at the real size of the Android device (in its CSS px) and scaled to fit the frame, so
  // the keys, text and controls arrange themselves exactly as they do on the device. "Match device" follows the
  // connected device's screen as it is turned (upright or sideways) and when another device is used. Landscape
  // and Portrait show a typical phone instead.
  const PHONE = { landscape: { w: 915, h: 412 }, portrait: { w: 412, h: 892 } };
  const LS_MODE = 'pocketdeck.previewMode';
  const LS_SCREEN = 'pocketdeck.previewScreen';
  const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let previewMode = ['auto', 'landscape', 'portrait'].includes(readLS(LS_MODE)) ? readLS(LS_MODE) : 'auto';
  // The device the preview matches: { w, h, name, online }. Remembered so the preview keeps its shape after the
  // device disconnects.
  let matched = (() => {
    const m = readLS(LS_SCREEN);
    return m && Number.isFinite(m.w) && Number.isFinite(m.h) && m.w >= 200 && m.h >= 200 ? { w: m.w, h: m.h, name: String(m.name || '').slice(0, 60), online: false } : null;
  })();
  const previewSize = () => (previewMode === 'auto' && matched ? matched : PHONE[previewMode === 'portrait' ? 'portrait' : (previewMode === 'auto' ? 'landscape' : previewMode)]);
  function sizePreview() {
    const canvas = $('.canvas');
    const dev = $('.device');
    const shell = $('.preview-shell');
    const size = previewSize();
    const cs = getComputedStyle(canvas);
    const used = [$('.canvas-tools'), $('.canvas-hint')].reduce((t, el) => t + el.offsetHeight + parseFloat(cs.rowGap || 16), 0);
    const availW = canvas.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = canvas.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - used;
    const FRAME = 24; // the dark border around the screen
    const r = size.w / size.h;
    let sw = Math.min(availW - FRAME, 980 - FRAME, (Math.min(availH, 800) - FRAME) * r);
    sw = Math.max(120, sw);
    const sh = sw / r;
    dev.style.width = Math.round(sw + FRAME) + 'px';
    dev.style.height = Math.round(sh + FRAME) + 'px';
    dev.classList.toggle('portrait', size.h > size.w);
    const z = (Math.round(sw + FRAME) - FRAME) / size.w;
    shell.style.zoom = String(z);
    shell.style.width = size.w + 'px';
    shell.style.height = (Math.round(sh + FRAME) - FRAME) / z + 'px';
  }
  new ResizeObserver(() => sizePreview()).observe($('.canvas'));
  function renderPreviewMode() {
    $$('#preview-orient button').forEach((x) => { const on = x.dataset.o === previewMode; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    const note = $('#preview-note');
    if (previewMode !== 'auto') note.innerHTML = '';
    else if (!matched) note.textContent = 'Connect a device to match its screen';
    else note.innerHTML = `${matched.online ? 'Matching' : 'Last matched'} <b>${esc(matched.name || 'your device')}</b>, ${matched.h > matched.w ? 'upright' : 'sideways'}`;
    note.hidden = !note.textContent;
  }
  function applyPreview() {
    renderPreviewMode();
    sizePreview();
    requestAnimationFrame(() => { view.layout(); view.setSelected(selectedId()); updateHeader(); });
  }
  /** Follows the screen of the connected device used most recently (from the PC's status). */
  function followDevices(devices) {
    const live = devices.filter((d) => d.online && d.screen).sort((a, b) => b.screen.at - a.screen.at)[0];
    let next = matched;
    if (live) next = { w: live.screen.w, h: live.screen.h, name: live.name, online: true };
    else if (matched) next = { ...matched, online: false };
    if (JSON.stringify(next) === JSON.stringify(matched)) return;
    const reshaped = !matched || !next || next.w !== matched.w || next.h !== matched.h;
    matched = next;
    if (live) writeLS(LS_SCREEN, { w: matched.w, h: matched.h, name: matched.name });
    if (previewMode === 'auto' && reshaped) applyPreview(); else renderPreviewMode();
  }
  function renderPreviewBars() {
    const p = cfg.profile || {};
    const badge = $('#pv-badge');
    const photo = p.show !== false && p.photo ? window.DeckSafe.safeImage(p.photo) : '';
    const name = p.show !== false && p.name ? p.name : '';
    badge.innerHTML = `<span class="dot" aria-hidden="true"></span>${photo ? `<span class="pv-avatar" style="background-image:url('${esc(photo)}')"></span>` : ''}` +
      `<span class="pv-name">${name ? `<b>${esc(name)}</b><span class="suffix">’s PocketDeck</span>` : 'PocketDeck'}</span>`;
    const dots = $('#pv-dots');
    dots.hidden = cfg.pages.length < 2;
    dots.innerHTML = cfg.pages.map((pg, i) => `<button type="button" class="${i === pageIndex ? 'on' : ''}" data-page="${i}" aria-label="Page ${i + 1}: ${esc(pg.name)}"${i === pageIndex ? ' aria-current="true"' : ''}></button>`).join('');
    $$('button', dots).forEach((b) => { b.onclick = () => { pageIndex = Number(b.dataset.page); selected = null; renderAll(); }; });
  }

  // drag to rearrange
  let dragFrom = null;
  const grid = view.grid;
  grid.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.dk-btn');
    if (!el) return;
    dragFrom = Number(el.dataset.index);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  grid.addEventListener('dragover', (e) => {
    const el = e.target.closest('.dk-btn');
    if (!el || dragFrom == null) return;
    e.preventDefault();
    $$('.drag-over', grid).forEach((x) => x !== el && x.classList.remove('drag-over'));
    if (Number(el.dataset.index) !== dragFrom) el.classList.add('drag-over');
  });
  grid.addEventListener('dragleave', (e) => { const el = e.target.closest('.dk-btn'); if (el && !el.contains(e.relatedTarget)) el.classList.remove('drag-over'); });
  grid.addEventListener('drop', (e) => {
    const el = e.target.closest('.dk-btn');
    if (!el || dragFrom == null) return;
    e.preventDefault();
    const to = Number(el.dataset.index);
    if (to !== dragFrom) {
      editCfg(() => {
        const list = page().buttons;
        [list[dragFrom], list[to]] = [list[to], list[dragFrom]];
      });
      select(to);
    }
  });
  grid.addEventListener('dragend', () => { dragFrom = null; $$('.dragging, .drag-over', grid).forEach((x) => x.classList.remove('dragging', 'drag-over')); });

  // ------------------------------------------------------------------ pages
  function renderPages() {
    const nav = $('#pages');
    nav.innerHTML = cfg.pages.map((p, i) => `
      <button class="page-tab ${i === pageIndex ? 'on' : ''}" data-i="${i}" title="Double-click to rename">
        <span class="nm">${esc(p.name)}</span>
        ${cfg.pages.length > 1 ? `<span class="x" data-del="${i}" title="Delete page">${icoHtml('x')}</span>` : ''}
      </button>`).join('') +
      `<button class="page-tab page-add" id="page-add" title="Add a page">${icoHtml('plus')}</button>`;
    $$('.page-tab[data-i]', nav).forEach((el) => {
      el.onclick = (e) => {
        const del = e.target.closest('[data-del]');
        if (del) return deletePage(Number(del.dataset.del));
        if (Number(el.dataset.i) !== pageIndex) { pageIndex = Number(el.dataset.i); selected = null; renderAll(); }
      };
      el.ondblclick = () => renamePage(el, Number(el.dataset.i));
    });
    $('#page-add').onclick = () => {
      editCfg((c) => c.pages.push({ id: uid(), name: `Page ${c.pages.length + 1}`, buttons: Array.from({ length: window.DeckGrids.MAX_KEYS }, () => ({ id: uid(), icon: { kind: 'none' }, size: 'normal', caption: { show: false, text: '' }, color: null, action: { type: 'none' } })) }));
      pageIndex = cfg.pages.length - 1;
      selected = null;
      renderAll();
    };
  }
  function renamePage(el, i) {
    const nm = $('.nm', el);
    nm.innerHTML = `<input value="${esc(cfg.pages[i].name)}" maxlength="24">`;
    const inp = $('input', nm);
    inp.focus();
    inp.select();
    const done = (ok) => {
      if (ok && inp.value.trim()) editCfg((c) => { c.pages[i].name = inp.value.trim(); });
      renderPages();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); };
    inp.onblur = () => done(true);
  }
  function deletePage(i) {
    if (!confirm(`Delete the page “${cfg.pages[i].name}” and its keys?`)) return;
    editCfg((c) => c.pages.splice(i, 1));
    pageIndex = Math.min(pageIndex, cfg.pages.length - 1);
    selected = null;
    renderAll();
  }

  // ------------------------------------------------------------------ selection & inspector
  function select(i) {
    selected = i;
    view.setSelected(selectedId());
    iconTab = btn()?.icon?.kind === 'none' ? 'lucide' : (btn()?.icon?.kind || 'lucide');
    renderInspector();
  }

  function describeKey(b) {
    if (b.caption?.text) return b.caption.text;
    const a = b.action || {};
    if (a.type === 'system') return meta.systemOps.find((o) => o.op === a.op)?.label || 'Windows action';
    if (a.type === 'app' && a.appName) return a.appName;
    if (a.type === 'app' && a.path) return a.path.split(/[\\/]/).pop().replace(/\.(exe|lnk)$/i, '');
    if (a.type === 'url' && a.url) { try { return new URL(/^[a-z]+:/i.test(a.url) ? a.url : 'https://' + a.url).hostname.replace(/^www\./, ''); } catch { return a.url; } }
    if (a.type === 'hotkey' && a.keys) return a.keys;
    if (a.type === 'page') return a.target === 'next' ? 'Next page' : a.target === 'prev' ? 'Previous page' : 'Go to ' + (cfg.pages.find((p) => p.id === a.target)?.name || 'page');
    if (a.type === 'none') return 'Empty key';
    return ACTION_TYPES.find((t) => t.type === a.type)?.label || 'Key';
  }
  function updateHeader() {
    const b = btn();
    if (!b) return;
    const sizeName = { featured: 'Most used', normal: 'Normal size', less: 'Less used' }[DeckView.sizeOf(b)];
    $('#key-label').textContent = window.DeckGrids.isEmptyKey(b) ? 'New key · not shown until you set it up' : `Key ${selected + 1} · ${sizeName}`;
    $('#key-title').textContent = describeKey(b);
  }

  function renderInspector() {
    const b = btn();
    $('#inspector-empty').hidden = !!b;
    $('#inspector-body').hidden = !b;
    if (!b) return;
    updateHeader();

    // action type grid
    const t = b.action?.type || 'none';
    $('#action-types').innerHTML = ACTION_TYPES.map((a) => `<button class="type-btn ${a.type === t ? 'on' : ''}" data-type="${a.type}">${icoHtml(a.icon)}${a.label}</button>`).join('');
    $$('#action-types .type-btn').forEach((el) => {
      el.onclick = () => {
        const type = el.dataset.type;
        if (type === (btn().action?.type || 'none')) return;
        editKey((k) => {
          k.action = { type };
          if (type === 'page') k.action.target = 'next';
          if (type === 'system') { k.action.op = meta.systemOps[0]?.op; decorateForOp(k); }
        }, { inspector: true });
      };
    });
    renderActionFields(b);

    // icon
    $$('#icon-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === iconTab));
    renderIconPane(b);

    // size
    $$('#key-size button').forEach((x) => {
      const on = x.dataset.size === DeckView.sizeOf(b);
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });

    // caption
    $('#caption-show').checked = !!b.caption?.show;
    $('#caption-text').value = b.caption?.text || '';
    $('#caption-text').disabled = !b.caption?.show;
    $$('#caption-pos button').forEach((x) => {
      const on = x.dataset.pos === (b.caption?.pos || 'bottom');
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
      x.disabled = !b.caption?.show;
    });

    // colours
    const sw = $('#swatches');
    const custom = b.color && !KEY_COLORS.includes(b.color);
    sw.innerHTML = `<button class="swatch none ${!b.color ? 'on' : ''}" data-c="" title="Theme default" aria-label="Theme default key colour"></button>` +
      KEY_COLORS.map((c) => `<button class="swatch ${b.color === c ? 'on' : ''}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Key colour ${c}"></button>`).join('') +
      `<label class="swatch custom ${custom ? 'on' : ''}" title="Custom colour" ${custom ? `style="background:${esc(b.color)}"` : ''}><input type="color" value="${esc(b.color || '#6e8bff')}"></label>`;
    $$('button.swatch', sw).forEach((el) => { el.onclick = () => editKey((k) => { k.color = el.dataset.c || null; }, { inspector: true }); });
    $('input[type=color]', sw).oninput = (e) => editKey((k) => { k.color = e.target.value; }, { key: 'color' });
    $('input[type=color]', sw).onchange = () => renderInspector();
    paintIcons($('#inspector'));
  }

  function field(label, html, help) {
    return `<label class="field"><span>${label}</span>${html}${help ? `<p class="help">${help}</p>` : ''}</label>`;
  }

  function renderActionFields(b) {
    const a = b.action || { type: 'none' };
    const box = $('#action-fields');
    let html = '';
    switch (a.type) {
      case 'app':
        html = (host ? `<button class="app-choice" data-do="apps">
            <span class="app-choice-icon">${a.appName && b.icon.kind === 'image' && b.icon.auto ? `<img src="${esc(b.icon.value)}" alt="">` : icoHtml('layout-grid')}</span>
            <span class="app-choice-text"><b>${a.appName ? esc(a.appName) : 'Choose an installed app'}</b><small>${a.appName ? 'Click to choose a different app' : 'Pick from the apps on this PC'}</small></span>
            ${icoHtml('chevron-right')}
          </button>` : '') +
          field(host ? 'Or a program file' : 'Program', `<div class="input-row"><input class="input" data-k="path" value="${esc(a.appName ? '' : a.path)}" placeholder="${a.appName ? 'Using ' + esc(a.appName) : 'C:\\Program Files\\App\\app.exe'}">${host ? '<button class="btn" data-pick="file">Browse…</button>' : ''}</div>`) +
          field('Arguments <small class="muted">(optional)</small>', `<input class="input" data-k="args" value="${esc(a.args)}" placeholder="--profile work">`) +
          (host ? `<button class="btn small" data-do="appicon">${icoHtml('image-plus')}Use the app’s icon</button>` : '');
        break;
      case 'url':
        html = field('Website address', `<input class="input" data-k="url" value="${esc(a.url)}" placeholder="https://example.com">`, 'Opens in your default browser.') +
          `<button class="btn small" data-do="favicon">${icoHtml('image-plus')}Use the site’s icon</button>`;
        break;
      case 'system': {
        const groups = [...new Set(meta.systemOps.map((o) => o.group))];
        html = field('Windows action', `<select class="input" data-k="op">${groups.map((g) => `<optgroup label="${esc(g)}">${meta.systemOps.filter((o) => o.group === g).map((o) => `<option value="${o.op}" ${o.op === a.op ? 'selected' : ''}>${esc(o.label)}${o.confirm ? ' (asks to confirm)' : ''}</option>`).join('')}</optgroup>`).join('')}</select>`,
          meta.systemOps.find((o) => o.op === a.op)?.confirm ? 'On your device, tap twice to confirm this one.' : '');
        break;
      }
      case 'hotkey':
        html = field('Keyboard shortcut', `<div class="input-row"><input class="input recorder" data-k="keys" value="${esc(a.keys)}" placeholder="Ctrl+Shift+M"><button class="btn" data-do="record">Record</button></div>`,
          'Click Record and press the keys, or type them like <b>Ctrl+Alt+T</b> or <b>Win+Shift+S</b>.');
        break;
      case 'text':
        html = field('Text to type', `<textarea class="input" data-k="text" placeholder="Your signature, an email address, a code snippet…">${esc(a.text)}</textarea>`, 'Typed into whatever window is active. New lines press Enter.');
        break;
      case 'open':
        html = field('File or folder', `<div class="input-row"><input class="input" data-k="path" value="${esc(a.path)}" placeholder="C:\\Users\\you\\Documents">${host ? '<button class="btn" data-pick="openfile">File…</button><button class="btn" data-pick="folder">Folder…</button>' : ''}</div>`);
        break;
      case 'command':
        html = field('Command', `<input class="input" data-k="command" value="${esc(a.command)}" placeholder="ipconfig /flushdns">`, 'Runs hidden through the Windows command prompt.');
        break;
      case 'page':
        html = field('Go to', `<select class="input" data-k="target">
          <option value="next" ${a.target === 'next' ? 'selected' : ''}>Next page</option>
          <option value="prev" ${a.target === 'prev' ? 'selected' : ''}>Previous page</option>
          ${cfg.pages.map((p) => `<option value="${esc(p.id)}" ${a.target === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>`, 'Happens on your device instantly. You can also swipe between pages.');
        break;
      default:
        html = '';
    }
    box.innerHTML = html;

    $$('[data-k]', box).forEach((inp) => {
      const k = inp.dataset.k;
      const isSelect = inp.tagName === 'SELECT';
      inp.addEventListener(isSelect ? 'change' : 'input', () => {
        editKey((x) => {
          x.action[k] = inp.value;
          if (x.action.type === 'app' && k === 'path') { delete x.action.appName; delete x.action.iconSrc; }
          if (k === 'op') decorateForOp(x);
        }, { key: isSelect ? null : 'action-' + k, inspector: k === 'op' });
        if (isSelect && k !== 'op') renderActionFields(btn());
      });
    });
    $$('[data-pick]', box).forEach((el) => { el.onclick = () => pick(el.dataset.pick); });
    $$('[data-do]', box).forEach((el) => {
      el.onclick = () => ({ appicon: useAppIcon, favicon: useFavicon, record: recordKeys, apps: openAppPicker })[el.dataset.do](el);
    });
    paintIcons(box);
  }

  function decorateForOp(k) {
    const op = meta.systemOps.find((o) => o.op === k.action.op);
    if (!op) return;
    if (k.icon.kind === 'none' || k.icon.auto) k.icon = { kind: 'lucide', value: op.icon, auto: true };
    if (!k.caption.text || k.caption.auto) k.caption = { show: k.caption.show, text: op.label.replace(/\s*\(.*\)$/, ''), auto: true };
  }

  async function pick(kind) {
    if (!host) return;
    let p = null;
    if (kind === 'file') p = await host.pickFile();
    else if (kind === 'openfile') p = await host.pickFile({ title: 'Choose a file', filters: [{ name: 'All files', extensions: ['*'] }] });
    else if (kind === 'folder') p = await host.pickFolder();
    if (!p) return;
    const name = p.split(/[\\/]/).pop().replace(/\.(exe|lnk|bat|cmd|url)$/i, '');
    editKey((k) => {
      k.action.path = p;
      delete k.action.appName;
      delete k.action.iconSrc;
      if (!k.caption.text || k.caption.auto) k.caption = { show: true, text: name, auto: true };
    }, { inspector: true });
    if (kind === 'file' && btn().icon.kind === 'none') useAppIcon();
  }

  async function useAppIcon() {
    const a = btn()?.action || {};
    if (!a.path) return toast('Choose a program first', true);
    const fromPath = /^shell:AppsFolder\\/i.test(a.path || '') ? a.path.slice(17) : null;
    const data = await host.fileIcon(a.iconSrc ? { ...a.iconSrc, appId: a.iconSrc.appId || fromPath } : a.path);
    if (!data) return toast('That program has no icon to use', true);
    iconTab = 'image';
    editKey((k) => { k.icon = { kind: 'image', value: data, auto: true }; }, { inspector: true });
  }

  /**
   * App icons used to be saved at 128 px and looked soft on big keys. Fetch them again at full size (256 px) and
   * swap them in when the new picture is bigger. Only app icons PocketDeck fetched itself are touched.
   */
  async function upgradeAppIcons() {
    if (!host || !host.fileIcon) return;
    const width = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth); im.onerror = () => res(0); im.src = src; });
    let changed = 0;
    for (const p of cfg.pages) {
      for (const k of p.buttons) {
        const a = k.action || {};
        if (k.icon?.kind !== 'image' || !k.icon.auto || a.type !== 'app' || !a.path) continue;
        const old = await width(k.icon.value);
        if (old >= 256) continue;
        const fromPath = /^shell:AppsFolder\\/i.test(a.path) ? a.path.slice(17) : null;
        const data = await host.fileIcon(a.iconSrc ? { ...a.iconSrc, appId: a.iconSrc.appId || fromPath } : a.path).catch(() => null);
        if (data && (await width(data)) > old) { k.icon = { ...k.icon, value: data }; changed++; }
      }
    }
    if (changed) { view.setDeck(cfg); view.setPage(pageIndex); save(); }
  }

  // ------------------------------------------------------------------ installed-app picker
  let appList = null;
  const appIcons = new Map();
  let appIconObserver = null;

  function appIcon(app) {
    if (!appIcons.has(app.appId)) {
      appIcons.set(app.appId, host.fileIcon({ iconSource: app.iconSource, logo: app.logo, appId: app.appId }).catch(() => null));
    }
    return appIcons.get(app.appId);
  }

  async function openAppPicker() {
    const dlg = $('#apps-dialog');
    $('#apps-search').value = '';
    dlg.showModal();
    $('#apps-search').focus();
    if (!appList) await loadApps(false);
    else renderAppList();
  }

  async function loadApps(refresh) {
    $('#apps-list').innerHTML = '<div class="apps-msg"><span class="mini-spinner"></span>Finding the apps on this PC…</div>';
    try {
      appList = await host.listApps(refresh);
      if (refresh) appIcons.clear();
      renderAppList();
    } catch (e) {
      $('#apps-list').innerHTML = `<div class="apps-msg">${esc(e.message || 'Could not list apps')}</div>`;
    }
  }

  function renderAppList() {
    const q = $('#apps-search').value.trim().toLowerCase();
    const list = (appList || []).filter((a) => !q || a.name.toLowerCase().includes(q));
    const current = btn()?.action?.appName;
    const box = $('#apps-list');
    if (!appList || !appList.length) { box.innerHTML = '<div class="apps-msg">No apps found. Use “Or a program file” to browse for one instead.</div>'; return; }
    if (!list.length) { box.innerHTML = `<div class="apps-msg">No apps match “${esc(q)}”.</div>`; return; }
    box.innerHTML = list.map((a, i) => `<button class="app-row ${a.name === current ? 'on' : ''}" data-i="${appList.indexOf(a)}">
        <span class="app-row-icon"></span><span class="app-row-name">${esc(a.name)}</span>${a.kind === 'store' ? '<span class="tag">Store</span>' : ''}</button>`).join('');
    if (appIconObserver) appIconObserver.disconnect();
    appIconObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        appIconObserver.unobserve(en.target);
        const app = appList[Number(en.target.dataset.i)];
        const slot = $('.app-row-icon', en.target);
        appIcon(app).then((url) => { slot.innerHTML = url && /^data:image\//.test(url) ? `<img src="${esc(url)}" alt="">` : icoHtml('app-window'); });
      }
    }, { root: box, rootMargin: '120px' });
    $$('.app-row', box).forEach((row) => {
      appIconObserver.observe(row);
      row.onclick = () => chooseApp(appList[Number(row.dataset.i)]);
    });
  }

  async function chooseApp(app) {
    $('#apps-dialog').close();
    editKey((k) => {
      k.action = { type: 'app', path: app.path, appName: app.name, args: k.action.args || '', iconSrc: { iconSource: app.iconSource, logo: app.logo, appId: app.appId } };
      k.caption = { show: k.caption.show || k.icon.kind === 'none', text: app.name.slice(0, 24), auto: true };
    }, { inspector: true, key: 'choose-app' });
    const b = btn();
    {
      const url = await appIcon(app);
      if (url && btn() === b) {
        iconTab = 'image';
        editKey((k) => { k.icon = { kind: 'image', value: url, auto: true }; }, { inspector: true, key: 'choose-app' });
      }
    }
  }

  $('#apps-search').addEventListener('input', renderAppList);
  $('#apps-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#apps-list .app-row')?.click(); }
  });
  $('#apps-refresh').onclick = () => loadApps(true);

  async function useFavicon(el) {
    const url = btn()?.action?.url;
    if (!url) return toast('Enter a website address first', true);
    el.disabled = true;
    try {
      const { dataUrl } = await api('/api/favicon?url=' + encodeURIComponent(url));
      iconTab = 'image';
      editKey((k) => { k.icon = { kind: 'image', value: dataUrl }; }, { inspector: true });
    } catch (e) { toast(e.message, true); }
    finally { el.disabled = false; }
  }

  function recordKeys(el) {
    const inp = $('#action-fields .recorder');
    inp.classList.add('recording');
    inp.value = '';
    inp.placeholder = 'Press your shortcut…';
    el.textContent = 'Listening…';
    const names = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', Delete: 'Delete', Backspace: 'Backspace', Enter: 'Enter', Tab: 'Tab', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert', PrintScreen: 'PrintScreen' };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return;
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Win');
      let key = names[e.key] || (e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const combo = [...mods, key].join('+');
      window.removeEventListener('keydown', onKey, true);
      inp.classList.remove('recording');
      editKey((k) => { k.action.keys = combo; }, { inspector: true });
    };
    window.addEventListener('keydown', onKey, true);
  }

  function renderIconPane(b) {
    const pane = $('#icon-pane');
    const ic = b.icon || { kind: 'none' };
    if (iconTab === 'lucide') {
      const q = iconQuery.trim().toLowerCase();
      const all = q ? meta.icons.filter((n) => n.includes(q.replace(/\s+/g, '-'))) : [...POPULAR.filter((n) => meta.icons.includes(n)), ...meta.icons.filter((n) => !POPULAR.includes(n))];
      const shown = all.slice(0, 210);
      pane.innerHTML = `<input class="input icon-search" placeholder="Search ${meta.icons.length.toLocaleString()} icons (music, folder, mic…)" value="${esc(iconQuery)}">
        <div class="icon-grid">${shown.map((n) => `<button class="icon-cell ${ic.kind === 'lucide' && ic.value === n ? 'on' : ''}" data-n="${n}" title="${n}">${icoHtml(n)}</button>`).join('')}
        ${all.length > shown.length ? `<div class="icon-more">${(all.length - shown.length).toLocaleString()} more. Search to narrow down.</div>` : ''}
        ${!all.length ? '<div class="icon-more">No icons match.</div>' : ''}</div>`;
      const s = $('.icon-search', pane);
      s.oninput = () => { iconQuery = s.value; const pos = s.selectionStart; renderIconPane(btn()); const s2 = $('.icon-search', pane); s2.focus(); s2.setSelectionRange(pos, pos); };
      $$('.icon-cell', pane).forEach((el) => { el.onclick = () => editKey((k) => { k.icon = { kind: 'lucide', value: el.dataset.n }; }, { inspector: true }); });
    } else if (iconTab === 'emoji') {
      pane.innerHTML = `<div class="icon-grid">${EMOJI.map((e) => `<button class="icon-cell emoji ${ic.kind === 'emoji' && ic.value === e ? 'on' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
        <div class="input-row" style="margin-top:8px"><input class="input" id="emoji-custom" maxlength="8" placeholder="Or type/paste any emoji (Win + .)"><button class="btn" id="emoji-use">Use</button></div>`;
      $$('.icon-cell', pane).forEach((el) => { el.onclick = () => editKey((k) => { k.icon = { kind: 'emoji', value: el.dataset.e }; }, { inspector: true }); });
      $('#emoji-use').onclick = () => { const v = $('#emoji-custom').value.trim(); if (v) editKey((k) => { k.icon = { kind: 'emoji', value: v }; }, { inspector: true }); };
    } else if (iconTab === 'image') {
      pane.innerHTML = `<div class="image-pane">
        <div class="image-preview">${ic.kind === 'image' ? `<img src="${esc(ic.value)}" alt="">` : 'No image yet'}</div>
        <div class="image-actions">
          <button class="btn small" id="img-upload">${icoHtml('upload')}Choose image…</button>
          ${b.action?.type === 'app' && host ? `<button class="btn small" id="img-app">${icoHtml('app-window')}App icon</button>` : b.action?.type === 'url' ? `<button class="btn small" id="img-site">${icoHtml('globe')}Site icon</button>` : ''}
        </div>
        <input type="file" id="img-file" accept="image/*" hidden>
      </div>`;
      $('#img-upload').onclick = async () => {
        if (host) {
          const data = await host.pickImage();
          if (data) editKey((k) => { k.icon = { kind: 'image', value: data }; }, { inspector: true });
        } else $('#img-file').click();
      };
      $('#img-file').onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => resizeImage(r.result).then((data) => editKey((k) => { k.icon = { kind: 'image', value: data }; }, { inspector: true }));
        r.readAsDataURL(f);
      };
      if ($('#img-app')) $('#img-app').onclick = useAppIcon;
      if ($('#img-site')) $('#img-site').onclick = (e) => useFavicon(e.currentTarget);
    } else {
      pane.innerHTML = `<p class="help">This key shows ${b.caption?.show && b.caption?.text ? 'only its caption' : 'nothing'}.</p>`;
    }
    paintIcons(pane);
  }

  function resizeImage(dataUrl, max = 256) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // static inspector controls
  $$('#icon-tabs button').forEach((el) => {
    el.onclick = () => {
      iconTab = el.dataset.tab;
      if (iconTab === 'none') editKey((k) => { k.icon = { kind: 'none' }; }, { inspector: true });
      else renderInspector();
    };
  });
  $('#caption-show').onchange = (e) => {
    editKey((k) => {
      k.caption = { ...k.caption, show: e.target.checked };
      if (e.target.checked && !k.caption.text) k.caption.text = describeKey({ ...k, caption: {} }).slice(0, 24);
    }, { inspector: true });
    if (e.target.checked) $('#caption-text').focus();
  };
  $('#caption-text').oninput = (e) => editKey((k) => { k.caption = { show: true, text: e.target.value, pos: k.caption?.pos || 'bottom' }; }, { key: 'caption' });
  $$('#key-size button').forEach((x) => { x.onclick = () => editKey((k) => { k.size = x.dataset.size; }, { inspector: true }); });
  $$('#caption-pos button').forEach((x) => { x.onclick = () => editKey((k) => { k.caption = { ...k.caption, pos: x.dataset.pos }; }, { inspector: true }); });
  $('#key-clear').onclick = () => editKey((k) => {
    Object.assign(k, { icon: { kind: 'none' }, size: 'normal', caption: { show: false, text: '' }, color: null, action: { type: 'none' } });
  }, { inspector: true });
  $('#key-test').onclick = async () => {
    const b = btn();
    if (!b) return;
    if (b.action.type === 'page') return toast('Page keys switch pages on your device');
    if (b.action.type === 'none') return toast('This key has no action yet');
    if (meta.systemOps.find((o) => o.op === b.action.op)?.confirm && !confirm('This will run on this PC right now. Continue?')) return;
    try { await api('/api/test', { method: 'POST', body: { action: b.action } }); toast(meta.platform === 'win32' ? 'Done' : 'Sent (actions only run on Windows)'); }
    catch (e) { toast(e.message, true); }
  };

  // ------------------------------------------------------------------ preview shape
  $$('#preview-orient button').forEach((b) => {
    b.onclick = () => {
      previewMode = b.dataset.o;
      writeLS(LS_MODE, previewMode);
      applyPreview();
    };
  });
  renderPreviewMode();

  // ------------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); restore(redoStack, undoStack); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && btn()) { e.preventDefault(); $('#key-clear').click(); }
    else if (e.key === 'Escape' && !typing) { selected = null; view.setSelected(null); renderInspector(); }
    else if (!typing && selected != null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      // Move to the previous or next key shown on the page.
      const shown = view.visibleKeys().map(([, i]) => i);
      const at = shown.indexOf(selected);
      const n = shown[at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)];
      if (n != null) select(n);
    }
  });

  // ------------------------------------------------------------------ top bar
  $('#theme-toggle').onclick = () => editCfg((c) => {
    c.theme = DARK.has(c.theme) ? (c.theme === 'graphite' ? 'linen' : 'porcelain') : (c.theme === 'linen' ? 'graphite' : 'obsidian');
  });

  // ------------------------------------------------------------------ connect dialog
  function renderConnect() {
    if (!status) return;
    $('#qr').src = status.qr || '';
    $('#pin').textContent = status.pin;
    pinExpiresAt = Date.now() + (status.pinExpiresIn || 0);
    paintPinTimer();
    $('#addresses').innerHTML = status.addresses.length
      ? status.addresses.map((a) => `<div class="addr"><span>${esc(a.ip)}:${status.port}</span><small>${esc(a.name)}</small></div>`).join('')
      : '<p class="muted small">No network found. Connect this PC to Wi‑Fi or Ethernet.</p>';
    $('#device-list').innerHTML = status.devices.length
      ? status.devices
          .slice()
          .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen))
          .map((d) => {
            const when = d.online ? 'Connected now' : 'Last seen ' + new Date(d.lastSeen).toLocaleString();
            const note = d.oneTime ? ' · one‑time connection' : !d.hasKey ? ' · needs a new PIN to connect again' : '';
            return `<div class="device-row"><span class="dot ${d.online ? 'on' : ''}"></span>
              <div class="meta"><b>${esc(d.name)}</b><small>${esc(when + note)}</small></div>
              <label class="trust" title="Trusted devices reconnect on their own, without a PIN"><span>Trusted</span><span class="switch"><input type="checkbox" data-trust="${esc(d.id)}" ${d.trusted ? 'checked' : ''} aria-label="Trust ${esc(d.name)}"><span></span></span></label>
              <button class="btn small" data-remove="${esc(d.id)}" aria-label="Disconnect and forget ${esc(d.name)}">Disconnect and forget</button></div>`;
          }).join('')
      : '<p class="muted small">No devices paired yet.</p>';
    $$('[data-trust]').forEach((el) => {
      el.onchange = async () => {
        await api('/api/devices/' + el.dataset.trust, { method: 'POST', body: { trusted: el.checked } });
        toast(el.checked ? 'Trusted: this device can reconnect without a PIN' : 'Not trusted: this device will need a new PIN next time');
        pollStatus();
      };
    });
    $$('[data-remove]').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Disconnect and forget this device? It will need a new PIN to connect again, and the current PIN changes now.')) return;
        await api('/api/devices/' + el.dataset.remove, { method: 'DELETE' });
        toast('Device forgotten. The PIN has changed.');
        pollStatus();
      };
    });
  }
  // Devices can only pair while this window is open (it opens a 5-minute pairing window on the PC).
  $('#open-connect').onclick = async () => {
    try { await api('/api/pairing/open', { method: 'POST' }); } catch {}
    renderConnect();
    $('#connect-dialog').showModal();
  };
  $('#connect-dialog').addEventListener('close', () => { api('/api/pairing/close', { method: 'POST' }).catch(() => {}); });
  $('#devices-pill').onclick = () => $('#open-connect').click();
  let pinExpiresAt = 0;
  function paintPinTimer() {
    const s = Math.max(0, Math.ceil((pinExpiresAt - Date.now()) / 1000));
    $('#pin-timer').textContent = s ? `New PIN and code in ${s} s` : 'Making a new PIN…';
  }
  setInterval(() => { if ($('#connect-dialog').open) { paintPinTimer(); if (Date.now() > pinExpiresAt + 400) pollStatus(); } }, 1000);
  $('#new-pin').onclick = async () => { await api('/api/pin/regenerate', { method: 'POST' }); pollStatus(); toast('New PIN created'); };

  async function pollStatus() {
    try {
      status = await api('/api/status');
      const online = status.devices.filter((d) => d.online);
      const pill = $('#devices-pill');
      pill.classList.toggle('online', online.length > 0);
      $('#devices-text').textContent = online.length === 0 ? 'No device connected' : online.length === 1 ? online[0].name : `${online.length} devices connected`;
      info.setWeather(status.weather);
      followDevices(status.devices);
      if ($('#connect-dialog').open) {
        if (!status.pairingOpen) api('/api/pairing/open', { method: 'POST' }).catch(() => {});
        renderConnect();
      }
    } catch { /* server restarting */ }
  }

  // ------------------------------------------------------------------ settings dialog
  function renderSettings() {
    $('#theme-cards').innerHTML = THEMES.map((t) => `<button class="theme-card ${cfg.theme === t.id ? 'on' : ''}" data-theme="${t.id}" data-t="${t.id}">
      <span class="sw"><i></i><i></i><i style="background:var(--accent)"></i><i></i></span><span class="nm">${t.name}<small>${t.note}</small></span></button>`).join('');
    $$('#theme-cards .theme-card').forEach((el) => { el.onclick = () => { editCfg((c) => { c.theme = el.dataset.t; }); renderSettings(); }; });
    $('#accent-swatches').innerHTML = ACCENTS.map((c) => `<button class="swatch ${cfg.accent === c ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Accent colour ${c}"></button>`).join('') +
      `<label class="swatch custom ${!ACCENTS.includes(cfg.accent) ? 'on' : ''}" title="Custom"><input type="color" value="${esc(cfg.accent)}"></label>`;
    $$('#accent-swatches button').forEach((el) => { el.onclick = () => { editCfg((c) => { c.accent = el.dataset.c; }); renderSettings(); }; });
    $('#accent-swatches input').oninput = (e) => editCfg((c) => { c.accent = e.target.value; }, { key: 'accent' });
    $('#set-24h').checked = !!cfg.clock.hour24;
    $('#set-seconds').checked = !!cfg.clock.showSeconds;
    $('#set-date').checked = cfg.clock.showDate !== false;
    $('#set-weather').checked = !!cfg.weather.enabled;
    $$('#set-unit button').forEach((b) => b.classList.toggle('on', b.dataset.unit === cfg.weather.unit));
    $('#loc-current').textContent = cfg.weather.location ? '· ' + cfg.weather.location.name + (cfg.weather.location.region ? ', ' + cfg.weather.location.region : '') : '· not set';
    $('#set-feedback').value = cfg.feedback || 'vibrate';
    $$('#set-clock-style button').forEach((b) => { const on = b.dataset.style === (cfg.clock.style || 'digital'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#set-icon-colours button').forEach((b) => { const on = b.dataset.c === (cfg.iconColours || 'original'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    renderBackgrounds();
    $('#about-version').textContent = ABOUT.versionLabel(meta.version);
    renderProfile();
    $('#login-row').hidden = !host;
    $('#login-store-row').hidden = true;
    if (host) host.loginItem().then((v) => {
      // null = Store build: Windows' Startup apps settings decide it.
      if (v === null) { $('#login-row').hidden = true; $('#login-store-row').hidden = false; return; }
      $('#set-login').checked = v;
    });
  }
  function openSettings(focus) {
    renderSettings();
    $('#settings-dialog').showModal();
    if (focus === 'clock') $('#set-24h').closest('.settings-list').scrollIntoView({ block: 'center' });
    if (focus === 'weather') $('#set-weather').closest('.settings-list').scrollIntoView({ block: 'center' });
  }
  $('#open-settings').onclick = () => openSettings();
  $('#set-24h').onchange = (e) => editCfg((c) => { c.clock.hour24 = e.target.checked; });
  $('#set-seconds').onchange = (e) => editCfg((c) => { c.clock.showSeconds = e.target.checked; });
  $('#set-date').onchange = (e) => editCfg((c) => { c.clock.showDate = e.target.checked; });
  $('#set-weather').onchange = (e) => { editCfg((c) => { c.weather.enabled = e.target.checked; }); setTimeout(pollStatus, 1500); };
  $('#set-feedback').onchange = (e) => editCfg((c) => { c.feedback = e.target.value; });
  $$('#set-icon-colours button').forEach((b) => { b.onclick = () => { editCfg((c) => { c.iconColours = b.dataset.c; }); renderSettings(); }; });
  $$('#set-clock-style button').forEach((b) => { b.onclick = () => { editCfg((c) => { c.clock.style = b.dataset.style; }); renderSettings(); }; });

  // ------------------------------------------------------------------ deck background (photo behind the keys)
  let recentBgs = [];
  async function renderBackgrounds(reload = false) {
    if (reload || !renderBackgrounds.loaded) {
      try { recentBgs = (await api('/api/backgrounds')).list || []; renderBackgrounds.loaded = true; } catch {}
    }
    const cur = cfg.background?.image || null;
    const box = $('#bg-choices');
    box.innerHTML = `<button class="bg-choice none ${cur ? '' : 'on'}" data-bg="" aria-pressed="${!cur}">None</button>` +
      recentBgs.map((b, i) => `<span class="bg-wrap"><button class="bg-choice ${cur === b.image ? 'on' : ''}" data-bg="${esc(b.id)}" aria-pressed="${cur === b.image}" aria-label="Recent background ${i + 1}" style="background-image:url('${esc(window.DeckSafe.safeImage(b.image))}')"></button>` +
        `<button class="bg-remove" data-bg-remove="${esc(b.id)}" aria-label="Remove recent background ${i + 1}" title="Remove from this list">×</button></span>`).join('') +
      `<button class="bg-choice add" id="bg-add">${icoHtml('image-plus')}<span>Add photo</span></button>`;
    $$('[data-bg]', box).forEach((el) => {
      el.onclick = () => {
        const b = recentBgs.find((x) => x.id === el.dataset.bg);
        editCfg((c) => { c.background = { ...c.background, image: b ? b.image : null }; });
        renderBackgrounds();
      };
    });
    $$('[data-bg-remove]', box).forEach((el) => {
      el.onclick = async () => { recentBgs = (await api('/api/backgrounds/' + el.dataset.bgRemove, { method: 'DELETE' })).list || []; renderBackgrounds(); };
    });
    $('#bg-add').onclick = addBackground;
    $('#bg-overlay-row').hidden = !cur;
    $('#bg-overlay').value = cfg.background?.overlay ?? 0.6;
    $('#bg-overlay-out').textContent = Math.round((cfg.background?.overlay ?? 0.6) * 100) + '%';
    paintIcons(box);
  }
  $('#bg-overlay').oninput = (e) => {
    editCfg((c) => { c.background = { ...c.background, overlay: Number(e.target.value) }; }, { key: 'bg-overlay' });
    $('#bg-overlay-out').textContent = Math.round(Number(e.target.value) * 100) + '%';
  };
  async function addBackground() {
    if (host && host.pickImage) { const data = await host.pickImage({ large: true }); if (data) openCropper(data); }
    else $('#bg-file').click();
  }
  $('#bg-file').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => openCropper(r.result);
    r.readAsDataURL(f);
  };
  // Cropper: the frame has the deck's shape; the photo can be moved and zoomed inside it.
  const crop = { img: null, zoom: 1, x: 0, y: 0, base: 1, overlay: 0.6 };
  const CROP_W = 1600;
  const CROP_H = 1000;
  function cropLayout() {
    const f = $('#crop-frame');
    const fw = f.clientWidth;
    const fh = f.clientHeight;
    const { img } = crop;
    crop.base = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
    const s = crop.base * crop.zoom;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    crop.x = Math.min(0, Math.max(fw - w, crop.x));
    crop.y = Math.min(0, Math.max(fh - h, crop.y));
    const el = $('#crop-img');
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = `translate(${crop.x}px, ${crop.y}px)`;
    $('#crop-overlay').style.opacity = String(crop.overlay);
    $('#crop-zoom-out').textContent = Math.round(crop.zoom * 100) + '%';
    $('#crop-overlay-out').textContent = Math.round(crop.overlay * 100) + '%';
  }
  function setZoom(z, cx, cy) {
    const f = $('#crop-frame');
    cx = cx ?? f.clientWidth / 2;
    cy = cy ?? f.clientHeight / 2;
    const old = crop.zoom;
    crop.zoom = Math.min(4, Math.max(1, z));
    const k = crop.zoom / old;
    crop.x = cx - (cx - crop.x) * k;
    crop.y = cy - (cy - crop.y) * k;
    $('#crop-zoom').value = crop.zoom;
    cropLayout();
  }
  // mode 'background' (deck shape, theme colour over it) or 'profile' (square, shown as a circle).
  function openCropper(dataUrl, mode = 'background') {
    const img = new Image();
    img.onload = () => {
      crop.mode = mode;
      const profile = mode === 'profile';
      $('#bg-dialog').classList.toggle('is-profile', profile);
      $('#bg-dialog-h').textContent = profile ? 'Adjust your photo' : 'Adjust the background';
      $('#crop-help').textContent = profile
        ? 'Drag the photo to move it, and use the slider or mouse wheel to zoom. The circle shows what appears on the deck.'
        : 'Drag the photo to move it, and use the slider or mouse wheel to zoom. The theme colour sits over the photo so the keys stay easy to read.';
      $('#crop-overlay-row').hidden = profile;
      $('#crop-keys').hidden = profile;
      $('#crop-overlay').hidden = profile;
      $('#crop-apply').textContent = profile ? 'Use this photo' : 'Use this background';
      crop.img = img;
      crop.zoom = 1;
      crop.overlay = cfg.background?.overlay ?? 0.6;
      $('#crop-img').src = dataUrl;
      $('#crop-zoom').value = 1;
      $('#crop-overlay-range').value = crop.overlay;
      $('#bg-dialog').showModal();
      requestAnimationFrame(() => {
        const f = $('#crop-frame');
        crop.base = Math.max(f.clientWidth / img.naturalWidth, f.clientHeight / img.naturalHeight);
        crop.x = (f.clientWidth - img.naturalWidth * crop.base) / 2;
        crop.y = (f.clientHeight - img.naturalHeight * crop.base) / 2;
        cropLayout();
      });
    };
    img.onerror = () => toast('That image could not be used', true);
    img.src = dataUrl;
  }
  let dragPt = null;
  $('#crop-frame').addEventListener('pointerdown', (e) => { dragPt = { x: e.clientX - crop.x, y: e.clientY - crop.y }; e.currentTarget.setPointerCapture(e.pointerId); });
  $('#crop-frame').addEventListener('pointermove', (e) => { if (!dragPt) return; crop.x = e.clientX - dragPt.x; crop.y = e.clientY - dragPt.y; cropLayout(); });
  $('#crop-frame').addEventListener('pointerup', () => { dragPt = null; });
  $('#crop-frame').addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setZoom(crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  $('#crop-frame').addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 40 : 10;
    const moves = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    if (moves[e.key]) { e.preventDefault(); crop.x += moves[e.key][0]; crop.y += moves[e.key][1]; cropLayout(); }
    if (e.key === '+' || e.key === '=') setZoom(crop.zoom * 1.1);
    if (e.key === '-') setZoom(crop.zoom / 1.1);
  });
  $('#crop-zoom').oninput = (e) => setZoom(Number(e.target.value));
  $('#crop-overlay-range').oninput = (e) => { crop.overlay = Number(e.target.value); cropLayout(); };
  $('#crop-cancel').onclick = () => $('#bg-dialog').close();
  $('#crop-apply').onclick = async () => {
    const f = $('#crop-frame');
    const s = crop.base * crop.zoom;
    if (crop.mode === 'profile') {
      const c = document.createElement('canvas');
      c.width = c.height = 320;
      c.getContext('2d').drawImage(crop.img, -crop.x / s, -crop.y / s, f.clientWidth / s, f.clientHeight / s, 0, 0, 320, 320);
      $('#bg-dialog').close();
      setPhoto(c.toDataURL('image/jpeg', 0.88));
      return;
    }
    const c = document.createElement('canvas');
    c.width = CROP_W;
    c.height = CROP_H;
    c.getContext('2d').drawImage(crop.img, -crop.x / s, -crop.y / s, f.clientWidth / s, f.clientHeight / s, 0, 0, CROP_W, CROP_H);
    let q = 0.85;
    let data = c.toDataURL('image/jpeg', q);
    while (data.length > 1.9 * 1024 * 1024 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
    try {
      recentBgs = (await api('/api/backgrounds', { method: 'POST', body: { image: data } })).list || [];
      editCfg((cc) => { cc.background = { image: data, overlay: crop.overlay }; });
      $('#bg-dialog').close();
      renderBackgrounds();
      toast('Background applied');
    } catch (err) { toast(err.message, true); }
  };

  // ------------------------------------------------------------------ updates and rating
  $('#check-updates').onclick = async () => {
    const st = $('#update-status');
    st.textContent = 'Checking…';
    const r = await ABOUT.checkForUpdate('windows', meta.version);
    st.textContent = r.message;
    if (r.update && r.url && /^https:\/\//.test(r.url)) {
      const a = document.createElement('a');
      a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'link-btn'; a.textContent = 'Open the download page';
      st.append(' ', a);
    }
  };
  let rateDone = null;
  function askRating(done) {
    rateDone = done || null;
    $$('#rate-dialog .stars button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
    if (!$('#rate-dialog').open) $('#rate-dialog').showModal();
  }
  function finishRating(state) {
    if (state && host && host.saveRating) host.saveRating(state);
    $('#rate-dialog').close();
  }
  $('#rate-dialog').addEventListener('close', () => { const f = rateDone; rateDone = null; if (f) f(); });
  $$('#rate-dialog .stars button').forEach((b) => {
    b.onclick = () => {
      const stars = Number(b.dataset.stars);
      $$('#rate-dialog .stars button').forEach((x) => { x.classList.toggle('on', Number(x.dataset.stars) <= stars); x.setAttribute('aria-checked', String(Number(x.dataset.stars) === stars)); });
      ABOUT.sendRating('windows', meta.version, stars);
      toast('Thank you for rating PocketDeck');
      setTimeout(() => finishRating({ stars }), 450);
    };
  });
  $('#rate-later').onclick = () => finishRating(null);
  $('#rate-never').onclick = () => finishRating({ never: true });
  $('#about-rate').onclick = () => askRating();
  if (host && host.onAskRating) host.onAskRating(() => askRating(() => host.ratingDone()));

  // ------------------------------------------------------------------ profile (name and photo shown on the deck)
  function renderProfile() {
    const p = cfg.profile || {};
    const av = $('#profile-photo');
    av.classList.toggle('has-photo', !!(p.photo && window.DeckSafe && window.DeckSafe.safeImage(p.photo)));
    const photo = p.photo && window.DeckSafe ? window.DeckSafe.safeImage(p.photo) : '';
    av.style.backgroundImage = photo ? `url("${photo}")` : '';
    av.innerHTML = p.photo ? '' : icoHtml('camera');
    if (document.activeElement !== $('#profile-name')) $('#profile-name').value = p.name || '';
    $('#profile-show').checked = p.show !== false;
    $('#profile-photo-remove').hidden = !p.photo;
    $('#profile-photo-adjust').hidden = !p.photo;
    $('#profile-preview').innerHTML = p.name ? `Shown on the deck as <b>${esc(p.name)}</b>’s PocketDeck` : 'Add your name to show “<b>Your name</b>’s PocketDeck” on the deck.';
    paintIcons($('.profile-card'));
  }
  async function pickProfilePhoto() {
    let data = null;
    if (host && host.pickImage) data = await host.pickImage({ large: true });
    else { $('#profile-file').click(); return; }
    if (data) openCropper(data, 'profile');
  }
  function setPhoto(data) {
    if (!data) return toast('That image could not be used', true);
    editCfg((c) => { c.profile = { ...c.profile, photo: data }; });
    renderProfile();
  }
  $('#profile-file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => openCropper(r.result, 'profile');
    r.readAsDataURL(f);
    e.target.value = '';
  };
  $('#profile-photo').onclick = pickProfilePhoto;
  $('#profile-photo-pick').onclick = pickProfilePhoto;
  $('#profile-photo-adjust').onclick = () => { const p = cfg.profile?.photo; if (p) openCropper(p, 'profile'); };
  $('#profile-photo-remove').onclick = () => { editCfg((c) => { c.profile = { ...c.profile, photo: null }; }); renderProfile(); };
  $('#profile-name').oninput = (e) => { editCfg((c) => { c.profile = { ...c.profile, name: e.target.value.slice(0, 30) }; }, { key: 'profile-name' }); renderProfile(); };
  $('#profile-show').onchange = (e) => editCfg((c) => { c.profile = { ...c.profile, show: e.target.checked }; });

  // ------------------------------------------------------------------ privacy & about
  const ABOUT = window.PocketDeckAbout;
  $('#privacy-text').textContent = ABOUT.privacy;
  $('#about-blurb').textContent = ABOUT.blurb + ' ' + ABOUT.momo;
  $('#about-momo').href = ABOUT.momoUrl;
  $('#about-feedback').href = ABOUT.feedbackUrl;
  $('#about-rate').hidden = false;
  $('#log-open').hidden = !host || !host.openLogs;
  $('#log-open').onclick = () => host.openLogs();
  $('#log-view').onclick = async () => {
    const pre = $('#log-text');
    if (!pre.hidden) { pre.hidden = true; $('#log-view').textContent = 'View activity log'; return; }
    const { text } = await api('/api/log');
    pre.textContent = text || 'The log is empty.';
    pre.hidden = false;
    pre.scrollTop = pre.scrollHeight;
    $('#log-view').textContent = 'Hide activity log';
  };
  $('#log-clear').onclick = async () => {
    if (!confirm('Clear the activity log?')) return;
    await api('/api/log', { method: 'DELETE' });
    $('#log-text').textContent = 'The log is empty.';
    toast('Activity log cleared');
  };
  $('#set-login').onchange = (e) => host && host.loginItem(e.target.checked);
  $('#login-store').onclick = () => host && host.loginItem(true);
  $$('#set-unit button').forEach((b) => { b.onclick = () => { editCfg((c) => { c.weather.unit = b.dataset.unit; }); renderSettings(); setTimeout(pollStatus, 1500); }; });
  let locTimer;
  $('#loc-input').oninput = (e) => {
    clearTimeout(locTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#loc-results').innerHTML = ''; return; }
    locTimer = setTimeout(async () => {
      try {
        const { results } = await api('/api/geocode?q=' + encodeURIComponent(q));
        $('#loc-results').innerHTML = results.length
          ? results.map((r, i) => `<button data-i="${i}">${esc(r.name)}<small>${esc(r.region)}</small></button>`).join('')
          : '<p class="muted small">No places found.</p>';
        $$('#loc-results button').forEach((el) => {
          el.onclick = () => {
            editCfg((c) => { c.weather.location = results[Number(el.dataset.i)]; c.weather.enabled = true; });
            $('#loc-results').innerHTML = '';
            $('#loc-input').value = '';
            renderSettings();
            toast('Location saved');
            setTimeout(pollStatus, 1500);
          };
        });
      } catch (err) { $('#loc-results').innerHTML = `<p class="muted small">${esc(err.message)}</p>`; }
    }, 350);
  };

  // close dialogs on backdrop click
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // ------------------------------------------------------------------ boot
  function renderAll() {
    renderPages();
    view.setDeck(cfg);
    view.setPage(pageIndex);
    view.setSelected(selectedId());
    refreshBars();
    renderInspector();
    paintIcons();
  }

  async function boot() {
    [cfg, meta] = await Promise.all([api('/api/config'), api('/api/meta')]);
    applyTheme();
    renderAll();
    pollStatus();
    // Every 2.5 s, and every second while a device is connected, so the preview follows it quickly when it turns.
    (function tick() { setTimeout(() => { pollStatus().finally(tick); }, status && status.devices.some((d) => d.online) ? 1000 : 2500); })();
    upgradeAppIcons().catch(() => {});
    window.__editor = { select, openSettings, get cfg() { return cfg; } };
  }
  paintIcons();
  boot().catch((e) => toast('Could not load PocketDeck: ' + e.message, true));
})();
