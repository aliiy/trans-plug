/**
 * Translation cache — MD5-style content hashing + chrome.storage.local persistence.
 * Cache key prefix "tx_" avoids collision with other stored data.
 */

const CACHE_PREFIX = 'tx_';
const STORAGE = chrome.storage.local;

/** Fast non-cryptographic hash (djb2 variant) for cache key generation. */
export function hashContent(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash | 0; // clamp to 32-bit int
  }
  return CACHE_PREFIX + (hash >>> 0).toString(36);
}

/** Look up a cached translation. Returns null if not cached. */
export async function getCached(hash: string): Promise<string | null> {
  const result = await STORAGE.get(hash);
  return result[hash] ?? null;
}

/** Store a translation in cache. */
export async function setCached(hash: string, translation: string): Promise<void> {
  await STORAGE.set({ [hash]: translation });
}

/** Batch lookup — returns Map of hash → translation for hits. */
export async function getCachedBatch(
  hashes: string[]
): Promise<Map<string, string>> {
  const result = await STORAGE.get(hashes);
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith(CACHE_PREFIX) && typeof value === 'string') {
      map.set(key, value);
    }
  }
  return map;
}

/** Remove all cached translations. */
export async function clearCache(): Promise<void> {
  const all = await STORAGE.get(null);
  const keysToRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (key.startsWith(CACHE_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    await STORAGE.remove(keysToRemove);
  }
}
