/**
 * DOM utilities — element scanning, filtering, and safe DOM creation.
 * NEVER use innerHTML — always createElement + textContent.
 */

/** Tags always eligible for translation — leaf-level text containers. */
const TRANSLATABLE_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT',
]);

/** Tags eligible ONLY if they contain no block-level children (leaf text containers).
 *  These are commonly used as layout containers in modern sites — translating them
 *  when they have block children adds extra flex/grid items and breaks layout. */
const LEAF_CONTAINER_TAGS = new Set([
  'DIV', 'ARTICLE', 'SECTION', 'TD', 'TH',
  'SUMMARY', 'LABEL', 'LEGEND', 'OPTION',
]);

/** Tags never to touch. */
const SKIP_TAGS = new Set([
  'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'CODE', 'PRE',
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
  'EMBED', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
]);

/** CSS class marking a translation block inserted by us. */
export const TRANS_BLOCK_CLASS = 'imm-trans-block';

/** CSS class marking the original element as having a translation. */
export const TRANS_MARKER_CLASS = 'imm-translated';

/** Data attribute storing the cache hash on the original element. */
export const HASH_ATTR = 'data-imm-hash';

/**
 * Determine whether an element's text content should be translated.
 * Skips elements that are: in the skip list, empty/whitespace-only,
 * interactive, or already processed.
 */
export function shouldTranslate(el: Element): boolean {
  // Skip by tag name
  if (SKIP_TAGS.has(el.tagName)) return false;

  // Skip interactive / editable elements
  if (el.getAttribute('role') === 'button') return false;
  if (el.getAttribute('contenteditable') === 'true') return false;
  if (el.hasAttribute('data-imm-skip')) return false;

  // Skip if inside a code block or file listing
  if (isInsideCodeBlock(el)) return false;

  // Skip if already has a translation
  if (el.hasAttribute(HASH_ATTR)) return false;
  if (el.classList.contains(TRANS_MARKER_CLASS)) return false;

  // Skip our own translation blocks
  if (el.classList.contains(TRANS_BLOCK_CLASS)) return false;

  // Must be a translatable tag (or have explicit data-imm-translate)
  const tag = el.tagName;
  const isExplicit = el.hasAttribute('data-imm-translate');
  if (!TRANSLATABLE_TAGS.has(tag) && !LEAF_CONTAINER_TAGS.has(tag) && !isExplicit) {
    return false;
  }

  // Layout containers (DIV, ARTICLE, SECTION, TD, TH, etc.) only translate
  // if they're leaf text containers — no block children inside.
  if (LEAF_CONTAINER_TAGS.has(tag) && !isLeafTextContainer(el)) {
    return false;
  }

  // Get direct text content (not from nested block children we'll translate separately)
  const directText = getDirectText(el);
  if (directText.length < 2) return false; // skip very short / empty

  return true;
}

/**
 * Get the text content of an element, excluding text from nested
 * block-level children (which will be translated independently).
 */
export function getDirectText(el: Element): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += (child as Text).textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      // Include inline elements' text; skip text inside nested block elements
      if (isInlineElement(childEl)) {
        text += getDirectText(childEl);
      }
    }
  }
  return text.trim();
}

/** CSS classes that indicate a code-block container (GitHub/GitLab/etc.). */
const CODE_BLOCK_CLASSES = [
  'highlight', 'source-code', 'code-block', 'codeblock',
  'blob-wrapper', 'blob-code', 'blob-code-inner',
  'js-file-line', 'js-code-block', 'file-code',
  'syntax-highlight', 'highlight-source',
  'line', 'line-numbers', 'language-',
];

/**
 * Check if an element or any ancestor is a code block or file listing.
 * Walks up the tree looking for PRE, CODE, or code-related class names.
 */
function isInsideCodeBlock(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName;
    if (tag === 'PRE' || tag === 'CODE') return true;

    // Check class names for code-related containers
    const cls = current.className;
    if (typeof cls === 'string') {
      const lower = cls.toLowerCase();
      for (const pattern of CODE_BLOCK_CLASSES) {
        if (lower.includes(pattern)) return true;
      }
    }
    current = current.parentElement;
    // Stop at body
    if (current?.tagName === 'BODY') break;
  }
  return false;
}

