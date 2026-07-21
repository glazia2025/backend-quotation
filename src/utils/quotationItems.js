const mongoose = require("mongoose");
const QuotationItem = require("../models/Quotation/QuotationItem");
const { normalizeQuotationImageReferences } = require("./quotationImages");

const INTERNAL_FIELDS = new Set([
  "_id",
  "id",
  "__v",
  "createdAt",
  "updatedAt",
  "quotation",
  "parentItem",
  "subItems",
]);

const itemPayload = (item = {}) =>
  Object.fromEntries(
    Object.entries(item).filter(([key]) => !INTERNAL_FIELDS.has(key))
  );

async function createQuotationItems(quotationId, items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return { topLevelIds: [], allIds: [] };
  }

  const documents = [];
  const topLevelIds = [];

  for (const item of items) {
    const topLevelId = new mongoose.Types.ObjectId();
    topLevelIds.push(topLevelId);

    const subItems = Array.isArray(item?.subItems) ? item.subItems : [];
    const subItemIds = subItems.map(
      () => new mongoose.Types.ObjectId()
    );
    const subItemIdMap = new Map();

subItems.forEach((subItem, index) => {
  if (subItem.id) {
    subItemIdMap.set(subItem.id, subItemIds[index]);
  }
});

    // documents.push({
    //   _id: topLevelId,
    //   quotation: quotationId,
    //   parentItem: null,
    //   subItems: subItemIds,
    //   ...itemPayload(item),
    // });

    const payload = itemPayload(item);
payload.joins = Array.isArray(payload.joins)
  ? payload.joins.map((join) => ({
      p1: subItemIdMap.get(join.p1),
      p2: subItemIdMap.get(join.p2),
      type: join.type,
    }))
  : [];

documents.push({
  _id: topLevelId,
  quotation: quotationId,
  parentItem: null,
  subItems: subItemIds,
  ...payload,
});

    subItems.forEach((subItem, index) => {
      documents.push({
        _id: subItemIds[index],
        quotation: quotationId,
        parentItem: topLevelId,
        subItems: [],
        ...itemPayload(subItem),
      });
    });
  }

  try {
    await QuotationItem.insertMany(documents);
  } catch (error) {
    // An ordered batch may fail after writing an earlier document.
    await QuotationItem.deleteMany({
      _id: { $in: documents.map((document) => document._id) },
    });
    throw error;
  }
  return { topLevelIds, allIds: documents.map((document) => document._id) };
}

async function hydrateQuotationItems(quotation) {
  if (!quotation) return quotation;

  const referenceIds = Array.isArray(quotation.quotationItems)
    ? quotation.quotationItems.map(String)
    : [];

  if (referenceIds.length === 0) {
    return normalizeQuotationImageReferences({
      ...quotation,
      items: Array.isArray(quotation.items) ? quotation.items : [],
    });
  }

  const documents = await QuotationItem.find({ quotation: quotation._id }).lean();
  const byId = new Map(documents.map((document) => [String(document._id), document]));

  const toApiItem = (document) => {
    if (!document) return null;
    const { quotation: _quotation, parentItem: _parent, subItems, ...item } = document;
    return {
      ...item,
      id: String(item._id),
      subItems: (subItems || [])
        .map((id) => toApiItem(byId.get(String(id))))
        .filter(Boolean),
    };
  };

  return normalizeQuotationImageReferences({
    ...quotation,
    items: referenceIds.map((id) => toApiItem(byId.get(id))).filter(Boolean),
  });
}

async function deleteQuotationItems(quotationId, filter = {}) {
  return QuotationItem.deleteMany({ quotation: quotationId, ...filter });
}

module.exports = {
  createQuotationItems,
  deleteQuotationItems,
  hydrateQuotationItems,
};
