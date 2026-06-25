/**
 * Main content script — orchestrates lazy block translation, hover translation,
 * and selection translation. Communicates with popup and background via messages.
 */

import { injectStyles } from './styles';
import { getSettings, getSetting } from '../utils/storage';
import { hashContent, getCachedBatch, setCachedBatch } from '../utils/cache';
import {
  getTranslatableElements,
  shouldTranslate,
  getDirectText,
  createTranslationBlock,
  removeAllTranslations,
  TRANS_BLOCK_CLASS,
  TRANS_MARKER_CLASS,
  HASH_ATTR,
  PENDING_ATTR,
} from '../utils/domUtils';
import { translateBatch } from '../utils/translator';
import { getDomainAction } from '../utils/domainRules';
import {
  initHoverTranslator,
  destroyHoverTranslator,
  setHoverEnabled,
  updateApiKey as updateHoverKey,
} from './hover-translator';
import {
  initSelectionTranslator,
  destroySelectionTranslator,
  updateApiKey as updateSelectionKey,
} from './selection-translator';

// --- Constants ---
const BATCH_SIZE = 15;  // smaller batches → faster turnover, so a scroll redirects translation sooner
const DEBOUNCE_MS = 50;
const ROOT_MARGIN = '800px 0px';
const MAX_PARALLEL = 3; // max concurrent API calls

// --- State ---
let enabled = false;
let apiKey = '';
let hoverEnabled = true;
let observer: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let isInserting = false; // guard — prevent MO from firing on our own DOM insertions
const queue = new Set<Element>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeJobs = 0; // concurrent API call counter (was boolean isTranslating)
let domainAction: 'always' | 'never' | 'default' = 'default';

// --- Initialization ---

async function init(): Promise<void> {
  console.debug('[沉浸式翻译] 插件初始化开始...');
  injectStyles();

  // Check domain rules first
  domainAction = await getDomainAction(location.hostname);

  // Always respect 'never' rules, regardless of global enabled
  if (domainAction === 'never') {
    console.log(`[沉浸式翻译] 已对 ${location.hostname} 禁用翻译 (域名黑名单)`);
    return;
  }

  const settings = await getSettings();
  apiKey = settings.apiKey;
  hoverEnabled = settings.hoverEnabled;
  console.debug(`[沉浸式翻译] 设置加载: enabled=${settings.enabled}, hasApiKey=${!!apiKey}, domainAction=${domainAction}`);

  // Determine effective enabled state
  if (domainAction === 'always') {
    enabled = true;
  } else {
    enabled = settings.enabled;
  }

  // Always listen for messages (toggle, hover, settings) regardless of enabled state
  chrome.runtime.onMessage.addListener(handleMessage);

  if (!enabled) {
    console.debug('[沉浸式翻译] 翻译未启用，等待用户通过弹窗开启');
    return;
  }

  if (!apiKey) {
    console.warn('[沉浸式翻译] API Key 未设置，请在插件弹窗中配置 DeepSeek API Key');
    return;
  }

  start();
}

function start(): void {
  setupIntersectionObserver();
  setupMutationObserver();
  setupScrollFallback();
  initHoverTranslator(apiKey);
  initSelectionTranslator(apiKey);
  scanAndObserve();
}

function stop(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  // Remove scroll fallback listener
  const cleanup = (setupScrollFallback as unknown as Record<string, unknown>)._cleanup as (() => void) | undefined;
  if (cleanup) cleanup();
  destroyHoverTranslator();
  destroySelectionTranslator();
  clearQueue();
}

// --- IntersectionObserver ---

function setupIntersectionObserver(): void {
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target;
          // Only add if still valid (not yet translated, still in DOM)
          if (el.isConnected && shouldTranslate(el)) {
            addToQueue(el);
          } else {
            console.debug(`[沉浸式翻译] IO 跳过: ${el.tagName}${el.className ? '.' + el.className.split(' ')[0] : ''} "${getDirectText(el).slice(0, 50)}"`);
          }
          // Stop observing this element once queued
          observer?.unobserve(el);
        }
      }
    },
    {
      rootMargin: ROOT_MARGIN,
      threshold: 0,
    }
  );
}

// --- Viewport helper ---

/** Check if an element is in or near the viewport (matches IntersectionObserver rootMargin). */
function isElementNearViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const margin = 800; // matches ROOT_MARGIN
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
}

