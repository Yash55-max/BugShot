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

// In-memory store for devtools data (service worker resets between sessions)
let storedDevtoolsData = { consoleLogs: [], networkFails: [] };

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
    storedDevtoolsData = msg.data || { consoleLogs: [], networkFails: [] };
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_DEVTOOLS_DATA') {
    // Forward to devtools page if available, else return stored
    sendResponse(storedDevtoolsData);
    return true;
  }
  if (msg.type === 'GET_STORED_DEVTOOLS_DATA') {
    sendResponse(storedDevtoolsData);
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
            chrome.tabs.captureVisibleTab(null, { format: 'png' }, (d) => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
              else res(d);
            });
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

    // Restore original scroll
    await evalInTab(tabId, (targetY) => {
      window.scrollTo(0, targetY);
    }, [originalScrollY]);

    sendResponse({ success: true, tiles, pageHeight, viewportHeight });
  } catch (err) {
    // Attempt to restore original scroll position before returning error
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
