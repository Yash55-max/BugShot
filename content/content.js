// content.js — isolated world
// Handles click/nav recording and message passing only.
// Console + network capture is handled via executeScript in MAIN world (no CSP issues).

(function () {
  const MAX_STEPS = 20;
  const KEY_STEPS = '__bugshot_steps__';

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

  // ── Click / Navigation recording ──────────────────────────────────────────
  function describeTarget(el) {
    if (!el) return 'unknown element';
    const tag  = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 60);
    const id   = el.id ? `#${el.id}` : '';
    const cls  = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return [tag, id || cls, text ? `"${text}"` : ''].filter(Boolean).join(' ');
  }

  document.addEventListener('click', (e) => {
    push(KEY_STEPS, { type: 'click', desc: describeTarget(e.target), url: window.location.href, time: Date.now() }, MAX_STEPS);
  }, true);

  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPush(...args);
    push(KEY_STEPS, { type: 'navigate', url: window.location.href, time: Date.now() }, MAX_STEPS);
  };
  history.replaceState = function (...args) {
    origReplace(...args);
    push(KEY_STEPS, { type: 'navigate', url: window.location.href, time: Date.now() }, MAX_STEPS);
  };
  window.addEventListener('popstate', () => {
    push(KEY_STEPS, { type: 'navigate', url: window.location.href, time: Date.now() }, MAX_STEPS);
  });

  // ── Message handler ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_SYSTEM_INFO') {
      sendResponse({
        url:              window.location.href,
        title:            document.title,
        userAgent:        navigator.userAgent,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        viewportSize:     `${window.innerWidth}x${window.innerHeight}`,
        platform:         navigator.platform,
        language:         navigator.language,
        timestamp:        new Date().toISOString(),
        steps:            readJSON(KEY_STEPS),
        errors:           readJSON('__bugshot_errors__'),
        network:          readJSON('__bugshot_network__'),
        pageHeight:       document.documentElement.scrollHeight,
        pageWidth:        document.documentElement.scrollWidth
      });
    }

    if (msg.type === 'SCROLL_TO') {
      window.scrollTo(0, msg.y);
      setTimeout(() => sendResponse({ done: true }), 150);
      return true;
    }

    if (msg.type === 'GET_SCROLL_INFO') {
      sendResponse({
        scrollY:        window.scrollY,
        pageHeight:     document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight
      });
    }
  });
})();
