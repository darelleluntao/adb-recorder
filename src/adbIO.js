const { spawn, execFile } = require('child_process');

function realSpawnGetEvent(serial, node) {
  const child = spawn('adb', ['-s', serial, 'shell', 'getevent', '-t', node]);
  const listeners = [];
  const exitListeners = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      for (const cb of listeners) cb(line);
    }
  });
  child.on('close', () => {
    for (const cb of exitListeners) cb();
  });
  child.on('error', () => {
    for (const cb of exitListeners) cb();
  });
  return {
    onLine(cb) {
      listeners.push(cb);
    },
    onExit(cb) {
      exitListeners.push(cb);
    },
    kill() {
      child.kill();
    },
  };
}

function realSendEvent(serial, devicePath, typeHex, codeHex, valueHex) {
  return new Promise((resolve, reject) => {
    execFile(
      'adb',
      [
        '-s',
        serial,
        'shell',
        'sendevent',
        devicePath,
        String(parseInt(typeHex, 16)),
        String(parseInt(codeHex, 16)),
        String(parseInt(valueHex, 16)),
      ],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function realCaptureScreenshot(serial) {
  return new Promise((resolve, reject) => {
    execFile(
      'adb',
      ['-s', serial, 'exec-out', 'screencap', '-p'],
      { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

module.exports = { realSpawnGetEvent, realSendEvent, realCaptureScreenshot };
