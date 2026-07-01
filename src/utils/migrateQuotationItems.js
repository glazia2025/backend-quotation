const crypto = require("crypto");
const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../../prod.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const connectDB = require("../db");
const PdfGenerationJob = require("../models/Quotation/PdfGenerationJob");
const PdfWorkerLease = require("../models/Quotation/PdfWorkerLease");
const Quotation = require("../models/Quotation/Quotation");
const QuotationItem = require("../models/Quotation/QuotationItem");
const {
  enqueuePdfGeneration,
  startPdfGenerationWorker,
  stopPdfGenerationWorker,
} = require("./pdfWarmup");
const { createQuotationItems, hydrateQuotationItems } = require("./quotationItems");
const {
  deleteS3Keys,
  normalizeQuotationImageUrl,
  uploadQuotationImages,
} = require("./quotationImages");

const MIGRATION_LOCK_ID = "quotation-items-migration";
const LOCK_MS = 60 * 1000;
const owner = `${process.pid}-${crypto.randomUUID()}`;

const optionValue = (name, fallback) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
};

const positiveIntegerOption = (name, fallback, { allowZero = false } = {}) => {
  const value = Number(optionValue(name, fallback));
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
};

const options = {
  batchSize: positiveIntegerOption("batch-size", 10),
  dryRun: process.argv.includes("--dry-run"),
  id: optionValue("id", ""),
  limit: positiveIntegerOption("limit", 0, { allowZero: true }),
  maxRetries: positiveIntegerOption("max-retries", 3),
  pdfOnly: process.argv.includes("--pdf-only"),
  skipPdfs: process.argv.includes("--skip-pdfs"),
  status: process.argv.includes("--status"),
  waitForPdfs: process.argv.includes("--wait-for-pdfs"),
};

if (options.id && !mongoose.Types.ObjectId.isValid(options.id)) {
  throw new Error("--id must be a valid MongoDB ObjectId");
}
if (options.pdfOnly && options.skipPdfs) {
  throw new Error("--pdf-only and --skip-pdfs cannot be used together");
}

let stopRequested = false;
let lockHeartbeat = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasEmbeddedItems = (quotation) => Array.isArray(quotation.items);
const hasItemReferences = (quotation) =>
  Array.isArray(quotation.quotationItems) && quotation.quotationItems.length > 0;

const acquireLock = async () => {
  const now = new Date();
  try {
    const lock = await PdfWorkerLease.findOneAndUpdate(
      {
        _id: MIGRATION_LOCK_ID,
        $or: [{ owner }, { lockedUntil: { $lte: now } }],
      },
      {
        $set: { owner, lockedUntil: new Date(now.getTime() + LOCK_MS) },
      },
      { upsert: true, new: true }
    ).lean();
    return lock?.owner === owner;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
};

const startLockHeartbeat = () => {
  lockHeartbeat = setInterval(async () => {
    try {
      const result = await PdfWorkerLease.updateOne(
        { _id: MIGRATION_LOCK_ID, owner },
        { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } }
      );
      if (result.matchedCount !== 1) {
        console.error("Migration lock was lost; stopping after the current quotation.");
        stopRequested = true;
      }
    } catch (error) {
      console.error("Unable to renew migration lock:", error.message);
      stopRequested = true;
    }
  }, LOCK_MS / 3);
  lockHeartbeat.unref?.();
};

const releaseLock = async () => {
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  lockHeartbeat = null;
  await PdfWorkerLease.deleteOne({ _id: MIGRATION_LOCK_ID, owner }).catch(() => {});
};

const cleanupUncommitted = async ({ allIds, uploadedKeys }) => {
  await Promise.allSettled([
    allIds.length ? QuotationItem.deleteMany({ _id: { $in: allIds } }) : null,
    uploadedKeys.length ? deleteS3Keys(uploadedKeys) : null,
  ]);
};

