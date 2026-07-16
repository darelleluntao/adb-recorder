const { execFile } = require('child_process');

function defaultExec(args) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function parseTouchEventNode(rawOutput) {
  const blocks = rawOutput.split(/\nadd device \d+: /);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const [nodeLine, ...rest] = block.split('\n');
    if (rest.join('\n').includes('ABS_MT_POSITION_X')) {
      return nodeLine.trim();
    }
  }
  throw new Error('No touchscreen input node found (ABS_MT_POSITION_X not present in any device)');
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

  async findTouchEventNode(serial) {
    const out = await this.exec(['-s', serial, 'shell', 'getevent', '-pl']);
    return parseTouchEventNode(out);
  }
}

module.exports = { DeviceManager, parseTouchEventNode };
