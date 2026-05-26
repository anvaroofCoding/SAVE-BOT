const { updateDb, readDb, generateId } = require("../db/jsonStore");

function nowIso() {
  return new Date().toISOString();
}

const DownloadJob = {
  async create(payload) {
    return updateDb((db) => {
      const job = {
        _id: generateId(),
        telegramId: payload.telegramId,
        chatId: payload.chatId,
        sourceUrl: payload.sourceUrl,
        platform: payload.platform || "unknown",
        status: payload.status || "queued",
        title: payload.title || null,
        mediaType: payload.mediaType || "document",
        fileSizeBytes: payload.fileSizeBytes || 0,
        telegramFileId: payload.telegramFileId || null,
        errorMessage: payload.errorMessage || null,
        processedAt: payload.processedAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      db.downloadJobs.push(job);
      return job;
    });
  },

  findById(id) {
    return {
      async lean() {
        const db = await readDb();
        const job = db.downloadJobs.find((item) => item._id === id);
        return job ? { ...job } : null;
      }
    };
  },

  async findByIdAndUpdate(id, update) {
    return updateDb((db) => {
      const index = db.downloadJobs.findIndex((item) => item._id === id);
      if (index === -1) return null;

      db.downloadJobs[index] = {
        ...db.downloadJobs[index],
        ...update,
        updatedAt: nowIso()
      };

      return { ...db.downloadJobs[index] };
    });
  }
};

module.exports = DownloadJob;
