/**
 * UI Checker v3 — Clone Full Page Engine
 *
 * Captures the entire computed DOM, aggressively inlines CSS,
 * base64-encodes external assets (images, fonts), and sends
 * the result to the service worker for download via chrome.downloads.
 *
 * IMPORTANT: This engine does NOT create clickable <a> elements or
 * navigate to any URL. The cloned HTML is delivered as a downloadable
 * file through the chrome.downloads API, ensuring zero redirects.
 *
 * Runs in page context (MAIN world) for full DOM/CSSOM access.
 */
(function () {
  if (window.__UI_CHECKER_CLONE_LOADED__) return;
  window.__UI_CHECKER_CLONE_LOADED__ = true;

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

  const BRAND_SUCCESS = () => getThemeColor('--uicheck-success', '#43A047');
  const BRAND_ERROR = () => getThemeColor('--uicheck-error', '#E53935');

  // ─── Toast Notification ──────────────────────────────────────────────────

  function showToast(message, isSuccess) {
    let existing = document.getElementById('uichecker-clone-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'uichecker-clone-toast';
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

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ─── CSS Inlining ────────────────────────────────────────────────────────

  function inlineAllStyles() {
    const styleSheets = [];
    for (const sheet of document.styleSheets) {
      try {
        const rules = [];
        for (const rule of sheet.cssRules) {
          rules.push(rule.cssText);
        }
        styleSheets.push(rules.join('\n'));
      } catch (e) {
        // Cross-origin stylesheet — skip
      }
    }
    return styleSheets;
  }

  function cloneDOMWithInlineStyles() {
    const clone = document.documentElement.cloneNode(true);

    // Remove all existing <link rel="stylesheet"> and <style> tags from clone
    clone.querySelectorAll('link[rel="stylesheet"], style').forEach(el => el.remove());

    // Add a single <style> block with all collected CSS rules
    const allCSS = inlineAllStyles();
    const styleEl = document.createElement('style');
    styleEl.textContent = allCSS.join('\n');
    clone.querySelector('head')?.appendChild(styleEl) || clone.insertBefore(styleEl, clone.firstChild);

    // Remove scripts (they won't work in a static clone)
    clone.querySelectorAll('script').forEach(el => el.remove());

    // Remove extension-injected elements
    clone.querySelectorAll('[data-uichecker-extension]').forEach(el => el.remove());
    clone.querySelectorAll('.uichecker-overlay, .uichecker-label, .uichecker-banner, .uichecker-tooltip, #uichecker-picker-highlight, #uichecker-picker-toast, #uichecker-clone-toast').forEach(el => el.remove());

    return clone;
  }

  // ─── Base64 Encoding ──────────────────────────────────────────────────────

  async function imageToBase64(url) {
    if (!url || url.startsWith('data:')) return url;

    try {
      const response = await fetch(url, { mode: 'cors' });
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(url);
        reader.readAsDataURL(blob);
      });
    } catch {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          } catch {
            resolve(url);
          }
        };
        img.onerror = () => resolve(url);
        img.src = url;
      });
    }
  }

  async function encodeImages(clone) {
    const images = clone.querySelectorAll('img[src]');
    const promises = [];

    for (const img of images) {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) continue;

      const absoluteUrl = new URL(src, location.href).href;
      promises.push(
        imageToBase64(absoluteUrl).then(base64 => {
          img.setAttribute('src', base64);
        })
      );
    }

    const bgElements = clone.querySelectorAll('[style*="background"]');
    for (const el of bgElements) {
      const style = el.getAttribute('style') || '';
      const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/g);
      if (urlMatch) {
        for (const match of urlMatch) {
          const url = match.replace(/url\(['"]?/, '').replace(/['"]?\)/, '');
          if (url.startsWith('data:')) continue;
          const absoluteUrl = new URL(url, location.href).href;
          promises.push(
            imageToBase64(absoluteUrl).then(base64 => {
              el.setAttribute('style',
                el.getAttribute('style').replace(match, `url('${base64}')`)
              );
            })
          );
        }
      }
    }

    await Promise.allSettled(promises);
  }

  // ─── Full Page Clone ─────────────────────────────────────────────────────

  async function cloneFullPage() {
    showToast('Cloning page...', true);

    try {
      const clone = cloneDOMWithInlineStyles();
      await encodeImages(clone);

      const head = clone.querySelector('head') || document.createElement('head');
      if (!clone.querySelector('meta[charset]')) {
        const meta = document.createElement('meta');
        meta.setAttribute('charset', 'utf-8');
        head.insertBefore(meta, head.firstChild);
      }

      if (!clone.querySelector('base')) {
        const base = document.createElement('base');
        base.setAttribute('href', location.origin + location.pathname);
        head.insertBefore(base, head.firstChild);
      }

      const html = '<!DOCTYPE html>\n' + clone.outerHTML;
      const filename = (document.title || 'page').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-clone.html';

      // Send to service worker for download via chrome.downloads API
      // This ensures NO redirect to any website
      window.postMessage({
        source: 'uichecker-clone-result',
        html: html,
        filename: filename,
        success: true,
        message: 'Page cloned successfully!',
      }, '*');

    } catch (err) {
      window.postMessage({
        source: 'uichecker-clone-result',
        success: false,
        message: `Clone failed: ${err.message}`,
      }, '*');
    }
  }

  // ─── Command Listener ────────────────────────────────────────────────────
  // SECURITY (Pattern 7): Validate message origin and shape before processing.

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (e.data.source !== 'uichecker-command') return;
    if (e.data.action === 'clone-page') {
      cloneFullPage();
    }
  });
})();
