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
      window.postMessage({ source: 'uichecker-command', action: 'toggle-overlays' }, location.origin);
      sendResponse({ ok: true });
    }
    else if (msg.action === 'remove') {
      window.postMessage({ source: 'uichecker-command', action: 'remove' }, location.origin);
      detectorInjected = false;
      sendResponse({ ok: true });
    }
    else if (msg.action === 'highlight') {
      window.postMessage({ source: 'uichecker-command', action: 'highlight', selector: msg.selector }, location.origin);
      sendResponse({ ok: true });
    }
    else if (msg.action === 'unhighlight') {
      window.postMessage({ source: 'uichecker-command', action: 'unhighlight' }, location.origin);
      sendResponse({ ok: true });
    }

    // Clone commands
    else if (msg.action === 'clone-page') {
      injectCloneEngine(() => {
        window.postMessage({ source: 'uichecker-command', action: 'clone-page' }, location.origin);
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
  // SECURITY (Pattern 7): Validate message origin and shape before processing.
  // - e.source !== window → reject cross-origin iframes
  // - typeof e.data !== 'object' → reject primitive data
  // - !e.data.source → reject messages without our source prefix
  // - e.data.source must start with 'uichecker-' to be from our scripts

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (!e.data.source || !e.data.source.startsWith('uichecker-')) return;

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
    // IMPORTANT: clone-engine.js runs in MAIN world where chrome.runtime is
    // NOT available. It bridges via window.postMessage. We (content script)
    // then relay to the service worker which has chrome.downloads access.
    // This is Pattern 3 (Permission Proxy) in action.
    if (e.data.source === 'uichecker-clone-result') {
      if (e.data.success && e.data.html) {
        // Relay to service worker for privileged download (NO page redirect)
        chrome.runtime.sendMessage({
          action: 'perform-download',
          data: e.data.html,
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

  // ─── SPA Navigation Detection (PATTERN 5: Lifecycle Guard) ────────────
  //
  // F21: Duplicate scans during SPA transitions are caused by missing
  // pushState/replaceState interception. Most SPA routers (React Router,
  // Vue Router, Next.js) use history.pushState() which fires NO events.
  // We monkey-patch the History API to call the existing nav handler.
  //
  // F22: Memory leaks occur when component picker event listeners persist
  // across navigations. We deactivate the picker before re-scanning.
  //
  // "Human Compression": ~10-line proxy that hooks into the existing
  // onPossibleNavigation() → sendScanCommand() pipeline. No new 100-line
  // navigation listener needed.

  let lastUrl = location.href;
  function onPossibleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // PATTERN 5: Soft reset — deactivate picker to remove its listeners,
    // notify service worker (clear stale findings, keep injected flags),
    // then re-scan after the DOM settles.
    window.postMessage({ source: 'uichecker-command', action: 'deactivate-component-picker' }, location.origin);
    chrome.runtime.sendMessage({ action: 'spa-navigate' }).catch(() => {});
    if (detectorInjected) {
      setTimeout(sendScanCommand, 500);
    }
  }
  window.addEventListener('popstate', onPossibleNavigation);
  window.addEventListener('hashchange', onPossibleNavigation);

  // PATTERN 5 (Lifecycle Guard): History API proxy for SPA detection.
  // pushState/replaceState fire NO browser events. Monkey-patch them to
  // call the existing onPossibleNavigation() which handles the soft-reset
  // and re-scan pipeline. This is the ~10-line solution, not a 100-line
  // MutationObserver or URL polling interval.
  const _pushState = history.pushState;
  const _replaceState = history.replaceState;
  history.pushState = function() { _pushState.apply(this, arguments); onPossibleNavigation(); };
  history.replaceState = function() { _replaceState.apply(this, arguments); onPossibleNavigation(); };

  // ─── Theme Injection (Pattern 4: Shared Token) ─────────────────────────
  // Inject theme.css as a <link> BEFORE any MAIN-world scripts so that
  // CSS Custom Properties (--uicheck-*) are available when scripts call
  // getThemeColor(). This is the single source of truth for all brand colors.
  let themeInjected = false;

  function injectTheme() {
    if (themeInjected) return;
    themeInjected = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('theme.css');
    link.dataset.uicheckerExtension = 'true';
    (document.head || document.documentElement).appendChild(link);
  }

  // ─── Detector Injection ────────────────────────────────────────────────

  function sendScanCommand() {
    const msg = { source: 'uichecker-command', action: 'scan' };
    if (scanConfig) msg.config = scanConfig;
    window.postMessage(msg, location.origin);
  }

  function injectDetectorAndScan() {
    if (detectorInjected) {
      sendScanCommand();
      return;
    }

    document.documentElement.dataset.uicheckerExtension = 'true';

    // Pattern 4: Inject theme.css BEFORE detect.js so CSS variables are available
    injectTheme();

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
    // Pattern 4: Ensure theme.css is loaded for CSS variable access
    injectTheme();
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
      window.postMessage({ source: 'uichecker-command', action: 'start-component-picker' }, location.origin);
      return;
    }
    // Pattern 4: Ensure theme.css is loaded for CSS variable access
    injectTheme();
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
