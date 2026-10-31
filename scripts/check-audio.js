// CI check (Windows only): the sound helper behind the device's volume slider and mute buttons compiles and
// reads the sound settings. Build machines may have no speakers or microphone; reading must still work.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { ActionRunner } = require('../src/actions');

(async () => {
  const lines = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-audio-'));
  const runner = new ActionRunner((...a) => lines.push(a.join(' ')), dir);
  let failed = false;
  try {
    const state = await runner.audioState();
    console.log('Sound settings read:', JSON.stringify(state));
    if (typeof state.volume !== 'number' || state.volume < 0 || state.volume > 100) throw new Error('Volume out of range');
    if (state.speakers) {
      // Set the volume to what it already is, so nothing changes on the build machine.
      await runner.setAudio({ volume: state.volume, mute: state.mute });
      console.log('Setting the volume works');
    }
  } catch (e) {
    failed = true;
    console.error('::error::The sound helper failed: ' + e.message);
  }
  for (const l of lines) console.log('::warning::' + l.replace(/\r?\n/g, ' '));
  runner.stop();
  process.exit(failed ? 1 : 0);
})();
