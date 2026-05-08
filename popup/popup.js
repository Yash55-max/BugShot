// popup.js

// ─── State ───────────────────────────────────────────────────────────────────
let screenshotDataUrl = null;
let baseImageUrl      = null;
let systemInfo        = null;
let activeTool        = 'pen';
let activeColor       = '#FF3B3B';
let severity          = 'medium';
let isDrawing         = false;
let drawStart         = { x: 0, y: 0 };
let undoStack         = [];
let canvas, ctx;

// Console screenshot
let consoleScreenshotUrl = null;
let consoleCanvas, consoleCtx;

// Crop state
let cropMode    = false;
let cropDragging = false;
let cropStart   = { x: 0, y: 0 };
let cropRect    = null; // { x, y, w, h } in canvas pixels

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  canvas = document.getElementById('screenshot-canvas');
  ctx    = canvas.getContext('2d', { willReadFrequently: true });

  bindCapture();
  bindAnnotationTools();
  bindCrop();
  bindConsoleCapture();
  bindReportStep();
  bindSettings();
  loadSettings();
  initAutoResize();
  await fetchSystemInfo();
});

// ─── Auto-resize textareas ────────────────────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
function initAutoResize() {
  document.querySelectorAll('textarea').forEach(ta => {
    ta.addEventListener('input', () => autoResize(ta));
    autoResize(ta);
  });
}

// ─── System Info ──────────────────────────────────────────────────────────────
async function fetchSystemInfo() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return resolve();
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_SYSTEM_INFO' }, (info) => {
        if (chrome.runtime.lastError || !info) {
          systemInfo = {
            url: tabs[0].url, title: tabs[0].title,
            userAgent: navigator.userAgent,
            screenResolution: `${screen.width}x${screen.height}`,
            viewportSize: 'unknown', platform: navigator.platform,
            language: navigator.language, timestamp: new Date().toISOString(),
            steps: [], errors: [], network: []
          };
        } else {
          systemInfo = info;
        }
        resolve();
      });
    });
  });
}

// ─── Screenshot Capture ───────────────────────────────────────────────────────
function bindCapture() {
  document.getElementById('btn-capture').addEventListener('click', async () => {
    const btn = document.getElementById('btn-capture');
    btn.disabled = true;
    btn.textContent = 'Capturing...';
    chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (res) => {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">⬡</span> Capture Viewport';
      if (!res?.success) { showToast('Capture failed: ' + (res?.error || 'unknown'), 'error'); return; }
      loadScreenshotToCanvas(res.dataUrl);
    });
  });

  document.getElementById('btn-capture-full').addEventListener('click', async () => {
    const btn = document.getElementById('btn-capture-full');
    btn.disabled = true;
    btn.textContent = 'Capturing...';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { btn.disabled = false; btn.textContent = 'Full Page'; return; }
      chrome.runtime.sendMessage({ type: 'CAPTURE_FULL_PAGE', tabId: tabs[0].id }, (res) => {
        btn.disabled = false;
        btn.textContent = 'Full Page';
        if (!res?.success) { showToast('Full capture failed: ' + (res?.error || 'unknown'), 'error'); return; }
        stitchTiles(res.tiles, res.pageHeight, res.viewportHeight);
      });
    });
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    showStep('step-report');
    renderMeta();
    autoFillSteps();
  });
}

// Stitch scroll tiles into one tall canvas, then load it
function stitchTiles(tiles, pageHeight, viewportHeight) {
  if (!tiles?.length) return;
  const firstImg = new Image();
  firstImg.onload = () => {
    const tileW = firstImg.width;
    const tileH = firstImg.height;
    const offscreen = document.createElement('canvas');
    offscreen.width  = tileW;
    offscreen.height = pageHeight;
    const offCtx = offscreen.getContext('2d');

    let loaded = 0;
    tiles.forEach((tile, i) => {
      const img = new Image();
      img.onload = () => {
        // Each tile was captured at scroll position tile.y
        // But the last tile may overlap — clip to avoid duplication
        const destY = tile.y;
        const srcH  = Math.min(tileH, pageHeight - tile.y);
        offCtx.drawImage(img, 0, 0, tileW, srcH, 0, destY, tileW, srcH);
        loaded++;
        if (loaded === tiles.length) {
          loadScreenshotToCanvas(offscreen.toDataURL('image/png'));
        }
      };
      img.src = tile.dataUrl;
    });
  };
  firstImg.src = tiles[0].dataUrl;
}

