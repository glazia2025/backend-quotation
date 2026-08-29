const test = require("node:test");
const assert = require("node:assert/strict");

test("PDF queue remains a safe no-op when no SQS queue URL is configured", async () => {
  const previous = process.env.QUOTATION_PDF_SQS_QUEUE_URL;
  delete process.env.QUOTATION_PDF_SQS_QUEUE_URL;
  const pdfQueue = require("./pdfQueue");

  assert.equal(pdfQueue.isSqsPdfQueueEnabled(), false);
  assert.equal(await pdfQueue.dispatchPendingPdfJobs(), 0);
  assert.deepEqual(await pdfQueue.receivePdfMessages(), []);

  if (previous === undefined) delete process.env.QUOTATION_PDF_SQS_QUEUE_URL;
  else process.env.QUOTATION_PDF_SQS_QUEUE_URL = previous;
});
