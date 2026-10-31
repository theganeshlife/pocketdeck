// Executes deck actions on Windows. On other platforms actions are logged (dry run),
// which keeps the server testable during development.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Virtual-key codes
// ---------------------------------------------------------------------------
const VK = {
  CTRL: 0x11, CONTROL: 0x11, SHIFT: 0x10, ALT: 0x12, WIN: 0x5b, META: 0x5b, CMD: 0x5b,
  ENTER: 0x0d, RETURN: 0x0d, ESC: 0x1b, ESCAPE: 0x1b, TAB: 0x09, SPACE: 0x20, BACKSPACE: 0x08,
  DELETE: 0x2e, DEL: 0x2e, INSERT: 0x2d, INS: 0x2d, HOME: 0x24, END: 0x23, PAGEUP: 0x21, PGUP: 0x21,
  PAGEDOWN: 0x22, PGDN: 0x22, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRINTSCREEN: 0x2c, PRTSC: 0x2c, CAPSLOCK: 0x14, MENU: 0x5d, APPS: 0x5d,
  PLUS: 0xbb, '=': 0xbb, MINUS: 0xbd, '-': 0xbd, ',': 0xbc, COMMA: 0xbc, '.': 0xbe, PERIOD: 0xbe,
  '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0,
  VOLUMEUP: 0xaf, VOLUMEDOWN: 0xae, VOLUMEMUTE: 0xad, MUTE: 0xad,
  PLAYPAUSE: 0xb3, MEDIANEXT: 0xb0, MEDIAPREV: 0xb1, MEDIASTOP: 0xb2,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 48 + i;
for (let i = 1; i <= 24; i++) VK['F' + i] = 0x6f + i;

function parseHotkey(str) {
  const parts = String(str || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty shortcut');
  return parts.map((p) => {
    const code = VK[p.toUpperCase()] ?? VK[p];
    if (code === undefined) throw new Error(`Unknown key "${p}"`);
    return code;
  });
}

// ---------------------------------------------------------------------------
// Built-in Windows actions (shown in the editor's "Windows action" list)
// ---------------------------------------------------------------------------
const SYSTEM_OPS = [
  { group: 'Media & sound', op: 'volume_up', label: 'Volume up', icon: 'volume-2', keys: [VK.VOLUMEUP] },
  { group: 'Media & sound', op: 'volume_down', label: 'Volume down', icon: 'volume-1', keys: [VK.VOLUMEDOWN] },
  { group: 'Media & sound', op: 'mute', label: 'Mute / unmute', icon: 'volume-x', keys: [VK.VOLUMEMUTE] },
  { group: 'Media & sound', op: 'media_playpause', label: 'Play / pause', icon: 'play', keys: [VK.PLAYPAUSE] },
  { group: 'Media & sound', op: 'media_next', label: 'Next track', icon: 'skip-forward', keys: [VK.MEDIANEXT] },
  { group: 'Media & sound', op: 'media_prev', label: 'Previous track', icon: 'skip-back', keys: [VK.MEDIAPREV] },
  { group: 'Media & sound', op: 'media_stop', label: 'Stop media', icon: 'square', keys: [VK.MEDIASTOP] },

  { group: 'Windows', op: 'show_desktop', label: 'Show desktop', icon: 'monitor', keys: [VK.WIN, VK.D] },
  { group: 'Windows', op: 'task_view', label: 'Task view', icon: 'layout-grid', keys: [VK.WIN, VK.TAB] },
  { group: 'Windows', op: 'alt_tab', label: 'Switch window (Alt+Tab)', icon: 'app-window', keys: [VK.ALT, VK.TAB] },
  { group: 'Windows', op: 'minimize_window', label: 'Minimize window', icon: 'minimize-2', keys: [VK.WIN, VK.DOWN] },
  { group: 'Windows', op: 'maximize_window', label: 'Maximize window', icon: 'maximize-2', keys: [VK.WIN, VK.UP] },
  { group: 'Windows', op: 'close_window', label: 'Close window (Alt+F4)', icon: 'x', keys: [VK.ALT, VK.F4] },
  { group: 'Windows', op: 'explorer', label: 'File Explorer', icon: 'folder', keys: [VK.WIN, VK.E] },
  { group: 'Windows', op: 'settings', label: 'Settings', icon: 'settings', start: 'ms-settings:' },
  { group: 'Windows', op: 'task_manager', label: 'Task Manager', icon: 'activity', keys: [VK.CTRL, VK.SHIFT, VK.ESC] },
  { group: 'Windows', op: 'calculator', label: 'Calculator', icon: 'calculator', start: 'calc.exe' },
  { group: 'Windows', op: 'snip', label: 'Snip (screenshot area)', icon: 'scan', keys: [VK.WIN, VK.SHIFT, VK.S] },
  { group: 'Windows', op: 'screenshot', label: 'Full screenshot to Pictures', icon: 'camera', keys: [VK.WIN, VK.PRINTSCREEN] },
  { group: 'Windows', op: 'clipboard_history', label: 'Clipboard history', icon: 'clipboard-list', keys: [VK.WIN, VK.V] },
  { group: 'Windows', op: 'emoji_panel', label: 'Emoji panel', icon: 'smile', keys: [VK.WIN, VK['.']] },

  { group: 'Editing', op: 'copy', label: 'Copy', icon: 'copy', keys: [VK.CTRL, VK.C] },
  { group: 'Editing', op: 'paste', label: 'Paste', icon: 'clipboard-paste', keys: [VK.CTRL, VK.V] },
  { group: 'Editing', op: 'cut', label: 'Cut', icon: 'scissors', keys: [VK.CTRL, VK.X] },
  { group: 'Editing', op: 'undo', label: 'Undo', icon: 'undo-2', keys: [VK.CTRL, VK.Z] },
  { group: 'Editing', op: 'redo', label: 'Redo', icon: 'redo-2', keys: [VK.CTRL, VK.Y] },
  { group: 'Editing', op: 'select_all', label: 'Select all', icon: 'text-select', keys: [VK.CTRL, VK.A] },

  { group: 'Power', op: 'lock', label: 'Lock PC', icon: 'lock', exec: ['rundll32.exe', ['user32.dll,LockWorkStation']] },
  { group: 'Power', op: 'sleep', label: 'Sleep', icon: 'moon', helper: 'SLEEP', confirm: true },
  { group: 'Power', op: 'signout', label: 'Sign out', icon: 'log-out', exec: ['shutdown.exe', ['/l']], confirm: true },
  { group: 'Power', op: 'restart', label: 'Restart', icon: 'rotate-ccw', exec: ['shutdown.exe', ['/r', '/t', '0']], confirm: true },
  { group: 'Power', op: 'shutdown', label: 'Shut down', icon: 'power', exec: ['shutdown.exe', ['/s', '/t', '0']], confirm: true },
];
const OPS_BY_ID = Object.fromEntries(SYSTEM_OPS.map((o) => [o.op, o]));

// ---------------------------------------------------------------------------
// Persistent PowerShell helper: compiled once, then each key press is ~instant.
// ---------------------------------------------------------------------------
const HELPER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PDKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
  static bool IsExt(byte vk) {
    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x5D ||
           (vk >= 0xA6 && vk <= 0xB7) || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
  }
  public static void Combo(byte[] keys) {
    foreach (byte k in keys) keybd_event(k, (byte)MapVirtualKey(k, 0), IsExt(k) ? 1u : 0u, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    for (int i = keys.Length - 1; i >= 0; i--)
      keybd_event(keys[i], (byte)MapVirtualKey(keys[i], 0), (IsExt(keys[i]) ? 1u : 0u) | 2u, UIntPtr.Zero);
  }
}
"@
# Sound controls (speaker volume and mute, microphone mute) through the Windows Core Audio API.
# Compiled separately so a problem here never stops the other actions.
$audioOk = $false
try {
Add-Type -TypeDefinition @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
namespace PDAudio {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p);
    int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float level);
    int GetChannelVolumeLevelScalar(uint ch, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }

  public static class Audio {
    // dataFlow 0 = speakers (render), 1 = microphone (capture); role 0 = the default device for most sound
    static IAudioEndpointVolume Endpoint(int flow) {
      try {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice dev;
        if (en.GetDefaultAudioEndpoint(flow, 0, out dev) != 0 || dev == null) return null;
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
        return o as IAudioEndpointVolume;
      } catch { return null; }
    }
    public static string State() {
      var spk = Endpoint(0);
      var mic = Endpoint(1);
      float vol = 0; bool mute = false, micMute = false;
      if (spk != null) { spk.GetMasterVolumeLevelScalar(out vol); spk.GetMute(out mute); }
      if (mic != null) mic.GetMute(out micMute);
      return string.Format(CultureInfo.InvariantCulture, "{0} {1} {2} {3} {4}",
        spk != null ? 1 : 0, (int)Math.Round(vol * 100), mute ? 1 : 0, mic != null ? 1 : 0, micMute ? 1 : 0);
    }
    public static void SetVolume(int percent) {
      var spk = Endpoint(0);
      if (spk == null) throw new Exception("No speakers found on this PC");
      Guid ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(spk.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, ref ctx));
      if (percent > 0) spk.SetMute(false, ref ctx);
    }
    public static bool IsMuted() {
      var spk = Endpoint(0);
      if (spk == null) throw new Exception("No speakers found on this PC");
      bool m; spk.GetMute(out m); return m;
    }
    public static void SetMute(bool mute) {
      var spk = Endpoint(0);
      if (spk == null) throw new Exception("No speakers found on this PC");
      Guid ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(spk.SetMute(mute, ref ctx));
    }
    public static void SetMicMute(bool mute) {
      var mic = Endpoint(1);
      if (mic == null) throw new Exception("No microphone found on this PC");
      Guid ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(mic.SetMute(mute, ref ctx));
    }
  }
}
"@
$audioOk = $true
} catch { [Console]::Error.WriteLine('Sound controls unavailable: ' + $_.Exception.Message) }
function Dec($b64) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64)) }
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ', 3)
  $id = $parts[0]; $cmd = $parts[1]; $arg = if ($parts.Length -gt 2) { $parts[2] } else { '' }
  $out = ''
  try {
    if ($cmd -like 'AUDIO*' -and -not $audioOk) { throw 'Sound controls are not available on this PC' }
    switch ($cmd) {
      'KEYS' { [PDKeys]::Combo([byte[]]($arg.Split(',') | ForEach-Object { [byte]$_ })) }
      'TEXT' {
        $t = Dec $arg
        $t = [regex]::Replace($t, '([\+\^%~\(\)\{\}\[\]])', '{$1}')
        $t = $t -replace "\r?\n", '{ENTER}'
        [System.Windows.Forms.SendKeys]::SendWait($t)
      }
      'START' {
        $o = (Dec $arg) | ConvertFrom-Json
        $p = @{ FilePath = $o.file }
        if ($o.args) { $p.ArgumentList = $o.args }
        if ($o.cwd) { $p.WorkingDirectory = $o.cwd }
        Start-Process @p
      }
      'RUN' { Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ' + (Dec $arg)) -WindowStyle Hidden }
      'SLEEP' { [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null }
      'AUDIO' { $out = [PDAudio.Audio]::State() }
      'AUDIOVOL' {
        # Tap volume up and down (no net change) so Windows shows its usual volume pop-up, then set the exact level.
        $p = [int]$arg
        $quiet = ($p -eq 0 -and [PDAudio.Audio]::IsMuted()) # a key press would unmute: skip the pop-up
        [PDAudio.Audio]::SetVolume($p)
        if ($quiet) { }
        elseif ($p -ge 98) { [PDKeys]::Combo([byte[]]@(0xAE)); [PDKeys]::Combo([byte[]]@(0xAF)) }
        else { [PDKeys]::Combo([byte[]]@(0xAF)); [PDKeys]::Combo([byte[]]@(0xAE)) }
        Start-Sleep -Milliseconds 150
        [PDAudio.Audio]::SetVolume($p)
      }
      'AUDIOMUTE' {
        # The mute key shows Windows' own pop-up; set it directly only if the key didn't do it.
        $want = ($arg -eq '1')
        if ([PDAudio.Audio]::IsMuted() -ne $want) {
          [PDKeys]::Combo([byte[]]@(0xAD))
          Start-Sleep -Milliseconds 150
          if ([PDAudio.Audio]::IsMuted() -ne $want) { [PDAudio.Audio]::SetMute($want) }
        }
      }
      'AUDIOMIC' { [PDAudio.Audio]::SetMicMute($arg -eq '1') }
      'PING' { }
      default { throw "Unknown command $cmd" }
    }
    [Console]::Out.WriteLine(("$id OK $out").TrimEnd())
  } catch {
    $msg = ($_.Exception.Message -replace "\r?\n", ' ')
    [Console]::Out.WriteLine("$id ERR $msg")
  }
}
`;

class WinHelper {
  constructor(log, dir) {
    this.log = log;
    this.dir = dir || os.tmpdir();
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.buf = '';
    this.ready = null;
  }

  start() {
    if (!IS_WIN) return;
    const file = path.join(this.dir, 'pocketdeck-helper.ps1');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    fs.writeFileSync(file, HELPER_PS1, 'utf8');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    let markReady;
    this.ready = new Promise((r) => { markReady = r; });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === 'READY') { markReady(); continue; }
        const [id, status, ...rest] = line.split(' ');
        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        status === 'OK' ? p.resolve(rest.join(' ')) : p.reject(new Error(rest.join(' ') || 'Action failed'));
      }
    });
    this.proc.stderr.on('data', (d) => this.log('[helper]', String(d).trim()));
    this.proc.on('exit', (code) => {
      this.log('[helper] exited', code);
      for (const p of this.pending.values()) p.reject(new Error('Helper stopped'));
      this.pending.clear();
      this.proc = null;
      setTimeout(() => this.start(), 1500);
    });
  }

  async send(cmd, arg = '') {
    if (!IS_WIN) { this.log('[dry-run]', cmd, arg); return; }
    if (!this.proc) this.start();
    await this.ready;
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${id} ${cmd} ${arg}\n`);
    });
  }

  stop() { if (this.proc) { this.proc.removeAllListeners('exit'); this.proc.kill(); this.proc = null; } }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] ?? m[2]);
  return out;
}

