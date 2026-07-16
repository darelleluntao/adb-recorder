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
  let onExitCb = null;
  return {
    onLine(cb) {
      onLineCb = cb;
    },
    onExit(cb) {
      onExitCb = cb;
    },
    kill() {
      this.killed = true;
    },
    feed(line) {
      onLineCb(line);
    },
    exit() {
      if (onExitCb) onExitCb();
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

test('recording two sequential gestures increments stepIndex and saves both', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const screenshotCalls = [];
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async (serial) => {
      screenshotCalls.push(serial);
      return Buffer.from(`fake-png-${screenshotCalls.length}`);
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
  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  assert.equal(steps.length, 2);
  assert.equal(steps[0].index, 0);
  assert.equal(steps[1].index, 1);
  assert.equal(screenshotCalls.length, 2);

  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 2);
  assert.equal(
    fs.readFileSync(path.join(sessionStore.sessionPath('demo'), 'screenshots', 'step-0.png'), 'utf8'),
    'fake-png-1'
  );
  assert.equal(
    fs.readFileSync(path.join(sessionStore.sessionPath('demo'), 'screenshots', 'step-1.png'), 'utf8'),
    'fake-png-2'
  );
});

test('a captureScreenshot rejection during a gesture does not crash the process and is surfaced via an error event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async () => {
      throw new Error('device disconnected');
    },
  });

  const errors = [];
  const errorPromise = new Promise((resolve) => {
    recorder.on('error', (err) => {
      errors.push(err);
      resolve();
    });
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
  await errorPromise;

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /device disconnected/);
  assert.equal(steps.length, 0);

  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 0);
});

test('a captureScreenshot rejection with NO error listener attached does not crash and does not consume a stepIndex', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  let shouldFail = true;
  const screenshotCalls = [];
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async (serial) => {
      screenshotCalls.push(serial);
      if (shouldFail) {
        throw new Error('device disconnected');
      }
      return Buffer.from('fake-png');
    },
  });

  // Deliberately do NOT attach an 'error' listener. Per Node's EventEmitter,
  // emit('error', ...) with zero listeners throws synchronously; the fix
  // must guard against that so the process never crashes here.
  const steps = [];
  recorder.on('step', (step) => steps.push(step));

  await recorder.start('demo', {
    serial: 'emulator-5554',
    node: '/dev/input/event2',
    device: { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });

  // First gesture: captureScreenshot rejects. If the process were going to
  // crash from an unhandled rejection / thrown 'error' emit, it would happen
  // during this feed loop.
  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  assert.equal(steps.length, 0);

  // Second gesture: captureScreenshot now succeeds, proving processing
  // continued normally after the failure above (no crash) and that the
  // failed gesture did not consume a stepIndex — numbering stays contiguous
  // starting at 0.
  shouldFail = false;
  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  assert.equal(steps.length, 1);
  assert.equal(steps[0].index, 0);

  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 1);
  assert.equal(
    fs.readFileSync(path.join(sessionStore.sessionPath('demo'), 'screenshots', 'step-0.png'), 'utf8'),
    'fake-png'
  );
});

test('stop() before start() does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => fakeSpawn(),
    captureScreenshot: async () => Buffer.from(''),
  });

  assert.doesNotThrow(() => recorder.stop());
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

test('stop() is idempotent: calling it twice only emits stopped once', async () => {
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

  let stoppedCount = 0;
  recorder.on('stopped', () => {
    stoppedCount++;
  });
  recorder.stop();
  recorder.stop();

  assert.equal(stoppedCount, 1);
});

test('unexpected child process exit (e.g. device unplugged) triggers a graceful stop', async () => {
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

  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  let stopped = false;
  recorder.on('stopped', () => {
    stopped = true;
  });

  spawn.exit();

  assert.equal(stopped, true);

  // partial session (the gesture recorded before the unplug) is preserved
  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 1);
});
