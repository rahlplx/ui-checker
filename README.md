# UI Checker

Detect UI anti-patterns, clone pages, and extract components — all in one Chrome extension.

## Features

- **Anti-Pattern Scanner** — 25 deterministic checks across two categories:
  - **AI tells** (slop): side-tab borders, overused fonts, gradient text, AI color palettes, nested cards, dark glow, bounce easing, and more
  - **Quality issues**: low contrast, cramped padding, tight line height, tiny text, skipped headings, and more
- **Clone Full Page** — Captures the computed DOM, inlines all CSS, base64-encodes images, and downloads as a single HTML file (no external redirects)
- **Copy Component** — Hover-highlight any element, click to extract its HTML + computed CSS, copied to clipboard
- **DevTools Panel** — Full findings panel with category grouping, hover-to-highlight, per-finding copy, and rule toggles
- **Elements Sidebar** — Shows findings for the currently selected `$0` element

## Architecture

```
uichecker-v3/
├── manifest.json              # Manifest V3 entry point
├── theme.css                  # CSS Custom Properties design system
├── background/
│   └── service-worker.js      # Message hub, badge, dedup, perform-download
├── content/
│   ├── content-script.js      # Bridge: extension ↔ page context
│   ├── clone-engine.js        # Full-page clone (MAIN world)
│   └── component-picker.js    # Hover + click component extractor (MAIN world)
├── detector/
│   ├── detect.js              # 3-phase anti-pattern engine (HTML Regex → CSSOM → DOM)
│   └── antipatterns.json      # Rule ID → name/description map (25 rules)
├── devtools/
│   ├── devtools.html          # DevTools entry point
│   ├── devtools.js            # Creates panel + sidebar
│   ├── panel.html / panel.js / panel.css    # Findings panel
│   └── sidebar.html / sidebar.js / sidebar.css  # Elements sidebar
├── popup/
│   ├── popup.html / popup.js / popup.css    # Toolbar popup (horizontal bar)
└── icons/
    ├── icon.svg               # Source vector
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

## Detection Pipeline

Three-phase detection runs in the page's MAIN world for full DOM/CSSOM access:

1. **HTML Regex** — Pattern-matches against raw HTML source (pure black backgrounds, purple hex codes, bounce animations, etc.)
2. **CSSOM** — Reads `document.styleSheets` for computed rule analysis
3. **DOM Walk** — Flat `querySelectorAll('*')` loop checking `getComputedStyle()` on every visible element

### Detection Source-of-Truth (v3)

In browser context, the detector runs ONLY DOM/CSSOM checks (Tier 1). HTML regex checks (`checkHtmlPatterns`) are disabled via `if (!IS_BROWSER)` guard, preventing double-counting. The service worker's `deduplicateFindings()` remains as defense-in-depth.

## Clone Engine

The clone engine runs in the page's MAIN world and:

1. Clones `document.documentElement`
2. Removes all `<link rel="stylesheet">` and `<style>` tags from the clone
3. Collects all CSS rules from `document.styleSheets` and injects a single `<style>` block
4. Base64-encodes all `<img>` sources and `background-image: url()` references
5. Removes all `<script>` tags and extension-injected elements
6. Sends the HTML string to the service worker via `window.postMessage`
7. The service worker calls `chrome.downloads.download()` with a data URL — **zero redirects**

## Install (Developer Mode)

1. Clone this repo
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `uichecker-v3/` directory

## Usage

- Click the **UI Checker** toolbar icon to open the popup
- Click **Scan** to detect anti-patterns on the current page
- Click **Clone page** to download a self-contained HTML copy
- Click **Copy component**, then hover and click any element to copy its HTML + styles
- Open **DevTools → UI Checker** panel for detailed findings with hover-to-highlight
- Open **DevTools → Elements → UI Checker** sidebar for element-specific findings

## Brand Palette

All colors use CSS Custom Properties defined in `theme.css`:

| Variable | Value | Usage |
|---|---|---|
| `--uicheck-primary` | `#607D8B` | Brand blue-grey |
| `--uicheck-slop` | `#E53935` | AI tells (red) |
| `--uicheck-quality` | `#FB8C00` | Quality issues (amber) |
| `--uicheck-clone` | `#1E88E5` | Clone features (blue) |
| `--uicheck-error` | `#E53935` | Error states |
| `--uicheck-success` | `#43A047` | Success states |

## Architectural Patterns

Eight patterns govern the extension's architecture. Violating any of these introduces the bugs they were designed to prevent:

| Pattern | Rule | Key File |
|---|---|---|
| **Idempotency Shield** | Every MAIN-world script must return early if `window.__UI_CHECKER_*_LOADED__` is set | `detect.js`, `clone-engine.js`, `component-picker.js`, `content-script.js` |
| **Source-of-Truth** | In browser context, only DOM/CSSOM checks run; regex is `!IS_BROWSER`-gated | `detect.js` |
| **Permission Proxy** | MAIN-world scripts never call privileged APIs directly; they postMessage → content script → service worker | `clone-engine.js` → `content-script.js` → `service-worker.js` |
| **Shared Token** | All brand colors come from `theme.css :root` via `getComputedStyle()` / `var(--uicheck-*)` | `theme.css`, `detect.js`, `clone-engine.js`, `component-picker.js` |
| **Lifecycle Guard** | `tabState.delete()` only in `chrome.tabs.onRemoved`; DevTools disconnect only cleans pipes; SPA nav is soft reset (findings cleared, injected flags preserved) | `service-worker.js` |
| **Brand Purge** | Zero legacy project names in source; `brand-cleanse.js` contains migration mappings only | All files |
| **Input Validation** | `inspectedWindow.eval()` uses `JSON.stringify()` for data injection (never template literals); all `message` listeners validate `e.source === window`, `typeof e.data === 'object'`, and `e.data.source.startsWith('uichecker-')`; all `postMessage` calls use `location.origin` (never `'*'`) | `panel.js`, `sidebar.js`, `content-script.js`, `detect.js`, `clone-engine.js`, `component-picker.js` |
| **SPA Navigation** | `history.pushState`/`replaceState` are monkey-patched to call `onPossibleNavigation()`, which triggers soft-reset (picker deactivation + findings clear + re-scan). No MutationObserver or URL polling needed. | `content-script.js`, `component-picker.js`, `service-worker.js` |

## License

Apache-2.0
