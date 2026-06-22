/**
 * Main content script — orchestrates lazy block translation, hover translation,
 * and selection translation. Communicates with popup and background via messages.
 */

import { injectStyles } from './styles';
import { getSettings, getSetting } from '../utils/storage';
import { hashContent, getCached, setCached, getCachedBatch, clearCache } from '../utils/cache';
import {
  getTranslatableElements,
  shouldTranslate,
  getDirectText,
  createTranslationBlock,
  removeAllTranslations,
  TRANS_BLOCK_CLASS,
  TRANS_MARKER_CLASS,
  HASH_ATTR,
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
const BATCH_SIZE = 20;
const DEBOUNCE_MS = 80;
const ROOT_MARGIN = '500px 0px';

// --- State ---
let enabled = false;
let apiKey = '';
let hoverEnabled = true;
let observer: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
const queue = new Set<Element>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isTranslating = false;
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
  const margin = 500; // matches ROOT_MARGIN
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
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
    }, 150); // debounce scroll events — only scan after user stops scrolling
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
  scheduleFlush();
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushQueue, DEBOUNCE_MS);
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
  isTranslating = false;
}

async function flushQueue(): Promise<void> {
  if (isTranslating || queue.size === 0) return;
  if (!apiKey) return;

  isTranslating = true;

  // Take a batch from the queue
  const batch: Element[] = [];
  for (const el of queue) {
    if (batch.length >= BATCH_SIZE) break;
    // Double-check element is still valid
    if (!el.isConnected || !shouldTranslate(el)) {
      queue.delete(el);
      continue;
    }
    batch.push(el);
  }

  // Remove batch items from queue
  for (const el of batch) {
    queue.delete(el);
  }

  if (batch.length === 0) {
    isTranslating = false;
    // If queue still has items, schedule another flush
    if (queue.size > 0) scheduleFlush();
    return;
  }

  try {
    await translateAndRender(batch);
  } catch (err) {
    console.error('[沉浸式翻译] 批量翻译失败:', err);
  }

  isTranslating = false;

  // If more items accumulated, flush again
  if (queue.size > 0) {
    scheduleFlush();
  }
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
    renderTranslation(hit.el, hit.text, hit.translation, hit.hash);
  }

  // Translate cache misses via API
  if (misses.length > 0) {
    const texts = misses.map((m) => m.text);
    const translations = await translateBatch(texts, apiKey);

    for (let i = 0; i < misses.length; i++) {
      const { el, text, hash } = misses[i];
      const translation = translations[i] ?? text;
      await setCached(hash, translation);
      renderTranslation(el, text, translation, hash);
    }
  }
}

function renderTranslation(
  el: Element,
  originalText: string,
  translatedText: string,
  hash: string
): void {
  // Skip if translation is same as original (already Chinese, numbers, etc.)
  if (translatedText === originalText) {
    el.setAttribute(HASH_ATTR, hash);
    return;
  }

  // Mark the original element as translated
  el.classList.add(TRANS_MARKER_CLASS);
  el.setAttribute(HASH_ATTR, hash);

  // Insert translation as a sibling <span> after the original element.
  // Sibling insertion preserves the original element's internal DOM (React/Vue
  // reconciliation unaffected) and avoids disrupting CSS :nth-child / :last-child
  // selectors on the original element's children. <span> is safe as a sibling
  // after any element including <p> (parser auto-close only triggers on block
  // elements, not inline <span>).
  const block = createTranslationBlock(translatedText);
  el.insertAdjacentElement('afterend', block);
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
