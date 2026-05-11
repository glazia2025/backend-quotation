const { restoreRateMap } = require("./rateMapUtils");

const normalizeColorMap = (input) =>
  Object.entries(restoreRateMap(input)).reduce((acc, [key, value]) => {
    const name = String(key || "").trim();
    if (!name) return acc;
    acc[name] = Number(value) || 0;
    return acc;
  }, {});

const ensureColorDefaults = (colors = {}) => {
  const normalized = normalizeColorMap(colors);
  if (!Object.prototype.hasOwnProperty.call(normalized, "Black")) {
    normalized.Black = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, "Silver")) {
    normalized.Silver = 0;
  }
  return normalized;
};

const colorMapToArray = (colors = {}) =>
  Object.entries(normalizeColorMap(colors))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rate]) => ({ name, rate: Number(rate) || 0 }));

const toSystemKey = (name = "") =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const toIdString = (value) => {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
};

const groupHandleOptionsBySystem = (options = [], userId = "") =>
  options.reduce((acc, option) => {
    const systemType = option.systemType || "";
    const key = toSystemKey(systemType);
    if (!key) return acc;

    if (!acc[key]) {
      acc[key] = [];
    }

    const createdBy = toIdString(option.createdBy);
    const isUserItem = Boolean(createdBy);
    const canDelete = Boolean(userId && createdBy === toIdString(userId));

    acc[key].push({
      id: String(option._id || `${systemType}:${option.name}`),
      _id: option._id,
      systemType,
      name: option.name || "",
      colors: colorMapToArray(option.colors),
      source: isUserItem ? "user" : "admin",
      canDelete,
    });

    return acc;
  }, {});

module.exports = {
  colorMapToArray,
  ensureColorDefaults,
  groupHandleOptionsBySystem,
  normalizeColorMap,
  toSystemKey,
};