function loadScreenshotToCanvas(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const maxW = 420;
    const scale = maxW / img.width;
    canvas.width  = img.width;
    canvas.height = img.height;
    canvas.style.width  = maxW + 'px';
    canvas.style.height = Math.round(img.height * scale) + 'px';
    ctx.drawImage(img, 0, 0);

    baseImageUrl      = dataUrl;
    screenshotDataUrl = canvas.toDataURL('image/png');
    undoStack = [];
    saveUndo();

    document.getElementById('preview-placeholder').style.display = 'none';
    canvas.style.display = 'block';
    document.getElementById('annotation-tools').style.display = 'flex';
    document.getElementById('btn-next').style.display = 'block';
    document.getElementById('console-capture-area').style.display = 'block';
    exitCropMode();
  };
  img.src = dataUrl;
}

// ─── Console Capture ─────────────────────────────────────────────────────────
function bindConsoleCapture() {
  consoleCanvas = document.getElementById('console-canvas');
  consoleCtx    = consoleCanvas.getContext('2d', { willReadFrequently: true });

  document.getElementById('btn-capture-console').addEventListener('click', () => {
    const btn = document.getElementById('btn-capture-console');

    // We can't capture DevTools directly — it's a separate Chrome panel.
    // Workflow: save popup state to storage, close popup, user arranges their
    // screen so DevTools console is visible, then the background alarm fires
    // after a countdown and captures the tab viewport (which should now show
    // the console if user has docked DevTools bottom/right or undocked it).
    // A simpler reliable approach: countdown then capture, user sees timer.

    let count = 3;
    btn.disabled = true;
    btn.style.minWidth = '80px';
    btn.textContent = `Capturing in ${count}s`;

    // Show instruction
    document.getElementById('console-placeholder').textContent =
      'Switch to your DevTools Console tab now...';
    document.getElementById('console-placeholder').style.display = 'block';

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        btn.textContent = `Capturing in ${count}s`;
      } else {
        clearInterval(interval);
        btn.textContent = 'Capturing...';

        chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (res) => {
          btn.disabled = false;
          btn.textContent = '+ Capture';
          document.getElementById('console-placeholder').textContent =
            'Open DevTools console, then click Capture';

          if (!res?.success) { showToast('Capture failed', 'error'); return; }

          const img = new Image();
          img.onload = () => {
            const maxW = 392;
            const scale = maxW / img.width;
            consoleCanvas.width  = img.width;
            consoleCanvas.height = img.height;
            consoleCanvas.style.width  = maxW + 'px';
            consoleCanvas.style.height = Math.round(img.height * scale) + 'px';
            consoleCtx.drawImage(img, 0, 0);
            consoleScreenshotUrl = consoleCanvas.toDataURL('image/png');

            document.getElementById('console-placeholder').style.display = 'none';
            consoleCanvas.style.display = 'block';
            document.getElementById('btn-remove-console').style.display = 'inline-block';
            showToast('Console screenshot captured', 'success');
          };
          img.src = res.dataUrl;
        });
      }
    }, 1000);
  });

  document.getElementById('btn-remove-console').addEventListener('click', () => {
    consoleScreenshotUrl = null;
    consoleCanvas.style.display = 'none';
    document.getElementById('console-placeholder').style.display = 'block';
    document.getElementById('btn-remove-console').style.display = 'none';
  });
}

// ─── Annotation ───────────────────────────────────────────────────────────────
function bindAnnotationTools() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.id === 'btn-crop-mode') return; // handled separately
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTool = btn.dataset.tool;
      exitCropMode();
    });
  });

  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      activeColor = dot.dataset.color;
    });
  });

  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-clear').addEventListener('click', clearAnnotations);

  canvas.addEventListener('mousedown', onDrawStart);
  canvas.addEventListener('mousemove', onDrawMove);
  canvas.addEventListener('mouseup',   onDrawEnd);
  canvas.addEventListener('mouseleave', onDrawEnd);
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (canvas.height / rect.height)
  };
}

function onDrawStart(e) {
  if (cropMode) return;
  isDrawing = true;
  drawStart = getCanvasPos(e);
  if (activeTool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(drawStart.x, drawStart.y);
  }
}

