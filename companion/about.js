/* PocketDeck: shared "About" details and the few optional internet calls (used by the PC app, the editor and the Android app). */
(function (root) {
  const API = 'https://gacharya.com/api/pocketdeck';
  const ABOUT = {
    app: 'PocketDeck',
    creator: 'Ganesh Acharya',
    api: API,
    feedbackUrl: 'https://gacharya.com/contact?topic=something-else',
    momoUrl: 'https://buymemomo.com/gacharya',
    blurb: 'PocketDeck is a free and open app.',
    momo: 'If you’re happy with it, you can buy me a plate of momo.',
    privacy: 'PocketDeck doesn’t collect, sell or share your personal data. Your deck, name and photo stay on your PC and your Android device. A small activity log (which actions worked or failed) stays on your devices to help fix problems. Only three things ever go to the developer, and only when you choose them: a star rating (just the number of stars), an error report when you tap Send report, and the version number when you check for updates. The camera is used only to scan the PocketDeck QR code, on the device itself.',
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Splits "1.0.0-b2410262140" into the version and the build stamp (DDMMYYHHMM, Australian Eastern time). */
  function parse(version) {
    const m = /^(\d+(?:\.\d+)*)(?:-b(\d{10}))?$/.exec(String(version || '').trim());
    if (!m) return null;
    const b = m[2];
    return {
      version: m[1],
      build: b || '',
      month: b ? Number(b.slice(2, 4)) : 0,
      year: b ? 2000 + Number(b.slice(4, 6)) : 0,
      // the build stamp in an order that sorts by time: YYMMDDHHMM
      order: b ? Number(b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2) + b.slice(6)) : 0,
    };
  }

  /** "1.0.0-b2410262140" -> "Version 1.0.0 (October, 2026) Build 2410262140". */
  ABOUT.versionLabel = function (version) {
    const p = parse(version);
    if (!p) return String(version || '');
    if (!p.build || p.month < 1 || p.month > 12) return `Version ${p.version}`;
    return `Version ${p.version} (${MONTHS[p.month - 1]}, ${p.year}) Build ${p.build}`;
  };

  /** Compares two versions ("1.0.0-b2410262140"): first the version number, then the build time. Returns -1, 0 or 1. */
  ABOUT.compareVersions = function (a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return 0;
    const xa = x.version.split('.').map(Number);
    const ya = y.version.split('.').map(Number);
    for (let i = 0; i < Math.max(xa.length, ya.length, 3); i++) {
      const d = (xa[i] || 0) - (ya[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return x.order === y.order ? 0 : x.order > y.order ? 1 : -1;
  };

  const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  /** Asks gacharya.com for the newest version. Sends only the app type and the current version. */
  ABOUT.checkForUpdate = async function (app, current) {
    try {
      const r = await fetch(`${API}/version?app=${encodeURIComponent(app)}&v=${encodeURIComponent(current || '')}`, { signal: timeout(8000) });
      if (!r.ok) throw new Error();
      const data = await r.json();
      const latest = data && data[app] && data[app].version;
      if (!latest) throw new Error();
      if (ABOUT.compareVersions(latest, current) > 0) {
        return { update: true, version: latest, url: data[app].url || '', message: `A newer version is available: PocketDeck ${ABOUT.versionLabel(latest)}.${data[app].url ? ' Open the download page to get it.' : ''}` };
      }
      return { update: false, version: latest, message: 'You have the latest version of PocketDeck.' };
    } catch {
      return { update: false, error: true, message: 'Couldn’t check for updates right now. Check the internet connection and try again later.' };
    }
  };

  /** Sends an anonymous star rating (1–5) with the app type and version. Nothing else. */
  ABOUT.sendRating = async function (app, version, stars) {
    try {
      const r = await fetch(`${API}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, version: String(version || '').slice(0, 20), stars }),
        signal: timeout(8000),
      });
      return r.ok;
    } catch {
      return false;
    }
  };

  /** Sends an error report the person agreed to send. */
  ABOUT.sendReport = async function (report) {
    try {
      const r = await fetch(`${API}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app: String(report.app || '').slice(0, 20),
          version: String(report.version || '').slice(0, 20),
          platform: String(report.platform || '').slice(0, 200),
          error: String(report.error || '').slice(0, 4000),
          log: String(report.log || '').slice(-12000),
        }),
        signal: timeout(10000),
      });
      return r.ok;
    } catch {
      return false;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ABOUT;
  else root.PocketDeckAbout = ABOUT;
})(typeof window !== 'undefined' ? window : globalThis);
