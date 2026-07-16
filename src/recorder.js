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
    this.stopped = false;
    this.parser = new GestureParser();
    this.child = this.spawnGetEvent(serial, node);
    this.child.onLine((line) => {
      this._onLine(line).catch((err) => this._reportError(err));
    });
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

  async _onLine(line) {
    this.sessionStore.appendEvents(this.name, [line]);
    const gesture = this.parser.feedLine(line);
    if (gesture) {
      await this._handleGesture(gesture);
    }
  }

  async _handleGesture(gesture) {
    // Do not consume stepIndex until the screenshot/step are actually
    // persisted, so a captureScreenshot rejection simply drops the failed
    // gesture instead of leaving a gap in the numbering.
    const index = this.stepIndex;
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
    this.stepIndex = index + 1;
    this.emit('step', step);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) this.child.kill();
    this.emit('stopped');
  }
}

module.exports = { Recorder };
