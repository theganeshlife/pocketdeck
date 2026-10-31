/* PocketDeck — shared deck renderer (phone app + PC editor preview). */
(function () {
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  // Icons arrive from the PC as SVG text: keep only drawing elements, drop scripts, event handlers and links.
  const SVG_OK = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'title']);
  const svgCache = new Map();
  function safeSvg(text) {
    if (!text) return '';
    if (svgCache.has(text)) return svgCache.get(text);
    let out = '';
    try {
      const doc = new DOMParser().parseFromString(String(text), 'image/svg+xml');
      const root = doc.documentElement;
      if (root && root.nodeName.toLowerCase() === 'svg') {
        const walk = (el) => {
          for (const child of [...el.children]) {
            if (!SVG_OK.has(child.nodeName.toLowerCase())) { child.remove(); continue; }
            walk(child);
          }
          for (const a of [...el.attributes]) {
            const n = a.name.toLowerCase();
            if (n.startsWith('on') || n === 'style' || n.includes('href') || /javascript:|url\(/i.test(a.value)) el.removeAttribute(a.name);
          }
        };
        walk(root);
        out = new XMLSerializer().serializeToString(root);
      }
    } catch { out = ''; }
    if (svgCache.size > 500) svgCache.clear();
    svgCache.set(text, out);
    return out;
  }
  const safeImage = (src) => (/^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(String(src || '')) ? src : '');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Layout. There is no fixed grid: the keys arrange themselves to be as big as the screen allows.
  // Keys of each size form a group: most used, normal, less used. In landscape the groups stand side by side
  // (most used on the left), all exactly the same height; upright, they are stacked (most used at the top),
  // all exactly the same width, so the deck looks symmetrical on any screen. Thin lines separate the groups. Most used keys are about twice the size of
  // normal keys, and less used keys about half.
  const MAX_KEYS = 24;
  const SIZES = ['featured', 'normal', 'less'];
  const GAP = 0.16; // space between keys, as a share of the key size
  const DIVIDER = 0.5; // space for the line between groups, in normal keys
  /** Size of k keys (with gaps) filling `span`. */
  const fit = (span, k) => span / (k + (k - 1) * GAP);
  // Target sizes, compared with a normal key, and how far a layout may stray from them.
  const RATIO = { featured: 2, normal: 1, less: 0.5 };
  const RANGE = { featured: [1.3, 4], less: [0.25, 0.8] };
  const MIN_TOUCH = 48; // px
  /**
   * Chooses how the groups are laid out in a w × h space. Returns { bands: [{ size, cell, cols }], normal, portrait }
   * with sizes in px. `cap` limits the size of a normal key so a page with few keys doesn't get giant keys.
   *
   * The layout is symmetrical on every screen: in landscape every group is exactly as tall as the others (upright,
   * exactly as wide), so all groups start and end on the same lines, and each group picks a tidy rows × columns
   * shape (full rows preferred). Key sizes stay close to 2 : 1 : 0.5.
   */
  function planBands(counts, w, h, cap) {
    const portrait = h > w * 1.05;
    const fillSide = portrait ? w : h; // every group spans exactly this side
    const otherSide = portrait ? h : w; // groups are placed one after another along this side
    const present = SIZES.filter((sz) => counts[sz]);
    if (!present.length) return { portrait, normal: Math.min(cap, fit(fillSide, 4)), bands: [] };
    // Shapes each group can take, sized for a fill side of 1: t keys across the fill side, l along the other.
    const options = present.map((size) => {
      const n = counts[size];
      const list = [];
      for (let c = 1; c <= n; c++) {
        const rows = Math.ceil(n / c);
        if (c > 1 && Math.ceil(n / (c - 1)) === rows) continue; // same rows with fewer columns is always better
        const t = portrait ? c : rows;
        const l = portrait ? rows : c;
        const cell = 1 / (t * (1 + GAP) - GAP);
        list.push({ size, cols: c, cell, ext: cell * (l * (1 + GAP) - GAP), empty: rows * c - n });
      }
      return list;
    });
    let best = null;
    const pick = (i, chosen) => {
      if (i < options.length) { for (const o of options[i]) { chosen[i] = o; pick(i + 1, chosen); } return; }
      const by = {};
      chosen.forEach((o) => { by[o.size] = o; });
      // One normal key, in the same units (from another group when the page has no normal keys).
      const unit = by.normal ? by.normal.cell : by.featured ? by.featured.cell / RATIO.featured : by.less.cell / RATIO.less;
      let fitness = 1;
      let fits = true;
      for (const o of chosen) {
        if (o.size !== 'normal') {
          const r = o.cell / unit;
          let target = RATIO[o.size];
          let [lo, hi] = RANGE[o.size];
          if (!by.normal && by.featured && by.less && o.size === 'less') { target = 0.25; lo = 0.1; hi = 0.5; }
          if (by.normal || (by.featured && by.less && o.size === 'less')) {
            if (r < lo || r > hi) fits = false;
            fitness *= Math.exp(-0.8 * Math.abs(Math.log(r / target)));
          }
        }
        fitness *= Math.pow(0.9, o.empty); // gaps at the end of a group look untidy
      }
      const ext = chosen.reduce((sum, o) => sum + o.ext, 0) + (chosen.length - 1) * DIVIDER * unit;
      const span = Math.min(fillSide, otherSide / ext, cap / unit); // how long the fill side really is
      // Keys smaller than a comfortable touch target (48 px) are a last resort.
      for (const o of chosen) fitness *= Math.pow(Math.min(1, (o.cell * span) / MIN_TOUCH), 3);
      const score = span * unit * fitness;
      if (!best || (fits && !best.fits) || (fits === best.fits && score > best.score)) {
        best = { fits, score, span, unit, bands: chosen.map((o) => ({ size: o.size, cell: o.cell * span, cols: o.cols })) };
      }
    };
    pick(0, []);
    return { portrait, normal: best.unit * best.span, bands: best.bands };
  }
  const isEmptyKey = (b) => !b || ((!b.icon || b.icon.kind === 'none') && !(b.caption && b.caption.show && b.caption.text) && (!b.action || b.action.type === 'none'));

  // The red Lock key (locks the PC) is part of every deck: it sits at the bottom left, under the keys, on every
  // page. It can't be moved, changed or removed. The PC runs presses of this id as "lock".
  const FIXED_LOCK = {
    id: 'pd-lock', fixed: true,
    icon: { kind: 'lucide', value: 'lock' },
    caption: { show: true, text: 'Lock', pos: 'bottom' },
    color: '#e5484d',
    action: { type: 'system', op: 'lock' },
  };

  class DeckView {
    constructor(stage, opts = {}) {
      this.stage = stage;
      this.opts = opts;
      this.mode = opts.mode || 'device';
      this.deck = null;
      this.pageIndex = 0;
      this.selectedId = null;
      this.confirming = null;
      stage.classList.add('dk-stage');
      this.grid = document.createElement('div');
      this.grid.className = 'dk-grid';
      stage.appendChild(this.grid);
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(stage);
      if (this.mode === 'device') this.bindPress();
      else this.grid.addEventListener('click', (e) => {
        const el = e.target.closest('.dk-btn');
        if (el && opts.onSelect) opts.onSelect(el.dataset.id, Number(el.dataset.index));
      });
    }

    get page() { return this.deck?.pages[this.pageIndex] || null; }

    /** Size of a key: 'featured' (most used), 'normal' or 'less' (less used). */
    static sizeOf(b) { return b && SIZES.includes(b.size) ? b.size : 'normal'; }

    /**
     * The keys this page shows, as [key, index]. On the device: the keys that do something. In the editor also
     * the selected key, and one empty "+" key to add a new one (while the page has room).
     */
    visibleKeys() {
      const list = (this.page && this.page.buttons) || [];
      const out = [];
      let plus = this.mode === 'editor';
      for (let i = 0; i < Math.min(list.length, MAX_KEYS); i++) {
        const b = list[i];
        if (!isEmptyKey(b)) out.push([b, i]);
        else if (this.mode === 'editor' && b && b.id === this.selectedId) { out.push([b, i]); plus = false; }
      }
      if (plus) {
        const i = list.findIndex((b, j) => j < MAX_KEYS && isEmptyKey(b));
        if (i >= 0) out.push([list[i], i]);
      }
      return out;
    }

    layout() {
      const w = this.stage.clientWidth;
      const h = this.stage.clientHeight;
      if (!w || !h || !this.deck || !this.bandEls) return;
      const fill = this.opts.fill ?? 0.94;
      const cap = Math.min(this.opts.maxCell || 240, Math.min(w, h) * 0.42);
      const plan = this.plan(w * fill, h * fill, cap);
      this.grid.classList.toggle('is-portrait', plan.portrait);
      this.grid.style.setProperty('--unit', plan.normal.toFixed(2) + 'px');
      // Room under the keys for the deepest 3D edge, the same for every group so they line up.
      const biggest = Math.max(0, ...plan.bands.map((b) => b.cell));
      this.grid.style.setProperty('--grid-depth', Math.max(3, biggest * 0.055).toFixed(2) + 'px');
      plan.bands.forEach((b) => {
        const el = this.bandEls[b.size];
        if (!el) return;
        el.style.setProperty('--cell', b.cell.toFixed(2) + 'px');
        el.style.width = (b.cols * b.cell + (b.cols - 1) * GAP * b.cell + 0.5).toFixed(2) + 'px'; // +0.5 px: rounding never wraps a row early
      });
    }

    /**
     * The layout for a w × h space. The editor lays out only the keys the device shows, so its preview arranges
     * them exactly as the device does; its empty keys (the "+" key) then go at the end of the normal keys, and
     * if that needs another row or column every key shrinks a little so all of them still fit.
     */
    plan(w, h, cap) {
      const extra = this.extra || 0;
      const real = { ...this.counts, normal: this.counts.normal - extra };
      if (!extra || !(real.featured + real.normal + real.less)) return planBands(this.counts, w, h, cap);
      const plan = planBands(real, w, h, cap);
      const n = plan.bands.find((b) => b.size === 'normal');
      if (!n) {
        // No normal keys on the device: the empty key gets its own group, one key across, at normal size.
        const order = SIZES.filter((sz) => sz === 'normal' || plan.bands.some((b) => b.size === sz));
        plan.bands.push({ size: 'normal', cell: plan.normal, cols: 1 });
        plan.bands.sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size));
      }
      const span = (k, cell) => k * cell + (k - 1) * GAP * cell;
      const box = plan.bands.map((b) => {
        const count = this.counts[b.size];
        const rows = Math.ceil(count / b.cols);
        return { across: span(b.cols, b.cell), down: span(rows, b.cell) };
      });
      const seps = (plan.bands.length - 1) * DIVIDER * plan.normal;
      const needW = plan.portrait ? Math.max(...box.map((b) => b.across)) : box.reduce((t, b) => t + b.across, 0) + seps;
      const needH = plan.portrait ? box.reduce((t, b) => t + b.down, 0) + seps : Math.max(...box.map((b) => b.down));
      const k = Math.min(1, w / needW, h / needH);
      if (k < 1) {
        plan.normal *= k;
        plan.bands.forEach((b) => { b.cell *= k; });
      }
      return plan;
    }

    setDeck(deck) {
      this.deck = deck;
      if (this.pageIndex >= deck.pages.length) this.pageIndex = 0;
      this.render();
    }
    setPage(i) {
      if (!this.deck) return;
      const n = this.deck.pages.length;
      this.pageIndex = ((i % n) + n) % n;
      this.render();
    }
    setSelected(id) {
      const changed = id !== this.selectedId;
      this.selectedId = id;
      // In the editor, selecting an empty key shows it, so the page is drawn again.
      if (this.mode === 'editor' && changed) { this.render(); return; }
      this.grid.querySelectorAll('.dk-btn').forEach((b) => b.classList.toggle('is-selected', b.dataset.id === id));
    }

    iconHtml(icon) {
      if (!icon || icon.kind === 'none') return null;
      if (icon.kind === 'svg') return safeSvg(icon.svg);
      if (icon.kind === 'lucide') return safeSvg(this.opts.lucide && this.opts.lucide(icon.value));
      if (icon.kind === 'emoji') return `<span class="dk-emoji">${esc(icon.value)}</span>`;
      if (icon.kind === 'image') {
        const src = safeImage(icon.value);
        if (!src) return null;
        return `<img alt="" draggable="false" src="${esc(src)}">`;
      }
      return null;
    }

    /** The permanent Lock key (the PC sends it with its icon already drawn). */
    fixedKey() {
      return (this.deck && this.deck.fixedKey) || FIXED_LOCK;
    }

    buttonHtml(b, i) {
      const icon = this.iconHtml(b.icon);
      const cap = b.caption && b.caption.show && b.caption.text ? b.caption.text : '';
      const empty = !icon && !cap && (!b.action || b.action.type === 'none');
      const cls = ['dk-btn'];
      const pos = ['top', 'bottom', 'left', 'right', 'center'].includes(b.caption && b.caption.pos) ? b.caption.pos : 'bottom';
      if (cap) cls.push('has-caption', 'cap-' + pos);
      if (b.color) cls.push('is-tinted');
      if (empty) cls.push('is-empty');
      if (b.id === this.selectedId) cls.push('is-selected');
      const style = b.color ? ` style="--tint:${esc(b.color)}"` : '';
      let inner = '';
      if (icon) inner += `<div class="dk-icon">${icon}</div>`;
      if (cap) inner += `<div class="dk-caption">${esc(cap)}</div>`;
      if (!inner && this.mode === 'editor') inner = `<div class="dk-placeholder">${PLUS}</div>`;
      const drag = this.mode === 'editor' ? ' draggable="true"' : '';
      return `<button class="${cls.join(' ')}" data-id="${esc(b.id)}" data-index="${i}"${style}${drag} aria-label="${esc(cap || 'Button ' + (i + 1))}"><div class="dk-face">${inner}</div><span class="dk-ring"></span></button>`;
    }

    render() {
      const page = this.page;
      if (!page) { this.grid.innerHTML = ''; this.bandEls = null; return; }
      const groups = { featured: [], normal: [], less: [] };
      for (const [key, i] of this.visibleKeys()) groups[isEmptyKey(key) ? 'normal' : DeckView.sizeOf(key)].push([key, i]);
      this.counts = { featured: groups.featured.length, normal: groups.normal.length, less: groups.less.length };
      // Empty keys (the editor's "+" key, or a new key not filled in yet) are never on the device.
      this.extra = groups.normal.filter(([key]) => isEmptyKey(key)).length;
      const parts = [];
      for (const size of SIZES) {
        if (!groups[size].length) continue;
        parts.push(`<div class="dk-band size-${size}" data-size="${size}">${groups[size].map(([key, i]) => this.buttonHtml(key, i)).join('')}</div>`);
      }
      this.grid.innerHTML = parts.length
        ? parts.join('<div class="dk-sep" aria-hidden="true"></div>')
        : '<p class="dk-empty-note">This page has no keys yet. Add them in PocketDeck on your PC.</p>';
      this.bandEls = {};
      this.grid.querySelectorAll('.dk-band').forEach((el) => { this.bandEls[el.dataset.size] = el; });
      this.grid.classList.toggle('icons-grey', this.deck.iconColours === 'greyscale');
      this.layout();
    }

    feedback(id, ok) {
      const el = this.grid.querySelector(`.dk-btn[data-id="${CSS.escape(id)}"]`);
      if (!el) return;
      const cls = ok ? 'is-ok' : 'is-err';
      el.classList.remove('is-ok', 'is-err');
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), ok ? 120 : 900);
    }

    bindPress() {
      let active = null;
      const release = (fire) => {
        if (!active) return;
        const { el, b } = active;
        el.classList.remove('is-pressed');
        active = null;
        if (!fire) return;
        if (b.confirm) {
          if (this.confirming !== b.id) {
            this.clearConfirm();
            this.confirming = b.id;
            el.classList.add('is-confirm');
            const lab = document.createElement('div');
            lab.className = 'dk-confirm-label';
            lab.textContent = 'Tap again';
            el.appendChild(lab);
            this.confirmTimer = setTimeout(() => this.clearConfirm(), 2500);
            return;
          }
          this.clearConfirm();
        } else this.clearConfirm();
        this.opts.onPress && this.opts.onPress(b, this.page);
      };
      this.grid.addEventListener('pointerdown', (e) => {
        const el = e.target.closest('.dk-btn');
        if (!el || !this.page) return;
        const b = this.page.buttons[Number(el.dataset.index)];
        if (!b || el.classList.contains('is-empty')) return;
        active = { el, b, x: e.clientX, y: e.clientY, id: e.pointerId };
        el.classList.add('is-pressed');
        this.opts.onDown && this.opts.onDown(b);
      });
      window.addEventListener('pointermove', (e) => {
        if (active && active.id === e.pointerId && Math.hypot(e.clientX - active.x, e.clientY - active.y) > 18) release(false);
      });
      window.addEventListener('pointerup', (e) => { if (active && active.id === e.pointerId) release(true); });
      window.addEventListener('pointercancel', () => release(false));
      this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    clearConfirm() {
      clearTimeout(this.confirmTimer);
      if (!this.confirming) return;
      const el = this.grid.querySelector(`.dk-btn[data-id="${CSS.escape(this.confirming)}"]`);
      if (el) { el.classList.remove('is-confirm'); el.querySelector('.dk-confirm-label')?.remove(); }
      this.confirming = null;
    }
  }

  /**
   * The information in the top bar: date and time on one line in the centre, and the weather
   * (icon, temperature and place) on the right. Used on the device and in the PC editor preview.
   */
  class DeckInfo {
    constructor({ now, weather, mode = 'device', lucide = null }) {
      this.nowEl = now;
      this.wxEl = weather;
      this.mode = mode;
      this.lucide = lucide;
      this.deck = null;
      this.weather = null;
      this.timer = setInterval(() => this.renderNow(), 1000);
    }
    setDeck(deck) { this.deck = deck; this.nowEl.dataset.style = ''; this.renderNow(); this.renderWeather(); }
    setWeather(w) { this.weather = w || null; this.renderWeather(); }

    renderNow() {
      if (!this.deck || !this.nowEl) return;
      const cfg = this.deck.clock || {};
      const analog = cfg.style === 'analog';
      const el = this.nowEl;
      if (el.dataset.style !== (analog ? 'analog' : 'digital')) {
        el.dataset.style = analog ? 'analog' : 'digital';
        el.innerHTML = (analog ? `<svg class="dk-mini-face" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="45" class="dk-face-ring"/>
            ${[0, 90, 180, 270].map((d) => `<line x1="50" y1="9" x2="50" y2="17" transform="rotate(${d} 50 50)" class="dk-tick"/>`).join('')}
            <line x1="50" y1="50" x2="50" y2="28" class="dk-hand dk-h"/><line x1="50" y1="50" x2="50" y2="16" class="dk-hand dk-m"/>
            <line x1="50" y1="56" x2="50" y2="13" class="dk-hand dk-s"/><circle cx="50" cy="50" r="5" class="dk-pin"/></svg>` : '') +
          '<span class="dk-now-date"></span><span class="dk-now-time"></span>';
        el.classList.toggle('is-analog', analog);
      }
      const now = new Date();
      let h = now.getHours();
      const m = String(now.getMinutes()).padStart(2, '0');
      let ampm = '';
      if (!cfg.hour24) { ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; } else h = String(h).padStart(2, '0');
      const secs = String(now.getSeconds()).padStart(2, '0');
      const timeHtml = `${h}:${m}${cfg.showSeconds ? `<span class="dk-sec">:${secs}</span>` : ''}${ampm ? ` <span class="dk-ampm">${ampm}</span>` : ''}`;
      const t = el.querySelector('.dk-now-time');
      if (t.innerHTML !== timeHtml) t.innerHTML = timeHtml;
      const d = el.querySelector('.dk-now-date');
      const dateText = cfg.showDate === false ? '' : now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      if (d.textContent !== dateText) d.textContent = dateText;
      d.hidden = !dateText;
      if (analog) {
        // Analogue: the small face shows the time; the digital time stays for screen readers.
        const s = now.getSeconds(), mi = now.getMinutes(), hr = now.getHours() % 12;
        const rot = (sel, deg) => { const x = el.querySelector(sel); if (x) x.setAttribute('transform', `rotate(${deg} 50 50)`); };
        rot('.dk-h', hr * 30 + mi * 0.5);
        rot('.dk-m', mi * 6 + s * 0.1);
        rot('.dk-s', s * 6);
        el.querySelector('.dk-s').style.display = cfg.showSeconds ? '' : 'none';
      }
      el.setAttribute('aria-label', `${dateText ? dateText + ', ' : ''}${h}:${m} ${ampm}`.trim());
    }

    renderWeather() {
      const el = this.wxEl;
      if (!el || !this.deck) return;
      const w = this.weather;
      // On the device, the weather only shows once there is weather to show; the editor shows a hint instead.
      const show = this.deck.weatherEnabled !== false && (!!w || this.mode === 'editor');
      el.hidden = !show;
      if (!show) return;
      const svg = w ? safeSvg(w.svg || (this.lucide && this.lucide(w.icon))) : '';
      const place = w ? (w.place || w.text || '') : 'Add a city in Settings';
      el.classList.toggle('is-empty', !w);
      el.innerHTML = (svg ? `<span class="dk-wx-icon" aria-hidden="true">${svg}</span>` : '') +
        (w ? `<span class="dk-wx-temp">${esc(w.temp)}°</span>` : '') +
        `<span class="dk-wx-place">${esc(place)}</span>`;
      el.setAttribute('aria-label', w ? `${w.temp}°${w.text ? ', ' + w.text : ''}${w.place ? ', ' + w.place : ''}` : place);
    }
  }

  window.DeckView = DeckView;
  window.DeckInfo = DeckInfo;
  /** Text colour for labels on an accent-coloured button: white when it is readable (4.5:1), otherwise near-black. */
  function onAccent(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const lum = [0, 2, 4].map((i) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    return 1.05 / (L + 0.05) >= 4.5 ? '#ffffff' : '#0b0d12';
  }

  window.DeckSafe = { safeSvg, safeImage, onAccent };
  window.DeckGrids = { MAX_KEYS, SIZES, isEmptyKey };
  window.DeckFixed = FIXED_LOCK;
  // Small drawn icons for the bars (from the Lucide set, ISC licence).
  const SPEAKER = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>';
  const svgIcon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  window.DeckIcons = {
    lock: svgIcon('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    volume: svgIcon(SPEAKER + '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>'),
    volumeOff: svgIcon(SPEAKER + '<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
    mic: svgIcon('<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'),
    micOff: svgIcon('<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  };
})();