function onDrawMove(e) {
  if (!isDrawing || cropMode) return;
  const pos = getCanvasPos(e);
  if (activeTool === 'pen') {
    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  } else if (activeTool === 'rect' || activeTool === 'arrow') {
    restoreLastSync();
    if (activeTool === 'rect') {
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeRect(drawStart.x, drawStart.y, pos.x - drawStart.x, pos.y - drawStart.y);
    } else {
      drawArrow(drawStart.x, drawStart.y, pos.x, pos.y);
    }
  }
}

function onDrawEnd(e) {
  if (!isDrawing || cropMode) return;
  isDrawing = false;
  if (activeTool === 'text') {
    const pos = getCanvasPos(e);
    const text = prompt('Enter label text:');
    if (text) {
      ctx.font = 'bold 16px Space Mono, monospace';
      ctx.fillStyle = activeColor;
      ctx.fillText(text, pos.x, pos.y);
    }
  }
  saveUndo();
  screenshotDataUrl = canvas.toDataURL('image/png');
}

function drawArrow(x1, y1, x2, y2) {
  const headLen = 16;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = activeColor;
  ctx.fillStyle   = activeColor;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function saveUndo() {
  undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (undoStack.length > 20) undoStack.shift();
}
function restoreLastSync() {
  if (undoStack.length) ctx.putImageData(undoStack[undoStack.length - 1], 0, 0);
}
function undo() {
  if (undoStack.length <= 1) return;
  undoStack.pop();
  ctx.putImageData(undoStack[undoStack.length - 1], 0, 0);
  screenshotDataUrl = canvas.toDataURL('image/png');
}
function clearAnnotations() {
  if (!baseImageUrl) return;
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    undoStack = [];
    saveUndo();
    screenshotDataUrl = canvas.toDataURL('image/png');
  };
  img.src = baseImageUrl;
}

// ─── Crop ─────────────────────────────────────────────────────────────────────
function bindCrop() {
  const btn     = document.getElementById('btn-crop-mode');
  const overlay = document.getElementById('crop-overlay');
  const cropBox = document.getElementById('crop-box');

  btn.addEventListener('click', () => {
    if (!baseImageUrl) return;
    cropMode = !cropMode;
    if (cropMode) {
      btn.classList.add('active');
      overlay.style.display = 'block';
      cropBox.style.display = 'none';
      cropRect = null;
    } else {
      exitCropMode();
    }
  });

  overlay.addEventListener('mousedown', (e) => {
    if (!cropMode) return;
    const rect = overlay.getBoundingClientRect();
    cropStart    = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    cropDragging = true;
    cropBox.style.display = 'block';
    cropBox.style.left   = cropStart.x + 'px';
    cropBox.style.top    = cropStart.y + 'px';
    cropBox.style.width  = '0px';
    cropBox.style.height = '0px';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!cropDragging) return;
    const rect = overlay.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const x = Math.min(cx, cropStart.x);
    const y = Math.min(cy, cropStart.y);
    const w = Math.abs(cx - cropStart.x);
    const h = Math.abs(cy - cropStart.y);
    cropBox.style.left   = x + 'px';
    cropBox.style.top    = y + 'px';
    cropBox.style.width  = w + 'px';
    cropBox.style.height = h + 'px';
    // Store in canvas pixel coords
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    cropRect = { x: x * scaleX, y: y * scaleY, w: w * scaleX, h: h * scaleY };
  });

  overlay.addEventListener('mouseup', () => { cropDragging = false; });

  overlay.addEventListener('dblclick', () => {
    if (!cropRect || cropRect.w < 5 || cropRect.h < 5) { exitCropMode(); return; }
    applyCrop();
  });
}

function applyCrop() {
  const { x, y, w, h } = cropRect;
  const cropped = ctx.getImageData(x, y, w, h);
  canvas.width  = w;
  canvas.height = h;
  ctx.putImageData(cropped, 0, 0);
  const croppedUrl = canvas.toDataURL('image/png');
  // Reload as new base
  baseImageUrl = croppedUrl;
  screenshotDataUrl = croppedUrl;
  undoStack = [];
  saveUndo();
  // Resize display
  const maxW = 420;
  canvas.style.width  = maxW + 'px';
  canvas.style.height = Math.round(h * (maxW / w)) + 'px';
  exitCropMode();
  showToast('Cropped', 'success');
}

