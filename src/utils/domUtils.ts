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
 *  when they have block children would insert a translation sibling that duplicates
 *  text already translated via individual child blocks, and adds an extra item in
 *  the parent's flex/grid layout. */
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

/** Semantic container tags — entire content inside these is never translated. */
const SEMANTIC_SKIP_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE']);

/**
 * CSS class patterns that indicate non-translatable UI chrome.
 * Short patterns (≤5 chars) use boundary matching to avoid false positives
 * (e.g. "nav" matches "nav-bar" but NOT "canvas").
 * Longer patterns use substring matching (e.g. "breadcrumb" anywhere in class).
 */
const UI_CHROME_SHORT = /\b(nav|menu|side|aside|footer|toolbar|pager|byline)\b/i;
const UI_CHROME_LONG = /(navbar|navigation|dropdown|breadcrumb|pagination|timestamp|comment-meta)/i;
const UI_CHROME_RE = new RegExp(UI_CHROME_SHORT.source + '|' + UI_CHROME_LONG.source, 'i');

/** Single-word UI labels that should never be translated (English, case-insensitive). */
const UI_LABELS = new Set([
  'login', 'logout', 'signup', 'signin', 'register',
  'submit', 'cancel', 'delete', 'edit', 'save', 'close',
  'share', 'reply', 'like', 'follow', 'subscribe', 'unsubscribe',
  'next', 'prev', 'previous', 'back', 'more', 'less',
  'search', 'reset', 'clear', 'apply', 'confirm', 'ok',
  'copy', 'paste', 'cut', 'undo', 'redo', 'retry',
  'menu', 'settings', 'help', 'about', 'home', 'profile',
  'download', 'upload', 'print', 'refresh', 'reload',
]);

/** CSS class marking a translation block inserted by us. */
export const TRANS_BLOCK_CLASS = 'imm-trans-block';

/** CSS class marking the original element as having a translation. */
export const TRANS_MARKER_CLASS = 'imm-translated';

/** Data attribute storing the cache hash on the original element. */
export const HASH_ATTR = 'data-imm-hash';

/** Data attribute marking an element whose translation is in-flight (API pending).
 *  Prevents concurrent detection paths from re-queuing and duplicating it. */
export const PENDING_ATTR = 'data-imm-pending';

/**
 * Check if an element (or any ancestor) is inside a semantic skip container:
 * <nav>, <footer>, <aside>, or an element whose CSS class indicates UI chrome.
 * Exceptions: <header> inside <article> or <main> is treated as content, not chrome.
 */
function isInsideSemanticChrome(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName;
    // Stop walking at content containers — everything inside is safe to translate
    if (tag === 'MAIN' || tag === 'ARTICLE') return false;
    if (current.getAttribute('role') === 'main') return false;

    // Skip semantic containers
    if (SEMANTIC_SKIP_TAGS.has(tag)) return true;
    // <header> is only skipped if it's page-level (not inside article/main)
    if (tag === 'HEADER') {
      const parent = current.parentElement;
      const parentTag = parent?.tagName ?? '';
      if (parentTag !== 'ARTICLE' && parentTag !== 'MAIN') return true;
    }

    // Check class names for UI chrome (boundary-aware regex)
    const cls = (current.className || '') as string;
    if (typeof cls === 'string' && cls.length > 0 && UI_CHROME_RE.test(cls)) {
      return true;
    }

    current = current.parentElement;
    if (current?.tagName === 'BODY') break;
  }
  return false;
}

/**
 * Check if an element is a fixed/sticky nav element near the top of the viewport.
 * These are almost always navigation bars and should not be translated.
 */
function isFixedNavElement(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.position !== 'fixed' && style.position !== 'sticky') return false;
  const rect = el.getBoundingClientRect();
  // Near the top of the viewport and not full-width content
  return rect.top <= 80 && rect.height < window.innerHeight * 0.6;
}

/**
 * Check whether text is already readable by a Simplified-Chinese reader: mostly
 * Han characters with NO Japanese kana and NO Korean hangul.
 *
 * Han alone is ambiguous — Japanese Kanji share the Unicode block U+4E00–U+9FFF
 * with Chinese. The deciding signal is kana/hangul: any hiragana, katakana, or
 * hangul means the text is Japanese/Korean and MUST be translated, no matter how
 * many Han characters it also contains. (The previous version counted kana and
 * hangul as "CJK" and so silently skipped virtually all Japanese/Korean text.)
 * Cyrillic and Latin count toward the total, so a mostly-Russian/English line
 * with a few stray Han characters is not mistaken for Chinese.
 */
function isAlreadyChineseReadable(text: string): boolean {
  let total = 0;
  let han = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Japanese kana or Korean hangul → not Chinese, needs translation.
    if ((cp >= 0x3040 && cp <= 0x309F) || // Hiragana
        (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana
        (cp >= 0xAC00 && cp <= 0xD7AF)) { // Hangul
      return false;
    }
    const isLatin = (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A);
    const isCyrillic = cp >= 0x0400 && cp <= 0x04FF;
    const isHan = cp >= 0x4E00 && cp <= 0x9FFF; // CJK Unified Ideographs
    if (isLatin || isCyrillic || isHan) {
      total++;
      if (isHan) han++;
    }
  }
  // Too few meaningful chars to judge — let other filters decide.
  if (total < 3) return false;
  // Mostly Han and no kana/hangul → Chinese the user can already read.
  return han / total > 0.5;
}

/**
 * Check if text looks like something that should NOT be translated:
 * pure numbers/dates/amounts, @mentions, #tags, single-word UI labels, pure emoji.
 */
