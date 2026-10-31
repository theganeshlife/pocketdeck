// Run the PocketDeck server without the desktop window (handy for development).
const path = require('path');
const os = require('os');
const { Store } = require('./store');
const { ActionRunner } = require('./actions');
const { createServer } = require('./server');
const { ActivityLog } = require('./activity-log');

const dir = process.env.POCKETDECK_DATA || path.join(os.homedir(), '.pocketdeck');
const store = new Store(dir);
const runner = new ActionRunner();
const server = createServer({ store, runner, activity: new ActivityLog(dir), port: Number(process.env.PORT) || 8765, localKey: process.env.POCKETDECK_LOCAL_KEY || null });
server.listen().then((port) => {
  console.log(`Editor:    http://localhost:${port}/editor/#key=${server.localKey}`);
  console.log(`PIN:       ${store.auth.pin}`);
});
process.on('SIGINT', () => { server.close(); runner.stop(); process.exit(0); });
