# adb-recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node.js webapp that records Android touch input via `adb getevent`, screenshots after every gesture, and replays sessions verbatim via `adb sendevent`.

**Architecture:** Single Express + `ws` server. Core logic (gesture parsing, device queries, session file I/O, recording orchestration, replay orchestration, websocket fan-out) lives in small dependency-injected modules under `src/`, each independently unit-testable without a real device. A thin `adbIO.js` module is the only place that actually shells out to `adb`; everything else takes injected functions so tests use fixtures/stubs instead of hardware. The frontend is plain HTML/CSS/vanilla JS served statically — no build step.

**Tech Stack:** Node.js 20 (built-in `node:test` for tests, global `fetch`), Express, `ws`. No database — sessions are folders on disk under `sessions/`.

## Global Constraints

- Repo root: `/Users/darelleluntao/Developer/Projects/adb-recorder` (already `git init`'d).
- Session folder layout (from spec, exact): `sessions/<name>/{events.log, steps.json, device.json, screenshots/step-N.png}`.
- Capture method: raw `adb shell getevent -t <node>` (numeric, unlabeled) piped later to `adb shell sendevent` — chosen over `-lt` (labeled) so recorded numeric type/code/value can be replayed directly without a symbol lookup table.
- Screenshot on every completed gesture, both during recording and (per spec) during replay progress reporting — no manual-capture-only mode in this iteration.
- Frontend: no framework, no build step — static HTML/CSS/vanilla JS under `public/`.
- Device mismatch on replay must warn and require explicit confirmation (`force: true`) — never silently replay against a mismatched device.
- No automated device/CI testing — this is a personal manual-testing tool; only the pure-logic modules (`eventParser`, `wsHub`) and dependency-injected modules (`deviceManager`, `sessionStore`, `recorder`, `replayer`, `routes`) get unit tests. Final end-to-end verification is manual, against a real emulator.

---

### Task 1: Project scaffold + static server + health check

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `server.js`
- Create: `public/index.html` (placeholder, replaced fully in Task 9)
- Create: `public/css/style.css`

**Interfaces:**
- Produces: an Express app listening on `process.env.PORT || 4545`, serving `public/` at `/`, with `GET /api/health` returning `{ ok: true }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "adb-recorder",
  "version": "0.1.0",
  "private": true,
  "description": "Record, browse, and replay adb touch input sessions with per-step screenshots.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
sessions/
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 4: Create placeholder `public/index.html` and `public/css/style.css`**

`public/index.html`:
```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>adb-recorder</title>
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
  <h1>adb-recorder</h1>
  <p>Scaffold OK.</p>
</body>
</html>
```

`public/css/style.css`:
```css
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.8rem; border-bottom: 1px solid #ddd; }
#timeline { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 1rem; }
.step { border: 1px solid #ddd; padding: 0.5rem; width: 220px; }
.step img { width: 100%; display: block; }
```

- [ ] **Step 5: Create `server.js` (health check only for now)**

```js
const express = require('express');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 4545;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`adb-recorder listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
```

- [ ] **Step 6: Verify it runs**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node server.js &`
Then: `curl -s http://localhost:4545/api/health`
Expected: `{"ok":true}`
Then: `kill %1` (stop the background server)

- [ ] **Step 7: Commit**

```bash
cd /Users/darelleluntao/Developer/Projects/adb-recorder
git add package.json package-lock.json .gitignore server.js public/
git commit -m "chore: scaffold project with Express static server and health check"
```

---

### Task 2: Gesture event parser (`src/eventParser.js`)

This is the one piece of real, order-sensitive logic in the system: turning a stream of raw `getevent -t` lines into discrete tap/swipe gestures. Both the Recorder (Task 5) and Replayer (Task 6) depend on it.

**Files:**
- Create: `src/eventParser.js`
- Test: `test/eventParser.test.js`

**Interfaces:**
- Produces:
  - `class GestureParser` with `feedLine(line: string) -> Gesture | null` — feed one raw line at a time; returns a completed `Gesture` object when a tap/swipe closes, else `null`.
  - `parseGetEventLog(rawText: string) -> Gesture[]` — convenience wrapper that runs a full log through a fresh `GestureParser`.
  - `Gesture` shape: `{ type: 'tap'|'swipe', x0, y0, x1, y1, startTime, endTime, rawLines: string[] }` where `rawLines` are the exact raw log lines belonging to that gesture (needed for replay).
  - `TAP_THRESHOLD_PX` (number, exported for tests).

- [ ] **Step 1: Write the failing test**

Create `test/eventParser.test.js`:

```js
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
  assert.equal(gestures[1].rawLines.length, 8);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/eventParser.test.js`
Expected: FAIL — `Cannot find module '../src/eventParser'`

- [ ] **Step 3: Write the implementation**

Create `src/eventParser.js`:

```js
const LINE_RE = /^\[\s*(\d+\.\d+)\]\s+(\S+):\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{8})$/;

const EV_KEY = 0x0001;
const EV_ABS = 0x0003;
const EV_SYN = 0x0000;
const SYN_REPORT = 0x0000;
const BTN_TOUCH = 0x014a;
const ABS_MT_POSITION_X = 0x0035;
const ABS_MT_POSITION_Y = 0x0036;
const TAP_THRESHOLD_PX = 15;

class GestureParser {
  constructor() {
    this._reset();
  }

  _reset() {
    this.buffer = [];
    this.x = null;
    this.y = null;
    this.startX = null;
    this.startY = null;
    this.startTime = null;
    this._pendingClose = false;
  }

  feedLine(line) {
    const trimmed = line.trim();
    const match = LINE_RE.exec(trimmed);
    if (!match) return null;

    const [, tsStr, , typeHex, codeHex, valueHex] = match;
    const ts = parseFloat(tsStr);
    const type = parseInt(typeHex, 16);
    const code = parseInt(codeHex, 16);
    const value = parseInt(valueHex, 16);

    this.buffer.push(trimmed);
    if (this.startTime === null) this.startTime = ts;

    if (type === EV_ABS && code === ABS_MT_POSITION_X) this.x = value;
    if (type === EV_ABS && code === ABS_MT_POSITION_Y) this.y = value;

    if (type === EV_KEY && code === BTN_TOUCH && value === 1) {
      this.startX = this.x;
      this.startY = this.y;
    }

    if (type === EV_KEY && code === BTN_TOUCH && value === 0) {
      this._pendingClose = true;
    }

    if (type === EV_SYN && code === SYN_REPORT && this._pendingClose) {
      return this._finish(ts);
    }
    return null;
  }

  _finish(endTime) {
    const x1 = this.x ?? this.startX ?? 0;
    const y1 = this.y ?? this.startY ?? 0;
    const x0 = this.startX ?? 0;
    const y0 = this.startY ?? 0;
    const distance = Math.hypot(x1 - x0, y1 - y0);

    const gesture = {
      type: distance <= TAP_THRESHOLD_PX ? 'tap' : 'swipe',
      x0,
      y0,
      x1,
      y1,
      startTime: this.startTime,
      endTime,
      rawLines: this.buffer,
    };

    this._reset();
    return gesture;
  }
}

function parseGetEventLog(rawText) {
  const parser = new GestureParser();
  const gestures = [];
  for (const line of rawText.split('\n')) {
    const gesture = parser.feedLine(line);
    if (gesture) gestures.push(gesture);
  }
  return gestures;
}

module.exports = { GestureParser, parseGetEventLog, TAP_THRESHOLD_PX, LINE_RE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/eventParser.test.js`
Expected: PASS, 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/eventParser.js test/eventParser.test.js
git commit -m "feat: add getevent raw-line gesture parser"
```

---

### Task 3: Device manager (`src/deviceManager.js`)

**Files:**
- Create: `src/deviceManager.js`
- Test: `test/deviceManager.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class DeviceManager` constructed with an injectable `exec(args: string[]) -> Promise<string>` (defaults to running real `adb`).
  - `deviceManager.listDevices() -> Promise<string[]>` — array of serials.
  - `deviceManager.getDeviceInfo(serial: string) -> Promise<{serial, model, resolution}>`.
  - `deviceManager.findTouchEventNode(serial: string) -> Promise<string>` — e.g. `/dev/input/event2`.
  - `parseTouchEventNode(rawOutput: string) -> string` — pure helper, exported for testing.

- [ ] **Step 1: Write the failing test**

Create `test/deviceManager.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/deviceManager.test.js`
Expected: FAIL — `Cannot find module '../src/deviceManager'`

- [ ] **Step 3: Write the implementation**

Create `src/deviceManager.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/deviceManager.test.js`
Expected: PASS, 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/deviceManager.js test/deviceManager.test.js
git commit -m "feat: add DeviceManager for adb device/resolution/touch-node queries"
```

---

### Task 4: Session store (`src/sessionStore.js`)

**Files:**
- Create: `src/sessionStore.js`
- Test: `test/sessionStore.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure filesystem I/O).
- Produces:
  - `class SessionStore` constructed with `rootDir: string`.
  - `createSession(name, device) -> string` (dir path) — writes `device.json`, empty `steps.json` (`[]`), empty `events.log`, creates `screenshots/`. Throws if session already exists.
  - `appendEvents(name, rawLines: string[])` — appends lines (one per line) to `events.log`.
  - `addStep(name, step: object) -> step` — appends to `steps.json`.
  - `saveScreenshot(name, stepIndex: number, buffer: Buffer) -> string` (file path) — writes `screenshots/step-<index>.png`.
  - `listSessions() -> string[]` — session names.
  - `getSession(name) -> {name, device, steps} | null`.
  - `getEventsLog(name) -> string`.
  - `deleteSession(name)`.
  - `rootDir` (public property, used by export in Task 8).

- [ ] **Step 1: Write the failing test**

Create `test/sessionStore.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../src/sessionStore');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  return new SessionStore(dir);
}

test('createSession writes device.json, empty steps.json, empty events.log', () => {
  const store = tmpStore();
  const device = { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' };
  store.createSession('demo', device);

  const dir = store.sessionPath('demo');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8')), device);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8')), []);
  assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8'), '');
  assert.ok(fs.existsSync(path.join(dir, 'screenshots')));
});

