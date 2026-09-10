const mongoose = require("mongoose");
const { performance } = require("node:perf_hooks");
const Quotation = require("../models/Quotation/Quotation");
const QuotationItem = require("../models/Quotation/QuotationItem");
const {
  createQuotationItems,
  hydrateQuotationItems,
} = require("../utils/quotationItems");
const {
  collectQuotationImageKeys,
  deleteS3Keys,
  uploadQuotationImages,
} = require("../utils/quotationImages");
const { scheduleQuotationPdfWarmup } = require("../utils/pdfWarmup");

const isOwner = (quotation, user) =>
  user?.role === "admin" ||
  !quotation.user ||
  !user?.userId ||
  quotation.user.toString() === user.userId;

async function findQuotation(req, res, projection) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ message: "Invalid quotation id" });
    return null;
  }
  const query = Quotation.findById(req.params.id);
  if (projection) query.select(projection);
  const quotation = await query;
  if (!quotation) {
    res.status(404).json({ message: "Quotation not found" });
    return null;
  }
  if (!isOwner(quotation, req.user)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return quotation;
}

const itemFromHydratedQuotation = (quotation, itemId) =>
  quotation.items.find(
    (item) => String(item._id || item.id) === String(itemId)
  );

async function hydrateItem(quotation, itemId) {
  const hydrated = await hydrateQuotationItems(quotation.toObject(), { itemId });
  return itemFromHydratedQuotation(hydrated, itemId);
}

async function touchQuotation(quotation, userId) {
  quotation.markModified("quotationItems");
  await quotation.save();
  await scheduleQuotationPdfWarmup(quotation._id, userId).catch((error) => {
    // The item is already committed; a PDF queue outage must not roll it back.
    console.warn("Unable to schedule quotation PDF warmup:", error.message);
  });
}

const createQuotationItem = async (req, res) => {
  const started = performance.now();
  const timings = [];
  const timed = async (name, action) => {
    const stepStarted = performance.now();
    try { return await action(); }
    finally { timings.push(`${name};dur=${(performance.now() - stepStarted).toFixed(1)}`); }
  };
  const setTimingHeader = () => res.setHeader("Server-Timing", [
    ...timings, `save_total;dur=${(performance.now() - started).toFixed(1)}`,
  ].join(", "));
  let prepared;
  let createdIds = [];
  let committed = false;
  try {
    const quotation = await timed("quotation_lookup", () => findQuotation(req, res, "_id user"));
    if (!quotation) return;
    const item = req.body?.item ?? req.body;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return res.status(400).json({ message: "Quotation item is required" });
    }

    prepared = await timed("image_upload", () => uploadQuotationImages({
      quotationId: quotation._id,
      items: [item],
    }));
    const created = await timed("item_insert", () => createQuotationItems(quotation._id, prepared.items));
    createdIds = created.allIds;
    // Append atomically without loading/replacing the whole item reference list.
    const updatedQuotation = await timed("quotation_update", () => Quotation.findByIdAndUpdate(
      quotation._id,
      { $push: { quotationItems: created.topLevelIds[0] } },
      { new: true, runValidators: true }
    ).select("_id updatedAt").lean());
    if (!updatedQuotation) {
      const error = new Error("Quotation no longer exists");
      error.statusCode = 404;
      throw error;
    }
    committed = true;

    await timed("pdf_schedule", () => scheduleQuotationPdfWarmup(quotation._id, req.user?.userId)).catch((error) => {
      console.warn("Unable to schedule quotation PDF warmup:", error.message);
    });
    const hydrated = await hydrateQuotationItems({
      _id: quotation._id,
      quotationItems: created.topLevelIds,
    }, { documents: created.documents });
    setTimingHeader();
    return res.status(201).json({ item: hydrated.items[0], updatedAt: updatedQuotation.updatedAt });
  } catch (error) {
    if (!committed && createdIds.length) {
      await QuotationItem.deleteMany({ _id: { $in: createdIds } }).catch(() => {});
    }
    if (!committed) {
      await deleteS3Keys(prepared?.uploadedKeys || []).catch(() => {});
    }
    setTimingHeader();
    console.error("Error creating quotation item:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Error creating quotation item",
    });
  }
};

const updateQuotationItem = async (req, res) => {
  let prepared;
  let replacementIds = [];
  let committed = false;
  try {
    const quotation = await findQuotation(req, res);
    if (!quotation) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.itemId)) {
      return res.status(400).json({ message: "Invalid quotation item id" });
    }
    const index = quotation.quotationItems.findIndex(
      (id) => String(id) === req.params.itemId
    );
    if (index < 0) {
      return res.status(404).json({ message: "Quotation item not found" });
    }
    const item = req.body?.item ?? req.body;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return res.status(400).json({ message: "Quotation item is required" });
    }

    const previousItem = await hydrateItem(quotation, req.params.itemId);
    const previousImageKeys = collectQuotationImageKeys({ items: [previousItem] });
    prepared = await uploadQuotationImages({
      quotationId: quotation._id,
      items: [item],
    });
    const replacement = await createQuotationItems(quotation._id, prepared.items);
    replacementIds = replacement.allIds;
    const replacementId = replacement.topLevelIds[0];
    quotation.quotationItems[index] = replacementId;
    await touchQuotation(quotation, req.user?.userId);
    committed = true;

    await QuotationItem.deleteMany({
      quotation: quotation._id,
      $or: [{ _id: req.params.itemId }, { parentItem: req.params.itemId }],
    });
    const savedItem = await hydrateItem(quotation, replacementId);
    const currentImageKeys = new Set(
      collectQuotationImageKeys(
        await hydrateQuotationItems(quotation.toObject())
      )
    );
    await deleteS3Keys(
      previousImageKeys.filter((key) => !currentImageKeys.has(key))
    ).catch((error) => {
      console.warn("Failed to remove replaced quotation item images:", error.message);
    });

    return res.json({ item: savedItem, updatedAt: quotation.updatedAt });
  } catch (error) {
    if (!committed && replacementIds.length) {
      await QuotationItem.deleteMany({ _id: { $in: replacementIds } }).catch(() => {});
    }
    if (!committed) {
      await deleteS3Keys(prepared?.uploadedKeys || []).catch(() => {});
    }
    console.error("Error updating quotation item:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Error updating quotation item",
    });
  }
};

