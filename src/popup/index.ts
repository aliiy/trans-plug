/**
 * Popup UI logic — manages settings, domain rules, cache, and segmented control animation.
 */

import { getSettings, setSetting } from '../utils/storage';
import { clearCache } from '../utils/cache';
import { getDomainAction, setDomainRule, getBaseDomain, type DomainAction } from '../utils/domainRules';

// --- DOM refs ---
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
const toggleEnabled = document.getElementById('toggle-enabled') as HTMLInputElement;
const toggleHover = document.getElementById('toggle-hover') as HTMLInputElement;
const toggleKeyVis = document.getElementById('toggle-key-visibility') as HTMLButtonElement;
const currentDomainEl = document.getElementById('current-domain') as HTMLElement;
const segmentedControl = document.getElementById('segmented-control') as HTMLElement;
const segmentedPill = document.getElementById('segmented-pill') as HTMLElement;
const btnDefault = document.getElementById('btn-default') as HTMLButtonElement;
const btnAlways = document.getElementById('btn-always') as HTMLButtonElement;
const btnNever = document.getElementById('btn-never') as HTMLButtonElement;
const clearCacheBtn = document.getElementById('clear-cache') as HTMLButtonElement;
const statusMsg = document.getElementById('status-message') as HTMLElement;

let currentHostname = '';
const segButtons = [btnDefault, btnAlways, btnNever];

// --- Eye icon SVGs (Lucide) ---
const eyeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOffIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;

// --- Init ---

async function init(): Promise<void> {
  // Get current tab's hostname
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      currentHostname = new URL(tab.url).hostname;
      currentDomainEl.textContent = getBaseDomain(currentHostname);
    } catch {
      currentDomainEl.textContent = '(无法获取域名)';
    }
  }

  // Load settings
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  toggleEnabled.checked = settings.enabled;
  toggleHover.checked = settings.hoverEnabled;

  // Load domain rule + position the sliding pill
  const action = await getDomainAction(currentHostname);
  highlightDomainButton(action);

  // Wire events
  apiKeyInput.addEventListener('change', onApiKeyChange);
  toggleEnabled.addEventListener('change', onEnabledChange);
  toggleHover.addEventListener('change', onHoverChange);
  toggleKeyVis.addEventListener('click', onToggleKeyVisibility);
  btnDefault.addEventListener('click', () => onDomainRuleChange('default'));
  btnAlways.addEventListener('click', () => onDomainRuleChange('always'));
  btnNever.addEventListener('click', () => onDomainRuleChange('never'));
  clearCacheBtn.addEventListener('click', onClearCache);
}

// --- Event handlers ---

async function onApiKeyChange(): Promise<void> {
  await setSetting('apiKey', apiKeyInput.value.trim());
  notifyContentScript('settings-updated');
  showStatus('API Key 已保存 ✓', 'success');
}

async function onEnabledChange(): Promise<void> {
  await setSetting('enabled', toggleEnabled.checked);
  notifyContentScript('toggle-translation');
  showStatus(
    toggleEnabled.checked ? '翻译已启用 ✓' : '翻译已禁用',
    toggleEnabled.checked ? 'success' : ''
  );
}

async function onHoverChange(): Promise<void> {
  await setSetting('hoverEnabled', toggleHover.checked);
  notifyContentScript('toggle-hover');
  showStatus(
    toggleHover.checked ? '悬停翻译已启用 ✓' : '悬停翻译已禁用',
    toggleHover.checked ? 'success' : ''
  );
}

function onToggleKeyVisibility(): void {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyVis.innerHTML = isPassword ? eyeOffIcon : eyeIcon;
}

async function onDomainRuleChange(action: DomainAction | 'default'): Promise<void> {
  await setDomainRule(currentHostname, action);
  highlightDomainButton(action);

  const labels: Record<string, string> = {
    default: '使用全局设置',
    always: `始终翻译 ${getBaseDomain(currentHostname)}`,
    never: `永不翻译 ${getBaseDomain(currentHostname)}`,
  };
  showStatus(`${labels[action]} ✓`, 'success');

  // Notify content script to apply rule immediately
  notifyContentScript('settings-updated');
}

async function onClearCache(): Promise<void> {
  await clearCache();
  showStatus('缓存已清除 ✓', 'success');
}

// --- Helpers ---

function highlightDomainButton(action: string): void {
  segButtons.forEach((btn) => btn.classList.remove('active'));

  let targetBtn: HTMLButtonElement;
  switch (action) {
    case 'always': targetBtn = btnAlways; break;
    case 'never':  targetBtn = btnNever; break;
    default:       targetBtn = btnDefault; break;
  }
  targetBtn.classList.add('active');

  // Animate the sliding pill to the active button
  const containerRect = segmentedControl.getBoundingClientRect();
  const btnRect = targetBtn.getBoundingClientRect();
  const left = btnRect.left - containerRect.left;
  const width = btnRect.width;

  segmentedPill.style.left = `${left}px`;
  segmentedPill.style.width = `${width}px`;
}

async function notifyContentScript(action: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action }).catch(() => {
      // Content script may not be loaded on this page (e.g., chrome:// URLs)
    });
  }
}

function showStatus(message: string, type: string): void {
  statusMsg.textContent = message;
  statusMsg.className = 'status-toast';
  if (type) statusMsg.classList.add(type);

  // Auto-clear after 2.5s
  setTimeout(() => {
    if (statusMsg.textContent === message) {
      statusMsg.textContent = '';
      statusMsg.className = 'status-toast';
    }
  }, 2500);
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
