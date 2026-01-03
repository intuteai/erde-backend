const LIVE_CACHE_TTL_MS = 1500;
const liveCache = new Map();

const cleanupLiveCache = () => {
  const now = Date.now();
  for (const [key, entry] of liveCache.entries()) {
    if (!entry?.ts || now - entry.ts > LIVE_CACHE_TTL_MS) {
      liveCache.delete(key);
    }
  }
};

module.exports = {
  liveCache,
  cleanupLiveCache,
  LIVE_CACHE_TTL_MS,
};
