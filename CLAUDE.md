# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome/Edge browser extension (Manifest V3, TypeScript) for immersive bilingual translation. Detects English/Japanese text in block-level elements on any page, translates to Simplified Chinese via the DeepSeek API, and inserts styled translation blocks below originals. Also supports hover translation, selection translation, keyboard shortcuts, and per-domain rules.

## Build & Development

```bash
npm install          # Install dependencies (Vite, TypeScript, @types/chrome)
npm run build        # Builds dist/ — load as unpacked extension in chrome://extensions
```

The build uses `build.mjs` (Vite programmatic API) to produce three separate bundles:
1. `content.js` — IIFE bundle (required by MV3 content scripts; ES modules not supported)
2. `background.js` — IIFE bundle (MV3 service worker)
3. `popup/index.html` + `assets/*` — HTML entry with module JS + CSS

After building, load `dist/` as an unpacked extension in Chrome/Edge. Open any web page, click the extension icon, enter your DeepSeek API key, and toggle on translation.

## Architecture

```
src/
  manifest.json              # MV3 manifest: permissions, content_scripts, background, commands
  content/
    index.ts                 # Main orchestrator: IntersectionObserver + MutationObserver + translation queue + message handling
    hover-translator.ts      # Alt+mouseover → floating translation tooltip (150ms throttle)
    selection-translator.ts  # Mouseup text selection → floating translation popup with copy/close buttons
    styles.ts                # All CSS as template literal, injected via <style> element (never innerHTML)
  popup/
    index.html               # Popup UI: API key, toggles, domain rules, cache clear
    index.ts                 # Popup logic: chrome.storage sync + chrome.tabs.sendMessage
    popup.css                # Popup styles
  background/
    index.ts                 # Service worker: chrome.commands handler (Alt+T/H/S) + contextMenus
  utils/
    storage.ts               # Typed chrome.storage.local wrappers (Settings interface)
    cache.ts                 # Content hash (djb2) → chrome.storage.local cache with batch lookup
    domUtils.ts              # Element scanning (TreeWalker), filtering, safe DOM creation (no innerHTML)
    translator.ts            # DeepSeek API client: POST /v1/chat/completions, JSON array response parsing
    domainRules.ts           # Per-domain "always"/"never" rules with wildcard support (*.example.com)
```

### Communication flow

```
Popup ──chrome.tabs.sendMessage──→ Content Script
Background (commands/contextMenu) ──chrome.tabs.sendMessage──→ Content Script
Content Script ←──chrome.storage.local──→ Popup (settings persistence)
Popup ←──chrome.storage.local──→ (read by content script on init)
```

### Key runtime behaviors

1. **Lazy translation via scroll**: IntersectionObserver (rootMargin: 300px) monitors block elements. Elements enter queue only when near viewport.
2. **Batching & dedup**: `Set<Element>` queue, 200ms debounce, 15-element batches per API call.
3. **Rendering**: `element.insertAdjacentElement('afterend', createTranslationBlock())` — sibling `<div class="imm-trans-block">` below original. Original DOM never modified.
4. **SPA support**: MutationObserver detects added nodes, scans for translatable elements, binds them to IntersectionObserver.
5. **Toggle off**: Disconnects observers, removes all `.imm-trans-block` elements, clears queue.
6. **Caching**: Source text hash → `chrome.storage.local` prefixed `tx_`. Batch cache lookup before API calls.
7. **Hover translation**: Alt+mouseover → throttled 150ms → cache → API → tooltip at cursor position.
8. **Selection translation**: Mouseup on selection → popup near selection rect → cache → API → rendered with copy/close.
9. **Domain rules**: Checked on content script init. "never" skips entirely. "always" overrides global enabled state.

### Element filtering

- **Translate**: `P`, `DIV`, `LI`, `ARTICLE`, `SECTION`, `H1`–`H6`, `TD`, `TH`, `BLOCKQUOTE`, `FIGCAPTION`, `DD`, `DT`, `SUMMARY`, `LABEL`, `LEGEND`, `OPTION`
- **Skip**: `VIDEO`, `AUDIO`, `CANVAS`, `SVG`, `CODE`, `PRE`, `SCRIPT`, `STYLE`, `IFRAME`, `TEXTAREA`, `INPUT`, `SELECT`, `BUTTON`, `role="button"`, `contenteditable="true"`, elements with `data-imm-skip`
- **Inline text aggregation**: Direct text nodes extracted from block elements; text in nested inline children (`A`, `SPAN`, `STRONG`, etc.) included; text in nested block children excluded (they get their own translation)

### API contract

- Endpoint: `https://api.deepseek.com/v1/chat/completions`
- Model: `deepseek-chat`
- System prompt: detects source language (English/Japanese), translates to Simplified Chinese, passes through numbers/URLs/code/Chinese unchanged
- Request: JSON array of strings → Response: JSON array of translations (same order)
- `stream: false`, `temperature: 0.3`, `max_tokens: 4096`

### Hard constraints

- **Never use `innerHTML`.** Always `document.createElement` + `textContent` for text insertion.
- Content scripts run as IIFE (not ES modules) — imports are inlined by Vite.
- CSS is injected as a `<style>` element by the content script; never linked as external stylesheet from content scripts.

### Message types (content script listeners)

| Message action | From | Effect |
|---|---|---|
| `toggle-translation` | Background / Popup | Enable/disable entire translation pipeline |
| `toggle-hover` | Background / Popup | Enable/disable hover translation only |
| `translate-selection` | Background (context menu / Alt+S) | Trigger selection translation |
| `settings-updated` | Popup | Re-read all settings from chrome.storage |
