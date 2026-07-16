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

function renderStep(step) {
  const timeline = document.getElementById('timeline');
  const el = document.createElement('div');
  el.className = 'step';
  el.innerHTML = `
    <img src="/sessions/${encodeURIComponent(sessionName)}/${encodeURIComponent(step.screenshot)}" />
    <div>${escapeHtml(step.type)} (${escapeHtml(step.x0)},${escapeHtml(step.y0)}) &rarr; (${escapeHtml(step.x1)},${escapeHtml(step.y1)})</div>
  `;
  timeline.appendChild(el);
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) {
    alert(`Failed to load devices: ${res.status} ${res.statusText}`);
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
    alert(`Failed to load session: ${res.status} ${res.statusText}`);
    return;
  }
  const session = await res.json();
  document.getElementById('timeline').innerHTML = '';
  session.steps.forEach(renderStep);
}

function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', session: sessionName }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'step') {
      renderStep(msg.step);
    } else if (msg.type === 'recording-stopped') {
      document.getElementById('status').textContent = 'Stopped';
    } else if (msg.type === 'replay-progress') {
      document.getElementById('status').textContent = `Replaying step ${msg.index + 1}...`;
    } else if (msg.type === 'replay-done') {
      document.getElementById('status').textContent = 'Replay complete';
    } else if (msg.type === 'replay-error') {
      document.getElementById('status').textContent = `Replay error: ${msg.error}`;
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
    alert(`Failed to start replay: ${body.error || `${res.status} ${res.statusText}`}`);
  }
}

document.getElementById('stop-btn').addEventListener('click', async () => {
  await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/stop`, { method: 'POST' });
});

document.getElementById('replay-btn').addEventListener('click', () => requestReplay(false));

loadDevices();
loadSession();
connectWebSocket();
