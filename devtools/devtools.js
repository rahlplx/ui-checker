/**
 * UI Checker v3 — DevTools Page
 *
 * Creates the UI Checker panel and sidebar, triggers auto-scan.
 */

chrome.devtools.panels.create(
  'UI Checker',
  'icons/icon-32.png',
  'devtools/panel.html'
);

chrome.devtools.panels.elements.createSidebarPane('UI Checker', (sidebar) => {
  sidebar.setPage('devtools/sidebar.html');
  sidebar.setHeight('200px');
});

const portName = `uichecker-devtools-${chrome.devtools.inspectedWindow.tabId}`;
let lifecyclePort = null;
let firstConnect = true;

function connectLifecycle() {
  lifecyclePort = chrome.runtime.connect({ name: portName });
  if (firstConnect) {
    firstConnect = false;
    chrome.storage.sync.get({ autoScan: 'panel' }, (settings) => {
      if (settings.autoScan === 'devtools') {
        try { lifecyclePort?.postMessage({ action: 'scan' }); } catch {}
      }
    });
  }
  lifecyclePort.onDisconnect.addListener(() => {
    lifecyclePort = null;
    setTimeout(connectLifecycle, 100);
  });
}
connectLifecycle();

setInterval(() => {
  try { lifecyclePort?.postMessage({ action: 'ping' }); } catch {}
}, 20000);