function exitCropMode() {
  cropMode     = false;
  cropDragging = false;
  cropRect     = null;
  document.getElementById('crop-overlay').style.display = 'none';
  document.getElementById('btn-crop-mode').classList.remove('active');
}

// ─── Report Step ──────────────────────────────────────────────────────────────
function bindReportStep() {
  document.getElementById('btn-back').addEventListener('click', () => showStep('step-capture'));
  document.querySelectorAll('.sev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      severity = btn.dataset.sev;
    });
  });
  document.getElementById('btn-submit-github').addEventListener('click', submitGitHub);
  document.getElementById('btn-copy-markdown').addEventListener('click', copyMarkdown);
}

function autoFillSteps() {
  if (!systemInfo?.steps?.length) return;
  const ta = document.getElementById('bug-steps');
  if (ta.value.trim()) return; // don't overwrite if user already typed

  const lines = systemInfo.steps.map((s, i) => {
    if (s.type === 'click') return `${i + 1}. Clicked ${s.desc}`;
    if (s.type === 'navigate') return `${i + 1}. Navigated to ${s.url}`;
    return `${i + 1}. ${s.desc || s.type}`;
  });
  ta.value = lines.join('\n');
  autoResize(ta);

  const hint = document.getElementById('steps-hint');
  hint.textContent = `auto-filled ${lines.length} steps`;
}

function renderMeta() {
  if (!systemInfo) return;
  const ua = parseUA(systemInfo.userAgent);

  document.getElementById('meta-display').innerHTML = `
    <span>URL:</span> ${truncate(systemInfo.url, 45)}<br>
    <span>Browser:</span> ${ua.browser}<br>
    <span>OS:</span> ${ua.os}<br>
    <span>Screen:</span> ${systemInfo.screenResolution} / viewport ${systemInfo.viewportSize}<br>
    <span>Time:</span> ${new Date(systemInfo.timestamp).toLocaleString()}
  `;

  // 1. Ask devtools page to sync + push latest data to background
  // 2. Then read from background (which now has fresh data)
  // 3. Merge with sessionStorage data from content script
  chrome.runtime.sendMessage({ type: 'GET_DEVTOOLS_DATA' }, () => {
    // Small extra delay to let devtools page finish its eval + push cycle
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'GET_STORED_DEVTOOLS_DATA' }, (devData) => {
        const dtErrors  = devData?.consoleLogs  || [];
        const dtNetwork = devData?.networkFails || [];
        const ssErrors  = systemInfo.errors     || [];
        const ssNetwork = systemInfo.network    || [];

        const mergeErrors = [...dtErrors, ...ssErrors]
          .filter((e, i, arr) => arr.findIndex(x => x.msg === e.msg) === i)
          .slice(-15);

        const mergeNetwork = [...dtNetwork, ...ssNetwork]
          .filter((n, i, arr) => arr.findIndex(x => x.url === n.url && x.status === n.status) === i)
          .slice(-20);

        if (mergeErrors.length) {
          document.getElementById('errors-box').style.display = 'block';
          document.getElementById('errors-display').innerHTML = mergeErrors.map(e => {
            const cls = e.msg?.startsWith('[warn]') ? 'warn-line' : 'error-line';
            return `<div class="${cls}">${escHtml(e.msg)}</div>`;
          }).join('');
        }

        if (mergeNetwork.length) {
          document.getElementById('network-box').style.display = 'block';
          document.getElementById('network-display').innerHTML = mergeNetwork.map(n => {
            const cls = n.status >= 500 ? 'status-5xx' : n.status >= 400 ? 'status-4xx' : 'status-0';
            return `<div class="network-line ${cls}">${n.status || 'ERR'} ${n.method} ${escHtml(truncate(n.url, 70))}</div>`;
          }).join('');
        }

        systemInfo._mergedErrors  = mergeErrors;
        systemInfo._mergedNetwork = mergeNetwork;
      });
    }, 500);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function parseUA(ua) {
  let browser = 'Unknown', os = 'Unknown';
  if (ua.includes('Chrome'))  browser = 'Chrome '  + (ua.match(/Chrome\/([\d.]+)/)?.[1]  || '');
  else if (ua.includes('Firefox')) browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '');
  else if (ua.includes('Safari'))  browser = 'Safari';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac'))    os = 'macOS';
  else if (ua.includes('Linux'))  os = 'Linux';
  else if (ua.includes('Android'))os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  return { browser, os };
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function buildMarkdown() {
  const title    = document.getElementById('bug-title').value.trim()    || 'Untitled Bug';
  const steps    = document.getElementById('bug-steps').value.trim();
  const expected = document.getElementById('bug-expected').value.trim();
  const actual   = document.getElementById('bug-actual').value.trim();
  const ua       = parseUA(systemInfo?.userAgent || '');
  const sevLabel = { low:'🟢 Low', medium:'🟡 Medium', high:'🟠 High', critical:'🔴 Critical' }[severity];

  const errors  = (systemInfo?._mergedErrors  || systemInfo?.errors  || []).map(e => `- ${e.msg}`).join('\n');
  const network = (systemInfo?._mergedNetwork || systemInfo?.network || []).map(n => `- \`${n.status || 'ERR'} ${n.method} ${n.url}\``).join('\n');

  return `## Bug Report: ${title}

**Severity:** ${sevLabel}

---

### Steps to Reproduce
${steps || '_Not provided_'}

### Expected Behavior
${expected || '_Not provided_'}

### Actual Behavior
${actual || '_Not provided_'}

---

### Environment

| Field | Value |
|---|---|
| URL | \`${systemInfo?.url || 'unknown'}\` |
| Browser | ${ua.browser} |
| OS | ${ua.os} |
| Screen | ${systemInfo?.screenResolution || 'unknown'} |
| Viewport | ${systemInfo?.viewportSize || 'unknown'} |
| Timestamp | ${systemInfo?.timestamp || new Date().toISOString()} |

${errors  ? `### Console Errors\n${errors}\n`  : ''}
${network ? `### Network Failures\n${network}\n` : ''}
---
*Filed via BugShot Chrome Extension*`;
}

async function submitGitHub() {
  const { ghToken, ghOwner, ghRepo } = await getSettings();
  if (!ghToken || !ghOwner || !ghRepo) {
    showToast('Set GitHub credentials in Settings first', 'error');
    showStep('step-settings');
    return;
  }
  const titleVal = document.getElementById('bug-title').value.trim();
  if (!titleVal) {
    document.getElementById('bug-title').focus();
    showToast('Add a title before submitting', 'error');
    return;
  }

  const body = buildMarkdown();
  const btn  = document.getElementById('btn-submit-github');
  btn.disabled = true;
  btn.textContent = screenshotDataUrl ? 'Uploading screenshot...' : 'Submitting...';

  chrome.runtime.sendMessage({
    type: 'SUBMIT_GITHUB',
    payload: {
      token: ghToken, owner: ghOwner, repo: ghRepo,
      title: titleVal, body,
      imageDataUrl: screenshotDataUrl,
      consoleDataUrl: consoleScreenshotUrl
    }
  }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Submit to GitHub';
    if (res?.success) {
      showToast(`Issue #${res.number} created!`, 'success');
      setTimeout(() => chrome.tabs.create({ url: res.url }), 1000);
    } else {
      showToast('GitHub error: ' + (res?.error || 'unknown'), 'error');
    }
  });
}

