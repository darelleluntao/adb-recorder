const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceManager, parseTouchDevices } = require('../src/deviceManager');

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
  '    ABS (0003): ABS_MT_POSITION_X   : value 0, min 0, max 1439, fuzz 0, flat 0, resolution 0',
  '                ABS_MT_POSITION_Y   : value 0, min 0, max 3119, fuzz 0, flat 0, resolution 0',
].join('\n');

// Modern emulators expose one virtio multi-touch device per possible display,
// listed in DESCENDING node order; only multi_touch_1 (the primary display)
// actually receives touches. All must be returned so the recorder can listen
// to whichever one fires.
const MULTI_NODE_OUTPUT = [
  'add device 1: /dev/input/event12',
  '  name:     "qwerty2"',
  '  events:',
  '    KEY (0001): KEY_HOME',
  'add device 2: /dev/input/event11',
  '  name:     "virtio_input_multi_touch_11"',
  '  events:',
  '    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0',
  '                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0',
  'add device 3: /dev/input/event1',
  '  name:     "virtio_input_multi_touch_1"',
  '  events:',
  '    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0',
  '                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0',
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

test('parseTouchDevices returns every node advertising ABS_MT_POSITION_X with abs ranges', () => {
  const devices = parseTouchDevices(GETEVENT_PL_OUTPUT);
  assert.deepEqual(devices, [{ node: '/dev/input/event2', absMaxX: 1439, absMaxY: 3119 }]);
});

test('parseTouchDevices returns all multi-touch nodes on multi-display emulators', () => {
  const devices = parseTouchDevices(MULTI_NODE_OUTPUT);
  assert.deepEqual(
    devices.map((d) => d.node),
    ['/dev/input/event11', '/dev/input/event1']
  );
  assert.equal(devices[0].absMaxX, 32767);
  assert.equal(devices[0].absMaxY, 32767);
});

test('parseTouchDevices throws when no touch node is present', () => {
  assert.throws(() => parseTouchDevices('add device 1: /dev/input/event0\n  name: "keys"\n'));
});

test('findTouchDevices runs getevent -pl and parses the result', async () => {
  const dm = new DeviceManager(fakeExec([['getevent -pl', MULTI_NODE_OUTPUT]]));
  const devices = await dm.findTouchDevices('emulator-5554');
  assert.equal(devices.length, 2);
  assert.equal(devices[1].node, '/dev/input/event1');
});
