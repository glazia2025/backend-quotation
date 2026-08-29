const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../prod.env") });

const connectDB = require("./db");
const PdfGenerationJob = require("./models/Quotation/PdfGenerationJob");
const Quotation = require("./models/Quotation/Quotation");
const User = require("./models/User");
const { getOrGeneratePdf } = require("./utils/pdfCache");
const { closePdfBrowser, launchPdfBrowser, shutdownPdfBrowser } = require("./utils/pdfBrowser");
const {
  deletePdfMessage,
  extendPdfMessageVisibility,
  isSqsPdfQueueEnabled,
  receivePdfMessages,
} = require("./utils/pdfQueue");
const { enqueuePdfGeneration } = require("./utils/pdfWarmup");
const { hydrateQuotationItems } = require("./utils/quotationItems");

const concurrency = Math.max(1, Number(process.env.QUOTATION_PDF_WORKER_CONCURRENCY || 1));
const heartbeatMs = Math.max(10000, Number(process.env.QUOTATION_PDF_SQS_HEARTBEAT_MS || 30000));
let stopping = false;

const revisionFor = (quotation) =>
  String(new Date(quotation.updatedAt || quotation.createdAt || 0).getTime());

async function processMessage(message) {
  let payload;
  try {
    payload = JSON.parse(message.Body || "{}");
  } catch (_error) {
    await deletePdfMessage(message.ReceiptHandle);
    return;
  }

  const heartbeat = setInterval(() => {
    extendPdfMessageVisibility(message.ReceiptHandle).catch((error) => {
      console.warn("Unable to extend PDF job visibility:", error.message);
    });
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    const quotation = await Quotation.findById(payload.quotationId).lean();
    if (!quotation) {
      await PdfGenerationJob.deleteOne({ _id: payload.jobId });
      await deletePdfMessage(message.ReceiptHandle);
      return;
    }

    const currentRevision = revisionFor(quotation);
    if (currentRevision !== payload.revision) {
      await enqueuePdfGeneration(quotation._id, quotation.user);
      await deletePdfMessage(message.ReceiptHandle);
      return;
    }

    await PdfGenerationJob.updateOne(
      { _id: payload.jobId, revision: payload.revision },
      { $set: { status: "processing", lockedAt: new Date(), lockedBy: `sqs-${process.pid}` }, $inc: { attempts: 1 } }
    );

    const [hydrated, user] = await Promise.all([
      hydrateQuotationItems(quotation),
      payload.userId ? User.findById(payload.userId) : null,
    ]);
    const { renderQuotationPdfBuffer } = require("./controllers/quotationController");
    await getOrGeneratePdf({
      quotation,
      type: "quotation",
      generate: () => renderQuotationPdfBuffer(hydrated, user),
    });

    const latest = await Quotation.findById(quotation._id).select("updatedAt createdAt user").lean();
    if (latest && revisionFor(latest) !== payload.revision) {
      await enqueuePdfGeneration(latest._id, latest.user);
    } else {
      await PdfGenerationJob.deleteOne({ _id: payload.jobId, revision: payload.revision });
    }
    await deletePdfMessage(message.ReceiptHandle);
  } catch (error) {
    const receives = Number(message.Attributes?.ApproximateReceiveCount || 1);
    await PdfGenerationJob.updateOne(
      { _id: payload.jobId },
      {
        $set: {
          status: receives >= 5 ? "failed" : "dispatched",
          lastError: String(error.message || error).slice(0, 1000),
        },
        $unset: { lockedAt: 1, lockedBy: 1 },
      }
    ).catch(() => {});
    console.error(`PDF SQS job failed (attempt ${receives}):`, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function workerLoop() {
  while (!stopping) {
    const messages = await receivePdfMessages(concurrency);
    await Promise.all(messages.map(processMessage));
  }
}

async function start() {
  if (!isSqsPdfQueueEnabled()) throw new Error("QUOTATION_PDF_SQS_QUEUE_URL is required");
  await connectDB();
  const browserHandle = await launchPdfBrowser();
  await closePdfBrowser(browserHandle);
  console.log(`Quotation PDF SQS worker started with concurrency ${concurrency}`);
  await workerLoop();
  await shutdownPdfBrowser().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received; stopping PDF worker`);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

start().catch((error) => {
  console.error("PDF worker failed:", error);
  process.exitCode = 1;
});
