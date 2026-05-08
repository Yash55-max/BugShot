// devtools.js — runs inside the DevTools page context

const MAX_NETWORK = 20;

let consoleLogs  = [];
let networkFails = [];

// ── Sync errors/warnings from page sessionStorage ─────────────────────────
function syncFromPage() {
  chrome.devtools.inspectedWindow.eval(
    `(function() {
      try {
        return {
          errors:  JSON.parse(sessionStorage.getItem('__bugshot_errors__')  || '[]'),
          network: JSON.parse(sessionStorage.getItem('__bugshot_network__') || '[]')
        };
      } catch(e) { return { errors: [], network: [] }; }
    })()`,
    (result, err) => {
      if (err || !result) return;
      consoleLogs = result.errors  || [];
      // Merge sessionStorage network with devtools-captured network (dedupe by url+status)
      const ss = result.network || [];
      const merged = [...networkFails, ...ss].filter((n, i, arr) =>
        arr.findIndex(x => x.url === n.url && x.status === n.status) === i
      ).slice(-MAX_NETWORK);
      networkFails = merged;
      pushToBackground();
    }
  );
}

// ── Always push latest data to background so popup can read it ────────────
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function pushToBackground() {
  if (!isContextValid()) return;
  chrome.runtime.sendMessage({
    type: 'STORE_DEVTOOLS_DATA',
    data: { consoleLogs, networkFails }
  }).catch(() => {});
}

// Start syncing immediately and every 2s
syncFromPage();
setInterval(syncFromPage, 2000);

// ── DevTools Panel ────────────────────────────────────────────────────────
chrome.devtools.panels.create(
  'BugShot',
  '/icons/icon16.png',
  '/devtools/panel.html',
  (panel) => {
    panel.onShown.addListener((panelWindow) => {
      syncFromPage();
      setTimeout(() => {
        panelWindow.postMessage({ type: 'BUGSHOT_DATA', consoleLogs, networkFails }, '*');
      }, 350);
    });
  }
);

// ── Network monitoring via chrome.devtools.network ────────────────────────
chrome.devtools.network.onRequestFinished.addListener((request) => {
  const status = request.response.status;
  if (status >= 400 || status === 0) {
    const entry = {
      method: request.request.method,
      url:    request.request.url.slice(0, 200),
      status,
      time:   Date.now()
    };
    // Dedupe
    const exists = networkFails.some(n => n.url === entry.url && n.status === entry.status);
    if (!exists) {
      networkFails.push(entry);
      if (networkFails.length > MAX_NETWORK) networkFails.shift();
    }
    pushToBackground();
  }
});

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_DEVTOOLS_DATA') {
    syncFromPage();
    setTimeout(() => {
      pushToBackground();
      sendResponse({ consoleLogs, networkFails });
    }, 350);
    return true;
  }
});
