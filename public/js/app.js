function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) {
    alert(`Failed to load devices: ${res.status} ${res.statusText}`);
    return;
  }
  const devices = await res.json();
  const select = document.getElementById('device-select');
  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.serial)}">${escapeHtml(d.model)} (${escapeHtml(d.serial)})</option>`)
    .join('');
}

async function loadSessions() {
  const res = await fetch('/api/sessions');
  if (!res.ok) {
    alert(`Failed to load sessions: ${res.status} ${res.statusText}`);
    return;
  }
  const sessions = await res.json();
  const tbody = document.querySelector('#sessions-table tbody');
  tbody.innerHTML = sessions
    .map(
      (s) => `
      <tr>
        <td><a href="/session.html?name=${encodeURIComponent(s.name)}">${escapeHtml(s.name)}</a></td>
        <td>${s.stepCount}</td>
        <td>${s.duration.toFixed(1)}s</td>
        <td>${escapeHtml(s.device.model)}</td>
        <td><button data-name="${escapeHtml(s.name)}" class="delete-btn">Delete</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      if (!res.ok) {
        alert(`Failed to delete session: ${res.status} ${res.statusText}`);
        return;
      }
      loadSessions();
    });
  });
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const name = document.getElementById('session-name').value.trim();
  const serial = document.getElementById('device-select').value;
  if (!name || !serial) {
    alert('Session name and device are required');
    return;
  }
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, serial }),
  });
  if (!res.ok) {
    const body = await res.json();
    alert(`Failed to start recording: ${body.error}`);
    return;
  }
  window.location.href = `/session.html?name=${encodeURIComponent(name)}`;
});

loadDevices();
loadSessions();
