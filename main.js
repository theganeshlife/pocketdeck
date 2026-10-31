// PocketDeck desktop app (Electron main process).
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./src/store');
const { ActionRunner } = require('./src/actions');
const { createServer } = require('./src/server');
const { listInstalledApps, resolveLogo, extractStartIcons, startIconFile } = require('./src/installed-apps');
const { ActivityLog } = require('./src/activity-log');
const { showOsd } = require('./src/osd');
const ABOUT = require('./companion/about');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let server = null;
let runner = null;
let activity = null;
let quitting = false;
// Microsoft Store (MSIX) build: Windows starts it at sign-in through its startup task, which passes no
// arguments, so a launch in the first few minutes after Windows starts is treated as a start-up launch.
const STORE = !!process.windowsStore;
const startHidden = process.argv.includes('--hidden') || (STORE && require('os').uptime() < 180);
const ICON = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d0f14',
    icon: ICON,
    title: 'PocketDeck',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9cdd8', height: 52 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${server.port}/editor/`);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && !quitting) { offerReport('Window stopped', d.reason); if (win && !win.isDestroyed()) win.reload(); } });
  win.on('unresponsive', () => offerReport('Window not responding', 'unresponsive'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('PocketDeck');
  const refresh = () => {
    const login = app.getLoginItemSettings().openAtLogin;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open PocketDeck', click: showWindow },
      { type: 'separator' },
      { label: `PocketDeck ${ABOUT.versionLabel(app.getVersion())}`, enabled: false },
      { label: `Created by ${ABOUT.creator}`, enabled: false },
      { label: 'Buy me a plate of momo…', click: () => shell.openExternal(ABOUT.momoUrl) },
      { label: 'Contact and feedback…', click: () => shell.openExternal(ABOUT.feedbackUrl) },
      { label: 'Check for updates…', click: () => checkUpdatesFromTray() },
      { type: 'separator' },
      STORE
        ? { label: 'Start with Windows…', click: () => setLogin(true) }
        : { label: 'Start with Windows', type: 'checkbox', checked: login, click: (m) => { setLogin(m.checked); refresh(); } },
      { type: 'separator' },
      { label: 'Quit PocketDeck', click: quitApp },
    ]));
  };
  refresh();
  tray.on('click', showWindow);
}

// ----------------------------------------------------------------------- small preferences (rating), kept on this PC
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch {} }

// Quitting asks once for a star rating (unless already rated or "Don't ask again").
let ratingWait = null;
function quitApp() {
  const r = readPrefs().rating || {};
  if (r.stars || r.never || !win || ratingWait) { quitting = true; app.quit(); return; }
  showWindow();
  const done = () => { clearTimeout(ratingWait); ratingWait = null; quitting = true; app.quit(); };
  ratingWait = setTimeout(done, 120000);
  ipcMain.once('rating-done', done);
  win.webContents.send('ask-rating');
}
handle('rating-save', (_e, state) => {
  const p = readPrefs();
  if (state && Number.isInteger(state.stars) && state.stars >= 1 && state.stars <= 5) p.rating = { stars: state.stars };
  else if (state && state.never === true) p.rating = { never: true };
  else return false;
  writePrefs(p);
  return true;
});

