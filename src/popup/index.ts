/**
 * Popup UI logic — manages settings, domain rules, and cache.
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
const btnDefault = document.getElementById('btn-default') as HTMLButtonElement;
const btnAlways = document.getElementById('btn-always') as HTMLButtonElement;
const btnNever = document.getElementById('btn-never') as HTMLButtonElement;
const clearCacheBtn = document.getElementById('clear-cache') as HTMLButtonElement;
const statusMsg = document.getElementById('status-message') as HTMLElement;

let currentHostname = '';

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

  // Load domain rule
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
  toggleKeyVis.textContent = isPassword ? '🙈' : '👁';
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
  [btnDefault, btnAlways, btnNever].forEach((btn) => btn.classList.remove('active'));
  switch (action) {
    case 'always':
      btnAlways.classList.add('active');
      break;
    case 'never':
      btnNever.classList.add('active');
      break;
    default:
      btnDefault.classList.add('active');
  }
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
  statusMsg.className = 'status-message';
  if (type) statusMsg.classList.add(type);

  // Auto-clear after 2.5s
  setTimeout(() => {
    if (statusMsg.textContent === message) {
      statusMsg.textContent = '';
      statusMsg.className = 'status-message';
    }
  }, 2500);
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
