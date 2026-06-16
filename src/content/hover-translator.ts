/**
 * Hover translator — shows a floating translation tooltip when the user
 * holds a modifier key (Alt by default) and hovers over text content.
 */

import { translateBatch } from '../utils/translator';
import { hashContent, getCached, setCached } from '../utils/cache';
import { getSetting } from '../utils/storage';

let enabled = false;
let apiKey = '';
let modifier: 'alt' | 'ctrl' | 'shift' = 'alt';
let modifierPressed = false;
let tooltip: HTMLElement | null = null;
let lastHovered: Element | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;

// --- Public API ---

export function initHoverTranslator(key: string): void {
  apiKey = key;
  getSetting('hoverEnabled').then((val) => {
    enabled = val;
  });
  getSetting('hoverModifier').then((val) => {
    modifier = val;
  });

  document.addEventListener('keydown', onKeyDown, { passive: true });
  document.addEventListener('keyup', onKeyUp, { passive: true });
  document.addEventListener('mouseover', onMouseOver, { passive: true });
  document.addEventListener('mousemove', onMouseMove, { passive: true });

  // Reset modifier state when window loses focus
  window.addEventListener('blur', onBlur);
}

export function destroyHoverTranslator(): void {
  enabled = false;
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('blur', onBlur);
  removeTooltip();
}

export function setHoverEnabled(val: boolean): void {
  enabled = val;
  if (!val) removeTooltip();
}

export function setHoverModifier(val: 'alt' | 'ctrl' | 'shift'): void {
  modifier = val;
  modifierPressed = false;
  removeTooltip();
}

export function updateApiKey(key: string): void {
  apiKey = key;
}

// --- Internal ---

function onKeyDown(e: KeyboardEvent): void {
  if (isModifierEvent(e)) {
    modifierPressed = true;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!isModifierEvent(e)) {
    modifierPressed = false;
    removeTooltip();
  }
}

function onBlur(): void {
  modifierPressed = false;
  removeTooltip();
}

function isModifierEvent(e: KeyboardEvent): boolean {
  switch (modifier) {
    case 'alt': return e.key === 'Alt' && !e.ctrlKey && !e.metaKey;
    case 'ctrl': return e.key === 'Control' && !e.altKey && !e.metaKey;
    case 'shift': return e.key === 'Shift' && !e.altKey && !e.ctrlKey;
    default: return false;
  }
}

function onMouseOver(e: MouseEvent): void {
  if (!enabled || !modifierPressed || !apiKey) return;
  const target = e.target as Element;
  if (!target || target === lastHovered) return;

  // Skip our own UI elements
  if (target.closest('.imm-hover-tooltip, .imm-selection-popup, .imm-trans-block')) return;

  // Find the nearest text-containing element
  const textEl = findTextContainer(target);
  if (!textEl || !hasMeaningfulText(textEl)) {
    removeTooltip();
    return;
  }

  lastHovered = textEl;

  // Throttle to 150ms
  if (throttleTimer) clearTimeout(throttleTimer);
  throttleTimer = setTimeout(() => {
    translateAndShow(textEl!, e.clientX, e.clientY);
  }, 150);
}

function onMouseMove(e: MouseEvent): void {
  if (tooltip) {
    positionTooltip(e.clientX, e.clientY);
  }
}

/** Find the best text-containing ancestor for hover translation. */
function findTextContainer(el: Element): Element | null {
  // Walk up from the hovered element
  let current: Element | null = el;

  // Skip very small inline elements, walk up to a meaningful container
  while (current) {
    const tag = current.tagName;
    // Stop at block-level containers
    if (['P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
         'ARTICLE', 'SECTION', 'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT',
         'LABEL', 'LEGEND', 'SPAN', 'A', 'SUMMARY'].includes(tag)) {
      if (hasMeaningfulText(current)) return current;
    }
    // Don't go beyond certain elements
    if (['BODY', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE'].includes(tag)) {
      break;
    }
    current = current.parentElement;
  }
  return null;
}

function hasMeaningfulText(el: Element): boolean {
  const text = (el as HTMLElement).textContent?.trim() ?? '';
  return text.length >= 2;
}

async function translateAndShow(el: Element, x: number, y: number): Promise<void> {
  const text = (el as HTMLElement).textContent?.trim() ?? '';
  if (text.length < 2) return;

  const hash = hashContent(text);
  const requestId = ++currentRequestId;

  // Check cache
  const cached = await getCached(hash);
  if (requestId !== currentRequestId) return; // stale request

  if (cached) {
    showTooltip(text, cached, x, y);
    return;
  }

  // Show loading state
  showTooltip(text, '', x, y, true);

  // Call API
  try {
    const results = await translateBatch([text], apiKey);
    if (requestId !== currentRequestId) return;
    const translation = results[0] ?? text;
    await setCached(hash, translation);
    showTooltip(text, translation, x, y);
  } catch (err) {
    if (requestId !== currentRequestId) return;
    showTooltip(text, `[翻译失败] ${(err as Error).message}`, x, y);
  }
}

function showTooltip(
  original: string,
  translation: string,
  x: number,
  y: number,
  loading = false
): void {
  removeTooltip();

  tooltip = document.createElement('div');
  tooltip.className = 'imm-hover-tooltip';

  const origDiv = document.createElement('div');
  origDiv.className = 'imm-tt-original';
  origDiv.textContent = original;

  const transDiv = document.createElement('div');
  transDiv.className = loading ? 'imm-tt-loading' : 'imm-tt-translation';
  transDiv.textContent = loading ? '翻译中...' : translation;

  tooltip.appendChild(origDiv);
  tooltip.appendChild(transDiv);
  document.body.appendChild(tooltip);

  positionTooltip(x, y);
}

function positionTooltip(x: number, y: number): void {
  if (!tooltip) return;

  const gap = 12;
  let left = x + gap;
  let top = y + gap;

  // Keep tooltip within viewport
  const rect = tooltip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 8) {
    left = x - rect.width - gap;
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = y - rect.height - gap;
  }
  // Clamp to viewport edges
  left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4));
  top = Math.max(4, Math.min(top, window.innerHeight - rect.height - 4));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function removeTooltip(): void {
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }
  lastHovered = null;
  currentRequestId++;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}
