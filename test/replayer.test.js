const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Replayer } = require('../src/replayer');

const FIXTURE = [
  '[   100.000000] /dev/input/event2: 0003 0035 000005a0',
  '[   100.000000] /dev/input/event2: 0003 0036 00000410',
  '[   100.000000] /dev/input/event2: 0001 014a 00000001',
  '[   100.000000] /dev/input/event2: 0000 0000 00000000',
  '[   100.050000] /dev/input/event2: 0001 014a 00000000',
  '[   100.050000] /dev/input/event2: 0000 0000 00000000',
  '[   101.000000] /dev/input/event2: 0003 0035 00000100',
  '[   101.000000] /dev/input/event2: 0003 0036 00000200',
  '[   101.000000] /dev/input/event2: 0001 014a 00000001',
  '[   101.000000] /dev/input/event2: 0000 0000 00000000',
  '[   101.100000] /dev/input/event2: 0003 0035 00000300',
  '[   101.100000] /dev/input/event2: 0003 0036 00000200',
  '[   101.100000] /dev/input/event2: 0000 0000 00000000',
  '[   101.200000] /dev/input/event2: 0001 014a 00000000',
  '[   101.200000] /dev/input/event2: 0000 0000 00000000',
].join('\n');

test('replay sends every line in order with correct relative delays and reports progress per gesture', async () => {
  const sessionStore = { getEventsLog: () => FIXTURE };
  const sent = [];
  const sleeps = [];
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async (serial, devicePath, typeHex, codeHex, valueHex) => {
      sent.push({ serial, devicePath, typeHex, codeHex, valueHex });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const progress = [];
  replayer.on('progress', (p) => progress.push(p));
  let done = false;
  replayer.on('done', () => {
    done = true;
  });

  await replayer.replay('demo', 'emulator-5554');

  assert.equal(sent.length, 15);
  assert.equal(sent[0].typeHex, '0003');
  assert.equal(sent[0].codeHex, '0035');
  assert.equal(sent[0].valueHex, '000005a0');
  assert.equal(sent[0].serial, 'emulator-5554');
  assert.equal(sent[0].devicePath, '/dev/input/event2');

  assert.deepEqual(progress.map((p) => p.type), ['tap', 'swipe']);
  assert.equal(done, true);

  // gap between the two gestures is ~0.95s -> ~950ms sleep somewhere in the sequence
  assert.ok(sleeps.some((ms) => ms > 900 && ms < 1000));
});

test('replay falls back to input tap/swipe when sendevent is denied (unrooted device)', async () => {
  const sessionStore = {
    getEventsLog: () => FIXTURE,
    getSession: () => ({
      device: { resolution: '1440x3120', absMaxX: 1439, absMaxY: 3119 },
    }),
  };
  const sent = [];
  const taps = [];
  const swipes = [];
  const sleeps = [];
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {
      throw new Error('/dev/input/event2: Permission denied');
    },
    inputTap: async (serial, x, y) => taps.push({ serial, x, y }),
    inputSwipe: async (serial, x0, y0, x1, y1, durationMs) =>
      swipes.push({ serial, x0, y0, x1, y1, durationMs }),
    sleep: async (ms) => sleeps.push(ms),
  });

  const progress = [];
  replayer.on('progress', (p) => progress.push(p));
  let done = false;
  replayer.on('done', () => {
    done = true;
  });

  await replayer.replay('demo', 'emulator-5554');

  assert.equal(sent.length, 0);
  // FIXTURE tap at raw (1440,1040) with absMax (1439,3119) on a 1440x3120 screen
  assert.equal(taps.length, 1);
  assert.equal(taps[0].serial, 'emulator-5554');
  assert.equal(taps[0].x, 1440); // 1440/1439*1440 rounded, clamped to width
  assert.equal(taps[0].y, 1040);
  // FIXTURE swipe raw (256,512)->(768,512) over 0.2s
  assert.equal(swipes.length, 1);
  assert.equal(swipes[0].x0, 256);
  assert.equal(swipes[0].y0, 512);
  assert.equal(swipes[0].x1, 768);
  assert.equal(swipes[0].durationMs, 200);
  // the ~0.95s gap between gestures is preserved
  assert.ok(sleeps.some((ms) => ms > 900 && ms < 1000));
  assert.deepEqual(progress.map((p) => p.type), ['tap', 'swipe']);
  assert.equal(done, true);
});

test('input fallback defaults absMax to 32767 when the session predates abs range capture', async () => {
  const trackingFixture = [
    '[   200.000000] /dev/input/event1: 0003 0039 00000007',
    '[   200.000000] /dev/input/event1: 0003 0035 00003fff', // raw 16383 = mid-screen
    '[   200.000000] /dev/input/event1: 0003 0036 00003fff',
    '[   200.000000] /dev/input/event1: 0000 0000 00000000',
    '[   200.100000] /dev/input/event1: 0003 0039 ffffffff',
    '[   200.100000] /dev/input/event1: 0000 0000 00000000',
  ].join('\n');
  const sessionStore = {
    getEventsLog: () => trackingFixture,
    getSession: () => ({ device: { resolution: '1080x2424' } }),
  };
  const taps = [];
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {
      throw new Error('Permission denied');
    },
    inputTap: async (serial, x, y) => taps.push({ x, y }),
    inputSwipe: async () => {},
    sleep: async () => {},
  });

  await replayer.replay('demo', 'emulator-5556');

  assert.equal(taps.length, 1);
  assert.equal(taps[0].x, 540); // 16383/32767 * 1080
  assert.equal(taps[0].y, 1212);
});

test('replay rejects with a clear message when events.log is empty', async () => {
  const sessionStore = { getEventsLog: () => '' };
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {},
  });

  await assert.rejects(() => replayer.replay('demo', 'emulator-5554'), /empty or contains no valid recorded events/);
});

test('replay rejects with a clear message when events.log contains no parseable lines', async () => {
  const sessionStore = { getEventsLog: () => 'garbage\nnot an event line\n' };
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {},
  });

  await assert.rejects(() => replayer.replay('demo', 'emulator-5554'), /empty or contains no valid recorded events/);
});