/**
 * Translation priority for an element — lower = more urgent. Three bands so the
 * batch always favors what the user is currently looking at:
 *   1. Visible (intersecting viewport) — most urgent, ordered top-to-bottom.
 *   2. Below the viewport — about to enter when scrolling down; nearest-below first.
 *   3. Above the viewport — already scrolled past; least urgent, nearest-above first.
 * Re-evaluated on every flush, so scrolling immediately redirects translation.
 */
function viewportPriority(el: Element): number {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const intersecting = rect.top < vh && rect.bottom > 0;
  if (intersecting) return -1_000_000 + rect.top; // visible
  if (rect.top >= vh) return rect.top - vh;        // below
  return 1_000_000 + (-rect.bottom);               // above
}

/**
 * Pick the `size` highest-priority (nearest-viewport) elements from candidates.
 * Layout is only measured when there are more candidates than fit in one batch
 * (i.e. under contention) — otherwise the whole set goes through untouched.
 */
function selectPriorityBatch(candidates: Element[], size: number): Element[] {
  if (candidates.length <= size) return candidates;
  const scored = candidates.map((el) => ({ el, p: viewportPriority(el) }));
  scored.sort((a, b) => a.p - b.p);
  const batch: Element[] = [];
  for (let i = 0; i < size; i++) batch.push(scored[i].el);
  return batch;
}

// --- Scroll fallback (safety net for IntersectionObserver misses) ---

function setupScrollFallback(): void {
  const onScroll = (): void => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      // Scan for visible-but-untranslated elements that the IntersectionObserver
      // may have missed (common on SPAs, lazy-loaded content, virtual scrollers).
      const allElements = getTranslatableElements(document.body);
      let queued = 0;
      for (const el of allElements) {
        if (queued >= BATCH_SIZE) break;
        if (!el.hasAttribute(HASH_ATTR) && isElementNearViewport(el)) {
          addToQueue(el);
          observer?.unobserve(el);
          queued++;
        }
      }
    }, 100); // debounce scroll events — faster scan for fast scrollers
  };

  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  // Store cleanup reference via a closure variable
  (setupScrollFallback as unknown as Record<string, unknown>)._cleanup = () => {
    document.removeEventListener('scroll', onScroll, { capture: true });
    if (scrollTimer) clearTimeout(scrollTimer);
  };
}

// --- MutationObserver (SPA support) ---

