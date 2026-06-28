const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Quotation = require("../models/Quotation/Quotation");
const { uploadQuotationImages } = require("./quotationImages");
const { hydrateQuotationItems } = require("./quotationItems");

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
