const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { DeviceManager } = require('./src/deviceManager');
const { SessionStore } = require('./src/sessionStore');
const { WsHub } = require('./src/wsHub');
const { Recorder } = require('./src/recorder');
const { Replayer } = require('./src/replayer');
const { createRouter } = require('./src/routes');
const {
  realSpawnGetEvent,
  realSendEvent,
  realCaptureScreenshot,
  realInputTap,
  realInputSwipe,
} = require('./src/adbIO');

const PORT = process.env.PORT || 4545;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const deviceManager = new DeviceManager();
const sessionStore = new SessionStore(SESSIONS_DIR);
const wsHub = new WsHub();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/sessions', express.static(SESSIONS_DIR));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(
  '/api',
  createRouter({
    deviceManager,
    sessionStore,
    wsHub,
    createRecorder: () =>
      new Recorder({
        sessionStore,
        spawnGetEvent: realSpawnGetEvent,
        captureScreenshot: realCaptureScreenshot,
      }),
    createReplayer: () =>
      new Replayer({
        sessionStore,
        sendEvent: realSendEvent,
        inputTap: realInputTap,
        inputSwipe: realInputSwipe,
      }),
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let subscribedSession = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'subscribe') {
      subscribedSession = msg.session;
      wsHub.subscribe(subscribedSession, ws);
    }
  });
  ws.on('close', () => {
    if (subscribedSession) wsHub.unsubscribe(subscribedSession, ws);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`adb-recorder listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
