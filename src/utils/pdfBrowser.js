const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const MIN_TEMP_FREE_BYTES = Number(process.env.PDF_MIN_TEMP_FREE_BYTES || 256 * 1024 * 1024);
const PDF_TEMP_DIR = process.env.PDF_TEMP_DIR || os.tmpdir();
const STALE_TEMP_PREFIX = "glazia-pdf-chrome-";
const STALE_TEMP_PREFIXES = [
  STALE_TEMP_PREFIX,
  "puppeteer_dev_chrome_profile-",
  "chrome-user-data-",
  "org.chromium.Chromium.",
];
const STALE_TEMP_MAX_AGE_MS = Number(process.env.PDF_STALE_TEMP_MAX_AGE_MS || 60 * 60 * 1000);
const BROWSER_CLOSE_TIMEOUT_MS = Number(process.env.PDF_BROWSER_CLOSE_TIMEOUT_MS || 5000);
const TEMP_RM_RETRIES = Number(process.env.PDF_TEMP_RM_RETRIES || 3);

const PDF_BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-crash-reporter",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-features=AcceptCHFrame,BackForwardCache,MediaRouter,OptimizationHints,SegmentationPlatform,Translate",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
];

const assertTempSpaceAvailable = () => {
  fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });

  if (typeof fs.statfsSync !== "function") return;

  const stats = fs.statfsSync(PDF_TEMP_DIR);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);

  if (Number.isFinite(freeBytes) && freeBytes < MIN_TEMP_FREE_BYTES) {
    const error = new Error(
      `Not enough free disk space for PDF generation in ${PDF_TEMP_DIR}. ` +
      `Available ${Math.round(freeBytes / 1024 / 1024)} MB, required at least ` +
      `${Math.round(MIN_TEMP_FREE_BYTES / 1024 / 1024)} MB.`
    );
    error.code = "ENOSPC";
    throw error;
  }
};

const rmTempPath = (targetPath) => {
  if (!targetPath) return;

  for (let attempt = 0; attempt < TEMP_RM_RETRIES; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === TEMP_RM_RETRIES - 1) {
        console.warn(`Failed to remove PDF temp path ${targetPath}:`, error.message);
      }
    }
  }
};

const cleanupStalePdfTempDirs = (maxAgeMs = STALE_TEMP_MAX_AGE_MS) => {
  fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });

  const now = Date.now();
  for (const entry of fs.readdirSync(PDF_TEMP_DIR, { withFileTypes: true })) {
    const isKnownTempDir = STALE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
    if (!entry.isDirectory() || !isKnownTempDir) continue;

    const fullPath = path.join(PDF_TEMP_DIR, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (now - stats.mtimeMs > maxAgeMs) {
        rmTempPath(fullPath);
      }
    } catch (error) {
      console.warn(`Failed to inspect PDF temp directory ${fullPath}:`, error.message);
    }
  }
};

const launchPdfBrowser = async () => {
  cleanupStalePdfTempDirs();
  assertTempSpaceAvailable();

  const userDataDir = fs.mkdtempSync(path.join(PDF_TEMP_DIR, STALE_TEMP_PREFIX));
  const cacheDir = path.join(userDataDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const browser = await puppeteer.launch({
      headless: true,
      userDataDir,
      args: PDF_BROWSER_ARGS,
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheDir,
        XDG_CONFIG_HOME: userDataDir,
      },
    });

    return { browser, userDataDir };
  } catch (error) {
    rmTempPath(userDataDir);
    throw error;
  }
};

const closePdfBrowser = async (handle) => {
  if (!handle) return;

  try {
    if (handle.browser) {
      const browserProcess = handle.browser.process?.();
      try {
        await Promise.race([
          handle.browser.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timed out while closing PDF browser")), BROWSER_CLOSE_TIMEOUT_MS)
          ),
        ]);
      } catch (error) {
        console.warn("PDF browser did not close cleanly:", error.message);
        if (browserProcess && !browserProcess.killed) {
          browserProcess.kill("SIGKILL");
        }
      }
    }
  } finally {
    if (handle.userDataDir) {
      rmTempPath(handle.userDataDir);
    }
    cleanupStalePdfTempDirs();
  }
};

module.exports = {
  closePdfBrowser,
  cleanupStalePdfTempDirs,
  launchPdfBrowser,
};
