const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGetEventLog, GestureParser, KeyParser } = require('../src/eventParser');

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

test('parses a tap and a swipe from raw getevent -t output', () => {
  const gestures = parseGetEventLog(FIXTURE);
  assert.equal(gestures.length, 2);

  assert.equal(gestures[0].type, 'tap');
  assert.deepEqual(
    [gestures[0].x0, gestures[0].y0, gestures[0].x1, gestures[0].y1],
    [1440, 1040, 1440, 1040]
  );
  assert.equal(gestures[0].startTime, 100.0);
  assert.equal(gestures[0].endTime, 100.05);
  assert.equal(gestures[0].rawLines.length, 6);

  assert.equal(gestures[1].type, 'swipe');
  assert.deepEqual(
    [gestures[1].x0, gestures[1].y0, gestures[1].x1, gestures[1].y1],
    [256, 512, 768, 512]
  );
  assert.equal(gestures[1].startTime, 101.0);
  assert.equal(gestures[1].endTime, 101.2);
  assert.equal(gestures[1].rawLines.length, 9);
});

// Emulator virtio_input_multi_touch devices never emit BTN_TOUCH (0001 014a);
// they signal contact down/up purely via ABS_MT_TRACKING_ID (0003 0039):
// any value = finger down, ffffffff (-1) = finger up.
const TRACKING_ID_FIXTURE = [
  '[   200.000000] /dev/input/event1: 0003 0039 00000007',
  '[   200.000000] /dev/input/event1: 0003 0035 00000fa0',
  '[   200.000000] /dev/input/event1: 0003 0036 00001f40',
  '[   200.000000] /dev/input/event1: 0003 003a 00000400',
  '[   200.000000] /dev/input/event1: 0000 0000 00000000',
  '[   200.150000] /dev/input/event1: 0003 003a 00000000',
  '[   200.150000] /dev/input/event1: 0003 0039 ffffffff',
  '[   200.150000] /dev/input/event1: 0000 0000 00000000',
  '[   201.000000] /dev/input/event1: 0003 0039 00000008',
  '[   201.000000] /dev/input/event1: 0003 0035 00000100',
  '[   201.000000] /dev/input/event1: 0003 0036 00000200',
  '[   201.000000] /dev/input/event1: 0000 0000 00000000',
  '[   201.100000] /dev/input/event1: 0003 0035 00000900',
  '[   201.100000] /dev/input/event1: 0000 0000 00000000',
  '[   201.200000] /dev/input/event1: 0003 0039 ffffffff',
  '[   201.200000] /dev/input/event1: 0000 0000 00000000',
].join('\n');

test('parses tap and swipe from TRACKING_ID-based streams (no BTN_TOUCH)', () => {
  const gestures = parseGetEventLog(TRACKING_ID_FIXTURE);
  assert.equal(gestures.length, 2);

  assert.equal(gestures[0].type, 'tap');
  assert.deepEqual(
    [gestures[0].x0, gestures[0].y0, gestures[0].x1, gestures[0].y1],
    [4000, 8000, 4000, 8000]
  );
  assert.equal(gestures[0].startTime, 200.0);
  assert.equal(gestures[0].endTime, 200.15);

  assert.equal(gestures[1].type, 'swipe');
  assert.deepEqual(
    [gestures[1].x0, gestures[1].y0, gestures[1].x1, gestures[1].y1],
    [256, 512, 2304, 512]
  );
});

test('tap threshold is configurable (raw-unit jitter still counts as a tap)', () => {
  const jitterFixture = [
    '[   300.000000] /dev/input/event1: 0003 0039 00000009',
    '[   300.000000] /dev/input/event1: 0003 0035 00000100',
    '[   300.000000] /dev/input/event1: 0003 0036 00000200',
    '[   300.000000] /dev/input/event1: 0000 0000 00000000',
    '[   300.050000] /dev/input/event1: 0003 0035 00000180', // +128 raw units of jitter
    '[   300.050000] /dev/input/event1: 0000 0000 00000000',
    '[   300.100000] /dev/input/event1: 0003 0039 ffffffff',
    '[   300.100000] /dev/input/event1: 0000 0000 00000000',
  ].join('\n');

  const strict = new GestureParser();
  const loose = new GestureParser({ tapThreshold: 455 });
  let strictGesture = null;
  let looseGesture = null;
  for (const line of jitterFixture.split('\n')) {
    strictGesture = strict.feedLine(line) || strictGesture;
    looseGesture = loose.feedLine(line) || looseGesture;
  }
  assert.equal(strictGesture.type, 'swipe');
  assert.equal(looseGesture.type, 'tap');
});

