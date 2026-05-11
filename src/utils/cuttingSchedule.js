const ProfileOptions = require("../models/ProfileOptions");
const HardwareOptions = require("../models/Hardware");

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

const evaluateFormula = (formula, variables) => {
  const source = String(formula || "").trim();
  if (!source) return "";

  const withValues = source
    .replace(/\bAREA\b/gi, String(toNumber(variables.AREA)))
    .replace(/\bW\b/gi, String(toNumber(variables.W)))
    .replace(/\bH\b/gi, String(toNumber(variables.H)))
    .replace(/\bQ\b/gi, String(toNumber(variables.Q, 1)));

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
  const wanted = normalizeCode(sapCode);
  if (!wanted) return null;

  const profileOptions = await ProfileOptions.findOne({}).lean();
  const categories = profileOptions?.categories || {};
  const categoryEntries =
    categories instanceof Map ? Array.from(categories.entries()) : Object.entries(categories);

  for (const [categoryName, categoryValue] of categoryEntries) {
    const productsMap = categoryValue?.products || {};
    const productEntries =
      productsMap instanceof Map ? Array.from(productsMap.entries()) : Object.entries(productsMap);

    for (const [optionName, products] of productEntries) {
      const match = (Array.isArray(products) ? products : []).find(
        (product) => normalizeCode(product.sapCode) === wanted
      );
      if (match) {
        return {
          ...match,
          catalogCategory: categoryName,
          catalogOption: optionName,
          label: match.description || match.part || match.sapCode,
        };
      }
    }
  }

  return null;
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

const resolveCatalogProduct = async (line) => {
  if (line.itemType === "hardware") {
    return findHardwareBySapCode(line.sapCode);
  }

  return findProfileProductBySapCode(line.sapCode);
};

const searchProfileProductsBySapCode = async (sapCode, limit = 10) => {
  const wanted = normalizeCode(sapCode);
  if (!wanted) return [];

  const profileOptions = await ProfileOptions.findOne({}).lean();
  const categories = profileOptions?.categories || {};
  const categoryEntries =
    categories instanceof Map ? Array.from(categories.entries()) : Object.entries(categories);
  const matches = [];

  for (const [categoryName, categoryValue] of categoryEntries) {
    const productsMap = categoryValue?.products || {};
    const productEntries =
      productsMap instanceof Map ? Array.from(productsMap.entries()) : Object.entries(productsMap);

    for (const [optionName, products] of productEntries) {
      for (const product of Array.isArray(products) ? products : []) {
        if (normalizeCode(product.sapCode).includes(wanted)) {
          matches.push({
            ...product,
            itemType: "profile",
            catalogCategory: categoryName,
            catalogOption: optionName,
            label: product.description || product.part || product.sapCode,
          });
        }

        if (matches.length >= limit) return matches;
      }
    }
  }

  return matches;
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

module.exports = {
  escapeHtml,
  evaluateFormula,
  resolveCatalogProduct,
  round3,
  searchCatalogProducts,
  toNumber,
};
