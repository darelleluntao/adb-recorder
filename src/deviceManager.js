const { execFile } = require('child_process');

function defaultExec(args) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Returns EVERY node advertising ABS_MT_POSITION_X, with its abs coordinate
// ranges. Emulators expose one virtio multi-touch node per possible display
// and only the primary display's node actually emits events, so the recorder
// must listen to all of them rather than guess one.
function parseTouchDevices(rawOutput) {
  const blocks = ('\n' + rawOutput).split(/\nadd device \d+: /);
  const devices = [];
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const [nodeLine, ...rest] = block.split('\n');
    const body = rest.join('\n');
    const xMatch = /ABS_MT_POSITION_X\s*:.*?max (\d+)/.exec(body);
    const yMatch = /ABS_MT_POSITION_Y\s*:.*?max (\d+)/.exec(body);
    if (xMatch) {
      devices.push({
        node: nodeLine.trim(),
        absMaxX: parseInt(xMatch[1], 10),
        absMaxY: yMatch ? parseInt(yMatch[1], 10) : parseInt(xMatch[1], 10),
      });
    }
  }
  if (devices.length === 0) {
    throw new Error('No touchscreen input node found (ABS_MT_POSITION_X not present in any device)');
  }
  return devices;
}

class DeviceManager {
  constructor(exec = defaultExec) {
    this.exec = exec;
  }

  async listDevices() {
    const out = await this.exec(['devices']);
    return out
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('device'))
      .map((line) => line.split(/\s+/)[0]);
  }

  async getDeviceInfo(serial) {
    const model = (await this.exec(['-s', serial, 'shell', 'getprop', 'ro.product.model'])).trim();
    const wm = await this.exec(['-s', serial, 'shell', 'wm', 'size']);
    const match = /size:\s*(\d+)x(\d+)/.exec(wm);
    const resolution = match ? `${match[1]}x${match[2]}` : 'unknown';
    return { serial, model, resolution };
  }

  async findTouchDevices(serial) {
    const out = await this.exec(['-s', serial, 'shell', 'getevent', '-pl']);
    return parseTouchDevices(out);
  }
}

module.exports = { DeviceManager, parseTouchDevices };