// ----------------------------------------------------------------------- updates
async function checkUpdatesFromTray() {
  const r = await ABOUT.checkForUpdate('windows', app.getVersion());
  const buttons = r.update && r.url ? ['Open the download page', 'Close'] : ['OK'];
  const { response } = await dialog.showMessageBox({ type: 'info', title: 'PocketDeck', message: 'Check for updates', detail: r.message, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
  if (r.update && r.url && response === 0 && /^https:\/\//.test(r.url)) shell.openExternal(r.url);
}

// ----------------------------------------------------------------------- error reports (sent only if the person agrees)
let reportOpen = false;
let reportsShown = 0;
async function offerReport(kind, error) {
  try { activity && activity.fail('app error', kind); } catch {}
  if (reportOpen || reportsShown >= 3 || !app.isReady()) return;
  reportOpen = true;
  reportsShown++;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'PocketDeck',
      message: 'Something went wrong',
      detail: 'Send an error report to the developer? It includes the error, the app version and the recent activity log (which actions worked or failed). It doesn’t include your name, photo, typed text, commands or location.',
      buttons: ['Send report', 'Don’t send'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      const log = activity ? activity.read(150) : '';
      const ok = await ABOUT.sendReport({ app: 'windows', version: app.getVersion(), platform: `Windows ${require('os').release()}`, error: `${kind}: ${error && error.stack ? error.stack : error}`, log: typeof log === 'string' ? log : (log && log.text) || '' });
      dialog.showMessageBox({ type: 'info', title: 'PocketDeck', message: ok ? 'Thank you. The report has been sent.' : 'The report couldn’t be sent. Check the internet connection and try again later.', buttons: ['OK'] });
    }
  } catch {}
  reportOpen = false;
}
process.on('uncaughtException', (e) => { console.error(e); offerReport('Crash', e); });
process.on('unhandledRejection', (e) => { console.error(e); offerReport('Error', e); });

function setLogin(enabled) {
  // The Store build's startup task is switched on and off in Windows' own Startup apps settings.
  if (STORE) { shell.openExternal('ms-settings:startupapps'); return; }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

// ----------------------------------------------------------------------- IPC
// Only our own editor page (served from this app's local server) may use these.
function trustedSender(e) {
  try {
    const url = (e.senderFrame && e.senderFrame.url) || '';
    // The window can only ever show our editor (navigation is locked), so the sender check is the key test.
    return !!server && !!win && e.sender === win.webContents && (!url || url.startsWith(`http://127.0.0.1:${server.port}/editor/`));
  } catch { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error('Not allowed');
    return fn(e, ...args);
  });
}
ipcMain.on('local-key', (e) => { e.returnValue = trustedSender(e) ? server.localKey : ''; });

handle('pick-file', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || 'Choose a program',
    properties: ['openFile'],
    filters: opts.filters || [{ name: 'Programs & shortcuts', extensions: ['exe', 'lnk', 'bat', 'cmd', 'url', 'appref-ms'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('pick-image', async (_e, opts = {}) => {
  const large = !!(opts && opts.large);
  const r = await dialog.showOpenDialog(win, {
    title: large ? 'Choose a photo for the deck background' : 'Choose an icon image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'bmp'] }],
  });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  if (/\.svg$/i.test(file) && !large) return 'data:image/svg+xml;base64,' + fs.readFileSync(file).toString('base64');
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const max = large ? 2400 : 256;
  if (width > max || height > max) img = img.resize(width >= height ? { width: max, quality: 'best' } : { height: max, quality: 'best' });
  return large ? 'data:image/jpeg;base64,' + img.toJPEG(90).toString('base64') : img.toDataURL();
});

/** Cuts away empty (transparent) edges around an icon, keeping it square, so every app icon fills its key alike.
 *  Windows sometimes returns a small old-style icon in the corner of a big transparent picture. */
function trimTransparent(img) {
  const { width: w, height: h } = img.getSize();
  if (!w || !h) return img;
  const px = img.toBitmap(); // BGRA
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return img;
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  if (side >= Math.min(w, h) * 0.9) return img; // already fills its picture
  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;
  const x = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));
  return img.crop({ x, y, width: Math.min(side, w), height: Math.min(side, h) });
}

// Best available icon for a program, shortcut or Store app, as a data URL. Kept at up to 256 px (never stretched
// up), so it stays sharp on the biggest keys.
async function iconFor(src) {
  const toUrl = (img) => {
    if (!img || img.isEmpty()) return null;
    let out = trimTransparent(img);
    const { width, height } = out.getSize();
    if (width > 256 || height > 256) out = out.resize({ width: 256, height: 256, quality: 'best' });
    return out.toDataURL();
  };
  if (typeof src === 'string') src = { iconSource: src };
  if (!src || typeof src !== 'object') return null;
  // Keys made before this version only kept the launch path; a Start-menu entry path holds the AppID.
  if (!src.appId && /^shell:AppsFolder\\/i.test(src.iconSource || '')) src = { ...src, appId: src.iconSource.slice(17) };
  try {
    // First choice: the icon Windows shows in the Start menu for this app (works for Office and Store apps too).
    if (src.appId) {
      const file = await startIconFile(String(src.appId), scriptsDir());
      if (file) { const url = toUrl(nativeImage.createFromPath(file)); if (url) return url; }
    }
    // A shortcut: ask Windows for the icon it shows for it (handles Office-style shortcuts that have no plain target).
    if (/^[a-z]:\\.+\.lnk$/i.test(src.iconSource || '') && fs.existsSync(src.iconSource)) {
      const file = await startIconFile(src.iconSource, scriptsDir());
      if (file) { const url = toUrl(nativeImage.createFromPath(file)); if (url) return url; }
    }
    if (src.logo) {
      const file = resolveLogo(src.logo);
      if (file) { const url = toUrl(nativeImage.createFromPath(file)); if (url) return url; }
    }
    let file = src.iconSource;
    if (!file || /^shell:/i.test(file)) return null;
    if (/\.lnk$/i.test(file)) {
      try {
        const link = shell.readShortcutLink(file);
        const icon = link.icon && fs.existsSync(link.icon) ? link.icon : null;
        if (icon && /\.(ico|png)$/i.test(icon)) { const url = toUrl(nativeImage.createFromPath(icon)); if (url) return url; }
        if (icon) file = icon;
        else if (link.target && fs.existsSync(link.target)) file = link.target;
      } catch { /* use the shortcut itself */ }
    }
    if (!fs.existsSync(file)) return null;
    // Ask Windows for the big version of the program's icon first; the built-in one is only 32 px.
    if (/^[a-z]:\\/i.test(file)) {
      const big = await startIconFile(file, scriptsDir());
      if (big) { const url = toUrl(nativeImage.createFromPath(big)); if (url) return url; }
    }
    return toUrl(await app.getFileIcon(file, { size: 'large' }));
  } catch { return null; }
}

handle('file-icon', (_e, src) => iconFor(src));
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');
// Listing the apps also fetches all their Start-menu icons in the background, so the list fills in quickly.
async function listAppsWithIcons(refresh) {
  const apps = await listInstalledApps({ refresh, dir: scriptsDir() });
  extractStartIcons(apps.map((a) => a.appId), scriptsDir()).catch(() => {});
  return apps;
}
handle('list-apps', (_e, refresh) => listAppsWithIcons(!!refresh));

handle('open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));

handle('login-item', (_e, value) => {
  if (typeof value === 'boolean') setLogin(value);
  return STORE ? null : app.getLoginItemSettings().openAtLogin;
});

handle('titlebar', (_e, { color, symbolColor } = {}) => {
  if (!/^#[0-9a-f]{6}$/i.test(color || '') || !/^#[0-9a-f]{6}$/i.test(symbolColor || '')) return;
  try { win.setTitleBarOverlay({ color, symbolColor, height: 52 }); } catch {}
});

// ----------------------------------------------------------------------- start
app.on('second-instance', showWindow);
// Never allow extra webviews or windows to be attached.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  // No camera, microphone, location, notifications or other permissions for any page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.setAppUserModelId('com.pocketdeck.desktop');
  const store = new Store(app.getPath('userData'));
  runner = new ActionRunner((...a) => console.log(...a), path.join(app.getPath('userData'), 'scripts'));
  activity = new ActivityLog(app.getPath('userData'));
  server = createServer({ store, runner, activity, port: 8765, onSound: showOsd });
  try {
    await server.listen();
  } catch (e) {
    dialog.showErrorBox('PocketDeck', 'Could not start the deck server: ' + e.message);
    app.exit(1);
    return;
  }
  createWindow();
  buildTray();
  setTimeout(() => listAppsWithIcons(false).catch(() => {}), 3000);
});

app.on('will-quit', () => {
  try { server && server.close(); } catch {}
  try { runner && runner.stop(); } catch {}
});
