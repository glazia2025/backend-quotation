const BaseRate = require("../models/Quotation/BaseRate");
const AreaSlab = require("../models/Quotation/AreaSlab");
const HandleRule = require("../models/Quotation/HandleRule");
const HandleOption = require("../models/Quotation/HandleOption");
const OptionSet = require("../models/Quotation/OptionSet");
const UserOptionSet = require("../models/Quotation/UserOptionSet");
const UserDescriptionRate = require("../models/Quotation/UserDescriptionRate");
const System = require("../models/Quotation/System");
const Series = require("../models/Quotation/Series");
// const Description = require("../models/Quotation/Description");
const numberOr = (value, fallback = 0) => {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : fallback;
};

const unique = (list) => Array.from(new Set(list.filter(Boolean)));

const toBooleanFlag = (value) => {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
};

const { restoreRateMap } = require("../utils/rateMapUtils");

const mapToArray = (map) => {
  const restored = restoreRateMap(map);
  return Object.entries(restored).map(([name, rate]) => ({
    name,
    rate: numberOr(rate, 0),
  }));
};

const effectiveRateWithAdminFallback = (adminRate, userRate) => {
  const parsedUserRate = Number(userRate);
  if (!Number.isFinite(parsedUserRate) || parsedUserRate === 0) {
    return numberOr(adminRate, 0);
  }
  return parsedUserRate;
};
const fetchOptionValues = async (type, systemDoc) => {
  if (type === "colorFinish" || type === "meshType" || type === "glassSpec") {
    const globalOption = await OptionSet.findOne({ type, system: { $exists: false } }).lean();
    return mapToArray(globalOption?.values);
  }

  if (systemDoc) {
    const optionSet = await OptionSet.findOne({ type, system: systemDoc._id }).lean();
    if (optionSet?.values) return mapToArray(optionSet.values);
  }
  const globalOption = await OptionSet.findOne({ type, system: { $exists: false } }).lean();
  return mapToArray(globalOption?.values);
};

const pickHandleRule = (rules, systemType, series, description) => {
  if (!rules?.length) return null;
  const exact = rules.find(
    (r) => r.description === description && r.systemType === systemType && r.series === series
  );
  if (exact) return exact;
  const systemMatch = rules.find(
    (r) => r.description === description && r.systemType === systemType && !r.series
  );
  if (systemMatch) return systemMatch;
  const generic = rules.find(
    (r) => r.description === description && !r.systemType && !r.series
  );
  return generic || null;
};

const resolveHandleInfo = (description, seriesMeta, rules, systemType, series) => {
  if (seriesMeta) {
    const matched = seriesMeta.descriptions?.find(
      (item) => item.name === description
    );
    if (matched) {
      return {
        types: matched.handleTypes || [],
        count: numberOr(matched.handleCount, 0),
      };
    }
  }

  const rule = pickHandleRule(rules, systemType, series, description);
  if (rule) {
    return {
      types: rule.handleTypes || [],
      count: numberOr(rule.handleCount, 0),
    };
  }

  return { types: [], count: 0 };
};

const getAreaSlabsSorted = async () => {
  const slabs = await AreaSlab.find({}).sort({ order: 1, max: 1 }).lean();
  if (slabs.length >= 3) return slabs.slice(0, 3);
  const defaults = [
    { label: "Small", max: 10 },
    { label: "Medium", max: 20 },
    { label: "Large", max: Number.MAX_SAFE_INTEGER },
  ];
  return [...slabs, ...defaults.slice(slabs.length, 3)];
};

const resolveAreaSlabIndex = (area, slabs) => {
  const safeArea = numberOr(area, 0);
  const slab = slabs.find((item) => safeArea <= item.max);
  if (slab) return slabs.indexOf(slab);
  return slabs.length ? slabs.length - 1 : 0;
};

