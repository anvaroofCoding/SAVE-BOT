const {
  updateDb,
  readDb,
  generateId,
  pickFields,
  matchesQuery,
  applySort
} = require("../db/jsonStore");

function nowIso() {
  return new Date().toISOString();
}

const User = {
  async findOneAndUpdate(filter, update, options = {}) {
    return updateDb((db) => {
      const telegramId = Number(filter.telegramId);
      let index = db.users.findIndex((user) => user.telegramId === telegramId);
      const timestamps = { updatedAt: nowIso() };

      if (index === -1) {
        if (!options.upsert) return null;

        const created = {
          _id: generateId(),
          telegramId,
          username: null,
          firstName: null,
          lastName: null,
          languageCode: null,
          isBot: false,
          isPremium: null,
          phoneNumber: null,
          phoneSharedAt: null,
          phoneShareMessageId: null,
          chatId: null,
          isBlocked: false,
          blockedAt: null,
          blockedBy: null,
          blockedReason: null,
          rawFrom: null,
          lastSeenAt: nowIso(),
          createdAt: nowIso(),
          ...update,
          ...timestamps
        };

        db.users.push(created);
        return options.new === false ? null : created;
      }

      const current = db.users[index];
      const next = {
        ...current,
        ...update.$set,
        ...update,
        ...timestamps
      };

      delete next.$set;
      db.users[index] = next;
      return options.new === false ? current : next;
    });
  },

  findOne(query) {
    return {
      select(fields) {
        this._select = fields;
        return this;
      },
      async lean() {
        const db = await readDb();
        const user = db.users.find((item) => matchesQuery(item, query)) || null;
        if (!user) return null;
        return this._select ? pickFields(user, this._select) : { ...user };
      }
    };
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
        let items = db.users.filter((item) => matchesQuery(item, query));
        items = applySort(items, this._sort);
        if (this._skip) items = items.slice(this._skip);
        if (this._limit) items = items.slice(0, this._limit);
        return items.map((item) => ({ ...item }));
      }
    };
  },

  async countDocuments(query = {}) {
    const db = await readDb();
    return db.users.filter((item) => matchesQuery(item, query)).length;
  },

  async updateOne(filter, update) {
    return updateDb((db) => {
      const index = db.users.findIndex((item) => matchesQuery(item, filter));
      if (index === -1) return { matchedCount: 0, modifiedCount: 0 };

      db.users[index] = {
        ...db.users[index],
        ...update.$set,
        updatedAt: nowIso()
      };

      return { matchedCount: 1, modifiedCount: 1 };
    });
  }
};

module.exports = User;
