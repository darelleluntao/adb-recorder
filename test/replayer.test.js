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
