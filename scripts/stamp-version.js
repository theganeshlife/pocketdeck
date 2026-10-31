// Run by the cloud build before building (both the Windows and Android jobs).
// Adds the build stamp to the version: "1.0.0" becomes "1.0.0-b2410262140", where the stamp is the date and
// time of the commit being built, in Australian Eastern time (AEST/AEDT), as DDMMYYHHMM. Using the commit time (not the clock)
// gives the Windows and Android builds of the same code the same build number.
// The apps show it as "Version 1.0.0 (October, 2026) Build 2410262140".
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const base = String(pkg.version).replace(/-.*$/, '');

const seconds = Number(execSync('git log -1 --format=%ct', { cwd: root }).toString().trim());
const when = new Date(seconds * 1000);
const part = (type) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', [type]: '2-digit', hour12: false })
  .formatToParts(when).find((p) => p.type === type).value.padStart(2, '0').slice(-2);
const stamp = `${part('day')}${part('month')}${part('year')}${part('hour') === '24' ? '00' : part('hour')}${part('minute')}`;
if (!/^\d{10}$/.test(stamp)) throw new Error('Bad build stamp: ' + stamp);
const version = `${base}-b${stamp}`;

// Windows app (and the deck the PC serves to browsers)
pkg.version = version;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

// Android app. versionCode must always grow: minutes since 24 Oct 2026, on top of the last date-based code.
const gradle = path.join(root, 'android', 'app', 'build.gradle.kts');
const code = 2026102500 + Math.floor((seconds - Date.UTC(2026, 9, 24) / 1000) / 60);
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode = \d+/, `versionCode = ${code}`).replace(/versionName = "[^"]*"/, `versionName = "${version}"`);
fs.writeFileSync(gradle, g);

console.log(`Version ${version} (Android versionCode ${code})`);
