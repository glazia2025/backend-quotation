const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { isLocalPdfMode } = require("./pdfRuntime");

const BUCKET = process.env.QUOTATION_S3_BUCKET || "quotation-img";
const MEMORY_CACHE_MAX_AGE_MS = Number(
  process.env.QUOTATION_PDF_MEMORY_CACHE_MAX_AGE_MS || 15 * 60 * 1000
);
const MEMORY_CACHE_MAX_BYTES = Number(
  process.env.QUOTATION_PDF_MEMORY_CACHE_MAX_BYTES || 64 * 1024 * 1024
);
const PDF_CACHE_VERSION = `${process.env.QUOTATION_PDF_CACHE_VERSION || "7"}:pricing-v2`;
const inFlight = new Map();
const memoryCache = new Map();
let memoryCacheBytes = 0;
const generationWaiters = [];
let activeGenerations = 0;
const GENERATION_CONCURRENCY = Math.max(
  1,
  Number(process.env.QUOTATION_PDF_GENERATION_CONCURRENCY || 2)
);
const SIGNED_URL_TTL_SECONDS = Math.max(
  60,
  Number(process.env.QUOTATION_PDF_SIGNED_URL_TTL_SECONDS || 900)
);

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const revisionFor = (quotation) =>
  `${PDF_CACHE_VERSION}:${new Date(
    quotation.updatedAt || quotation.createdAt || 0
  ).getTime()}`;

const cacheKeyFor = (quotationId, type) =>
  `quotations/${quotationId}/pdf-cache/${type}.pdf`;

const withGenerationSlot = async (generate) => {
  await new Promise((resolve) => {
    const acquire = () => {
      activeGenerations += 1;
      resolve();
    };
    if (activeGenerations < GENERATION_CONCURRENCY) acquire();
    else generationWaiters.push(acquire);
  });
  try {
    return await generate();
  } finally {
    activeGenerations -= 1;
    generationWaiters.shift()?.();
  }
};

const rememberPdf = (quotation, type, buffer, generatedAt = Date.now()) => {
  const key = cacheKeyFor(quotation._id, type);
  const existing = memoryCache.get(key);
  if (existing) memoryCacheBytes -= existing.buffer.length;
  memoryCache.delete(key);

  // A single unusually large PDF must not defeat the process-wide cache cap.
  if (buffer.length > MEMORY_CACHE_MAX_BYTES) return;

  memoryCache.set(key, {
    buffer,
    generatedAt,
    revision: revisionFor(quotation),
  });
  memoryCacheBytes += buffer.length;

  while (memoryCacheBytes > MEMORY_CACHE_MAX_BYTES && memoryCache.size > 1) {
    const oldestKey = memoryCache.keys().next().value;
    const oldest = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    memoryCacheBytes -= oldest.buffer.length;
  }
};

async function readCachedPdf(quotation, type) {
  const key = cacheKeyFor(quotation._id, type);
  const memoryEntry = memoryCache.get(key);
  if (
    memoryEntry?.revision === revisionFor(quotation) &&
    Date.now() - memoryEntry.generatedAt <= MEMORY_CACHE_MAX_AGE_MS
  ) {
    memoryCache.delete(key);
    memoryCache.set(key, memoryEntry);
    return memoryEntry.buffer;
  }
  if (memoryEntry) {
    memoryCache.delete(key);
    memoryCacheBytes -= memoryEntry.buffer.length;
  }

  if (!process.env.AWS_REGION) return null;

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );
    const metadata = response.Metadata || {};
    const generatedAt = Number(metadata.generatedat || Date.now());
    if (metadata.revision !== revisionFor(quotation)) {
      return null;
    }

    const buffer = Buffer.from(await response.Body.transformToByteArray());
    rememberPdf(quotation, type, buffer, generatedAt);
    return buffer;
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.warn(`PDF cache read failed for ${type}:`, error.message);
    return null;
  }
}

async function writeCachedPdf(quotation, type, buffer) {
  if (!buffer?.length) return;
  rememberPdf(quotation, type, buffer);
  if (!process.env.AWS_REGION) return;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: cacheKeyFor(quotation._id, type),
      Body: buffer,
      ContentType: "application/pdf",
      CacheControl: "private, max-age=0, no-cache",
      Metadata: {
        revision: revisionFor(quotation),
        generatedat: String(Date.now()),
      },
    })
  );
}

async function getOrGeneratePdf({ quotation, type, generate }) {
  if (isLocalPdfMode()) {
    return {
      buffer: await generate(),
      cacheStatus: "BYPASS",
    };
  }

  const cached = await readCachedPdf(quotation, type);
  if (cached) return { buffer: cached, cacheStatus: "HIT" };

  const flightKey = `${quotation._id}:${type}:${revisionFor(quotation)}`;
  if (!inFlight.has(flightKey)) {
    const generation = (async () => {
      const buffer = await withGenerationSlot(generate);
      await writeCachedPdf(quotation, type, buffer).catch((error) => {
        console.warn(`PDF cache write failed for ${type}:`, error.message);
      });
      return buffer;
    })().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, generation);
  }

  return { buffer: await inFlight.get(flightKey), cacheStatus: "MISS" };
}

async function hasStoredCachedPdf(quotation, type) {
  if (!process.env.AWS_REGION || isLocalPdfMode()) return false;
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: cacheKeyFor(quotation._id, type) })
    );
    return response.Metadata?.revision === revisionFor(quotation);
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return false;
    console.warn(`PDF cache metadata read failed for ${type}:`, error.message);
    return false;
  }
}

async function getPdfCacheStatus(quotation, type) {
  if (!process.env.AWS_REGION || isLocalPdfMode()) return { ready: false, size: 0 };
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: cacheKeyFor(quotation._id, type) })
    );
    const ready = response.Metadata?.revision === revisionFor(quotation);
    return { ready, size: ready ? Number(response.ContentLength || 0) : 0 };
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) {
      return { ready: false, size: 0 };
    }
    throw error;
  }
}

async function createPdfDeliveryUrls(quotation, type, fileName) {
  if (!(await hasStoredCachedPdf(quotation, type))) return null;
  const key = cacheKeyFor(quotation._id, type);
  const safeFileName = String(fileName || "quotation.pdf").replace(/["\r\n]/g, "_");
  const [previewUrl, downloadUrl] = await Promise.all([
    getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ResponseContentType: "application/pdf",
        ResponseContentDisposition: `inline; filename="${safeFileName}"`,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS }
    ),
    getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ResponseContentType: "application/pdf",
        ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS }
    ),
  ]);
  return { previewUrl, downloadUrl, expiresIn: SIGNED_URL_TTL_SECONDS };
}

async function preparePdfDelivery({ quotation, type, fileName, generate }) {
  const wasCached = await hasStoredCachedPdf(quotation, type);
  if (!wasCached) {
    await getOrGeneratePdf({ quotation, type, generate });
  }
  const urls = await createPdfDeliveryUrls(quotation, type, fileName);
  return urls ? { ...urls, cacheStatus: wasCached ? "HIT" : "MISS" } : null;
}

module.exports = {
  getPdfCacheStatus,
  getOrGeneratePdf,
  preparePdfDelivery,
  revisionFor,
};