/** Block-level tags — elements we consider "blocks" when checking nesting. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'ARTICLE', 'SECTION', 'ASIDE', 'MAIN', 'NAV',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH',
  'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT', 'UL', 'OL', 'DL',
  'SUMMARY', 'DETAILS', 'FIELDSET', 'FORM', 'HEADER', 'FOOTER',
  'PRE', 'HR', 'ADDRESS',
]);

/**
 * Check if an element is a "leaf" text container — it has text content but
 * no block-level child elements. Such elements are safe to translate because
 * appending a child span won't alter a flex/grid layout.
 */
function isLeafTextContainer(el: Element): boolean {
  for (const child of el.children) {
    if (BLOCK_TAGS.has(child.tagName)) return false;
    // Also check for display:block/grid/flex on children
    const display = getComputedStyle(child).display;
    if (display === 'block' || display === 'flex' || display === 'grid' ||
        display === 'inline-flex' || display === 'inline-grid' ||
        display === 'table' || display === 'table-row' || display === 'table-cell') {
      return false;
    }
  }
  return true;
}

/** Heuristic: inline elements are those that flow within text. */
function isInlineElement(el: Element): boolean {
  const inlineTags = new Set([
    'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'CODE', 'KBD',
    'SMALL', 'MARK', 'SUB', 'SUP', 'TIME', 'ABBR', 'CITE', 'Q',
    'DFN', 'VAR', 'SAMP', 'INS', 'DEL', 'BR', 'WBR',
  ]);
  if (inlineTags.has(el.tagName)) return true;
  // Check computed display style
  const display = getComputedStyle(el).display;
  return display.startsWith('inline');
}

/**
 * Scan the document for all translatable block-level elements.
 */
export function getTranslatableElements(root: Element = document.body): Element[] {
  const elements: Element[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Element): number {
        // Don't recurse into our own translation blocks
        if (node.classList.contains(TRANS_BLOCK_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Don't recurse into skip-tagged elements
        if (SKIP_TAGS.has(node.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Don't recurse into code block containers
        if (node.tagName === 'PRE' || node.tagName === 'CODE') {
          return NodeFilter.FILTER_REJECT;
        }
        const cls = (node.className || '') as string;
        if (typeof cls === 'string') {
          const lower = cls.toLowerCase();
          for (const pattern of CODE_BLOCK_CLASSES) {
            if (lower.includes(pattern)) return NodeFilter.FILTER_REJECT;
          }
        }
        if (shouldTranslate(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );
  let node: Element | null;
  while ((node = walker.nextNode() as Element | null)) {
    elements.push(node);
  }
  return elements;
}

/**
 * Create a translation block element. NEVER uses innerHTML.
 * Uses a <span> (display:block via CSS) so it safely nests inside <p> and other
 * elements that don't allow <div> children. Only shows the translation —
 * the original text is already visible in the element above.
 */
export function createTranslationBlock(translatedText: string): HTMLElement {
  const span = document.createElement('span');
  span.className = TRANS_BLOCK_CLASS;
  span.textContent = translatedText;
  return span;
}

/**
 * Remove CSS truncation from an element so the appended translation is visible.
 * Many sites use -webkit-line-clamp / max-height + overflow:hidden to truncate
 * card previews, which would hide an appended child translation.
 */
export function smashTruncation(el: Element): void {
  const style = (el as HTMLElement).style;
  // Remove line clamping (does not affect layout)
  style.webkitLineClamp = '';
  // Remove max-height constraints (common in card/list truncation)
  // Only if explicitly set via inline style — reading computed style would
  // match nearly every element and be too aggressive.
  if (style.maxHeight && style.maxHeight !== 'none') {
    style.maxHeight = 'none';
  }
  // NOTE: we deliberately do NOT change overflow:hidden. Many sites
  // (GitHub, etc.) use overflow:hidden on flex/grid layout containers.
  // Changing it breaks the page layout.
}

/**
 * Remove all translation blocks from the page and restore original elements.
 */
export function removeAllTranslations(): void {
  // Remove all translation spans (child elements of translated nodes)
  for (const el of document.querySelectorAll(`.${TRANS_BLOCK_CLASS}`)) {
    el.remove();
  }
  // Clear markers and restore truncation on original elements
  for (const el of document.querySelectorAll(`.${TRANS_MARKER_CLASS}`)) {
    el.classList.remove(TRANS_MARKER_CLASS);
    el.removeAttribute(HASH_ATTR);
  }
}

