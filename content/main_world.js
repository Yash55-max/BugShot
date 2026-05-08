// main_world.js — injected into the page's MAIN world via chrome.scripting.executeScript
// Runs as a real script file (not inline), so CSP 'self' rules allow it.
// Intercepts console errors, warnings, and network failures.

(function () {
  // Guard: don't double-inject
  if (window.__bugshot_injected__) return;
  window.__bugshot_injected__ = true;

  const MAX_ERRORS  = 15;
  const MAX_NETWORK = 20;
  const KEY_ERRORS  = '__bugshot_errors__';
  const KEY_NETWORK = '__bugshot_network__';

  function readJSON(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { return []; }
  }
  function writeJSON(key, arr) {
    try { sessionStorage.setItem(key, JSON.stringify(arr)); } catch {}
  }
  function push(key, item, max) {
    const arr = readJSON(key);
    arr.push(item);
    if (arr.length > max) arr.shift();
    writeJSON(key, arr);
  }

  function serialize(a) {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch { return String(a); }
  }

  // ── Console errors + warnings ─────────────────────────────────────────────
  const origError = console.error.bind(console);
  console.error = function (...args) {
    origError(...args);
    push(KEY_ERRORS, { msg: args.map(serialize).join(' ').slice(0, 300), time: Date.now() }, MAX_ERRORS);
  };

  const origWarn = console.warn.bind(console);
  console.warn = function (...args) {
    origWarn(...args);
    push(KEY_ERRORS, { msg: '[warn] ' + args.map(serialize).join(' ').slice(0, 300), time: Date.now() }, MAX_ERRORS);
  };

  window.addEventListener('error', (e) => {
    push(KEY_ERRORS, {
      msg: e.message + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''),
      time: Date.now()
    }, MAX_ERRORS);
  });

  window.addEventListener('unhandledrejection', (e) => {
    push(KEY_ERRORS, {
      msg: 'Unhandled rejection: ' + String(e.reason).slice(0, 200),
      time: Date.now()
    }, MAX_ERRORS);
  });

  // ── Network failures — XHR ────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let method = '', reqUrl = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u, ...rest) {
      method = m; reqUrl = String(u).slice(0, 200);
      origOpen(m, u, ...rest);
    };
    xhr.addEventListener('loadend', () => {
      if (xhr.status >= 400 || xhr.status === 0) {
        push(KEY_NETWORK, { method, url: reqUrl, status: xhr.status, time: Date.now() }, MAX_NETWORK);
      }
    });
    return xhr;
  };

  // ── Network failures — fetch ──────────────────────────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url    = (typeof input === 'string' ? input : input?.url || '').slice(0, 200);
    const method = ((init?.method) || 'GET').toUpperCase();
    try {
      const res = await origFetch(input, init);
      if (!res.ok) push(KEY_NETWORK, { method, url, status: res.status, time: Date.now() }, MAX_NETWORK);
      return res;
    } catch (err) {
      push(KEY_NETWORK, { method, url, status: 0, error: err.message, time: Date.now() }, MAX_NETWORK);
      throw err;
    }
  };
})();