const deleteQuotationItem = async (req, res) => {
  try {
    const quotation = await findQuotation(req, res);
    if (!quotation) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.itemId)) {
      return res.status(400).json({ message: "Invalid quotation item id" });
    }
    const index = quotation.quotationItems.findIndex(
      (id) => String(id) === req.params.itemId
    );
    if (index < 0) {
      return res.status(404).json({ message: "Quotation item not found" });
    }

    const previousItem = await hydrateItem(quotation, req.params.itemId);
    const imageKeys = collectQuotationImageKeys({ items: [previousItem] });
    quotation.quotationItems.splice(index, 1);
    await touchQuotation(quotation, req.user?.userId);
    const currentImageKeys = new Set(
      collectQuotationImageKeys(
        await hydrateQuotationItems(quotation.toObject())
      )
    );
    await QuotationItem.deleteMany({
      quotation: quotation._id,
      $or: [{ _id: req.params.itemId }, { parentItem: req.params.itemId }],
    });
    await deleteS3Keys(
      imageKeys.filter((key) => !currentImageKeys.has(key))
    ).catch((error) => {
      console.warn("Failed to remove deleted quotation item images:", error.message);
    });
    return res.json({ itemId: req.params.itemId, updatedAt: quotation.updatedAt });
  } catch (error) {
    console.error("Error deleting quotation item:", error);
    return res.status(500).json({ message: "Error deleting quotation item" });
  }
};

const reorderQuotationItems = async (req, res) => {
  try {
    const quotation = await findQuotation(req, res);
    if (!quotation) return;
    const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String) : [];
    const currentIds = quotation.quotationItems.map(String);
    if (
      itemIds.length !== currentIds.length ||
      new Set(itemIds).size !== currentIds.length ||
      currentIds.some((id) => !itemIds.includes(id))
    ) {
      return res.status(400).json({ message: "itemIds must contain every quotation item exactly once" });
    }
    quotation.quotationItems = itemIds;
    await touchQuotation(quotation, req.user?.userId);
    return res.json({ itemIds, updatedAt: quotation.updatedAt });
  } catch (error) {
    console.error("Error reordering quotation items:", error);
    return res.status(500).json({ message: "Error reordering quotation items" });
  }
};

const BULK_UPDATE_FIELDS = {
  glass: "glassSpec",
  colorFinish: "colorFinish",
};

const replaceLegacyItemOption = (items, field, from, to) => {
  let updatedCount = 0;
  (items || []).forEach((item) => {
    if (String(item?.[field] || "").trim() === from) {
      item[field] = to;
      updatedCount += 1;
    }
    updatedCount += replaceLegacyItemOption(item?.subItems, field, from, to);
  });
  return updatedCount;
};

const bulkUpdateQuotationItems = async (req, res) => {
  try {
    const quotation = await findQuotation(req, res);
    if (!quotation) return;

    const field = BULK_UPDATE_FIELDS[String(req.body?.field || "")];
    const from = String(req.body?.from || "").trim();
    const to = String(req.body?.to || "").trim();
    if (!field) {
      return res.status(400).json({
        message: "field must be either glass or colorFinish",
      });
    }
    if (!from || !to) {
      return res.status(400).json({ message: "from and to are required" });
    }
    if (from === to) {
      return res.status(400).json({ message: "Replacement option must be different" });
    }

    const result = await QuotationItem.updateMany(
      { quotation: quotation._id, [field]: from },
      { $set: { [field]: to } }
    );
    let updatedCount = result.modifiedCount || 0;
    if (
      updatedCount === 0 &&
      (!quotation.quotationItems || quotation.quotationItems.length === 0) &&
      Array.isArray(quotation.items)
    ) {
      updatedCount = replaceLegacyItemOption(
        quotation.items,
        field,
        from,
        to
      );
      if (updatedCount > 0) quotation.markModified("items");
    }
    if (updatedCount === 0) {
      return res.status(404).json({
        message: `No quotation items use "${from}"`,
      });
    }

    await touchQuotation(quotation, req.user?.userId);
    const hydrated = await hydrateQuotationItems(quotation.toObject());
    return res.json({
      quotation: hydrated,
      updatedCount,
      field: req.body.field,
      from,
      to,
    });
  } catch (error) {
    console.error("Error bulk updating quotation items:", error);
    return res.status(500).json({
      message: error.message || "Error bulk updating quotation items",
    });
  }
};

module.exports = {
  __test: { replaceLegacyItemOption },
  bulkUpdateQuotationItems,
  createQuotationItem,
  deleteQuotationItem,
  reorderQuotationItems,
  updateQuotationItem,
};
