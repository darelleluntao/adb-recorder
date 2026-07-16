const fs = require('fs');
const path = require('path');

const VALID_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertValidSessionName(name) {
  if (
    typeof name !== 'string' ||
    !VALID_NAME_RE.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error(`Invalid session name "${name}"`);
  }
}

class SessionStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  sessionPath(name) {
    assertValidSessionName(name);
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
