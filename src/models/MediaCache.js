const { updateDb, readDb, generateId } = require("../db/jsonStore");

function nowIso() {
  return new Date().toISOString();
}

const MediaCache = {
  findOne(query) {
    return {
      async lean() {
        const db = await readDb();
        const item = db.mediaCache.find((entry) => entry.sourceUrl === query.sourceUrl);
        return item ? { ...item } : null;
      }
    };
  },

  async findOneAndUpdate(filter, update, options = {}) {
    return updateDb((db) => {
      const index = db.mediaCache.findIndex((entry) => entry.sourceUrl === filter.sourceUrl);
      const payload = {
        sourceUrl: filter.sourceUrl,
        platform: update.platform || "unknown",
        title: update.title || null,
        mediaType: update.mediaType,
        telegramFileId: update.telegramFileId,
        fileSizeBytes: update.fileSizeBytes || 0,
        updatedAt: nowIso()
      };

      if (index === -1) {
        if (!options.upsert) return null;
        const created = {
          _id: generateId(),
          ...payload,
          createdAt: nowIso()
        };
        db.mediaCache.push(created);
        return created;
      }

      db.mediaCache[index] = {
        ...db.mediaCache[index],
        ...payload
      };

      return { ...db.mediaCache[index] };
    });
  }
};

module.exports = MediaCache;
