# Glazia Quotation Backend

This service owns the quotation API surface:

- `/api/quotations`
- `/api/admin/quotations`
- `/api/user/quotation-data`

It does not expose login routes. It verifies the token created by the main
backend using the shared `JWT_SECRET` and `AUTH_COOKIE_NAME`.

## Run

```bash
npm install
cp .env.example prod.env
npm start
```

Use the same production `JWT_SECRET` as `backend-main/prod.env`.
# Quotation PDF background worker

Production can dispatch quotation PDF generation through Amazon SQS. When
`QUOTATION_PDF_SQS_QUEUE_URL` is set, the API process only persists and
dispatches jobs; run the independently scalable worker with:

```bash
npm run start:pdf-worker
```

Configure the SQS source queue with a visibility timeout of at least 90 seconds
and a dead-letter queue with `maxReceiveCount` set to 5. Grant the API task
`sqs:SendMessage`; grant worker tasks `sqs:ReceiveMessage`,
`sqs:DeleteMessage`, and `sqs:ChangeMessageVisibility`. Both services need the
existing MongoDB and S3 access. If the queue URL is absent, the legacy MongoDB
polling worker remains active for rollback compatibility.

Create the encrypted source queue and 14-day DLQ with:

```bash
aws cloudformation deploy \
  --stack-name glazia-production-pdf-queue \
  --template-file infrastructure/pdf-queue.yaml
```

Use the `PdfQueueUrl` output as `QUOTATION_PDF_SQS_QUEUE_URL`. Run the API and
`start:pdf-worker` as separate services; scale only the worker service from SQS
backlog/oldest-message metrics. Keep at least two warm workers in production.

PDF cache objects use one stable key per quotation and document type. If S3
bucket versioning is enabled, configure a lifecycle rule that permanently
deletes noncurrent `quotations/*/pdf-cache/*` versions after one day and removes
expired delete markers; otherwise overwrites can retain billable old versions.

Useful endpoints:

- `GET /api/quotations/:id/pdf-status` queues missing current revisions and
  reports `queued`, `dispatched`, `processing`, `failed`, or `ready`.
- `GET /api/quotations/:id/pdf-url` returns short-lived direct S3 preview and
  download URLs after the current revision is ready.
