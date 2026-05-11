/**
 * UI Checker v3 — Content Script Bridge
 *
 * Bridges between the extension messaging system and:
 *   1. Page-context anti-pattern detector
 *   2. Clone Full Page engine
 *   3. Component Picker engine
 *
 * Wrapped in an IIFE with an idempotency flag so re-injection is a no-op.
 * This ensures the popup's "Scan page" button always works correctly
 * regardless of how many times the content script is injected.
 */
(function () {
  if (window.__UI_CHECKER_CS_LOADED__) return;
  window.__UI_CHECKER_CS_LOADED__ = true;

  let detectorInjected = false;
  let pendingScan = false;
  let scanConfig = null;
  let cloneEngineInjected = false;
  let pickerInjected = false;

  // ─── Message Router ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Anti-pattern detection commands
    if (msg.action === 'scan') {
      scanConfig = msg.config || null;
      injectDetectorAndScan();
      sendResponse({ ok: true });
    }
    else if (msg.action === 'toggle-overlays') {
      window.postMessage({ source: 'uichecker-command', action: 'toggle-overlays' }, '*');
      sendResponse({ ok: true });
    }
    else if (msg.action === 'remove') {
      window.postMessage({ source: 'uichecker-command', action: 'remove' }, '*');
      detectorInjected = false;
      sendResponse({ ok: true });
    }
    else if (msg.action === 'highlight') {
      window.postMessage({ source: 'uichecker-command', action: 'highlight', selector: msg.selector }, '*');
      sendResponse({ ok: true });
    }
    else if (msg.action === 'unhighlight') {
      window.postMessage({ source: 'uichecker-command', action: 'unhighlight' }, '*');
      sendResponse({ ok: true });
    }

    // Clone commands
    else if (msg.action === 'clone-page') {
      injectCloneEngine(() => {
        window.postMessage({ source: 'uichecker-command', action: 'clone-page' }, '*');
      });
      sendResponse({ ok: true });
    }
    else if (msg.action === 'start-component-picker') {
      injectPicker();
      sendResponse({ ok: true });
    }

    return true;
  });

  // ─── Results Listener ──────────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    // Anti-pattern results from detector
    if (e.data.source === 'uichecker-results') {
      chrome.runtime.sendMessage({
        action: 'findings',
        findings: e.data.findings,
        count: e.data.count,
      }).catch(() => {});
    }

    // Overlay toggle feedback
    if (e.data.source === 'uichecker-overlays-toggled') {
      chrome.runtime.sendMessage({
        action: 'overlays-toggled',
        visible: e.data.visible,
      }).catch(() => {});
    }

    // Detector ready signal
    if (e.data.source === 'uichecker-ready') {
      detectorInjected = true;
      if (pendingScan) {
        pendingScan = false;
        sendScanCommand();
      }
    }

    // Clone engine results — forward HTML to service worker for download
    if (e.data.source === 'uichecker-clone-result') {
      if (e.data.success && e.data.html) {
        // Use chrome.downloads API via service worker — NO page redirect
        chrome.runtime.sendMessage({
          action: 'clone-download',
          html: e.data.html,
          filename: e.data.filename,
        }).catch(() => {});
      } else {
        // Error or progress message
        chrome.runtime.sendMessage({
          action: 'clone-result',
          success: e.data.success,
          message: e.data.message,
        }).catch(() => {});
      }
    }

    // Component picker result
    if (e.data.source === 'uichecker-component-result') {
      chrome.runtime.sendMessage({
        action: 'clone-result',
        html: e.data.html,
        selector: e.data.selector,
        success: e.data.success,
        message: e.data.message,
        copiedToClipboard: e.data.copiedToClipboard,
      }).catch(() => {});
    }
  });

  // ─── Page Active Signal ────────────────────────────────────────────────

  let lastPageActive = 0;
  document.addEventListener('pointermove', () => {
    const now = Date.now();
    if (now - lastPageActive < 150) return;
    lastPageActive = now;
    chrome.runtime.sendMessage({ action: 'page-pointer-active' }).catch(() => {});
  }, { passive: true, capture: true });

  // ─── SPA Navigation Detection ──────────────────────────────────────────

  let lastUrl = location.href;
  function onPossibleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (detectorInjected) {
      setTimeout(sendScanCommand, 500);
    }
  }
  window.addEventListener('popstate', onPossibleNavigation);
  window.addEventListener('hashchange', onPossibleNavigation);

  // ─── Detector Injection ────────────────────────────────────────────────

  function sendScanCommand() {
    const msg = { source: 'uichecker-command', action: 'scan' };
    if (scanConfig) msg.config = scanConfig;
    window.postMessage(msg, '*');
  }

  function injectDetectorAndScan() {
    if (detectorInjected) {
      sendScanCommand();
      return;
    }

    document.documentElement.dataset.uicheckerExtension = 'true';

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('detector/detect.js');
    script.dataset.uicheckerExtension = 'true';
    pendingScan = true;
    script.onload = () => script.remove();
    script.onerror = () => {
      script.remove();
      chrome.runtime.sendMessage({ action: 'inject-fallback' });
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // ─── Clone Engine Injection ────────────────────────────────────────────

  function injectCloneEngine(callback) {
    if (cloneEngineInjected) {
      if (callback) callback();
      return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/clone-engine.js');
    script.onload = () => {
      cloneEngineInjected = true;
      script.remove();
      if (callback) callback();
    };
    script.onerror = () => {
      script.remove();
      console.warn('[uichecker] Clone engine injection failed');
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // ─── Component Picker Injection ────────────────────────────────────────

  function injectPicker() {
    if (pickerInjected) {
      // Re-activate picker
      window.postMessage({ source: 'uichecker-command', action: 'start-component-picker' }, '*');
      return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/component-picker.js');
    script.onload = () => {
      pickerInjected = true;
      script.remove();
    };
    script.onerror = () => {
      script.remove();
      console.warn('[uichecker] Component picker injection failed');
    };
    (document.head || document.documentElement).appendChild(script);
  }
})();
