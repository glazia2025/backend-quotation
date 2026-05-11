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

const cleanupStalePdfTempDirs = () => {
  fs.mkdirSync(PDF_TEMP_DIR, { recursive: true });

  const now = Date.now();
  for (const entry of fs.readdirSync(PDF_TEMP_DIR, { withFileTypes: true })) {
    const isKnownTempDir = STALE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
    if (!entry.isDirectory() || !isKnownTempDir) continue;

    const fullPath = path.join(PDF_TEMP_DIR, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (now - stats.mtimeMs > STALE_TEMP_MAX_AGE_MS) {
        fs.rmSync(fullPath, { recursive: true, force: true });
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
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
};

const closePdfBrowser = async (handle) => {
  if (!handle) return;

  try {
    if (handle.browser) {
      await handle.browser.close();
    }
  } finally {
    if (handle.userDataDir) {
      fs.rmSync(handle.userDataDir, { recursive: true, force: true });
    }
  }
};

module.exports = {
  closePdfBrowser,
  cleanupStalePdfTempDirs,
  launchPdfBrowser,
};
