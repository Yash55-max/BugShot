// background.js — service worker

// Inject main_world.js into every tab on navigation (bypasses CSP, no inline scripts)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  chrome.scripting.executeScript({
    target: { tabId },
    files:  ['content/main_world.js'],
    world:  'MAIN',
    injectImmediately: true
  }).catch(() => {}); // silently ignore restricted pages
});

// Session storage area for devtools data (survives background service worker suspension)
const sessionStore = (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TAB') {
    captureTab(sendResponse);
    return true;
  }
  if (msg.type === 'CAPTURE_FULL_PAGE') {
    captureFullPage(msg.tabId, sendResponse);
    return true;
  }
  if (msg.type === 'SUBMIT_GITHUB') {
    submitToGitHub(msg.payload, sendResponse);
    return true;
  }
  if (msg.type === 'GET_TAB_INFO') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) sendResponse({ url: tabs[0].url, title: tabs[0].title, id: tabs[0].id });
    });
    return true;
  }
  if (msg.type === 'STORE_DEVTOOLS_DATA') {
    const data = msg.data || { consoleLogs: [], networkFails: [] };
    sessionStore.set({ devtoolsData: data }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'GET_DEVTOOLS_DATA' || msg.type === 'GET_STORED_DEVTOOLS_DATA') {
    sessionStore.get({ devtoolsData: { consoleLogs: [], networkFails: [] } }, (result) => {
      sendResponse(result.devtoolsData);
    });
    return true;
  }
});

async function captureTab(sendResponse) {
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (d) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(d);
      });
    });
    sendResponse({ success: true, dataUrl });
  } catch (err) {
    console.warn('captureTab error:', err.message);
    sendResponse({ success: false, error: err.message });
  }
}

// Full-page capture: scroll through the page and stitch tiles
async function captureFullPage(tabId, sendResponse) {
  let originalScrollY = 0;
  let hasAdjusted = false;
  try {
    // Read scroll info directly from the page so full-page capture does not
    // depend on the content-script message bridge being alive.
    const scrollInfo = await evalInTab(tabId, () => ({
      scrollY: window.scrollY,
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    }));
    const { pageHeight, viewportHeight } = scrollInfo;

    // Save original scroll position
    originalScrollY = scrollInfo.scrollY;

    // Temporarily adjust position of fixed and sticky elements to prevent repetition
    await evalInTab(tabId, () => {
      const elements = document.querySelectorAll('*');
      const excludedTags = new Set(['span', 'a', 'p', 'i', 'b', 'strong', 'code', 'pre', 'img', 'svg', 'path', 'button', 'input', 'select', 'option', 'label', 'li', 'ul', 'ol', 'td', 'tr', 'th', 'tbody', 'thead', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr']);
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (excludedTags.has(el.tagName.toLowerCase())) continue;
        try {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'sticky') {
            el.setAttribute('data-bugshot-org-pos', style.position);
            const inlinePos = el.style.getPropertyValue('position');
            if (inlinePos) {
              el.setAttribute('data-bugshot-org-inline-pos', inlinePos);
              const inlinePriority = el.style.getPropertyPriority('position');
              if (inlinePriority) {
                el.setAttribute('data-bugshot-org-inline-priority', inlinePriority);
              }
            }
            el.style.setProperty('position', style.position === 'fixed' ? 'absolute' : 'static', 'important');
          }
        } catch (e) {}
      }
    });
    hasAdjusted = true;

    const tiles = [];
    let y = 0;

    // Protect against hitting Chrome's per-minute capture limits by
    // adding a small delay between captures and retrying on transient
    // quota errors. Also cap tile count to a reasonable maximum.
    const maxTiles = 60; // safety cap
    let tileCount = 0;
    async function captureVisibleWithRetry(attempts = 4, delayMs = 250) {
      for (let i = 0; i < attempts; i++) {
        try {
          const dataUrl = await new Promise((res, rej) => {
            try {
              chrome.tabs.captureVisibleTab(null, { format: 'png' }, (d) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(d);
              });
            } catch (err) {
              rej(err);
            }
          });
          return dataUrl;
        } catch (err) {
          // If this looks like a temporary quota/call-limit error, wait and retry
          const msg = String(err.message || '').toLowerCase();
          if (msg.includes('max_capture_visible_tab_calls') || msg.includes('exceeds') || i < attempts - 1) {
            await new Promise(r => setTimeout(r, delayMs * (i + 1)));
            continue;
          }
          throw err;
        }
      }
      throw new Error('captureVisibleTab: retries exhausted');
    }

    while (y < pageHeight) {
      if (tileCount >= maxTiles) break;
      await evalInTab(tabId, (targetY) => {
        window.scrollTo(0, targetY);
      }, [y]);
      // small pause to allow paint
      await new Promise(r => setTimeout(r, 120));
      const dataUrl = await captureVisibleWithRetry();
      tiles.push({ dataUrl, y });
      tileCount++;
      y += viewportHeight;
      // delay between captures to avoid hitting rate limits
      await new Promise(r => setTimeout(r, 180));
    }

    // Restore elements and scroll
    await evalInTab(tabId, () => {
      const elements = document.querySelectorAll('[data-bugshot-org-pos]');
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        try {
          const orgInlinePos = el.getAttribute('data-bugshot-org-inline-pos');
          const orgInlinePriority = el.getAttribute('data-bugshot-org-inline-priority');
          if (orgInlinePos) {
            el.style.setProperty('position', orgInlinePos, orgInlinePriority || '');
          } else {
            el.style.removeProperty('position');
          }
        } catch (e) {}
        el.removeAttribute('data-bugshot-org-pos');
        el.removeAttribute('data-bugshot-org-inline-pos');
        el.removeAttribute('data-bugshot-org-inline-priority');
      }
    });
    hasAdjusted = false;

    await evalInTab(tabId, (targetY) => {
      window.scrollTo(0, targetY);
    }, [originalScrollY]);

    sendResponse({ success: true, tiles, pageHeight, viewportHeight });
  } catch (err) {
    if (hasAdjusted) {
      try {
        await evalInTab(tabId, () => {
          const elements = document.querySelectorAll('[data-bugshot-org-pos]');
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            try {
              const orgInlinePos = el.getAttribute('data-bugshot-org-inline-pos');
              const orgInlinePriority = el.getAttribute('data-bugshot-org-inline-priority');
              if (orgInlinePos) {
                el.style.setProperty('position', orgInlinePos, orgInlinePriority || '');
              } else {
                el.style.removeProperty('position');
              }
            } catch (e) {}
            el.removeAttribute('data-bugshot-org-pos');
            el.removeAttribute('data-bugshot-org-inline-pos');
            el.removeAttribute('data-bugshot-org-inline-priority');
          }
        });
      } catch (e) {}
    }
    try {
      if (typeof originalScrollY === 'number') {
        await evalInTab(tabId, (targetY) => {
          window.scrollTo(0, targetY);
        }, [originalScrollY]);
      }
    } catch (restoreErr) {
      // ignore restoration errors
    }
    sendResponse({ success: false, error: err.message });
  }
}

function sendTabMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function evalInTab(tabId, fn, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: fn,
        args
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(results?.[0]?.result);
      }
    );
  });
}

async function uploadImageToRepo(token, owner, repo, imageDataUrl, prefix = 'bugshot') {
  try {
    const base64 = imageDataUrl.split(',')[1];
    const filename = `${prefix}-${Date.now()}.png`;
    const path = `.bugshot/${filename}`;

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          message: `bugshot: add screenshot ${filename}`,
          content: base64
        })
      }
    );

    const data = await res.json();
    if (!res.ok) { console.warn('Repo upload failed:', data.message); return null; }
    return data.content.download_url;
  } catch (err) {
    console.warn('Repo upload error:', err.message);
    return null;
  }
}

async function submitToGitHub(payload, sendResponse) {
  const { token, owner, repo, title, body, imageDataUrl, consoleDataUrl } = payload;
  try {
    let screenshotSection = '';
    let consoleSection    = '';

    if (imageDataUrl) {
      const url = await uploadImageToRepo(token, owner, repo, imageDataUrl, 'bugshot');
      screenshotSection = url
        ? `### Screenshot\n\n![Bug Screenshot](${url})\n\n`
        : `> ⚠️ Screenshot upload failed. Please attach manually.\n\n`;
    }

    if (consoleDataUrl) {
      const url = await uploadImageToRepo(token, owner, repo, consoleDataUrl, 'console');
      consoleSection = url
        ? `### Console Screenshot\n\n![Console](${url})\n\n`
        : `> ⚠️ Console screenshot upload failed.\n\n`;
    }

    const finalBody = screenshotSection + consoleSection + (screenshotSection || consoleSection ? '---\n\n' : '') + body;

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({ title, body: finalBody })
    });

    const data = await res.json();
    if (res.ok) {
      sendResponse({ success: true, url: data.html_url, number: data.number });
    } else {
      sendResponse({ success: false, error: data.message });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}