function isNonTranslatableText(text: string): boolean {
  const t = text.trim();

  // Pure numbers, dates, amounts, percentages
  if (/^[\d.,+\-*/=:/\s%$€£¥]+$/.test(t)) return true;
  // ISO-style dates: 2024-01-01, 01/01/2024
  if (/^\d{2,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(t)) return true;
  // @mentions and #hashtags
  if (/^[@#]\w{1,30}$/.test(t)) return true;
  // Pure emoji/symbols (no CJK, no Latin letters)
  if (/^[\p{Emoji}\p{S}\s]+$/u.test(t) && !/[a-zA-Z一-鿿぀-ゟ゠-ヿ]/.test(t)) return true;
  // Single-word UI label (case-insensitive)
  const word = t.toLowerCase().replace(/[.!?…]+$/, '');
  if (UI_LABELS.has(word)) return true;
  // Very short all-uppercase text (likely acronyms, nav labels, button text)
  if (t.length <= 5 && /^[A-Z\s]+$/.test(t) && !/[a-z]/.test(t)) return true;

  return false;
}

/**
 * Check if an element is likely a horizontal navigation item (not content text).
 */
function isHorizontalNavItem(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  const parentStyle = getComputedStyle(parent);
  const isFlexRow = parentStyle.display === 'flex' &&
    (parentStyle.flexDirection === 'row' || parentStyle.flexDirection.startsWith('row'));
  if (!isFlexRow) return false;

  // Parent has many children (likely a list of nav items)
  if (parent.children.length < 3) return false;

  // Element is narrow (nav items are typically short)
  const rect = el.getBoundingClientRect();
  return rect.width < 200;
}

/**
 * Determine whether an element's text content should be translated.
 * Skips elements that are: in the skip list, empty/whitespace-only,
 * interactive, or already processed.
 */
export function shouldTranslate(el: Element): boolean {
  // --- Cheap tag / attribute checks first (no layout reads, no DOM walks) ---
  if (SKIP_TAGS.has(el.tagName)) return false;

  // Skip interactive / editable elements
  if (el.getAttribute('role') === 'button') return false;
  if (el.getAttribute('contenteditable') === 'true') return false;
  if (el.hasAttribute('data-imm-skip')) return false;

  // Skip if already processed, or one of our own translation blocks
  if (el.hasAttribute(HASH_ATTR)) return false;
  if (el.hasAttribute(PENDING_ATTR)) return false; // translation already in-flight
  if (el.classList.contains(TRANS_MARKER_CLASS)) return false;
  if (el.classList.contains(TRANS_BLOCK_CLASS)) return false;

  // Must be a translatable tag (or explicitly opted-in via data-imm-translate)
  const tag = el.tagName;
  const isExplicit = el.hasAttribute('data-imm-translate');
  if (!TRANSLATABLE_TAGS.has(tag) && !LEAF_CONTAINER_TAGS.has(tag) && !isExplicit) {
    return false;
  }

  // --- Text checks (DOM reads only, no forced layout) ---
  // Run before the getComputedStyle/getBoundingClientRect heuristics below so
  // that empty, already-readable, or non-translatable elements bail out cheaply
  // without triggering a layout reflow.
  const directText = getDirectText(el);
  if (directText.length < 2) return false; // skip very short / empty
  // Skip text already readable as Chinese (Han without Japanese kana / Korean hangul)
  if (isAlreadyChineseReadable(directText)) return false;
  // Skip non-translatable patterns (numbers, dates, @mentions, UI labels)
  if (isNonTranslatableText(directText)) return false;

  // --- Ancestor walks (medium cost) ---
  if (isInsideCodeBlock(el)) return false;
  if (isInsideSemanticChrome(el)) return false;

  // Layout containers (DIV, ARTICLE, SECTION, TD, TH, etc.) only translate when
  // they're leaf text containers — no block children inside. isLeafTextContainer
  // reads getComputedStyle per child, so it is gated behind the cheaper checks.
  if (LEAF_CONTAINER_TAGS.has(tag) && !isLeafTextContainer(el)) {
    return false;
  }

  // --- Layout-reading nav heuristics (most expensive) last ---
  // Skip fixed/sticky nav bars near the viewport top
  if (isFixedNavElement(el)) return false;
  // Skip horizontal nav items (flex-row children in nav-like containers)
  if (isHorizontalNavItem(el)) return false;

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
 * inserting a translation sibling won't duplicate text content already
 * translated via individual child blocks.
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
 * Returns a <span> (display:block via CSS) inserted as a sibling after the
 * original element via insertAdjacentElement('afterend', ...). <span> is used
 * instead of <div> because it is valid phrasing content in any HTML context
 * (inside <p>, <li>, etc.) — though sibling insertion via the DOM API bypasses
 * the HTML parser, <span> remains the safest choice.
 * Only shows the translation — the original text is already visible in the
 * element above.
 */
export function createTranslationBlock(translatedText: string): HTMLElement {
  const span = document.createElement('span');
  span.className = TRANS_BLOCK_CLASS;
  span.textContent = translatedText;
  return span;
}

/**
 * Remove CSS truncation from an element. Retained for edge cases where a
 * translation must be placed inside a truncated container. No longer called
 * by the default renderTranslation() path — with sibling insertion the
 * translation lives outside the element's overflow clipping region.
 * Many sites use -webkit-line-clamp / max-height + overflow:hidden to truncate
 * card previews. Only modifies inline styles; does not touch computed styles.
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
  // Clear any in-flight markers so a re-enable starts fresh
  for (const el of document.querySelectorAll(`[${PENDING_ATTR}]`)) {
    el.removeAttribute(PENDING_ATTR);
  }
}

