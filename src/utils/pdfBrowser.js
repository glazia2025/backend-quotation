const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const MIN_TEMP_FREE_BYTES = Number(process.env.PDF_MIN_TEMP_FREE_BYTES || 256 * 1024 * 1024);
//  const MIN_TEMP_FREE_BYTES= 0;
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
const PDF_PROTOCOL_TIMEOUT_MS = Number(process.env.PDF_PROTOCOL_TIMEOUT_MS || 180000);
const PDF_CONTENT_TIMEOUT_MS = Number(process.env.PDF_CONTENT_TIMEOUT_MS || 120000);
const PDF_BROWSER_LAUNCH_TIMEOUT_MS = Number(
  process.env.PDF_BROWSER_LAUNCH_TIMEOUT_MS || 30000
);

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

const withTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

let sharedBrowserHandle = null;
let sharedBrowserPromise = null;
let staleCleanupDone = false;

const allowedAssetOrigins = () => {
  const origins = new Set();
  const quotationBucket = process.env.QUOTATION_S3_BUCKET || "quotation-img";
  const configured = [
    ...(process.env.PDF_ALLOWED_ASSET_ORIGINS || "").split(","),
  ];

  if (quotationBucket && process.env.AWS_REGION) {
    configured.push(
      `https://${quotationBucket}.s3.${process.env.AWS_REGION}.amazonaws.com`
    );
  }

  configured.filter(Boolean).forEach((value) => {
    try {
      origins.add(new URL(String(value).trim()).origin);
    } catch (_error) {
      // Ignore malformed optional asset origins.
    }
  });
  return origins;
};

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
  if (sharedBrowserHandle?.browser?.connected) return sharedBrowserHandle;
  if (sharedBrowserPromise) return sharedBrowserPromise;

  if (!staleCleanupDone) {
    cleanupStalePdfTempDirs();
    staleCleanupDone = true;
  }
  assertTempSpaceAvailable();

  sharedBrowserPromise = (async () => {
    const userDataDir = fs.mkdtempSync(path.join(PDF_TEMP_DIR, STALE_TEMP_PREFIX));
    const cacheDir = path.join(userDataDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });

    try {
      const browser = await puppeteer.launch({
        headless: true,
        userDataDir,
        timeout: PDF_BROWSER_LAUNCH_TIMEOUT_MS,
        protocolTimeout: PDF_PROTOCOL_TIMEOUT_MS,
        args: PDF_BROWSER_ARGS,
        env: {
          ...process.env,
          XDG_CACHE_HOME: cacheDir,
          XDG_CONFIG_HOME: userDataDir,
        },
      });

      const handle = { browser, userDataDir, shared: true };
      browser.once("disconnected", () => {
        if (sharedBrowserHandle === handle) sharedBrowserHandle = null;
        rmTempPath(userDataDir);
      });
      sharedBrowserHandle = handle;
      return handle;
    } catch (error) {
      rmTempPath(userDataDir);
      throw error;
    } finally {
      sharedBrowserPromise = null;
    }
  })();

  return sharedBrowserPromise;
};

const preparePdfPage = async (page) => {
  page.setDefaultTimeout(PDF_CONTENT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PDF_CONTENT_TIMEOUT_MS);

  await page.setRequestInterception(true);
  const permittedOrigins = allowedAssetOrigins();
  page.on("request", (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    const isInlineOrLocal =
      url.startsWith("data:") ||
      url.startsWith("about:") ||
      url.startsWith("blob:") ||
      url.startsWith("file:");
    let isPermittedRemoteImage = false;
    if (resourceType === "image" && !isInlineOrLocal) {
      try {
        isPermittedRemoteImage = permittedOrigins.has(new URL(url).origin);
      } catch (_error) {
        isPermittedRemoteImage = false;
      }
    }

    if (
      !isInlineOrLocal &&
      !isPermittedRemoteImage &&
      ["image", "media", "font", "stylesheet"].includes(resourceType)
    ) {
      request.abort().catch(() => {});
      return;
    }

    request.continue().catch(() => {});
  });
};

const setPdfContent = async (page, html) => {
  await preparePdfPage(page);
  await page.setContent(html, {
    waitUntil: ["domcontentloaded", "load"],
    timeout: PDF_CONTENT_TIMEOUT_MS,
  });
  const failedImages = await page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            })
      )
    );
    return images
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src || img.alt || "unknown image");
  });
  if (failedImages.length > 0) {
    throw new Error(`PDF image failed to load: ${failedImages.join(", ")}`);
  }
};

const closePdfBrowser = async (handle) => {
  if (!handle) return;
  if (handle.shared) return;

  try {
    if (handle.browser) {
      const browserProcess = handle.browser.process?.();
      try {
        await withTimeout(
          handle.browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          "Timed out while closing PDF browser"
        );
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

const shutdownPdfBrowser = async () => {
  const handle = sharedBrowserHandle;
  sharedBrowserHandle = null;
  if (!handle) return;

  try {
    await withTimeout(
      handle.browser.close(),
      BROWSER_CLOSE_TIMEOUT_MS,
      "Timed out while closing shared PDF browser"
    );
  } catch (error) {
    const browserProcess = handle.browser.process?.();
    if (browserProcess && !browserProcess.killed) browserProcess.kill("SIGKILL");
  } finally {
    rmTempPath(handle.userDataDir);
  }
};

process.once("exit", () => {
  const handle = sharedBrowserHandle;
  const browserProcess = handle?.browser?.process?.();
  if (browserProcess && !browserProcess.killed) browserProcess.kill("SIGKILL");
  if (handle?.userDataDir) rmTempPath(handle.userDataDir);
});

module.exports = {
  closePdfBrowser,
  cleanupStalePdfTempDirs,
  launchPdfBrowser,
  preparePdfPage,
  setPdfContent,
  shutdownPdfBrowser,
};
