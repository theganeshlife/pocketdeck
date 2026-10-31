// CI check (Windows only): the Start-menu icon helper compiles and saves real PNG icons.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractStartIcons, startIconFile, iconErrors } = require('../src/installed-apps');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-icons-'));
  const targets = [process.env.SystemRoot + '\\System32\\notepad.exe', 'Microsoft.Windows.Explorer'];
  await extractStartIcons(targets, base);
  let ok = 0;
  for (const t of targets) {
    const file = await startIconFile(t, base);
    const png = file && fs.readFileSync(file);
    const valid = png && png.length > 100 && png.slice(1, 4).toString() === 'PNG';
    console.log(`${t}: ${valid ? `icon saved (${png.length} bytes)` : 'no icon'}`);
    if (valid) ok++;
  }
  if (iconErrors.last) console.log(iconErrors.last.split(/\r?\n/).map((l) => '::warning::' + l).join('\n'));
  if (!ok) { console.error('::error::The Start-menu icon helper produced no icons'); process.exit(1); }
})();