test('feedLine returns null until a gesture closes', () => {
  const parser = new GestureParser();
  const lines = FIXTURE.split('\n');
  for (let i = 0; i < 5; i++) {
    assert.equal(parser.feedLine(lines[i]), null);
  }
  const gesture = parser.feedLine(lines[5]);
  assert.ok(gesture);
  assert.equal(gesture.type, 'tap');
});

// ── KeyParser ──────────────────────────────────────────────────────────
// evdev keycodes: h=35 e=18 l=38 o=24 shift=42 a=30 1=2 backspace=14
// enter=28 space=57 dot=52 @=shift+2

function feedKey(parser, ts, code, value) {
  return parser.feed(ts, code, value) || [];
}

test('KeyParser buffers keystrokes and flush() yields a text step', () => {
  const kp = new KeyParser();
  for (const [ts, code] of [[10.0, 35], [10.1, 18], [10.2, 38], [10.3, 38], [10.4, 24]]) {
    assert.deepEqual(feedKey(kp, ts, code, 1), []);
    feedKey(kp, ts + 0.01, code, 0);
  }
  const steps = kp.flush(10.5);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'text');
  assert.equal(steps[0].text, 'hello');
  assert.equal(steps[0].startTime, 10.0);
  assert.equal(steps[0].endTime, 10.5);
});

test('KeyParser applies shift for uppercase and symbols', () => {
  const kp = new KeyParser();
  feedKey(kp, 1.0, 42, 1); // shift down
  feedKey(kp, 1.1, 30, 1); // A
  feedKey(kp, 1.1, 30, 0);
  feedKey(kp, 1.2, 3, 1); // shift+2 = @
  feedKey(kp, 1.2, 3, 0);
  feedKey(kp, 1.3, 42, 0); // shift up
  feedKey(kp, 1.4, 30, 1); // a
  const steps = kp.flush(1.5);
  assert.equal(steps[0].text, 'A@a');
});

test('KeyParser backspace edits the pending buffer', () => {
  const kp = new KeyParser();
  feedKey(kp, 1.0, 30, 1); // a
  feedKey(kp, 1.1, 48, 1); // b
  feedKey(kp, 1.2, 14, 1); // backspace
  feedKey(kp, 1.3, 46, 1); // c
  const steps = kp.flush(1.4);
  assert.equal(steps[0].text, 'ac');
});

test('KeyParser emits a key step for backspace on an empty buffer and for enter', () => {
  const kp = new KeyParser();
  const del = feedKey(kp, 1.0, 14, 1);
  assert.equal(del.length, 1);
  assert.deepEqual([del[0].type, del[0].key, del[0].androidKeycode], ['key', 'DEL', 67]);

  feedKey(kp, 2.0, 30, 1); // a
  const enter = feedKey(kp, 2.1, 28, 1);
  assert.equal(enter.length, 2, 'enter flushes pending text first');
  assert.equal(enter[0].type, 'text');
  assert.equal(enter[0].text, 'a');
  assert.deepEqual([enter[1].type, enter[1].key, enter[1].androidKeycode], ['key', 'ENTER', 66]);
});

test('KeyParser flushes automatically after a typing gap', () => {
  const kp = new KeyParser({ gapSeconds: 2 });
  feedKey(kp, 1.0, 30, 1); // a
  const steps = feedKey(kp, 5.0, 48, 1); // b, 4s later
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, 'a');
  const rest = kp.flush(5.1);
  assert.equal(rest[0].text, 'b');
});

test('KeyParser ignores unknown keycodes and key repeats count as presses', () => {
  const kp = new KeyParser();
  feedKey(kp, 1.0, 116, 1); // KEY_POWER — ignored
  feedKey(kp, 1.1, 30, 1); // a down
  feedKey(kp, 1.2, 30, 2); // a autorepeat
  const steps = kp.flush(1.3);
  assert.equal(steps[0].text, 'aa');
});
