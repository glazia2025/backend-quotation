const crypto = require("crypto");
const mongoose = require("mongoose");

const PdfGenerationJob = require("../models/Quotation/PdfGenerationJob");
const PdfWorkerLease = require("../models/Quotation/PdfWorkerLease");
const Quotation = require("../models/Quotation/Quotation");
const User = require("../models/User");
const { getOrGeneratePdf } = require("./pdfCache");
const { isLocalPdfMode } = require("./pdfRuntime");
const { hydrateQuotationItems } = require("./quotationItems");

function readDurationMs(name, fallback, { allowZero = false } = {}) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const value = Number(rawValue);
  if (Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) {
    return value;
  }

  console.warn(`${name} must be a ${allowZero ? "non-negative" : "positive"} number of milliseconds; using ${fallback}`);
  return fallback;
}

const WARMUP_DELAY_MS = readDurationMs("QUOTATION_PDF_WARMUP_DELAY_MS", 1200, {
  allowZero: true,
});
const POLL_MS = readDurationMs("QUOTATION_PDF_WORKER_POLL_MS", 1000);
const LEASE_MS = readDurationMs("QUOTATION_PDF_WORKER_LEASE_MS", 30000);
const STALE_JOB_MS = readDurationMs("QUOTATION_PDF_JOB_STALE_MS", 10 * 60 * 1000);
const WARMUP_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.QUOTATION_PDF_WARMUP_ENABLED || "true").trim().toLowerCase()
);
const instanceId = `${process.pid}-${crypto.randomUUID()}`;
const timers = new Map();
let workerInterval = null;
let leaseInterval = null;
let tickRunning = false;
let isLeader = false;

const revisionFor = (quotation) =>
  String(new Date(quotation.updatedAt || quotation.createdAt || 0).getTime());

async function enqueuePdfGeneration(quotationId, userId) {
  if (isLocalPdfMode()) return;
  const quotation = await Quotation.findById(quotationId)
    .select("_id updatedAt createdAt")
    .lean();
  if (!quotation) return;

  const now = new Date();
  const revision = revisionFor(quotation);
  const userObjectId = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : null;
  await PdfGenerationJob.findOneAndUpdate(
    { quotation: quotation._id },
    [
      {
        $set: {
          quotation: quotation._id,
          user: userObjectId,
          revision,
          status: {
            $cond: [{ $eq: ["$status", "processing"] }, "processing", "pending"],
          },
          rerunRequested: {
            $cond: [{ $eq: ["$status", "processing"] }, true, false],
          },
          attempts: { $ifNull: ["$attempts", 0] },
          nextAttemptAt: now,
          createdAt: { $ifNull: ["$createdAt", now] },
          updatedAt: now,
        },
      },
    ],
    { upsert: true, new: true }
  );
}

function scheduleQuotationPdfWarmup(quotationId, userId) {
  if (!WARMUP_ENABLED || isLocalPdfMode()) return;

  const id = String(quotationId);
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(id);
    enqueuePdfGeneration(id, userId).catch((error) => {
      console.warn(`Unable to enqueue PDF generation for ${id}:`, error.message);
    });
  }, WARMUP_DELAY_MS);
  timer.unref?.();
  timers.set(id, timer);
}

async function cancelPdfGeneration(quotationId) {
  if (isLocalPdfMode()) return;
  const id = String(quotationId);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  await PdfGenerationJob.deleteOne({ quotation: quotationId });
}

async function acquireOrRenewLease() {
  const now = new Date();
  try {
    const lease = await PdfWorkerLease.findOneAndUpdate(
      {
        _id: "pdf-worker-leader",
        $or: [{ owner: instanceId }, { lockedUntil: { $lte: now } }],
      },
      {
        $set: {
          owner: instanceId,
          lockedUntil: new Date(now.getTime() + LEASE_MS),
        },
      },
      { upsert: true, new: true }
    ).lean();
    isLeader = lease?.owner === instanceId;
  } catch (error) {
    if (error?.code !== 11000) {
      console.warn("PDF worker lease error:", error.message);
    }
    isLeader = false;
  }
}

async function claimJob() {
  const now = new Date();
  return PdfGenerationJob.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        {
          status: "processing",
          lockedAt: { $lte: new Date(now.getTime() - STALE_JOB_MS) },
        },
      ],
    },
    {
      $set: {
        status: "processing",
        lockedAt: now,
        lockedBy: instanceId,
        rerunRequested: false,
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
  ).lean();
}