async function migrateOne(rawQuotation) {
  if (options.pdfOnly) return { status: "unchanged", quotation: rawQuotation };

  const legacy = hasEmbeddedItems(rawQuotation) && !hasItemReferences(rawQuotation);
  const hydrated = await hydrateQuotationItems(rawQuotation);
  const storedImageItems = hasItemReferences(rawQuotation)
    ? await QuotationItem.find({ quotation: rawQuotation._id })
        .select("refImage")
        .lean()
    : [];
  const repairedStoredUrls =
    normalizeQuotationImageUrl(rawQuotation.globalConfig?.logo) !==
      rawQuotation.globalConfig?.logo ||
    storedImageItems.some(
      (item) => normalizeQuotationImageUrl(item.refImage) !== item.refImage
    );
  const prepared = await uploadQuotationImages({
    quotationId: rawQuotation._id,
    items: hydrated.items || [],
    globalConfig: hydrated.globalConfig || {},
  });

  if (!legacy && !repairedStoredUrls && prepared.uploadedKeys.length === 0) {
    return { status: "unchanged", quotation: rawQuotation };
  }

  let allIds = [];
  let committed = false;
  try {
    const created = await createQuotationItems(rawQuotation._id, prepared.items);
    allIds = created.allIds;

    const updateResult = await Quotation.updateOne(
      { _id: rawQuotation._id, updatedAt: rawQuotation.updatedAt },
      {
        $set: {
          quotationItems: created.topLevelIds,
          globalConfig: prepared.globalConfig,
        },
        $unset: { items: 1 },
      }
    );

    if (updateResult.modifiedCount !== 1) {
      const error = new Error("Quotation changed during migration; retrying latest version");
      error.code = "MIGRATION_CONFLICT";
      throw error;
    }
    committed = true;

    await QuotationItem.deleteMany({
      quotation: rawQuotation._id,
      ...(allIds.length ? { _id: { $nin: allIds } } : {}),
    }).catch((error) => {
      console.warn(`Old item cleanup deferred for ${rawQuotation._id}:`, error.message);
    });

    const quotation = await Quotation.findById(rawQuotation._id).lean();
    return { status: "migrated", quotation };
  } catch (error) {
    if (!committed) {
      await cleanupUncommitted({ allIds, uploadedKeys: prepared.uploadedKeys });
    }
    throw error;
  }
}

