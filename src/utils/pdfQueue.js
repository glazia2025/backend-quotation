const {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} = require("@aws-sdk/client-sqs");

const PdfGenerationJob = require("../models/Quotation/PdfGenerationJob");

const QUEUE_URL = String(process.env.QUOTATION_PDF_SQS_QUEUE_URL || "").trim();
const WAIT_SECONDS = Math.min(20, Math.max(1, Number(process.env.QUOTATION_PDF_SQS_WAIT_SECONDS || 20)));
const VISIBILITY_SECONDS = Math.max(30, Number(process.env.QUOTATION_PDF_SQS_VISIBILITY_SECONDS || 90));
const sqs = new SQSClient({ region: process.env.AWS_REGION });

const isSqsPdfQueueEnabled = () => Boolean(QUEUE_URL);

async function dispatchPendingPdfJobs(limit = 10) {
  if (!isSqsPdfQueueEnabled()) return 0;
  const jobs = await PdfGenerationJob.find({ status: "pending", nextAttemptAt: { $lte: new Date() } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  let dispatched = 0;
  for (const job of jobs) {
    try {
      const response = await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          jobId: String(job._id),
          quotationId: String(job.quotation),
          userId: job.user ? String(job.user) : null,
          revision: job.revision,
          type: "quotation",
        }),
        MessageAttributes: {
          type: { DataType: "String", StringValue: "quotation" },
        },
      }));
      const result = await PdfGenerationJob.updateOne(
        { _id: job._id, revision: job.revision, status: "pending" },
        { $set: { status: "dispatched", dispatchedAt: new Date(), messageId: response.MessageId }, $unset: { lastError: 1 } }
      );
      if (result.modifiedCount) dispatched += 1;
    } catch (error) {
      await PdfGenerationJob.updateOne(
        { _id: job._id, revision: job.revision },
        { $set: { lastError: String(error.message || error).slice(0, 1000), nextAttemptAt: new Date(Date.now() + 5000) } }
      );
    }
  }
  return dispatched;
}

const receivePdfMessages = async (max = 1) => {
  if (!isSqsPdfQueueEnabled()) return [];
  const response = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: Math.min(10, Math.max(1, max)),
    WaitTimeSeconds: WAIT_SECONDS,
    VisibilityTimeout: VISIBILITY_SECONDS,
    AttributeNames: ["ApproximateReceiveCount"],
  }));
  return response.Messages || [];
};

const deletePdfMessage = (receiptHandle) =>
  sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }));

const extendPdfMessageVisibility = (receiptHandle) =>
  sqs.send(new ChangeMessageVisibilityCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: VISIBILITY_SECONDS,
  }));

module.exports = {
  deletePdfMessage,
  dispatchPendingPdfJobs,
  extendPdfMessageVisibility,
  isSqsPdfQueueEnabled,
  receivePdfMessages,
};
