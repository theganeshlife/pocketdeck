# PocketDeck security

PocketDeck is built by Ganesh Acharya to be safe by default. This page explains how it protects your PC and your Android device, and how to report a problem.

## How PocketDeck is protected

**Pairing**
- An Android device can only pair while **Connect device** is open on the PC, and for at most 5 minutes at a time.
- Pairing needs the 6-digit PIN shown on the PC. Wrong PINs are rate-limited, and after 10 wrong attempts the PIN is replaced and pairing closes, so guessing it is not practical.
- Each paired device gets its own long random key, which you can revoke in **Connect device → Paired devices**.
- Trust is chosen on both sides. A device marked as not trusted on the PC loses its key when it disconnects, so it needs the PIN again. On the Android device, an untrusted PC is not remembered.
- The PIN changes every minute (and the QR code with it), after every successful pairing, and whenever the PC removes a device. A new pairing starts as a one-time connection; it becomes saved and trusted only when the person chooses Save for future use, and a one-time connection is removed from the PC on disconnect.
- The PC has the final say: a device it disconnects and forgets loses its key at once and needs a new PIN.
- The Android app asks for the camera only when you tap Scan QR code, uses it only on the device, and only for the PocketDeck code. The page inside the app may use no other device permission.
- Update checks, star ratings and error reports go only to gacharya.com over HTTPS, and only when the person uses them. Ratings carry no identifying data; error reports are sent only after the person agrees and never include typed text, commands, names, photos or locations.

**What a paired device can do**
- A paired device can only press the keys you set up. It cannot send new commands, read files or change your deck.

**The PC editor**
- The editor and its settings are only reachable from the PC itself, through the PocketDeck window.
- Every editor request needs a secret key that changes each time PocketDeck starts. That stops web pages open in your browser from talking to PocketDeck (cross-site requests and DNS-rebinding are both blocked).
- The desktop app runs its pages in a sandbox with context isolation, no system access, no extra windows, and no camera, microphone or location permissions. It can't be steered to other websites.
- Build-time safety switches turn off features attackers misuse: running as a script host, start-up options injected through the environment, debugging flags, and loading app code from outside its packaged archive.
- Pages are served with a strict Content Security Policy, and anti-framing and no-sniff headers.

**Checking what comes in**
- Every setting, key, name and image is checked before it is saved or sent to a device: unexpected values are dropped, text is length-limited, colours must be real colours and images must be real images under a size limit.

**The Android app**
- The WebView only loads PocketDeck's own bundled page. It has no file, content or cross-origin access, and links open in your browser.
- Anything received from the PC (icons, images, names) is cleaned before it is shown.
- Deep links only pre-fill the connect form; you always tap **Connect** yourself.
- App backups and WebView usage metrics are turned off.

**Updates and dependencies**
- Builds use current, supported versions of the desktop framework and all dependencies. `npm audit` reports no known vulnerabilities.

## Known limits

Traffic between the Android device and the PC stays on your own Wi-Fi but is not encrypted. Someone who already has your Wi-Fi password and captures the traffic could see which keys you press. Use PocketDeck on a private network (home Wi-Fi), not on public or guest Wi-Fi.

## Reporting a problem

If you find a security issue, please tell Ganesh privately through [gacharya.com/contact](https://gacharya.com/contact?topic=something-else) and choose "Something else", rather than posting it publicly.
