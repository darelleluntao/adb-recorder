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
