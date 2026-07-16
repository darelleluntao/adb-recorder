function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showBanner(msg) {
  const banner = document.getElementById('banner');
  banner.textContent = msg;
  banner.classList.add('show');
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) {
    showBanner(`Failed to load devices: ${res.status} ${res.statusText}`);
    return;
  }
  const devices = await res.json();
  const select = document.getElementById('device-select');
  if (devices.length === 0) {
    select.innerHTML = '<option value="">no devices connected</option>';
    return;
  }
  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.serial)}">${escapeHtml(d.model)} (${escapeHtml(d.serial)})</option>`)
    .join('');
}

async function loadSessions() {
  const res = await fetch('/api/sessions');
  if (!res.ok) {
    showBanner(`Failed to load sessions: ${res.status} ${res.statusText}`);
    return;
  }
  const sessions = await res.json();
  const tbody = document.querySelector('#sessions-table tbody');
  if (sessions.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="5" class="empty">
        No sessions yet. Name one above, pick a device, and hit <strong>Record</strong> —
        every tap and swipe on the device is captured with a screenshot.
      </td></tr>`;
    return;
  }
  tbody.innerHTML = sessions
    .map(
      (s) => `
      <tr>
        <td><a href="/session.html?name=${encodeURIComponent(s.name)}">${escapeHtml(s.name)}</a></td>
        <td class="num">${s.stepCount}</td>
        <td class="num mono">${formatDuration(s.duration)}</td>
        <td class="mono">${escapeHtml(s.device.model)}</td>
        <td><button data-name="${escapeHtml(s.name)}" class="delete-btn btn-quiet" title="Delete session">&#10005;&#xFE0E;</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      if (!res.ok) {
        showBanner(`Failed to delete session: ${res.status} ${res.statusText}`);
        return;
      }
      loadSessions();
    });
  });
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const formError = document.getElementById('form-error');
  formError.textContent = '';
  const name = document.getElementById('session-name').value.trim();
  const serial = document.getElementById('device-select').value;
  if (!name || !serial) {
    formError.textContent = !name ? 'Give the session a name first.' : 'No device selected — plug one in and reload.';
    return;
  }
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, serial }),
  });
  if (!res.ok) {
    const body = await res.json();
    formError.textContent = body.error || `Failed to start recording (${res.status})`;
    return;
  }
  window.location.href = `/session.html?name=${encodeURIComponent(name)}`;
});

document.getElementById('session-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('start-btn').click();
});

loadDevices();
loadSessions();
