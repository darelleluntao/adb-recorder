const LINE_RE = /^\[\s*(\d+\.\d+)\]\s+(\S+):\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{8})$/;

const EV_KEY = 0x0001;
const EV_ABS = 0x0003;
const EV_SYN = 0x0000;
const SYN_REPORT = 0x0000;
const BTN_TOUCH = 0x014a;
const ABS_MT_POSITION_X = 0x0035;
const ABS_MT_POSITION_Y = 0x0036;
const ABS_MT_TRACKING_ID = 0x0039;
const TRACKING_ID_NONE = 0xffffffff;
const TAP_THRESHOLD_PX = 15;

class GestureParser {
  constructor({ tapThreshold = TAP_THRESHOLD_PX } = {}) {
    this.tapThreshold = tapThreshold;
    this._reset();
  }

  _reset() {
    this.buffer = [];
    this.x = null;
    this.y = null;
    this.startX = null;
    this.startY = null;
    this.startTime = null;
    this._active = false;
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

    if (type === EV_ABS && code === ABS_MT_POSITION_X) {
      this.x = value;
      // TRACKING_ID (down) can arrive before the first position event in the
      // same SYN batch; backfill the gesture origin from the first position.
      if (this._active && this.startX === null) this.startX = value;
    }
    if (type === EV_ABS && code === ABS_MT_POSITION_Y) {
      this.y = value;
      if (this._active && this.startY === null) this.startY = value;
    }

    // Contact down: BTN_TOUCH 1 (physical touchscreens) or any
    // ABS_MT_TRACKING_ID other than -1 (emulator virtio touch, which never
    // emits BTN_TOUCH at all).
    const isTrackingId = type === EV_ABS && code === ABS_MT_TRACKING_ID;
    const isDown =
      (type === EV_KEY && code === BTN_TOUCH && value === 1) ||
      (isTrackingId && value !== TRACKING_ID_NONE && !this._active);
    const isUp =
      (type === EV_KEY && code === BTN_TOUCH && value === 0) ||
      (isTrackingId && value === TRACKING_ID_NONE);

    if (isDown) {
      this._active = true;
      this.startX = this.x;
      this.startY = this.y;
    }

    if (isUp) {
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
      type: distance <= this.tapThreshold ? 'tap' : 'swipe',
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

// ── keyboard events ────────────────────────────────────────────────────
// Hardware/host keystrokes arrive as EV_KEY on a non-touch device (the
// emulator's qwerty2, a phone's physical keys). KeyParser turns printable
// key-downs into 'text' steps and action keys into 'key' steps so typed
// input can be replayed with `input text` / `input keyevent`.

const KEY_BACKSPACE = 14;
const KEY_TAB = 15;
const KEY_ENTER = 28;
const KEY_LEFTSHIFT = 42;
const KEY_RIGHTSHIFT = 54;

// evdev keycode -> [char, shiftedChar]
const EVDEV_CHARS = {
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'],
  7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'], 10: ['9', '('], 11: ['0', ')'],
  12: ['-', '_'], 13: ['=', '+'],
  16: ['q', 'Q'], 17: ['w', 'W'], 18: ['e', 'E'], 19: ['r', 'R'], 20: ['t', 'T'],
  21: ['y', 'Y'], 22: ['u', 'U'], 23: ['i', 'I'], 24: ['o', 'O'], 25: ['p', 'P'],
  26: ['[', '{'], 27: [']', '}'],
  30: ['a', 'A'], 31: ['s', 'S'], 32: ['d', 'D'], 33: ['f', 'F'], 34: ['g', 'G'],
  35: ['h', 'H'], 36: ['j', 'J'], 37: ['k', 'K'], 38: ['l', 'L'],
  39: [';', ':'], 40: ["'", '"'], 41: ['`', '~'], 43: ['\\', '|'],
  44: ['z', 'Z'], 45: ['x', 'X'], 46: ['c', 'C'], 47: ['v', 'V'], 48: ['b', 'B'],
  49: ['n', 'N'], 50: ['m', 'M'], 51: [',', '<'], 52: ['.', '>'], 53: ['/', '?'],
  57: [' ', ' '],
};

// action keys replayed as Android keyevents
const EVDEV_ACTION_KEYS = {
  [KEY_ENTER]: { key: 'ENTER', androidKeycode: 66 },
  [KEY_BACKSPACE]: { key: 'DEL', androidKeycode: 67 },
  [KEY_TAB]: { key: 'TAB', androidKeycode: 61 },
};

class KeyParser {
  constructor({ gapSeconds = 2 } = {}) {
    this.gapSeconds = gapSeconds;
    this.shift = false;
    this._resetBuffer();
  }

  _resetBuffer() {
    this.chars = [];
    this.startTime = null;
    this.lastTime = null;
  }

  // Feed one EV_KEY event. Returns an array of completed steps (usually
  // empty; keystrokes accumulate until flushed by a gap, an action key,
  // a touch gesture, or stop).
  feed(ts, code, value) {
    if (code === KEY_LEFTSHIFT || code === KEY_RIGHTSHIFT) {
      this.shift = value !== 0;
      return [];
    }
    if (value === 0) return []; // key-up; value 2 = autorepeat counts as a press

    const out = [];
    if (this.chars.length && ts - this.lastTime > this.gapSeconds) {
      out.push(...this.flush(this.lastTime));
    }

    if (EVDEV_CHARS[code]) {
      this.chars.push(EVDEV_CHARS[code][this.shift ? 1 : 0]);
      if (this.startTime === null) this.startTime = ts;
      this.lastTime = ts;
      return out;
    }

    if (code === KEY_BACKSPACE && this.chars.length) {
      this.chars.pop();
      this.lastTime = ts;
      return out;
    }

    if (EVDEV_ACTION_KEYS[code]) {
      out.push(...this.flush(ts));
      out.push({ type: 'key', ...EVDEV_ACTION_KEYS[code], startTime: ts, endTime: ts });
      return out;
    }

    return out; // unmapped key (power, volume, arrows…) — ignored
  }

  // Returns the pending text as a step (empty array if nothing buffered).
  flush(endTs) {
    if (!this.chars.length) return [];
    const step = {
      type: 'text',
      text: this.chars.join(''),
      startTime: this.startTime,
      endTime: endTs ?? this.lastTime,
    };
    this._resetBuffer();
    return [step];
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

module.exports = { GestureParser, KeyParser, parseGetEventLog, TAP_THRESHOLD_PX, LINE_RE };
