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
  assert.equal(taps[0].x, 1439); // 1440/1440*1440 rounded, clamped inside the screen
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

test('input fallback scales the tap threshold, caps idle gaps, and clamps to screen bounds', async () => {
  // finger jitter of 73 raw units (~2px at 32767 raw / 1080px) must stay a
  // tap, exactly as the recorder classified it; a 13s recorded pause must
  // not stall the replay; raw values at the abs maximum must not scale to
  // an out-of-bounds pixel (== width).
  const fixture = [
    '[   100.000000] /dev/input/event1: 0003 0039 00000007',
    '[   100.000000] /dev/input/event1: 0003 0035 00004843', // 18499
    '[   100.000000] /dev/input/event1: 0003 0036 00004e92', // 20114
    '[   100.000000] /dev/input/event1: 0000 0000 00000000',
    '[   100.050000] /dev/input/event1: 0003 0035 00004806', // 18438 (-61 jitter)
    '[   100.050000] /dev/input/event1: 0000 0000 00000000',
    '[   100.122000] /dev/input/event1: 0003 0039 ffffffff',
    '[   100.122000] /dev/input/event1: 0000 0000 00000000',
    // 13s idle pause, then a tap at the raw maximum corner
    '[   113.122000] /dev/input/event1: 0003 0039 00000008',
    '[   113.122000] /dev/input/event1: 0003 0035 00007fff', // 32767
    '[   113.122000] /dev/input/event1: 0003 0036 00007fff',
    '[   113.122000] /dev/input/event1: 0000 0000 00000000',
    '[   113.200000] /dev/input/event1: 0003 0039 ffffffff',
    '[   113.200000] /dev/input/event1: 0000 0000 00000000',
  ].join('\n');
  const sessionStore = {
    getEventsLog: () => fixture,
    getSession: () => ({
      device: { resolution: '1080x2424', absMaxX: 32767, absMaxY: 32767 },
    }),
  };
  const taps = [];
  const swipes = [];
  const sleeps = [];
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {
      throw new Error('Permission denied');
    },
    inputTap: async (serial, x, y) => taps.push({ x, y }),
    inputSwipe: async (serial, x0, y0, x1, y1, durationMs) => swipes.push({ x0, y0 }),
    sleep: async (ms) => sleeps.push(ms),
  });

  await replayer.replay('demo', 'emulator-5556');

  assert.equal(swipes.length, 0, 'jittery tap must not be replayed as a swipe');
  assert.equal(taps.length, 2);
  assert.ok(sleeps.every((ms) => ms <= 3000), `idle gaps must be capped at 3s, got ${sleeps}`);
  assert.equal(taps[1].x, 1079, 'raw max must clamp inside the screen');
  assert.equal(taps[1].y, 2423);
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

test('input fallback replays typed text and action keys interleaved with touches', async () => {
  const fixture = [
    // tap on the email field
    '[   100.000000] /dev/input/event1: 0003 0039 00000007',
    '[   100.000000] /dev/input/event1: 0003 0035 00002000',
    '[   100.000000] /dev/input/event1: 0003 0036 00002000',
    '[   100.000000] /dev/input/event1: 0000 0000 00000000',
    '[   100.100000] /dev/input/event1: 0003 0039 ffffffff',
    '[   100.100000] /dev/input/event1: 0000 0000 00000000',
    // type "hi" then Enter on the keyboard device
    '[   101.000000] /dev/input/event12: 0001 0023 00000001',
    '[   101.000000] /dev/input/event12: 0000 0000 00000000',
    '[   101.100000] /dev/input/event12: 0001 0017 00000001',
    '[   101.100000] /dev/input/event12: 0000 0000 00000000',
    '[   101.200000] /dev/input/event12: 0001 001c 00000001',
    '[   101.200000] /dev/input/event12: 0000 0000 00000000',
    // tap Sign In
    '[   102.000000] /dev/input/event1: 0003 0039 00000008',
    '[   102.000000] /dev/input/event1: 0003 0035 00003000',
    '[   102.000000] /dev/input/event1: 0003 0036 00003000',
    '[   102.000000] /dev/input/event1: 0000 0000 00000000',
    '[   102.100000] /dev/input/event1: 0003 0039 ffffffff',
    '[   102.100000] /dev/input/event1: 0000 0000 00000000',
  ].join('\n');
  const sessionStore = {
    getEventsLog: () => fixture,
    getSession: () => ({
      device: {
        resolution: '1080x2424',
        absMaxX: 32767,
        absMaxY: 32767,
        nodes: ['/dev/input/event1'],
      },
    }),
  };
  const calls = [];
  const replayer = new Replayer({
    sessionStore,
    sendEvent: async () => {
      throw new Error('Permission denied');
    },
    inputTap: async () => calls.push('tap'),
    inputSwipe: async () => calls.push('swipe'),
    inputText: async (serial, text) => calls.push(`text:${text}`),
    inputKeyevent: async (serial, keycode) => calls.push(`key:${keycode}`),
    sleep: async () => {},
  });

  const progress = [];
  replayer.on('progress', (p) => progress.push(p.type));
  let done = false;
  replayer.on('done', () => {
    done = true;
  });

  await replayer.replay('demo', 'emulator-5556');

  assert.deepEqual(calls, ['tap', 'text:hi', 'key:66', 'tap']);
  assert.deepEqual(progress, ['tap', 'text', 'key', 'tap']);
  assert.equal(done, true);
});