const resolveBaseRate = async (systemType, series, description, area) => {
  const slabs = await getAreaSlabsSorted();
  // const baseRateDoc = await BaseRate.findOne({ systemType, series, description }).lean();
  let baseRateDoc;
  //  Louvers special case
  if (systemType === "Louvers") {
    baseRateDoc = await BaseRate.findOne({ systemType }).lean();
  } else {
    baseRateDoc = await BaseRate.findOne({
      systemType,
      series,
      description,
    }).lean();
  }
  const areaIndex = Math.min(resolveAreaSlabIndex(area, slabs), 2);
  const rates = Array.isArray(baseRateDoc?.rates)
    ? [...baseRateDoc.rates, 0, 0, 0].slice(0, 3)
    : [0, 0, 0];
  const baseRate = rates[areaIndex] ?? 0;

  return { baseRate, areaIndex, slabs: slabs.slice(0, 3) };
};

const calculateQuotationRate = async (item, userId) => {
  // logic yaha ayegi
  console.log("RATE ITEM", {
  description: item.description,
  systemType: item.systemType,
  series: item.series,
  area: item.area,
  glassSpec: item.glassSpec,
  colorFinish: item.colorFinish,
  handleType: item.handleType,
});
  const area = numberOr(item.area, 0);
  const systemDoc = await System.findOne({
  name: item.systemType,
}).lean();

const seriesMeta = await Series.findOne({
  system: systemDoc?._id,
  name: item.series,
}).lean();

const colorFinishes = await fetchOptionValues(
  "colorFinish",
  systemDoc
);

const meshTypes = await fetchOptionValues(
  "meshType",
  systemDoc
);

const glassSpecs = await fetchOptionValues(
  "glassSpec",
  systemDoc
);

const handleOptions = await HandleOption.find({
  systemType: item.systemType,
  $or: [
    { createdBy: { $exists: false } },
    { createdBy: null },
    ...(userId ? [{ createdBy: userId }] : []),
  ],
}).lean();

const handleRules = await HandleRule.find().lean();

  const {
    baseRate,
    areaIndex,
  } = await resolveBaseRate(
    item.systemType,
    item.series,
    item.description,
    area
  );
  console.log("BASE RATE", {
  description: item.description,
  systemType: item.systemType,
  series: item.series,
  baseRate,
  areaIndex,
});
  const colorRate =
  colorFinishes.find((c) => c.name === item.colorFinish)?.rate ?? 0;

const glassRate =
  glassSpecs.find((g) => g.name === item.glassSpec)?.rate ?? 0;

// const meshRate =
//   item.meshPresent === "Yes"
//     ? meshTypes.find((m) => m.name === item.meshType)?.rate ?? 0
//     : 0;

const hasMesh =
  item.meshPresent === "Yes" || toBooleanFlag(item.meshPresent);

const meshRate = hasMesh
  ? meshTypes.find((m) => m.name === item.meshType)?.rate ?? 0
  : 0;

const { count: handleCount } = resolveHandleInfo(
  item.description,
  seriesMeta,
  handleRules,
  item.systemType,
  item.series
);

const handleOption = handleOptions.find(
  (h) => h.name === item.handleType
);

const handleUnitRate =
  numberOr(handleOption?.colors?.get?.(item.handleColor), 0);

const handleRate =
  handleCount > 0
    ? (handleCount * handleUnitRate) / Math.max(area, 1)
    : 0;

const finalRate =
  baseRate +
  colorRate +
  glassRate +
  meshRate +
  handleRate;

// const amount = finalRate * area * numberOr(item.quantity, 1);
console.log("FINAL RATE", {
  baseRate,
  colorRate,
  glassRate,
  meshRate,
  handleRate,
  finalRate,
});

  return {
  rate: finalRate,
//   amount,
  handleCount,
  baseRate,
  area,
  areaSlabIndex: areaIndex,
};
};

module.exports = {
  calculateQuotationRate,
  resolveBaseRate,
  fetchOptionValues,
  resolveHandleInfo,
  numberOr,
};