function setupMutationObserver(): void {
  const pendingRoots = new Set<Element>();
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  function processPendingRoots(): void {
    scanTimer = null;
    if (pendingRoots.size === 0) return;

    const roots = Array.from(pendingRoots);
    pendingRoots.clear();

    const seen = new Set<Element>();

    for (const root of roots) {
      if (!root.isConnected) continue;

      // Scan the added subtree for translatable elements
      const newElements = getTranslatableElements(root);
      for (const newEl of newElements) {
        if (seen.has(newEl)) continue;
        seen.add(newEl);
        if (isElementNearViewport(newEl)) {
          addToQueue(newEl);
        } else {
          observeElement(newEl);
        }
      }

      // Also check the added node itself
      if (shouldTranslate(root) && !seen.has(root)) {
        seen.add(root);
        if (isElementNearViewport(root)) {
          addToQueue(root);
        } else {
          observeElement(root);
        }
      }
    }
  }

  mutationObserver = new MutationObserver((mutations) => {
    // Skip if we're in the middle of inserting translation blocks ourselves
    if (isInserting) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        // Skip our own elements
        if (el.classList.contains(TRANS_BLOCK_CLASS)) continue;
        pendingRoots.add(el);
      }
    }

    if (pendingRoots.size > 0 && !scanTimer) {
      scanTimer = setTimeout(processPendingRoots, DEBOUNCE_MS);
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// --- Element scanning & observation ---

function scanAndObserve(): void {
  const elements = getTranslatableElements(document.body);
  console.debug(`[沉浸式翻译] 扫描完成: 找到 ${elements.length} 个可翻译元素`);
  for (const el of elements) {
    observeElement(el);
  }
}

function observeElement(el: Element): void {
  observer?.observe(el);
}

// --- Translation queue ---

function addToQueue(el: Element): void {
  queue.add(el);
  // If jobs are already running, don't debounce — dispatch next batch immediately
  if (activeJobs > 0 && activeJobs < MAX_PARALLEL) {
    flushQueue();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  // First batch gets shorter debounce; subsequent batches are already fast
  const delay = activeJobs === 0 ? DEBOUNCE_MS : 0;
  debounceTimer = setTimeout(flushQueue, delay);
}

function clearQueue(): void {
  queue.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }
  activeJobs = 0;
}

function flushQueue(): void {
  if (activeJobs >= MAX_PARALLEL || queue.size === 0) return;
  if (!apiKey) return;

  // Collect all still-valid candidates, dropping dead/invalid ones from the queue.
  const candidates: Element[] = [];
  for (const el of queue) {
    if (!el.isConnected || !shouldTranslate(el)) {
      queue.delete(el);
      continue;
    }
    candidates.push(el);
  }

  if (candidates.length === 0) return;

  // Prioritize what the user is actually looking at: pick the BATCH_SIZE elements
  // nearest the viewport (visible first, then about-to-enter below). Re-evaluated
  // every flush, so after scrolling the next batch targets the new position
  // instead of grinding through the backlog above it.
  const batch = selectPriorityBatch(candidates, BATCH_SIZE);

  // Remove batch items from queue and mark them in-flight, so concurrent
  // detection paths (scroll fallback / IntersectionObserver / MutationObserver)
  // don't re-queue and re-translate the same element while its API call is
  // pending — that was the cause of duplicate translation blocks while scrolling.
  for (const el of batch) {
    queue.delete(el);
    el.setAttribute(PENDING_ATTR, '1');
  }

  // Fire and forget — don't await, let batches run in parallel
  activeJobs++;
  translateAndRender(batch)
    .catch(err => console.error('[沉浸式翻译] 批量翻译失败:', err))
    .finally(() => {
      // Clear any leftover in-flight markers. Rendered elements already cleared
      // theirs (HASH_ATTR guards them now); this lets any that errored out retry.
      for (const el of batch) el.removeAttribute(PENDING_ATTR);
      activeJobs--;
      // If more items accumulated, keep the pipeline going
      if (queue.size > 0) {
        flushQueue();
      }
    });
}

async function translateAndRender(elements: Element[]): Promise<void> {
  // Build array of texts and hashes
  const items = elements.map((el) => {
    const text = getDirectText(el);
    const hash = hashContent(text);
    return { el, text, hash };
  });

  const hashes = items.map((i) => i.hash);

  // Check cache
  const cachedMap = await getCachedBatch(hashes);

  // Separate hits and misses
  const hits: Array<{ el: Element; text: string; translation: string }> = [];
  const misses: Array<{ el: Element; text: string; hash: string }> = [];

  for (const item of items) {
    const cached = cachedMap.get(item.hash);
    if (cached) {
      hits.push({ el: item.el, text: item.text, translation: cached });
    } else {
      misses.push(item);
    }
  }

  // Render cache hits immediately
  for (const hit of hits) {
    // Skip elements removed from DOM while waiting
    if (!hit.el.isConnected) continue;
    renderTranslation(hit.el, hit.text, hit.translation, hit.hash);
  }

  // Translate cache misses via API
  if (misses.length > 0) {
    // Filter out elements already removed from DOM (saves API quota)
    const liveMisses = misses.filter(m => m.el.isConnected);
    if (liveMisses.length === 0) return;

    const texts = liveMisses.map((m) => m.text);
    const translations = await translateBatch(texts, apiKey);

    // Render immediately, then persist every entry in a single storage write.
    // Caching must not block the render path, so the batch write is fire-and-forget.
    const toCache: Array<{ hash: string; translation: string }> = [];
    for (let i = 0; i < liveMisses.length; i++) {
      const { el, text, hash } = liveMisses[i];
      // Double-check still connected after API call
      if (!el.isConnected) continue;
      const translation = translations[i] ?? text;
      renderTranslation(el, text, translation, hash);
      toCache.push({ hash, translation });
    }
    void setCachedBatch(toCache);
  }
}

function renderTranslation(
  el: Element,
  originalText: string,
  translatedText: string,
  hash: string
): void {
  // Skip if element was removed from DOM while we were waiting for API
  if (!el.isConnected) return;

  // Translation has arrived — clear the in-flight marker (HASH_ATTR takes over).
  el.removeAttribute(PENDING_ATTR);

  // Skip if translation is same as original (already Chinese, numbers, etc.)
  if (translatedText === originalText) {
    el.setAttribute(HASH_ATTR, hash);
    return;
  }

  // Mark the original element as translated
  el.classList.add(TRANS_MARKER_CLASS);
  el.setAttribute(HASH_ATTR, hash);

  // Guard MutationObserver from firing on our own insertion
  isInserting = true;

  // Insert the translation block. Default is sibling insertion after the
  // original (preserves the original's internal DOM for React/Vue and avoids
  // breaking :nth-child selectors); flex/grid parents are handled specially to
  // avoid layout breakage. See insertTranslationBlock() for the full rationale.
  const block = createTranslationBlock(translatedText);
  insertTranslationBlock(el, block);

  // Release the guard after the browser has processed the insertion
  requestAnimationFrame(() => { isInserting = false; });
}

/**
 * Insert the translation block without disrupting the host layout.
 *
 * Default: sibling insertion after the original element (`afterend`) — keeps the
 * original element's internal DOM intact so SPA frameworks (React/Vue) don't
 * reconcile the translation away, and avoids breaking :nth-child selectors.
 *
 * Exception: when the original element's PARENT is a flex or grid container, a
 * sibling would become a brand-new flex/grid item and land in its own column or
 * cell — a very common cause of broken layouts. In that case we nest the
 * translation INSIDE the original element instead, so the existing item simply
 * grows taller. (Trade-off: a framework re-render may drop the nested node, but
 * it is then re-translated straight from cache.)
 */
function insertTranslationBlock(el: Element, block: HTMLElement): void {
  const parent = el.parentElement;
  const parentDisplay = parent ? getComputedStyle(parent).display : '';
  const parentIsFlexOrGrid =
    parentDisplay.includes('flex') || parentDisplay.includes('grid');

  if (parentIsFlexOrGrid) {
    // Force the nested translation onto its own full-width line (also covers the
    // rarer case where the element itself is a flex/grid container).
    block.style.width = '100%';
    el.appendChild(block);
  } else {
    el.insertAdjacentElement('afterend', block);
  }
}

// --- Message handling ---

interface ToggleMessage {
  action: 'toggle-translation' | 'toggle-hover' | 'translate-selection';
}

interface SettingsUpdatedMessage {
  action: 'settings-updated';
}

type Message = ToggleMessage | SettingsUpdatedMessage;

async function handleMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  switch (message.action) {
    case 'toggle-translation':
      await handleToggleTranslation();
      sendResponse({ success: true, enabled });
      break;

    case 'toggle-hover':
      hoverEnabled = !hoverEnabled;
      setHoverEnabled(hoverEnabled);
      sendResponse({ success: true, hoverEnabled });
      break;

    case 'translate-selection':
      // Trigger selection translation — the selection-translator
      // listens for mouseup, but here we trigger it programmatically
      handleTranslateSelection();
      sendResponse({ success: true });
      break;

    case 'settings-updated':
      await handleSettingsUpdated();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false, error: 'unknown action' });
  }
}

