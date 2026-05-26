const {
  updateDb,
  readDb,
  generateId,
  matchesQuery,
  applySort
} = require("../db/jsonStore");

function nowIso() {
  return new Date().toISOString();
}

const Advertisement = {
  async create(payload) {
    return updateDb((db) => {
      const ad = {
        _id: generateId(),
        title: payload.title,
        description: payload.description || "",
        linkUrl: payload.linkUrl || null,
        linkLabel: payload.linkLabel || "Batafsil",
        media: payload.media || [],
        createdBy: payload.createdBy,
        status: payload.status || "draft",
        stats: payload.stats || { total: 0, sent: 0, failed: 0 },
        sentAt: payload.sentAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      db.advertisements.push(ad);
      return ad;
    });
  },

  find(query = {}) {
    return {
      sort(sortBy) {
        this._sort = sortBy;
        return this;
      },
      skip(value) {
        this._skip = value;
        return this;
      },
      limit(value) {
        this._limit = value;
        return this;
      },
      async lean() {
        const db = await readDb();
        let items = db.advertisements.filter((item) => matchesQuery(item, query));
        items = applySort(items, this._sort);
        if (this._skip) items = items.slice(this._skip);
        if (this._limit) items = items.slice(0, this._limit);
        return items.map((item) => ({ ...item }));
      }
    };
  },

  async countDocuments(query = {}) {
    const db = await readDb();
    return db.advertisements.filter((item) => matchesQuery(item, query)).length;
  },

  findById(id) {
    return {
      async lean() {
        const db = await readDb();
        const ad = db.advertisements.find((item) => item._id === id);
        return ad ? { ...ad } : null;
      }
    };
  },

  async findByIdAndUpdate(id, update) {
    return updateDb((db) => {
      const index = db.advertisements.findIndex((item) => item._id === id);
      if (index === -1) return null;

      db.advertisements[index] = {
        ...db.advertisements[index],
        ...update,
        updatedAt: nowIso()
      };

      return { ...db.advertisements[index] };
    });
  }
};

module.exports = Advertisement;
