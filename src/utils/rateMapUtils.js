const escapeMongoKey = (key = "") =>
  String(key)
    .replace(/\./g, "[dot]")
    .replace(/\$/g, "[dollar]");

const restoreMongoKey = (key = "") =>
  String(key)
    .replace(/\[dot\]/g, ".")
    .replace(/\[dollar\]/g, "$");

// Normalizes map-like inputs and escapes MongoDB reserved characters in keys
const normalizeRateMap = (input) => {
  if (!input) return {};

  if (typeof input === "object" && !Array.isArray(input)) {
    return Object.entries(input).reduce((acc, [k, v]) => {
      acc[escapeMongoKey(k)] = Number(v) || 0;
      return acc;
    }, {});
  }

  if (Array.isArray(input)) {
    return input.reduce((acc, val) => {
      acc[escapeMongoKey(val)] = 0;
      return acc;
    }, {});
  }

  return {};
};

// Restores escaped keys so API consumers see the original labels
const restoreRateMap = (input) => {
  if (!input) return {};
  const entries = input instanceof Map ? Array.from(input.entries()) : Object.entries(input);
  return entries.reduce((acc, [k, v]) => {
    acc[restoreMongoKey(k)] = Number(v) || 0;
    return acc;
  }, {});
};

module.exports = {
  normalizeRateMap,
  restoreRateMap,
};
