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

const remapConfiguratorLayout = (value, subItemIdMap) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const node = { ...value };
  if (node.id && subItemIdMap.has(String(node.id))) {
    node.id = String(subItemIdMap.get(String(node.id)));
  }
  if (Array.isArray(node.children)) {
    node.children = node.children.map((child) =>
      remapConfiguratorLayout(child, subItemIdMap)
    );
  }
  return node;
};

const collectLayoutNodeIds = (node, ids = new Set()) => {
  if (!node || typeof node !== "object") return ids;
  if (node.id) ids.add(String(node.id));
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => collectLayoutNodeIds(child, ids));
  }
  return ids;
};

const resolveJoinEndpoint = (value, subItemIdMap, validLayoutIds) => {
  const id = String(value || "").trim();
  if (!id) return "";
  if (subItemIdMap.has(id)) return String(subItemIdMap.get(id));
  return validLayoutIds.has(id) ? id : "";
};

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
    const subItemIds = subItems.map(() => new mongoose.Types.ObjectId());
    const subItemIdMap = new Map();

    subItems.forEach((subItem, index) => {
      if (subItem.id) {
        subItemIdMap.set(String(subItem.id), subItemIds[index]);
      }
    });

    const payload = itemPayload(item);
    payload.configuratorLayout = remapConfiguratorLayout(
      payload.configuratorLayout,
      subItemIdMap
    );
    const validLayoutIds = collectLayoutNodeIds(payload.configuratorLayout);
    payload.joins = Array.isArray(payload.joins)
      ? payload.joins.map((join) => ({
          p1: resolveJoinEndpoint(join.p1, subItemIdMap, validLayoutIds),
          p2: resolveJoinEndpoint(join.p2, subItemIdMap, validLayoutIds),
          type: join.type,
        }))
      : [];

    const invalidJoin = payload.joins.find((join) => !join.p1 || !join.p2);
    if (invalidJoin) {
      const error = new Error(
        "Every mullion/coupler join must reference a valid sub-item or layout section"
      );
      error.statusCode = 400;
      throw error;
    }

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
      joins: Array.isArray(item.joins)
        ? item.joins.map((join) => ({
            p1: String(join.p1),
            p2: String(join.p2),
            type: join.type,
          }))
        : [],
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
  __test: {
    collectLayoutNodeIds,
    remapConfiguratorLayout,
    resolveJoinEndpoint,
  },
  createQuotationItems,
  deleteQuotationItems,
  hydrateQuotationItems,
};