async function processJob(job) {
  const quotation = await Quotation.findById(job.quotation).lean();
  if (!quotation) {
    await PdfGenerationJob.deleteOne({ _id: job._id });
    return;
  }

  const currentRevision = revisionFor(quotation);
  if (currentRevision !== job.revision) {
    await PdfGenerationJob.updateOne(
      { _id: job._id },
      {
        $set: {
          revision: currentRevision,
          status: "pending",
          rerunRequested: false,
          nextAttemptAt: new Date(),
        },
        $unset: { lockedAt: 1, lockedBy: 1 },
      }
    );
    return;
  }

  const [hydrated, user] = await Promise.all([
    hydrateQuotationItems(quotation),
    job.user ? User.findById(job.user) : null,
  ]);
  const { renderQuotationPdfBuffer } = require("../controllers/quotationController");
  const {
    renderBomPdfBuffer,
    renderCuttingSchedulePdfBuffer,
  } = require("../controllers/cuttingScheduleController");

  const generators = [
    ["quotation", () => renderQuotationPdfBuffer(hydrated, user)],
    ["cutting-schedule", () => renderCuttingSchedulePdfBuffer(hydrated)],
    ["bom", () => renderBomPdfBuffer(hydrated)],
  ];

  for (const [type, generate] of generators) {
    await getOrGeneratePdf({ quotation, type, generate });
  }

  const latestJob = await PdfGenerationJob.findById(job._id).lean();
  if (!latestJob) {
    const { deleteQuotationImages } = require("./quotationImages");
    await deleteQuotationImages(job.quotation).catch(() => {});
    return;
  }
  if (latestJob.rerunRequested || latestJob.revision !== job.revision) {
    await PdfGenerationJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "pending",
          rerunRequested: false,
          nextAttemptAt: new Date(),
          attempts: 0,
        },
        $unset: { lockedAt: 1, lockedBy: 1, lastError: 1 },
      }
    );
    return;
  }
  await PdfGenerationJob.deleteOne({ _id: job._id, revision: job.revision });
}

async function workerTick() {
  if (tickRunning || !isLeader) return;
  tickRunning = true;
  try {
    const job = await claimJob();
    if (!job) return;
    try {
      await processJob(job);
    } catch (error) {
      const backoffMs = Math.min(60 * 60 * 1000, 5000 * 2 ** Math.min(job.attempts, 8));
      const failureUpdate = await PdfGenerationJob.updateOne(
        { _id: job._id, revision: job.revision },
        {
          $set: {
            status: "pending",
            nextAttemptAt: new Date(Date.now() + backoffMs),
            lastError: String(error.message || error).slice(0, 1000),
          },
          $unset: { lockedAt: 1, lockedBy: 1 },
        }
      );
      if (failureUpdate.modifiedCount === 0) {
        await PdfGenerationJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: "pending",
              rerunRequested: false,
              attempts: 0,
              nextAttemptAt: new Date(),
            },
            $unset: { lockedAt: 1, lockedBy: 1, lastError: 1 },
          }
        );
      }
      console.warn(`PDF job failed for ${job.quotation}:`, error.message);
    }
  } finally {
    tickRunning = false;
  }
}

async function startPdfGenerationWorker() {
  if (!WARMUP_ENABLED || isLocalPdfMode()) {
    console.log(
      isLocalPdfMode()
        ? "Local PDF mode enabled: cache, S3 writes, and warmup worker are disabled"
        : "Quotation PDF warmup worker is disabled"
    );
    return;
  }
  if (workerInterval) return;
  await Promise.all([PdfGenerationJob.init(), PdfWorkerLease.init()]);
  await acquireOrRenewLease();
  leaseInterval = setInterval(acquireOrRenewLease, Math.max(5000, LEASE_MS / 3));
  workerInterval = setInterval(workerTick, POLL_MS);
  leaseInterval.unref?.();
  workerInterval.unref?.();
  workerTick();
}

async function stopPdfGenerationWorker() {
  if (isLocalPdfMode()) return;
  if (workerInterval) clearInterval(workerInterval);
  if (leaseInterval) clearInterval(leaseInterval);
  workerInterval = null;
  leaseInterval = null;
  isLeader = false;
  await PdfGenerationJob.updateMany(
    { status: "processing", lockedBy: instanceId },
    {
      $set: { status: "pending", nextAttemptAt: new Date() },
      $unset: { lockedAt: 1, lockedBy: 1 },
    }
  );
  await PdfWorkerLease.deleteOne({ _id: "pdf-worker-leader", owner: instanceId });
}

module.exports = {
  cancelPdfGeneration,
  enqueuePdfGeneration,
  scheduleQuotationPdfWarmup,
  startPdfGenerationWorker,
  stopPdfGenerationWorker,
};
