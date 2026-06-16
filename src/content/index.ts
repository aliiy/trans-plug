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
  smashTruncation,
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
const BATCH_SIZE = 15;
const DEBOUNCE_MS = 200;
const ROOT_MARGIN = '300px 0px';

// --- State ---
let enabled = false;
let apiKey = '';
let hoverEnabled = true;
let observer: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
const queue = new Set<Element>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isTranslating = false;
let domainAction: 'always' | 'never' | 'default' = 'default';

// --- Initialization ---

async function init(): Promise<void> {
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

  // Determine effective enabled state
  if (domainAction === 'always') {
    enabled = true;
  } else {
    enabled = settings.enabled;
  }

  // Always listen for messages (toggle, hover, settings) regardless of enabled state
  chrome.runtime.onMessage.addListener(handleMessage);

  if (!enabled) return;

  if (!apiKey) {
    console.warn('[沉浸式翻译] API Key 未设置，请在插件弹窗中配置 DeepSeek API Key');
    return;
  }

  start();
}

function start(): void {
  setupIntersectionObserver();
  setupMutationObserver();
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

// --- MutationObserver (SPA support) ---

function setupMutationObserver(): void {
  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          // Skip our own elements
          if (el.classList.contains(TRANS_BLOCK_CLASS)) continue;

          // Scan the new subtree for translatable elements
          const newElements = getTranslatableElements(el);
          for (const newEl of newElements) {
            observeElement(newEl);
          }

          // Also check the added node itself
          if (shouldTranslate(el)) {
            observeElement(el);
          }
        }
      }
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

  // Remove CSS truncation so the translation child is visible
  smashTruncation(el);

  // Append translation as a child <span> (safe inside <p> and any block container)
  const block = createTranslationBlock(translatedText);
  el.appendChild(block);
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
