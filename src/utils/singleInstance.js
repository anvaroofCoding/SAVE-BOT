const fs = require("node:fs/promises");
const path = require("node:path");

const LOCK_FILE = path.resolve(process.cwd(), "data", ".bot.lock");

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireSingleInstanceLock() {
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });

  try {
    await fs.writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const existingPid = Number(await fs.readFile(LOCK_FILE, "utf8").catch(() => ""));
  if (isProcessAlive(existingPid) && existingPid !== process.pid) {
    console.error(
      `[BOT] Boshqa bot jarayoni allaqachon ishlayapti (PID ${existingPid}).\n`
      + "   Avval to'xtating: npm run stop"
    );
    return false;
  }

  await fs.writeFile(LOCK_FILE, String(process.pid), "utf8");
  return true;
}

async function releaseSingleInstanceLock() {
  try {
    const currentPid = Number(await fs.readFile(LOCK_FILE, "utf8"));
    if (currentPid === process.pid) {
      await fs.unlink(LOCK_FILE);
    }
  } catch {
    // lock already removed
  }
}

module.exports = {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock
};
