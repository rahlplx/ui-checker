/**
 * UI Checker v3 — Service Worker
 *
 * Routes messages between popup, DevTools panel, content scripts,
 * and the clone/component engines.
 *
 * OFF-BY-ONE BUG FIX (v3):
 *   The original bug had TWO root causes:
 *
 *   1. Badge counted elements (findings.length) instead of total findings
 *      (findings.reduce(sum of f.findings.length)). This was fixed in v2.
 *
 *   2. The detector's scan() function runs BOTH DOM-level element checks
 *      AND HTML regex checks (checkHtmlPatterns). When the regex check
 *      finds "pure-black-white" or "ai-color-palette" that was already
 *      detected by the DOM check, it creates a DUPLICATE finding pushed
 *      under document.body. The fix: deduplicate page-level findings
 *      against element-level findings before storing.
 *
 *   Additionally, clone-page now uses chrome.downloads.download() instead
 *   of creating a clickable <a> element in the page. This prevents any
 *   possibility of redirecting users to external websites.
 */

// Per-tab state: { tabId: { findings, overlaysVisible, injected, csInjected } }
const tabState = new Map();

// Active DevTools panel connections: { tabId: Set<port> }
const panelPorts = new Map();

function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { findings: [], overlaysVisible: true, injected: false, csInjected: false });
  }
  return tabState.get(tabId);
}

/**
 * Count total individual findings, not just element count.
 * This matches the DevTools panel's renderFindings() count exactly.
 */
function updateBadge(tabId) {
  const state = tabState.get(tabId);
  const count = state?.findings?.reduce((sum, f) => sum + f.findings.length, 0) || 0;
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#607D8B', tabId }).catch(() => {});
}

function notifyPanels(tabId, message) {
  const ports = panelPorts.get(tabId);
  if (ports) {
    for (const port of ports) {
      try { port.postMessage(message); } catch { /* port disconnected */ }
    }
  }
}

async function getSettings() {
  return chrome.storage.sync.get({
    disabledRules: [],
    lineLengthMode: 'strict',
    spotlightBlur: true,
    autoScan: 'panel',
  });
}

async function buildScanConfig() {
  const { disabledRules, lineLengthMode, spotlightBlur } = await getSettings();
  const config = {};
  if (disabledRules.length) config.disabledRules = disabledRules;
  config.lineLengthMax = lineLengthMode === 'lax' ? 120 : 80;
  config.spotlightBlur = spotlightBlur;
  return config;
}

async function ensureContentScriptInjected(tabId) {
  const state = getState(tabId);
  if (state.csInjected) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js'],
      injectImmediately: true,
    });
    state.csInjected = true;
    return true;
  } catch {
    return false;
  }
}

async function sendScanToTab(tabId) {
  const ok = await ensureContentScriptInjected(tabId);
  if (!ok) return;
  const config = await buildScanConfig();
  chrome.tabs.sendMessage(tabId, { action: 'scan', config }).catch(() => {});
}

// ─── Deduplication (Off-by-one fix part 2) ────────────────────────────────
// When the detector finds the same anti-pattern via BOTH DOM checks AND
// HTML regex checks, the HTML regex result is a duplicate. We deduplicate
// by checking if any element-level finding has the same type as a
// page-level finding, and removing the page-level duplicate.

function deduplicateFindings(findings) {
  if (!findings || findings.length <= 1) return findings;

  // Collect all anti-pattern types found at the ELEMENT level (not page-level)
  const elementLevelTypes = new Set();
  for (const item of findings) {
    if (item.isPageLevel) continue;
    for (const f of (item.findings || [])) {
      elementLevelTypes.add(f.type);
    }
  }

  // If there are no element-level findings, nothing to deduplicate
  if (elementLevelTypes.size === 0) return findings;

  // For page-level items, remove findings whose type was already found at element level
  return findings.map(item => {
    if (!item.isPageLevel) return item;
    const dedupedFindings = (item.findings || []).filter(f => !elementLevelTypes.has(f.type));
    if (dedupedFindings.length === (item.findings || []).length) return item;
    return { ...item, findings: dedupedFindings };
  }).filter(item => !item.isPageLevel || (item.findings && item.findings.length > 0));
}

