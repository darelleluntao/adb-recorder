const { EventEmitter } = require('events');
const { GestureParser, LINE_RE } = require('./eventParser');

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Replayer extends EventEmitter {
  constructor({ sessionStore, sendEvent, inputTap, inputSwipe, sleep = realSleep }) {
    super();
    this.sessionStore = sessionStore;
    this.sendEvent = sendEvent;
    this.inputTap = inputTap;
    this.inputSwipe = inputSwipe;
    this.sleep = sleep;
  }

  async replay(name, serial) {
    const rawLog = this.sessionStore.getEventsLog(name);
    const lines = rawLog.split('\n').filter((line) => line.trim());
    const matchedLines = lines
      .map((line) => ({ line: line.trim(), match: LINE_RE.exec(line.trim()) }))
      .filter(({ match }) => match);

    if (matchedLines.length === 0) {
      throw new Error('events.log is empty or contains no valid recorded events');
    }

    const parser = new GestureParser();
    let prevTs = null;
    let stepIndex = 0;

    for (let i = 0; i < matchedLines.length; i++) {
      const { line: trimmed, match } = matchedLines[i];
      const [, tsStr, devicePath, typeHex, codeHex, valueHex] = match;
      const ts = parseFloat(tsStr);

      if (prevTs !== null) {
        await this.sleep(Math.max(0, (ts - prevTs) * 1000));
      }
      prevTs = ts;

      try {
        await this.sendEvent(serial, devicePath, typeHex, codeHex, valueHex);
      } catch (err) {
        // Raw sendevent needs root (SELinux denies /dev/input writes on
        // production builds). Fall back to synthesizing the recorded gestures
        // with `adb shell input`, which works unrooted. Only safe to switch
        // wholesale on the very first event; mid-stream the device has
        // already received partial raw input.
        if (i === 0 && this.inputTap && this.inputSwipe) {
          return this._replayWithInput(name, serial, matchedLines);
        }
        throw err;
      }

      const gesture = parser.feedLine(trimmed);
      if (gesture) {
        this.emit('progress', { index: stepIndex, type: gesture.type, mode: 'sendevent' });
        stepIndex++;
      }
    }

    this.emit('done');
  }

  async _replayWithInput(name, serial, matchedLines) {
    const session = this.sessionStore.getSession(name);
    const device = (session && session.device) || {};
    const resMatch = /^(\d+)x(\d+)$/.exec(device.resolution || '');
    if (!resMatch) {
      throw new Error(
        'sendevent replay requires root on this device, and input-based fallback needs the recorded screen resolution (missing from device.json)'
      );
    }
    const width = parseInt(resMatch[1], 10);
    const height = parseInt(resMatch[2], 10);
    // Touch coordinates in the log are raw abs units; sessions recorded
    // before abs ranges were captured default to the common 0..32767 range.
    const absMaxX = device.absMaxX || 32767;
    const absMaxY = device.absMaxY || 32767;
    const scaleX = (raw) => Math.min(width, Math.round((raw / (absMaxX + 1)) * width));
    const scaleY = (raw) => Math.min(height, Math.round((raw / (absMaxY + 1)) * height));

    const parser = new GestureParser();
    const gestures = [];
    for (const { line } of matchedLines) {
      const gesture = parser.feedLine(line);
      if (gesture) gestures.push(gesture);
    }
    if (gestures.length === 0) {
      throw new Error('events.log contains no complete gestures to replay');
    }

    let prevEnd = null;
    for (let i = 0; i < gestures.length; i++) {
      const g = gestures[i];
      if (prevEnd !== null) {
        await this.sleep(Math.max(0, (g.startTime - prevEnd) * 1000));
      }
      this.emit('progress', { index: i, type: g.type, mode: 'input' });
      if (g.type === 'tap') {
        await this.inputTap(serial, scaleX(g.x0), scaleY(g.y0));
      } else {
        const durationMs = Math.max(1, Math.round((g.endTime - g.startTime) * 1000));
        await this.inputSwipe(
          serial,
          scaleX(g.x0),
          scaleY(g.y0),
          scaleX(g.x1),
          scaleY(g.y1),
          durationMs
        );
      }
      prevEnd = g.endTime;
    }

    this.emit('done');
  }
}

module.exports = { Replayer };
