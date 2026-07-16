function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const params = new URLSearchParams(window.location.search);
const sessionName = params.get('name');
document.getElementById('session-title').textContent = sessionName;
document.getElementById('export-link').href = `/api/sessions/${encodeURIComponent(sessionName)}/export`;

// Recorded coordinates are raw touchscreen abs units (commonly 0..32767),
// not pixels; scale against the recorded device's abs range to position
// overlays and to show human-readable px values.
let device = { absMaxX: 32767, absMaxY: 32767, resolution: '' };
let screenW = null;
let screenH = null;

function pct(raw, absMax) {
  return (raw / (absMax + 1)) * 100;
}

function toPx(raw, absMax, dim) {
  return dim ? Math.round((raw / (absMax + 1)) * dim) : raw;
}

function showBanner(msg) {
  const banner = document.getElementById('banner');
  banner.textContent = msg;
  banner.classList.add('show');
}

function setStatus(text, kind) {
  const pill = document.getElementById('status');
  pill.textContent = text;
  pill.className = `pill${kind ? ` ${kind}` : ''}`;
}

function overlayFor(step) {
  const x0 = pct(step.x0, device.absMaxX);
  const y0 = pct(step.y0, device.absMaxY);
  if (step.type === 'tap') {
    return `<div class="marker-tap" style="left:${x0}%;top:${y0}%"></div>`;
  }
  const x1 = pct(step.x1, device.absMaxX);
  const y1 = pct(step.y1, device.absMaxY);
  return `
    <svg class="marker-swipe" viewBox="0 0 100 100" preserveAspectRatio="none">
      <circle cx="${x0}" cy="${y0}" r="1.6"></circle>
      <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"></line>
    </svg>
    <div class="marker-tap" style="left:${x1}%;top:${y1}%"></div>`;
}

function renderStep(step) {
  const timeline = document.getElementById('timeline');
  const empty = timeline.querySelector('.empty');
  if (empty) empty.remove();
  const durMs = Math.round((step.endTime - step.startTime) * 1000);
  const px = `${toPx(step.x0, device.absMaxX, screenW)},${toPx(step.y0, device.absMaxY, screenH)}`;
  const px1 = `${toPx(step.x1, device.absMaxX, screenW)},${toPx(step.y1, device.absMaxY, screenH)}`;
  const coords = step.type === 'tap' ? `(${px})` : `(${px}) &rarr; (${px1})`;
  const el = document.createElement('div');
  el.className = 'step';
  el.innerHTML = `
    <div class="shot">
      <img src="/sessions/${encodeURIComponent(sessionName)}/${encodeURIComponent(step.screenshot)}" alt="step ${step.index} screenshot" loading="lazy" />
      ${overlayFor(step)}
    </div>
    <div class="caption">
      <span class="idx">${String(step.index + 1).padStart(2, '0')}</span>
      <span class="kind ${escapeHtml(step.type)}">${escapeHtml(step.type)}</span>
      <span class="coords">${coords} &middot; ${durMs}ms</span>
    </div>
  `;
  timeline.appendChild(el);
}

function renderEmptyTimeline() {
  document.getElementById('timeline').innerHTML = `
    <div class="empty">
      No steps yet — touch the device and each tap or swipe will appear here
      with a screenshot the moment it happens.
    </div>`;
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) {
    showBanner(`Failed to load devices: ${res.status} ${res.statusText}`);
    return;
  }
  const devices = await res.json();
  const select = document.getElementById('replay-device-select');
  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.serial)}">${escapeHtml(d.model)} (${escapeHtml(d.serial)})</option>`)
    .join('');
}

async function loadSession() {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}`);
  if (!res.ok) {
    showBanner(`Failed to load session: ${res.status} ${res.statusText}`);
    return;
  }
  const session = await res.json();
  if (session.device) {
    device = { absMaxX: 32767, absMaxY: 32767, ...session.device };
    const resMatch = /^(\d+)x(\d+)$/.exec(session.device.resolution || '');
    if (resMatch) {
      screenW = parseInt(resMatch[1], 10);
      screenH = parseInt(resMatch[2], 10);
    }
  }
  if (session.recording) {
    setStatus('Recording', 'recording');
  } else {
    setStatus('Stopped', '');
    document.getElementById('stop-btn').disabled = true;
  }
  document.getElementById('timeline').innerHTML = '';
  if (session.steps.length === 0) {
    renderEmptyTimeline();
  } else {
    session.steps.forEach(renderStep);
  }
}

function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', session: sessionName }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'step') {
      setStatus('Recording', 'recording');
      renderStep(msg.step);
    } else if (msg.type === 'recording-stopped') {
      setStatus('Stopped', '');
      document.getElementById('stop-btn').disabled = true;
    } else if (msg.type === 'replay-progress') {
      const mode = msg.mode === 'input' ? ' · input fallback' : '';
      setStatus(`Replaying step ${msg.index + 1}${mode}`, 'replaying');
    } else if (msg.type === 'replay-done') {
      setStatus('Replay complete', 'done');
    } else if (msg.type === 'replay-error') {
      setStatus('Replay failed', 'error');
      showBanner(`Replay error: ${msg.error}`);
    }
  });
}

async function requestReplay(force) {
  const serial = document.getElementById('replay-device-select').value;
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial, force }),
  });
  const body = await res.json();
  if (res.status === 409 && body.mismatch) {
    const confirmMsg = `Recorded on ${body.recorded.model} (${body.recorded.resolution}), current device is ${body.current.model} (${body.current.resolution}). Replay anyway?`;
    if (confirm(confirmMsg)) {
      await requestReplay(true);
    }
  } else if (!res.ok) {
    setStatus('Replay failed', 'error');
    showBanner(`Failed to start replay: ${body.error || `${res.status} ${res.statusText}`}`);
  } else {
    document.getElementById('banner').classList.remove('show');
    setStatus('Replaying', 'replaying');
  }
}

document.getElementById('stop-btn').addEventListener('click', async () => {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/stop`, { method: 'POST' });
  if (res.ok || res.status === 404) {
    setStatus('Stopped', '');
    document.getElementById('stop-btn').disabled = true;
  }
});

document.getElementById('replay-btn').addEventListener('click', () => requestReplay(false));

loadDevices();
loadSession();
connectWebSocket();
