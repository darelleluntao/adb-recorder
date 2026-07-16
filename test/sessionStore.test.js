const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../src/sessionStore');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  return new SessionStore(dir);
}

test('createSession writes device.json, empty steps.json, empty events.log', () => {
  const store = tmpStore();
  const device = { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' };
  store.createSession('demo', device);

  const dir = store.sessionPath('demo');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8')), device);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8')), []);
  assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8'), '');
  assert.ok(fs.existsSync(path.join(dir, 'screenshots')));
});

test('createSession throws if session already exists', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  assert.throws(() => store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' }));
});

test('appendEvents and addStep accumulate correctly', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  store.appendEvents('demo', ['line1', 'line2']);
  store.appendEvents('demo', ['line3']);
  assert.equal(store.getEventsLog('demo'), 'line1\nline2\nline3\n');

  store.addStep('demo', { index: 0, type: 'tap' });
  store.addStep('demo', { index: 1, type: 'swipe' });
  const session = store.getSession('demo');
  assert.equal(session.steps.length, 2);
  assert.equal(session.steps[1].type, 'swipe');
});

test('saveScreenshot writes the buffer to screenshots/step-N.png', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  const file = store.saveScreenshot('demo', 0, Buffer.from('fake-png-bytes'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'fake-png-bytes');
});

test('listSessions / deleteSession', () => {
  const store = tmpStore();
  store.createSession('a', { serial: 'x', model: 'x', resolution: 'x' });
  store.createSession('b', { serial: 'x', model: 'x', resolution: 'x' });
  assert.deepEqual(store.listSessions().sort(), ['a', 'b']);
  store.deleteSession('a');
  assert.deepEqual(store.listSessions(), ['b']);
});

test('getSession returns null for unknown session', () => {
  const store = tmpStore();
  assert.equal(store.getSession('nope'), null);
});