test('createSession throws if session already exists', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  assert.throws(() => store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' }));
});

test('appendEvents and addStep accumulate correctly', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  store.appendEvents('demo', ['line1', 'line2']);
  store.appendEvents('demo', ['line3']);
  assert.equal(store.getEventsLog('demo'), 'line1\nline2\nline3\n');

  store.addStep('demo', { index: 0, type: 'tap' });
  store.addStep('demo', { index: 1, type: 'swipe' });
  const session = store.getSession('demo');
  assert.equal(session.steps.length, 2);
  assert.equal(session.steps[1].type, 'swipe');
});

test('saveScreenshot writes the buffer to screenshots/step-N.png', () => {
  const store = tmpStore();
  store.createSession('demo', { serial: 'x', model: 'x', resolution: 'x' });
  const file = store.saveScreenshot('demo', 0, Buffer.from('fake-png-bytes'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'fake-png-bytes');
});

test('listSessions / deleteSession', () => {
  const store = tmpStore();
  store.createSession('a', { serial: 'x', model: 'x', resolution: 'x' });
  store.createSession('b', { serial: 'x', model: 'x', resolution: 'x' });
  assert.deepEqual(store.listSessions().sort(), ['a', 'b']);
  store.deleteSession('a');
  assert.deepEqual(store.listSessions(), ['b']);
});

test('getSession returns null for unknown session', () => {
  const store = tmpStore();
  assert.equal(store.getSession('nope'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/sessionStore.test.js`
Expected: FAIL — `Cannot find module '../src/sessionStore'`

- [ ] **Step 3: Write the implementation**

Create `src/sessionStore.js`:

```js
const fs = require('fs');
const path = require('path');

class SessionStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  sessionPath(name) {
    return path.join(this.rootDir, name);
  }

  createSession(name, device) {
    const dir = this.sessionPath(name);
    if (fs.existsSync(dir)) {
      throw new Error(`Session "${name}" already exists`);
    }
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'device.json'), JSON.stringify(device, null, 2));
    fs.writeFileSync(path.join(dir, 'steps.json'), '[]');
    fs.writeFileSync(path.join(dir, 'events.log'), '');
    return dir;
  }

  appendEvents(name, rawLines) {
    fs.appendFileSync(path.join(this.sessionPath(name), 'events.log'), rawLines.join('\n') + '\n');
  }

  addStep(name, step) {
    const stepsPath = path.join(this.sessionPath(name), 'steps.json');
    const steps = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
    steps.push(step);
    fs.writeFileSync(stepsPath, JSON.stringify(steps, null, 2));
    return step;
  }

  saveScreenshot(name, stepIndex, buffer) {
    const file = path.join(this.sessionPath(name), 'screenshots', `step-${stepIndex}.png`);
    fs.writeFileSync(file, buffer);
    return file;
  }

  listSessions() {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs
      .readdirSync(this.rootDir)
      .filter((name) => fs.existsSync(path.join(this.rootDir, name, 'steps.json')));
  }

  getSession(name) {
    const dir = this.sessionPath(name);
    if (!fs.existsSync(dir)) return null;
    const device = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
    const steps = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'));
    return { name, device, steps };
  }

  getEventsLog(name) {
    return fs.readFileSync(path.join(this.sessionPath(name), 'events.log'), 'utf8');
  }

  deleteSession(name) {
    fs.rmSync(this.sessionPath(name), { recursive: true, force: true });
  }
}

module.exports = { SessionStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/sessionStore.test.js`
Expected: PASS, 6 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.js test/sessionStore.test.js
git commit -m "feat: add SessionStore for on-disk session file management"
```

---

### Task 5: Recorder (`src/recorder.js`)

**Files:**
- Create: `src/recorder.js`
- Test: `test/recorder.test.js`

**Interfaces:**
- Consumes: `GestureParser` from `src/eventParser.js` (Task 2); a `SessionStore` instance (Task 4) with `createSession`, `appendEvents`, `addStep`, `saveScreenshot`.
- Produces:
  - `class Recorder extends EventEmitter`, constructed with `{ sessionStore, spawnGetEvent, captureScreenshot }` where:
    - `spawnGetEvent(serial, node) -> { onLine(cb: (line: string) => void), kill() }`
    - `captureScreenshot(serial) -> Promise<Buffer>`
  - `recorder.start(name, { serial, node, device }) -> Promise<void>` — creates the session, starts consuming lines, saves a step + screenshot each time a gesture closes.
  - `recorder.stop()` — kills the child process, emits `'stopped'`.
  - Emits `'step'` with the saved step object each time one is recorded.

- [ ] **Step 1: Write the failing test**

Create `test/recorder.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder } = require('../src/recorder');
const { SessionStore } = require('../src/sessionStore');

const TAP_LINES = [
  '[   100.000000] /dev/input/event2: 0003 0035 000005a0',
  '[   100.000000] /dev/input/event2: 0003 0036 00000410',
  '[   100.000000] /dev/input/event2: 0001 014a 00000001',
  '[   100.000000] /dev/input/event2: 0000 0000 00000000',
  '[   100.050000] /dev/input/event2: 0001 014a 00000000',
  '[   100.050000] /dev/input/event2: 0000 0000 00000000',
];

function fakeSpawn() {
  let onLineCb = null;
  return {
    onLine(cb) {
      onLineCb = cb;
    },
    kill() {
      this.killed = true;
    },
    feed(line) {
      onLineCb(line);
    },
  };
}

test('recording a tap gesture saves a step and screenshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const screenshotCalls = [];
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async (serial) => {
      screenshotCalls.push(serial);
      return Buffer.from('fake-png');
    },
  });

  const steps = [];
  recorder.on('step', (step) => steps.push(step));

  await recorder.start('demo', {
    serial: 'emulator-5554',
    node: '/dev/input/event2',
    device: { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });

  for (const line of TAP_LINES) {
    await spawn.feed(line);
  }

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'tap');
  assert.equal(steps[0].index, 0);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0], 'emulator-5554');

  const session = sessionStore.getSession('demo');
  assert.equal(session.steps.length, 1);
  assert.equal(
    fs.readFileSync(path.join(sessionStore.sessionPath('demo'), 'screenshots', 'step-0.png'), 'utf8'),
    'fake-png'
  );
  assert.equal(sessionStore.getEventsLog('demo').split('\n').filter(Boolean).length, TAP_LINES.length);
});

test('stop() kills the child process and emits stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recorder-test-'));
  const sessionStore = new SessionStore(dir);
  const spawn = fakeSpawn();
  const recorder = new Recorder({
    sessionStore,
    spawnGetEvent: () => spawn,
    captureScreenshot: async () => Buffer.from(''),
  });
  await recorder.start('demo', {
    serial: 'x',
    node: '/dev/input/event2',
    device: { serial: 'x', model: 'x', resolution: 'x' },
  });

  let stopped = false;
  recorder.on('stopped', () => {
    stopped = true;
  });
  recorder.stop();

  assert.equal(spawn.killed, true);
  assert.equal(stopped, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/recorder.test.js`
Expected: FAIL — `Cannot find module '../src/recorder'`

- [ ] **Step 3: Write the implementation**

Create `src/recorder.js`:

```js
const { EventEmitter } = require('events');
const { GestureParser } = require('./eventParser');

class Recorder extends EventEmitter {
  constructor({ sessionStore, spawnGetEvent, captureScreenshot }) {
    super();
    this.sessionStore = sessionStore;
    this.spawnGetEvent = spawnGetEvent;
    this.captureScreenshot = captureScreenshot;
  }

  async start(name, { serial, node, device }) {
    this.sessionStore.createSession(name, device);
    this.name = name;
    this.serial = serial;
    this.stepIndex = 0;
    this.parser = new GestureParser();
    this.child = this.spawnGetEvent(serial, node);
    this.child.onLine((line) => this._onLine(line));
  }

  async _onLine(line) {
    this.sessionStore.appendEvents(this.name, [line]);
    const gesture = this.parser.feedLine(line);
    if (gesture) {
      await this._handleGesture(gesture);
    }
  }

  async _handleGesture(gesture) {
    const index = this.stepIndex++;
    const screenshotBuffer = await this.captureScreenshot(this.serial);
    this.sessionStore.saveScreenshot(this.name, index, screenshotBuffer);
    const step = {
      index,
      type: gesture.type,
      x0: gesture.x0,
      y0: gesture.y0,
      x1: gesture.x1,
      y1: gesture.y1,
      startTime: gesture.startTime,
      endTime: gesture.endTime,
      screenshot: `screenshots/step-${index}.png`,
    };
    this.sessionStore.addStep(this.name, step);
    this.emit('step', step);
  }

  stop() {
    if (this.child) this.child.kill();
    this.emit('stopped');
  }
}

module.exports = { Recorder };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/recorder.test.js`
Expected: PASS, 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/recorder.js test/recorder.test.js
git commit -m "feat: add Recorder orchestrating getevent capture, steps, and screenshots"
```

---

### Task 6: Replayer (`src/replayer.js`)

**Files:**
- Create: `src/replayer.js`
- Test: `test/replayer.test.js`

**Interfaces:**
- Consumes: `GestureParser` from `src/eventParser.js` (Task 2); `LINE_RE` exported from `src/eventParser.js`; a `SessionStore` instance's `getEventsLog(name) -> string` (Task 4).
- Produces:
  - `class Replayer extends EventEmitter`, constructed with `{ sessionStore, sendEvent, sleep }` where:
    - `sendEvent(serial, devicePath, typeHex, codeHex, valueHex) -> Promise<void>`
    - `sleep(ms) -> Promise<void>` (defaults to real `setTimeout`-based sleep)
  - `replayer.replay(name, serial) -> Promise<void>` — replays `events.log` line by line, preserving original relative timing, emitting `'progress'` with `{index, type}` each time a gesture closes, and `'done'` at the end.

- [ ] **Step 1: Write the failing test**

Create `test/replayer.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/replayer.test.js`
Expected: FAIL — `Cannot find module '../src/replayer'`

- [ ] **Step 3: Write the implementation**

Create `src/replayer.js`:

```js
const { EventEmitter } = require('events');
const { GestureParser, LINE_RE } = require('./eventParser');

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Replayer extends EventEmitter {
  constructor({ sessionStore, sendEvent, sleep = realSleep }) {
    super();
    this.sessionStore = sessionStore;
    this.sendEvent = sendEvent;
    this.sleep = sleep;
  }

  async replay(name, serial) {
    const rawLog = this.sessionStore.getEventsLog(name);
    const lines = rawLog.split('\n').filter((line) => line.trim());
    const parser = new GestureParser();
    let prevTs = null;
    let stepIndex = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      const match = LINE_RE.exec(trimmed);
      if (!match) continue;
      const [, tsStr, devicePath, typeHex, codeHex, valueHex] = match;
      const ts = parseFloat(tsStr);

      if (prevTs !== null) {
        await this.sleep(Math.max(0, (ts - prevTs) * 1000));
      }
      prevTs = ts;

      await this.sendEvent(serial, devicePath, typeHex, codeHex, valueHex);

      const gesture = parser.feedLine(trimmed);
      if (gesture) {
        this.emit('progress', { index: stepIndex, type: gesture.type });
        stepIndex++;
      }
    }

    this.emit('done');
  }
}

module.exports = { Replayer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/replayer.test.js`
Expected: PASS, 1 test passing

- [ ] **Step 5: Commit**

```bash
git add src/replayer.js test/replayer.test.js
git commit -m "feat: add Replayer for timing-accurate sendevent playback"
```

---

### Task 7: WebSocket fan-out hub (`src/wsHub.js`)

**Files:**
- Create: `src/wsHub.js`
- Test: `test/wsHub.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class WsHub` with `subscribe(sessionName, ws)`, `unsubscribe(sessionName, ws)`, `broadcast(sessionName, message: object)` — sends `JSON.stringify(message)` to every subscribed socket with `readyState === 1` (open).

- [ ] **Step 1: Write the failing test**

Create `test/wsHub.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WsHub } = require('../src/wsHub');

function fakeSocket() {
  return { readyState: 1, sent: [], send(msg) { this.sent.push(msg); } };
}

test('broadcast only reaches subscribers of that session', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  const b = fakeSocket();
  hub.subscribe('session-a', a);
  hub.subscribe('session-b', b);

  hub.broadcast('session-a', { type: 'step', step: { index: 0 } });

  assert.equal(a.sent.length, 1);
  assert.deepEqual(JSON.parse(a.sent[0]), { type: 'step', step: { index: 0 } });
  assert.equal(b.sent.length, 0);
});

test('unsubscribe stops further messages', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  hub.subscribe('session-a', a);
  hub.unsubscribe('session-a', a);
  hub.broadcast('session-a', { type: 'step' });
  assert.equal(a.sent.length, 0);
});

