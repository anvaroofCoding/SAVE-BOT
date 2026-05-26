const fs = require("node:fs/promises");
const path = require("node:path");
const { execSync } = require("node:child_process");

const LOCK_FILE = path.resolve(process.cwd(), "data", ".bot.lock");

function killPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`[STOP] PID ${pid} to'xtatildi`);
  } catch {
    // already stopped
  }
}

async function main() {
  try {
    const pid = Number(await fs.readFile(LOCK_FILE, "utf8"));
    killPid(pid);
    await fs.unlink(LOCK_FILE).catch(() => {});
  } catch {
    // no lock file
  }

  try {
    execSync("pkill -f 'node src/index.js' 2>/dev/null || true", {
      stdio: "ignore",
      shell: true
    });
    execSync("pkill -f 'nodemon.*src/index.js' 2>/dev/null || true", {
      stdio: "ignore",
      shell: true
    });
  } catch {
    // ignore
  }

  console.log("[STOP] Barcha bot jarayonlari to'xtatildi. Endi: npm run dev");
}

main();
