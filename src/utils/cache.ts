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

/** Max in-memory cache entries — bounds memory on long-lived SPA sessions. */
const MAX_MEM_ENTRIES = 2000;

/** In-memory cache for fast synchronous lookups, bounded to MAX_MEM_ENTRIES. */
const memCache = new Map<string, string>();

/**
 * Write to the in-memory cache, evicting the oldest entry when over capacity.
 * Map preserves insertion order, so the first key is the oldest (FIFO).
 */
function memSet(hash: string, translation: string): void {
  memCache.set(hash, translation);
  if (memCache.size > MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
}

interface CacheEntry {
  t: string;
  ts: number;
}

/** Normalize text for stable hashing: trim, collapse whitespace, normalize line endings. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Fast non-cryptographic hash (djb2 variant) for cache key generation. */
export function hashContent(text: string): string {
  const normalized = normalizeText(text);
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
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
  // Check memory cache first
  const memHit = memCache.get(hash);
  if (memHit !== undefined) return memHit;

  const result = await STORAGE.get(hash);
  const translation = parseEntry(hash, result[hash]);
  if (translation !== null) {
    memSet(hash, translation);
  }
  return translation;
}

/** Store a translation in cache with current timestamp. Triggers eviction if needed. */
export async function setCached(hash: string, translation: string): Promise<void> {
  // Write to memory immediately (synchronous for virtual-scroll recovery)
  memSet(hash, translation);

  const entry: CacheEntry = { t: translation, ts: Date.now() };
  await STORAGE.set({ [hash]: entry });

  // Trigger async eviction check (fire-and-forget, no await needed for correctness)
  evictIfNeeded();
}

/**
 * Store many translations in a single storage write — far fewer chrome.storage
 * round-trips than calling setCached() once per element for a batch, and a
 * single eviction check instead of one per entry.
 */
export async function setCachedBatch(
  entries: Array<{ hash: string; translation: string }>
): Promise<void> {
  if (entries.length === 0) return;
  const ts = Date.now();
  const toStore: Record<string, CacheEntry> = {};
  for (const { hash, translation } of entries) {
    memSet(hash, translation);
    toStore[hash] = { t: translation, ts };
  }
  await STORAGE.set(toStore);
  evictIfNeeded();
}

/** Batch lookup — returns Map of hash → translation for valid (non-expired) hits. */
export async function getCachedBatch(
  hashes: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const storageHashes: string[] = [];

  // Check memory cache first (synchronous)
  for (const hash of hashes) {
    const memHit = memCache.get(hash);
    if (memHit !== undefined) {
      map.set(hash, memHit);
    } else {
      storageHashes.push(hash);
    }
  }

  // Only query storage for misses
  if (storageHashes.length > 0) {
    const result = await STORAGE.get(storageHashes);
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(CACHE_PREFIX)) continue;
      const translation = parseEntry(key, value);
      if (translation !== null) {
        map.set(key, translation);
        memSet(key, translation); // promote to memory
      }
    }
  }

  return map;
}

/** Clear memory cache (e.g., on clearCache). */
export function clearMemCache(): void {
  memCache.clear();
}

/** Remove all cached translations. */
export async function clearCache(): Promise<void> {
  clearMemCache();
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
let lastEvictionCheck = 0;

/** Minimum gap between full-storage eviction scans (each scan reads all entries). */
const EVICTION_MIN_INTERVAL_MS = 60_000;

/**
 * Evict oldest entries if cache exceeds MAX_ENTRIES. The scan reads all storage,
 * so it is throttled to run at most once per minute. The first call after a page
 * load always runs (lastEvictionCheck starts at 0), keeping storage reliably
 * bounded. Runs at most once concurrently.
 */
async function evictIfNeeded(): Promise<void> {
  if (evictionPending) return;
  const now = Date.now();
  if (now - lastEvictionCheck < EVICTION_MIN_INTERVAL_MS) return;
  evictionPending = true;
  lastEvictionCheck = now;

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