test('broadcast skips sockets that are not open', () => {
  const hub = new WsHub();
  const a = fakeSocket();
  a.readyState = 3; // CLOSED
  hub.subscribe('session-a', a);
  hub.broadcast('session-a', { type: 'step' });
  assert.equal(a.sent.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/wsHub.test.js`
Expected: FAIL — `Cannot find module '../src/wsHub'`

- [ ] **Step 3: Write the implementation**

Create `src/wsHub.js`:

```js
class WsHub {
  constructor() {
    this.subscribers = new Map();
  }

  subscribe(sessionName, ws) {
    if (!this.subscribers.has(sessionName)) this.subscribers.set(sessionName, new Set());
    this.subscribers.get(sessionName).add(ws);
  }

  unsubscribe(sessionName, ws) {
    this.subscribers.get(sessionName)?.delete(ws);
  }

  broadcast(sessionName, message) {
    const sockets = this.subscribers.get(sessionName);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

module.exports = { WsHub };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/wsHub.test.js`
Expected: PASS, 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/wsHub.js test/wsHub.test.js
git commit -m "feat: add WsHub for per-session websocket broadcast"
```

---

### Task 8: Real adb I/O + REST routes + server wiring

**Files:**
- Create: `src/adbIO.js`
- Create: `src/routes.js`
- Test: `test/routes.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `DeviceManager` (Task 3), `SessionStore` (Task 4), `Recorder` (Task 5), `Replayer` (Task 6), `WsHub` (Task 7).
- Produces (`src/adbIO.js`): `realSpawnGetEvent(serial, node)`, `realSendEvent(serial, devicePath, typeHex, codeHex, valueHex)`, `realCaptureScreenshot(serial)` — the only real `adb`-shelling functions, matching the injectable signatures Recorder/Replayer expect.
- Produces (`src/routes.js`): `createRouter({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }) -> express.Router` mounted at `/api`, exposing:
  - `GET /devices` -> `[{serial, model, resolution}]`
  - `GET /sessions` -> `[{name, device, stepCount, duration}]`
  - `GET /sessions/:name` -> `{name, device, steps}` or 404
  - `POST /sessions` `{name, serial}` -> starts recording, 201 `{name, device}`, 409 if name exists
  - `POST /sessions/:name/stop` -> stops recording, 404 if not active
  - `POST /sessions/:name/replay` `{serial, force}` -> 409 `{mismatch:true, recorded, current}` if device mismatches and not forced; otherwise starts replay async, 200 `{started:true}`
  - `DELETE /sessions/:name` -> `{deleted:true}`
  - `GET /sessions/:name/export` -> streams a `.tar.gz` of the session folder

- [ ] **Step 1: Write `src/adbIO.js` (real adb integration, no test — exercised manually in Task 11)**

```js
const { spawn, execFile } = require('child_process');

function realSpawnGetEvent(serial, node) {
  const child = spawn('adb', ['-s', serial, 'shell', 'getevent', '-t', node]);
  const listeners = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      for (const cb of listeners) cb(line);
    }
  });
  return {
    onLine(cb) {
      listeners.push(cb);
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
```

- [ ] **Step 2: Write the failing test for routes**

Create `test/routes.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { EventEmitter } = require('events');
const { createRouter } = require('../src/routes');

function startTestServer({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function fakeDeviceManager(devices, infoBySerial) {
  return {
    listDevices: async () => devices,
    getDeviceInfo: async (serial) => infoBySerial[serial],
    findTouchEventNode: async () => '/dev/input/event2',
  };
}

function fakeSessionStore(initial = {}) {
  const sessions = { ...initial };
  return {
    rootDir: '/tmp/fake',
    listSessions: () => Object.keys(sessions),
    getSession: (name) => sessions[name] || null,
    deleteSession: (name) => delete sessions[name],
    _sessions: sessions,
  };
}

test('GET /api/devices returns device info for each connected serial', async () => {
  const deviceManager = fakeDeviceManager(['emulator-5554'], {
    'emulator-5554': { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });
  const server = await startTestServer({
    deviceManager,
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/devices`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' }]);
  server.close();
});

test('GET /api/sessions/:name returns 404 for unknown session', async () => {
  const server = await startTestServer({
    deviceManager: fakeDeviceManager([], {}),
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/nope`);
  assert.equal(res.status, 404);
  server.close();
});

test('POST /api/sessions starts a recorder and returns 201', async () => {
  const deviceManager = fakeDeviceManager(['emulator-5554'], {
    'emulator-5554': { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
  });
  let startedWith = null;
  class FakeRecorder extends EventEmitter {
    async start(name, opts) {
      startedWith = { name, opts };
    }
  }
  const server = await startTestServer({
    deviceManager,
    sessionStore: fakeSessionStore(),
    wsHub: { broadcast() {} },
    createRecorder: () => new FakeRecorder(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', serial: 'emulator-5554' }),
  });
  assert.equal(res.status, 201);
  assert.equal(startedWith.name, 'demo');
  assert.equal(startedWith.opts.serial, 'emulator-5554');
  server.close();
});

test('POST /api/sessions/:name/replay returns 409 on device mismatch without force', async () => {
  const deviceManager = fakeDeviceManager(['emulator-9999'], {
    'emulator-9999': { serial: 'emulator-9999', model: 'OtherPhone', resolution: '1080x2400' },
  });
  const sessionStore = fakeSessionStore({
    demo: {
      name: 'demo',
      device: { serial: 'emulator-5554', model: 'Pixel', resolution: '1440x3120' },
      steps: [],
    },
  });
  const server = await startTestServer({
    deviceManager,
    sessionStore,
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/demo/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial: 'emulator-9999', force: false }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.mismatch, true);
  server.close();
});

test('DELETE /api/sessions/:name deletes the session', async () => {
  const sessionStore = fakeSessionStore({ demo: { name: 'demo', device: {}, steps: [] } });
  const server = await startTestServer({
    deviceManager: fakeDeviceManager([], {}),
    sessionStore,
    wsHub: { broadcast() {} },
    createRecorder: () => new EventEmitter(),
    createReplayer: () => new EventEmitter(),
  });
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/api/sessions/demo`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(sessionStore.listSessions(), []);
  server.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/routes.test.js`
Expected: FAIL — `Cannot find module '../src/routes'`

- [ ] **Step 4: Write `src/routes.js`**

```js
const express = require('express');
const { spawn } = require('child_process');

function createRouter({ deviceManager, sessionStore, wsHub, createRecorder, createReplayer }) {
  const router = express.Router();
  const activeRecorders = new Map();

  router.get('/devices', async (req, res) => {
    try {
      const serials = await deviceManager.listDevices();
      const devices = await Promise.all(serials.map((serial) => deviceManager.getDeviceInfo(serial)));
      res.json(devices);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions', (req, res) => {
    const sessions = sessionStore.listSessions().map((name) => {
      const session = sessionStore.getSession(name);
      const steps = session.steps;
      const duration = steps.length ? steps[steps.length - 1].endTime - steps[0].startTime : 0;
      return { name, device: session.device, stepCount: steps.length, duration };
    });
    res.json(sessions);
  });

  router.get('/sessions/:name', (req, res) => {
    const session = sessionStore.getSession(req.params.name);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  router.post('/sessions', async (req, res) => {
    const { name, serial } = req.body;
    if (!name || !serial) return res.status(400).json({ error: 'name and serial are required' });
    if (sessionStore.listSessions().includes(name)) {
      return res.status(409).json({ error: `Session "${name}" already exists` });
    }
    try {
      const device = await deviceManager.getDeviceInfo(serial);
      const node = await deviceManager.findTouchEventNode(serial);
      const recorder = createRecorder();
      recorder.on('step', (step) => wsHub.broadcast(name, { type: 'step', step }));
      recorder.on('stopped', () => wsHub.broadcast(name, { type: 'recording-stopped' }));
      await recorder.start(name, { serial, node, device: { ...device, node } });
      activeRecorders.set(name, recorder);
      res.status(201).json({ name, device });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:name/stop', (req, res) => {
    const recorder = activeRecorders.get(req.params.name);
    if (!recorder) return res.status(404).json({ error: 'No active recording for this session' });
    recorder.stop();
    activeRecorders.delete(req.params.name);
    res.json({ stopped: true });
  });

  router.post('/sessions/:name/replay', async (req, res) => {
    const { name } = req.params;
    const { serial, force } = req.body;
    const session = sessionStore.getSession(name);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try {
      const current = await deviceManager.getDeviceInfo(serial);
      const recorded = session.device;
      const mismatch = current.serial !== recorded.serial || current.resolution !== recorded.resolution;
      if (mismatch && !force) {
        return res.status(409).json({ mismatch: true, recorded, current });
      }
      const replayer = createReplayer();
      replayer.on('progress', (progress) => wsHub.broadcast(name, { type: 'replay-progress', ...progress }));
      replayer.on('done', () => wsHub.broadcast(name, { type: 'replay-done' }));
      replayer
        .replay(name, serial)
        .catch((err) => wsHub.broadcast(name, { type: 'replay-error', error: err.message }));
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/sessions/:name', (req, res) => {
    sessionStore.deleteSession(req.params.name);
    res.json({ deleted: true });
  });

  router.get('/sessions/:name/export', (req, res) => {
    const { name } = req.params;
    const session = sessionStore.getSession(name);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.tar.gz"`);
    const tar = spawn('tar', ['-czf', '-', '-C', sessionStore.rootDir, name]);
    tar.stdout.pipe(res);
    tar.on('error', () => res.status(500).end());
  });

  return router;
}

module.exports = { createRouter };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test test/routes.test.js`
Expected: PASS, 5 tests passing

- [ ] **Step 6: Wire real modules into `server.js`**

Replace the contents of `server.js` with:

```js
const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { DeviceManager } = require('./src/deviceManager');
const { SessionStore } = require('./src/sessionStore');
const { WsHub } = require('./src/wsHub');
const { Recorder } = require('./src/recorder');
const { Replayer } = require('./src/replayer');
const { createRouter } = require('./src/routes');
const { realSpawnGetEvent, realSendEvent, realCaptureScreenshot } = require('./src/adbIO');

const PORT = process.env.PORT || 4545;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const deviceManager = new DeviceManager();
const sessionStore = new SessionStore(SESSIONS_DIR);
const wsHub = new WsHub();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/sessions', express.static(SESSIONS_DIR));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(
  '/api',
  createRouter({
    deviceManager,
    sessionStore,
    wsHub,
    createRecorder: () =>
      new Recorder({
        sessionStore,
        spawnGetEvent: realSpawnGetEvent,
        captureScreenshot: realCaptureScreenshot,
      }),
    createReplayer: () => new Replayer({ sessionStore, sendEvent: realSendEvent }),
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let subscribedSession = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'subscribe') {
      subscribedSession = msg.session;
      wsHub.subscribe(subscribedSession, ws);
    }
  });
  ws.on('close', () => {
    if (subscribedSession) wsHub.unsubscribe(subscribedSession, ws);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`adb-recorder listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
```

- [ ] **Step 7: Verify the full suite still passes and the server boots**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node --test`
Expected: PASS, all tests across all files (eventParser, deviceManager, sessionStore, recorder, replayer, wsHub, routes)

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node server.js & sleep 1 && curl -s http://localhost:4545/api/health && kill %1`
Expected: `{"ok":true}`

- [ ] **Step 8: Commit**

```bash
git add src/adbIO.js src/routes.js test/routes.test.js server.js
git commit -m "feat: wire real adb I/O, REST routes, and websocket server"
```

---

### Task 9: Frontend — session list page

**Files:**
- Modify: `public/index.html` (replace placeholder from Task 1)
- Create: `public/js/app.js`

**Interfaces:**
- Consumes: `GET /api/devices`, `GET /api/sessions`, `POST /api/sessions`, `DELETE /api/sessions/:name` (Task 8).
- Produces: a page at `/` listing sessions with Delete, and a form to name + pick a device + start recording, redirecting to `/session.html?name=<name>` on success.

- [ ] **Step 1: Replace `public/index.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>adb-recorder</title>
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
  <h1>adb-recorder</h1>

  <section id="new-session">
    <h2>New Session</h2>
    <label>Name <input id="session-name" type="text" placeholder="login-to-booking" /></label>
    <label>Device <select id="device-select"></select></label>
    <button id="start-btn">Record</button>
  </section>

  <section id="session-list">
    <h2>Sessions</h2>
    <table id="sessions-table">
      <thead><tr><th>Name</th><th>Steps</th><th>Duration</th><th>Device</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <script src="/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/js/app.js`**

```js
async function loadDevices() {
  const res = await fetch('/api/devices');
  const devices = await res.json();
  const select = document.getElementById('device-select');
  select.innerHTML = devices
    .map((d) => `<option value="${d.serial}">${d.model} (${d.serial})</option>`)
    .join('');
}

async function loadSessions() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  const tbody = document.querySelector('#sessions-table tbody');
  tbody.innerHTML = sessions
    .map(
      (s) => `
      <tr>
        <td><a href="/session.html?name=${encodeURIComponent(s.name)}">${s.name}</a></td>
        <td>${s.stepCount}</td>
        <td>${s.duration.toFixed(1)}s</td>
        <td>${s.device.model}</td>
        <td><button data-name="${s.name}" class="delete-btn">Delete</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/sessions/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      loadSessions();
    });
  });
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const name = document.getElementById('session-name').value.trim();
  const serial = document.getElementById('device-select').value;
  if (!name || !serial) {
    alert('Session name and device are required');
    return;
  }
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, serial }),
  });
  if (!res.ok) {
    const body = await res.json();
    alert(`Failed to start recording: ${body.error}`);
    return;
  }
  window.location.href = `/session.html?name=${encodeURIComponent(name)}`;
});

