/**
 * UI Checker v3 — Component Picker Engine
 *
 * Allows users to hover-highlight and click-to-clone any DOM component.
 * On hover, the element gets a branded highlight border (blue dashed).
 * On click, the element's HTML + deeply computed CSS is extracted,
 * copied to clipboard, and a visual success toast is shown.
 *
 * IMPORTANT: The picker never navigates or redirects. It only copies
 * component HTML+CSS to the clipboard.
 *
 * Runs in page context (MAIN world) for full DOM/CSSOM access.
 */
(function () {
  if (window.__UI_CHECKER_PICKER_LOADED__) return;
  window.__UI_CHECKER_PICKER_LOADED__ = true;

  // ─── State ────────────────────────────────────────────────────────────────

  let active = false;
  let hoveredElement = null;
  let highlightOverlay = null;
  let toastElement = null;

  // ── PATTERN 4 (Shared Token): All brand colors from theme.css ──────────────
  // If the brand changes, you only change one line in theme.css.
  // Fallback values match theme.css defaults for the brief window
  // before the <link> stylesheet is fully processed.

  function getThemeColor(varName, fallback) {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return val || fallback;
    } catch { return fallback; }
  }

  const BRAND_CLONE = () => getThemeColor('--uicheck-clone', '#1E88E5');
  const BRAND_CLONE_SUBTLE = () => getThemeColor('--uicheck-clone-subtle', 'rgba(30, 136, 229, 0.08)');
  const BRAND_SUCCESS = () => getThemeColor('--uicheck-success', '#43A047');
  const BRAND_ERROR = () => getThemeColor('--uicheck-error', '#E53935');

  // ─── Highlight Overlay ────────────────────────────────────────────────────

  function createHighlightOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'uichecker-picker-highlight';
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px dashed ${BRAND_CLONE()};
      background: ${BRAND_CLONE_SUBTLE()};
      border-radius: 4px;
      transition: all 0.1s ease;
      display: none;
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function positionHighlight(el) {
    if (!highlightOverlay) highlightOverlay = createHighlightOverlay();
    const rect = el.getBoundingClientRect();
    highlightOverlay.style.top = (rect.top + window.scrollY) + 'px';
    highlightOverlay.style.left = (rect.left + window.scrollX) + 'px';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
    highlightOverlay.style.position = 'absolute';
    highlightOverlay.style.display = 'block';
  }

  function hideHighlight() {
    if (highlightOverlay) highlightOverlay.style.display = 'none';
  }

  // ─── Toast Notification ───────────────────────────────────────────────────

  function showToast(message, isSuccess) {
    if (toastElement) toastElement.remove();

    const toast = document.createElement('div');
    toast.id = 'uichecker-picker-toast';
    const bgColor = isSuccess ? BRAND_SUCCESS() : BRAND_ERROR();
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: ${bgColor};
      color: white;
      padding: 10px 20px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    toastElement = toast;

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // ─── Computed Style Extraction ────────────────────────────────────────────

  function extractComputedStyles(el) {
    const computed = window.getComputedStyle(el);
    const defaultEl = document.createElement(el.tagName);
    document.body.appendChild(defaultEl);
    const defaultStyles = window.getComputedStyle(defaultEl);

    const styles = {};
    const importantProps = [
      'display', 'position', 'width', 'height', 'margin', 'padding',
      'background', 'background-color', 'background-image',
      'color', 'font-family', 'font-size', 'font-weight', 'line-height',
      'text-align', 'text-decoration', 'text-transform',
      'border', 'border-radius', 'box-shadow',
      'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
      'grid-template-columns', 'grid-template-rows',
      'overflow', 'opacity', 'transform', 'transition',
    ];

    for (const prop of importantProps) {
      try {
        const val = computed.getPropertyValue(prop);
        const defaultVal = defaultStyles.getPropertyValue(prop);
        if (val && val !== defaultVal) {
          styles[prop] = val;
        }
      } catch { /* skip unsupported properties */ }
    }

    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      try {
        const val = computed.getPropertyValue(prop);
        const defaultVal = defaultStyles.getPropertyValue(prop);
        if (val && val !== defaultVal && !styles[prop]) {
          if (/color|size|width|height|margin|padding|border|display|position|flex|grid|gap/i.test(prop)) {
            styles[prop] = val;
          }
        }
      } catch { /* skip */ }
    }

    defaultEl.remove();
    return styles;
  }

  function extractComponentHTML(el) {
    const clone = el.cloneNode(true);

    // Remove extension-injected elements from the clone
    clone.querySelectorAll('[data-uichecker-extension]').forEach(e => e.remove());
    clone.querySelectorAll('#uichecker-picker-highlight, #uichecker-picker-toast, #uichecker-clone-toast').forEach(e => e.remove());

    // Inline computed styles on the root element
    const styles = extractComputedStyles(el);
    const styleStr = Object.entries(styles)
      .map(([prop, val]) => `${prop}: ${val}`)
      .join('; ');
    clone.setAttribute('style', styleStr);

    // Inline styles on children too
    const originalChildren = el.querySelectorAll('*');
    const clonedChildren = clone.querySelectorAll('*');
    originalChildren.forEach((origChild, i) => {
      if (i >= clonedChildren.length) return;
      const childStyles = extractComputedStyles(origChild);
      const childStyleStr = Object.entries(childStyles)
        .map(([prop, val]) => `${prop}: ${val}`)
        .join('; ');
      clonedChildren[i].setAttribute('style', childStyleStr);
    });

    return clone.outerHTML;
  }

  function generateSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = `#${CSS.escape(current.id)}`;
        path.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 2)
          .filter(c => !c.startsWith('uichecker-'))
          .join('.');
        if (classes) selector += '.' + classes;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────

  function onPointerMove(e) {
    if (!active) return;

    if (e.target.id === 'uichecker-picker-highlight' ||
        e.target.id === 'uichecker-picker-toast' ||
        e.target.id === 'uichecker-clone-toast' ||
        e.target.closest('#uichecker-picker-highlight, #uichecker-picker-toast, #uichecker-clone-toast')) {
      return;
    }

    if (hoveredElement !== e.target) {
      hoveredElement = e.target;
      positionHighlight(hoveredElement);
    }
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement;
    if (!target) return;

    try {
      const html = extractComponentHTML(target);
      const selector = generateSelector(target);

      // Copy to clipboard (no redirect, no navigation)
      navigator.clipboard.writeText(html).then(() => {
        showToast(`Component copied to clipboard! (${selector})`, true);

        window.postMessage({
          source: 'uichecker-component-result',
          html: html,
          selector: selector,
          success: true,
          message: 'Component copied to clipboard',
          copiedToClipboard: true,
        }, '*');
      }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = html;
        textarea.style.cssText = 'position:fixed;left:-9999px;';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();

        showToast(`Component copied! (${selector})`, true);

        window.postMessage({
          source: 'uichecker-component-result',
          html: html,
          selector: selector,
          success: true,
          message: 'Component copied to clipboard',
          copiedToClipboard: true,
        }, '*');
      });
    } catch (err) {
      showToast(`Extraction failed: ${err.message}`, false);
    }

    deactivatePicker();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && active) {
      deactivatePicker();
    }
  }

  // ─── Activation ───────────────────────────────────────────────────────────

  function activatePicker() {
    if (active) return;
    active = true;
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = 'crosshair';

    showToast('Click any element to clone it. Press Esc to cancel.', true);
  }

  function deactivatePicker() {
    active = false;
    hoveredElement = null;
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = '';
    hideHighlight();
  }

  // ─── Command Listener ────────────────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'uichecker-command') return;
    if (e.data.action === 'start-component-picker') {
      activatePicker();
    }
  });
})();
