const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Quotation = require("../models/Quotation/Quotation");
const {
  isMissingS3ObjectError,
  normalizeQuotationImageUrl,
  sanitizePdfImageReference,
  uploadQuotationImages,
} = require("./quotationImages");
const { hydrateQuotationItems } = require("./quotationItems");
const { getOrGeneratePdf } = require("./pdfCache");

test("legacy embedded items and sub-items remain readable", async () => {
  const legacyImage = "data:image/png;base64,aGVsbG8=";
  const legacy = new Quotation({
    _id: new mongoose.Types.ObjectId(),
    items: [
      {
        _id: new mongoose.Types.ObjectId(),
        refCode: "OLD-1",
        amount: 100,
        refImage: legacyImage,
        subItems: [
          {
            _id: new mongoose.Types.ObjectId(),
            refCode: "OLD-1-a",
            refImage: legacyImage,
          },
        ],
      },
    ],
  }).toObject();

  const hydrated = await hydrateQuotationItems(legacy);
  assert.equal(hydrated.items.length, 1);
  assert.equal(hydrated.items[0].refCode, "OLD-1");
  assert.equal(hydrated.items[0].refImage, legacyImage);
  assert.equal(hydrated.items[0].subItems[0].refCode, "OLD-1-a");
  assert.equal(hydrated.items[0].subItems[0].refImage, legacyImage);
});

test("new quotation documents do not persist an embedded items array", () => {
  const quotation = new Quotation({
    quotationItems: [new mongoose.Types.ObjectId()],
  });
  assert.equal(quotation.items, undefined);
  assert.equal(quotation.quotationItems.length, 1);
});

test("existing remote and relative image URLs are preserved without S3 writes", async () => {
  const remoteUrl = "https://legacy.example.com/window.png";
  const relativeUrl = "/images/legacy-window.png";
  const result = await uploadQuotationImages({
    quotationId: new mongoose.Types.ObjectId(),
    items: [
      {
        refImage: remoteUrl,
        subItems: [{ refImage: relativeUrl }],
      },
    ],
    globalConfig: { logo: remoteUrl },
  });

  assert.equal(result.items[0].refImage, remoteUrl);
  assert.equal(result.items[0].subItems[0].refImage, relativeUrl);
  assert.equal(result.globalConfig.logo, remoteUrl);
  assert.deepEqual(result.uploadedKeys, []);
});

test("incorrect legacy quotation bucket URLs are repaired", () => {
  const previousRegion = process.env.AWS_REGION;
  process.env.AWS_REGION = "ap-south-1";
  const corrected = normalizeQuotationImageUrl(
    "https://glazia.s3.ap-south-1.amazonaws.com/quotations/quote-1/image.png"
  );
  if (previousRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = previousRegion;

  assert.equal(
    corrected,
    "https://quotation-img.s3.ap-south-1.amazonaws.com/quotations/quote-1/image.png"
  );
});

test("missing S3 objects can be distinguished from operational S3 errors", () => {
  assert.equal(isMissingS3ObjectError({ name: "NoSuchKey" }), true);
  assert.equal(
    isMissingS3ObjectError({ $metadata: { httpStatusCode: 404 } }),
    true
  );
  assert.equal(isMissingS3ObjectError({ name: "AccessDenied" }), false);
});

test("malformed legacy PDF image data URLs are omitted", () => {
  assert.equal(
    sanitizePdfImageReference("data:image/png;base64,/Quotations/Fix.png"),
    ""
  );
  assert.equal(sanitizePdfImageReference("data:image/png;base64,aGVsbG8="), "data:image/png;base64,aGVsbG8=");
  assert.equal(sanitizePdfImageReference("https://example.com/window.png"), "https://example.com/window.png");
});

test("concurrent PDF requests share one generation", async () => {
  const previousRegion = process.env.AWS_REGION;
  const previousCacheEnabled = process.env.QUOTATION_PDF_CACHE_ENABLED;
  delete process.env.AWS_REGION;
  process.env.QUOTATION_PDF_CACHE_ENABLED = "true";
  let generationCount = 0;
  const quotation = {
    _id: new mongoose.Types.ObjectId(),
    updatedAt: new Date(),
  };
  const generate = async () => {
    generationCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Buffer.from("pdf");
  };

  const [first, second] = await Promise.all([
    getOrGeneratePdf({ quotation, type: "test", generate }),
    getOrGeneratePdf({ quotation, type: "test", generate }),
  ]);
  const third = await getOrGeneratePdf({ quotation, type: "test", generate });

  assert.equal(generationCount, 1);
  assert.equal(first.buffer.toString(), "pdf");
  assert.equal(second.buffer.toString(), "pdf");
  assert.equal(third.buffer.toString(), "pdf");
  assert.equal(third.cacheStatus, "HIT");

  quotation.updatedAt = new Date(quotation.updatedAt.getTime() + 1000);
  await getOrGeneratePdf({ quotation, type: "test", generate });
  assert.equal(generationCount, 2);

  if (previousRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = previousRegion;
  if (previousCacheEnabled === undefined) {
    delete process.env.QUOTATION_PDF_CACHE_ENABLED;
  } else {
    process.env.QUOTATION_PDF_CACHE_ENABLED = previousCacheEnabled;
  }
});

test("local PDF mode generates directly without using the cache", async () => {
  const previousCacheEnabled = process.env.QUOTATION_PDF_CACHE_ENABLED;
  const previousCacheDisabled = process.env.QUOTATION_PDF_CACHE_DISABLED;
  delete process.env.QUOTATION_PDF_CACHE_ENABLED;
  process.env.QUOTATION_PDF_CACHE_DISABLED = "true";
  let generationCount = 0;
  const quotation = {
    _id: new mongoose.Types.ObjectId(),
    updatedAt: new Date(),
  };
  const generate = async () => {
    generationCount += 1;
    return Buffer.from("local-pdf");
  };

  const first = await getOrGeneratePdf({ quotation, type: "local-test", generate });
  const second = await getOrGeneratePdf({ quotation, type: "local-test", generate });

  if (previousCacheEnabled === undefined) {
    delete process.env.QUOTATION_PDF_CACHE_ENABLED;
  } else {
    process.env.QUOTATION_PDF_CACHE_ENABLED = previousCacheEnabled;
  }
  if (previousCacheDisabled === undefined) {
    delete process.env.QUOTATION_PDF_CACHE_DISABLED;
  } else {
    process.env.QUOTATION_PDF_CACHE_DISABLED = previousCacheDisabled;
  }

  assert.equal(generationCount, 2);
  assert.equal(first.cacheStatus, "BYPASS");
  assert.equal(second.cacheStatus, "BYPASS");
  assert.equal(second.buffer.toString(), "local-pdf");
});