loadDevices();
loadSessions();
```

- [ ] **Step 3: Manual verification**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && node server.js` (leave running), open `http://localhost:4545/` in a browser.
Expected: page loads, device dropdown populates if a device/emulator is connected (or shows empty if none), session table renders (empty on first run).

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat: add session list page with record form"
```

---

### Task 10: Frontend — session detail page

**Files:**
- Create: `public/session.html`
- Create: `public/js/session.js`

**Interfaces:**
- Consumes: `GET /api/sessions/:name`, `GET /api/devices`, `POST /api/sessions/:name/stop`, `POST /api/sessions/:name/replay`, `GET /api/sessions/:name/export`, and the `/ws` websocket (Task 8).
- Produces: a page at `/session.html?name=<name>` showing the live/step timeline, Stop/Replay/Export controls, and a confirm-on-mismatch flow for replay.

- [ ] **Step 1: Create `public/session.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>adb-recorder - session</title>
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
  <a href="/index.html">&larr; Sessions</a>
  <h1 id="session-title"></h1>
  <p id="status">Live</p>
  <div>
    <label>Replay on <select id="replay-device-select"></select></label>
    <button id="stop-btn">Stop Recording</button>
    <button id="replay-btn">Replay</button>
    <a id="export-link">Export</a>
  </div>
  <div id="timeline"></div>
  <script src="/js/session.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/js/session.js`**

