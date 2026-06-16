/**
 * Selection translator — shows a floating translation popup when the user
 * selects text on the page.
 */

import { translateBatch } from '../utils/translator';
import { hashContent, getCached, setCached } from '../utils/cache';

let apiKey = '';
let popup: HTMLElement | null = null;
let currentRequestId = 0;

// --- Public API ---

export function initSelectionTranslator(key: string): void {
  apiKey = key;
  document.addEventListener('mouseup', onMouseUp);
  // Dismiss popup on scroll or outside click
  document.addEventListener('mousedown', onMouseDown);
  window.addEventListener('scroll', removePopup, { passive: true });
}

export function destroySelectionTranslator(): void {
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('scroll', removePopup);
  removePopup();
}

export function updateApiKey(key: string): void {
  apiKey = key;
}

// --- Internal ---

function onMouseUp(e: MouseEvent): void {
  // Don't trigger on our own UI
  if ((e.target as Element)?.closest('.imm-selection-popup, .imm-hover-tooltip, .imm-trans-block')) {
    return;
  }

  // Small delay to let the selection settle
  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 2) return;

    // Don't translate if selection is inside an input/textarea (handled elsewhere)
    const anchorNode = selection.anchorNode;
    if (anchorNode?.parentElement?.closest('input, textarea, [contenteditable="true"]')) {
      return;
    }

    // Get selection position for popup placement
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    translateAndShow(text, rect);
  }, 10);
}

function onMouseDown(e: MouseEvent): void {
  // Close popup if clicking outside it
  if (popup && !(e.target as Element)?.closest('.imm-selection-popup')) {
    removePopup();
  }
}

async function translateAndShow(
  text: string,
  rect: DOMRect
): Promise<void> {
  if (!apiKey) return;

  const hash = hashContent(text);
  const requestId = ++currentRequestId;

  // Show popup with loading state
  showPopup(text, '', rect, true);

  // Check cache
  const cached = await getCached(hash);
  if (requestId !== currentRequestId) return;

  if (cached) {
    showPopup(text, cached, rect);
    return;
  }

  // Call API
  try {
    const results = await translateBatch([text], apiKey);
    if (requestId !== currentRequestId) return;
    const translation = results[0] ?? text;
    await setCached(hash, translation);
    showPopup(text, translation, rect);
  } catch (err) {
    if (requestId !== currentRequestId) return;
    showPopup(text, `[翻译失败] ${(err as Error).message}`, rect);
  }
}

function showPopup(
  original: string,
  translation: string,
  anchorRect: DOMRect,
  loading = false
): void {
  removePopup();

  popup = document.createElement('div');
  popup.className = 'imm-selection-popup';

  // Header
  const header = document.createElement('div');
  header.className = 'imm-sp-header';

  const title = document.createElement('span');
  title.className = 'imm-sp-title';
  title.textContent = '翻译';

  const actions = document.createElement('div');
  actions.className = 'imm-sp-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'imm-sp-btn';
  copyBtn.textContent = '📋';
  copyBtn.title = '复制译文';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(translation).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = translation;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  });

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'imm-sp-btn';
  closeBtn.textContent = '✕';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removePopup();
  });

  actions.appendChild(copyBtn);
  actions.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(actions);

  // Body
  const body = document.createElement('div');
  body.className = 'imm-sp-body';

  const origDiv = document.createElement('div');
  origDiv.className = 'imm-sp-original';
  origDiv.textContent = original;

  const transDiv = document.createElement('div');
  transDiv.className = loading ? 'imm-sp-loading' : 'imm-sp-translation';
  transDiv.textContent = loading ? '⏳ 翻译中...' : translation;

  body.appendChild(origDiv);
  body.appendChild(transDiv);

  popup.appendChild(header);
  popup.appendChild(body);
  document.body.appendChild(popup);

  // Position the popup
  positionPopup(anchorRect);
}

function positionPopup(anchorRect: DOMRect): void {
  if (!popup) return;

  const gap = 8;
  const popupRect = popup.getBoundingClientRect();

  // Try below the selection first, then above
  let top = anchorRect.bottom + gap + window.scrollY;
  let left = anchorRect.left + window.scrollX;

  // If below goes off-screen, try above
  if (top + popupRect.height > window.innerHeight + window.scrollY - 8) {
    top = anchorRect.top - popupRect.height - gap + window.scrollY;
  }
  // Clamp vertically
  top = Math.max(
    window.scrollY + 4,
    Math.min(top, window.scrollY + window.innerHeight - popupRect.height - 4)
  );

  // Clamp horizontally
  left = Math.max(4, Math.min(left, window.innerWidth - popupRect.width - 4 + window.scrollX));

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

function removePopup(): void {
  if (popup) {
    popup.remove();
    popup = null;
  }
  currentRequestId++;
}