async function handleToggleTranslation(): Promise<void> {
  if (enabled) {
    // Disable
    enabled = false;
    stop();
    removeAllTranslations();
  } else {
    // Enable
    enabled = true;
    const settings = await getSettings();
    apiKey = settings.apiKey;
    start();
  }
}

async function handleSettingsUpdated(): Promise<void> {
  const settings = await getSettings();
  const newApiKey = settings.apiKey;
  const newEnabled = settings.enabled;
  const newHoverEnabled = settings.hoverEnabled;

  // Handle enable/disable change
  if (newEnabled !== enabled) {
    if (newEnabled) {
      enabled = true;
      apiKey = newApiKey;
      start();
    } else {
      enabled = false;
      stop();
      removeAllTranslations();
    }
    return;
  }

  // Handle API key change
  if (newApiKey !== apiKey) {
    apiKey = newApiKey;
    updateHoverKey(apiKey);
    updateSelectionKey(apiKey);
  }

  // Handle hover toggle change
  if (newHoverEnabled !== hoverEnabled) {
    hoverEnabled = newHoverEnabled;
    setHoverEnabled(hoverEnabled);
  }
}

function handleTranslateSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  // Manually trigger a mouseup-like event for the selection translator
  const event = new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
  });
  // Dispatch on the anchor node's parent if possible
  const anchorNode = selection.anchorNode;
  if (anchorNode) {
    const target =
      anchorNode.nodeType === Node.TEXT_NODE
        ? anchorNode.parentElement
        : (anchorNode as Element);
    target?.dispatchEvent(event);
  }
}

// --- Boot ---
console.debug('[沉浸式翻译] Content script loaded, waiting for DOM...');
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