```js
const params = new URLSearchParams(window.location.search);
const sessionName = params.get('name');
document.getElementById('session-title').textContent = sessionName;
document.getElementById('export-link').href = `/api/sessions/${encodeURIComponent(sessionName)}/export`;

function renderStep(step) {
  const timeline = document.getElementById('timeline');
  const el = document.createElement('div');
  el.className = 'step';
  el.innerHTML = `
    <img src="/sessions/${encodeURIComponent(sessionName)}/${step.screenshot}" />
    <div>${step.type} (${step.x0},${step.y0}) &rarr; (${step.x1},${step.y1})</div>
  `;
  timeline.appendChild(el);
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  const devices = await res.json();
  const select = document.getElementById('replay-device-select');
  select.innerHTML = devices
    .map((d) => `<option value="${d.serial}">${d.model} (${d.serial})</option>`)
    .join('');
}

async function loadSession() {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}`);
  const session = await res.json();
  document.getElementById('timeline').innerHTML = '';
  session.steps.forEach(renderStep);
}

function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', session: sessionName }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'step') {
      renderStep(msg.step);
    } else if (msg.type === 'recording-stopped') {
      document.getElementById('status').textContent = 'Stopped';
    } else if (msg.type === 'replay-progress') {
      document.getElementById('status').textContent = `Replaying step ${msg.index + 1}...`;
    } else if (msg.type === 'replay-done') {
      document.getElementById('status').textContent = 'Replay complete';
    } else if (msg.type === 'replay-error') {
      document.getElementById('status').textContent = `Replay error: ${msg.error}`;
    }
  });
}

