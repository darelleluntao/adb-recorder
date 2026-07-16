const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceManager, parseTouchEventNode } = require('../src/deviceManager');

const DEVICES_OUTPUT = 'List of devices attached\nemulator-5554\tdevice\n\n';
const MODEL_OUTPUT = 'sdk_gphone64_arm64\n';
const WM_SIZE_OUTPUT = 'Physical size: 1440x3120\n';
const GETEVENT_PL_OUTPUT = [
  'add device 1: /dev/input/event0',
  '  name:     "goldfish-events"',
  '  events:',
  '    KEY (0001): KEY_HOME',
  'add device 2: /dev/input/event2',
  '  name:     "goldfish_events (touch)"',
  '  events:',
  '    ABS (0003): ABS_MT_POSITION_X   : value 0, min 0, max 1439',
  '                ABS_MT_POSITION_Y   : value 0, min 0, max 3119',
].join('\n');

function fakeExec(responses) {
  return async (args) => {
    const key = args.join(' ');
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`no fake response configured for: ${key}`);
  };
}

test('listDevices parses serials from `adb devices`', async () => {
  const dm = new DeviceManager(fakeExec([['devices', DEVICES_OUTPUT]]));
  const serials = await dm.listDevices();
  assert.deepEqual(serials, ['emulator-5554']);
});

test('getDeviceInfo combines model + resolution', async () => {
  const dm = new DeviceManager(
    fakeExec([
      ['getprop ro.product.model', MODEL_OUTPUT],
      ['wm size', WM_SIZE_OUTPUT],
    ])
  );
  const info = await dm.getDeviceInfo('emulator-5554');
  assert.deepEqual(info, {
    serial: 'emulator-5554',
    model: 'sdk_gphone64_arm64',
    resolution: '1440x3120',
  });
});

test('parseTouchEventNode finds the node advertising ABS_MT_POSITION_X', () => {
  const node = parseTouchEventNode(GETEVENT_PL_OUTPUT);
  assert.equal(node, '/dev/input/event2');
});

test('parseTouchEventNode throws when no touch node is present', () => {
  assert.throws(() => parseTouchEventNode('add device 1: /dev/input/event0\n  name: "keys"\n'));
});
