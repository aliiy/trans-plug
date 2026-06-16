/**
 * All CSS styles injected into the page by the content script.
 * Injected as a <style> element — never uses inline styles on content elements.
 */

export const STYLES = /* css */ `
/* === Translation Block (appended inside the original element as a child span) ===
 * Inherits font, size, color from the parent so it blends with the original text.
 * Only slightly dimmed via opacity to visually distinguish it from the source. */
.imm-trans-block {
  display: block;
  opacity: 0.82;
  margin-top: 0.15em;
  animation: imm-fade-in 0.25s ease-out;
  max-width: 100%;
  overflow-wrap: break-word;
  word-break: break-word;
}
/* Marker on the original element (no forced style changes — let it flow naturally) */
.imm-translated {
  /* Translation span flows as a block child inside the element, no layout override needed */
}

/* === Hover Translation Tooltip === */
.imm-hover-tooltip {
  position: fixed;
  z-index: 2147483647;
  max-width: 420px;
  padding: 10px 14px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  font-size: 14px;
  line-height: 1.55;
  color: #222;
  pointer-events: none;
  animation: imm-fade-in 0.15s ease-out;
}
.imm-hover-tooltip .imm-tt-original {
  color: #666;
  font-size: 0.85em;
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid #eee;
  white-space: pre-wrap;
}
.imm-hover-tooltip .imm-tt-translation {
  color: #111;
  font-weight: 500;
  white-space: pre-wrap;
}
.imm-hover-tooltip .imm-tt-loading {
  color: #999;
  font-style: italic;
}

/* === Selection Translation Popup === */
.imm-selection-popup {
  position: absolute;
  z-index: 2147483646;
  min-width: 200px;
  max-width: 480px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
  font-size: 14px;
  line-height: 1.55;
  animation: imm-fade-in 0.2s ease-out;
  overflow: hidden;
}
.imm-selection-popup .imm-sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #f6f8fa;
  border-bottom: 1px solid #e8ecf0;
}
.imm-selection-popup .imm-sp-title {
  font-size: 0.8em;
  color: #666;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.imm-selection-popup .imm-sp-actions {
  display: flex;
  gap: 6px;
}
.imm-selection-popup .imm-sp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  color: #555;
  transition: background 0.15s;
}
.imm-selection-popup .imm-sp-btn:hover {
  background: #f0f0f0;
}
.imm-selection-popup .imm-sp-body {
  padding: 10px 14px;
}
.imm-selection-popup .imm-sp-original {
  color: #666;
  font-size: 0.85em;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid #eee;
  white-space: pre-wrap;
}
.imm-selection-popup .imm-sp-translation {
  color: #111;
  font-weight: 500;
  white-space: pre-wrap;
}
.imm-selection-popup .imm-sp-loading {
  color: #999;
  font-style: italic;
  padding: 12px 0;
  text-align: center;
}

/* === Fade-in animation === */
@keyframes imm-fade-in {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

/** Inject the stylesheet into the page. */
export function injectStyles(): void {
  if (document.getElementById('imm-trans-styles')) return; // already injected
  const style = document.createElement('style');
  style.id = 'imm-trans-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}
