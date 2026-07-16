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
