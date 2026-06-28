const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../../prod.env") });

const connectDB = require("../db");
const Quotation = require("../models/Quotation/Quotation");
const QuotationItem = require("../models/Quotation/QuotationItem");
const { createQuotationItems } = require("./quotationItems");
const {
  deleteS3Keys,
  uploadQuotationImages,
} = require("./quotationImages");

async function migrateQuotationItems() {
  await connectDB();

  const cursor = Quotation.find({
    "items.0": { $exists: true },
    "quotationItems.0": { $exists: false },
  }).cursor();

  let migrated = 0;
  let failed = 0;

  for await (const quotation of cursor) {
    let allIds = [];
    let uploadedKeys = [];
    try {
      // A prior interrupted attempt can leave unreferenced item documents.
      // This quotation still uses embedded items, so they are safe to remove.
      await QuotationItem.deleteMany({ quotation: quotation._id });
      const prepared = await uploadQuotationImages({
        quotationId: quotation._id,
        items: quotation.items,
        globalConfig: quotation.globalConfig || {},
      });
      uploadedKeys = prepared.uploadedKeys;
      const result = await createQuotationItems(quotation._id, prepared.items);
      allIds = result.allIds;

      const updateResult = await Quotation.updateOne(
        { _id: quotation._id, "quotationItems.0": { $exists: false } },
        {
          $set: {
            quotationItems: result.topLevelIds,
            globalConfig: prepared.globalConfig,
          },
          $unset: { items: 1 },
        }
      );

      if (updateResult.modifiedCount !== 1) {
        await QuotationItem.deleteMany({ _id: { $in: allIds } });
        await deleteS3Keys(uploadedKeys);
        continue;
      }
      migrated += 1;
    } catch (error) {
      failed += 1;
      if (allIds.length > 0) {
        await QuotationItem.deleteMany({ _id: { $in: allIds } });
      }
      await deleteS3Keys(uploadedKeys).catch(() => {});
      console.error(`Failed quotation ${quotation._id}:`, error.message);
    }
  }

  console.log(`Quotation item migration complete. Migrated: ${migrated}; failed: ${failed}.`);
  await mongoose.disconnect();

  if (failed > 0) process.exitCode = 1;
}

migrateQuotationItems().catch(async (error) => {
  console.error("Quotation item migration failed:", error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
