const { EventEmitter } = require('events');
const { GestureParser, KeyParser, LINE_RE, TAP_THRESHOLD_PX } = require('./eventParser');

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Recordings preserve the operator's idle time between gestures; replaying a
// 13s pause verbatim looks like a hang. Input-fallback replay is automation,
// not a screening, so cap inter-gesture waits. (Raw sendevent replay stays
// verbatim — fidelity is its point.)
const MAX_GESTURE_GAP_MS = 3000;

class Replayer extends EventEmitter {
  constructor({ sessionStore, sendEvent, inputTap, inputSwipe, inputText, inputKeyevent, sleep = realSleep }) {
    super();
    this.sessionStore = sessionStore;
    this.sendEvent = sendEvent;
    this.inputTap = inputTap;
    this.inputSwipe = inputSwipe;
    this.inputText = inputText;
    this.inputKeyevent = inputKeyevent;
    this.sleep = sleep;
  }

  _touchNodeFilter(name) {
    // Sessions recorded since key capture store their touch nodes; lines
    // from other devices are keyboard events. Legacy logs contain touch
    // lines only, so "everything is touch" is the safe default.
    const session = typeof this.sessionStore.getSession === 'function' ? this.sessionStore.getSession(name) : null;
    const nodes = new Set((session && session.device && session.device.nodes) || []);
    return (devicePath) => nodes.size === 0 || nodes.has(devicePath);
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

    const isTouchNode = this._touchNodeFilter(name);
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

      // keyboard lines are replayed raw but must not feed the touch parser
      // (their SYN_REPORTs would close gestures early)
      const gesture = isTouchNode(devicePath) ? parser.feedLine(trimmed) : null;
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
    const scaleX = (raw) => Math.min(width - 1, Math.round((raw / (absMaxX + 1)) * width));
    const scaleY = (raw) => Math.min(height - 1, Math.round((raw / (absMaxY + 1)) * height));

    // Match the recorder's classification: the tap threshold is in raw abs
    // units, so scale it the same way, or finger jitter on a 0..32767 device
    // turns recorded taps into micro-swipes.
    const tapThreshold = Math.round((TAP_THRESHOLD_PX * (absMaxX + 1)) / width);
    const isTouchNode = this._touchNodeFilter(name);
    const parser = new GestureParser({ tapThreshold });
    const keyParser = new KeyParser();
    const steps = [];
    for (const { line, match } of matchedLines) {
      const [, tsStr, devicePath, typeHex, codeHex, valueHex] = match;
      if (isTouchNode(devicePath)) {
        const gesture = parser.feedLine(line);
        if (gesture) steps.push(gesture);
      } else if (parseInt(typeHex, 16) === 0x01) {
        steps.push(...keyParser.feed(parseFloat(tsStr), parseInt(codeHex, 16), parseInt(valueHex, 16)));
      }
    }
    steps.push(...keyParser.flush());
    steps.sort((a, b) => a.startTime - b.startTime);
    if (steps.length === 0) {
      throw new Error('events.log contains no complete gestures to replay');
    }

    let prevEnd = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (prevEnd !== null) {
        await this.sleep(Math.min(MAX_GESTURE_GAP_MS, Math.max(0, (s.startTime - prevEnd) * 1000)));
      }
      this.emit('progress', { index: i, type: s.type, mode: 'input' });
      if (s.type === 'tap') {
        await this.inputTap(serial, scaleX(s.x0), scaleY(s.y0));
      } else if (s.type === 'swipe') {
        const durationMs = Math.max(1, Math.round((s.endTime - s.startTime) * 1000));
        await this.inputSwipe(
          serial,
          scaleX(s.x0),
          scaleY(s.y0),
          scaleX(s.x1),
          scaleY(s.y1),
          durationMs
        );
      } else if (s.type === 'text') {
        await this.inputText(serial, s.text);
      } else if (s.type === 'key') {
        await this.inputKeyevent(serial, s.androidKeycode);
      }
      prevEnd = s.endTime;
    }

    this.emit('done');
  }
}

module.exports = { Replayer };