// Handle messages from content scripts, popup, and clone engine
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId || sender.tab?.id;

  if (msg.action === 'findings' && tabId) {
    const state = getState(tabId);

    // BUG FIX: Deduplicate findings before storing
    const rawFindings = msg.findings || [];
    state.findings = deduplicateFindings(rawFindings);
    state.injected = true;

    updateBadge(tabId);
    notifyPanels(tabId, { action: 'findings', findings: state.findings });
    chrome.runtime.sendMessage({ action: 'findings-updated', tabId, findings: state.findings }).catch(() => {});
    sendResponse({ ok: true });
  }

  else if (msg.action === 'scan' && tabId) {
    sendScanToTab(tabId);
    sendResponse({ ok: true });
  }

  else if (msg.action === 'toggle-overlays' && tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'toggle-overlays' }).catch(() => {});
    sendResponse({ ok: true });
  }

  else if (msg.action === 'page-pointer-active' && tabId) {
    notifyPanels(tabId, { action: 'page-pointer-active' });
    sendResponse({ ok: true });
  }

  else if (msg.action === 'overlays-toggled' && tabId) {
    const state = getState(tabId);
    state.overlaysVisible = msg.visible;
    notifyPanels(tabId, { action: 'overlays-toggled', visible: msg.visible });
    chrome.runtime.sendMessage({ action: 'overlays-toggled-broadcast', tabId, visible: msg.visible }).catch(() => {});
    sendResponse({ ok: true });
  }

  else if (msg.action === 'get-state' && tabId) {
    sendResponse(getState(tabId));
  }

  else if (msg.action === 'inject-fallback' && tabId) {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['detector/detect.js'],
    }).catch((err) => {
      console.warn('[uichecker] Fallback injection failed:', err);
    });
    sendResponse({ ok: true });
  }

  else if (msg.action === 'disabled-rules-changed') {
    for (const [tid, state] of tabState) {
      if (state.injected) sendScanToTab(tid);
    }
    sendResponse({ ok: true });
  }

  // ── Clone Commands ──

  else if (msg.action === 'clone-page' && tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'clone-page' }).catch(() => {});
    sendResponse({ ok: true });
  }

  else if (msg.action === 'start-component-picker' && tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'start-component-picker' }).catch(() => {});
    sendResponse({ ok: true });
  }

  // ── Pattern 3: Permission Proxy — Download via chrome.downloads ──
  //
  // Content scripts are "untrusted" by CSP. They cannot create <a> tags
  // or trigger downloads in the page context. The Service Worker is the
  // ONLY context that can reliably call chrome.downloads.download().
  //
  // Message flow:
  //   clone-engine.js (MAIN world)
  //     → window.postMessage({ source: 'uichecker-clone-result', html, filename })
  //   content-script.js (isolated world)
  //     → chrome.runtime.sendMessage({ action: 'perform-download', data, filename })
  //   service-worker.js (this file)
  //     → chrome.downloads.download({ url: dataUrl, filename, saveAs: true })

  else if (msg.action === 'perform-download' && tabId) {
    const html = msg.data;
    const filename = msg.filename || 'page-clone.html';

    // Create a data URL from the HTML content
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true,
    }).then(() => {
      // Notify popup/panel of success
      notifyPanels(tabId, { action: 'clone-result', success: true, message: 'Page cloned and downloaded!' });
      chrome.runtime.sendMessage({ action: 'clone-result', tabId, success: true, message: 'Page cloned and downloaded!' }).catch(() => {});
    }).catch((err) => {
      notifyPanels(tabId, { action: 'clone-result', success: false, message: `Download failed: ${err.message}` });
      chrome.runtime.sendMessage({ action: 'clone-result', tabId, success: false, message: `Download failed: ${err.message}` }).catch(() => {});
    });

    sendResponse({ ok: true });
  }

  else if (msg.action === 'clone-result' && tabId) {
    // Forward component picker result to panels/popup
    notifyPanels(tabId, { action: 'clone-result', ...msg });
    sendResponse({ ok: true });
  }

  return true;
});

