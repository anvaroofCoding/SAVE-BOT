const DEFAULT_TTL_MS = 10 * 60 * 1000;
const SUBSCRIPTION_TTL_MS = 90 * 1000;

class TtlMap {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > 5000) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }

  delete(key) {
    this.map.delete(key);
  }
}

const mediaCache = new TtlMap(DEFAULT_TTL_MS);
const subscriptionCache = new TtlMap(SUBSCRIPTION_TTL_MS);

function getCachedMedia(sourceUrl) {
  return mediaCache.get(sourceUrl);
}

function setCachedMedia(sourceUrl, entry) {
  mediaCache.set(sourceUrl, entry);
}

function getCachedSubscription(userId) {
  return subscriptionCache.get(String(userId));
}

function setCachedSubscription(userId, isSubscribed) {
  subscriptionCache.set(String(userId), isSubscribed);
}

function invalidateSubscription(userId) {
  subscriptionCache.delete(String(userId));
}

module.exports = {
  getCachedMedia,
  setCachedMedia,
  getCachedSubscription,
  setCachedSubscription,
  invalidateSubscription
};
