const express = require('express');
const { spawn } = require('child_process');

const VALID_SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isValidSessionName(name) {
  return typeof name === 'string' && VALID_SESSION_NAME_RE.test(name) && name !== '.' && name !== '..';
}

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
    if (!isValidSessionName(name)) {
      return res
        .status(400)
        .json({ error: 'Session name may only contain letters, numbers, dots, underscores, and hyphens' });
    }
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
    const { name } = req.params;
    if (!isValidSessionName(name)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }
    const activeRecorder = activeRecorders.get(name);
    if (activeRecorder) {
      activeRecorder.stop();
      activeRecorders.delete(name);
    }
    sessionStore.deleteSession(name);
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
