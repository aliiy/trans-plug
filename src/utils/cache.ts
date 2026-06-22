/**
 * Translation cache — djb2 content hashing + chrome.storage.local persistence.
 * Cache key prefix "tx_" avoids collision with other stored data.
 *
 * Cache entries are stored as { t: string, ts: number } with:
 *   - t: the translation string
 *   - ts: Unix timestamp in milliseconds when the entry was created
 *
 * TTL: entries older than 7 days are treated as expired.
 * Eviction: when cache exceeds MAX_ENTRIES, the oldest 20% are deleted.
 */

const CACHE_PREFIX = 'tx_';
const STORAGE = chrome.storage.local;

/** Maximum number of cached translations before eviction kicks in. */
const MAX_ENTRIES = 5000;

/** Cache TTL in milliseconds (7 days). */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  t: string;
  ts: number;
}

/** Fast non-cryptographic hash (djb2 variant) for cache key generation. */
export function hashContent(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash | 0; // clamp to 32-bit int
  }
  return CACHE_PREFIX + (hash >>> 0).toString(36);
}

/** Read a cache entry, returning the translation if valid and not expired. */
function parseEntry(key: string, raw: unknown): string | null {
  if (typeof raw === 'string') {
    // Legacy format — plain string, no timestamp. Treat as valid (pre-existing cache).
    return raw;
  }
  if (raw && typeof raw === 'object' && 't' in (raw as Record<string, unknown>) && 'ts' in (raw as Record<string, unknown>)) {
    const entry = raw as CacheEntry;
    if (typeof entry.t !== 'string' || typeof entry.ts !== 'number') return null;
    // Check TTL
    if (Date.now() - entry.ts > TTL_MS) {
      // Expired — remove asynchronously (fire-and-forget)
      STORAGE.remove(key).catch(() => {});
      return null;
    }
    return entry.t;
  }
  return null;
}

/** Look up a cached translation. Returns null if not cached or expired. */
export async function getCached(hash: string): Promise<string | null> {
  const result = await STORAGE.get(hash);
  return parseEntry(hash, result[hash]);
}

/** Store a translation in cache with current timestamp. Triggers eviction if needed. */
export async function setCached(hash: string, translation: string): Promise<void> {
  const entry: CacheEntry = { t: translation, ts: Date.now() };
  await STORAGE.set({ [hash]: entry });

  // Trigger async eviction check (fire-and-forget, no await needed for correctness)
  evictIfNeeded();
}

/** Batch lookup — returns Map of hash → translation for valid (non-expired) hits. */
export async function getCachedBatch(
  hashes: string[]
): Promise<Map<string, string>> {
  const result = await STORAGE.get(hashes);
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const translation = parseEntry(key, value);
    if (translation !== null) {
      map.set(key, translation);
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

// --- Eviction (internal) ---

let evictionPending = false;

/** Evict oldest entries if cache exceeds MAX_ENTRIES. Runs at most once at a time. */
async function evictIfNeeded(): Promise<void> {
  if (evictionPending) return;
  evictionPending = true;

  try {
    const all = await STORAGE.get(null);
    const entries: Array<{ key: string; ts: number }> = [];

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(CACHE_PREFIX)) continue;
      let ts = 0;
      if (value && typeof value === 'object' && 'ts' in (value as Record<string, unknown>)) {
        ts = (value as CacheEntry).ts ?? 0;
      }
      entries.push({ key, ts });
    }

    if (entries.length <= MAX_ENTRIES) return;

    // Sort by timestamp ascending (oldest first), remove oldest 20%
    entries.sort((a, b) => a.ts - b.ts);
    const removeCount = Math.ceil(entries.length * 0.2);
    const keysToRemove = entries.slice(0, removeCount).map(e => e.key);

    await STORAGE.remove(keysToRemove);
    console.debug(`[cache] Evicted ${keysToRemove.length} stale entries, ${entries.length - keysToRemove.length} remaining`);
  } catch (err) {
    console.warn('[cache] Eviction failed:', err);
  } finally {
    evictionPending = false;
  }
}
