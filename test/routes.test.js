const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { EventEmitter } = require('events');
const { createRouter } = require('../src/routes');

function startTestServer({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function fakeDeviceManager(devices, infoBySerial) {
  return {
    listDevices: async () => devices,
    getDeviceInfo: async (serial) => infoBySerial[serial],
    findTouchDevices: async () => [{ node: '/dev/input/event2', absMaxX: 1439, absMaxY: 3119 }],
  };
}

function fakeSessionStore(initial = {}) {
  const sessions = { ...initial };
  return {
    rootDir: '/tmp/fake',
    listSessions: () => Object.keys(sessions),
    getSession: (name) => sessions[name] || null,
    deleteSession: (name) => delete sessions[name],
    _sessions: sessions,
  };
}

test('GET /api/devices returns device info for each connected serial', async () => {
  const deviceManager = fakeDeviceManager(['emulator-5554'], {
    'emulator-5554': { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });
  const server = await startTestServer({
    deviceManager,
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/devices`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' }]);
  server.close();
});

test('GET /api/sessions/:name returns 404 for unknown session', async () => {
  const server = await startTestServer({
    deviceManager: fakeDeviceManager([], {}),
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/nope`);
  assert.equal(res.status, 404);
  server.close();
});

test('POST /api/sessions starts a recorder and returns 201', async () => {
  const deviceManager = fakeDeviceManager(['emulator-5554'], {
    'emulator-5554': { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });
  let startedWith = null;
  class FakeRecorder extends EventEmitter {
    async start(name, opts) {
      startedWith = { name, opts };
    }
  }
  const server = await startTestServer({
    deviceManager,
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new FakeRecorder(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', serial: 'emulator-5554' }),
  });
  assert.equal(res.status, 201);
  assert.equal(startedWith.name, 'demo');
  assert.equal(startedWith.opts.serial, 'emulator-5554');
  server.close();
});

test('POST /api/sessions/:name/replay returns 409 on device mismatch without force', async () => {
  const deviceManager = fakeDeviceManager(['emulator-9999'], {
    'emulator-9999': { serial: 'emulator-9999', model: 'OtherPhone', resolution: '1080x2400' },
  });
  const sessionStore = fakeSessionStore({
    demo: {
      name: 'demo',
      device: { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
      steps: [],
    },
  });
  const server = await startTestServer({
    deviceManager,
    sessionStore,
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/demo/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial: 'emulator-9999', force: false }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.mismatch, true);
  server.close();
});

test('DELETE /api/sessions/:name deletes the session', async () => {
  const sessionStore = fakeSessionStore({ demo: { name: 'demo', device: {}, steps: [] } });
  const server = await startTestServer({
    deviceManager: fakeDeviceManager([], {}),
    sessionStore,
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/demo`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(sessionStore.listSessions(), []);
  server.close();
});

test('DELETE /api/sessions/:name stops an active recorder before deleting', async () => {
  const deviceManager = fakeDeviceManager(['emulator-5554'], {
    'emulator-5554': { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });
  let stopCalled = false;
  class FakeRecorder extends EventEmitter {
    async start(name, opts) {}
    stop() {
      stopCalled = true;
    }
  }
  const sessionStore = fakeSessionStore();
  const server = await startTestServer({
    deviceManager,
    sessionStore,
    wsHub: { broadcast() {} },
    createRecorder: () => new FakeRecorder(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();

  await fetch(`http://localhost:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', serial: 'emulator-5554' }),
  });

  const res = await fetch(`http://localhost:${port}/api/sessions/demo`, { method: 'DELETE' });

  assert.equal(res.status, 200);
  assert.equal(stopCalled, true);
  assert.deepEqual(sessionStore.listSessions(), []);
  server.close();
});

test('POST /api/sessions rejects a path-traversal session name', async () => {
  const server = await startTestServer({
    deviceManager: fakeDeviceManager([], {}),
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../evil', serial: 'emulator-5554' }),
  });
  assert.equal(res.status, 400);
  server.close();
});
