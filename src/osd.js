// A small pop-up on the PC screen, like the one Windows shows for the volume, for changes Windows itself
// doesn't announce (microphone on/off from the device). It never takes focus or clicks, and hides itself.
const { BrowserWindow, screen, nativeTheme } = require('electron');

const W = 216;
const H = 52;
const SHOW_MS = 1800;
let win = null;
let hideTimer = null;

// Lucide icons (ISC licence)
const MIC = '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>';
const MIC_OFF = '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>';

function page(text, icon) {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? 'rgba(32,32,32,0.96)' : 'rgba(249,249,249,0.97)';
  const fg = dark ? '#ffffff' : '#1b1b1b';
  const line = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  // Fixed text and icons only; no scripts.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
.box{box-sizing:border-box;margin:2px;height:${H - 4}px;display:flex;align-items:center;gap:12px;padding:0 18px;border-radius:8px;
background:${bg};color:${fg};border:1px solid ${line};box-shadow:0 4px 12px rgba(0,0,0,0.25)}
svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
span{font-size:14px;white-space:nowrap}
</style></head><body><div class="box"><svg viewBox="0 0 24 24">${icon}</svg><span>${text}</span></div></body></html>`;
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.on('closed', () => { win = null; });
  return win;
}

/** Shows the pop-up: { kind: 'mic', muted }. */
function showOsd(evt) {
  if (!evt || evt.kind !== 'mic') return;
  const w = ensureWindow();
  const text = evt.muted ? 'Microphone muted' : 'Microphone on';
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(text, evt.muted ? MIC_OFF : MIC))).catch(() => {});
  // Bottom centre of the main screen, just above the taskbar, where Windows shows its volume pop-up.
  const area = screen.getPrimaryDisplay().workArea;
  w.setBounds({ x: Math.round(area.x + (area.width - W) / 2), y: Math.round(area.y + area.height - H - 24), width: W, height: H });
  w.showInactive();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.hide(); }, SHOW_MS);
}

module.exports = { showOsd };
