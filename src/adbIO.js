const { spawn, execFile } = require('child_process');

// No node argument: getevent watches every input device and prefixes each
// line with the originating node path, which the recorder needs both to
// filter to touch devices and to replay to the correct node later.
function realSpawnGetEvent(serial) {
  const child = spawn('adb', ['-s', serial, 'shell', 'getevent', '-t']);
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

function execAdb(args) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function realInputTap(serial, x, y) {
  return execAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)]);
}

function realInputSwipe(serial, x0, y0, x1, y1, durationMs) {
  return execAdb([
    '-s',
    serial,
    'shell',
    'input',
    'swipe',
    String(x0),
    String(y0),
    String(x1),
    String(y1),
    String(durationMs),
  ]);
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

module.exports = { realSpawnGetEvent, realSendEvent, realCaptureScreenshot, realInputTap, realInputSwipe };
