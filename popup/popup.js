/**
 * UI Checker v3 — Popup Controller
 *
 * Horizontal bar layout — brand left, actions center, utility right.
 *
 * All features unified in one horizontal flow:
 *   Scan → Clone page → Copy component → Toggle → Report
 */

const btnScan        = document.getElementById('btn-scan');
const scanCount      = document.getElementById('scan-count');
const btnClonePage   = document.getElementById('btn-clone-page');
const btnCopyComponent = document.getElementById('btn-copy-component');
const btnToggle      = document.getElementById('btn-toggle');
const btnCopyAll     = document.getElementById('btn-copy-all');
const detailPanel    = document.getElementById('detail-panel');
const detailCount    = document.getElementById('detail-count');
const detailLabel    = document.getElementById('detail-label');
const detailBreakdown = document.getElementById('detail-breakdown');
const popupToast     = document.getElementById('popup-toast');

let overlaysVisible = true;
let currentFindings = [];
let panelExpanded = false;

// ─── Toast ──────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  popupToast.textContent = message;
  popupToast.className = 'popup-toast ' + type;
  requestAnimationFrame(() => popupToast.classList.add('visible'));
  setTimeout(() => popupToast.classList.remove('visible'), 2200);
}

// ─── Tab ID ─────────────────────────────────────────────────────────────

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// ─── Count ──────────────────────────────────────────────────────────────

function totalCount(findings) {
  if (!findings) return 0;
  return findings.reduce((sum, f) => sum + (f.findings?.length || 0), 0);
}

// ─── UI Update ──────────────────────────────────────────────────────────

function updateFromState(state) {
  if (!state) return;
  currentFindings = state.findings || [];
  const count = totalCount(currentFindings);

  // Update scan button badge
  if (count > 0) {
    scanCount.textContent = String(count);
    scanCount.classList.add('visible');
    btnScan.classList.add('has-findings');
  } else {
    scanCount.classList.remove('visible');
    btnScan.classList.remove('has-findings');
  }

  overlaysVisible = state.overlaysVisible !== false;
  btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);

  // Auto-expand detail panel when there are findings
  if (count > 0 && !panelExpanded) {
    expandPanel();
  } else if (count === 0 && panelExpanded) {
    collapsePanel();
  }

  renderBreakdown(currentFindings, count);
}

function expandPanel() {
  panelExpanded = true;
  detailPanel.style.display = '';
}

function collapsePanel() {
  panelExpanded = false;
  detailPanel.style.display = 'none';
}

function renderBreakdown(findings, count) {
  if (!count || count === 0) {
    detailCount.textContent = '0';
    detailCount.className = 'detail-count clean';
    detailLabel.textContent = 'anti-patterns found';
    detailBreakdown.innerHTML = '<div style="color:var(--uicheck-text-dim);font-size:11px">Page is clean!</div>';
    return;
  }

  detailCount.textContent = String(count);
  detailCount.className = 'detail-count';
  detailLabel.textContent = count === 1 ? 'anti-pattern found' : 'anti-patterns found';
  detailBreakdown.innerHTML = '';

  const categories = { slop: new Map(), quality: new Map() };
  for (const item of findings) {
    for (const f of (item.findings || [])) {
      const cat = f.category || 'quality';
      const groups = categories[cat] || categories.quality;
      if (!groups.has(f.type)) {
        groups.set(f.type, { name: f.name, count: 0 });
      }
      groups.get(f.type).count++;
    }
  }

  for (const [catKey, groups] of Object.entries(categories)) {
    if (groups.size === 0) continue;
    for (const [type, data] of groups) {
      const row = document.createElement('div');
      row.className = 'breakdown-row';
      row.innerHTML = `
        <span class="breakdown-dot ${catKey}"></span>
        <span class="breakdown-name">${escapeHtml(data.name)}</span>
        <span class="breakdown-count">${data.count}</span>`;
      detailBreakdown.appendChild(row);
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Load State ─────────────────────────────────────────────────────────

async function loadState() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  chrome.runtime.sendMessage(
    { action: 'get-state', tabId },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[uichecker] get-state failed:', chrome.runtime.lastError.message);
        return;
      }
      updateFromState(response);
    }
  );
}

// ─── Real-time Updates ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'findings-updated') {
    currentFindings = msg.findings || [];
    const count = totalCount(currentFindings);

    if (count > 0) {
      scanCount.textContent = String(count);
      scanCount.classList.add('visible');
      btnScan.classList.add('has-findings');
    } else {
      scanCount.classList.remove('visible');
      btnScan.classList.remove('has-findings');
    }

    btnScan.querySelector('span:not(.scan-count)').textContent = 'Scan';
    btnScan.disabled = false;

    if (count > 0 && !panelExpanded) expandPanel();
    renderBreakdown(currentFindings, count);
  }

  if (msg.action === 'overlays-toggled-broadcast') {
    overlaysVisible = msg.visible;
    btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
  }

  if (msg.action === 'clone-result') {
    if (msg.success) {
      showToast(msg.message || 'Clone complete!', 'success');
    } else {
      showToast(msg.message || 'Clone failed', 'error');
    }
    btnClonePage.querySelector('span').textContent = 'Clone page';
    btnClonePage.disabled = false;
  }
});

// ── Scan Button ──

btnScan.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  btnScan.querySelector('span:not(.scan-count)').textContent = 'Scanning';
  btnScan.disabled = true;
  chrome.runtime.sendMessage({ action: 'scan', tabId });
});

// ── Clone Page Button ──

btnClonePage.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  btnClonePage.querySelector('span').textContent = 'Cloning';
  btnClonePage.disabled = true;
  chrome.runtime.sendMessage({ action: 'clone-page', tabId });
  setTimeout(() => {
    btnClonePage.querySelector('span').textContent = 'Clone page';
    btnClonePage.disabled = false;
  }, 15000);
});

// ── Copy Component Button ──

btnCopyComponent.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ action: 'start-component-picker', tabId });
  window.close(); // Close popup so user can interact with the page
});

// ── Toggle Overlays Button ──

btnToggle.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ action: 'toggle-overlays', tabId });
  overlaysVisible = !overlaysVisible;
  btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
});

// ── Copy Report Button ──

btnCopyAll.addEventListener('click', async () => {
  if (!currentFindings.length) {
    showToast('No findings to copy', 'info');
    return;
  }
  const text = formatFindingsForCopy(currentFindings);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Report copied!', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
});

function formatFindingsForCopy(findings) {
  if (!findings.length) return 'UI Checker found no anti-patterns on this page.';
  const lines = ['# UI Checker findings'];
  const groups = { slop: [], quality: [] };
  for (const item of findings) {
    for (const f of (item.findings || [])) {
      const cat = f.category || 'quality';
      const where = item.isPageLevel ? '_(page-level)_' : `\`${item.selector}\``;
      groups[cat].push(`- **${f.name}** at ${where}: ${f.detail}`);
    }
  }
  if (groups.slop.length) lines.push('', `## AI tells (${groups.slop.length})`, ...groups.slop);
  if (groups.quality.length) lines.push('', `## Quality issues (${groups.quality.length})`, ...groups.quality);
  lines.push('', '---', 'Detected by UI Checker v3.');
  return lines.join('\n');
}

// ─── Initialize ─────────────────────────────────────────────────────────

loadState();
