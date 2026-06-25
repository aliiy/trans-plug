# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome/Edge browser extension (Manifest V3, TypeScript) for immersive bilingual translation. Detects English/Japanese/Russian (and other foreign-language) text in block-level elements on any page, translates to Simplified Chinese via the DeepSeek API, and inserts styled translation blocks below originals. Also supports hover translation, selection translation, keyboard shortcuts, and per-domain rules.

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

1. **Lazy, viewport-prioritized translation**: IntersectionObserver (rootMargin: 800px) monitors block elements; elements enter the queue only when near the viewport. Each flush translates the elements nearest the viewport first (visible, then about-to-enter below), so scrolling redirects translation to the current position instead of grinding through the backlog above. Scroll-stop fallback (100ms debounce) rescans the visible area for missed elements.
2. **Batching & dedup**: `Set<Element>` queue, 50ms debounce, viewport-prioritized 15-element batches, up to 3 concurrent API calls. Elements are marked in-flight (`data-imm-pending`) the moment they enter a batch so concurrent detection paths don't re-queue them — this prevents duplicate translation blocks while scrolling. MutationObserver collects added nodes into a pending set, batch-scans after debounce.
3. **Rendering**: a `<span class="imm-trans-block">` is inserted below the original — as a sibling (`insertAdjacentElement('afterend', …)`) by default, or nested inside the original when its parent is a flex/grid container (so the translation doesn't become a stray flex/grid item and break the layout). Original DOM otherwise unmodified. Cache writes are batched and fire-and-forget so they never block rendering.
4. **SPA support**: MutationObserver detects added nodes, debounced (50ms) then batch-scans. Viewport-aware: elements already in viewport go directly to translation queue; others registered with IntersectionObserver.
5. **Toggle off**: Disconnects observers, removes all `.imm-trans-block` elements, clears queue. Removes scroll listener.
6. **Caching**: Source text hash (djb2) → `chrome.storage.local` prefixed `tx_`. 7-day TTL, max 5000 entries with LRU eviction (oldest 20% deleted when full). Batch cache lookup before API calls.
7. **Hover translation**: Alt+mouseover → throttled 150ms → cache → API → tooltip at cursor position.
8. **Selection translation**: Mouseup on selection → popup near selection rect → cache → API → rendered with copy/close.
9. **Domain rules**: Checked on content script init. "never" skips entirely. "always" overrides global enabled state.
10. **Smart filtering**: Semantic chrome detection (nav, footer, sidebar, etc. via boundary-aware regex), fixed/sticky nav skip, non-translatable text patterns (numbers, dates, @mentions, UI labels), horizontal nav item detection.
11. **API reliability**: 3-retry exponential backoff (1s→2s→4s) on 429/5xx errors. Circuit breaker: 5 consecutive failures → 30s cooldown (returns originals). Non-retryable 4xx errors fail immediately.

### Element filtering

- **Translate**: `P`, `LI`, `H1`–`H6`, `BLOCKQUOTE`, `FIGCAPTION`, `DD`, `DT` — always translated
- **Translate (leaf only)**: `DIV`, `ARTICLE`, `SECTION`, `TD`, `TH`, `SUMMARY`, `LABEL`, `LEGEND`, `OPTION` — only when no block children inside
- **Skip**: `VIDEO`, `AUDIO`, `CANVAS`, `SVG`, `CODE`, `PRE`, `SCRIPT`, `STYLE`, `IFRAME`, `TEXTAREA`, `INPUT`, `SELECT`, `BUTTON`, `role="button"`, `contenteditable="true"`, elements with `data-imm-skip`
- **Semantic skip**: Elements inside `<nav>`, `<footer>`, `<aside>`, or ancestors with UI chrome classes (nav, sidebar, breadcrumb, toolbar, etc. — boundary-aware regex). Stops at `<main>`, `<article>`, `[role="main"]` content containers.
- **Pattern skip**: Pure numbers/dates/amounts, @mentions, #hashtags, single-word UI labels (Login, Submit, Share...), pure emoji, all-uppercase acronyms ≤5 chars
- **Horizontal nav skip**: Elements whose parent is `display:flex; flex-direction:row` with ≥3 children and element width < 200px
- **Inline text aggregation**: Direct text nodes extracted from block elements; text in nested inline children (`A`, `SPAN`, `STRONG`, etc.) included; text in nested block children excluded (they get their own translation)

### API contract

- Endpoint: `https://api.deepseek.com/v1/chat/completions`
- Model: `deepseek-v4-flash`
- System prompt: auto-detects source language (English/Japanese/Russian/Korean/any), translates to Simplified Chinese, passes through numbers/URLs/code/Chinese unchanged
- Request: JSON array of strings → Response: JSON array of translations (same order)
- `stream: false`, `temperature: 0.3`, `max_tokens: 4096`
- Retry: 3 attempts with exponential backoff (1s→2s→4s) on 429/5xx
- Circuit breaker: 5 consecutive failures → 30s cooldown. Returns originals during cooldown.
- Cache: djb2 hash → `chrome.storage.local` with `{t, ts}` format. 7-day TTL, max 5000 entries, LRU eviction.

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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
