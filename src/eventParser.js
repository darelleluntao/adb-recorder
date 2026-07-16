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