async function processWithRetries(quotationId) {
  let lastError;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    try {
      const quotation = await Quotation.findById(quotationId).lean();
      if (!quotation) return { status: "missing", quotation: null };
      return await migrateOne(quotation);
    } catch (error) {
      lastError = error;
      if (attempt < options.maxRetries) {
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        console.warn(
          `Attempt ${attempt} failed for ${quotationId}; retrying ` +
            `(${attempt + 1}/${options.maxRetries}) in ${delay}ms: ${error.message}`
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

async function waitForPdfJobs(quotationIds) {
  if (!quotationIds.length) return true;
  await startPdfGenerationWorker();
  console.log(`Waiting for ${quotationIds.length} quotation PDF cache job(s)...`);

  while (!stopRequested) {
    const remaining = await PdfGenerationJob.countDocuments({
      quotation: { $in: quotationIds },
    });
    if (remaining === 0) return true;
    console.log(`PDF cache jobs remaining: ${remaining}`);
    await sleep(5000);
  }
  return false;
}

async function printStatus() {
  const [total, legacy, normalized, pdfJobs, retriedPdfJobs] = await Promise.all([
    Quotation.countDocuments(),
    Quotation.countDocuments({
      "quotationItems.0": { $exists: false },
      items: { $type: "array" },
    }),
    Quotation.countDocuments({ "quotationItems.0": { $exists: true } }),
    PdfGenerationJob.countDocuments(),
    PdfGenerationJob.countDocuments({ attempts: { $gt: 0 } }),
  ]);

  console.log(
    JSON.stringify(
      {
        quotations: {
          total,
          legacy,
          normalized,
          emptyOrUnclassified: total - legacy - normalized,
        },
        pdfJobs: {
          pendingOrProcessing: pdfJobs,
          retriedAtLeastOnce: retriedPdfJobs,
        },
      },
      null,
      2
    )
  );
}

async function migrateQuotationItems() {
  await connectDB();
  await Promise.all([
    QuotationItem.init(),
    PdfGenerationJob.init(),
    PdfWorkerLease.init(),
  ]);

  if (options.status) {
    await printStatus();
    return;
  }

  if (!(await acquireLock())) {
    throw new Error("Another quotation migration is already running");
  }
  startLockHeartbeat();

  const filter = options.id
    ? { _id: new mongoose.Types.ObjectId(options.id) }
    : {};
  const total = await Quotation.countDocuments(filter);
  console.log(
    `Quotation migration starting: total=${total}, batchSize=${options.batchSize}, ` +
      `dryRun=${options.dryRun}, pdfOnly=${options.pdfOnly}, skipPdfs=${options.skipPdfs}`
  );

  const counters = { scanned: 0, migrated: 0, unchanged: 0, failed: 0, enqueued: 0 };
  const enqueuedQuotationIds = [];
  let lastId = null;

  // Keyset pagination avoids holding a MongoDB cursor open while images upload.
  // Each page is discarded before the next one is fetched, keeping memory bounded.
  while (!stopRequested && (options.limit === 0 || counters.scanned < options.limit)) {
    const pageSize = options.limit
      ? Math.min(options.batchSize, options.limit - counters.scanned)
      : options.batchSize;
    const pageFilter = lastId
      ? { $and: [filter, { _id: { $gt: lastId } }] }
      : filter;
    const quotations = await Quotation.find(pageFilter)
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean();
    if (quotations.length === 0) break;

    for (const quotation of quotations) {
      if (stopRequested) break;
      counters.scanned += 1;
      lastId = quotation._id;

      try {
        if (options.dryRun) {
          const legacy = hasEmbeddedItems(quotation) && !hasItemReferences(quotation);
          console.log(
            `[dry-run] ${quotation._id}: ${legacy ? "legacy-items" : "normalized-or-empty"}`
          );
          counters[legacy ? "migrated" : "unchanged"] += 1;
        } else {
          const result = await processWithRetries(quotation._id);
          counters[result.status === "migrated" ? "migrated" : "unchanged"] += 1;

          if (!options.skipPdfs && result.quotation) {
            await enqueuePdfGeneration(result.quotation._id, result.quotation.user);
            counters.enqueued += 1;
            if (options.waitForPdfs) enqueuedQuotationIds.push(result.quotation._id);
          }
        }
      } catch (error) {
        counters.failed += 1;
        console.error(`Failed quotation ${quotation._id}:`, error.message);
      }

      if (counters.scanned % options.batchSize === 0) {
        console.log(`Progress: ${JSON.stringify(counters)}, lastId=${lastId}`);
      }
    }
  }

  console.log(`Migration scan complete: ${JSON.stringify(counters)}`);
  if (options.waitForPdfs && !options.dryRun && !options.skipPdfs) {
    const pdfsComplete = await waitForPdfJobs(enqueuedQuotationIds);
    console.log(
      pdfsComplete
        ? "All queued PDF caches are complete."
        : "Stopped waiting; unfinished PDF jobs remain safely queued in MongoDB."
    );
  } else if (counters.enqueued > 0) {
    console.log(
      "PDF jobs were stored durably in MongoDB and will continue through the backend PDF worker. " +
        "Use --wait-for-pdfs to keep this process open until they finish."
    );
  }

  if (counters.failed > 0) process.exitCode = 1;
}

const requestStop = (signal) => {
  console.log(`${signal} received; stopping safely after the current quotation.`);
  stopRequested = true;
};
process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

migrateQuotationItems()
  .catch((error) => {
    console.error("Quotation migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopPdfGenerationWorker().catch(() => {});
    await releaseLock();
    await mongoose.disconnect();
  });
