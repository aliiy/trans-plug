/**
 * Chrome storage helpers — typed wrappers around chrome.storage.local.
 */
const STORAGE = chrome.storage.local;

export interface Settings {
  apiKey: string;
  enabled: boolean;
  hoverEnabled: boolean;
  hoverModifier: 'alt' | 'ctrl' | 'shift';
}

const DEFAULTS: Settings = {
  apiKey: '',
  enabled: false,
  hoverEnabled: true,
  hoverModifier: 'alt',
};

export async function getSettings(): Promise<Settings> {
  const result = await STORAGE.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...result } as Settings;
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K]
): Promise<void> {
  await STORAGE.set({ [key]: value });
}

export async function getSetting<K extends keyof Settings>(
  key: K
): Promise<Settings[K]> {
  const result = await STORAGE.get(key);
  if (result[key] !== undefined) {
    return result[key] as Settings[K];
  }
  return DEFAULTS[key];
}