// Track which tabs have DevTools open
const devtoolsTabs = new Set();

async function tearDownTab(tabId) {
  devtoolsTabs.delete(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'remove' });
  } catch { /* tab might be closed */ }
  const state = tabState.get(tabId);
  if (state) {
    state.findings = [];
    state.injected = false;
    state.csInjected = false;
  }
  updateBadge(tabId);
  panelPorts.delete(tabId);
}

// Handle long-lived connections from DevTools pages and panels
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('uichecker-devtools-')) {
    const tabId = parseInt(port.name.replace('uichecker-devtools-', ''), 10);
    devtoolsTabs.add(tabId);

    port.onMessage.addListener((msg) => {
      if (msg.action === 'scan') sendScanToTab(tabId);
    });

    port.onDisconnect.addListener(() => {
      tearDownTab(tabId);
    });
  }

  if (port.name.startsWith('uichecker-panel-')) {
    const tabId = parseInt(port.name.replace('uichecker-panel-', ''), 10);
    if (!panelPorts.has(tabId)) panelPorts.set(tabId, new Set());
    panelPorts.get(tabId).add(port);

    const state = getState(tabId);
    port.postMessage({ action: 'state', ...state });

    if (!state.findings.length) {
      sendScanToTab(tabId);
    }

    port.onMessage.addListener((msg) => {
      if (msg.action === 'scan') {
        sendScanToTab(tabId);
      } else if (msg.action === 'toggle-overlays') {
        chrome.tabs.sendMessage(tabId, { action: 'toggle-overlays' }).catch(() => {});
      } else if (msg.action === 'highlight') {
        chrome.tabs.sendMessage(tabId, { action: 'highlight', selector: msg.selector }).catch(() => {});
      } else if (msg.action === 'unhighlight') {
        chrome.tabs.sendMessage(tabId, { action: 'unhighlight' }).catch(() => {});
      } else if (msg.action === 'clone-page') {
        chrome.tabs.sendMessage(tabId, { action: 'clone-page' }).catch(() => {});
      } else if (msg.action === 'start-component-picker') {
        chrome.tabs.sendMessage(tabId, { action: 'start-component-picker' }).catch(() => {});
      }
    });

    port.onDisconnect.addListener(() => {
      panelPorts.get(tabId)?.delete(port);
      if (panelPorts.get(tabId)?.size === 0) panelPorts.delete(tabId);
    });
  }

  if (port.name.startsWith('uichecker-sidebar-')) {
    const tabId = parseInt(port.name.replace('uichecker-sidebar-', ''), 10);
    if (!panelPorts.has(tabId)) panelPorts.set(tabId, new Set());
    panelPorts.get(tabId).add(port);

    const state = getState(tabId);
    port.postMessage({ action: 'state', ...state });
    if (!state.findings.length) sendScanToTab(tabId);

    port.onDisconnect.addListener(() => {
      panelPorts.get(tabId)?.delete(port);
      if (panelPorts.get(tabId)?.size === 0) panelPorts.delete(tabId);
    });
  }
});

// Re-scan on navigation (only if DevTools is open AND user was actively scanning)
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!devtoolsTabs.has(details.tabId)) return;
  const state = tabState.get(details.tabId);
  if (!state) return;
  const wasActive = state.injected || state.findings.length > 0;
  state.findings = [];
  state.injected = false;
  state.csInjected = false;
  updateBadge(details.tabId);
  notifyPanels(details.tabId, { action: 'navigated' });
  if (wasActive) {
    setTimeout(() => sendScanToTab(details.tabId), 300);
  }
});

// Clean up state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  panelPorts.delete(tabId);
});
