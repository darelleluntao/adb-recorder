const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder } = require('../src/recorder');
const { SessionStore } = require('../src/sessionStore');

const TAP_LINES = [
  '[   100.000000] /dev/input/event2: 0003 0035 000005a0',
  '[   100.000000] /dev/input/event2: 0003 0036 00000410',
  '[   100.000000] /dev/input/event2: 0001 014a 00000001',
  '[   100.000000] /dev/input/event2: 0000 0000 00000000',
  '[   100.050000] /dev/input/event2: 0001 014a 00000000',
  '[   100.050000] /dev/input/event2: 0000 0000 00000000',
];

function fakeSpawn() {
  let onLineCb = null;
  return {
    onLine(cb) {
      onLineCb = cb;
    },
    kill() {
      this.killed = true;
    },
    feed(line) {
      onLineCb(line);
    },
  };
}

test('recording a tap gesture saves a step and screenshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const screenshotCalls = [];
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async (serial) => {
      screenshotCalls.push(serial);
      return Buffer.from('fake-png');
    },
  });

  const steps = [];
  recorder.on('step', (step) => steps.push(step));

  await recorder.start('demo', {
    serial: 'emulator-5554',
    node: '/dev/input/event2',
    device: { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });

  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'tap');
  assert.equal(steps[0].index, 0);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0], 'emulator-5554');

  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 1);
  assert.equal(
    fs.readFileSync(path.join(sessionStore.sessionPath('demo'), 'screenshots', 'step-0.png'), 'utf8'),
    'fake-png'
  );
  assert.equal(sessionStore.getEventsLog('demo').split('\n').filter(Boolean).length, TAP_LINES.length);
});

test('stop() kills the child process and emits stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async () => Buffer.from(''),
  });
  await recorder.start('demo', {
    serial: 'x',
    node: '/dev/input/event2',
    device: { serial: 'x', model: 'x', resolution: 'x' },
  });

  let stopped = false;
  recorder.on('stopped', () => {
    stopped = true;
  });
  recorder.stop();

  assert.equal(spawn.killed, true);
  assert.equal(stopped, true);
});