async function requestReplay(force) {
  const serial = document.getElementById('replay-device-select').value;
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial, force }),
  });
  const body = await res.json();
  if (res.status === 409 && body.mismatch) {
    const confirmMsg = `Recorded on ${body.recorded.model} (${body.recorded.resolution}), current device is ${body.current.model} (${body.current.resolution}). Replay anyway?`;
    if (confirm(confirmMsg)) {
      await requestReplay(true);
    }
  }
}

document.getElementById('stop-btn').addEventListener('click', async () => {
  await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/stop`, { method: 'POST' });
});

document.getElementById('replay-btn').addEventListener('click', () => requestReplay(false));

loadDevices();
loadSession();
connectWebSocket();
```

- [ ] **Step 3: Manual verification**

With `node server.js` running and a device/emulator connected: from `/`, start a session, tap on the device a few times, confirm the timeline fills in live with thumbnails; click Stop; click Replay and confirm the device replays the taps; verify Export downloads a `.tar.gz`.

- [ ] **Step 4: Commit**

```bash
git add public/session.html public/js/session.js
git commit -m "feat: add session detail page with live timeline, replay, and export"
```

---

### Task 11: README + end-to-end manual verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: documented usage instructions; a verified end-to-end recording → replay cycle on a real emulator/device.

- [ ] **Step 1: Write `README.md`**

```markdown
# adb-recorder

Record touch input on an Android device/emulator via `adb`, browse a screenshot
per gesture, and replay a recorded session verbatim.

## Requirements

- Node.js 20+
- `adb` on your `PATH`, with exactly one device/emulator connected (or pass a
  specific serial in the UI's device dropdown if multiple are attached)

## Usage

    npm install
    npm start

Open http://localhost:4545, name a session, pick a device, click **Record**,
then interact with your device/emulator normally — each tap/swipe is captured
with a screenshot in real time. Click **Stop** when done.

From the session page you can **Replay** the recorded session on the same or
a different device (a confirmation is required if the target device's
resolution/serial doesn't match what was recorded), or **Export** the session
as a `.tar.gz` (raw event log, step metadata, and screenshots).

## Tests

    npm test

## How it works

See `docs/superpowers/specs/2026-07-16-adb-recorder-design.md` for the full
design. In short: `adb shell getevent -t <node>` streams raw numeric touch
events, which are grouped into discrete tap/swipe gestures, screenshotted, and
saved to `sessions/<name>/`. Replay pipes the same raw events back through
`adb shell sendevent`, preserving original timing.
```

- [ ] **Step 2: Full automated test suite**

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && npm test`
Expected: PASS, all tests across `eventParser`, `deviceManager`, `sessionStore`, `recorder`, `replayer`, `wsHub`, `routes`

- [ ] **Step 3: Manual end-to-end verification against a real emulator**

Requires an already-running Android emulator (e.g. `emulator-5554`) or connected device.

Run: `cd /Users/darelleluntao/Developer/Projects/adb-recorder && npm start`
Then in a browser:
1. Open http://localhost:4545, confirm the device dropdown shows the connected emulator.
2. Name a session (e.g. `manual-check`), click Record.
3. Tap a few places on the emulator screen; confirm the timeline fills in live with a screenshot per tap.
4. Click Stop; confirm status changes to "Stopped".
5. Click Replay (same device); confirm the emulator visibly receives the same taps and the status updates step-by-step to "Replay complete".
6. Click Export; confirm a `manual-check.tar.gz` downloads and contains `events.log`, `steps.json`, `device.json`, `screenshots/`.
7. Delete the session from the list; confirm it disappears and its folder is gone from `sessions/`.

Expected: all 7 steps behave as described, with no server errors in the terminal running `npm start`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with usage instructions"
```
