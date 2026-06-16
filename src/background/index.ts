/**
 * Background service worker — handles keyboard shortcuts and context menus.
 * Relays commands to the active tab's content script.
 */

// --- Install / Startup ---

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

function setupContextMenu(): void {
  // Remove existing items to avoid duplicates, then re-create
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-page',
      title: '翻译此页面',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection'],
    });
  });
}

// --- Context menu click ---

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  switch (info.menuItemId) {
    case 'translate-page':
      chrome.tabs.sendMessage(tab.id, { action: 'toggle-translation' }).catch(() => {});
      break;
    case 'translate-selection':
      chrome.tabs.sendMessage(tab.id, { action: 'translate-selection' }).catch(() => {});
      break;
  }
});

// --- Keyboard shortcuts ---

chrome.commands.onCommand.addListener((command) => {
  mapCommand(command);
});

async function mapCommand(command: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  switch (command) {
    case 'toggle-translation':
      chrome.tabs.sendMessage(tab.id, { action: 'toggle-translation' }).catch(() => {});
      break;
    case 'toggle-hover':
      chrome.tabs.sendMessage(tab.id, { action: 'toggle-hover' }).catch(() => {});
      break;
    case 'translate-selection':
      chrome.tabs.sendMessage(tab.id, { action: 'translate-selection' }).catch(() => {});
      break;
  }
}

// Keep service worker alive (MV3 may terminate idle workers)
// The above listeners are enough to wake the worker when needed.
