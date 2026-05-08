// panel.js — runs inside the BugShot DevTools panel

let currentData = { consoleLogs: [], networkFails: [] };
let pollInterval = null;

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function safeSendMessage(msg, cb) {
  if (!isContextValid()) { stopPolling(); return; }
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return; // swallow
      if (cb) cb(res);
    });
  } catch (e) {
    stopPolling();
  }
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function render(data) {
  if (!data) return;
  currentData = data;

  const cList = document.getElementById('console-list');
  const nList = document.getElementById('network-list');

  if (!data.consoleLogs?.length) {
    cList.innerHTML = '<span class="empty">No errors captured yet.</span>';
  } else {
    cList.innerHTML = data.consoleLogs.map(e => {
      const cls = e.msg?.startsWith('[warn]') ? 'warn' : 'error';
      const ts  = e.time ? `<span class="ts">${timeAgo(e.time)}</span>` : '';
      return `<div class="entry ${cls}">${escHtml(e.msg)}${ts}</div>`;
    }).join('');
  }

  if (!data.networkFails?.length) {
    nList.innerHTML = '<span class="empty">No network failures captured yet.</span>';
  } else {
    nList.innerHTML = data.networkFails.map(n => {
      const cls = n.status >= 500 ? 'net5xx' : 'net4xx';
      const ts  = n.time ? `<span class="ts">${timeAgo(n.time)}</span>` : '';
      return `<div class="entry ${cls}"><strong>${n.status || 'ERR'}</strong> ${n.method} ${escHtml(n.url)}${ts}</div>`;
    }).join('');
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Receive data from devtools.js when panel is shown
window.addEventListener('message', (e) => {
  if (e.data?.type === 'BUGSHOT_DATA') render(e.data);
});

// File bug report
document.getElementById('btn-file').addEventListener('click', () => {
  safeSendMessage({ type: 'STORE_DEVTOOLS_DATA', data: currentData }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Data saved — open BugShot popup to file the report';
    setTimeout(() => { status.textContent = ''; }, 4000);
  });
});

// Poll every 3s — stops automatically if extension is reloaded
pollInterval = setInterval(() => {
  if (!isContextValid()) { stopPolling(); return; }
  safeSendMessage({ type: 'GET_DEVTOOLS_DATA' }, (res) => { if (res) render(res); });
}, 3000);

// Initial load
safeSendMessage({ type: 'GET_DEVTOOLS_DATA' }, (res) => { if (res) render(res); });
