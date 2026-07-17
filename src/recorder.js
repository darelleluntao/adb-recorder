const { EventEmitter } = require('events');
const { GestureParser, KeyParser, LINE_RE, TAP_THRESHOLD_PX } = require('./eventParser');

class Recorder extends EventEmitter {
  constructor({ sessionStore, spawnGetEvent, captureScreenshot }) {
    super();
    this.sessionStore = sessionStore;
    this.spawnGetEvent = spawnGetEvent;
    this.captureScreenshot = captureScreenshot;
  }

  async start(name, { serial, nodes, device }) {
    this.sessionStore.createSession(name, device);
    this.name = name;
    this.serial = serial;
    this.nodes = new Set(nodes);
    this.stepIndex = 0;
    this.stopped = false;
    // Gesture coordinates are in the touchscreen's raw abs units (often
    // 0..32767), not pixels; scale the tap-vs-swipe threshold accordingly.
    const width = parseInt(String(device?.resolution).split('x')[0], 10);
    const tapThreshold =
      device?.absMaxX && width
        ? Math.round((TAP_THRESHOLD_PX * (device.absMaxX + 1)) / width)
        : TAP_THRESHOLD_PX;
    this.parser = new GestureParser({ tapThreshold });
    this.keyParser = new KeyParser();
    this._keySynPending = false;
    // getevent runs across ALL input devices (output lines are prefixed with
    // the originating node); _onLine filters to the touch nodes. This avoids
    // guessing which of several identical multi-touch nodes is live.
    // Gestures are handled strictly one at a time: screencap takes ~300ms,
    // and gestures closing during that window would otherwise race on
    // stepIndex — duplicate step numbers and overwritten screenshots.
    this._gestureChain = Promise.resolve();
    this.child = this.spawnGetEvent(serial);
    this.child.onLine((line) => this._onLine(line));
    if (typeof this.child.onExit === 'function') {
      this.child.onExit(() => this.stop());
    }
  }

  _reportError(err) {
    // EventEmitter has a special case: emit('error', ...) with zero listeners
    // throws synchronously. Since this is called from inside a .catch(), an
    // unguarded emit here would become a new unhandled rejection and crash
    // the process again. Only emit if someone is actually listening; otherwise
    // fall back to logging so the failure is still visible.
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.error('Recorder error:', err);
    }
  }

  _onLine(line) {
    const match = LINE_RE.exec(line.trim());
    if (!match) return;
    const [, tsStr, devicePath, typeHex, codeHex, valueHex] = match;

    if (this.nodes.has(devicePath)) {
      this.sessionStore.appendEvents(this.name, [line]);
      const gesture = this.parser.feedLine(line);
      if (gesture) {
        // Text typed before this touch belongs before it in the timeline.
        for (const step of this.keyParser.flush(gesture.startTime)) {
          this._enqueueStep(step);
        }
        this._enqueueStep(gesture);
      }
      return;
    }

    // Non-touch device: capture keyboard events (and their SYN_REPORTs, which
    // raw sendevent replay needs) so typed text survives the recording.
    const type = parseInt(typeHex, 16);
    if (type === 0x01) {
      this.sessionStore.appendEvents(this.name, [line]);
      this._keySynPending = true;
      const steps = this.keyParser.feed(parseFloat(tsStr), parseInt(codeHex, 16), parseInt(valueHex, 16));
      for (const step of steps) {
        this._enqueueStep(step);
      }
    } else if (type === 0x00 && this._keySynPending) {
      this.sessionStore.appendEvents(this.name, [line]);
      this._keySynPending = false;
    }
  }

  _enqueueStep(data) {
    this._gestureChain = this._gestureChain
      .then(() => this._handleStep(data))
      .catch((err) => this._reportError(err));
  }

  async _handleStep(data) {
    // Do not consume stepIndex until the screenshot/step are actually
    // persisted, so a captureScreenshot rejection simply drops the failed
    // step instead of leaving a gap in the numbering.
    const index = this.stepIndex;
    const screenshotBuffer = await this.captureScreenshot(this.serial);
    this.sessionStore.saveScreenshot(this.name, index, screenshotBuffer);
    const common = {
      index,
      type: data.type,
      startTime: data.startTime,
      endTime: data.endTime,
      screenshot: `screenshots/step-${index}.png`,
    };
    let step;
    if (data.type === 'text') {
      step = { ...common, text: data.text };
    } else if (data.type === 'key') {
      step = { ...common, key: data.key, androidKeycode: data.androidKeycode };
    } else {
      step = { ...common, x0: data.x0, y0: data.y0, x1: data.x1, y1: data.y1 };
    }
    this.sessionStore.addStep(this.name, step);
    this.stepIndex = index + 1;
    this.emit('step', step);
  }

  // Resolves once every gesture queued so far has been fully persisted.
  idle() {
    return this._gestureChain || Promise.resolve();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    // Text typed after the last touch would otherwise be lost.
    if (this.keyParser) {
      for (const step of this.keyParser.flush()) {
        this._enqueueStep(step);
      }
    }
    if (this.child) this.child.kill();
    this.emit('stopped');
  }
}

module.exports = { Recorder };
