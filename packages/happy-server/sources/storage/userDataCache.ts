/**
 * Per-user in-memory cache for expensive GET endpoints.
 *
 * Strategy: write-through invalidation + TTL safety net.
 * - Every write operation explicitly calls invalidate() for its namespace.
 * - TTL (default 60 s) is a safety net for any paths that might be missed
 *   and to prevent unbounded memory growth.
 * - Works correctly in single-instance deployments.
 *
 * Namespaces: 'sessions' | 'feed' | 'friends' | 'artifacts' | 'profile'
 */

const DEFAULT_TTL_MS = 60_000; // 1 minute safety net

interface CacheEntry {
    data: unknown;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Periodic cleanup of expired entries to prevent memory leaks.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expiresAt < now) {
            cache.delete(key);
        }
    }
}, 60_000);

export const userDataCache = {
    get<T>(namespace: string, userId: string): T | null {
        const key = `${namespace}:${userId}`;
        const entry = cache.get(key);
        if (!entry || entry.expiresAt < Date.now()) {
            if (entry) cache.delete(key);
            return null;
        }
        return entry.data as T;
    },

    set(namespace: string, userId: string, data: unknown, ttlMs = DEFAULT_TTL_MS): void {
        cache.set(`${namespace}:${userId}`, { data, expiresAt: Date.now() + ttlMs });
    },

    invalidate(namespace: string, userId: string): void {
        cache.delete(`${namespace}:${userId}`);
    }
};
