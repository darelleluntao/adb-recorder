const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGetEventLog, GestureParser } = require('../src/eventParser');

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
