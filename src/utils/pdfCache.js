const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

const BUCKET = process.env.QUOTATION_S3_BUCKET || "quotation-img";
const MEMORY_CACHE_MAX_AGE_MS = Number(
  process.env.QUOTATION_PDF_MEMORY_CACHE_MAX_AGE_MS || 15 * 60 * 1000
);
const MEMORY_CACHE_MAX_BYTES = Number(
  process.env.QUOTATION_PDF_MEMORY_CACHE_MAX_BYTES || 64 * 1024 * 1024
);
const inFlight = new Map();
const memoryCache = new Map();
let memoryCacheBytes = 0;
const generationWaiters = [];
let activeGenerations = 0;
const GENERATION_CONCURRENCY = Math.max(
  1,
  Number(process.env.QUOTATION_PDF_GENERATION_CONCURRENCY || 2)
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
  String(new Date(quotation.updatedAt || quotation.createdAt || 0).getTime());

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

module.exports = {
  getOrGeneratePdf,
};
