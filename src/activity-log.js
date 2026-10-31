// Local activity log: what succeeded and what failed, kept only on this PC to help track down problems.
// It never records personal content: no typed text, commands, PINs, tokens, IP addresses or locations.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // keep about 1 MB, plus one older file

class ActivityLog {
  constructor(dir) {
    this.dir = path.join(dir, 'logs');
    this.file = path.join(this.dir, 'activity.log');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }

  write(level, event, detail = '') {
    const line = `${new Date().toISOString()}  ${level.padEnd(5)}  ${event}${detail ? '  ' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : ''}\n`;
    try {
      const st = fs.existsSync(this.file) ? fs.statSync(this.file) : null;
      if (st && st.size > MAX_BYTES) fs.renameSync(this.file, this.file.replace(/\.log$/, '.old.log'));
      fs.appendFileSync(this.file, line);
    } catch { /* logging must never break the app */ }
  }

  ok(event, detail) { this.write('OK', event, detail); }
  fail(event, detail) { this.write('FAIL', event, detail); }
  info(event, detail) { this.write('INFO', event, detail); }

  read(maxLines = 400) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n');
      return lines.slice(-maxLines).join('\n');
    } catch { return ''; }
  }

  clear() {
    for (const f of [this.file, this.file.replace(/\.log$/, '.old.log')]) { try { fs.unlinkSync(f); } catch {} }
  }
}

/** Describes an action for the log without its private contents (no typed text or command lines). */
function describeAction(a) {
  if (!a) return 'none';
  switch (a.type) {
    case 'app': return 'app ' + (a.appName || path.basename(String(a.path || '')).replace(/\.(exe|lnk)$/i, ''));
    case 'url': { try { return 'website ' + new URL(/^[a-z]+:/i.test(a.url) ? a.url : 'https://' + a.url).hostname; } catch { return 'website'; } }
    case 'open': return 'open file/folder';
    case 'hotkey': return 'shortcut ' + (a.keys || '');
    case 'text': return 'type text';
    case 'command': return 'command';
    case 'system': return 'windows ' + (a.op || '');
    case 'page': return 'switch page';
    default: return a.type;
  }
}

module.exports = { ActivityLog, describeAction };