class ActionRunner {
  constructor(log = console.log, dir = null) {
    this.log = log;
    this.helper = new WinHelper(log, dir);
    this.helper.start();
    // Stand-in sound settings when not on Windows (development and tests).
    this.fakeAudio = { speakers: true, volume: 40, mute: false, mic: true, micMute: false };
  }

  exec(file, args) {
    if (!IS_WIN) { this.log('[dry-run] exec', file, args.join(' ')); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const p = spawn(file, args, { windowsHide: true, detached: true, stdio: 'ignore' });
      p.on('error', reject);
      p.on('spawn', () => { p.unref(); resolve(); });
    });
  }

  startFile(file, args, cwd) {
    const payload = { file };
    const list = Array.isArray(args) ? args : splitArgs(args);
    if (list.length) payload.args = list;
    if (cwd) payload.cwd = cwd;
    return this.helper.send('START', b64(JSON.stringify(payload)));
  }

  async run(action) {
    if (!action || !action.type || action.type === 'none' || action.type === 'page') return;
    switch (action.type) {
      case 'app':
        if (!action.path) throw new Error('No program chosen');
        {
          // Only real program files get a working folder; shortcuts and Start-menu entries bring their own.
          const isExe = /^[a-z]:\\.+\.(exe|bat|cmd)$/i.test(action.path);
          return this.startFile(action.path, action.args || '', action.cwd || (IS_WIN && isExe ? path.dirname(action.path) : ''));
        }
      case 'url': {
        let url = String(action.url || '').trim();
        if (!url) throw new Error('No website address');
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        return this.startFile(url);
      }
      case 'open':
        if (!action.path) throw new Error('No file or folder chosen');
        return this.startFile(action.path);
      case 'hotkey':
        return this.helper.send('KEYS', parseHotkey(action.keys).join(','));
      case 'text':
        return this.helper.send('TEXT', b64(action.text || ''));
      case 'command':
        if (!action.command) throw new Error('No command');
        return this.helper.send('RUN', b64(action.command));
      case 'system': {
        const op = OPS_BY_ID[action.op];
        if (!op) throw new Error('Unknown Windows action');
        if (op.keys) return this.helper.send('KEYS', op.keys.join(','));
        if (op.start) return this.startFile(op.start);
        if (op.helper) return this.helper.send(op.helper);
        if (op.exec) return this.exec(op.exec[0], op.exec[1]);
        return;
      }
      default:
        throw new Error(`Unknown action type "${action.type}"`);
    }
  }

  // ------------------------------------------------------------------ sound (volume slider and mute buttons on the device)
  /** { speakers, volume (0-100), mute, mic, micMute } for the PC's default speakers and microphone. */
  async audioState() {
    if (!IS_WIN) return { ...this.fakeAudio };
    const parts = String(await this.helper.send('AUDIO')).trim().split(/\s+/).map(Number);
    if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) throw new Error('Could not read the sound settings');
    return { speakers: parts[0] === 1, volume: Math.max(0, Math.min(100, parts[1])), mute: parts[2] === 1, mic: parts[3] === 1, micMute: parts[4] === 1 };
  }
  /** Applies any of { volume, mute, micMute }. */
  async setAudio(change) {
    if (!IS_WIN) {
      if (change.volume != null) { this.fakeAudio.volume = change.volume; if (change.volume > 0) this.fakeAudio.mute = false; }
      if (change.mute != null) this.fakeAudio.mute = change.mute;
      if (change.micMute != null) this.fakeAudio.micMute = change.micMute;
      this.log('[dry-run] audio', JSON.stringify(change));
      return;
    }
    if (change.volume != null) await this.helper.send('AUDIOVOL', String(change.volume));
    if (change.mute != null) await this.helper.send('AUDIOMUTE', change.mute ? '1' : '0');
    if (change.micMute != null) await this.helper.send('AUDIOMIC', change.micMute ? '1' : '0');
  }

  stop() { this.helper.stop(); }
}

module.exports = { ActionRunner, SYSTEM_OPS, OPS_BY_ID, parseHotkey };