async function copyMarkdown() {
  await navigator.clipboard.writeText(buildMarkdown());
  showToast('Markdown copied!', 'success');
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function bindSettings() {
  document.getElementById('btn-settings').addEventListener('click', () => showStep('step-settings'));
  document.getElementById('btn-settings-back').addEventListener('click', () => showStep('step-capture'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
}
async function loadSettings() {
  const { ghToken, ghOwner, ghRepo } = await getSettings();
  if (ghToken) document.getElementById('gh-token').value = ghToken;
  if (ghOwner) document.getElementById('gh-owner').value = ghOwner;
  if (ghRepo)  document.getElementById('gh-repo').value  = ghRepo;
}
function saveSettings() {
  const token = document.getElementById('gh-token').value.trim();
  const owner = document.getElementById('gh-owner').value.trim();
  const repo  = document.getElementById('gh-repo').value.trim();
  chrome.storage.local.set({ ghToken: token, ghOwner: owner, ghRepo: repo }, () => {
    document.getElementById('settings-status').textContent = 'Saved.';
    setTimeout(() => { document.getElementById('settings-status').textContent = ''; showStep('step-capture'); }, 1000);
  });
}
function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(['ghToken', 'ghOwner', 'ghRepo'], resolve));
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('#' + id + ' textarea').forEach(ta => autoResize(ta));
}
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'toast show ' + type;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}
