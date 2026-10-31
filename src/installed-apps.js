// Lists the apps in the Windows Start menu (desktop programs and Store apps).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIST_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Start-menu shortcuts by name (desktop programs)
$lnk = @{}
$roots = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk -File | ForEach-Object {
    if (-not $lnk.ContainsKey($_.BaseName)) { $lnk[$_.BaseName] = $_.FullName }
  }
}

# Microsoft Store app logos by AppID
$uwp = @{}
foreach ($p in Get-AppxPackage) {
  if (-not $p.InstallLocation) { continue }
  $manifest = Join-Path $p.InstallLocation 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifest)) { continue }
  try { $m = [xml](Get-Content -LiteralPath $manifest -Raw) } catch { continue }
  foreach ($a in @($m.Package.Applications.Application)) {
    if (-not $a) { continue }
    $ve = $a.VisualElements
    if (-not $ve) { continue }
    $logo = $ve.Square44x44Logo
    if (-not $logo) { $logo = $ve.Square150x150Logo }
    if (-not $logo) { continue }
    $uwp[$p.PackageFamilyName + '!' + $a.Id] = (Join-Path $p.InstallLocation $logo)
  }
}

$out = foreach ($s in Get-StartApps) {
  $o = [ordered]@{ name = $s.Name; appId = $s.AppID }
  if ($lnk.ContainsKey($s.Name)) { $o.lnk = $lnk[$s.Name] }
  if ($uwp.ContainsKey($s.AppID)) { $o.logo = $uwp[$s.AppID] }
  [pscustomobject]$o
}
@($out) | ConvertTo-Json -Compress
`;

const HIDE = /\b(uninstall|uninstaller|readme|read me|release notes|documentation|help|manual|license|website|support|feedback hub)\b/i;

// Known-folder GUIDs that appear at the start of some desktop AppIDs.
function knownFolders() {
  const pf = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const win = process.env.SystemRoot || 'C:\\Windows';
  return {
    '{6D809377-6AF0-444B-8957-A3773F02200E}': pf,
    '{905E63B6-C1BF-494E-B29C-65B732D3D21A}': pf,
    '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': pf86,
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(win, 'System32'),
    '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': path.join(win, 'SysWOW64'),
    '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': win,
  };
}

function resolveAppIdPath(appId) {
  const m = /^(\{[0-9A-F-]+\})\\(.+)$/i.exec(appId || '');
  if (m) {
    const base = knownFolders()[m[1].toUpperCase()];
    return base ? path.join(base, m[2]) : null;
  }
  if (/^[a-z]:\\/i.test(appId || '')) return appId;
  return null;
}

// Store apps ship logos as Name.targetsize-48.png, Name.scale-200.png, …; pick the best one.
function resolveLogo(logo) {
  if (!logo) return null;
  if (fs.existsSync(logo)) return logo;
  const dir = path.dirname(logo);
  const ext = path.extname(logo);
  const base = path.basename(logo, ext).toLowerCase();
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const candidates = files.filter((f) => f.toLowerCase().startsWith(base + '.') && f.toLowerCase().endsWith(ext.toLowerCase()) && !/contrast-/i.test(f));
  if (!candidates.length) return null;
  const score = (f) => {
    let s = 0;
    const t = /targetsize-(\d+)/i.exec(f);
    const sc = /scale-(\d+)/i.exec(f);
    if (t) s += Math.min(Number(t[1]), 256) * 10;
    if (sc) s += Number(sc[1]);
    if (/altform-unplated/i.test(f)) s += 5000;
    if (/altform-lightunplated/i.test(f)) s -= 3000;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return path.join(dir, candidates[0]);
}

let cache = null;

function listInstalledApps({ refresh = false, dir = null } = {}) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (cache && !refresh) return cache;
  cache = new Promise((resolve, reject) => {
    const base = dir || os.tmpdir();
    try { fs.mkdirSync(base, { recursive: true }); } catch {}
    const file = path.join(base, 'pocketdeck-apps.ps1');
    fs.writeFileSync(file, '\ufeff' + LIST_PS1, 'utf8');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    let out = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', reject);
    ps.on('close', () => {
      let rows;
      try { rows = JSON.parse(out.trim() || '[]'); } catch (e) { reject(new Error('Could not read the app list')); return; }
      if (!Array.isArray(rows)) rows = [rows];
      const seen = new Set();
      const apps = [];
      for (const r of rows) {
        if (!r || !r.name || !r.appId || HIDE.test(r.name)) continue;
        const key = r.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const isStore = /![^\\]+$/.test(r.appId) && !r.lnk;
        apps.push({
          name: r.name,
          appId: r.appId,
          // What the key will launch: the Start-menu shortcut when there is one, otherwise the Start-menu entry itself.
          path: r.lnk || 'shell:AppsFolder\\' + r.appId,
          kind: isStore ? 'store' : 'desktop',
          iconSource: r.lnk || resolveAppIdPath(r.appId) || null,
          logo: r.logo || null,
        });
      }
      apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      resolve(apps);
    });
  });
  cache.catch(() => { cache = null; });
  return cache;
}

// ------------------------------------------------------------------ Start-menu icons
// Asks Windows for each app's icon exactly as the Start menu shows it (shell:AppsFolder\<AppID>).
// This covers every kind of app, including Office and other programs whose shortcuts don't point at a normal file.
const ICON_PS1 = String.raw`
param([string]$List)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PdShellIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItemImageFactory {
    [PreserveSig] int GetImage(PdSize size, int flags, out IntPtr phbm);
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PdSize { public int cx; public int cy; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  private struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }

  [StructLayout(LayoutKind.Sequential)]
  private struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant;
  }

  [DllImport("gdi32.dll")]
  private static extern int GetObject(IntPtr h, int size, ref BITMAP bm);

  [DllImport("gdi32.dll")]
  private static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, [Out] byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);

  [DllImport("user32.dll")]
  private static extern IntPtr GetDC(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

  public static bool Save(string parsingName, string file, int size) {
    IShellItemImageFactory factory;
    SHCreateItemFromParsingName(parsingName, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
    PdSize s; s.cx = size; s.cy = size;
    IntPtr h;
    // 0x1 = a bigger size is fine, 0x4 = the icon only (no thumbnail)
    if (factory.GetImage(s, 0x5, out h) != 0 || h == IntPtr.Zero) return false;
    try {
      BITMAP bm = new BITMAP();
      if (GetObject(h, Marshal.SizeOf(typeof(BITMAP)), ref bm) == 0) return false;
      int w = bm.bmWidth, ht = Math.Abs(bm.bmHeight);
      if (w <= 0 || ht <= 0 || w > 1024 || ht > 1024) return false;
      // Read the pixels as 32-bit, top row first, keeping the transparency.
      BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
      bi.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bi.biWidth = w; bi.biHeight = -ht; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
      byte[] px = new byte[w * ht * 4];
      IntPtr dc = GetDC(IntPtr.Zero);
      int lines;
      try { lines = GetDIBits(dc, h, 0, (uint)ht, px, ref bi, 0); } finally { ReleaseDC(IntPtr.Zero, dc); }
      if (lines == 0) return false;
      bool hasAlpha = false;
      for (int i = 3; i < px.Length; i += 4) { if (px[i] != 0) { hasAlpha = true; break; } }
      if (!hasAlpha) { for (int i = 3; i < px.Length; i += 4) px[i] = 255; }
      using (Bitmap outBmp = new Bitmap(w, ht, PixelFormat.Format32bppPArgb)) {
        BitmapData d = outBmp.LockBits(new Rectangle(0, 0, w, ht), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try {
          for (int y = 0; y < ht; y++) Marshal.Copy(px, y * w * 4, new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), w * 4);
        } finally { outBmp.UnlockBits(d); }
        outBmp.Save(file, ImageFormat.Png);
      }
      return true;
    } finally { DeleteObject(h); }
  }
}
'@
$items = Get-Content -LiteralPath $List -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($it in @($items)) {
  try { if (-not [PdShellIcon]::Save($it.id, $it.out, 256)) { [Console]::Error.WriteLine('no image: ' + $it.id) } } catch { [Console]::Error.WriteLine('failed: ' + $it.id + ': ' + $_.Exception.Message) }
}
`;

function iconCacheDir(base) {
  const dir = path.join(base, 'app-icons');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
const iconFile = (base, appId) => path.join(iconCacheDir(base), crypto.createHash('sha1').update(String(appId)).digest('hex') + '.png');
let iconJob = Promise.resolve();
const iconErrors = { last: '' }; // problems from the last icon run, for troubleshooting

/** Windows name for a Start-menu entry. */
const appsFolderName = (appId) => 'shell:AppsFolder\\' + appId;

/** Saves the icons Windows shows for these items (Start-menu entries or shortcut files) into the cache.
 *  Skips ones already there; one PowerShell run for the lot. */
function extractStartIcons(appIds, base) {
  if (process.platform !== 'win32') return Promise.resolve();
  const todo = [...new Set(appIds.filter((id) => typeof id === 'string' && id).map((id) => (/^(shell:|[a-z]:\\)/i.test(id || '') ? id : appsFolderName(id))).filter((id) => typeof id === 'string' && id && id.length <= 512 && !/[\r\n]/.test(id)))]
    .map((id) => ({ id, out: iconFile(base, id) }))
    .filter((x) => !fs.existsSync(x.out));
  if (!todo.length) return iconJob;
  const run = () => new Promise((resolve) => {
    // Another run may have saved these meanwhile.
    const left = todo.filter((x) => !fs.existsSync(x.out));
    if (!left.length) { resolve(); return; }
    const script = path.join(base, 'pocketdeck-icons.ps1');
    const list = path.join(base, `pocketdeck-icons-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(script, '﻿' + ICON_PS1, 'utf8');
      fs.writeFileSync(list, JSON.stringify(left), 'utf8');
    } catch { resolve(); return; }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script, '-List', list], { windowsHide: true });
    let err = '';
    ps.stderr.setEncoding('utf8');
    ps.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    const done = () => { try { fs.unlinkSync(list); } catch {} iconErrors.last = err.trim(); resolve(); };
    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, 60000);
    ps.on('error', () => { clearTimeout(timer); done(); });
    ps.on('close', () => { clearTimeout(timer); done(); });
  });
  iconJob = iconJob.then(run, run);
  return iconJob;
}

/** The cached icon file for an AppID or a shortcut path, extracting it first if needed. */
async function startIconFile(appId, base) {
  if (!appId || process.platform !== 'win32') return null;
  const name = /^(shell:|[a-z]:\\)/i.test(appId) ? appId : appsFolderName(appId);
  const file = iconFile(base, name);
  if (!fs.existsSync(file)) await extractStartIcons([name], base);
  return fs.existsSync(file) ? file : null;
}

module.exports = { listInstalledApps, resolveLogo, extractStartIcons, startIconFile, iconErrors };
