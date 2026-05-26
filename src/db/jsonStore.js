const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.resolve(process.cwd(), "data");
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "data.json");

const DEFAULT_DB = {
  users: [],
  downloadJobs: [],
  mediaCache: [],
  advertisements: [],
  meta: { version: 1, createdAt: new Date().toISOString() }
};

let writeChain = Promise.resolve();

function enqueue(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

function generateId() {
  return randomUUID();
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(DEFAULT_DB, null, 2), "utf8");
  }
}

async function loadDb() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  const db = JSON.parse(raw);

  return {
    users: Array.isArray(db.users) ? db.users : [],
    downloadJobs: Array.isArray(db.downloadJobs) ? db.downloadJobs : [],
    mediaCache: Array.isArray(db.mediaCache) ? db.mediaCache : [],
    advertisements: Array.isArray(db.advertisements) ? db.advertisements : [],
    meta: db.meta || { version: 1 }
  };
}

async function saveDb(db) {
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify(db, null, 2);

  await fs.writeFile(tempFile, payload, "utf8");
  await fs.rename(tempFile, DATA_FILE);
}

async function initJsonDb() {
  await ensureDataFile();
  const db = await loadDb();
  console.log(`[DB] JSON storage ready: ${DATA_FILE}`);
  console.log(
    `[DB] users=${db.users.length} jobs=${db.downloadJobs.length} cache=${db.mediaCache.length} ads=${db.advertisements.length}`
  );
}

async function updateDb(mutator) {
  return enqueue(async () => {
    const db = await loadDb();
    const result = await mutator(db);
    await saveDb(db);
    return result;
  });
}

async function readDb() {
  return loadDb();
}

function pickFields(doc, select) {
  if (!select || select === "") return { ...doc };

  const fields = select.split(/\s+/).filter(Boolean);
  const includeOnly = !fields.some((field) => field.startsWith("-"));
  const picked = {};

  if (includeOnly) {
    for (const field of fields) {
      if (field.startsWith("-")) continue;
      picked[field] = doc[field];
    }
    return picked;
  }

  const excluded = new Set(fields.filter((field) => field.startsWith("-")).map((field) => field.slice(1)));
  for (const [key, value] of Object.entries(doc)) {
    if (!excluded.has(key)) {
      picked[key] = value;
    }
  }

  return picked;
}

function matchesQuery(doc, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (key === "$or") {
      const ok = value.some((clause) => matchesQuery(doc, clause));
      if (!ok) return false;
      continue;
    }

    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(value, "$ne")) {
        if (doc[key] === value.$ne) return false;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(value, "$gte")) {
        const left = new Date(doc[key]).getTime();
        const right = new Date(value.$gte).getTime();
        if (Number.isNaN(left) || left < right) return false;
        continue;
      }
    }

    if (doc[key] !== value) {
      return false;
    }
  }

  return true;
}

function applySort(items, sort) {
  if (!sort) return items;

  const [[field, direction]] = Object.entries(sort);
  const factor = direction === -1 ? -1 : 1;

  return [...items].sort((a, b) => {
    const left = a[field];
    const right = b[field];

    const leftTime = new Date(left).getTime();
    const rightTime = new Date(right).getTime();

    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return (leftTime - rightTime) * factor;
    }

    if (typeof left === "string" && typeof right === "string") {
      return left.localeCompare(right) * factor;
    }

    return ((left || 0) - (right || 0)) * factor;
  });
}

module.exports = {
  DATA_FILE,
  initJsonDb,
  updateDb,
  readDb,
  generateId,
  pickFields,
  matchesQuery,
  applySort
};
