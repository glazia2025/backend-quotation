const ProfileOptions = require("../models/ProfileOptions");
const HardwareOptions = require("../models/Hardware");
const Product = require("../models/Product");

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round3 = (value) => {
  const n = toNumber(value);
  return Math.round(n * 1000) / 1000;
};

const normalizeCode = (value) => String(value || "").trim().toUpperCase();

const getMapValue = (mapLike, key) => {
  if (!mapLike || !key) return undefined;
  if (mapLike instanceof Map) return mapLike.get(key);
  return mapLike[key];
};

const evaluateFormula = (formula, variables) => {
  const source = String(formula || "").trim();
  if (!source) return "";

  let withValues = source.toUpperCase();
    // .replace(/\bAREA\b/gi, String(toNumber(variables.AREA)))
    // .replace(/\bW\b/gi, String(toNumber(variables.W)))
    // .replace(/\bH\b/gi, String(toNumber(variables.H)))
    // .replace(/\bQ\b/gi, String(toNumber(variables.Q, 1)));
     Object.keys(variables).forEach((key) => {
  const value = toNumber(variables[key], 0);
   const regex = new RegExp(`(?<![a-zA-Z0-9])${key}(?![a-zA-Z0-9])`, "gi");
  withValues = withValues.replace(regex, String(value));
});

  if (!/^[\d+\-*/().\s]+$/.test(withValues)) {
    throw new Error(`Invalid formula: ${source}`);
  }

  // The expression is reduced to numbers/operators above before evaluation.
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${withValues});`)();
  if (!Number.isFinite(Number(result))) {
    throw new Error(`Formula did not return a number: ${source}`);
  }

  return round3(result);
};

const findProfileProductBySapCode = async (sapCode) => {
  const wanted = String(sapCode || "").trim();
  if (!wanted) return null;

  const product = await Product.findOne({
    sapCode: wanted,
    enabled: true,
  }).lean();

  if (!product) return null;

  return {
    ...product,
    itemType: "profile",
    label: product.description || product.part || product.sapCode,
  };
};

const findHardwareBySapCode = async (sapCode) => {
  const wanted = String(sapCode || "").trim();
  if (!wanted) return null;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const product = await HardwareOptions.findOne({
    sapCode: { $regex: `^${escaped}$`, $options: "i" },
  }).lean();

  return product
    ? {
        ...product,
        label: product.perticular || product.sapCode,
      }
    : null;
};

const findGlassByName = (glassSpec) => {
  const label = String(glassSpec || "").trim();
  return label ? { label } : null;
};

const resolveCatalogProduct = async (line) => {
  if (line.itemType === "hardware") {
    return findHardwareBySapCode(line.sapCode);
  }
  if (line.itemType === "glass") {
    return findGlassByName(line.description || line.sapCode);
  }

  return findProfileProductBySapCode(line.sapCode);
};

const searchProfileProductsBySapCode = async (sapCode, limit = 10) => {
  const wanted = String(sapCode || "").trim();
  if (!wanted) return [];

  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const products = await Product.find({
    sapCode: { $regex: `^${escaped}`, $options: "i" },
    enabled: true,
  })
    .limit(limit)
    .lean();

  return products.map((product) => ({
    ...product,
    itemType: "profile",
    label: product.description || product.part || product.sapCode,
  }));
};

const searchHardwareBySapCode = async (sapCode, limit = 10) => {
  const wanted = String(sapCode || "").trim();
  if (!wanted) return [];
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const products = await HardwareOptions.find({
    sapCode: { $regex: escaped, $options: "i" },
  })
    .limit(limit)
    .lean();

  return products.map((product) => ({
    ...product,
    itemType: "hardware",
    label: product.perticular || product.sapCode,
  }));
};

const searchCatalogProducts = async ({ itemType, sapCode, limit = 10 }) => {
  if (itemType === "hardware") {
    return searchHardwareBySapCode(sapCode, limit);
  }

  return searchProfileProductsBySapCode(sapCode, limit);
};

const listProfileProducts = async () => {
  const profileOptions = await ProfileOptions.findOne({}).lean();
  const categories = profileOptions?.categories || {};
  const categoryEntries =
    categories instanceof Map ? Array.from(categories.entries()) : Object.entries(categories);
  const products = [];

  for (const [categoryName, categoryValue] of categoryEntries) {
    const productsMap = categoryValue?.products || {};
    const productEntries =
      productsMap instanceof Map ? Array.from(productsMap.entries()) : Object.entries(productsMap);

    for (const [optionName, optionProducts] of productEntries) {
      for (const product of Array.isArray(optionProducts) ? optionProducts : []) {
        const rate = toNumber(getMapValue(categoryValue?.rate || {}, optionName));
        products.push({
          ...product,
          rate,
          itemType: "profile",
          catalogCategory: categoryName,
          catalogOption: optionName,
          label: product.description || product.part || product.sapCode,
        });
      }
    }
  }

  return products.sort((a, b) =>
    `${a.catalogCategory} ${a.catalogOption} ${a.label}`.localeCompare(
      `${b.catalogCategory} ${b.catalogOption} ${b.label}`
    )
  );
};

module.exports = {
  escapeHtml,
  evaluateFormula,
  listProfileProducts,
  resolveCatalogProduct,
  round3,
  searchCatalogProducts,
  toNumber,
};
